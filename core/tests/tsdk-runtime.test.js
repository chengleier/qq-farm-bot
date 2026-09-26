const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const {
    MINI_PROGRAM_APP_IDS,
    TSDK_SHA256,
    TSDK_VERSION,
    TSDK_BUILDS,
    TsdkRuntime,
    resolveTsdkHostProfile,
} = require('../dist/utils/tsdk-runtime');

// 内置构建的冻结向量：锁定 WASM 版本，防止误换文件。
// 已与 2026-09-24 两个官方 QQ 会话逐字节对齐（112/112 bytes）。
const EXPECTED_QQ_CREDENTIAL_BYTES = Buffer.from(
    "344e0d774812caf143fabc83bfe2fef9f863b450d5ee978e5c7b50dfa10f02df7b677d833d074325d4af1336e9b41af6e9eed9df6baa76780968668b8710e1696ad5ea9521daf61434d125b367f5ed14ab19a19eb0ff76f74c42e5fc81da1d4188d7614ed3b8",
    "hex",
);

test('TSDK selects the mini-program host profile by account platform', () => {
    assert.deepEqual(resolveTsdkHostProfile('qq'), {
        appId: MINI_PROGRAM_APP_IDS.qq,
        debugMode: 0,
        deviceText: 'windows;windows;windows 10.0;0;',
        platform: 'qq',
        userDataPath: 'qqfile://usr/',
    });
    assert.deepEqual(resolveTsdkHostProfile('wx'), {
        appId: MINI_PROGRAM_APP_IDS.wx,
        debugMode: 2,
        platform: 'wx',
    });
});

test('QQ virtual user paths stay inside the account TSDK directory', () => {
    const dataDir = path.join(os.tmpdir(), 'qq-farm-tsdk-path-test');
    const runtime = new TsdkRuntime({ dataDir, platform: 'qq' });

    assert.equal(runtime.resolveDataPath('qqfile://usr/state.bin'), path.join(dataDir, 'state.bin'));
    assert.throws(
        () => runtime.resolveDataPath('qqfile://usr/../../outside.bin'),
        /TSDK 文件路径越出账号目录/,
    );
});

test('bundled TSDK matches the pinned official build', () => {
    const wasmPath = path.join(__dirname, '..', 'src', 'utils', 'tsdk.wasm');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex');

    assert.equal(TSDK_VERSION, 'v3.9.0.1790160550');
    assert.equal(hash, TSDK_SHA256);
});

