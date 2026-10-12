// Following a car with the phone alone: GPS for road speed (about once a
// second, a little late) and the motion sensors for what happens in between.
// The phone can sit in its holder at any angle: which way is forward is
// learned by matching the sensed acceleration to the changes in GPS speed,
// which takes a few pulls away and stops. The pedal is inferred from the
// acceleration the car needs beyond its drag.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

// A typical car of its size: for drag, and for how hard it can pull.
const CAR = { mass: 1450, cda: 0.65, roll: 0.011, power: 100e3 };

export class GpsSource {
  constructor(onSample, onStatus) {
    this.onSample = onSample;
    this.onStatus = onStatus;
    this.g = null; // gravity direction (sensor frame)
    this.lin = [0, 0, 0]; // smoothed acceleration without gravity
    this.mh = []; // recent [t, x, y, z] level accelerations
    this.M = [0, 0, 0]; // forward axis evidence
    this.W = 0;
    this.fwd = null;
    this.v = 0; // fused speed
    this.a = 0; // fused acceleration along the road
    this.aRaw = 0;
    this.bias = 0; // what the sensor reads along the road that isn't the car's acceleration
    this.hist = []; // [t, v] for matching late GPS fixes
    this.fix = null; // last GPS fix {t, v}
    this.dvdt = 0;
    this.lastMotion = 0;
    this.motion = false;
  }

  async start() {
    if (!navigator.geolocation) throw new Error('This browser gives no location.');
    // iPhone: motion data needs a yes from a tap; this runs inside one
    const DM = window.DeviceMotionEvent;
    if (DM && typeof DM.requestPermission === 'function') {
      try {
        this.motion = (await DM.requestPermission()) === 'granted';
      } catch {
        this.motion = false;
      }
    } else this.motion = !!DM;
    this.onMotionBound = (e) => this.onMotion(e);
    if (this.motion) window.addEventListener('devicemotion', this.onMotionBound);
    await new Promise((resolve, reject) => {
      let first = true;
      this.watch = navigator.geolocation.watchPosition(
        (p) => {
          this.onFix(p);
          if (first) {
            first = false;
            resolve();
          }
        },
        (err) => {
          if (first) {
            first = false;
            reject(new Error(err.code === 1 ? 'Location is not allowed for this page.' : 'No GPS fix yet. Try again in the open.'));
          }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );
    });
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 50);
    return { label: 'GPS and motion sensors', detail: this.motion ? 'Learning which way is forward: pull away and brake a few times' : 'No motion sensors: speed from GPS alone' };
  }

  stop() {
    clearInterval(this.timer);
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
    if (this.onMotionBound) window.removeEventListener('devicemotion', this.onMotionBound);
  }

  get calibrated() {
    return !!this.fwd && this.W > 4;
  }

  onMotion(e) {
    const ag = e.accelerationIncludingGravity;
    if (!ag || ag.x == null) return;
    const now = performance.now();
    const dt = this.lastMotion ? Math.min(0.1, (now - this.lastMotion) / 1000) : 0.016;
    this.lastMotion = now;
    const raw = [ag.x, ag.y, ag.z];
    // gravity: the slow average of the reading, less what is known to be the
    // car speeding up or slowing down (else a long pull reads as a tilt);
    // acceleration: what is left, or the sensor's own split when it gives one
    const fused = e.acceleration && e.acceleration.x != null;
    if (!this.g) this.g = raw.slice();
    const kg = Math.min(1, dt / 2);
    const known = this.calibrated && !fused ? scale(this.fwd, this.aRaw - this.bias) : [0, 0, 0];
    this.g = this.g.map((x, i) => x + (raw[i] - known[i] - x) * kg);
    const la = fused ? [e.acceleration.x, e.acceleration.y, e.acceleration.z] : sub(raw, this.g);
    if (this.fwd) this.aRaw = dot(la, this.fwd);
    // level it: drop what points along gravity
    const gu = scale(this.g, 1 / (norm(this.g) || 1));
    const h = sub(la, scale(gu, dot(la, gu)));
    const kl = Math.min(1, dt * 12); // road bumps out, pulls and stops in
    this.lin = this.lin.map((x, i) => x + (h[i] - x) * kl);
    this.mh.push([now, h[0], h[1], h[2]]);
    while (this.mh.length && this.mh[0][0] < now - 6000) this.mh.shift();
  }

