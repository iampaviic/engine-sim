// 3D engine: crankshaft, rods, pistons and valves (rotors on a Wankel)
// moving with the simulation, each cylinder lit by its own combustion.
// Piston motion comes from each cylinder's crank angle in the simulation,
// so the crank throws, split pins and bank angles fall out of the same
// firing data as the sound. three.js is loaded the first time it is shown.

let THREE = null;

export async function createView3D(canvas) {
  THREE ??= await import('../vendor/three.min.js');
  return new View3D(canvas);
}

const S = 0.01; // scene units per mm
const UP = () => new THREE.Vector3(0, 1, 0);

// Bank angle between the two banks of a vee (degrees).
function bankAngle(spec) {
  if (spec.design?.bankAngle) return spec.design.bankAngle;
  if (/^F/.test(spec.family ?? '')) return 180;
  const m = /(\d+)°/.exec(spec.tagline ?? '');
  if (m) return +m[1];
  const n = spec.cylinders;
  return spec.family === 'W16' ? 90 : n === 12 || n === 6 ? 60 : n === 10 ? 72 : n === 2 ? 45 : 90;
}

class View3D {
  constructor(canvas) {
    this.c = canvas;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    this.r = r;
    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
    pm.dispose();
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x2a2420, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(-3, 5, 4);
    this.scene.add(key);
    this.cam = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
    this.az = -0.75; // orbit: azimuth and elevation (radians), distance
    this.el = 0.42;
    this.zoomK = 1; // the user's zoom against the framing distance
    this.Rb = 1; // radius that has to stay in view
    this.root = null;
    this.burn = [];
    this.heat = [];
    this.bindOrbit();
    this.mats = {
      crank: new THREE.MeshStandardMaterial({ color: 0x6f747b, metalness: 0.9, roughness: 0.32 }),
      rod: new THREE.MeshStandardMaterial({ color: 0xa3a9b0, metalness: 0.92, roughness: 0.26 }),
      piston: new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 0.65, roughness: 0.38 }),
      ring: new THREE.MeshStandardMaterial({ color: 0x3c3f44, metalness: 0.8, roughness: 0.4 }),
      vIn: new THREE.MeshStandardMaterial({ color: 0x9cc6e6, metalness: 0.85, roughness: 0.3 }),
      vEx: new THREE.MeshStandardMaterial({ color: 0xc9915f, metalness: 0.85, roughness: 0.35 }),
      housing: new THREE.MeshStandardMaterial({ color: 0x8c939b, metalness: 0.3, roughness: 0.5, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
    };
  }

