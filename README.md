# homebridge-melk-elk-ble-light

Homebridge platform plugin for controlling MELK/ELK BLE lights.

## Features

- Scans by device name fragment(s)
- Connects on demand, retries once on write failure
- Auto-disconnects after idle timeout
- Exposes each configured device as a HomeKit `Lightbulb`
- Supports `On`, `Hue`, `Saturation`, and `Brightness`

## Install

```bash
npm install
npm run build
```

Link/install into Homebridge as usual for local plugins.

## Example Config

```json
{
  "platforms": [
    {
      "platform": "MelkBlePlatform",
      "name": "MELK BLE Lights",
      "devices": [
        {
          "name": "Desk Light",
          "targetNames": ["MELK-OA21"],
          "writeUuid": "0000fff3-0000-1000-8000-00805f9b34fb",
          "writeWithResponse": false,
          "scanTimeoutMs": 1000,
          "connectTimeoutMs": 8000,
          "postWriteDelayMs": 50,
          "idleTimeoutSeconds": 300
        }
      ]
    }
  ]
}
```

## Notes

- BLE support depends on host OS capabilities and adapter permissions.
- On Linux, run Homebridge with BLE permissions (often via `sudo setcap` on Node binary or running with elevated privileges).
- If your light uses a different write characteristic, set `writeUuid` per device.
