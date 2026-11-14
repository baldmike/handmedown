// The Notes app: a window on the board listing your notes, showing the one you
// pick, and letting you write: an on-board keyboard you air-tap or pinch-tap
// (or your real keyboard) types into the note, and Save writes it back to the
// notes folder. Every button carries data-key; the board turns taps into
// press(key).

import { renderMarkdown } from "./markdown.js";

const ROWS = ["1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm,.?"];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const keyFor = (ch) => `type:${encodeURIComponent(ch)}`;

const keyboardHtml = `
  <div class="notes-keyboard">
    ${ROWS.map((row) => `<div class="kb-row">${[...row].map((ch) =>
      `<button data-key="${keyFor(ch)}" tabindex="-1">${esc(ch)}</button>`).join("")}</div>`).join("")}
    <div class="kb-row">
      <button class="wide" data-key="shift" tabindex="-1">⇧</button>
      <button data-key="${keyFor("-")}" tabindex="-1">-</button>
      <button class="space" data-key="space" tabindex="-1">space</button>
      <button data-key="${keyFor("!")}" tabindex="-1">!</button>
      <button class="wide" data-key="back" tabindex="-1">⌫</button>
      <button class="wide" data-key="enter" tabindex="-1">⏎</button>
    </div>
  </div>`;

export const notesHtml = `
  <div class="app-head">
    <span class="title">Notes</span>
    <span class="app-actions">
      <button class="app-btn" data-key="new" tabindex="-1">+ New</button>
      <button class="app-btn" data-key="edit" tabindex="-1" hidden>Edit</button>
      <button class="app-btn" data-key="cancel" tabindex="-1" hidden>Cancel</button>
      <button class="app-btn primary" data-key="save" tabindex="-1" hidden>Save</button>
      <button class="app-close" data-key="close" tabindex="-1">✕</button>
    </span>
  </div>
  <div class="notes-app">
    <nav class="notes-list"></nav>
    <article class="notes-view body"><p class="notes-empty">Pick a note, or + New to write one.</p></article>
    <div class="notes-editor" hidden></div>
  </div>
  <div class="notes-kb-slot" hidden>${keyboardHtml}</div>`;

