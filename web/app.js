// handmedown board: webcam hand tracking -> pinchable glass cards.
//
// Every input (each tracked hand, and the mouse as a fallback) is a "pointer"
// with a screen position and a pinching flag. Pointers grab cards; the board
// steps card motion once per frame.

import { renderMarkdown } from "./markdown.js";

const MEDIAPIPE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const PINCH_ON = 0.28;   // thumb-index gap / palm length: below this starts a pinch
const PINCH_OFF = 0.42;  // ...above this ends it (hysteresis stops flicker)
const TAP_MS = 300;      // pinch shorter than this, with little travel, is a tap
const TAP_PX = 28;
const LOST_MS = 180;     // a hand missing longer than this is released
const MIN_SCALE = 0.4;
const MAX_SCALE = 3;

const params = new URLSearchParams(location.search);
const DEBUG = params.get("debug") === "1";

const video = document.getElementById("camera");
const debugCanvas = document.getElementById("debug");
const boardEl = document.getElementById("board");
const cursorsEl = document.getElementById("cursors");
const statusEl = document.getElementById("hud-status");

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
      card.x = a.x + a.grabDX;
      card.y = a.y + a.grabDY;
    } else if (card.target) {
      const k = Math.min(1, dt * 9);
      card.x += (card.target.x - card.x) * k;
      card.y += (card.target.y - card.y) * k;
      if (dist(card.x, card.y, card.target.x, card.target.y) < 0.5) card.target = null;
    } else if (card.vx || card.vy) {
      card.x += card.vx * dt;
      card.y += card.vy * dt;
      const drag = Math.pow(0.05, dt);
      card.vx *= drag;
      card.vy *= drag;
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
      fx: new OneEuro(), fy: new OneEuro(),
      card: null, hover: null, grabDX: 0, grabDY: 0,
      downAt: 0, downX: 0, downY: 0, travel: 0, hist: [],
    };
    pointers.set(id, p);
  }
  return p;
}

function updatePointer(id, rawX, rawY, pinching, now, smooth = true) {
  const p = getPointer(id);
  const x = smooth ? p.fx.filter(rawX, now) : rawX;
  const y = smooth ? p.fy.filter(rawY, now) : rawY;
  if (p.pinching) p.travel = Math.max(p.travel, dist(x, y, p.downX, p.downY));
  p.x = x;
  p.y = y;
  p.seen = now;
  p.hist.push({ t: now, x, y });
  while (p.hist.length && now - p.hist[0].t > 100) p.hist.shift();

  if (pinching && !p.pinching) pinchDown(p, now);
  else if (!pinching && p.pinching) pinchUp(p, now, false);

  p.el.style.transform = `translate(${x}px, ${y}px)`;
  p.el.classList.toggle("pinching", p.pinching);
  if (!p.pinching) setHover(p, cardAt(x, y));
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
  p.downX = p.x;
  p.downY = p.y;
  p.travel = 0;
  setHover(p, null);
  const card = cardAt(p.x, p.y);
  if (!card) return;
  p.card = card;
  card.target = null;
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
    p.grabDX = card.x - p.x;
    p.grabDY = card.y - p.y;
  }
}

function pinchUp(p, now, lost) {
  p.pinching = false;
  const card = p.card;
  p.card = null;
  if (!card) return;
  card.holders = card.holders.filter((h) => h !== p);
  card.twoHand = null;
  const rest = card.holders[0];
  if (rest) {
    // The other hand keeps holding: re-anchor it so the card doesn't jump.
    rest.grabDX = card.x - rest.x;
    rest.grabDY = card.y - rest.y;
    return;
  }
  card.el.classList.remove("held");
  if (lost) return;
  if (now - p.downAt < TAP_MS && p.travel < TAP_PX) {
    onTap(card);
    return;
  }
  const first = p.hist[0], last = p.hist[p.hist.length - 1];
  const span = (last.t - first.t) / 1000;
  if (span > 0.02) {
    const vx = (last.x - first.x) / span, vy = (last.y - first.y) / span;
    const speed = Math.hypot(vx, vy);
    if (speed > 250) {
      const k = Math.min(1, 4000 / speed);
      card.vx = vx * k;
      card.vy = vy * k;
    }
  }
}

function dropPointer(p, now) {
  if (p.pinching) pinchUp(p, now, true);
  setHover(p, null);
  p.el.remove();
  pointers.delete(p.id);
}

// ---------------------------------------------------------------- notes

