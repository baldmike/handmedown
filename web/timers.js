// Kitchen timers. The server keeps them (as end times, in state/board.json),
// so they run on while the board is hidden or closed; the page shows them,
// sets them, and makes the noise.
//
// Three places they show up:
//   - the Timers window: presets, finger count, and a row per timer
//   - the strip pinned to the top of the board, whenever timers are running
//   - the alarm: full screen, loud, until a pinch, a palm, a click or a key

const PRESETS = [1, 3, 5, 10, 15, 20];
// Holding up fingers picks the minutes; it never starts a timer by itself
// (a hand that's just in view reads as a count, usually 4). It puts the
// number on a start button, and a tap on that starts it.
const COUNT_HOLD_MS = 1500; // hold the same finger count this long to put it on the start button
const COUNT_HINT = "or hold up fingers for the minutes (👍 = 1, two hands add up), then tap start";
const MAX_COUNT = 10;
const CHIME_EVERY_MS = 1600;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// 75 -> "1:15", 3725 -> "1:02:05"
function clock(sec) {
  const t = Math.max(0, Math.ceil(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export const timersHtml = `
  <div class="app-head">
    <span class="title">Timers</span>
    <button class="app-close" data-key="close" tabindex="-1">✕</button>
  </div>
  <div class="tm-presets">
    ${PRESETS.map((m) => `<button data-key="add:${m}" tabindex="-1">${m}<small>min</small></button>`).join("")}
  </div>
  <div class="tm-count">
    <div class="tm-count-text">${COUNT_HINT}</div>
    <div class="tm-count-bar"><div class="tm-count-fill"></div></div>
    <button class="tm-go" data-key="go" tabindex="-1" hidden></button>
  </div>
  <div class="tm-list"></div>`;

export class Timers {
  constructor({ api, say, fast = false }) {
    Object.assign(this, { api, say });
    this.unit = fast ? 1 : 60; // seconds per "minute": ?fast=1 runs minutes as seconds
    this.list = [];
    this.offset = 0;       // server clock minus this page's clock, in seconds
    this.root = null;      // the open Timers window, if any
    this.shape = "";       // what the window's rows were built for
    this.counting = null;  // { n, since } while a finger count is locking in
    this.pending = null;   // minutes on the start button, from a finger count
    this.audio = null;
    this.lastChime = -Infinity;

    this.strip = document.createElement("div");
    this.strip.id = "timer-strip";
    this.alarm = document.createElement("div");
    this.alarm.id = "alarm";
    this.alarm.hidden = true;
    this.badge = document.createElement("div");
    this.badge.id = "sound-badge";
    this.badge.textContent = "🔇 sound off: click once to turn it on";
    this.badge.hidden = true;
    document.body.append(this.strip, this.alarm, this.badge);
  }

  // ---- state from the server

  set(timers = [], serverNow = Date.now() / 1000) {
    this.offset = serverNow - Date.now() / 1000;
    this.list = [...timers].sort((a, b) => a.created - b.created);
    this.renderRows();
  }

  get ringing() {
    return this.list.some((t) => t.state === "ringing");
  }

  now() {
    return Date.now() / 1000 + this.offset;
  }

  // Seconds left (running or paused), or seconds over (ringing).
  remaining(t) {
    if (t.state === "paused") return t.left;
    if (t.state === "ringing") return this.now() - t.end;
    return t.end - this.now();
  }

  label(t) {
    if (t.label) return t.label;
    return t.seconds % 60 === 0 ? `${t.seconds / 60} min timer` : `${clock(t.seconds)} timer`;
  }

  async op(body) {
    try {
      await this.api("/api/timer", body);
    } catch (err) {
      this.say(`timer: ${err.message}`);
    }
  }

  start(minutes) {
    const n = Math.round(minutes);
    if (this.list.length >= 4) return this.say("timers: 4 is the most at once");
    this.say(`timer: ${n} min`);
    this.op({ op: "add", seconds: n * this.unit });
  }

  dismissAll() {
    if (!this.ringing) return false;
    this.list = this.list.filter((t) => t.state !== "ringing");
    this.renderRows();
    this.op({ op: "dismiss-all" });
    this.say("timer stopped");
    return true;
  }

  // ---- the window

  attach(root) {
    this.root = root;
    this.shape = "";
    this.pending = null;
    this.renderRows();
    return this;
  }

  get open() {
    return !!this.root?.isConnected;
  }

  press(key) {
    const [what, arg, extra] = key.split(":");
    if (what === "add") return this.start(Number(arg));
    if (what === "go") {
      const n = this.pending;
      this.setPending(null);
      return n && this.start(n);
    }
    const t = this.list.find((x) => x.id === arg);
    if (!t) return;
    if (what === "toggle") this.op({ op: t.state === "paused" ? "resume" : "pause", id: t.id });
    else if (what === "adj") this.op({ op: "adjust", id: t.id, delta: Number(extra) * this.unit });
    else if (what === "cancel") this.op({ op: t.state === "ringing" ? "dismiss" : "cancel", id: t.id });
  }

  // Rows are rebuilt only when timers come or go or change state; the digits
  // update every frame. Rebuilding under a hand that's aiming would lose its aim.
  renderRows() {
    const list = this.root?.querySelector(".tm-list");
    if (!list) return;
    const shape = this.list.map((t) => `${t.id}:${t.state}`).join(",");
    if (shape === this.shape) return;
    this.shape = shape;
    list.innerHTML = this.list.length ? this.list.map((t) => `
      <div class="tm-timer state-${t.state}" data-id="${t.id}">
        <div class="tm-label">${esc(this.label(t))}</div>
        <div class="tm-digits">0:00</div>
        <div class="tm-buttons">
          ${t.state === "ringing" ? "" : `
          <button data-key="adj:${t.id}:-1" tabindex="-1">−1</button>
          <button data-key="adj:${t.id}:1" tabindex="-1">+1</button>
          <button data-key="adj:${t.id}:5" tabindex="-1">+5</button>
          <button data-key="toggle:${t.id}" tabindex="-1">${t.state === "paused" ? "▶" : "❚❚"}</button>`}
          <button class="tm-cancel" data-key="cancel:${t.id}" tabindex="-1">${t.state === "ringing" ? "stop" : "✕"}</button>
        </div>
      </div>`).join("") : '<div class="tm-empty">no timers running</div>';
  }

  // ---- finger count

  // Called every frame with the fingers held up across both hands (null when
  // counting doesn't apply: no hand in view, or one pinching or pointing).
  // `steady` is false while a hand is moving. A count held still goes on the
  // start button; only tapping that starts the timer.
  count(n, steady, nowMs) {
    const fill = this.root?.querySelector(".tm-count-fill");
    const text = this.root?.querySelector(".tm-count-text");
    const reset = () => {
      this.counting = null;
      if (fill) fill.style.width = "0";
      if (text) text.textContent = COUNT_HINT;
      this.root?.classList.remove("counting");
    };
    if (!n || !this.open || this.ringing) return reset();
    n = Math.min(n, MAX_COUNT);
    if (n === this.pending) return reset(); // already on the button
    if (!steady || this.counting?.n !== n) this.counting = { n, since: nowMs };
    const k = Math.min(1, (nowMs - this.counting.since) / COUNT_HOLD_MS);
    this.root.classList.add("counting");
    if (fill) fill.style.width = `${k * 100}%`;
    if (text) text.textContent = `${n} min: hold still…`;
    if (k < 1) return;
    reset();
    this.setPending(n);
  }

  setPending(n) {
    this.pending = n;
    const go = this.root?.querySelector(".tm-go");
    if (!go) return;
    go.hidden = n === null;
    go.textContent = n === null ? "" : `▶ start ${n} min`;
  }

  // ---- sound

  // Chrome only lets a page make sound after a real click or keypress (a
  // pinch doesn't count), so the board calls this on every real input.
  unlock() {
    try {
      this.audio ??= new AudioContext();
      if (this.audio.state === "suspended") this.audio.resume();
    } catch { /* no Web Audio */ }
  }

  get soundOn() {
    return this.audio?.state === "running";
  }

  chime() {
    const ctx = this.audio;
    if (!this.soundOn) return;
    const t0 = ctx.currentTime;
    [0, 0.18, 0.36].forEach((dt, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = i === 2 ? 1319 : 988;
      gain.gain.setValueAtTime(0.0001, t0 + dt);
      gain.gain.exponentialRampToValueAtTime(0.7, t0 + dt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + dt);
      osc.stop(t0 + dt + 0.18);
    });
  }

  // ---- every frame

  frame(nowMs) {
    // Server-side ringing lags by up to a quarter second; show zero, not -0:00.
    for (const el of this.root?.querySelectorAll(".tm-timer") ?? []) {
      const t = this.list.find((x) => x.id === el.dataset.id);
      if (!t) continue;
      const r = this.remaining(t);
      el.querySelector(".tm-digits").textContent = t.state === "ringing" ? `+${clock(r)}` : clock(r);
    }

    const showStrip = this.list.length && !this.open;
    this.strip.hidden = !showStrip;
    if (showStrip) {
      this.strip.innerHTML = this.list.map((t) => {
        const r = this.remaining(t);
        return `<div class="ts-item state-${t.state}"><span>${esc(this.label(t))}</span>` +
          `<b>${t.state === "ringing" ? "+" : ""}${clock(r)}</b></div>`;
      }).join("");
    }

    const ringing = this.list.filter((t) => t.state === "ringing");
    this.alarm.hidden = !ringing.length;
    document.body.classList.toggle("ringing", ringing.length > 0);
    if (ringing.length) {
      const over = Math.max(...ringing.map((t) => this.remaining(t)));
      this.alarm.innerHTML =
        `<div class="al-label">${ringing.map((t) => esc(this.label(t))).join(" · ")}</div>` +
        `<div class="al-big">TIME'S UP</div>` +
        `<div class="al-over">+${clock(over)}</div>` +
        `<div class="al-hint">pinch anywhere, show your palm, or click to stop</div>`;
      if (nowMs - this.lastChime > CHIME_EVERY_MS) {
        this.lastChime = nowMs;
        this.chime();
      }
    }

    this.badge.hidden = this.soundOn || !this.list.length;
  }
}
