import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { MelkLightAccessory } from './accessory';
import type { MelkDeviceConfig, MelkPlatformConfig } from './settings';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export class MelkBlePlatform implements DynamicPlatformPlugin {
  public readonly Service = this.api.hap.Service;
  public readonly Characteristic = this.api.hap.Characteristic;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly activeAccessories = new Map<string, MelkLightAccessory>();

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.config = config as MelkPlatformConfig;

    this.api.on('didFinishLaunching', () => {
      void this.syncAccessories();
    });

    this.api.on('shutdown', () => {
      void this.shutdown();
    });
  }

  private readonly config: MelkPlatformConfig;

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private async syncAccessories(): Promise<void> {
    const devices = this.config.devices ?? [];
    const desiredUuids = new Set<string>();

    for (const device of devices) {
      if (!this.isValidDevice(device)) {
        this.log.warn(`Skipping invalid device config: ${JSON.stringify(device)}`);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`${device.name}:${device.targetNames.join('|')}`);
      desiredUuids.add(uuid);

      const cached = this.cachedAccessories.get(uuid);
      if (cached) {
        cached.context.deviceConfig = device;
        this.activeAccessories.set(uuid, new MelkLightAccessory(this, cached, device));
        this.log.info(`Restored accessory from cache: ${device.name}`);
        continue;
      }

      const accessory = new this.api.platformAccessory(device.name, uuid);
      accessory.context.deviceConfig = device;
      this.activeAccessories.set(uuid, new MelkLightAccessory(this, accessory, device));
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Registered new accessory: ${device.name}`);
    }

    const staleAccessories = [...this.cachedAccessories.entries()]
      .filter(([uuid]) => !desiredUuids.has(uuid))
      .map(([, accessory]) => accessory);

    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      for (const accessory of staleAccessories) {
        this.cachedAccessories.delete(accessory.UUID);
      }
      this.log.info(`Unregistered ${staleAccessories.length} stale accessories`);
    }
  }

  private isValidDevice(device: Partial<MelkDeviceConfig>): device is MelkDeviceConfig {
    return (
      typeof device.name === 'string' &&
      device.name.length > 0 &&
      Array.isArray(device.targetNames) &&
      device.targetNames.length > 0 &&
      device.targetNames.every((name) => typeof name === 'string' && name.length > 0)
    );
  }

  private async shutdown(): Promise<void> {
    const running = [...this.activeAccessories.values()];
    this.activeAccessories.clear();

    await Promise.allSettled(running.map((accessory) => accessory.shutdown()));
  }
}
