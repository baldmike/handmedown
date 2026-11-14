#!/usr/bin/env python3
"""handmedown local server.

Serves the board (web/), configured actions, kitchen timers, Spotify control,
and the live board: cards and session status that scripts (bin/hmd, session
hooks) push and the page shows. Standard library only. Binds to 127.0.0.1.

    python3 server.py [--port 8800] [--config handmedown.json]
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
DEFAULTS = {
    "name": "handmedown",
    "port": 8800,
    # Your own commands for the apps ring: each runs an argv list (no shell)
    # from the project folder. None by default; built-in apps live in the page.
    "actions": [],
}
ACTION_TIMEOUT = 20
MAX_OUTPUT_CHARS = 2000
MAX_BODY = 1024 * 1024
STATE_FILE = ROOT / "state" / "board.json"
TONES = ("info", "ok", "warn", "error", "ask")
SESSION_STATES = ("idle", "working", "waiting", "done")
MAX_CARDS = 100
MAX_TIMERS = 4
MAX_TIMER_SECONDS = 24 * 3600


class Board:
    """Cards and session status, shared by every open page.

    Lives in the server (and state/board.json) rather than the browser, so
    nothing pushed while the page is hidden or closed is lost.
    """

    def __init__(self, path):
        self.path = path
        self.changed = threading.Condition()
        self.version = 0
        self.cards = {}
        self.sessions = {}
        self.timers = {}
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.cards = {c["id"]: c for c in saved.get("cards", [])}
            self.sessions = {s["source"]: s for s in saved.get("sessions", [])}
            self.timers = {t["id"]: t for t in saved.get("timers", [])}
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def snapshot(self):
        return {
            "version": self.version,
            "cards": list(self.cards.values()),
            "sessions": list(self.sessions.values()),
            "timers": list(self.timers.values()),
            "now": time.time(),
        }

    def _commit(self):
        # Caller holds self.changed.
        self.version += 1
        self.path.parent.mkdir(exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.snapshot()), encoding="utf-8")
        tmp.replace(self.path)
        self.changed.notify_all()

    def push(self, data):
        title = data.get("title")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("a card needs a title")
        tone = data.get("tone", "info")
        if tone not in TONES:
            raise ValueError(f"tone must be one of {', '.join(TONES)}")
        card_id = str(data.get("id") or uuid.uuid4().hex[:8])[:80]
        now = time.time()
        with self.changed:
            old = self.cards.get(card_id)
            self.cards[card_id] = {
                "id": card_id,
                "title": title[:200],
                "body": str(data.get("body") or "")[:20000],
                "tone": tone,
                "created": old["created"] if old else now,
                "updated": now,
            }
            while len(self.cards) > MAX_CARDS:
                del self.cards[next(iter(self.cards))]
            self._commit()
        return card_id

    def remove(self, card_id=None, everything=False):
        with self.changed:
            if everything:
                self.cards.clear()
            elif self.cards.pop(str(card_id), None) is None:
                return False
            self._commit()
        return True

    def set_status(self, source, state, label=""):
        source = str(source or "default")[:80]
        with self.changed:
            if state == "off":
                if self.sessions.pop(source, None) is None:
                    return
            elif state in SESSION_STATES:
                self.sessions[source] = {
                    "source": source,
                    "state": state,
                    "label": str(label or "")[:120],
                    "updated": time.time(),
                }
            else:
                raise ValueError(f"state must be one of {', '.join(SESSION_STATES)}, or off")
            self._commit()

    # ---- timers: stored as end times, so they keep running while the page is
    # hidden or closed, and through restarts.

    def add_timer(self, seconds, label=""):
        if type(seconds) not in (int, float) or not 1 <= seconds <= MAX_TIMER_SECONDS:
            raise ValueError("seconds must be between 1 and 86400")
        with self.changed:
            if len(self.timers) >= MAX_TIMERS:
                raise ValueError(f"at most {MAX_TIMERS} timers at once")
            timer_id = uuid.uuid4().hex[:6]
            now = time.time()
            self.timers[timer_id] = {
                "id": timer_id,
                "label": str(label or "")[:60],
                "seconds": seconds,
                "state": "running",
                "end": now + seconds,
                "left": None,
                "created": now,
            }
            self._commit()
        return timer_id

    def timer_op(self, timer_id, op, delta=0):
        with self.changed:
            if op == "dismiss-all":
                ringing = [k for k, t in self.timers.items() if t["state"] == "ringing"]
                for k in ringing:
                    del self.timers[k]
                if ringing:
                    self._commit()
                return bool(ringing)
            t = self.timers.get(str(timer_id))
            if t is None:
                return False
            now = time.time()
            if op in ("cancel", "dismiss"):
                del self.timers[t["id"]]
            elif op == "pause" and t["state"] == "running":
                t.update(state="paused", left=max(t["end"] - now, 1), end=None)
            elif op == "resume" and t["state"] == "paused":
                t.update(state="running", end=now + t["left"], left=None)
            elif op == "adjust" and t["state"] in ("running", "paused"):
                if type(delta) not in (int, float) or abs(delta) > MAX_TIMER_SECONDS:
                    raise ValueError("delta must be a number of seconds")
                if t["state"] == "running":
                    t["end"] = max(t["end"] + delta, now + 1)
                else:
                    t["left"] = max(t["left"] + delta, 1)
            elif op not in ("pause", "resume", "adjust"):
                raise ValueError("op must be pause, resume, adjust, cancel, dismiss or dismiss-all")
            else:
                return True
            self._commit()
        return True

    def ring_due(self):
        """Mark running timers whose time is up as ringing. Returns them."""
        now = time.time()
        with self.changed:
            due = [t for t in self.timers.values() if t["state"] == "running" and t["end"] <= now]
            for t in due:
                t["state"] = "ringing"
            if due:
                self._commit()
        return due

    def wait(self, seen, timeout):
        """Block until the board moves past version `seen` (or timeout)."""
        with self.changed:
            if self.version == seen:
                self.changed.wait(timeout)
            return self.snapshot() if self.version != seen else None


# Spotify on this Mac, through its AppleScript dictionary. Only these fixed
# scripts run; the volume step is the one number passed in, and it's clamped.
# "if running" first, so asking for the status never launches Spotify.
SPOTIFY_STATUS = """
if application "Spotify" is not running then return "off"
tell application "Spotify"
  set out to (player state as string) & linefeed & (sound volume as string)
  try
    set out to out & linefeed & (player position as string) & linefeed & (duration of current track as string)
    set out to out & linefeed & (name of current track) & linefeed & (artist of current track)
  end try
  return out