  // Drag to orbit, wheel or pinch to zoom, double-click to reset.
  bindOrbit() {
    const c = this.c;
    const pts = new Map();
    let pinch = 0;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      this.touched = true;
    });
    c.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d0 = Math.hypot(a[0] - b[0], a[1] - b[1]);
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        const [a2, b2] = [...pts.values()];
        const d1 = Math.hypot(a2[0] - b2[0], a2[1] - b2[1]);
        if (pinch && d0 > 0) this.zoom(d0 / d1);
        pinch = 1;
        return;
      }
      this.az -= (e.clientX - p[0]) * 0.008;
      this.el = Math.max(-1.2, Math.min(1.4, this.el + (e.clientY - p[1]) * 0.006));
      pts.set(e.pointerId, [e.clientX, e.clientY]);
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      pinch = 0;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(e.deltaY * 0.0012));
      },
      { passive: false }
    );
    c.addEventListener('dblclick', () => {
      this.az = this.az0 ?? -0.75;
      this.el = 0.42;
      this.zoomK = 1;
    });
  }

  zoom(k) {
    this.zoomK = Math.max(0.35, Math.min(2.5, this.zoomK * k));
  }

  // Build the moving parts for a compiled engine and its spec.
  setEngine(cfg, spec) {
    if (this.root) {
      this.scene.remove(this.root);
      this.root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && !Object.values(this.mats).includes(o.material)) o.material.dispose();
      });
    }
    this.cfg = cfg;
    this.spec = spec;
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.burn = new Float32Array(cfg.nCyl);
    this.heat = new Float32Array(cfg.nCyl);
    this.port = new Float32Array(cfg.nCyl * 2);
    if (cfg.kind === 'rotary') this.buildRotary(cfg, spec);
    else this.buildPiston(cfg, spec);
    this.az = this.az0 ?? -0.75;
    this.zoomK = 1;
  }

  buildPiston(cfg, spec) {
    const n = cfg.nCyl;
    const B = spec.bore, St = spec.stroke, L = spec.rod ?? spec.stroke * 1.65;
    const r = (St / 2) * S, l = L * S, b = B * S;
    this.r0 = r;
    this.l0 = l;
    const banks = spec.banks ?? [spec.firingOrder.slice().sort((x, y) => x - y)];
    const nb = banks.length;
    const ang = nb > 1 ? bankAngle(spec) : 0;
    const pitch = b * 1.18;
    const rodW = b * 0.24;
    const two = cfg.kind === 'twostroke';
    // per cylinder: axial position, bank axis angle (from vertical) and the
    // pin angle at crank zero, from its firing offset
    const cyl = [];
    banks.forEach((bank, bi) => {
      const sorted = bank.slice().sort((x, y) => x - y);
      sorted.forEach((cn, k) => {
        let beta = nb === 1 ? 0 : (bi === 0 ? -ang / 2 : ang / 2);
        // a W16 is two narrow vees: alternate cylinders lean out of each bank
        if (spec.family === 'W16') beta += (k % 2 ? 7.5 : -7.5) * (bi === 0 ? 1 : -1);
        const x = (k - (sorted.length - 1) / 2) * pitch + (nb > 1 ? (bi === 0 ? -1 : 1) * rodW * 0.6 : 0);
        cyl[cn - 1] = { x, beta: (beta * Math.PI) / 180, k };
      });
    });
    for (let c = 0; c < n; c++) {
      const o = cyl[c];
      o.psi0 = o.beta + (cfg.cylOffset[c] * Math.PI) / 180;
      o.dir = new THREE.Vector3(0, Math.cos(o.beta), Math.sin(o.beta));
      o.side = new THREE.Vector3(0, -Math.sin(o.beta), Math.cos(o.beta));
    }
    this.cyl = cyl;

    // crankshaft: main journals, a pair of webs and a pin per cylinder
    const crank = new THREE.Group();
    this.crank = crank;
    this.root.add(crank);
    const mats = this.mats;
    const xs = cyl.map((o) => o.x);
    const x0 = Math.min(...xs) - pitch * 0.55, x1 = Math.max(...xs) + pitch * 0.55;
    const mainR = b * 0.28;
    const main = new THREE.Mesh(new THREE.CylinderGeometry(mainR, mainR, x1 - x0, 24), mats.crank);
    main.rotation.z = Math.PI / 2;
    main.position.x = (x0 + x1) / 2;
    crank.add(main);
    const pinR = b * 0.24;
    const webT = b * 0.12;
    const webGeo = new THREE.BoxGeometry(webT, r + mainR + pinR * 0.6, b * 0.62);
    // counterweights: half discs opposite each pin
    const cwGeo = new THREE.CylinderGeometry(r * 1.25, r * 1.25, webT, 28, 1, false, Math.PI, Math.PI);
    for (const o of cyl) {
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(pinR, pinR, rodW * 1.15, 18), mats.crank);
      pin.rotation.z = Math.PI / 2;
      const py = r * Math.cos(o.psi0), pz = r * Math.sin(o.psi0);
      pin.position.set(o.x, py, pz);
      crank.add(pin);
      for (const s of [-1, 1]) {
        const wx = o.x + s * (rodW * 0.58 + webT / 2);
        const web = new THREE.Mesh(webGeo, mats.crank);
        web.position.set(wx, py / 2, pz / 2);
        web.rotation.x = o.psi0;
        crank.add(web);
        const cw = new THREE.Mesh(cwGeo, mats.crank);
        cw.rotation.z = Math.PI / 2;
        cw.rotation.x = o.psi0;
        cw.position.set(wx, 0, 0);
        crank.add(cw);
      }
    }

    // rods, pistons, bores, valves (ports on a two-stroke) and the glow
    const comp = b * 0.42; // piston compression height
    const deck = r + l + comp + b * 0.03;
    this.deck = deck;
    this.comp = comp;
    const pistonGeo = new THREE.CylinderGeometry(b / 2, b / 2, b * 0.62, 32);
    const ringGeo = new THREE.CylinderGeometry(b / 2 + 0.0015, b / 2 + 0.0015, b * 0.05, 32, 1, true);
    const rodGeo = new THREE.CylinderGeometry(rodW * 0.32, rodW * 0.42, 1, 12);
    const bigEnd = new THREE.CylinderGeometry(pinR * 1.45, pinR * 1.45, rodW, 18);
    const boreLen = deck - (l - r - b * 0.3);
    const boreGeo = new THREE.CylinderGeometry(b / 2 + 0.004, b / 2 + 0.004, boreLen, 36, 1, true);
    const glowGeo = new THREE.CircleGeometry(b * 0.48, 32);
    const nv = two ? 0 : (spec.valves?.inCount ?? 1) + (spec.valves?.exCount ?? 1) > 2 ? 2 : 1;
    const vR = b * (nv === 2 ? 0.15 : 0.21);
    const valveGeo = new THREE.CylinderGeometry(vR, vR * 0.5, b * 0.06, 20);
    const stemGeo = new THREE.CylinderGeometry(b * 0.025, b * 0.025, b * 0.42, 8);
    for (const o of cyl) {
      o.rod = new THREE.Group();
      const shank = new THREE.Mesh(rodGeo, mats.rod);
      o.shank = shank;
      o.rod.add(shank);
      o.big = new THREE.Mesh(bigEnd, mats.rod);
      o.big.rotation.z = Math.PI / 2;
      o.rod.add(o.big);
      this.root.add(o.rod);
      o.piston = new THREE.Group();
      const crown = new THREE.Mesh(pistonGeo, mats.piston);
      crown.position.y = comp - b * 0.31;
      o.piston.add(crown);
      for (let k = 0; k < 2; k++) {
        const ring = new THREE.Mesh(ringGeo, mats.ring);
        ring.position.y = comp - b * (0.08 + 0.09 * k);
        o.piston.add(ring);
      }
      o.piston.quaternion.setFromUnitVectors(UP(), o.dir);
      this.root.add(o.piston);
      // the bore glows with the burn inside it
      const bm = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, metalness: 0.1, roughness: 0.25, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide, emissive: 0xff7a1a, emissiveIntensity: 0 });
      o.boreMat = bm;
      const bore = new THREE.Mesh(boreGeo, bm);
      bore.quaternion.setFromUnitVectors(UP(), o.dir);
      bore.position.set(o.x, 0, 0).addScaledVector(o.dir, deck - boreLen / 2);
      this.root.add(bore);
      const gm = new THREE.MeshBasicMaterial({ color: 0xffb04a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      o.glowMat = gm;
      o.glow = new THREE.Mesh(glowGeo, gm);
      o.glow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), o.dir);
      this.root.add(o.glow);
      // valves: intake on one side of the head, exhaust on the other
      o.valves = [];
      for (const [side, mat, which] of [[-1, mats.vIn, 1], [1, mats.vEx, 0]]) {
        for (let k = 0; k < nv; k++) {
          const v = new THREE.Group();
          v.add(new THREE.Mesh(valveGeo, mat));
          const stem = new THREE.Mesh(stemGeo, mat);
          stem.position.y = b * 0.24;
          v.add(stem);
          v.quaternion.setFromUnitVectors(UP(), o.dir);
          const base = new THREE.Vector3(o.x + (nv === 2 ? (k ? 1 : -1) * b * 0.2 : 0), 0, 0).addScaledVector(o.dir, deck + b * 0.02).addScaledVector(o.side, side * b * 0.22);
          o.valves.push({ g: v, base, which });
          this.root.add(v);
        }
      }
    }
    // a see-through head on each bank (a plug in it on a two-stroke)
    const headMat = new THREE.MeshStandardMaterial({ color: 0x7d848c, metalness: 0.6, roughness: 0.45, transparent: true, opacity: 0.16, depthWrite: false });
    banks.forEach((bank) => {
      const os = bank.map((cn) => cyl[cn - 1]);
      const xa = Math.min(...os.map((o) => o.x)), xb = Math.max(...os.map((o) => o.x));
      const beta = os.reduce((q, o) => q + o.beta, 0) / os.length;
      const dir = new THREE.Vector3(0, Math.cos(beta), Math.sin(beta));
      const h = b * (two ? 0.34 : 0.56);
      const head = new THREE.Mesh(new THREE.BoxGeometry(xb - xa + b * 1.2, h, b * (spec.family === 'W16' ? 1.7 : 1.25)), headMat);
      head.quaternion.setFromUnitVectors(UP(), dir);
      head.position.set((xa + xb) / 2, 0, 0).addScaledVector(dir, deck + h / 2);
      this.root.add(head);
      if (two)
        for (const o of os) {
          const plug = new THREE.Mesh(new THREE.CylinderGeometry(b * 0.06, b * 0.08, b * 0.32, 12), mats.vEx);
          plug.quaternion.setFromUnitVectors(UP(), o.dir);
          plug.position.set(o.x, 0, 0).addScaledVector(o.dir, deck + h + b * 0.1);
          this.root.add(plug);
        }
    });
    // two-stroke ports: windows in the bore wall that light up while open,
    // exhaust (orange) on one side, transfers (blue) round the others
    if (two) {
      const p = spec.ports;
      const drop = (deg) => {
        const a = (deg * Math.PI) / 180, sa = Math.sin(a);
        return r * (1 - Math.cos(a)) + l - Math.sqrt(l * l - r * r * sa * sa);
      };
      const crownTdc = r + l + comp;
      const win = (open, w, side, color) => {
        const top = crownTdc - drop(open), bot = crownTdc - 2 * r - b * 0.02;
        const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
        const g = new THREE.Mesh(new THREE.PlaneGeometry(w * S, top - bot), m);
        return { g, m, mid: (top + bot) / 2, side };
      };
      for (const o of cyl) {
        o.ports = [win(p.ex.open, Math.min(p.ex.width * 0.7, B * 0.7), 1, 0xff8a3a), win(p.transfer.open, p.transfer.width * 0.3, -1, 0x58aee0)];
        for (const q of o.ports) {
          q.g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), o.side.clone().multiplyScalar(q.side));
          q.g.position.set(o.x, 0, 0).addScaledVector(o.dir, q.mid).addScaledVector(o.side, (q.side * b) / 2 + q.side * 0.006);
          this.root.add(q.g);
        }
      }
    }
    let mi = 1e-9, me = 1e-9;
    for (let i = 0; i < cfg.inTab.length; i++) {
      if (cfg.inTab[i] > mi) mi = cfg.inTab[i];
      if (cfg.exTab[i] > me) me = cfg.exTab[i];
    }
    this.maxIn = mi;
    this.maxEx = me;
    this.vLift = b * 0.11;
    // frame it: from the counterweights to the heads, and end to end
    const half = ((ang / 2) * Math.PI) / 180;
    const up = nb > 1 ? Math.cos(half) : 1;
    const top = (deck + b * 0.6) * up, bottom = -1.3 * r;
    const across = nb > 1 ? 2 * (deck + b * 0.6) * Math.sin(half) : b * 1.3;
    const Rb = Math.max((x1 - x0) / 2, (top - bottom) / 2, across / 2) + b * 0.2;
    this.Rb = Rb;
    this.center = new THREE.Vector3(0, (top + bottom) / 2, 0);
    this.az0 = -0.75;
  }

  // A Wankel: each rotor turns at a third of the eccentric shaft speed
  // around an eccentric, inside its epitrochoid housing.
  buildRotary(cfg, spec) {
    const nr = cfg.nCyl / 3;
    const Rg = 105 * S; // generating radius, as on a 1.3 L two-rotor
    const e = Rg * 0.143; // eccentricity
    const w = 0.5 * Rg; // drawn slimmer than life so the rotors read
    this.rotors = [];
    const tri = new THREE.Shape();
    for (let k = 0; k <= 3 * 24; k++) {
      // flanks: arcs bulging outward between the three apexes
      const seg = Math.floor(k / 24), t = (k % 24) / 24;
      const a0 = (seg * 2 * Math.PI) / 3 + Math.PI / 2, a1 = a0 + (2 * Math.PI) / 3;
      const p0 = [Rg * Math.cos(a0), Rg * Math.sin(a0)], p1 = [Rg * Math.cos(a1), Rg * Math.sin(a1)];
      const mid = (a0 + a1) / 2;
      const bulge = Rg * 0.18 * Math.sin(Math.PI * t);
      const x = p0[0] + (p1[0] - p0[0]) * t + Math.cos(mid) * bulge;
      const y = p0[1] + (p1[1] - p0[1]) * t + Math.sin(mid) * bulge;
      if (k === 0) tri.moveTo(x, y);
      else tri.lineTo(x, y);
    }
    const rotorGeo = new THREE.ExtrudeGeometry(tri, { depth: w, bevelEnabled: true, bevelSize: Rg * 0.02, bevelThickness: Rg * 0.02, bevelSegments: 2, curveSegments: 4 });
    rotorGeo.translate(0, 0, -w / 2);
    const rotorEdges = new THREE.EdgesGeometry(rotorGeo, 25);
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x3a3d42 });
    // the housing: an epitrochoid traced by the apexes, drawn at both faces
    const seg = [];
    const at = (t, x) => new THREE.Vector3(x, e * Math.cos(3 * t) + Rg * 1.01 * Math.cos(t), e * Math.sin(3 * t) + Rg * 1.01 * Math.sin(t));
    for (const x of [-w * 0.52, w * 0.52])
      for (let k = 0; k < 96; k++) seg.push(at((k / 96) * 2 * Math.PI, x), at(((k + 1) / 96) * 2 * Math.PI, x));
    const housingGeo = new THREE.BufferGeometry().setFromPoints(seg);
    const housingMat = new THREE.LineBasicMaterial({ color: 0x8a8174, transparent: true, opacity: 0.6 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(Rg * 0.16, Rg * 0.16, nr * w * 1.5 + w, 24), this.mats.crank);
    shaft.rotation.z = Math.PI / 2;
    this.root.add(shaft);
    for (let i = 0; i < nr; i++) {
      const x = (i - (nr - 1) / 2) * w * 1.5;
      const g = new THREE.Group();
      const m = new THREE.MeshStandardMaterial({ color: 0x9da3aa, metalness: 0.8, roughness: 0.33, emissive: 0xff6a12, emissiveIntensity: 0 });
      const rotor = new THREE.Mesh(rotorGeo, m);
      rotor.rotation.y = Math.PI / 2; // extrusion along the shaft (x)
      g.add(rotor);
      const edge = new THREE.LineSegments(rotorEdges, edgeMat);
      edge.rotation.y = Math.PI / 2;
      g.add(edge);
      this.root.add(g);
      const line = new THREE.LineSegments(housingGeo, housingMat);
      line.position.x = x;
      this.root.add(line);
      this.rotors.push({ g, mat: m, x, faces: [i * 3, i * 3 + 1, i * 3 + 2] });
    }
    this.ecc = e;
    this.Rb = Math.max(nr * w * 1.5 + w, Rg * 2.6) * 0.62;
    this.center = new THREE.Vector3(0, 0, 0);
    this.az0 = -1.32; // nearly face-on, to see the rotors orbit
  }

  onSnap(data) {
    const n = this.cfg?.nCyl ?? 0;
    for (let c = 0; c < n; c++) {
      const bar = data[8 + c * 4];
      const burn = data[8 + c * 4 + 3];
      this.heat[c] = Math.min(1, Math.log10(Math.max(1, bar)) / 1.8);
      this.burn[c] = burn > 0 ? 1 : this.burn[c] * 0.5;
    }
  }

  resize() {
    const rect = this.c.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.r.setPixelRatio(dpr);
      this.r.setSize(w, h, false);
      this.cam.aspect = w / h;
      this.cam.updateProjectionMatrix();
    }
    return true;
  }

  // crank: crank angle in degrees (0..cycle) as the strobe shows it
  draw(crank) {
    if (!this.root || this.resize() === false) return;
    const cfg = this.cfg;
    const cycle = cfg.cycle;
    const th = ((crank % cycle) + cycle) % cycle;
    if (cfg.kind === 'rotary') this.poseRotary(th);
    else this.posePiston(th);
    // far enough that the engine fits the shorter side of the panel
    const t = Math.tan(((this.cam.fov / 2) * Math.PI) / 180);
    const dist = ((this.Rb * 1.08) / (t * Math.min(1, this.cam.aspect))) * this.zoomK;
    const ce = Math.cos(this.el);
    this.cam.position.set(this.center.x + dist * ce * Math.sin(this.az), this.center.y + dist * Math.sin(this.el), this.center.z + dist * ce * Math.cos(this.az));
    this.cam.lookAt(this.center);
    this.r.render(this.scene, this.cam);
  }

  posePiston(th) {
    const cfg = this.cfg;
    const r = this.r0, l = this.l0;
    const rad = (th * Math.PI) / 180;
    this.crank.rotation.x = rad;
    const tab = cfg.tabN / cfg.cycle;
    const t = (this.tmp ??= { pin: new THREE.Vector3(), pp: new THREE.Vector3(), d: new THREE.Vector3(), x: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), q: new THREE.Quaternion() });
    const { pin, pp, d } = t;
    for (let c = 0; c < this.cyl.length; c++) {
      const o = this.cyl[c];
      const psi = o.psi0 + rad;
      pin.set(o.x, r * Math.cos(psi), r * Math.sin(psi));
      const a = psi - o.beta;
      const sa = Math.sin(a);
      const s = r * Math.cos(a) + Math.sqrt(l * l - r * r * sa * sa);
      pp.set(o.x, 0, 0).addScaledVector(o.dir, s);
      o.piston.position.copy(pp);
      // rod from the crank pin to the gudgeon pin
      d.subVectors(pp, pin);
      const len = d.length();
      o.rod.position.copy(pin);
      o.shank.scale.set(1, len, 1);
      o.shank.position.set(0, len / 2, 0);
      o.rod.quaternion.setFromUnitVectors(t.up, d.normalize());
      t.x.set(1, 0, 0).applyQuaternion(t.q.copy(o.rod.quaternion).invert());
      o.big.quaternion.setFromUnitVectors(t.up, t.x);
      // valves follow the cam tables at this crank angle
      const ca = (th + cfg.cylOffset[c]) % cfg.cycle;
      const i = Math.min(cfg.tabN, Math.round(ca * tab));
      for (const v of o.valves) {
        const lift = v.which ? cfg.inTab[i] / this.maxIn : cfg.exTab[i] / this.maxEx;
        v.g.position.copy(v.base).addScaledVector(o.dir, -lift * this.vLift);
      }
      // combustion glow just above the crown, and the hot gas in the bore
      const burn = this.burn[c], heat = this.heat[c];
      o.glow.position.set(o.x, 0, 0).addScaledVector(o.dir, s + this.comp + 0.003);
      o.glowMat.opacity = Math.min(0.8, burn * 0.7 + heat * 0.2);
      o.glowMat.color.setRGB(1, 0.42 + 0.18 * burn, 0.1 + 0.08 * burn);
      if (o.ports) {
        const ca = (th + cfg.cylOffset[c]) % cfg.cycle;
        const j = Math.min(cfg.tabN, Math.round(ca * tab));
        o.ports[0].m.opacity = 0.12 + 0.75 * Math.min(1, cfg.exTabHi[j] / this.maxEx);
        o.ports[1].m.opacity = 0.12 + 0.75 * Math.min(1, cfg.inTab[j] / this.maxIn);
      }
      o.boreMat.emissiveIntensity = burn * 1.4 + heat * 0.35;
      o.boreMat.opacity = 0.13 + burn * 0.25;
    }
  }

  poseRotary(th) {
    const rad = (th * Math.PI) / 180;
    const cfg = this.cfg;
    for (let i = 0; i < this.rotors.length; i++) {
      const R = this.rotors[i];
      // rotor phase from the firing offsets of its first face
      const ph = rad + (cfg.cylOffset[R.faces[0]] * Math.PI) / 180;
      R.g.position.set(R.x, this.ecc * Math.cos(ph), this.ecc * Math.sin(ph));
      R.g.rotation.x = ph / 3;
      let b = 0, h = 0;
      for (const f of R.faces) {
        b = Math.max(b, this.burn[f]);
        h = Math.max(h, this.heat[f]);
      }
      R.mat.emissiveIntensity = b * 0.7;
    }
  }
}