  // average level acceleration between two moments
  avgBetween(t0, t1) {
    const s = [0, 0, 0];
    let n = 0;
    for (const m of this.mh) {
      if (m[0] <= t0 || m[0] > t1) continue;
      s[0] += m[1];
      s[1] += m[2];
      s[2] += m[3];
      n++;
    }
    return n > 5 ? scale(s, 1 / n) : null;
  }

  onFix(p) {
    // when the fix was taken (its speed describes then, not now)
    const lag = Date.now() - p.timestamp;
    const t = performance.now() - (lag > 0 && lag < 3000 ? lag : 0);
    let v = p.coords.speed;
    if (v == null || v < 0 || Number.isNaN(v)) {
      // no speed in the fix: from the distance since the last one
      if (this.prevPos) {
        const d = haversine(this.prevPos, p.coords);
        const dt = (t - this.prevPos.t) / 1000;
        v = dt > 0.2 ? d / dt : this.fix?.v ?? 0;
      } else v = 0;
    }
    this.prevPos = { latitude: p.coords.latitude, longitude: p.coords.longitude, t };
    if (this.fix) {
      const dt = (t - this.fix.t) / 1000;
      if (dt > 0.2) {
        const D = (v - this.fix.v) / dt;
        this.dvdt += (D - this.dvdt) * 0.6;
        // what the sensor read over the same stretch as the speed change
        const H = this.avgBetween(this.fix.t, t);
        // its offset along the road (a tilted holder, drift)
        if (H && this.calibrated && Math.abs(D) < 8) this.bias += (dot(H, this.fwd) - D - this.bias) * 0.3;
        // forward axis: the sensed acceleration that tracks GPS speed changes
        if (H && Math.abs(D) > 0.3 && v > 1.5 && Math.abs(D) < 8) {
          this.M = this.M.map((x, i) => x + H[i] * D);
          this.W += D * D;
          const n = norm(this.M);
          if (n > 0) this.fwd = scale(this.M, 1 / n);
          if (this.calibrated && !this.saidCal) {
            this.saidCal = true;
            this.onStatus('Calibrated: following every push of the pedal');
          }
        }
      }
    }
    this.fix = { t, v };
    // pull the fused speed toward GPS, judged at the moment of the fix
    const then = this.speedAt(t);
    this.v = Math.max(0, this.v + (v - then) * (this.calibrated ? 0.6 : 1));
    if (v < 0.4 && (!this.calibrated || Math.abs(this.a) < 0.3)) this.v = 0;
  }

  speedAt(t) {
    const h = this.hist;
    for (let i = h.length - 1; i >= 0; i--) if (h[i][0] <= t) return h[i][1];
    return h.length ? h[0][1] : this.v;
  }

  tick() {
    const now = performance.now();
    const dt = Math.min(0.2, (now - this.last) / 1000);
    this.last = now;
    if (this.calibrated) {
      this.a = dot(this.lin, this.fwd) - this.bias;
      this.v = Math.max(0, this.v + this.a * dt);
    } else if (this.fix) {
      // speed from GPS alone, carried along its trend
      this.a = this.dvdt;
      const ahead = Math.min(1.5, (now - this.fix.t) / 1000);
      this.v = Math.max(0, this.fix.v + this.dvdt * ahead * 0.7);
    }
    this.hist.push([now, this.v]);
    while (this.hist.length && this.hist[0][0] < now - 4000) this.hist.shift();
    // what the driver is asking for: acceleration plus what drag takes
    const v = this.v;
    const res = (0.5 * 1.2 * CAR.cda * v * v) / CAR.mass + (v > 0.3 ? 9.81 * CAR.roll : 0);
    const want = this.a + res;
    const most = Math.min(4.5, CAR.power / (CAR.mass * Math.max(v, 4)));
    let pedal = 0, brake = 0;
    if (want > 0.04) pedal = Math.min(1, Math.pow(want / most, 0.85));
    else if (want < -0.8) brake = Math.min(1, -want / 7);
    this.onSample({ t: now, speed: v, accel: this.a, pedal, brake });
  }
}

function haversine(a, b) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
