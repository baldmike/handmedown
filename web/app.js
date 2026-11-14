// handmedown board: webcam hand tracking -> pinchable glass cards.
//
// Every input (each tracked hand, and the mouse as a fallback) is a "pointer"
// with a screen position and a pinching flag. Pointers grab cards; the board
// steps card motion once per frame.

import { renderMarkdown } from "./markdown.js";
import { Look } from "./look.js";
import { SpotifyApp, spotifyHtml } from "./spotify.js";
import { Timers, timersHtml } from "./timers.js";

const MEDIAPIPE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// A card is held exactly while index tip and thumb tip touch. Measured as the
// tip gap over palm length, so it holds at any distance from the camera.
const PINCH_ON = 0.28;   // tips closer than this: touching, grab
const PINCH_OFF = 0.32;  // tips farther than this: apart, let go...
const RELEASE_MS = 150;  // ...once they've stayed apart this long (a blurry frame mid-drag isn't a release)
const TAP_MS = 1000;     // pinch shorter than this, with little palm travel, is a tap
const TAP_PX = 45;
const LOST_MS = 180;     // a hand missing longer than this is released
const THROW_SPEED = 1500; // px/s at the knuckles when you let go: only a deliberate flick throws a card
const GAZE_SNAP_PX = 160; // a look within this far of a card's edge chooses it
const GAZE_STICKY_PX = 60; // the chosen card keeps it unless another is clearly closer
const SCROLL_SPEED = 900;   // px/s when two fingers point straight up or down
const SCROLL_DEADZONE = 0.45; // fingers flatter than this (0 flat .. 1 vertical) don't scroll
const SCROLL_SETTLE = 3;    // frames the two-finger pose must hold before scrolling
const FLICK_SPEED = 1300;   // px/s: a two-finger swipe this fast over a message dismisses it
const VOLUME_VERTICAL = 0.85; // a pointing finger this upright (0 flat .. 1 straight) changes Spotify's volume
const VOLUME_SETTLE_MS = 800; // ...once held this long
const VOLUME_EVERY_MS = 400;  // ...then a step this often
const VOLUME_STEP = 5;
// Spotify hand signs, held still this long: thumbs down for the next song,
// palm to the camera to pause.
const POSE_HOLD_MS = { "thumbs-down": 1000, palm: 1500 };
const POSE_GRACE_MS = 150;    // a sign missed for a frame or two still counts as held
// Swipes (open hand, sideways): left for the previous song, right for the next.
const SWIPE_SPEED = 1400;     // px/s: a stroke's top speed must reach this...
const SWIPE_MIN_FRAC = 0.25;  // ...and it must cover this share of the screen width
const SWIPE_MOVING = 250;     // px/s sideways: slower than this, a stroke has ended
const SWIPE_SETTLE_MS = 250;  // after a stroke, wait this long for a faster one the other way (the real swipe after a wind-up)
const SWIPE_COOLDOWN_MS = 1500; // one song per swipe, even as the hand swings back
const PALM_AFTER_SWIPE_MS = 2000; // a hand coming to rest open after a swipe isn't a pause
const PALM_STILL_PX_S = 300;  // the palm must be this still (at the knuckles): a hand moving the cursor isn't a stop sign
const TAP_DIP = 0.82;       // air tap: fingertip reach drops below this share of its usual...
const TAP_BACK = 0.92;     // ...and returns above this share...
const TAP_WINDOW_MS = 450; // ...within this long
const AIM_LAG_MS = 120;    // a tap presses the key aimed at this long before the dip
const POINT_HOLD_MS = 500; // stay in pointing mode through a tap's brief finger bend
const PALM_DISMISS_MS = 500; // a palm held this long stops a ringing timer
const COUNT_STILL_PX_S = 500; // hands moving faster than this aren't holding up a count
const MIN_SCALE = 0.4;
const MAX_SCALE = 3;

const params = new URLSearchParams(location.search);
const DEBUG = params.get("debug") === "1";
const FAST = params.get("fast") === "1"; // timers: minutes run as seconds, for testing

const video = document.getElementById("camera");
const debugCanvas = document.getElementById("debug");
const boardEl = document.getElementById("board");
const cursorsEl = document.getElementById("cursors");
const statusEl = document.getElementById("hud-status");
const presenceEl = document.getElementById("presence");

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// ---------------------------------------------------------------- smoothing

// One Euro filter: smooths jitter when the hand is still, stays responsive
// when it moves fast.
class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.015, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 });
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max((t - this.t) / 1000, 1e-3);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

// ---------------------------------------------------------------- cards

const cards = new Map(); // id -> card
let nextId = 1;
let topZ = 1;

function spawnCard({ kind, html, x, y, from, data = {} }) {
  const el = document.createElement("div");
  el.className = `card ${kind}`;
  el.innerHTML = html;
  const id = nextId++;
  el.dataset.id = id;
  boardEl.appendChild(el);
  const start = from || { x, y };
  const card = {
    id, el, kind, data,
    x: start.x, y: start.y, vx: 0, vy: 0, scale: 1,
    target: from ? { x, y } : null,
    holders: [], twoHand: null, removing: false,
  };
  cards.set(id, card);
  raise(card);
  if (from) {
    el.classList.add("spawning");
    requestAnimationFrame(() => el.classList.remove("spawning"));
  }
  render(card);
  return card;
}

function removeCard(card) {
  if (card.removing) return;
  card.removing = true;
  if (card.kind === "window") saveOpenApps();
  for (const p of card.holders) p.card = null;
  card.holders = [];
  card.el.style.opacity = "0";
  setTimeout(() => { card.el.remove(); cards.delete(card.id); }, 200);
}

function raise(card) {
  card.el.style.zIndex = ++topZ;
}

function render(card) {
  card.el.style.transform =
    `translate(${card.x}px, ${card.y}px) translate(-50%, -50%) scale(${card.scale})`;
}

function cardAt(x, y) {
  const el = document.elementFromPoint(x, y)?.closest(".card");
  const card = el && cards.get(Number(el.dataset.id));
  return card && !card.removing ? card : null;
}

