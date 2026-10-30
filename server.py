#!/usr/bin/env python3
"""handmedown local server.

Serves the board (web/) and a small read-only JSON API over a folder of
markdown notes. Standard library only. Binds to 127.0.0.1.

    python3 server.py [--port 8800] [--config handmedown.json]
"""

import argparse
import json
import os
import subprocess
import sys
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

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            if url.path == "/":
                self.path = "/index.html"
            return super().do_GET()
        if not self.host_ok():
            return self.send_json({"error": "forbidden host"}, HTTPStatus.FORBIDDEN)

        notes_root = self.config["notes"]
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
        # Actions run commands, so only the board itself may trigger them: the
        # custom header can't be sent cross-site without a CORS preflight,
        # which this server never approves.
        if (
            url.path != "/api/run"
            or not self.host_ok()
            or self.headers.get("X-Handmedown") != "1"
            or self.headers.get("Origin", f"http://{self.headers.get('Host')}")
            != f"http://{self.headers.get('Host')}"
        ):
            return self.send_json({"error": "forbidden"}, HTTPStatus.FORBIDDEN)
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 4096)
            index = json.loads(self.rfile.read(length) or b"{}").get("index")
            if type(index) is not int or index < 0:
                raise IndexError
            action = self.config["actions"][index]
        except (ValueError, TypeError, IndexError, AttributeError):
            return self.send_json({"error": "no such action"}, HTTPStatus.BAD_REQUEST)
        print(f"handmedown: running {action['title']!r}: {action['run']}", flush=True)
        return self.send_json(run_action(action))


def main():
    parser = argparse.ArgumentParser(description="handmedown board server")
    parser.add_argument("--config", default=str(ROOT / "handmedown.json"))
    parser.add_argument("--port", type=int)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    config = load_config(Path(args.config))
    port = args.port or int(config["port"])
    Handler.config = config

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"handmedown: notes from {config['notes']}")
    print(f"handmedown: open http://127.0.0.1:{port}/ in Chrome")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
