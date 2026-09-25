export {};
const { CONFIG, DEFAULT_CLIENT_VERSION } = require('../config/config');

// Verified in the official Windows WeChat capture on 2026-09-25.
const WX_CLIENT_VERSION = '1.14.2.13_20260922';

function isWechatPlatform(platform: unknown = CONFIG.platform): boolean {
    return ['wx', 'wechat'].includes(String(platform || '').trim().toLowerCase());
}

function resolvePlatformClientVersion(platform: unknown, configuredVersion: unknown): string {
    const version = String(configuredVersion || '').trim() || DEFAULT_CLIENT_VERSION;
    // Only replace the inherited QQ default. Explicit custom versions remain usable.
    return isWechatPlatform(platform) && version === DEFAULT_CLIENT_VERSION ? WX_CLIENT_VERSION : version;
}

function getClientVersion(): string {
    return resolvePlatformClientVersion(CONFIG.platform, CONFIG.clientVersion);
}

function getLoginDeviceInfo(): Record<string, any> {
    const device = CONFIG.deviceInfo || {};
    const info: Record<string, any> = {
        client_version: getClientVersion(),
        sys_software: device.sysSoftware || 'Windows',
    };
    if (isWechatPlatform()) {
        if (device.network) info.network = String(device.network);
        if (device.deviceId) info.device_id = String(device.deviceId);
        const memory = Number(device.memory);
        if (Number.isSafeInteger(memory) && memory > 0) info.memory = memory;
    }
    return info;
}

module.exports = { WX_CLIENT_VERSION, isWechatPlatform, resolvePlatformClientVersion, getClientVersion, getLoginDeviceInfo };