function stepCards(dt) {
  const w = innerWidth, h = innerHeight;
  for (const card of cards.values()) {
    const [a, b] = card.holders;
    if (a && b) {
      const t = card.twoHand;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      card.scale = clamp(t.scale * (dist(a.x, a.y, b.x, b.y) / t.dist), MIN_SCALE, MAX_SCALE);
      const k = card.scale / t.scale;
      card.x = mx + t.offX * k;
      card.y = my + t.offY * k;
    } else if (a) {
      card.x = a.ax + a.grabDX;
      card.y = a.ay + a.grabDY;
    } else if (card.target) {
      const k = Math.min(1, dt * 9);
      card.x += (card.target.x - card.x) * k;
      card.y += (card.target.y - card.y) * k;
      if (dist(card.x, card.y, card.target.x, card.target.y) < 0.5) card.target = null;
    } else if (card.vx || card.vy) {
      card.x += card.vx * dt;
      card.y += card.vy * dt;
      if (card.flung) {
        // Flicked away with two fingers: off the screen and gone.
        if (card.x < -200 || card.x > w + 200 || card.y < -200 || card.y > h + 200) {
          dismissMessage(card);
          continue;
        }
        render(card);
        continue;
      }
      const drag = Math.pow(0.05, dt);
      card.vx *= drag;
      card.vy *= drag;
      // The screen is the boundary: a thrown card bounces back once it's
      // halfway past an edge (its centre on the edge), so it never leaves.
      if (card.x < 0 || card.x > w) { card.x = clamp(card.x, 0, w); card.vx *= -0.6; }
      if (card.y < 0 || card.y > h) { card.y = clamp(card.y, 0, h); card.vy *= -0.6; }
      if (Math.hypot(card.vx, card.vy) < 8) card.vx = card.vy = 0;
    }
    render(card);
  }
}

// ---------------------------------------------------------------- pointers

const pointers = new Map(); // id -> pointer

function getPointer(id) {
  let p = pointers.get(id);
  if (!p) {
    const el = document.createElement("div");
    el.className = "cursor";
    cursorsEl.appendChild(el);
    p = {
      id, el, x: 0, y: 0, pinching: false, seen: 0,
      fx: new OneEuro(), fy: new OneEuro(), fax: new OneEuro(), fay: new OneEuro(),
      card: null, hover: null, grabDX: 0, grabDY: 0, scrollFrames: 0, scrollEl: null,
      downAt: 0, downX: 0, downY: 0, travel: 0, hist: [],
    };
    pointers.set(id, p);
  }
  return p;
}

// Two fingers out (index and middle, ring and little finger curled) scroll
// whatever is under the hand: point them up to scroll up, down to scroll down,
// like holding an arrow key. `point` is how vertical they are, -1 straight up
// to +1 straight down; null when the hand isn't in the pose.
// Two fingers out and a quick swipe over a message card send it off the
// screen and dismiss it. Thrown cards only bounce off the edges; this is the
// way to get rid of one.
function flickStep(p, point) {
  if (point === null || p.pinching || p.hist.length < 2) return;
  const first = p.hist[0], last = p.hist[p.hist.length - 1];
  const span = (last.t - first.t) / 1000;
  if (span < 0.04) return;
  const vx = (last.x - first.x) / span, vy = (last.y - first.y) / span;
  if (Math.hypot(vx, vy) < FLICK_SPEED) return;
  const card = cardAt(first.x, first.y) ?? cardAt(last.x, last.y);
  if (card?.kind !== "message" || card.holders.length || card.flung) return;
  card.flung = true;
  card.target = null;
  card.vx = vx * 1.5;
  card.vy = vy * 1.5;
  say("flicked away");
}

// With the Spotify window open, point a finger straight up for volume up and
// straight down for volume down: a step every VOLUME_EVERY_MS while you hold
// it. Not while aiming at a button, so pointing to air-tap a key still works.
function volumeStep(p, pointing, dir, now) {
  const sp = spotifyLive();
  const upright = pointing && dir !== null && Math.abs(dir) > VOLUME_VERTICAL && !p.hot && !p.pinching;
  const want = sp && upright ? (dir < 0 ? 1 : -1) : 0;
  if (want !== p.volDir) {
    p.volDir = want;
    p.volSince = now;
    p.volLast = -Infinity;
  }
  p.el.classList.toggle("vol-up", want > 0);
  p.el.classList.toggle("vol-down", want < 0);
  if (!want || now - p.volSince < VOLUME_SETTLE_MS || now - p.volLast < VOLUME_EVERY_MS) return;
  p.volLast = now;
  sp.data.instance.volume(want * VOLUME_STEP);
}

// Hold a hand sign while Spotify is the app in use: thumbs down skips to the
// next song, a still palm to the camera pauses. Each fires once per sign;
// drop your hand (or change the sign) to do it again. While a timer is
// ringing, a palm stops it instead, and nothing else.
function poseStep(p, pose, now) {
  if (pose) p.poseSeen = now;
  else if (p.pose && now - p.poseSeen < POSE_GRACE_MS) pose = p.pose;
  if (pose !== p.pose) {
    p.pose = pose;
    p.poseSince = now;
    p.poseFired = false;
  }
  if (timers.ringing) {
    if (pose === "palm" && !p.poseFired && now - p.poseSince >= PALM_DISMISS_MS) {
      p.poseFired = true;
      timers.dismissAll();
    }
    return;
  }
  const sp = spotifyLive();
  const live = pose && sp && !p.poseFired;
  p.el.classList.toggle("sign-next", !!live && pose === "thumbs-down");
  p.el.classList.toggle("sign-pause", !!live && pose === "palm");
  if (!live) return;
  if (pose === "palm" && p.hist.length > 1) {
    const a = p.hist[0], b = p.hist[p.hist.length - 1];
    const speed = dist(a.ax, a.ay, b.ax, b.ay) / Math.max((b.t - a.t) / 1000, 0.001);
    if (speed > PALM_STILL_PX_S) p.poseSince = now; // moving: start the count again
    // Mid-swipe, or just after one: the open hand is swiping, not stopping.
    // (Only a fast stroke counts; a resting hand's jitter makes slow ones.)
    const swiping = (p.stroke && p.stroke.peak >= SWIPE_SPEED) || p.swipe || now - (p.swipeAt ?? -Infinity) < PALM_AFTER_SWIPE_MS;
    if (swiping) p.poseSince = now;
  }
  if (now - p.poseSince < POSE_HOLD_MS[pose]) return;
  p.poseFired = true;
  p.el.classList.remove("sign-next", "sign-pause");
  sp.data.instance.gesture(pose === "thumbs-down" ? "next" : "pause", pose);
}

