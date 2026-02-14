import { EventEmitter } from 'node:events';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POST_WRITE_DELAY_MS,
  DEFAULT_SCAN_TIMEOUT_MS,
  DEFAULT_WRITE_UUID,
  type MelkDeviceConfig,
} from './settings';

// noble is CommonJS; using require keeps compatibility across runtime/package variants.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const noble: NobleApi = require('@abandonware/noble');

interface NobleApi extends EventEmitter {
  state: string;
  startScanningAsync(serviceUUIDs: string[], allowDuplicates?: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
}

interface NoblePeripheral extends EventEmitter {
  address: string;
  advertisement?: {
    localName?: string;
  };
  state?: string;
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverAllServicesAndCharacteristicsAsync(): Promise<{ characteristics: NobleCharacteristic[] }>;
}

interface NobleCharacteristic {
  uuid: string;
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
}

function toPacketPower(on: boolean): Buffer {
  return Buffer.from([0x7e, 0x00, 0x04, on ? 0x01 : 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]);
}

function toPacketColor(r: number, g: number, b: number): Buffer {
  const rgb = [r, g, b];
  for (const value of rgb) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('RGB values must be integers in 0..255');
    }
  }

  return Buffer.from([0x7e, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xef]);
}

function normalizeUuid(uuid: string): string {
  return uuid.replaceAll('-', '').toLowerCase();
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timeout);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

export interface BleSessionOptions {
  targetNames: string[];
  writeUuid?: string;
  writeWithResponse?: boolean;
  scanTimeoutMs?: number;
  connectTimeoutMs?: number;
  postWriteDelayMs?: number;
  idleTimeoutMs?: number;
}

export class BleSession {
  private readonly targetNames: string[];
  private readonly writeUuid: string;
  private readonly writeWithResponse: boolean;
  private readonly scanTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly postWriteDelayMs: number;
  private idleTimeoutMs: number | null;