end tell
"""
SPOTIFY_COMMANDS = {
    "prev": 'tell application "Spotify" to previous track',
    "playpause": 'tell application "Spotify" to playpause',
    "next": 'tell application "Spotify" to next track',
    "pause": 'tell application "Spotify" to pause',
    "play": 'tell application "Spotify" to play',
}
# Spotify reads back one less than it was set to (set 50, get 49), so set one
# higher to land on the number asked for; otherwise every step loses a point.
SPOTIFY_VOLUME = """
if application "Spotify" is not running then return
tell application "Spotify"
  set v to (sound volume) + ({step})
  if v < 0 then set v to 0
  if v > 100 then set v to 100
  if v < 100 and v > 0 then set v to v + 1
  set sound volume to v
end tell
"""


def osascript(script):
    done = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=5)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip() or "osascript failed")
    return done.stdout.strip()


def spotify(cmd=None, step=0):
    """Run a transport command (or none), then report what's playing."""
    try:
        before = osascript(SPOTIFY_STATUS) if cmd in SPOTIFY_COMMANDS else None
        if cmd in SPOTIFY_COMMANDS:
            osascript(SPOTIFY_COMMANDS[cmd])
        elif cmd == "volume":
            osascript(SPOTIFY_VOLUME.format(step=max(-25, min(25, int(step)))))
        out = osascript(SPOTIFY_STATUS)
        # Spotify takes a moment to report a pause or a new song: wait (up to
        # a second) for the status to change, so the board shows what happened.
        what = lambda status: [line for i, line in enumerate(status.split("\n")) if i in (0, 4)]  # state, track
        waited = 0
        while before is not None and what(out) == what(before) and waited < 1.0:
            time.sleep(0.15)
            waited += 0.15
            out = osascript(SPOTIFY_STATUS)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as err:
        return {"running": False, "error": str(err)}
    if out == "off":
        return {"running": False}
    fields = out.split("\n") + [""] * 6

    def number(text):
        try:
            return float(text.replace(",", "."))  # some locales write 44,27
        except ValueError:
            return None

    duration_ms = number(fields[3])
    return {
        "running": True,
        "state": fields[0],
        "volume": int(fields[1]) if fields[1].isdigit() else None,
        "position": number(fields[2]),  # seconds into the song
        "duration": duration_ms / 1000 if duration_ms else None,  # seconds
        "track": fields[4],
        "artist": fields[5],
    }