// With the Spotify window open, swipe an open hand sideways: left for the
// previous song, right for the next. Each sideways stroke is judged whole when
// it ends; a wind-up before a swipe, or the swing back after one, is a stroke
// too, so the fastest stroke of the bunch wins and only after a short pause.
// A swipe that carries the hand out of the camera's view counts as well
// (swipeEnd runs when the hand is lost).
function swipeStep(p, openHand, now) {
  if (openHand) p.openSeen = now;
  const sp = spotifyLive();
  if (!sp || p.card || p.pinching) {
    p.stroke = p.swipe = null;
    return;
  }
  const h = p.hist;
  if (h.length < 2) return;
  const a = h[h.length - 2], b = h[h.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return;
  const vx = (b.rx - a.rx) / dt, vy = (b.ry - a.ry) / dt;
  const dir = Math.abs(vx) > SWIPE_MOVING && Math.abs(vx) > Math.abs(vy) ? Math.sign(vx) : 0;
  if (p.stroke && dir !== p.stroke.dir) {
    strokeDone(p, p.stroke, now);
    p.stroke = null;
  }
  if (dir && !p.stroke) p.stroke = { dir, x0: a.rx, y0: a.ry, x1: b.rx, y1: b.ry, peak: 0, open: false };
  const st = p.stroke;
  if (st) {
    st.x1 = b.rx;
    st.y1 = b.ry;
    st.peak = Math.max(st.peak, Math.abs(vx));
    st.open ||= now - (p.openSeen ?? -Infinity) < 300;
  }
  const c = p.swipe;
  if (c && now - c.endT > SWIPE_SETTLE_MS && !(st && st.peak > c.peak)) fireSwipe(p, now);
}

// A finished stroke: keep it as the swipe if it qualifies and beats the last.
function strokeDone(p, st, now) {
  const dx = st.x1 - st.x0, dy = st.y1 - st.y0;
  if (!st.open || st.peak < SWIPE_SPEED || Math.abs(dx) < innerWidth * SWIPE_MIN_FRAC || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
  if (!p.swipe || st.peak > p.swipe.peak) p.swipe = { dir: st.dir, peak: st.peak, endT: now };
}

function fireSwipe(p, now) {
  const c = p.swipe;
  p.swipe = null;
  const sp = spotifyLive();
  if (!c || !sp || now - (p.swipeAt ?? -Infinity) < SWIPE_COOLDOWN_MS) return;
  p.swipeAt = now;
  sp.data.instance.gesture(c.dir < 0 ? "prev" : "next", "swipe");
}

// The hand left the camera's view: finish its stroke and fire what it was.
function swipeEnd(p, now) {
  if (p.stroke) strokeDone(p, p.stroke, now);
  p.stroke = null;
  if (p.swipe) fireSwipe(p, now);
}

function scrollStep(p, point, now) {
  const dt = Math.min((now - (p.scrollT ?? now)) / 1000, 0.1);
  p.scrollT = now;
  if (point === null || p.pinching) {
    p.scrollFrames = 0;
    p.scrollEl = null;
    p.el.classList.remove("scrolling", "scroll-up", "scroll-down");
    return;
  }
  const strength = Math.max(0, (Math.abs(point) - SCROLL_DEADZONE) / (1 - SCROLL_DEADZONE));
  p.el.classList.add("scrolling");
  p.el.classList.toggle("scroll-up", strength > 0 && point < 0);
  p.el.classList.toggle("scroll-down", strength > 0 && point > 0);
  if (++p.scrollFrames < SCROLL_SETTLE) return;
  if (p.scrollFrames === SCROLL_SETTLE) {
    // Lock onto one scrollable area for the whole gesture.
    const card = cardAt(p.x, p.y);
    const collapsed = card?.kind === "message" && !card.el.classList.contains("open");
    const scrollable = (el) => el.scrollHeight > el.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(el).overflowY);
    let el = card && !collapsed ? document.elementFromPoint(p.x, p.y) : null;
    while (el && el !== card.el && !scrollable(el)) el = el.parentElement;
    p.scrollEl = el && el !== card.el ? el
      : [...(!collapsed && card?.el.querySelectorAll(".body, .output") || [])].find(scrollable) ?? null;
    if (!p.scrollEl) say(card ? "scroll: open it first, nothing to scroll yet" : "scroll: hold two fingers over an open card");
    return;
  }
  if (p.scrollEl) p.scrollEl.scrollTop += Math.sign(point) * strength * SCROLL_SPEED * dt;
}

// `anchor` is the point used to tell a tap from a drag. For a hand it's the
// palm: opening the fingers to release a pinch moves the fingertips but not
// the palm, so a quick pinch still reads as a tap.
function updatePointer(id, rawX, rawY, pinching, now, { smooth = true, anchor = null, scrollPoint = null, pointing = false, pointDir = null, pose = null, openHand = false, tap = null, fingers = 0 } = {}) {
  const p = getPointer(id);
  p.fingers = fingers;
  const x = smooth ? p.fx.filter(rawX, now) : rawX;
  const y = smooth ? p.fy.filter(rawY, now) : rawY;
  // The anchor is the hand itself (the middle knuckle), smoothed like the
  // cursor. A held card follows it, not the fingertips, so opening your
  // fingers to let go doesn't move or fling the card.
  p.ax = anchor ? (smooth ? p.fax.filter(anchor.x, now) : anchor.x) : x;
  p.ay = anchor ? (smooth ? p.fay.filter(anchor.y, now) : anchor.y) : y;
  if (p.pinching) p.travel = Math.max(p.travel, dist(p.ax, p.ay, p.downX, p.downY));
  p.x = x;
  p.y = y;
  p.seen = now;
  p.hist.push({ t: now, x, y, ax: p.ax, ay: p.ay, rx: anchor ? anchor.x : x, ry: anchor ? anchor.y : y });
  while (p.hist.length && now - p.hist[0].t > 100) p.hist.shift();

  if (pinching && !p.pinching) pinchDown(p, now);
  else if (!pinching && p.pinching) pinchUp(p, now, false);

  p.el.style.transform = `translate(${x}px, ${y}px)`;
  p.el.classList.toggle("pinching", p.pinching);
  scrollStep(p, scrollPoint, now);
  flickStep(p, scrollPoint);
  if (!p.pinching) {
    const card = cardAt(x, y);
    setHover(p, card);
    setHot(p, keyAt(x, y, card));
  }
  p.el.classList.toggle("pointing", pointing);
  airTapStep(p, pointing, tap, now);
  volumeStep(p, pointing, pointDir, now);
  poseStep(p, pose, now);
  swipeStep(p, openHand, now);
}

// Point and tap the air: the key pressed is the one aimed at just before the
// fingertip dipped, since the dip itself drags the cursor down a little.
function airTapStep(p, pointing, tap, now) {
  p.aimTrail ??= [];
  if (!pointing) {
    p.aimTrail.length = 0;
    p.tapKey = null;
    return;
  }
  p.aimTrail.push({ t: now, key: p.hot });
  while (p.aimTrail.length > 1 && now - p.aimTrail[1].t > AIM_LAG_MS) p.aimTrail.shift();
  if (tap === "down") p.tapKey = p.aimTrail[0].key;
  else if (tap === "cancel") p.tapKey = null;
  else if (tap === "tap" && p.tapKey) {
    const key = p.tapKey;
    p.tapKey = null;
    const card = cards.get(Number(key.closest(".card")?.dataset.id));
    if (card && !card.removing) onTap(card, key);
  }
}

// The button (anything with data-key) under a point, inside the given card.
function keyAt(x, y, card) {
  const key = card && document.elementFromPoint(x, y)?.closest("[data-key]");
  return key && card.el.contains(key) ? key : null;
}

function setHot(p, key) {
  if (p.hot === key) return;
  p.hot?.classList.remove("hot");
  p.hot = key;
  key?.classList.add("hot");
}

function setHover(p, card) {
  if (p.hover === card) return;
  p.hover?.el.classList.remove("hover");
  p.hover = card;
  card?.el.classList.add("hover");
}

function pinchDown(p, now) {
  p.pinching = true;
  p.downAt = now;
  p.downX = p.ax;
  p.downY = p.ay;
  p.travel = 0;
  setHover(p, null);
  // A ringing timer: any pinch, anywhere, stops it, and does nothing else.
  if (timers.dismissAll()) {
    p.dismissed = true;
    return;
  }
  p.dismissed = false;
  if (document.elementFromPoint(p.x, p.y)?.closest("#timer-strip")) {
    p.stripTap = true;
    return;
  }
  const card = cardAt(p.x, p.y) ?? (p.id !== "mouse" ? gazeCard : null);
  if (!card) {
    if (p.id !== "mouse") say("pinch: no card under your fingers");
    return;
  }
  if (card.kind === "window") focusApp(card.data.app);
  if (card.fixed) {
    // Pinned (the Spotify display): hands can't pick it up, move, throw or
    // stretch it. Only a quick pinch on its ✕ does anything.
    const key = keyAt(p.x, p.y, card);
    p.fixedClose = key?.dataset.key === "close" ? { card, key } : null;
    return;
  }
  p.downKey = keyAt(p.x, p.y, card);
  p.card = card;
  card.target = null;
  card.flung = false; // caught mid-flick: it's yours again
  card.vx = card.vy = 0;
  card.holders.push(p);
  card.el.classList.add("held");
  raise(card);
  if (card.holders.length === 2) {
    const [a, b] = card.holders;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    card.twoHand = {
      dist: Math.max(dist(a.x, a.y, b.x, b.y), 1),
      scale: card.scale,
      offX: card.x - mx,
      offY: card.y - my,
    };
  } else {
    p.grabDX = card.x - p.ax;
    p.grabDY = card.y - p.ay;
  }
}

function pinchUp(p, now, lost) {
  p.pinching = false;
  if (p.dismissed) {
    p.dismissed = false;
    return;
  }
  if (p.stripTap) {
    p.stripTap = false;
    if (!lost && now - p.downAt < TAP_MS && p.travel < TAP_PX) openApp({ data: { app: "timers" }, x: innerWidth / 2, y: 40 });
    return;
  }
  if (p.fixedClose) {
    const { card, key } = p.fixedClose;
    p.fixedClose = null;
    if (!lost && now - p.downAt < TAP_MS && p.travel < TAP_PX) pressWindow(card, key);
    return;
  }
  const card = p.card;
  p.card = null;
  if (!card) return;
  card.holders = card.holders.filter((h) => h !== p);
  card.twoHand = null;
  const rest = card.holders[0];
  if (rest) {
    // The other hand keeps holding: re-anchor it so the card doesn't jump.
    rest.grabDX = card.x - rest.ax;
    rest.grabDY = card.y - rest.ay;
    return;
  }
  card.el.classList.remove("held");
  if (lost) return;
  const held = Math.round(now - p.downAt), moved = Math.round(p.travel);
  if (held < TAP_MS && moved < TAP_PX) {
    say(`tap (${held} ms)`);
    onTap(card, p.downKey);
    return;
  }
  // Thrown only by a deliberate flick: the hand itself moving fast as you let
  // go. Anything slower sets the card down right where it is.
  card.vx = card.vy = 0;
  const first = p.hist[0], last = p.hist[p.hist.length - 1];
  const span = (last.t - first.t) / 1000;
  const vx = span > 0.02 ? (last.ax - first.ax) / span : 0, vy = span > 0.02 ? (last.ay - first.ay) / span : 0;
  const speed = Math.hypot(vx, vy);
  if (speed < THROW_SPEED) return say(`set down (${held} ms, moved ${moved} px)`);
  const k = Math.min(1, 4000 / speed);
  card.vx = vx * k;
  card.vy = vy * k;
  say("thrown");
}

function dropPointer(p, now) {
  swipeEnd(p, now);
  pinchGates.delete(p.id);
  airTaps.delete(p.id);
  pointSeen.delete(p.id);
  if (p.pinching) pinchUp(p, now, true);
  setHover(p, null);
  setHot(p, null);
  p.el.remove();
  pointers.delete(p.id);
}

// ---------------------------------------------------------------- apps

const launchers = [];
let actionTitles = [];  // your own commands from handmedown.json, after the built-in apps

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Handmedown": "1" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function escapeText(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function placeLaunchers() {
  launchers.push(spawnCard({
    kind: "launcher",
    html: '<div class="title">apps</div>',
    x: innerWidth / 2,
    y: innerHeight * 0.88, // low, clear of the Timers window
    data: { menu: "apps" },
  }));
}

