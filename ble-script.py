import asyncio
from functools import partial
from bleak import BleakClient, BleakScanner

MELK_NAMES = ("MELK-OA21",)
SCAN_TIMEOUT_S = 1.0
CONNECT_TIMEOUT_S = 8.0
WRITE_UUID = "0000fff3-0000-1000-8000-00805f9b34fb"
WRITE_WITH_RESPONSE = False

# Some devices need a tiny delay after write.
POST_WRITE_DELAY_S = 0.05
DEFAULT_IDLE_TIMEOUT_S = 300.0

# Serialize connect/write/disconnect so rapid commands don't collide.
_tx_lock = asyncio.Lock()
_resolved_device = None
_client = None
_idle_timeout_s = DEFAULT_IDLE_TIMEOUT_S
_idle_task = None


def pkt_power(on: bool) -> bytearray:
    return bytearray([0x7E, 0x00, 0x04, 0x01 if on else 0x00, 0x00, 0x00, 0x00, 0x00, 0xEF])


def pkt_color(r: int, g: int, b: int) -> bytearray:
    for v in (r, g, b):
        if not (0 <= v <= 255):
            raise ValueError("RGB values must be in 0..255")
    return bytearray([0x7E, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xEF])


async def ainput(prompt: str = "") -> str:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, partial(input, prompt))


async def resolve_device_address() -> str:
    global _resolved_device
    if _resolved_device:
        return _resolved_device.address

    devices = await BleakScanner.discover(timeout=SCAN_TIMEOUT_S)
    for device in devices:
        name = (device.name or "").strip()
        if any(target.lower() in name.lower() for target in MELK_NAMES):
            _resolved_device = device
            return device.address

    raise RuntimeError(f"No BLE device found matching names: {', '.join(MELK_NAMES)}")


def _idle_timeout_label() -> str:
    if _idle_timeout_s is None:
        return "off"
    return f"{_idle_timeout_s:.1f}s"


def _cancel_idle_task_locked() -> None:
    global _idle_task
    if _idle_task is None:
        return
    if _idle_task is not asyncio.current_task():
        _idle_task.cancel()
    _idle_task = None


async def _idle_disconnect_worker(timeout_s: float) -> None:
    try:
        await asyncio.sleep(timeout_s)
    except asyncio.CancelledError:
        return

    async with _tx_lock:
        # Only disconnect if this is still the active timer.
        if _idle_task is not asyncio.current_task():
            return
        await _disconnect_client(reason=f"idle timeout ({timeout_s:.1f}s)")
        print("auto-disconnected")


def _arm_idle_timer_locked() -> None:
    _cancel_idle_task_locked()
    if _client is None or not _client.is_connected:
        return
    if _idle_timeout_s is None:
        return
    _idle = float(_idle_timeout_s)
    if _idle <= 0:
        return
    global _idle_task
    _idle_task = asyncio.create_task(_idle_disconnect_worker(_idle))


async def _disconnect_client(reason: str = "") -> None:
    global _client
    _cancel_idle_task_locked()
    if _client is None:
        return
    try:
        if _client.is_connected:
            await _client.disconnect()
    finally:
        _client = None


async def _ensure_connected() -> BleakClient:
    global _client, _resolved_device
    if _client is not None and _client.is_connected:
        _arm_idle_timer_locked()
        return _client

    await _disconnect_client()
    last_error = None
    for attempt in (1, 2):
        try:
            device_address = await resolve_device_address()
            _client = BleakClient(device_address)
            await asyncio.wait_for(_client.connect(), timeout=CONNECT_TIMEOUT_S)
            if not _client.is_connected:
                raise RuntimeError("Failed to connect")
            _arm_idle_timer_locked()
            return _client
        except Exception as e:
            last_error = e
            await _disconnect_client()
            # Retry once with a fresh scan in case the cached peripheral is stale.
            _resolved_device = None
            if attempt == 2:
                break
    raise RuntimeError(f"Unable to connect: {last_error}")


async def ensure_connected() -> None:
    async with _tx_lock:
        await _ensure_connected()


async def disconnect() -> None:
    async with _tx_lock:
        await _disconnect_client()


async def reconnect() -> None:
    async with _tx_lock:
        await _disconnect_client()
        await _ensure_connected()


