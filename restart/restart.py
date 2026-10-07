"""restart.py: the half of the restart mod that outlives Claude Code.

Started by the mod just before it runs /exit, through `cmd /c start /b` so it is not in Claude's process tree. It
stays attached to the same console, waits until no claude.exe is attached to that console any more, gives the shell
a moment to draw its prompt, then types the relaunch command (`claude -c` by default) into the console input buffer
followed by Enter, exactly as if you had typed it. Windows only: it uses GetConsoleProcessList and WriteConsoleInputW.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as w
import os
import sys
import time
from pathlib import Path

LOG = Path(os.environ.get("TEMP", ".")) / "claude-restart.log"


def log(line: str) -> None:
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {line}\n")
    except OSError:
        pass


def detach_stdio() -> None:
    """Close the inherited stdout/stderr pipes so the parent that started us can finish reading."""
    try:
        fd = os.open(os.devnull, os.O_RDWR)
        for target in (0, 1, 2):
            try:
                os.dup2(fd, target)
            except OSError:
                pass
    except OSError:
        pass


if sys.platform == "win32":
    k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    FILE_SHARE_READ = 1
    FILE_SHARE_WRITE = 2
    OPEN_EXISTING = 3
    KEY_EVENT = 0x0001
    VK_RETURN = 0x0D
    INVALID_HANDLE_VALUE = w.HANDLE(-1).value

    class KEY_EVENT_RECORD(ctypes.Structure):
        _fields_ = [
            ("bKeyDown", w.BOOL),
            ("wRepeatCount", w.WORD),
            ("wVirtualKeyCode", w.WORD),
            ("wVirtualScanCode", w.WORD),
            ("UnicodeChar", w.WCHAR),
            ("dwControlKeyState", w.DWORD),
        ]

    class INPUT_RECORD(ctypes.Structure):
        _fields_ = [("EventType", w.WORD), ("_pad", w.WORD), ("Event", KEY_EVENT_RECORD)]

    def console_pids() -> list[int]:
        n = 64
        while True:
            arr = (w.DWORD * n)()
            got = k32.GetConsoleProcessList(arr, n)
            if got == 0:
                return []
            if got <= n:
                return list(arr[:got])
            n = got

    def image_name(pid: int) -> str:
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return ""
        try:
            size = w.DWORD(32768)
            buf = ctypes.create_unicode_buffer(size.value)
            if not k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return ""
            return Path(buf.value).name.lower()
        finally:
            k32.CloseHandle(h)

    def claude_alive(pid: int | None) -> bool:
        pids = console_pids()
        if pid is not None and pid in pids:
            return True
        return any(image_name(p) in ("claude.exe", "claude") for p in pids if p != os.getpid())

    def key_records(text: str) -> ctypes.Array:
        chars = list(text)
        records = (INPUT_RECORD * (2 * len(chars) + 2))()
        i = 0
        for ch in chars:
            for down in (True, False):
                rec = records[i]
                rec.EventType = KEY_EVENT
                rec.Event.bKeyDown = down
                rec.Event.wRepeatCount = 1
                rec.Event.wVirtualKeyCode = 0
                rec.Event.wVirtualScanCode = 0
                rec.Event.UnicodeChar = ch
                rec.Event.dwControlKeyState = 0
                i += 1
        for down in (True, False):
            rec = records[i]
            rec.EventType = KEY_EVENT
            rec.Event.bKeyDown = down
            rec.Event.wRepeatCount = 1
            rec.Event.wVirtualKeyCode = VK_RETURN
            rec.Event.wVirtualScanCode = 0x1C
            rec.Event.UnicodeChar = "\r"
            rec.Event.dwControlKeyState = 0
            i += 1
        return records

    def type_into_console(text: str) -> bool:
        h = k32.CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, 0, None)
        if h == INVALID_HANDLE_VALUE or not h:
            log(f"CONIN$ open failed: {ctypes.GetLastError()}")
            return False
        try:
            records = key_records(text)
            written = w.DWORD(0)
            ok = k32.WriteConsoleInputW(h, records, len(records), ctypes.byref(written))
            log(f"WriteConsoleInputW ok={bool(ok)} written={written.value} of {len(records)} err={ctypes.GetLastError()}")
            return bool(ok) and written.value == len(records)
        finally:
            k32.CloseHandle(h)

else:  # pragma: no cover - the mod only starts this on Windows

    def console_pids() -> list[int]:
        return []

    def claude_alive(pid: int | None) -> bool:
        return False

    def type_into_console(text: str) -> bool:
        return False


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pid", type=int, default=None, help="Claude's process id, when the caller knows it")
    ap.add_argument("--settle", type=int, default=400, help="ms to wait after Claude is gone before typing")
    ap.add_argument("--timeout", type=int, default=120, help="seconds to wait for Claude to exit before giving up")
    ap.add_argument("--dry-run", action="store_true", help="print the console's processes and the command, type nothing")
    ap.add_argument("command", nargs=argparse.REMAINDER, help="what to type, after --; default: claude -c")
    a = ap.parse_args(argv)
    words = [x for x in a.command if x != "--"]
    command = " ".join(words) if words else "claude -c"

    if a.dry_run:
        pids = console_pids()
        print(f"console processes: {[(p, image_name(p) if sys.platform == 'win32' else '?') for p in pids]}")
        print(f"would type: {command!r}")
        return 0

    detach_stdio()
    log(f"start pid={os.getpid()} watching={a.pid} command={command!r} console={console_pids()}")
    deadline = time.monotonic() + a.timeout
    while claude_alive(a.pid):
        if time.monotonic() > deadline:
            log("gave up: claude still attached to this console")
            return 2
        time.sleep(0.2)
    time.sleep(max(0, a.settle) / 1000)
    ok = type_into_console(command)
    log(f"typed {command!r}: {'ok' if ok else 'FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
