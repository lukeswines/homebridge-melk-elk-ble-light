import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { MelkBlePlatform } from './platform';
import { BleSession } from './ble-session';
import type { MelkDeviceConfig } from './settings';

interface LightState {
  on: boolean;
  hue: number;
  saturation: number;
  brightness: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hsvToRgb(hue: number, saturation: number, value: number): { r: number; g: number; b: number } {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp(saturation / 100, 0, 1);
  const v = clamp(value / 100, 0, 1);

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let rp = 0;
  let gp = 0;
  let bp = 0;

  if (h < 60) {
    rp = c;
    gp = x;
  } else if (h < 120) {
    rp = x;
    gp = c;
  } else if (h < 180) {
    gp = c;
    bp = x;
  } else if (h < 240) {
    gp = x;
    bp = c;
  } else if (h < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }

  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

export class MelkLightAccessory {
  private readonly service: Service;
  private readonly bleSession: BleSession;

  private readonly state: LightState = {
    on: false,
    hue: 0,
    saturation: 0,
    brightness: 100,
  };

  constructor(
    private readonly platform: MelkBlePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: MelkDeviceConfig,
  ) {
    this.bleSession = BleSession.fromDeviceConfig(config);

    this.service =
      this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);

    this.service.setCharacteristic(this.platform.Characteristic.Name, config.name);

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.Hue)
      .onGet(this.getHue.bind(this))
      .onSet(this.setHue.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.Saturation)
      .onGet(this.getSaturation.bind(this))
      .onSet(this.setSaturation.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(this.getBrightness.bind(this))
      .onSet(this.setBrightness.bind(this));
  }

  private getOn(): CharacteristicValue {
    return this.state.on;
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = !!value;
    this.state.on = on;

    if (!on) {
      await this.bleSession.setPower(false);
      return;
    }

    await this.bleSession.setPower(true);
    await this.pushCurrentColor();
  }

  private getHue(): CharacteristicValue {
    return this.state.hue;
  }

  private async setHue(value: CharacteristicValue): Promise<void> {
    this.state.hue = clamp(Number(value), 0, 360);
    await this.pushCurrentColorIfOn();
  }

  private getSaturation(): CharacteristicValue {
    return this.state.saturation;
  }

  private async setSaturation(value: CharacteristicValue): Promise<void> {
    this.state.saturation = clamp(Number(value), 0, 100);
    await this.pushCurrentColorIfOn();
  }

  private getBrightness(): CharacteristicValue {
    return this.state.brightness;
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    this.state.brightness = clamp(Number(value), 0, 100);
    await this.pushCurrentColorIfOn();
  }

  private async pushCurrentColorIfOn(): Promise<void> {
    if (!this.state.on) {
      return;
    }

    await this.pushCurrentColor();
  }

  private async pushCurrentColor(): Promise<void> {
    const { r, g, b } = hsvToRgb(this.state.hue, this.state.saturation, this.state.brightness);
    this.platform.log.debug(`Setting ${this.config.name} color to RGB(${r}, ${g}, ${b})`);
    await this.bleSession.setColor(r, g, b);
  }

  async shutdown(): Promise<void> {
    await this.bleSession.disconnect();
  }
}