async def connection_status() -> str:
    async with _tx_lock:
        if _client is not None and _client.is_connected:
            return f"connected (idle timeout: {_idle_timeout_label()})"
        return f"disconnected (idle timeout: {_idle_timeout_label()})"


async def set_idle_timeout(value: float | None) -> str:
    global _idle_timeout_s
    async with _tx_lock:
        _idle_timeout_s = value
        _arm_idle_timer_locked()
        return _idle_timeout_label()


async def send(payload: bytearray) -> None:
    """
    Write over a shared BLE connection.
    If a write fails due to a dropped link, reconnect once and retry.
    """
    async with _tx_lock:
        client = await _ensure_connected()
        try:
            await client.write_gatt_char(WRITE_UUID, payload, response=WRITE_WITH_RESPONSE)
        except Exception:
            await _disconnect_client()
            client = await _ensure_connected()
            await client.write_gatt_char(WRITE_UUID, payload, response=WRITE_WITH_RESPONSE)

        if POST_WRITE_DELAY_S:
            await asyncio.sleep(POST_WRITE_DELAY_S)
        _arm_idle_timer_locked()
        print(f"sent: {payload.hex(' ')}")


def print_help() -> None:
    print(
        "\nCommands:\n"
        "  connect             Connect and keep the session open\n"
        "  disconnect          Disconnect current session\n"
        "  reconnect           Force reconnect\n"
        "  status              Show connection status\n"
        "  idle                Show idle timeout\n"
        "  idle <sec|off>      Set idle timeout (auto-disconnect)\n"
        "  on                  Power on\n"
        "  off                 Power off\n"
        "  blue|red|green|white Set common colors\n"
        "  color R G B          Set color by RGB (0-255 each)\n"
        "  raw <hex...>         Send raw bytes, e.g. raw 7e 00 04 01 00 00 00 00 ef\n"
        "  help                 Show this help\n"
        "  quit|exit            Exit\n"
    )


async def command_loop() -> None:
    presets = {
        "red": (255, 0, 0),
        "green": (0, 255, 0),
        "blue": (0, 0, 255),
        "white": (255, 255, 255),
    }

    print_help()

    while True:
        line = (await ainput("melk> ")).strip()
        if not line:
            continue

        parts = line.split()
        cmd = parts[0].lower()

        try:
            if cmd in ("quit", "exit"):
                await disconnect()
                return

            if cmd == "help":
                print_help()
                continue

            if cmd == "connect":
                await ensure_connected()
                print("connected")
                continue

            if cmd == "disconnect":
                await disconnect()
                print("disconnected")
                continue

            if cmd == "reconnect":
                await reconnect()
                print("reconnected")
                continue

            if cmd == "status":
                print(await connection_status())
                continue

            if cmd == "idle":
                if len(parts) == 1:
                    print(f"idle timeout: {_idle_timeout_label()}")
                    continue
                if len(parts) != 2:
                    print("usage: idle <sec|off>")
                    continue
                arg = parts[1].lower()
                if arg == "off":
                    label = await set_idle_timeout(None)
                    print(f"idle timeout set to {label}")
                    continue
                seconds = float(parts[1])
                if seconds <= 0:
                    raise ValueError("idle seconds must be > 0, or use 'off'")
                label = await set_idle_timeout(seconds)
                print(f"idle timeout set to {label}")
                continue

            if cmd == "on":
                await send(pkt_power(True))
                continue

            if cmd == "off":
                await send(pkt_power(False))
                continue

            if cmd in presets:
                r, g, b = presets[cmd]
                await send(pkt_color(r, g, b))
                continue

            if cmd == "color":
                if len(parts) != 4:
                    print("usage: color R G B   (each 0-255)")
                    continue
                r, g, b = (int(parts[1]), int(parts[2]), int(parts[3]))
                await send(pkt_color(r, g, b))
                continue

            if cmd == "raw":
                if len(parts) < 2:
                    print("usage: raw <hex bytes...>")
                    continue
                data = bytearray(int(x, 16) for x in parts[1:])
                await send(data)
                continue

            print(f"unknown command: {cmd} (type 'help')")
        except Exception as e:
            print(f"error: {e}")


async def main():
    try:
        await command_loop()
    finally:
        await disconnect()


if __name__ == "__main__":
    asyncio.run(main())
