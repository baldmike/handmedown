# Use your own notes

Copy `handmedown.json.example` to `handmedown.json` and point `notes` at any
folder of markdown files. An Obsidian vault works as-is.

```json
{
  "name": "handmedown",
  "port": 8800,
  "notes": "~/Documents/MyVault"
}
```

Each folder becomes a card off the ring, and each note fans out of its folder.
