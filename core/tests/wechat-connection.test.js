const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const { CONFIG, DEFAULT_CLIENT_VERSION } = require('../dist/config/config');
const { loadProto, types } = require('../dist/utils/proto');
const { WX_CLIENT_VERSION, resolvePlatformClientVersion } = require('../dist/utils/client-profile');
const { sanitizeMeta } = require('../dist/services/logger');

test('platform defaults upgrade WeChat without replacing QQ or explicit versions', () => {
    assert.equal(resolvePlatformClientVersion('qq', DEFAULT_CLIENT_VERSION), DEFAULT_CLIENT_VERSION);
    assert.equal(resolvePlatformClientVersion('wx', DEFAULT_CLIENT_VERSION), WX_CLIENT_VERSION);
    assert.equal(resolvePlatformClientVersion('wechat', DEFAULT_CLIENT_VERSION), WX_CLIENT_VERSION);
    assert.equal(resolvePlatformClientVersion('wx', 'custom-version'), 'custom-version');
});

test('decoded WeChat login uses configured device fields and does not invent a launch scene', async () => {
    await loadProto();
    const { buildLoginBody } = require('../dist/utils/network');
    const saved = { platform: CONFIG.platform, clientVersion: CONFIG.clientVersion, deviceInfo: CONFIG.deviceInfo };
    try {
        CONFIG.platform = 'wx';
        CONFIG.clientVersion = DEFAULT_CLIENT_VERSION;
        CONFIG.deviceInfo = { sysSoftware: 'Windows test', network: 'wifi', memory: '8192', deviceId: 'test-device' };
        const decode = () => types.LoginRequest.toObject(types.LoginRequest.decode(buildLoginBody()), { longs: String });
        const wx = decode();
        assert.deepEqual(wx.device_info, { client_version: WX_CLIENT_VERSION, sys_software: 'Windows test', network: 'wifi', memory: '8192', device_id: 'test-device' });
        assert.equal(wx.report_data.minigame_channel, 'other');
        assert.equal(wx.report_data.minigame_platid, 2);
        assert.equal(Object.hasOwn(wx, 'scene_id'), false);
        CONFIG.deviceInfo.memory = 'invalid';
        assert.equal(Object.hasOwn(decode().device_info, 'memory'), false);
        CONFIG.platform = 'qq';
        const qq = decode();
        assert.equal(qq.device_info.client_version, DEFAULT_CLIENT_VERSION);
        assert.equal(qq.report_data.minigame_channel, 'other-qq');
        assert.equal(Object.hasOwn(qq.device_info, 'device_id'), false);
    } finally {
        Object.assign(CONFIG, saved);
    }
});

test('diagnostic numeric codes survive while credentials remain redacted', () => {
    const result = sanitizeMeta({ code: 123456, token: 'secret', diagnostics: {
        reasonCode: 2, disconnectCode: 1006, errorCode: 500, closeCode: 'credential',
        authCode: 'secret', reason: 'wss://example.test/?code=secret&token=secret',
    } });
    assert.equal(result.code, '[REDACTED]');
    assert.equal(result.token, '[REDACTED]');
    assert.equal(result.diagnostics.reasonCode, 2);
    assert.equal(result.diagnostics.disconnectCode, 1006);
    assert.equal(result.diagnostics.errorCode, 500);
    assert.equal(result.diagnostics.closeCode, '[REDACTED]');
    assert.equal(result.diagnostics.authCode, '[REDACTED]');
    assert.ok(!JSON.stringify(result).includes('secret'));
});

function aceHarness() {
    const filename = path.resolve(__dirname, '../dist/services/ace.js');
    const realRequire = createRequire(filename);
    const tasks = new Map();
    const fed = [];
    let readError = false;
    const overrides = {
        './scheduler': { createScheduler: () => ({ setIntervalTask: (name, _ms, fn) => tasks.set(name, fn), clearAll: () => tasks.clear() }) },
        '../utils/proto': { types: {
            AntiDataRequest: { create: value => value, encode: value => ({ finish: () => value.data }) },
            AntiDataReply: { decode: value => ({ result: value }) },
        } },
        '../utils/utils': { log() {}, logWarn() {} },
        '../utils/crypto-wasm': {
            getDataToServer() { if (readError) throw new Error('read failed'); return Buffer.from([1]); },
            sendDataFromServer: value => fed.push([...value]),
            processReceivedData() { throw new Error('process failed'); },
            destroyWasm() {},
        },
    };
    const sandbox = { require: name => overrides[name] || realRequire(name), module: { exports: {} }, exports: {}, Buffer, Date };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return { ace: sandbox.module.exports, tasks, fed, failRead: () => { readError = true; } };
}

