#!/usr/bin/env python3
"""handmedown local server.

Serves the board (web/) and a small read-only JSON API over a folder of
markdown notes. Standard library only. Binds to 127.0.0.1.

    python3 server.py [--port 8800] [--config handmedown.json]
"""

import argparse
import json
import os
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
DEFAULTS = {"name": "handmedown", "port": 8800, "notes": "sample-notes"}
MAX_NOTE_BYTES = 512 * 1024


def load_config(path):
    config = dict(DEFAULTS)
    if path.is_file():
        with path.open(encoding="utf-8") as f:
            config.update(json.load(f))
    notes = Path(os.path.expanduser(str(config["notes"])))
    if not notes.is_absolute():
        notes = ROOT / notes
    config["notes"] = notes.resolve()
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
            return self.send_json({"name": self.config["name"]})
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
