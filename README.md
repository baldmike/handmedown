# handmedown

Your notes, floating over your webcam, moved with your hands.

handmedown tracks your hands through the camera and puts your markdown notes
on screen as glass cards. Pinch to grab, flick to throw, stretch with two hands
to resize. No headset, no controllers.

## Run it

```
./start.sh               # starts the server and opens the board in its own window
./start.sh --fullscreen  # same, filling the screen: for a dedicated monitor
```

Allow the camera the first time. The board gets its own borderless Chrome
window (a separate Chrome profile in `~/.handmedown/chrome`). On a laptop, put
that window in its own full-screen Space and swipe to it when you want it.

The camera runs only while the board is on screen, and switches off when you
swipe away or switch tabs. Anything pushed to the board meanwhile is waiting
when you come back.

Prefer to run it by hand? `python3 server.py`, then open
**http://127.0.0.1:8800/** in Chrome. The server uses only the Python standard
library. On first load the page fetches Google MediaPipe's hand tracker from a
CDN.

No camera? The mouse works: click is a pinch, Alt + scroll resizes a card.

## Use your notes

```
cp handmedown.json.example handmedown.json
```

Set `notes` to any folder of `.md` files (an Obsidian vault works as-is). Each
subfolder becomes a card off the ring at the bottom, and its notes fan out when
you tap it. The server only reads `.md` files inside that folder. It listens on
127.0.0.1 only.

Options: `--port 8800`, `--config path/to/config.json`, `--verbose`.

## Actions

The **actions** ring holds cards that run something on your computer when you
tap them: open an app or a website, run a script. List them in
`handmedown.json`:

```json
"actions": [
  { "title": "Calculator", "run": ["open", "-a", "Calculator"] },
  { "title": "Backup", "run": ["./scripts/backup.sh"] }
]
```

`run` is a command and its arguments, run from the project folder without a
shell (so no pipes or `~`; wrap those in a script). The card shows the
command's output and turns green or red. Only actions listed in the config
can run: the board can't send its own commands, and other websites can't
trigger them. Commands time out after 20 seconds.

## Push to the board

`bin/hmd` puts cards on the board from any script or terminal:

```
bin/hmd push "Deploy finished" "All **3** services healthy" --tone ok
bin/hmd push "Build log" - < build.log          # body from stdin (markdown)
bin/hmd push "Tests" "running…" --id tests       # same --id updates in place
bin/hmd remove tests                             # or: bin/hmd remove --all
bin/hmd status working "nightly job"             # a light on the status ring
bin/hmd board                                    # what's up there, as JSON
```

Tones: `info`, `ok`, `warn`, `error`, `ask`. Pushed cards stack down the right
side. Tap one to expand it, flick it off the screen to dismiss it. The server
keeps them in `state/board.json`, so they survive restarts and reloads.

The same API is plain HTTP for anything that isn't a shell: `POST /api/push`,
`/api/remove` and `/api/status` with a JSON body and the header
`X-Handmedown: 1`, which keeps other websites from writing to your board.

## Claude Code

Add `bin/hmd hook` as a hook and the board mirrors your Claude Code sessions.
The status ring (top right) shows each session working, waiting on you, or
done. A red card appears when Claude needs you, and when it finishes, its last
reply lands on the board. Add this to `~/.claude/settings.json`, with the path
to your checkout:

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "/path/to/handmedown/bin/hmd hook" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/path/to/handmedown/bin/hmd hook" }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "/path/to/handmedown/bin/hmd hook" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "/path/to/handmedown/bin/hmd hook" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "/path/to/handmedown/bin/hmd hook" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "/path/to/handmedown/bin/hmd hook" }] }]
  }
}
```

The hook never fails or slows Claude down if the board isn't running: it gives
up after 2 seconds and exits quietly.

## Gestures

| Gesture | What it does |
| --- | --- |
| Tap (quick pinch) | Open a ring, a folder, or a note; run an action |
| Pinch and drag | Move a card |
| Let go mid-motion | Throw it (a pushed card flies off and is dismissed) |
| Both hands pinch one card | Pull apart or push together to resize |
| `Esc` | Fold away notes and actions (pushed cards stay) |
| Double blink (look mode) | Tap the card you're looking at |
| `g` / `k` | Cycle look mode (off, head, eyes) / recalibrate it |

Add `?debug=1` to the URL to draw the tracked hand landmarks.

## Look to choose

Press `g` to cycle **off → head → eyes**. The card you're looking at lights up
blue. Pinch anywhere, with your hand resting rather than reaching for the
screen, and the pinch acts on that card: tap opens or runs it, and pinch and
move carries it. Reaching for a card directly still works.

- **head:** follows where your nose points. Steadier. It asks you to look at
  one dot for a second to set your neutral pose.
- **eyes:** follows your irises. A nine-dot calibration (about 12 seconds) fits
  it to you. Keep your head still while the dot moves. Webcam eye tracking is
  only good to a few centimetres, so it picks the nearest card rather than
  steering a cursor.

**Double blink** to tap the card you're looking at, with no hands at all: it
opens a folder or note, or runs an action. It needs two quick blinks with both
eyes. Ordinary blinking, winks, and resting your eyes are ignored, and the
choice freezes while your eyes are closed so the blink can't move it.

`k` recalibrates. Do it after you move the laptop or change seats.
Calibration and mode are remembered in this browser. `?look=head` or
`?look=eyes` in the URL picks a mode directly. Face tracking runs alongside
hand tracking, so look mode uses more battery; it stays off unless you turn it
on.

## Layout

```
start.sh          start the server and open the board window
server.py         local server: notes, actions, and the live board
bin/hmd           push cards and status; Claude Code hook
web/index.html    the board
web/app.js        hand tracking, gestures, cards
web/look.js       head and eye tracking for look to choose
web/markdown.js   small, escaping markdown renderer
sample-notes/     notes shown until you configure your own
state/            board contents and server log (not committed)
```

## Credits

Hand tracking by [Google MediaPipe](https://developers.google.com/mediapipe)
(Apache 2.0), loaded from a CDN and not redistributed here.

## License

Copyright (C) 2026 baldmike

handmedown is free software under the GNU Affero General Public License,
version 3 or later. See [LICENSE](LICENSE).