function childrenOf(parent) {
  return [...cards.values()].filter((c) => c.data.parent === parent.id && !c.removing);
}

function closeChildren(parent) {
  for (const child of childrenOf(parent)) {
    closeChildren(child);
    removeCard(child);
  }
  parent.el.classList.remove("expanded");
}

// Lay n cards out on an arc above (cx, cy).
function arc(n, cx, cy, radius) {
  const spread = Math.min(Math.PI * 0.8, 0.45 * Math.max(n - 1, 1));
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;
    const angle = -Math.PI / 2 + t * spread;
    return {
      x: clamp(cx + Math.cos(angle) * radius, 90, innerWidth - 90),
      y: clamp(cy + Math.sin(angle) * radius, 50, innerHeight - 50),
    };
  });
}

function openLauncher(card) {
  if (childrenOf(card).length) return closeChildren(card);
  const items = [
    ...Object.entries(APPS).map(([app, a]) => ({ title: a.title, app, kind: "app", meta: "tap to open" })),
    ...actionTitles.map((title, index) => ({ title, index, kind: "action", meta: "tap to run" })),
  ];
  const spots = arc(items.length, card.x, card.y, Math.min(innerHeight * 0.38, 320));
  items.forEach((item, i) => {
    spawnCard({
      kind: item.kind,
      html: `<div class="title">${escapeText(item.title)}</div><div class="meta">${item.meta}</div>` +
        (item.kind === "action" ? '<pre class="output"></pre>' : ""),
      ...spots[i],
      from: card,
      data: { parent: card.id, index: item.index, app: item.app },
    });
  });
  card.el.classList.add("expanded");
}