test('QQ host inputs reproduce the bundled TSDK credential byte vector', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tsdk-test-'));
    const originalHttpsGet = https.get;
    let runtime;
    try {
        // Initialization seeds server time synchronously; the delayed network refresh is irrelevant to this vector.
        https.get = () => ({ on() { return this; } });
        runtime = new TsdkRuntime({
            accountId: 'credential-vector',
            dataDir: path.join(tempRoot, 'data'),
            platform: 'qq',
        });
        await runtime.init();
        runtime.bindUser('tsdk-regression-openid');

        const encoded = runtime.getEncryptedInitInfo();
        const decoded = Buffer.from(encoded, 'base64');
        assert.equal(encoded.length, 136);
        assert.deepEqual(decoded, EXPECTED_QQ_CREDENTIAL_BYTES);

        const plaintext = Buffer.from('tsdk-transform-regression');
        const encrypted = runtime.transform(plaintext, false);
        assert.notDeepEqual(encrypted, plaintext);
        assert.deepEqual(runtime.transform(encrypted, true), plaintext);
    } finally {
        runtime?.destroy();
        https.get = originalHttpsGet;
        const resolvedRoot = path.resolve(tempRoot);
        const resolvedTemp = path.resolve(os.tmpdir());
        assert.ok(resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`));
        assert.ok(path.basename(resolvedRoot).startsWith('qq-farm-tsdk-test-'));
        fs.rmSync(resolvedRoot, { recursive: true, force: true });
    }
});

function fnv1a32(value) {
    let hash = 0x811C9DC5;
    for (const byte of value) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

// 冻结 `s()`（Date.now）的运行时：AntiData 负载只由取整秒的宿主时钟决定，冻结后可与官方抓包逐字节对照。
class FrozenClockTsdkRuntime extends TsdkRuntime {
    constructor(options, clock) {
        super(options);
        this.clock = clock;
    }

    createImports() {
        const imports = super.createImports();
        return { a: { ...imports.a, s: () => this.clock.value } };
    }
}

// 官方抓包 ws_00151_SEND.bin（会话版本 1.14.0.4_20260911）解密后的 AntiData 上报负载：
// 该会话第 5 次上报（上报计数 04）在本地时钟 1789354371.5 秒生成。
const OFFICIAL_ANTIDATA_BASELINE
    = '0705a49302fb0000000400000025e3a427b72edf949045efd1023879b22d5d393adecb4bd32d671a174c50d845b37e7a6ce5b2';

test('AntiData report payload reproduces the official capture and its FNV-1a checksum', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tsdk-ace-test-'));
    const originalHttpsGet = https.get;
    let runtime;
    try {
        // 初始化时会同步读取服务器时间，延迟刷新与本次向量无关。
        https.get = () => ({ on() { return this; } });
        const clock = { value: 1789354346500 };
        runtime = new FrozenClockTsdkRuntime({
            accountId: 'antidata-vector',
            dataDir: path.join(tempRoot, 'data'),
            platform: 'qq',
        }, clock);
        await runtime.init();
        runtime.bindUser('Q'.repeat(32));

        // `M()` 按当前秒封装负载、`N()` 消费一次；官方该报文是本次会话的第 5 次读取。
        for (let index = 0; index < 4; index += 1) {
            runtime.heartbeatTick();
            runtime.getDataToServer();
        }
        clock.value = 1789354371500;
        runtime.heartbeatTick();
        const payload = runtime.getDataToServer();

        assert.deepEqual(payload, Buffer.from(OFFICIAL_ANTIDATA_BASELINE, 'hex'));
        assert.equal(payload.length, 51);
        assert.equal(payload.readUInt16BE(12), payload.length - 14);
        assert.equal(payload.readUInt32BE(2), fnv1a32(payload.subarray(14)));
        // 读取一次后不会重复上报，必须等下一次 `M()` 才会产生新负载。
        assert.equal(runtime.getDataToServer().length, 0);
    } finally {
        runtime?.destroy();
        https.get = originalHttpsGet;
        fs.rmSync(path.resolve(tempRoot), { recursive: true, force: true });
    }
});

test('WeChat loads its audited WASM and reports unsupported host calls without user data', async () => {
    const build = TSDK_BUILDS.wx;
    assert.equal(build.version, 'v3.9.0.1790237209');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../src/utils', build.file))).digest('hex'), build.sha256);
    const originalGet = https.get;
    const originalRequest = https.request;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tsdk-wx-'));
    let runtime;
    try {
        https.get = () => ({ on() { return this; } });
        https.request = () => ({ on() { return this; }, end() {} });
        runtime = new TsdkRuntime({ dataDir, platform: 'wx' });
        await runtime.init();
        runtime.bindUser('synthetic-wx-openid');
        assert.equal(runtime.getDiagnostics().version, build.version);
        const plaintext = Buffer.from('synthetic-wechat-protocol-vector');
        const ciphertext = runtime.transform(plaintext);
        assert.notDeepEqual(ciphertext, plaintext);
        assert.deepEqual(runtime.transform(ciphertext, true), plaintext);
        assert.equal(runtime.createImports().a.e(), 0);
        assert.equal(runtime.getDiagnostics().unsupportedAceVmCalls, 1);
        assert.ok(runtime.getDiagnostics().lastUnsupportedAceVmAt > 0);
        assert.ok(!JSON.stringify(runtime.getDiagnostics()).includes('synthetic-wx-openid'));
        const pkgAssets = require('../package.json').pkg.assets;
        assert.ok(pkgAssets.includes('src/utils/tsdk-wx.wasm'));
        assert.match(fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8'), /COPY[^\n]+tsdk-wx\.wasm/);
    } finally {
        runtime?.destroy();
        https.get = originalGet;
        https.request = originalRequest;
        assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(dataDir).startsWith('qq-farm-tsdk-wx-'));
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('unsupported ACEVM fingerprints exact bounded bytes without executing or retaining task content', () => {
    for (const platform of ['qq', 'wx']) {
        const runtime = new TsdkRuntime({ dataDir: path.join(os.tmpdir(), 'synthetic-acevm-diagnostics'), platform });
        runtime.memory = new WebAssembly.Memory({ initial: 2 });
        const view = new Uint8Array(runtime.memory.buffer);
        const invoke = runtime.createImports().a.e;
        try {
            assert.equal(runtime.getDiagnostics().lastUnsupportedAceVmTaskHash, '');
            const tasks = [Buffer.from('{"synthetic":"甲"}'), Buffer.from('{"synthetic":"乙"}'), Buffer.from([0xFF, 0xFE])];
            assert.equal(tasks[0].length, tasks[1].length);
            const hashes = [];
            for (const task of tasks) {
                view.set(task, 64);
                view[64 + task.length] = 0;
                assert.equal(invoke(64), 0);
                const result = runtime.getDiagnostics();
                assert.equal(result.lastUnsupportedAceVmTaskHash, crypto.createHash('sha256').update(task).digest('hex'));
                assert.equal(result.lastUnsupportedAceVmTaskBytes, task.length);
                assert.equal(result.lastUnsupportedAceVmTaskReadFailed, false);
                assert.ok(!JSON.stringify(result).includes('synthetic'));
                hashes.push(result.lastUnsupportedAceVmTaskHash);
            }
            assert.notEqual(hashes[0], hashes[1]);
            assert.equal(runtime.getDiagnostics().unsupportedAceVmCalls, tasks.length);
            for (const ptr of [undefined, 0, -1, view.length, Number.NaN]) {
                assert.equal(invoke(ptr), 0);
                const result = runtime.getDiagnostics();
                assert.equal(result.lastUnsupportedAceVmTaskHash, '');
                assert.equal(result.lastUnsupportedAceVmTaskReadFailed, true);
            }
            view.fill(65, 64, 64 + 65537);
            assert.equal(invoke(64), 0);
            assert.equal(runtime.getDiagnostics().lastUnsupportedAceVmTaskReadFailed, true);
            view[64 + 65536] = 0;
            assert.equal(invoke(64), 0);
            assert.equal(runtime.getDiagnostics().lastUnsupportedAceVmTaskBytes, 65536);
            assert.equal(runtime.getDiagnostics().lastUnsupportedAceVmTaskReadFailed, false);
        } finally {
            runtime.destroy();
        }
        const next = new TsdkRuntime({ dataDir: path.join(os.tmpdir(), 'synthetic-acevm-diagnostics'), platform });
        assert.equal(next.getDiagnostics().unsupportedAceVmCalls, 0);
        assert.equal(next.getDiagnostics().lastUnsupportedAceVmTaskHash, '');
        next.destroy();
    }
});

test('compiled pkg layout resolves platform WASM assets from src', async () => {
    const vm = require('node:vm');
    const { createRequire } = require('node:module');
    const filename = path.resolve(__dirname, '../dist/utils/tsdk-runtime.js');
    const realRequire = createRequire(filename);
    const sandbox = {
        require: name => name === '../config/runtime-paths'
            ? { getResourcePath: (...parts) => path.resolve(__dirname, '../dist', ...parts) }
            : realRequire(name),
        module: { exports: {} }, exports: {}, __dirname: path.dirname(filename),
        Buffer, WebAssembly, process, console,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const originalGet = https.get;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tsdk-pkg-'));
    try {
        https.get = () => ({ on() { return this; } });
        for (const platform of ['qq', 'wx']) {
            const runtime = new sandbox.module.exports.TsdkRuntime({ dataDir, platform });
            try {
                await runtime.init();
                assert.equal(runtime.getDiagnostics().version, TSDK_BUILDS[platform].version);
            } finally { runtime.destroy(); }
        }
    } finally {
        https.get = originalGet;
        assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(dataDir).startsWith('qq-farm-tsdk-pkg-'));
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