def notify(timer):
    """A macOS notification, so a finished timer reaches you when the board
    window isn't in front. Quietly does nothing elsewhere."""
    if sys.platform != "darwin":
        return
    label = timer["label"] or "Timer"
    script = 'display notification (item 1 of argv) with title "handmedown" sound name "Glass"'
    script = f"on run argv\n{script}\nend run"
    try:
        subprocess.run(["osascript", "-e", script, f"{label}: time's up"],
                       capture_output=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        pass


def watch_timers(board):
    while True:
        for timer in board.ring_due():
            print(f"handmedown: timer {timer['label'] or timer['id']!r} is up", flush=True)
            threading.Thread(target=notify, args=(timer,), daemon=True).start()
        time.sleep(0.25)


def load_config(path):
    config = dict(DEFAULTS)
    if path.is_file():
        with path.open(encoding="utf-8") as f:
            config.update(json.load(f))
    config["actions"] = valid_actions(config.get("actions"))
    return config


def valid_actions(raw):
    actions = []
    for a in raw or []:
        run = a.get("run") if isinstance(a, dict) else None
        if isinstance(run, list) and run and all(isinstance(x, str) for x in run):
            actions.append({"title": str(a.get("title") or run[0]), "run": run})
        else:
            print(f"handmedown: skipping bad action {a!r} (needs a non-empty 'run' list)")
    return actions


def run_action(action):
    try:
        done = subprocess.run(
            action["run"], cwd=ROOT, capture_output=True, text=True,
            timeout=ACTION_TIMEOUT, stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return {"ok": False, "output": f"command not found: {action['run'][0]}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "output": f"timed out after {ACTION_TIMEOUT}s"}
    output = (done.stdout + done.stderr).strip()[:MAX_OUTPUT_CHARS]
    return {"ok": done.returncode == 0, "output": output}


class Handler(SimpleHTTPRequestHandler):
    config = None  # set in main()
    board = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def host_ok(self):
        # Refuse requests whose Host isn't loopback (guards against DNS rebinding).
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in ("127.0.0.1", "localhost", "[::1]")

    def post_ok(self):
        # Writes and actions need the X-Handmedown header. Browsers can't send a
        # custom header cross-site without a CORS preflight, which this server
        # never approves, so other websites can't drive the board. Scripts
        # (curl, bin/hmd) send it and have no Origin.
        own = f"http://{self.headers.get('Host')}"
        return (
            self.host_ok()
            and self.headers.get("X-Handmedown") == "1"
            and self.headers.get("Origin", own) == own
        )

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("request too large")
        data = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("expected a JSON object")
        return data

    def stream_events(self):
        """Server-sent events: a full board snapshot on every change."""
        self.close_connection = True
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        seen = -1
        try:
            while True:
                snap = self.board.wait(seen, timeout=15)
                if snap is None:
                    self.wfile.write(b": keepalive\n\n")
                else:
                    seen = snap["version"]
                    self.wfile.write(f"data: {json.dumps(snap)}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            if url.path == "/":
                self.path = "/index.html"
            return super().do_GET()
        if not self.host_ok():
            return self.send_json({"error": "forbidden host"}, HTTPStatus.FORBIDDEN)

        if url.path == "/api/board":
            with self.board.changed:
                snap = self.board.snapshot()
            return self.send_json(snap)
        if url.path == "/api/events":
            return self.stream_events()
        if url.path == "/api/spotify":
            return self.send_json(spotify())
        if url.path == "/api/config":
            titles = [a["title"] for a in self.config["actions"]]
            return self.send_json({"name": self.config["name"], "actions": titles})
        return self.send_json({"error": "unknown endpoint"}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        url = urlparse(self.path)
        if not self.post_ok():
            return self.send_json({"error": "forbidden"}, HTTPStatus.FORBIDDEN)
        try:
            data = self.read_json()
        except ValueError as err:
            return self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)

        try:
            if url.path == "/api/push":
                return self.send_json({"id": self.board.push(data)})
            if url.path == "/api/remove":
                found = self.board.remove(data.get("id"), everything=data.get("all") is True)
                return self.send_json({"removed": found})
            if url.path == "/api/timer":
                op = data.get("op", "add")
                if op == "add":
                    return self.send_json({"id": self.board.add_timer(data.get("seconds"), data.get("label"))})
                found = self.board.timer_op(data.get("id"), op, data.get("delta", 0))
                return self.send_json({"ok": found})
            if url.path == "/api/status":
                self.board.set_status(data.get("source"), data.get("state"), data.get("label"))
                return self.send_json({"ok": True})
        except ValueError as err:
            return self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)

        if url.path == "/api/spotify":
            cmd = data.get("cmd")
            if cmd not in (*SPOTIFY_COMMANDS, "volume"):
                return self.send_json({"error": "unknown spotify command"}, HTTPStatus.BAD_REQUEST)
            step = data.get("step", 0)
            if type(step) is not int:
                return self.send_json({"error": "step must be a whole number"}, HTTPStatus.BAD_REQUEST)
            return self.send_json(spotify(cmd, step))
        if url.path == "/api/run":
            index = data.get("index")
            if type(index) is not int or not 0 <= index < len(self.config["actions"]):
                return self.send_json({"error": "no such action"}, HTTPStatus.BAD_REQUEST)
            action = self.config["actions"][index]
            print(f"handmedown: running {action['title']!r}: {action['run']}", flush=True)
            return self.send_json(run_action(action))
        return self.send_json({"error": "unknown endpoint"}, HTTPStatus.NOT_FOUND)


def main():
    parser = argparse.ArgumentParser(description="handmedown board server")
    parser.add_argument("--config", default=str(ROOT / "handmedown.json"))
    parser.add_argument("--port", type=int)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    config = load_config(Path(args.config))
    port = args.port or int(config["port"])
    Handler.config = config
    Handler.board = Board(STATE_FILE)
    threading.Thread(target=watch_timers, args=(Handler.board,), daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True  # open event streams mustn't block shutdown
    print(f"handmedown: open http://127.0.0.1:{port}/ in Chrome")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
