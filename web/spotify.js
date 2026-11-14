// Spotify on this Mac, run entirely by hand signs: a big display of what's
// playing (track, timeline, play state, volume) with nothing to press. The
// board reads the signs and calls gesture(cmd) and volume(step); the server
// drives Spotify (POST /api/spotify). The display lights up whatever a sign
// just did.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const POLL_MS = 2000;
const TICK_MS = 250; // the timeline moves on its own between polls

// 75.4 -> "1:15"
const clock = (sec) => {
  const t = Math.max(0, Math.floor(sec ?? 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

export const spotifyHtml = `
  <div class="sp-zoom">
  <div class="app-head">
    <span class="title">Spotify</span>
    <button class="app-close" data-key="close" tabindex="-1">✕</button>
  </div>
  <div class="sp-now">
    <div class="sp-track">…</div>
    <div class="sp-artist"></div>
    <div class="sp-timeline">
      <span class="sp-elapsed">0:00</span>
      <div class="sp-time-bar"><div class="sp-time-fill"></div></div>
      <span class="sp-total">0:00</span>
    </div>
  </div>
  <div class="sp-transport">
    <div class="sp-ind" data-ind="prev">⏮</div>
    <div class="sp-ind sp-play" data-ind="play">▶</div>
    <div class="sp-ind" data-ind="next">⏭</div>
  </div>
  <div class="sp-volume">
    <span class="sp-vol-icon">🔈</span>
    <div class="sp-vol-bar"><div class="sp-vol-fill"></div></div>
    <span class="sp-vol-num"></span>
  </div>
  <div class="sp-signs">
    <div class="sp-sign"><span class="sp-sign-icon">👈</span><span>swipe: previous</span></div>
    <div class="sp-sign"><span class="sp-sign-icon">✋</span><span>pause / play</span></div>
    <div class="sp-sign"><span class="sp-sign-icon">👉</span><span>swipe: next</span></div>
    <div class="sp-sign"><span class="sp-sign-icon">☝️</span><span>volume up</span></div>
    <div class="sp-sign"><span class="sp-sign-icon">👎</span><span>next song</span></div>
    <div class="sp-sign"><span class="sp-sign-icon">👇</span><span>volume down</span></div>
  </div>
  </div>`;

export class SpotifyApp {
  constructor(root, { api, say }) {
    Object.assign(this, { root, api, say });
    this.trackEl = root.querySelector(".sp-track");
    this.artistEl = root.querySelector(".sp-artist");
    this.playEl = root.querySelector(".sp-play");
    this.fillEl = root.querySelector(".sp-vol-fill");
    this.numEl = root.querySelector(".sp-vol-num");
    this.elapsedEl = root.querySelector(".sp-elapsed");
    this.totalEl = root.querySelector(".sp-total");
    this.timeFillEl = root.querySelector(".sp-time-fill");
    this.clock = null; // { position, duration, playing, at }: the last reading, to count on from
    this.state = null; // "playing" / "paused", as Spotify last said
    this.busy = false;
    this.refresh();
    // Keep up with changes made in Spotify itself, until the window closes.
    this.timer = setInterval(() => {
      if (!root.isConnected) return clearInterval(this.timer);
      if (!this.busy) this.refresh();
    }, POLL_MS);
    this.ticker = setInterval(() => {
      if (!root.isConnected) return clearInterval(this.ticker);
      this.tick();
    }, TICK_MS);
  }

  // Where the song is now: the last reading, plus the time since if it's playing.
  tick() {
    const c = this.clock;
    if (!c || !c.duration) {
      this.elapsedEl.textContent = this.totalEl.textContent = "0:00";
      this.timeFillEl.style.width = "0";
      return;
    }
    const pos = Math.min(c.duration, c.position + (c.playing ? (performance.now() - c.at) / 1000 : 0));
    this.elapsedEl.textContent = clock(pos);
    this.totalEl.textContent = clock(c.duration);
    this.timeFillEl.style.width = `${(pos / c.duration) * 100}%`;
  }

  refresh() {
    return this.api("/api/spotify").then((s) => this.show(s)).catch(() => this.show({ running: false }));
  }

  send(body) {
    this.busy = true;
    return this.api("/api/spotify", body)
      .then((s) => this.show(s))
      .catch((err) => this.say(`spotify: ${err.message}`))
      .finally(() => { this.busy = false; });
  }

  show(s) {
    this.root.classList.toggle("sp-off", !s.running);
    this.state = s.running ? s.state : null;
    this.clock = s.running && s.duration
      ? { position: s.position ?? 0, duration: s.duration, playing: s.state === "playing", at: performance.now() }
      : null;
    this.tick();
    if (!s.running) {
      this.trackEl.textContent = s.error ? "Can't reach Spotify" : "Spotify isn't open";
      this.artistEl.textContent = s.error
        ? "allow Python to control Spotify: System Settings → Privacy & Security → Automation"
        : "open Spotify on this Mac";
      this.playEl.textContent = "▶";
      return;
    }
    this.trackEl.innerHTML = esc(s.track || "nothing playing");
    this.artistEl.innerHTML = esc(s.artist || "");
    this.playEl.textContent = s.state === "playing" ? "⏸" : "▶";
    if (s.volume != null) {
      this.fillEl.style.width = `${s.volume}%`;
      this.numEl.textContent = s.volume;
    }
  }

  // Nothing on this window is pressed: it's all hand signs.
  press() {}

  // A hand sign or swipe: "prev", "next" or "pause" (the palm, which plays
  // again if it's already paused). `how` picks the message.
  gesture(cmd, how) {
    if (cmd === "pause" && this.state === "paused") cmd = "play";
    const ind = this.root.querySelector(`[data-ind="${cmd === "pause" ? "play" : cmd}"]`);
    ind.classList.remove("fired");
    void ind.offsetWidth; // restart the flash
    ind.classList.add("fired");
    const said = {
      prev: "👈 previous song",
      next: how === "swipe" ? "👉 next song" : "👎 next song",
      pause: "✋ paused",
      play: "✋ playing",
    };
    this.say(said[cmd]);
    this.send({ cmd });
  }

  // A step of the volume, from pointing a finger up (+) or down (−).
  volume(step) {
    if (this.busy) return;
    this.root.classList.remove("sp-vol-up", "sp-vol-down");
    void this.root.offsetWidth; // restart the flash
    this.root.classList.add(step > 0 ? "sp-vol-up" : "sp-vol-down");
    this.send({ cmd: "volume", step });
  }
}
