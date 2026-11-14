// Look to choose: estimate where on screen you're looking, from the webcam,
// with MediaPipe's face landmarker. Iris position plus head pose, mapped to
// the screen by a nine-dot calibration; accurate to a few centimetres at best,
// so the board uses it to pick the nearest card, not to aim a cursor.
//
// A deliberate double blink (both eyes, twice, quickly) fires
// onDoubleBlink: the board taps whatever card you're looking at. While your
// eyes are closing the look point freezes, so a blink can't move the choice.

const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const DOT_MS = 1300;     // each calibration dot is shown this long...
const SETTLE_MS = 450;   // ...and samples start once your eyes have landed on it
const RIDGE = 0.01;

// Blink detection uses MediaPipe's eyeBlink blendshapes (0 open .. 1 shut).
// Looking down droops the lids to ~0.4, so "closed" needs well above that.
const BLINK_CLOSED = 0.6;
const BLINK_OPEN = 0.35;
const BLINK_MAX_MS = 450;    // shut longer than this isn't a blink, it's resting
const DOUBLE_GAP_MS = 650;   // second blink must start within this of the first ending
const SETTLE_AFTER_MS = 150; // irises need a moment to read true after opening

const STORE = "handmedown.look";

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function load(key) {
  try { return JSON.parse(localStorage.getItem(`${STORE}.${key}`)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(`${STORE}.${key}`, JSON.stringify(value)); } catch { /* private window */ }
}

// Pose features from one frame of face landmarks, all in units that don't
// depend on distance from the camera.
function features(lms, vw, vh) {
  const P = (i) => ({ x: lms[i].x * vw, y: lms[i].y * vh });
  const outerA = P(33), innerA = P(133), innerB = P(362), outerB = P(263);
  const span = Math.max(dist(outerA, outerB), 1);
  const centre = mid(outerA, outerB);
  const nose = P(1);

  // Each iris relative to its own eye, in eye widths. Pair irises to eyes by
  // proximity rather than trusting landmark order.
  const eyes = [
    { c: mid(outerA, innerA), w: Math.max(dist(outerA, innerA), 1) },
    { c: mid(innerB, outerB), w: Math.max(dist(innerB, outerB), 1) },
  ];
  let [i1, i2] = [P(468), P(473)];
  if (dist(i1, eyes[0].c) > dist(i2, eyes[0].c)) [i1, i2] = [i2, i1];
  const gx = ((i1.x - eyes[0].c.x) / eyes[0].w + (i2.x - eyes[1].c.x) / eyes[1].w) / 2;
  const gy = ((i1.y - eyes[0].c.y) / eyes[0].w + (i2.y - eyes[1].c.y) / eyes[1].w) / 2;

  return {
    nx: (nose.x - centre.x) / span,
    ny: (nose.y - centre.y) / span,
    gx, gy,
    fx: centre.x / vw,
    fy: centre.y / vh,
  };
}

const eyeVector = (f) => [f.gx, f.gy, f.nx, f.ny, f.fx, f.fy];

// Smallest spread each eyeVector feature is scaled by when fitting. Calibration
// asks you to hold your head still, so the head features barely vary; scaling
// them by that tiny spread would turn landmark noise into huge inputs and fling
// the estimate around at the slightest head movement. With these floors, a
// feature that didn't vary during calibration just gets ~no weight.
const MIN_SPREAD = [0.01, 0.01, 0.03, 0.03, 0.03, 0.03];

// Ridge least squares on standardised features: returns a predictor.
function fitLinear(rows, targets, minSpread = []) {
  const k = rows[0].length;
  const mean = Array(k).fill(0), std = Array(k).fill(0);
  for (const r of rows) r.forEach((v, j) => (mean[j] += v / rows.length));
  for (const r of rows) r.forEach((v, j) => (std[j] += (v - mean[j]) ** 2 / rows.length));
  for (let j = 0; j < k; j++) std[j] = Math.max(Math.sqrt(std[j]), minSpread[j] ?? 0) || 1;

  const X = rows.map((r) => [1, ...r.map((v, j) => (v - mean[j]) / std[j])]);
  const n = k + 1;
  const solve = (b) => {
    // (XᵀX + λI) w = Xᵀb, by Gaussian elimination with partial pivoting.
    const A = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => {
        if (j === n) return X.reduce((s, x, r) => s + x[i] * b[r], 0);
        return X.reduce((s, x) => s + x[i] * x[j], 0) + (i === j && i > 0 ? RIDGE * X.length : 0);
      }));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = 0; r < n; r++) {
        if (r === c || !A[c][c]) continue;
        const f = A[r][c] / A[c][c];
        for (let j = c; j <= n; j++) A[r][j] -= f * A[c][j];
      }
    }
    return A.map((row, i) => row[n] / (row[i] || 1));
  };
  return { mean, std, wx: solve(targets.map((t) => t[0])), wy: solve(targets.map((t) => t[1])) };
}