test('late AntiData from a stopped connection cannot contaminate its replacement', async () => {
    const h = aceHarness();
    let finishOld;
    let finishNew;
    h.ace.startAceRuntime(() => new Promise(resolve => { finishOld = resolve; }));
    const oldRequest = h.ace.sendAntiData();
    h.ace.stopAceRuntime(true);
    h.ace.startAceRuntime(() => new Promise(resolve => { finishNew = resolve; }));
    const newRequest = h.ace.sendAntiData();
    finishOld({ body: Buffer.from([11]) });
    await oldRequest;
    assert.deepEqual(h.fed, []);
    assert.equal(h.ace.getAceDiagnostics().requestRunning, true);
    assert.equal(h.ace.getAceDiagnostics().replies, 0);
    finishNew({ body: Buffer.from([22]) });
    await newRequest;
    assert.deepEqual(h.fed, [[22]]);
    assert.equal(h.ace.getAceDiagnostics().nonemptyReplies, 1);
    assert.equal(h.ace.getAceDiagnostics().requestRunning, false);
    h.ace.stopAceRuntime();
});

test('empty AntiData replies and local processing failures remain distinguishable', async () => {
    const h = aceHarness();
    h.ace.startAceRuntime(async () => ({ body: Buffer.alloc(0) }));
    await h.ace.sendAntiData();
    assert.equal(h.ace.getAceDiagnostics().replies, 1);
    assert.equal(h.ace.getAceDiagnostics().nonemptyReplies, 0);
    h.tasks.get('process_received_data')();
    assert.ok(h.ace.getAceDiagnostics().lastProcessFailureAt > 0);
    h.failRead();
    await h.ace.sendAntiData();
    assert.equal(h.ace.getAceDiagnostics().failures, 1);
    assert.equal(h.ace.getAceDiagnostics().requestRunning, false);
    h.ace.stopAceRuntime();
});

test('kickout and close snapshots preserve diagnostics before cleanup', async () => {
    await loadProto();
    const filename = path.resolve(__dirname, '../dist/utils/network.js');
    const realRequire = createRequire(filename);
    let destroyed = false;
    const overrides = {
        ws: { OPEN: 1 },
        '../services/scheduler': { createScheduler: () => ({ clear() {}, clearAll() {} }) },
        '../services/ace': { stopAceRuntime() { destroyed = true; }, getAceDiagnostics: () => ({ replies: 7 }) },
        './crypto-wasm': { getDiagnostics: () => ({ ready: !destroyed, unsupportedAceVmCalls: 1 }) },
        './utils': { toLong: Number, toNum: Number, log() {}, logWarn() {} },
    };
    const sandbox = { require: name => overrides[name] || realRequire(name), module: { exports: {} }, exports: {}, Buffer, console, process };
    vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}
        module.exports.inspectNotify = handleNotify;
        module.exports.installConnection = () => {
            ws = { readyState: 1, close() {} };
            currentConnection = { id: 1, socket: ws, phase: 'online', intentionalClose: false, finalized: false, loginInitialized: true, startedAt: Date.now() - 1000 };
        };
        module.exports.disconnect = () => finalizeConnection(currentConnection, { source: 'ws_close', code: 1006 });
    `, sandbox, { filename });
    const network = sandbox.module.exports;
    network.installConnection();
    let kicked;
    let closed;
    network.networkEvents.on('kickout', value => { kicked = value; });
    network.networkEvents.on('disconnected', value => { closed = value; });
    const event = types.EventMessage.encode(types.EventMessage.create({
        message_type: 'gamepb.userpb.KickoutNotify',
        body: types.KickoutNotify.encode(types.KickoutNotify.create({ reason: 2, reason_message: 'test kickout' })).finish(),
    })).finish();
    network.inspectNotify({ body: event });
    assert.equal(kicked.reasonCode, 2);
    assert.equal(kicked.diagnostics.tsdk.unsupportedAceVmCalls, 1);
    network.disconnect();
    assert.equal(closed.code, 1006);
    assert.equal(closed.diagnostics.tsdk.ready, true);
    assert.equal(closed.diagnostics.ace.replies, 7);
    assert.ok(closed.diagnostics.connectionAgeMs >= 1000);
    assert.equal(destroyed, true);
});