// ---------------------------------------------------------------- app windows

// Built-in apps open as windows on the board. Each is an object with
// press(key); the board turns taps on its [data-key] buttons into presses.
const APPS = {
  timers: { title: "Timers", html: timersHtml, y: 0.42, create: (el) => timers.attach(el) },
  // Pinned to the left, clear of the apps ring (centre) and pushed cards (right).
  spotify: { title: "Spotify", html: spotifyHtml, x: 0.25, y: 0.47, fixed: true, create: (el) => new SpotifyApp(el, { api, say }) },
};
const windows = new Map(); // app name -> its open window card
const OPEN_APPS_STORE = "handmedown.openApps";

// Hand signs go to one app at a time: the one you last opened or touched.
// So holding up fingers for a timer can't pause Spotify, and the other way round.
let focusedApp = null;

function focusApp(name) {
  focusedApp = name;
  for (const [n, card] of windows) card.el.classList.toggle("focused", n === name && !card.removing);
}

function spotifyLive() {
  const sp = windows.get("spotify");
  return sp && !sp.removing && focusedApp === "spotify" ? sp : null;
}

// Which app windows are open, kept so a reload (or restart) brings them back.
function saveOpenApps() {
  const names = [...windows].filter(([, card]) => !card.removing).map(([name]) => name);
  try { localStorage.setItem(OPEN_APPS_STORE, JSON.stringify(names)); } catch { /* private window */ }
}

function reopenApps() {
  let names = null;
  try { names = JSON.parse(localStorage.getItem(OPEN_APPS_STORE)); } catch { /* none */ }
  if (!Array.isArray(names)) names = ["timers"]; // first run: open Timers
  const from = launchers[0];
  for (const name of names) if (APPS[name]) openApp({ data: { app: name }, x: from.x, y: from.y });
}

function openApp(from) {
  const name = from.data.app, spec = APPS[name];
  const open = windows.get(name);
  if (open && !open.removing) {
    // Already open: bring it back to the middle.
    open.target = { x: innerWidth * (spec.x ?? 0.5), y: innerHeight * spec.y };
    raise(open);
    focusApp(name);
    return;
  }
  const card = spawnCard({
    kind: "window",
    html: spec.html,
    x: innerWidth * (spec.x ?? 0.5),
    y: innerHeight * spec.y,
    from,
    data: { app: name },
  });
  card.el.classList.add(name);
  card.fixed = !!spec.fixed;
  card.data.instance = spec.create(card.el);
  windows.set(name, card);
  focusApp(name);
  saveOpenApps();
}

function pressWindow(card, key) {
  focusApp(card.data.app);
  if (!key) return;
  key.classList.remove("pressed");
  void key.offsetWidth; // restart the flash
  key.classList.add("pressed");
  if (key.dataset.key === "close") removeCard(card);
  else card.data.instance.press(key.dataset.key);
}

async function runAction(card) {
  const el = card.el;
  if (el.classList.contains("running")) return;
  const meta = el.querySelector(".meta"), out = el.querySelector(".output");
  el.classList.remove("ok", "failed");
  el.classList.add("running");
  meta.textContent = "running…";
  out.textContent = "";
  try {
    const { ok, output } = await api("/api/run", { index: card.data.index });
    el.classList.add(ok ? "ok" : "failed");
    meta.textContent = ok ? "done ✓" : "failed ✗";
    out.textContent = output;
  } catch (err) {
    el.classList.add("failed");
    meta.textContent = "failed ✗";
    out.textContent = err.message;
  }
  el.classList.remove("running");
  raise(card);
}

// ---------------------------------------------------------------- live board

// Cards pushed by scripts and Claude (bin/hmd). The server owns them; the page
// mirrors its snapshot, so cards pushed while the page was hidden are waiting.
const messageCards = new Map(); // server card id -> card