  private queue: Promise<void> = Promise.resolve();
  private cachedPeripheral: NoblePeripheral | null = null;
  private peripheral: NoblePeripheral | null = null;
  private characteristic: NobleCharacteristic | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(options: BleSessionOptions) {
    this.targetNames = options.targetNames;
    this.writeUuid = options.writeUuid ?? DEFAULT_WRITE_UUID;
    this.writeWithResponse = options.writeWithResponse ?? false;
    this.scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.postWriteDelayMs = options.postWriteDelayMs ?? DEFAULT_POST_WRITE_DELAY_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  static fromDeviceConfig(config: MelkDeviceConfig): BleSession {
    return new BleSession({
      targetNames: config.targetNames,
      writeUuid: config.writeUuid,
      writeWithResponse: config.writeWithResponse,
      scanTimeoutMs: config.scanTimeoutMs,
      connectTimeoutMs: config.connectTimeoutMs,
      postWriteDelayMs: config.postWriteDelayMs,
      idleTimeoutMs: config.idleTimeoutSeconds === undefined ? undefined : config.idleTimeoutSeconds * 1000,
    });
  }

  setIdleTimeoutMs(value: number | null): void {
    this.idleTimeoutMs = value;
    this.armIdleTimer();
  }

  async setPower(on: boolean): Promise<void> {
    await this.send(toPacketPower(on));
  }

  async setColor(r: number, g: number, b: number): Promise<void> {
    await this.send(toPacketColor(r, g, b));
  }

  async disconnect(): Promise<void> {
    await this.withLock(async () => {
      await this.disconnectInternal();
    });
  }

  async send(payload: Buffer): Promise<void> {
    await this.withLock(async () => {
      let char = await this.ensureConnected();
      try {
        await this.writePayload(char, payload);
      } catch {
        await this.disconnectInternal();
        char = await this.ensureConnected();
        await this.writePayload(char, payload);
      }

      await delay(this.postWriteDelayMs);
      this.armIdleTimer();
    });
  }

  private async withLock(action: () => Promise<void>): Promise<void> {
    const chained = this.queue.then(action, action);
    this.queue = chained.catch(() => undefined);
    await chained;
  }

  private async waitForPoweredOn(): Promise<void> {
    if (noble.state === 'poweredOn') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onStateChange = (state: string) => {
        if (state !== 'poweredOn') {
          return;
        }

        clearTimeout(timeout);
        noble.removeListener('stateChange', onStateChange);
        resolve();
      };

      const timeout = setTimeout(() => {
        noble.removeListener('stateChange', onStateChange);
        reject(new Error('BLE adapter did not reach poweredOn state in time'));
      }, this.scanTimeoutMs);

      noble.on('stateChange', onStateChange);
    });
  }

  private async resolvePeripheral(): Promise<NoblePeripheral> {
    if (this.cachedPeripheral) {
      return this.cachedPeripheral;
    }

    await this.waitForPoweredOn();
    const targets = this.targetNames.map((name) => name.toLowerCase());

    const peripheral = await new Promise<NoblePeripheral>(async (resolve, reject) => {
      let finished = false;
      let timeout: NodeJS.Timeout | null = null;

      const onDiscover = async (candidate: NoblePeripheral) => {
        const name = candidate.advertisement?.localName?.trim().toLowerCase() ?? '';
        if (!targets.some((target) => name.includes(target))) {
          return;
        }

        await cleanup();
        resolve(candidate);
      };

      const cleanup = async () => {
        if (finished) {
          return;
        }

        finished = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        noble.removeListener('discover', onDiscover);
        try {
          await noble.stopScanningAsync();
        } catch {
          // best effort scan cleanup
        }
      };

      timeout = setTimeout(async () => {
        await cleanup();
        reject(new Error(`No BLE peripheral found matching: ${this.targetNames.join(', ')}`));
      }, this.scanTimeoutMs);

      noble.on('discover', onDiscover);
      try {
        await noble.startScanningAsync([], true);
      } catch (error) {
        await cleanup();
        reject(error);
      }
    });

    this.cachedPeripheral = peripheral;
    return peripheral;
  }

  private async ensureConnected(): Promise<NobleCharacteristic> {
    if (this.peripheral && this.peripheral.state === 'connected' && this.characteristic) {
      this.armIdleTimer();
      return this.characteristic;
    }

    await this.disconnectInternal();

    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const peripheral = await this.resolvePeripheral();
        await withTimeout(peripheral.connectAsync(), this.connectTimeoutMs, 'BLE connect');
        peripheral.on('disconnect', this.handleDisconnect);

        const discovered = await peripheral.discoverAllServicesAndCharacteristicsAsync();
        const normalizedWriteUuid = normalizeUuid(this.writeUuid);
        const characteristic = discovered.characteristics.find((char) => normalizeUuid(char.uuid) === normalizedWriteUuid);
        if (!characteristic) {
          throw new Error(`Could not find write characteristic ${this.writeUuid}`);
        }

        this.peripheral = peripheral;
        this.characteristic = characteristic;
        this.armIdleTimer();
        return characteristic;
      } catch (error) {
        lastError = error;
        this.cachedPeripheral = null;
        await this.disconnectInternal();
      }
    }

    throw new Error(`Unable to connect to BLE device: ${String(lastError)}`);
  }

  private async writePayload(characteristic: NobleCharacteristic, payload: Buffer): Promise<void> {
    // noble expects withoutResponse, inverse of writeWithResponse.
    await characteristic.writeAsync(payload, !this.writeWithResponse);
  }

  private async disconnectInternal(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const peripheral = this.peripheral;
    this.peripheral = null;
    this.characteristic = null;

    if (!peripheral) {
      return;
    }

    peripheral.removeListener('disconnect', this.handleDisconnect);
    try {
      if (peripheral.state === 'connected') {
        await peripheral.disconnectAsync();
      }
    } catch {
      // best effort cleanup
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!this.peripheral || this.peripheral.state !== 'connected') {
      return;
    }

    if (this.idleTimeoutMs === null || this.idleTimeoutMs <= 0) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      void this.disconnect();
    }, this.idleTimeoutMs);
  }

  private readonly handleDisconnect = () => {
    this.peripheral = null;
    this.characteristic = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  };
}
