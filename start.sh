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

# The board belongs on the laptop's own screen, next to the laptop camera that
# tracks your hands, even with a bigger monitor attached. macOS measures
# screens from the bottom-left of the main one; Chrome wants top-left.
laptop=$(osascript -l JavaScript -e '
  ObjC.import("AppKit");
  const all = $.NSScreen.screens, mainH = all.objectAtIndex(0).frame.size.height;
  let out = "";
  for (let i = 0; i < all.count; i++) {
    const s = all.objectAtIndex(i);
    if (!/built-in/i.test(s.localizedName.js)) continue;
    const f = s.visibleFrame;
    out = [f.origin.x, mainH - f.origin.y - f.size.height, f.size.width, f.size.height].map(Math.round).join(" ");
  }
  out' 2>/dev/null)
if [ -n "$laptop" ]; then
  read -r lx ly lw lh <<EOF
$laptop
EOF
  flags="$flags --window-position=$lx,$ly --window-size=$lw,$lh"
fi
[ "$1" = "--fullscreen" ] && flags="$flags --start-fullscreen"
echo "handmedown: opening the board${laptop:+ on the laptop screen}"
# shellcheck disable=SC2086
open -na "Google Chrome" --args $flags