function fillMessage(card, msg) {
  const time = new Date(msg.updated * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  card.el.className = card.el.className.replace(/\btone-\w+/g, "").trim() + ` tone-${msg.tone}`;
  card.el.querySelector(".title").textContent = msg.title;
  card.el.querySelector(".meta").textContent = time;
  card.el.querySelector(".body").innerHTML = msg.body ? renderMarkdown(msg.body) : "";
  card.data.updated = msg.updated;
}

// Next free spot in the columns down the right-hand side.
function messageSpot() {
  const slot = messageCards.size;
  const perColumn = Math.max(1, Math.floor((innerHeight - 140) / 120));
  const col = Math.floor(slot / perColumn), row = slot % perColumn;
  return {
    x: clamp(innerWidth - 200 - col * 360, 180, innerWidth - 180),
    y: 110 + row * 120,
  };
}

function applyBoard({ cards: list, sessions, timers: timerList, now: serverNow }) {
  timers.set(timerList, serverNow);
  const live = new Set();
  for (const msg of list) {
    live.add(msg.id);
    let card = messageCards.get(msg.id);
    if (!card) {
      const spot = messageSpot();
      card = spawnCard({
        kind: "message",
        html: '<div class="title"></div><div class="meta"></div><div class="body"></div>',
        ...spot,
        from: { x: spot.x, y: -120 },
        data: { serverId: msg.id },
      });
      messageCards.set(msg.id, card);
      fillMessage(card, msg);
    } else if (card.data.updated !== msg.updated) {
      fillMessage(card, msg);
      raise(card);
    }
  }
  for (const [id, card] of messageCards) {
    if (!live.has(id)) {
      messageCards.delete(id);
      removeCard(card);
    }
  }
  renderSessions(sessions);
}

function dismissMessage(card) {
  if (card.removing) return;
  messageCards.delete(card.data.serverId);
  removeCard(card);
  api("/api/remove", { id: card.data.serverId }).catch(() => {});
}

const STATE_RANK = { waiting: 3, working: 2, done: 1, idle: 0 };
const STATE_WORDS = { waiting: "needs you", working: "working", done: "done", idle: "idle" };

function renderSessions(sessions) {
  const sorted = [...sessions].sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state]);
  presenceEl.hidden = !sorted.length;
  presenceEl.className = sorted.length ? `state-${sorted[0].state}` : "";
  presenceEl.querySelector(".list").innerHTML = sorted
    .map((s) => `<div class="session state-${s.state}"><span class="dot"></span>` +
      `${escapeText(s.label || s.source)} <span class="word">${STATE_WORDS[s.state]}</span></div>`)
    .join("");
}

function connectBoard() {
  // EventSource reconnects by itself if the server restarts.
  const events = new EventSource("/api/events");
  events.onmessage = (e) => applyBoard(JSON.parse(e.data));
}

function onTap(card, key = null) {
  if (card.kind === "launcher") openLauncher(card);
  else if (card.kind === "app") openApp(card);
  else if (card.kind === "window") pressWindow(card, key);
  else if (card.kind === "action") runAction(card);
  else if (card.kind === "message") {
    card.el.classList.toggle("open");
    raise(card);
  }
}

function clearBoard() {
  // Pushed cards stay: flick them away to dismiss them for good.
  for (const card of cards.values()) {
    if (card.kind !== "launcher" && card.kind !== "message") removeCard(card);
  }
  for (const l of launchers) l.el.classList.remove("expanded");
}

// ---------------------------------------------------------------- mouse fallback

addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse") return;
  updatePointer("mouse", e.clientX, e.clientY, (e.buttons & 1) === 1, performance.now(), { smooth: false });
});
addEventListener("pointerdown", (e) => {
  timers.unlock(); // a real click: the page may make sound now
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  e.preventDefault();
  updatePointer("mouse", e.clientX, e.clientY, true, performance.now(), { smooth: false });
});
addEventListener("pointerup", (e) => {
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  updatePointer("mouse", e.clientX, e.clientY, false, performance.now(), { smooth: false });
});
// Alt/Ctrl + wheel over a card scales it (stands in for the two-hand stretch).
addEventListener("wheel", (e) => {
  if (!e.altKey && !e.ctrlKey) return;
  const card = cardAt(e.clientX, e.clientY);
  if (!card) return;
  e.preventDefault();
  card.scale = clamp(card.scale * Math.exp(-e.deltaY * 0.002), MIN_SCALE, MAX_SCALE);
}, { passive: false });
addEventListener("keydown", (e) => {
  timers.unlock();
  if (timers.dismissAll()) return; // any key stops a ringing timer
  if (e.key === "Escape" || e.key === "c") {
    look.cancelCalibration();
    clearBoard();
  } else if (e.key === "g") {
    look.setMode(look.active ? "off" : "eyes").catch((err) => say(`face tracking failed: ${err.message}`));
  } else if (e.key === "k") {
    look.calibrate();
  }
});

// ---------------------------------------------------------------- hand tracking

let landmarker = null;
let lastVideoTime = -1;
let visionPromise = null;

// MediaPipe's vision bundle and wasm, shared by the hand and face trackers.
function loadVision() {
  visionPromise ??= (async () => {
    const mod = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
    const fileset = await mod.FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
    return { mod, fileset };
  })();
  return visionPromise;
}

// Map a normalized landmark to screen px, matching the mirrored, object-fit:
// cover video underneath.
function toScreen(lm) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(innerWidth / vw, innerHeight / vh);
  const dw = vw * s, dh = vh * s;
  return {
    x: (innerWidth - dw) / 2 + (1 - lm.x) * dw,
    y: (innerHeight - dh) / 2 + lm.y * dh,
  };
}

// Briefly show what the last pinch did, so gesture tuning isn't guesswork.
let sayUntil = 0;
function say(text) {
  statusEl.textContent = text;
  sayUntil = performance.now() + 2500;
}

// Per hand: after a release the tips must clearly part (past PINCH_OFF)
// before the next grab, so jitter at the moment of letting go can't re-grab.
// While holding, the tips must stay apart for RELEASE_MS before it lets go:
// a fast drag blurs the fingers for a frame or two, and that mustn't drop
// (or throw) the card while you're still pinching.
const pinchGates = new Map();

