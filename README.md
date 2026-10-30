# handmedown

Your notes, floating over your webcam, moved with your hands.

handmedown tracks your hands through the camera and puts your markdown notes
on screen as glass cards. Pinch to grab, flick to throw, stretch with two hands
to resize. No headset, no controllers.

## Run it

```
python3 server.py
```

Then open **http://127.0.0.1:8800/** in Chrome and allow the camera. The server
uses only the Python standard library. On first load the page fetches Google
MediaPipe's hand tracker from a CDN.

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

## Gestures

| Gesture | What it does |
| --- | --- |
| Tap (quick pinch) | Open a ring, a folder, or a note; run an action |
| Pinch and drag | Move a card |
| Let go mid-motion | Throw it |
| Both hands pinch one card | Pull apart or push together to resize |
| `Esc` | Clear the board |

Add `?debug=1` to the URL to draw the tracked hand landmarks.

## Layout

```
server.py         local server: notes API and configured actions
web/index.html    the board
web/app.js        hand tracking, gestures, cards
web/markdown.js   small, escaping markdown renderer
sample-notes/     notes shown until you configure your own
```

## Credits

Hand tracking by [Google MediaPipe](https://developers.google.com/mediapipe)
(Apache 2.0), loaded from a CDN and not redistributed here.

## License

Copyright (C) 2026 baldmike

handmedown is free software under the GNU Affero General Public License,
version 3 or later. See [LICENSE](LICENSE).