function predict(model, vec) {
  const z = [1, ...vec.map((v, j) => (v - model.mean[j]) / model.std[j])];
  const dot = (w) => w.reduce((s, wi, i) => s + wi * z[i], 0);
  return { x: dot(model.wx), y: dot(model.wy) };
}

export class Look {
  constructor({ loadVision, video, say, Filter, onDoubleBlink }) {
    Object.assign(this, { loadVision, video, say, Filter, onDoubleBlink });
    this.blink = { closed: false, closedAt: 0, openedAt: -Infinity, firstEnd: 0 };
    this.blinkScore = 0;
    this.mode = "off";
    this.face = null;
    this.calib = null;       // calibration in progress
    this.point = null;       // latest estimate, screen px (fractions × screen size)
    this.fx = null;
    this.fy = null;
    // Calibration is per session: it goes stale as soon as you or the laptop
    // move, so every start of a look mode calibrates first. Only the mode is saved.
    this.models = { eyes: null };
    try {
      localStorage.removeItem(`${STORE}.head`);
      localStorage.removeItem(`${STORE}.eyes`);
    } catch { /* private window */ }

    this.overlay = document.createElement("div");
    this.overlay.id = "calib";
    this.overlay.hidden = true;
    this.overlay.innerHTML = '<div class="dot"></div><div class="hint"></div>';
    document.body.appendChild(this.overlay);
    this.dotEl = this.overlay.querySelector(".dot");
    this.hintEl = this.overlay.querySelector(".hint");

    this.marker = document.createElement("div");
    this.marker.id = "look-marker";
    this.marker.hidden = true;
    document.body.appendChild(this.marker);
  }

  get active() { return this.mode !== "off"; }

  async setMode(mode) {
    this.mode = mode;
    save("mode", mode);
    this.cancelCalibration();
    this.point = null;
    this.marker.hidden = true;
    if (mode === "off") return this.say("look: off");
    this.fx = new this.Filter(0.35, 0.002);
    this.fy = new this.Filter(0.35, 0.002);
    if (!this.face) {
      this.say("loading face tracking…");
      const { mod, fileset } = await this.loadVision();
      this.face = await mod.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
    }
    if (this.mode !== mode) return; // switched again while loading
    this.models[mode] = null;
    this.calibrate();
  }

  calibrate() {
    if (!this.active) return;
    const spots = [0.1, 0.5, 0.9].flatMap((y) => [0.1, 0.5, 0.9].map((x) => ({ x, y })));
    // Visit the dots in a snake so the eyes never jump across the screen.
    [spots[3], spots[5]] = [spots[5], spots[3]];
    this.calib = { spots, index: 0, start: null, samples: [] };
    this.overlay.hidden = false;
    this.hintEl.textContent = "Keep your head still and follow the dot with your eyes";
    this.placeDot();
  }

  cancelCalibration() {
    this.calib = null;
    this.overlay.hidden = true;
  }

  placeDot() {
    const s = this.calib.spots[this.calib.index];
    this.dotEl.style.left = `${s.x * 100}%`;
    this.dotEl.style.top = `${s.y * 100}%`;
    this.dotEl.classList.remove("go");
    void this.dotEl.offsetWidth; // restart the shrink animation
    this.dotEl.classList.add("go");
  }

