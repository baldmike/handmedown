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

Allow the camera the first time. handmedown always uses the laptop's built-in
camera, even with a webcam or an iPhone connected, and `start.sh` opens the
board on the laptop's own screen, even with a bigger monitor attached. The board gets its own borderless Chrome
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

### Install it as an app

With the server running, open **http://127.0.0.1:8800/** in your everyday
Chrome and click the install icon at the right of the address bar (or ⋮ →
Cast, save, and share → Install page as app). handmedown gets its own window,
a Dock icon, and shows up in Launchpad and Spotlight.

The app is only a window onto the local server, so the server has to be
running when you open it. To have it always running, start it at login:

```
bin/login-item install   # start now and at every login; restarts if it dies
bin/login-item remove    # undo
```

If the repo lives in `~/Desktop` or `~/Documents`, macOS asks once whether
Python may read that folder: allow it, or the server can't start. If you change
the port, install the app again from the new address.

## Use your notes

```
cp handmedown.json.example handmedown.json
```

Set `notes` to any folder of `.md` files (an Obsidian vault works as-is). The
Notes app lists them by folder. The server only reads and writes `.md` files
inside that folder, never creates folders, and listens on 127.0.0.1 only.

Options: `--port 8800`, `--config path/to/config.json`, `--verbose`.

## Apps

The **apps** ring holds apps that run inside the board, as windows you can
move, stretch with two hands, and close with ✕.

**Notes** lists your notes on the left and shows the one you tap on the right.
Scroll either side with two fingers. **+ New** and **Edit** open an on-board
keyboard: air-tap or pinch-tap its glowing keys to type (⇧ capitalises the
next letter), or use your real keyboard. **Save** writes the note back to your
notes folder (`⌘S` works too, and `Esc` cancels). A new note is named after its
first line, so `# Groceries` becomes `Groceries.md`, in the folder of the note
you had open.

**Calculator**: tap it and a calculator opens on the board, then pinch-tap its
glowing keys, or point and air-tap: aim your index finger at a key (the others
curled) and give it a quick dip, like tapping a screen that isn't there. The
key under your finger lights up, so you can see what you'll press. Drag it by any spot that isn't a key, stretch it with two hands, and
tap ✕ to close it.

**Spotify** runs the Spotify app on this Mac entirely by hand signs. Its
window is a big display, twice the size of the others, to read from across
the room: the song, the artist, how far in you are, play or pause, and the
volume. It sits on the left, clear of the apps ring, and comes back by itself
when the board reloads. It stays put: hands can't pick it up, move, throw or stretch it, and
there's nothing on it to press except ✕ to close it. The display lights up
whatever a sign just did. With the window open:

- 👈 **swipe an open hand to the left**, quickly: previous song
- 👉 **swipe an open hand to the right**, quickly: next song
- ☝️ **point a finger straight up**: volume up, 5 at a time while you hold it
- 👇 **point a finger straight down**: volume down
- 👎 **thumbs down** (a fist, thumb pointing down) for a moment: next song
- ✋ **open hand up**, fingers pointing up, held still for a moment: pause (or play, if it's paused)

A sign fires once; drop your hand or change the sign to do it again. Pointing
at a button doesn't change the volume, so air-tapping still works. The first
time, macOS asks whether Python may control Spotify: allow it.

You can also add your own commands to the same ring in `handmedown.json`:

```json
"actions": [
  { "title": "Backup", "run": ["./scripts/backup.sh"] }
]
```

`run` is a command and its arguments, run from the project folder without a
shell (so no pipes or `~`; wrap those in a script). The card shows the
command's output and turns green or red. Only commands listed in the config
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
side. Tap one to expand it; flick it away with two fingers to dismiss it. The server
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
| Tap (quick pinch) | Open the apps ring or an app; press any button or key in an app |
| Pinch and drag | Move a card |
| Let go | Set it down right there |
| Flick hard as you let go | Throw it: it bounces off the screen edges, never more than halfway off |
| Both hands pinch one card | Pull apart or push together to resize |
| Point (index finger only) at a key, then a quick dip of the fingertip | Press it (air tap) |
| Two fingers out (index and middle), pointing up or down | Scroll whatever is under your hand; hold fingers sideways to pause |
| Two fingers out, quick swipe across a pushed card | Flick it off the screen and dismiss it |
| Point one finger straight up / down (Spotify open) | Volume up / down |
| Quick open-hand swipe left / right (Spotify open) | Previous / next song |
| Thumbs down / open hand up, held (Spotify open) | Next song / pause or play |
| `Esc` | Close app windows and fold away the ring (pushed cards stay) |
| Double blink (eye tracking on) | Tap the card you're looking at |
| `g` / `k` | Eye tracking on or off / recalibrate it |

Add `?debug=1` to the URL to draw the tracked hand landmarks.

## Look to choose

Press `g` to turn eye tracking on or off. A nine-dot calibration runs first
(about 12 seconds): keep your head still and follow the dot with your eyes.
After that, the card you're looking at lights up blue. Pinch anywhere, with
your hand resting rather than reaching for the screen, and the pinch acts on
that card: tap opens or runs it, and pinch and move carries it. Reaching for a
card directly still works.

**Double blink** to tap the card you're looking at, with no hands at all: it
opens a folder or note, or runs an action. It needs two quick blinks with both
eyes. Ordinary blinking, winks, and resting your eyes are ignored, and the
choice freezes while your eyes are closed so the blink can't move it.

Webcam eye tracking is only good to a few centimetres (less with glasses), so
it picks the nearest card rather than steering a cursor. It calibrates every
time it starts, because a calibration goes stale as soon as you or the laptop
move; `k` redoes it. `?look=eyes` in the URL turns it on directly, and with
`?debug=1` the status line shows what the face tracker is reading. Face
tracking uses more battery, so it stays off unless you turn it on.

## Layout

```
start.sh          start the server and open the board window
server.py         local server: notes (read and save), actions, and the live board
bin/hmd           push cards and status; Claude Code hook
web/index.html    the board
web/app.js        hand tracking, gestures, cards
web/look.js       eye tracking and blink detection for look to choose
web/notes.js      the Notes app: browse, read, and write notes
web/calculator.js the Calculator app
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
