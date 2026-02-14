export const PLUGIN_NAME = 'homebridge-melk-ble-light';
export const PLATFORM_NAME = 'MelkBlePlatform';

export const DEFAULT_SCAN_TIMEOUT_MS = 1000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
export const DEFAULT_POST_WRITE_DELAY_MS = 50;
export const DEFAULT_IDLE_TIMEOUT_MS = 300000;
export const DEFAULT_WRITE_UUID = '0000fff3-0000-1000-8000-00805f9b34fb';

export interface MelkDeviceConfig {
  name: string;
  targetNames: string[];
  writeUuid?: string;
  writeWithResponse?: boolean;
  scanTimeoutMs?: number;
  connectTimeoutMs?: number;
  postWriteDelayMs?: number;
  idleTimeoutSeconds?: number;
}

export interface MelkPlatformConfig {
  platform: string;
  name?: string;
  devices: MelkDeviceConfig[];
}
