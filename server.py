#!/usr/bin/env python3
"""handmedown local server.

Serves the board (web/), a read-only JSON API over a folder of markdown
notes, configured actions, and the live board: cards and session status that
scripts (bin/hmd, Claude Code hooks) push and the page shows. Standard library
only. Binds to 127.0.0.1.

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
    "notes": "sample-notes",
    # Each action runs an argv list (no shell) from the project folder.
    "actions": [
        {"title": "Calculator", "run": ["open", "-a", "Calculator"]},
        {"title": "What time is it?", "run": ["date", "+%A %-I:%M %p"]},
        {"title": "Say hello", "run": ["say", "Hello from handmedown"]},
        {"title": "Show notes folder", "run": ["open", "sample-notes"]},
    ],
}
MAX_NOTE_BYTES = 512 * 1024
ACTION_TIMEOUT = 20
MAX_OUTPUT_CHARS = 2000
MAX_BODY = 1024 * 1024
STATE_FILE = ROOT / "state" / "board.json"
TONES = ("info", "ok", "warn", "error", "ask")
SESSION_STATES = ("idle", "working", "waiting", "done")
MAX_CARDS = 100


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
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.cards = {c["id"]: c for c in saved.get("cards", [])}
            self.sessions = {s["source"]: s for s in saved.get("sessions", [])}
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def snapshot(self):
        return {
            "version": self.version,
            "cards": list(self.cards.values()),
            "sessions": list(self.sessions.values()),
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

    def wait(self, seen, timeout):
        """Block until the board moves past version `seen` (or timeout)."""
        with self.changed:
            if self.version == seen:
                self.changed.wait(timeout)
            return self.snapshot() if self.version != seen else None


def load_config(path):
    config = dict(DEFAULTS)
    if path.is_file():
        with path.open(encoding="utf-8") as f:
            config.update(json.load(f))
    notes = Path(os.path.expanduser(str(config["notes"])))
    if not notes.is_absolute():
        notes = ROOT / notes
    config["notes"] = notes.resolve()
    config["actions"] = valid_actions(config.get("actions"))
    return config


def note_tree(notes_root):
    """Group every .md file under notes_root by its folder (relative path)."""
    groups = {}
    for dirpath, dirnames, filenames in os.walk(notes_root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        rel_dir = Path(dirpath).relative_to(notes_root)
        for name in sorted(filenames):
            if name.startswith(".") or not name.lower().endswith(".md"):
                continue
            folder = rel_dir.as_posix() if rel_dir.parts else notes_root.name
            groups.setdefault(folder, []).append(
                {"title": name[:-3], "path": (rel_dir / name).as_posix()}
            )
    return [{"name": k, "notes": v} for k, v in groups.items()]


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


def resolve_note(notes_root, rel):
    """Return the real path of a note, or None if it escapes notes_root."""
    if not rel or not rel.lower().endswith(".md"):
        return None
    target = (notes_root / rel).resolve()
    if target != notes_root and notes_root not in target.parents:
        return None
    return target if target.is_file() else None


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

        notes_root = self.config["notes"]
        if url.path == "/api/board":
            with self.board.changed:
                snap = self.board.snapshot()
            return self.send_json(snap)
        if url.path == "/api/events":
            return self.stream_events()
        if url.path == "/api/config":
            titles = [a["title"] for a in self.config["actions"]]
            return self.send_json({"name": self.config["name"], "actions": titles})
        if url.path == "/api/notes":
            if not notes_root.is_dir():
                return self.send_json({"folders": [], "error": "notes folder not found"})
            return self.send_json({"folders": note_tree(notes_root)})
        if url.path == "/api/note":
            rel = parse_qs(url.query).get("path", [""])[0]
            target = resolve_note(notes_root, rel)
            if target is None:
                return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            with target.open("rb") as f:
                text = f.read(MAX_NOTE_BYTES).decode("utf-8", errors="replace")
            return self.send_json({"title": target.stem, "path": rel, "markdown": text})
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
            if url.path == "/api/status":
                self.board.set_status(data.get("source"), data.get("state"), data.get("label"))
                return self.send_json({"ok": True})
        except ValueError as err:
            return self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)

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

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True  # open event streams mustn't block shutdown
    print(f"handmedown: notes from {config['notes']}")
    print(f"handmedown: open http://127.0.0.1:{port}/ in Chrome")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
