"""walkie.py: push-to-talk to Claude Code from any app.

Hold a key (default F13: bind your spare mouse button to it) anywhere on the
desktop. The microphone records while the key is held, a local Whisper model
transcribes on release, and the words land as <epoch ms>.txt under
~/.claude/walkie/drops. The walkie mod inside Claude Code submits them as a
prompt and writes the answer under ~/.claude/walkie/replies, which this script
reads aloud with the Windows speech synthesizer.

    python walkie.py                 # F13, small.en on the CPU (no VRAM), speaks replies
    python walkie.py --model large-v3 --device cuda --compute float16   # the GPU, when it is free
    python walkie.py --key f14 --no-speak
    python walkie.py --list-devices  # pick a microphone for --mic

Beeps: high on record start, two-tone on a drop written, low when nothing was heard.
Pressing the key while a reply is being read stops the speech.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import winsound
from collections import deque
from pathlib import Path

import numpy as np

SR = 16000
BLOCK = 1600  # 100 ms of audio per callback
HEARTBEAT_S = 5
DEFAULT_VOCAB = (
    "Claude Code, TypeScript, React, npm, git, commit, branch, pull request, "
    "mod, plugin, hook, pane, terminal, PowerShell, Windows."
)
SPEAK_PS1 = """param([string]$File, [int]$Rate = 1)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = $Rate
$s.Speak([IO.File]::ReadAllText($File, [Text.Encoding]::UTF8))
"""
CREATE_NO_WINDOW = 0x08000000


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def beep(freq: int, ms: int) -> None:
    threading.Thread(target=winsound.Beep, args=(freq, ms), daemon=True).start()


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


class Mic:
    """The microphone, open the whole time; frames are kept only while recording, plus a short pre-roll."""

    def __init__(self, device, preroll_ms: int = 300) -> None:
        import sounddevice as sd

        self.lock = threading.Lock()
        self.recording = False
        self.frames: list[np.ndarray] = []
        self.preroll: deque[np.ndarray] = deque(maxlen=max(1, preroll_ms // 100))
        self.started_at = 0.0
        self.stream = sd.InputStream(
            samplerate=SR, channels=1, dtype="float32", blocksize=BLOCK, device=device, callback=self._on_audio
        )
        self.stream.start()

    def _on_audio(self, indata, frames, time_info, status) -> None:
        block = indata[:, 0].copy()
        with self.lock:
            if self.recording:
                self.frames.append(block)
            else:
                self.preroll.append(block)

    def start(self) -> bool:
        with self.lock:
            if self.recording:
                return False
            self.frames = list(self.preroll)
            self.preroll.clear()
            self.recording = True
            self.started_at = time.time()
        return True

    def stop(self) -> tuple[np.ndarray, float] | None:
        """The recording and how long the key was held, in seconds (the pre-roll not counted)."""
        with self.lock:
            if not self.recording:
                return None
            self.recording = False
            frames, self.frames = self.frames, []
            held = time.time() - self.started_at
        return (np.concatenate(frames) if frames else np.zeros(0, dtype=np.float32)), held


class Transcriber:
    def __init__(self, model: str, device: str, compute: str, language: str, beam: int, vocab: str, threads: int) -> None:
        from faster_whisper import WhisperModel

        try:
            self.model = WhisperModel(model, device=device, compute_type=compute, cpu_threads=threads)
        except Exception as err:  # noqa: BLE001 - any CUDA/ctranslate2 failure falls back to the CPU
            log(f"{device}/{compute} failed ({err}); falling back to cpu/int8")
            self.model = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=threads)
        self.language = language or None
        self.beam = beam
        self.vocab = vocab or None
        # warm the encoder and the decoder, without the VAD skipping the silence, so the first real clip is quick
        self.text(np.zeros(SR, dtype=np.float32), vad=False)

    def text(self, audio: np.ndarray, vad: bool = True) -> str:
        segments, _info = self.model.transcribe(
            audio,
            language=self.language,
            beam_size=self.beam,
            vad_filter=vad,
            initial_prompt=self.vocab,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip()


def speakable(markdown: str, max_chars: int) -> str:
    """Markdown as something a voice can say: code is skipped, links and bullets flattened."""
    t = re.sub(r"```.*?```", " Code omitted. ", markdown, flags=re.S)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"https?://\S+", "a link", t)
    t = re.sub(r"^\s{0,3}#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"^\s*(?:[-*+]|\d+\.)\s+", "", t, flags=re.M)
    t = re.sub(r"[*_~|>]+", "", t)
    t = re.sub(r"[ \t]+", " ", t).strip()
    if len(t) > max_chars:
        t = t[:max_chars].rsplit(" ", 1)[0] + ". The rest is in the terminal."
    return t


class Speaker:
    """Reads reply files aloud through System.Speech, one PowerShell process at a time."""

    def __init__(self, folder: Path, rate: int, max_chars: int, enabled: bool) -> None:
        self.replies = folder / "replies"
        self.ps1 = folder / "speak.ps1"
        self.ps1.write_text(SPEAK_PS1, encoding="utf-8")
        self.rate = rate
        self.max_chars = max_chars
        self.enabled = enabled
        self.proc: subprocess.Popen | None = None
        self.since = int(time.time() * 1000)
        self.seen: set[str] = set()

    def hush(self) -> bool:
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc = None
            return True
        return False

    def say(self, text: str) -> None:
        self.hush()
        fd, path = tempfile.mkstemp(suffix=".txt", prefix="walkie-say-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        self.proc = subprocess.Popen(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(self.ps1), "-File", path, "-Rate", str(self.rate)],
            creationflags=CREATE_NO_WINDOW,
        )

    def watch(self) -> None:
        while True:
            time.sleep(0.5)
            try:
                for f in sorted(self.replies.glob("*.txt")):
                    stem = f.stem
                    if stem in self.seen or not stem.isdigit() or int(stem) < self.since:
                        continue
                    if time.time() - f.stat().st_mtime < 0.3:
                        continue  # still being written
                    self.seen.add(stem)
                    text = f.read_text(encoding="utf-8", errors="replace")
                    f.unlink(missing_ok=True)
                    spoken = speakable(text, self.max_chars)
                    log(f"← {spoken[:120]}{'…' if len(spoken) > 120 else ''}")
                    if self.enabled and spoken:
                        self.say(spoken)
            except Exception as err:  # noqa: BLE001 - keep watching
                log(f"speaker: {err}")


def heartbeat(folder: Path, info: dict) -> None:
    path = folder / "recorder.json"
    while True:
        try:
            write_atomic(path, json.dumps({**info, "at": int(time.time() * 1000)}))
        except Exception as err:  # noqa: BLE001
            log(f"heartbeat: {err}")
        time.sleep(HEARTBEAT_S)


def pick_device(spec: str | None):
    if spec is None:
        return None
    import sounddevice as sd

    if spec.isdigit():
        return int(spec)
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0 and spec.lower() in d["name"].lower():
            return i
    raise SystemExit(f"no input device matches {spec!r}; see --list-devices")


def main() -> None:
    ap = argparse.ArgumentParser(description="Push-to-talk to Claude Code from any app.")
    ap.add_argument("--key", default="f13", help="the push-to-talk key, as the `keyboard` module names it (default f13)")
    ap.add_argument("--folder", default="~/.claude/walkie", help="exchange folder shared with the walkie mod")
    ap.add_argument("--model", default="small.en", help="faster-whisper model: small.en (default, CPU-friendly), base.en, medium, large-v3, large-v3-turbo")
    ap.add_argument("--device", default="cpu", help="cpu (default, no VRAM) or cuda")
    ap.add_argument("--compute", default="int8", help="ctranslate2 compute type: int8 on the CPU, float16 on the GPU")
    ap.add_argument("--threads", type=int, default=4, help="CPU threads for transcription, so a game keeps the rest")
    ap.add_argument("--language", default="en", help="dictation language code; empty to auto-detect")
    ap.add_argument("--beam", type=int, default=5)
    ap.add_argument("--vocab", default=DEFAULT_VOCAB, help="words hinted to the recognizer")
    ap.add_argument("--mic", help="input device index or name substring (default: system default)")
    ap.add_argument("--min-seconds", type=float, default=0.4, help="shorter recordings are ignored as accidental taps")
    ap.add_argument("--suppress", action="store_true", help="swallow the key so the focused app never sees it")
    ap.add_argument("--no-speak", action="store_true", help="do not read replies aloud")
    ap.add_argument("--rate", type=int, default=1, help="speech rate, -10 (slow) to 10 (fast)")
    ap.add_argument("--max-speak", type=int, default=1500, help="characters of a reply read aloud before it is cut")
    ap.add_argument("--list-devices", action="store_true")
    args = ap.parse_args()
    # the console may be cp1252; the log uses arrows and dots
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if args.list_devices:
        import sounddevice as sd

        print(sd.query_devices())
        return

    import keyboard

    folder = Path(args.folder).expanduser()
    drops = folder / "drops"
    replies = folder / "replies"
    drops.mkdir(parents=True, exist_ok=True)
    replies.mkdir(parents=True, exist_ok=True)

    # one recorder per folder: a fresh heartbeat means another one holds the key
    beat = folder / "recorder.json"
    if beat.exists() and time.time() - beat.stat().st_mtime < 3 * HEARTBEAT_S:
        try:
            other = json.loads(beat.read_text(encoding="utf-8")).get("pid")
        except Exception:  # noqa: BLE001
            other = "?"
        log(f"another recorder is already running (pid {other}); exiting")
        sys.exit(3)
    for leftover in list(drops.iterdir()) + list(replies.iterdir()):
        leftover.unlink(missing_ok=True)

    log(f"loading {args.model} on {args.device} ({args.compute})…")
    stt = Transcriber(args.model, args.device, args.compute, args.language, args.beam, args.vocab, args.threads)
    mic = Mic(pick_device(args.mic))
    speaker = Speaker(folder, args.rate, args.max_speak, not args.no_speak)
    jobs: queue.Queue[np.ndarray] = queue.Queue()

    def transcribe_forever() -> None:
        while True:
            audio = jobs.get()
            try:
                started = time.time()
                text = stt.text(audio)
                took = time.time() - started
            except Exception as err:  # noqa: BLE001
                log(f"transcription failed: {err}")
                beep(300, 200)
                continue
            if not text:
                log(f"(no speech in {len(audio) / SR:.1f}s)")
                beep(300, 120)
                continue
            stem = str(int(time.time() * 1000))
            write_atomic(drops / f"{stem}.txt", text)
            log(f"→ {text}  ({len(audio) / SR:.1f}s audio, {took:.2f}s)")
            beep(1000, 50)
            beep(1400, 50)

    def on_down(_event) -> None:
        speaker.hush()
        if mic.start():
            beep(880, 50)

    def on_up(_event) -> None:
        taken = mic.stop()
        if taken is None:
            return
        audio, held = taken
        if held < args.min_seconds:
            log(f"(too short: held {held:.1f}s)")
            beep(300, 80)
            return
        jobs.put(audio)

    threading.Thread(target=transcribe_forever, daemon=True).start()
    threading.Thread(target=speaker.watch, daemon=True).start()
    threading.Thread(
        target=heartbeat,
        args=(folder, {"pid": os.getpid(), "key": args.key, "model": args.model, "device": args.device, "since": int(time.time() * 1000)}),
        daemon=True,
    ).start()

    keyboard.on_press_key(args.key, on_down, suppress=args.suppress)
    keyboard.on_release_key(args.key, on_up, suppress=args.suppress)
    log(f"ready: hold {args.key.upper()} to talk · drops → {drops} · replies {'spoken' if not args.no_speak else 'logged only'}")
    try:
        keyboard.wait()
    except KeyboardInterrupt:
        pass
    finally:
        speaker.hush()
        (folder / "recorder.json").unlink(missing_ok=True)


if __name__ == "__main__":
    if sys.platform != "win32":
        raise SystemExit("walkie.py uses winsound and System.Speech; it runs on Windows")
    main()