let launcher = null;
const noteCache = new Map();

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function escapeText(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function placeLauncher() {
  launcher = spawnCard({
    kind: "launcher",
    html: '<div class="title">notes</div>',
    x: innerWidth / 2,
    y: innerHeight * 0.82,
  });
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

async function openLauncher(card) {
  if (childrenOf(card).length) return closeChildren(card);
  let folders;
  try {
    ({ folders } = await api("/api/notes"));
  } catch (err) {
    statusEl.textContent = `couldn't load notes (${err.message})`;
    return;
  }
  const spots = arc(folders.length, card.x, card.y, Math.min(innerHeight * 0.38, 320));
  folders.forEach((folder, i) => {
    spawnCard({
      kind: "folder",
      html: `<div class="title">${escapeText(folder.name)}</div>
             <div class="meta">${folder.notes.length} note${folder.notes.length === 1 ? "" : "s"}</div>`,
      ...spots[i],
      from: card,
      data: { parent: card.id, folder },
    });
  });
  card.el.classList.add("expanded");
}

function openFolder(card) {
  if (childrenOf(card).length) return closeChildren(card);
  const notes = card.data.folder.notes;
  const spots = arc(notes.length, card.x, card.y, 170);
  notes.forEach((note, i) => {
    spawnCard({
      kind: "note",
      html: `<div class="title">${escapeText(note.title)}</div><div class="body"></div>`,
      ...spots[i],
      from: card,
      data: { parent: card.id, note },
    });
  });
  card.el.classList.add("expanded");
}

async function toggleNote(card) {
  const el = card.el;
  if (el.classList.contains("open")) {
    el.classList.remove("open");
    return;
  }
  const { path } = card.data.note;
  if (!noteCache.has(path)) {
    try {
      const { markdown } = await api(`/api/note?path=${encodeURIComponent(path)}`);
      noteCache.set(path, renderMarkdown(markdown));
    } catch (err) {
      noteCache.set(path, `<p>couldn't load this note (${escapeText(err.message)})</p>`);
    }
  }
  el.querySelector(".body").innerHTML = noteCache.get(path);
  el.classList.add("open");
  raise(card);
}

function onTap(card) {
  if (card.kind === "launcher") openLauncher(card);
  else if (card.kind === "folder") openFolder(card);
  else if (card.kind === "note") toggleNote(card);
}

function clearBoard() {
  for (const card of cards.values()) if (card !== launcher) removeCard(card);
  launcher.el.classList.remove("expanded");
}

// ---------------------------------------------------------------- mouse fallback

addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse") return;
  updatePointer("mouse", e.clientX, e.clientY, (e.buttons & 1) === 1, performance.now(), false);
});
addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  e.preventDefault();
  updatePointer("mouse", e.clientX, e.clientY, true, performance.now(), false);
});
addEventListener("pointerup", (e) => {
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  updatePointer("mouse", e.clientX, e.clientY, false, performance.now(), false);
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
  if (e.key === "Escape" || e.key === "c") clearBoard();
});

// ---------------------------------------------------------------- hand tracking

let landmarker = null;
let lastVideoTime = -1;

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

function trackHands(now) {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
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
    const was = pointers.get(id)?.pinching ?? false;
    const pinching = was ? ratio < PINCH_OFF : ratio < PINCH_ON;

    const c = toScreen({ x: (lms[4].x + lms[8].x) / 2, y: (lms[4].y + lms[8].y) / 2 });
    updatePointer(id, c.x, c.y, pinching, now);
  });

  for (const p of [...pointers.values()]) {
    if (p.id !== "mouse" && now - p.seen > LOST_MS) dropPointer(p, now);
  }
  const hands = [...pointers.keys()].filter((k) => k !== "mouse").length;
  statusEl.textContent = hands ? `${hands} hand${hands > 1 ? "s" : ""}` : "show a hand";
  if (DEBUG) drawDebug(result.landmarks);
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

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    statusEl.textContent = "no camera: mouse mode (click = pinch)";
    throw err;
  }
}

async function startTracker() {
  statusEl.textContent = "loading hand tracking…";
  const { FilesetResolver, HandLandmarker } = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
  landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 2,
  });
  statusEl.textContent = "show a hand";
}

// ---------------------------------------------------------------- main loop

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  trackHands(now);
  stepCards(dt);
  requestAnimationFrame(frame);
}

async function main() {
  api("/api/config")
    .then(({ name }) => {
      document.getElementById("hud-name").textContent = name;
      document.title = name;
    })
    .catch(() => {});
  placeLauncher();
  requestAnimationFrame(frame);
  try {
    await startCamera();
    await startTracker();
  } catch (err) {
    console.warn("handmedown: hand tracking unavailable", err);
    if (video.srcObject) statusEl.textContent = "hand tracking failed to load: mouse mode";
  }
}

main();
