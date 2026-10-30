// Look to choose: estimate where on screen you're looking, from the webcam.
//
// Two modes, both built on MediaPipe's face landmarker:
//   head  where your nose points. Steady; a one-second "look at the centre"
//         sets your neutral pose.
//   eyes  where your irises point, plus head pose. A nine-dot calibration fits
//         a per-person mapping; accurate to a few centimetres at best, so the
//         board uses it to pick the nearest card, not to aim a cursor.
//
// In either mode a deliberate double blink (both eyes, twice, quickly) fires
// onDoubleBlink: the board taps whatever card you're looking at. While your
// eyes are closing the look point freezes, so a blink can't move the choice.

const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// Head mode: screen fraction moved per unit of nose offset (offset is measured
// in inter-eye distances, so it doesn't depend on how far you sit).
const HEAD_GAIN_X = 1.8;
const HEAD_GAIN_Y = 3.2;

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

// Ridge least squares on standardised features: returns a predictor.
function fitLinear(rows, targets) {
  const k = rows[0].length;
  const mean = Array(k).fill(0), std = Array(k).fill(0);
  for (const r of rows) r.forEach((v, j) => (mean[j] += v / rows.length));
  for (const r of rows) r.forEach((v, j) => (std[j] += (v - mean[j]) ** 2 / rows.length));
  for (let j = 0; j < k; j++) std[j] = Math.sqrt(std[j]) || 1;

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
    this.models = { head: load("head"), eyes: load("eyes") };

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
    this.fx = new this.Filter(mode === "eyes" ? 0.35 : 0.9, mode === "eyes" ? 0.002 : 0.004);
    this.fy = new this.Filter(mode === "eyes" ? 0.35 : 0.9, mode === "eyes" ? 0.002 : 0.004);
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
    if (this.models[mode]) this.say(`look: ${mode} (k to recalibrate)`);
    else this.calibrate();
  }

  calibrate() {
    if (!this.active) return;
    const spots = this.mode === "eyes"
      ? [0.1, 0.5, 0.9].flatMap((y) => [0.1, 0.5, 0.9].map((x) => ({ x, y })))
      : [{ x: 0.5, y: 0.5 }];
    // Visit the eye dots in a snake so the eyes never jump across the screen.
    if (spots.length === 9) [spots[3], spots[5]] = [spots[5], spots[3]];
    this.calib = { spots, index: 0, start: null, samples: [] };
    this.overlay.hidden = false;
    this.hintEl.textContent = this.mode === "eyes"
      ? "Keep your head still and follow the dot with your eyes"
      : "Point your nose at the dot";
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
    if (this.mode === "head") {
      const n = c.samples.length;
      this.models.head = {
        nx: c.samples.reduce((s, x) => s + x.f.nx, 0) / n,
        ny: c.samples.reduce((s, x) => s + x.f.ny, 0) / n,
      };
    } else {
      this.models.eyes = fitLinear(
        c.samples.map((s) => eyeVector(s.f)),
        c.samples.map((s) => [s.spot.x, s.spot.y]),
      );
    }
    save(this.mode, this.models[this.mode]);
    this.say(`look: ${this.mode} calibrated`);
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

    let frac;
    if (this.mode === "head") {
      // Turning to your right moves the nose image-left; the board is mirrored.
      frac = { x: 0.5 - (f.nx - model.nx) * HEAD_GAIN_X, y: 0.5 + (f.ny - model.ny) * HEAD_GAIN_Y };
    } else {
      frac = predict(model, eyeVector(f));
    }
    const x = this.fx.filter(Math.min(1, Math.max(0, frac.x)) * innerWidth, now);
    const y = this.fy.filter(Math.min(1, Math.max(0, frac.y)) * innerHeight, now);
    this.point = { x, y };
    this.marker.hidden = false;
    this.marker.style.transform = `translate(${x}px, ${y}px)`;
    return this.point;
  }

  pause() {
    this.cancelCalibration();
    this.point = null;
    this.marker.hidden = true;
  }

  static savedMode() {
    const m = load("mode");
    return ["off", "head", "eyes"].includes(m) ? m : "off";
  }
}