function pinchGate(id, ratio, now) {
  let g = pinchGates.get(id);
  if (!g) pinchGates.set(id, (g = { armed: true, apartSince: null }));
  if (pointers.get(id)?.pinching) {
    if (ratio <= PINCH_OFF) {
      g.apartSince = null;
      return true;
    }
    g.apartSince ??= now;
    if (now - g.apartSince < RELEASE_MS) return true;
    g.apartSince = null;
    g.armed = false;
    return false;
  }
  if (ratio > PINCH_OFF) g.armed = true;
  return g.armed && ratio < PINCH_ON;
}

// ---------------------------------------------------------------- look to choose

const look = new Look({ loadVision, video, say, Filter: OneEuro, onDoubleBlink });
const timers = new Timers({ api, say, fast: FAST });
let gazeCard = null;

// Double blink: tap the card you're looking at, hands-free.
function onDoubleBlink() {
  if (!gazeCard) return say("double blink: look at a card first");
  say("double blink");
  const el = gazeCard.el;
  el.classList.remove("blinked");
  void el.offsetWidth; // restart the flash
  el.classList.add("blinked");
  onTap(gazeCard);
}

// The card nearest the look point (0 inside it), if any is close enough.
function updateGazeCard(pt) {
  let best = null, bestD = Infinity, currentD = Infinity;
  if (pt) {
    for (const card of cards.values()) {
      if (card.removing) continue;
      const r = card.el.getBoundingClientRect();
      const d = Math.hypot(
        Math.max(r.left - pt.x, 0, pt.x - r.right),
        Math.max(r.top - pt.y, 0, pt.y - r.bottom),
      );
      if (d < bestD) { best = card; bestD = d; }
      if (card === gazeCard) currentD = d;
    }
  }
  let next = bestD < GAZE_SNAP_PX ? best : null;
  if (gazeCard && currentD < GAZE_SNAP_PX && currentD < bestD + GAZE_STICKY_PX) next = gazeCard;
  if (next === gazeCard) return;
  gazeCard?.el.classList.remove("gazed");
  gazeCard = next;
  gazeCard?.el.classList.add("gazed");
}

// Air tap detector per hand. `reach` is fingertip-to-wrist over knuckle-to-
// wrist: high when the index is straight, dropping as it bends. A tap is a
// quick dip and recovery against the hand's own straight-finger baseline, so
// slow bends and holding the finger curled don't count.
const airTaps = new Map();

function airTapGate(id, reach, pointMode, now) {
  let g = airTaps.get(id);
  if (!g) airTaps.set(id, (g = { base: reach, down: false, at: 0 }));
  if (!pointMode) {
    Object.assign(g, { base: reach, down: false });
    return null;
  }
  if (!g.down) {
    if (reach < g.base * TAP_DIP) {
      Object.assign(g, { down: true, at: now });
      return "down";
    }
    g.base += (reach - g.base) * 0.2; // follow the straight finger, slowly
    return null;
  }
  if (now - g.at > TAP_WINDOW_MS) {
    Object.assign(g, { base: reach, down: false });
    return "cancel";
  }
  if (reach > g.base * TAP_BACK) {
    g.down = false;
    return "tap";
  }
  return null;
}

const pointSeen = new Map(); // hand id -> last time it was clearly pointing

function trackHands(now) {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  if (look.active) updateGazeCard(look.update(now));
  else if (gazeCard) updateGazeCard(null);
  if (DEBUG && look.active && now > sayUntil) statusEl.textContent = look.debugText();
  const result = landmarker.detectForVideo(video, now);
  const vw = video.videoWidth, vh = video.videoHeight;
  const used = new Set();

  result.landmarks.forEach((lms, i) => {
    let id = `hand-${result.handedness[i]?.[0]?.categoryName ?? i}`;
    if (used.has(id)) id += `-${i}`;
    used.add(id);

    // Pinch measured as a ratio to palm length, so it works at any distance.
    const px = (l) => [l.x * vw, l.y * vh];
    const [tx, ty] = px(lms[4]), [ix, iy] = px(lms[8]);
    const [wx, wy] = px(lms[0]), [mx, my] = px(lms[9]);
    const ratio = dist(tx, ty, ix, iy) / Math.max(dist(wx, wy, mx, my), 1);
    const pinching = pinchGate(id, ratio, now);
    if (DEBUG && !look.active && now > sayUntil) {
      statusEl.textContent = `gap ${ratio.toFixed(2)} ${pinching ? "touching" : "apart"}`;
    }

    // A finger is out when its tip is well beyond its middle knuckle from the wrist.
    const out = (tip, pip) => {
      const [ax, ay] = px(lms[tip]), [bx, by] = px(lms[pip]);
      return dist(wx, wy, ax, ay) > dist(wx, wy, bx, by) * 1.1;
    };
    const twoFingers = !pinching && out(8, 6) && out(12, 10) && !out(16, 14) && !out(20, 18);
    // Pointing: index out, the rest curled. Held briefly through a tap, when the
    // index itself bends and would otherwise read as "not pointing".
    const othersCurled = !out(12, 10) && !out(16, 14) && !out(20, 18);
    if (!pinching && othersCurled && out(8, 6)) pointSeen.set(id, now);
    const pointing = !pinching && othersCurled && now - (pointSeen.get(id) ?? -Infinity) < POINT_HOLD_MS;
    const [rx, ry] = px(lms[8]), [kx, ky] = px(lms[6]);
    const tap = airTapGate(id, dist(wx, wy, rx, ry) / Math.max(dist(wx, wy, kx, ky), 1), pointing, now);
    // Which way the pointing finger points: knuckle-to-tip, vertical share (-1 straight up).
    let pointDir = null;
    if (pointing) {
      const [bx, by] = px(lms[5]);
      pointDir = (ry - by) / Math.max(Math.hypot(rx - bx, ry - by), 1);
    }
    // Hand signs for Spotify.
    const palmLen = Math.max(dist(wx, wy, mx, my), 1);
    const [i5x, i5y] = px(lms[5]), [t2x, t2y] = px(lms[2]);
    const thumbOut = dist(tx, ty, i5x, i5y) / palmLen;              // thumb tip well away from the index knuckle
    const thumbDown = (ty - t2y) / Math.max(dist(t2x, t2y, tx, ty), 1); // 1: thumb straight down
    const [m12x, m12y] = px(lms[12]);
    const fingersUp = (wy - m12y) / Math.max(dist(wx, wy, m12x, m12y), 1); // 1: fingers straight up
    let pose = null;
    if (!pinching && !out(8, 6) && othersCurled && thumbOut > 0.6 && thumbDown > 0.7) pose = "thumbs-down";
    // Stop sign: all four fingers out and pointing up, thumb any way. (Either
    // side of the hand works; poseStep also wants it held still.)
    else if (!pinching && out(8, 6) && out(12, 10) && out(16, 14) && out(20, 18) && fingersUp > 0.6) pose = "palm";
    if (DEBUG && pose && now > sayUntil) statusEl.textContent = `sign: ${pose}`;
    const openHand = !pinching && out(8, 6) && out(12, 10) && out(16, 14) && out(20, 18);
    // Fingers held up, for setting a timer. The thumb counts when it's well
    // clear of the hand (a thumbs-up is 1). A lone index finger is pointing,
    // which aims and air-taps, so it counts as nothing.
    const thumbUp = thumbOut > 0.75 && (t2y - ty) / Math.max(dist(t2x, t2y, tx, ty), 1) > 0.3;
    const fingers = pinching || pointing ? 0
      : [out(8, 6), out(12, 10), out(16, 14), out(20, 18), thumbUp].filter(Boolean).length;

    // Which way those two fingers point: knuckle-to-tip, vertical share.
    let scrollPoint = null;
    if (twoFingers) {
      const [k1x, k1y] = px(lms[5]), [t1x, t1y] = px(lms[8]);
      const [k2x, k2y] = px(lms[9]), [t2x, t2y] = px(lms[12]);
      const dx = t1x - k1x + t2x - k2x, dy = t1y - k1y + t2y - k2y;
      scrollPoint = dy / Math.max(Math.hypot(dx, dy), 1);
    }

    // Pinch cursor sits between thumb and index; a pointing cursor on the fingertip.
    const c = pointing ? toScreen(lms[8]) : toScreen({ x: (lms[4].x + lms[8].x) / 2, y: (lms[4].y + lms[8].y) / 2 });
    updatePointer(id, c.x, c.y, pinching, now, { anchor: toScreen(lms[9]), scrollPoint, pointing, pointDir, pose, openHand, tap, fingers });
  });
  countFingers(now);

  for (const p of [...pointers.values()]) {
    if (p.id !== "mouse" && now - p.seen > LOST_MS) dropPointer(p, now);
  }
  const hands = [...pointers.keys()].filter((k) => k !== "mouse").length;
  if (now > sayUntil && !(DEBUG && (hands || look.active))) statusEl.textContent = hands ? `${hands} hand${hands > 1 ? "s" : ""}` : "show a hand";
  if (DEBUG) drawDebug(result.landmarks);
}