  stepCalibration(f, now) {
    const c = this.calib;
    c.start ??= now;
    const t = now - c.start;
    if (f && t > SETTLE_MS) c.samples.push({ f, spot: c.spots[c.index] });
    if (t < DOT_MS) return;
    c.index++;
    c.start = now;
    if (c.index < c.spots.length) return this.placeDot();

    this.cancelCalibration();
    if (c.samples.length < c.spots.length * 5) {
      return this.say("calibration lost your face: press k to try again");
    }
    // Fit, drop the worst-fitting fifth of samples (glare on glasses, a glance
    // away), and fit again on the rest.
    const fit = (samples) => fitLinear(
      samples.map((s) => eyeVector(s.f)),
      samples.map((s) => [s.spot.x, s.spot.y]),
      MIN_SPREAD,
    );
    const first = fit(c.samples);
    const err = (s) => {
      const p = predict(first, eyeVector(s.f));
      return Math.hypot(p.x - s.spot.x, p.y - s.spot.y);
    };
    const kept = [...c.samples].sort((a, b) => err(a) - err(b)).slice(0, Math.ceil(c.samples.length * 0.8));
    this.models[this.mode] = fit(kept);
    this.say(`look: ${this.mode} calibrated (k to redo)`);
  }

  // Track both eyelids; a short closure is a blink, two in a row a double blink.
  stepBlink(shapes, now) {
    const score = (name) => shapes?.find((c) => c.categoryName === name)?.score ?? 0;
    // Both eyes must close: a wink or one droopy lid doesn't count.
    this.blinkScore = Math.min(score("eyeBlinkLeft"), score("eyeBlinkRight"));
    const b = this.blink;
    if (!b.closed && this.blinkScore > BLINK_CLOSED) {
      b.closed = true;
      b.closedAt = now;
    } else if (b.closed && this.blinkScore < BLINK_OPEN) {
      b.closed = false;
      b.openedAt = now;
      if (now - b.closedAt > BLINK_MAX_MS) {
        b.firstEnd = 0;
      } else if (b.firstEnd && b.closedAt - b.firstEnd < DOUBLE_GAP_MS) {
        b.firstEnd = 0;
        this.onDoubleBlink?.();
      } else {
        b.firstEnd = now;
      }
    }
  }

  // Eyes shut or just reopened: iris positions can't be trusted.
  eyesBusy(now) {
    return this.blink.closed || this.blinkScore > BLINK_OPEN || now - this.blink.openedAt < SETTLE_AFTER_MS;
  }

  // Call once per new camera frame. Returns the smoothed look point or null.
  update(now) {
    if (!this.face || !this.active || this.video.readyState < 2) return (this.point = null);
    const result = this.face.detectForVideo(this.video, now);
    const lms = result.faceLandmarks?.[0];
    const f = lms && lms.length > 473 ? features(lms, this.video.videoWidth, this.video.videoHeight) : null;
    if (f) this.stepBlink(result.faceBlendshapes?.[0]?.categories, now);
    this.features = f;
    const busy = this.eyesBusy(now);

    if (this.calib) {
      this.stepCalibration(busy ? null : f, now);
      return (this.point = null);
    }
    // Freeze the point through a blink so the choice it acts on holds still.
    if (f && busy && this.point) return this.point;
    const model = this.models[this.mode];
    if (!f || !model) {
      this.marker.hidden = true;
      return (this.point = null);
    }

    const frac = predict(model, eyeVector(f));
    const x = this.fx.filter(Math.min(1, Math.max(0, frac.x)) * innerWidth, now);
    const y = this.fy.filter(Math.min(1, Math.max(0, frac.y)) * innerHeight, now);
    this.point = { x, y };
    this.marker.hidden = false;
    this.marker.style.transform = `translate(${x}px, ${y}px)`;
    return this.point;
  }

  // One line for ?debug=1: what the face tracker is reading right now.
  debugText() {
    const f = this.features;
    if (!f) return `look ${this.mode}: no face`;
    const pt = this.point ? ` → ${Math.round(this.point.x)},${Math.round(this.point.y)}` : "";
    return `look ${this.mode}: nose ${f.nx.toFixed(2)},${f.ny.toFixed(2)} iris ${f.gx.toFixed(2)},${f.gy.toFixed(2)}` +
      ` blink ${this.blinkScore.toFixed(2)}${this.calib ? " (calibrating)" : this.models[this.mode] ? "" : " (not calibrated)"}${pt}`;
  }

  pause() {
    this.cancelCalibration();
    this.point = null;
    this.marker.hidden = true;
  }

  static savedMode() {
    const m = load("mode");
    return m === "eyes" ? m : "off";
  }
}