// A filename from the note's first line ("# Groceries" -> "Groceries.md").
function fileNameFor(text) {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const name = first.replace(/^#+\s*/, "").replace(/[^\w\s-]/g, "").trim().slice(0, 60);
  if (name) return name;
  const d = new Date(), pad = (n) => String(n).padStart(2, "0");
  return `Note ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

export class NotesApp {
  constructor(root, { api, say }) {
    this.root = root;
    this.api = api;
    this.say = say;
    this.$ = (sel) => root.querySelector(sel);
    this.current = null;  // { path, markdown }
    this.editing = null;  // { path, folder, text, create }
    this.shift = false;
    this.load();
  }

  async load(selectPath) {
    let folders = [];
    try {
      ({ folders } = await this.api("/api/notes"));
    } catch (err) {
      this.$(".notes-list").innerHTML = `<p class="notes-empty">couldn't load notes (${esc(err.message)})</p>`;
      return;
    }
    this.$(".notes-list").innerHTML = folders.map((f) =>
      `<div class="notes-folder">${esc(f.name)}</div>` +
      f.notes.map((n) => `<button class="notes-item" data-key="open:${encodeURIComponent(n.path)}" tabindex="-1">${esc(n.title)}</button>`).join(""),
    ).join("") || '<p class="notes-empty">No notes yet.</p>';
    if (selectPath) await this.open(selectPath);
    else this.markSelected();
  }

  async open(path) {
    try {
      const { markdown } = await this.api(`/api/note?path=${encodeURIComponent(path)}`);
      this.current = { path, markdown };
    } catch (err) {
      this.say(`couldn't open that note (${err.message})`);
      return;
    }
    const view = this.$(".notes-view");
    view.innerHTML = renderMarkdown(this.current.markdown) || '<p class="notes-empty">(empty note)</p>';
    view.scrollTop = 0;
    this.markSelected();
    this.render();
  }

  markSelected() {
    for (const b of this.root.querySelectorAll(".notes-item")) {
      b.classList.toggle("selected", this.current && decodeURIComponent(b.dataset.key.slice(5)) === this.current.path);
    }
  }

  // Show the viewer or the editor + keyboard, and the right header buttons.
  render() {
    const editing = !!this.editing;
    this.root.classList.toggle("editing", editing);
    this.$(".notes-view").hidden = editing;
    this.$(".notes-editor").hidden = !editing;
    this.$(".notes-kb-slot").hidden = !editing;
    this.$('[data-key="new"]').hidden = editing;
    this.$('[data-key="edit"]').hidden = editing || !this.current;
    this.$('[data-key="cancel"]').hidden = !editing;
    this.$('[data-key="save"]').hidden = !editing;
    this.root.querySelector('[data-key="shift"]').classList.toggle("on", this.shift);
    if (editing) this.renderEditor();
  }

  renderEditor() {
    const ed = this.$(".notes-editor");
    ed.textContent = this.editing.text;
    const caret = document.createElement("span");
    caret.className = "caret";
    ed.appendChild(caret);
    ed.scrollTop = ed.scrollHeight;
  }

  startEdit(create) {
    if (create) {
      const folder = this.current ? this.current.path.split("/").slice(0, -1).join("/") : "";
      this.editing = { folder, text: "# ", create: true };
    } else if (this.current) {
      this.editing = { path: this.current.path, text: this.current.markdown, create: false };
    }
    this.render();
  }

  async save() {
    const e = this.editing;
    if (!e.create) {
      await this.api("/api/note", { path: e.path, markdown: e.text });
      this.editing = null;
      this.say("saved");
      return this.load(e.path);
    }
    // New note: name it after its first line; add a number if that's taken.
    const base = (e.folder ? `${e.folder}/` : "") + fileNameFor(e.text);
    for (let n = 1; n < 50; n++) {
      const path = `${base}${n > 1 ? ` ${n}` : ""}.md`;
      try {
        await this.api("/api/note", { path, markdown: e.text, create: true });
        this.editing = null;
        this.say(`saved ${path}`);
        return this.load(path);
      } catch (err) {
        if (!/409/.test(err.message)) throw err;
      }
    }
  }

  type(text) {
    if (!this.editing) return;
    if (text === "\b") this.editing.text = this.editing.text.slice(0, -1);
    else this.editing.text += text;
    this.renderEditor();
  }

  press(key) {
    if (key.startsWith("open:")) {
      if (this.editing) return this.say("save or cancel first");
      return this.open(decodeURIComponent(key.slice(5)));
    }
    if (key.startsWith("type:")) {
      let ch = decodeURIComponent(key.slice(5));
      if (this.shift) {
        ch = ch.toUpperCase();
        this.shift = false;
        this.render();
      }
      return this.type(ch);
    }
    switch (key) {
      case "new": return this.startEdit(true);
      case "edit": return this.startEdit(false);
      case "cancel": this.editing = null; return this.render();
      case "save":
        return this.save().catch((err) => this.say(`couldn't save (${err.message})`));
      case "shift": this.shift = !this.shift; return this.render();
      case "space": return this.type(" ");
      case "enter": return this.type("\n");
      case "back": return this.type("\b");
    }
  }

  // Real keyboard while editing. Returns true if it used the key.
  handleKey(e) {
    if (!this.editing) return false;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") this.press("save");
    else if (e.metaKey || e.ctrlKey || e.altKey) return false;
    else if (e.key === "Escape") this.press("cancel");
    else if (e.key === "Backspace") this.type("\b");
    else if (e.key === "Enter") this.type("\n");
    else if (e.key.length === 1) this.type(e.key);
    else return false;
    e.preventDefault();
    return true;
  }
}