// Every hand's fingers, added up, for the Timers window when it's the app in use.
function countFingers(now) {
  const hands = [...pointers.values()].filter((p) => p.id !== "mouse");
  if (focusedApp !== "timers") return timers.count(null, false, now);
  let total = 0, steady = true;
  for (const p of hands) {
    total += p.fingers || 0;
    const a = p.hist[0], b = p.hist[p.hist.length - 1];
    if (a && b && b.t > a.t && dist(a.ax, a.ay, b.ax, b.ay) / ((b.t - a.t) / 1000) > COUNT_STILL_PX_S) steady = false;
  }
  timers.count(total, steady, now);
}

function drawDebug(hands) {
  const dpr = devicePixelRatio || 1;
  if (debugCanvas.width !== innerWidth * dpr) {
    debugCanvas.width = innerWidth * dpr;
    debugCanvas.height = innerHeight * dpr;
  }
  const ctx = debugCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.fillStyle = "#f2b45a";
  for (const lms of hands) {
    for (const lm of lms) {
      const { x, y } = toScreen(lm);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

let cameraAllowed = false;

function openCamera(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(deviceId && { deviceId: { exact: deviceId } }) },
    audio: false,
  });
}

// Always the laptop's built-in camera, even with a webcam or an iPhone
// (Continuity Camera) around that the browser would otherwise pick first.
async function startCamera() {
  try {
    // Ask with the default camera first: camera names stay hidden until allowed.
    let stream = await openCamera(null);
    cameraAllowed = true;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const laptop = cams.find((c) => /facetime|built-in|integrated/i.test(c.label));
    if (laptop && stream.getVideoTracks()[0]?.getSettings().deviceId !== laptop.deviceId) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await openCamera(laptop.deviceId);
    }
    if (document.hidden) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    statusEl.textContent = "no camera: mouse mode (click = pinch)";
    throw err;
  }
}

async function startTracker() {
  statusEl.textContent = "loading hand tracking…";
  const { mod, fileset } = await loadVision();
  landmarker = await mod.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 2,
  });
  statusEl.textContent = "show a hand";
}

// The camera only runs while the board is on screen: swipe to another Space
// or switch tabs and it switches off, and back on when you return.
function stopCamera() {
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  lastVideoTime = -1;
  look.pause();
  updateGazeCard(null);
  const now = performance.now();
  for (const p of [...pointers.values()]) if (p.id !== "mouse") dropPointer(p, now);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopCamera();
  else if (cameraAllowed && !video.srcObject) {
    startCamera()
      .then(() => { statusEl.textContent = landmarker ? "show a hand" : statusEl.textContent; })
      .catch(() => {});
  }
});

// ---------------------------------------------------------------- main loop

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  trackHands(now);
  stepCards(dt);
  timers.frame(now);
  requestAnimationFrame(frame);
}

async function main() {
  api("/api/config")
    .then(({ name, actions }) => {
      document.getElementById("hud-name").textContent = name;
      document.title = name;
      actionTitles = actions || [];
    })
    .catch(() => {});
  placeLaunchers();
  reopenApps();
  connectBoard();
  requestAnimationFrame(frame);
  try {
    await startCamera();
    await startTracker();
    const mode = params.get("look") ?? Look.savedMode();
    if (mode === "eyes") {
      look.setMode(mode).catch((err) => say(`face tracking failed: ${err.message}`));
    }
  } catch (err) {
    console.warn("handmedown: hand tracking unavailable", err);
    if (video.srcObject) statusEl.textContent = "hand tracking failed to load: mouse mode";
  }
}

main();
