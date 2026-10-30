#!/bin/sh
# Start handmedown (if it isn't already running) and open the board in its own
# borderless Chrome window.
#
#   ./start.sh               a normal window: drag it to a screen, or give it
#                            its own full-screen Space on a laptop
#   ./start.sh --fullscreen  fill the screen (a dedicated monitor at home)
cd "$(dirname "$0")" || exit 1

port=${HANDMEDOWN_PORT:-$(python3 -c 'import json; print(json.load(open("handmedown.json")).get("port", 8800))' 2>/dev/null || echo 8800)}
url="http://127.0.0.1:$port/"

if ! curl -s -o /dev/null "$url"; then
  mkdir -p state
  nohup python3 -u server.py --port "$port" >> state/server.log 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null "$url" && break
    sleep 0.3
  done
  if ! curl -s -o /dev/null "$url"; then
    echo "handmedown: server didn't start; see state/server.log" >&2
    exit 1
  fi
  echo "handmedown: server running on $url (log: state/server.log)"
fi

# A separate Chrome profile gives the board its own app window (and Dock icon),
# and makes Chrome honour the window flags even when Chrome is already open.
flags="--app=$url --user-data-dir=$HOME/.handmedown/chrome --no-first-run --no-default-browser-check"
[ "$1" = "--fullscreen" ] && flags="$flags --start-fullscreen"
# shellcheck disable=SC2086
open -na "Google Chrome" --args $flags
