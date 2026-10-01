// Scripted scenes: courses, the heads-up strip and the drag-strip time slip.

import { speedText } from './units.js';

const segs = (list) => {
  let s = 0;
  return list.map((q) => {
    const o = { ...q, s };
    s += q.len;
    return o;
  });
};

export const SCENES = {
  flyby: {
    title: 'Fly-by',
    sub: 'Roadside mic, 7.5 m from the kerb, full throttle past it.',
    key: '3',
  },
  tunnel: {
    title: 'Tunnel run',
    sub: 'Cruise up to a 320 m tunnel, drop a gear at the portal and floor it through. Lift before the exit and let it crackle.',
    key: '4',
    track: segs([
      { len: 170, env: 'open' },
      { len: 320, env: 'tunnel' },
      { len: 200, env: 'open' },
    ]),
  },
  drag: {
    title: 'Quarter mile',
    sub: 'Staged on the launch limiter. Hit GO on green: your reaction counts. The car does the rest and prints a time slip.',
    key: '5',
    length: 402.336,
    marks: [
      ['60ft', 18.288],
      ['330ft', 100.584],
      ['eighth', 201.168],
      ['1000ft', 304.8],
      ['quarter', 402.336],
    ],
  },
  mountain: {
    title: 'Mountain road',
    sub: 'Two kilometres of canyon road, a tunnel and seven corners. Hard braking, blipped downshifts and overrun crackle.',
    key: '6',
    track: segs([
      { len: 160, env: 'open' },
      { len: 55, env: 'open', v: 85, turn: 1 },
      { len: 230, env: 'canyon' },
      { len: 45, env: 'canyon', v: 65, turn: -1 },
      { len: 180, env: 'canyon' },
      { len: 50, env: 'canyon', v: 50, turn: 1 },
      { len: 240, env: 'open' },
      { len: 160, env: 'tunnel' },
      { len: 60, env: 'open', v: 105, turn: -1 },
      { len: 210, env: 'open' },
      { len: 45, env: 'canyon', v: 58, turn: 1 },
      { len: 260, env: 'canyon' },
      { len: 50, env: 'canyon', v: 80, turn: -1 },
      { len: 200, env: 'open' },
    ]),
  },
};
for (const k of ['tunnel', 'mountain']) {
  const t = SCENES[k].track;
  SCENES[k].length = t[t.length - 1].s + t[t.length - 1].len;
}

// 2-D outline of the mountain road for the map (corners as arcs).
export function courseOutline(track) {
  const pts = [];
  let x = 0, y = 0, h = -Math.PI / 2;
  const step = 5;
  for (const seg of track) {
    const turn = seg.v ? (seg.turn ?? 1) * (seg.v <= 60 ? 2.6 : seg.v <= 85 ? 1.6 : 0.9) : 0;
    const n = Math.max(1, Math.round(seg.len / step));
    for (let i = 0; i < n; i++) {
      h += turn / n;
      x += Math.cos(h) * (seg.len / n);
      y += Math.sin(h) * (seg.len / n);
      pts.push([x, y, seg.s + ((i + 1) / n) * seg.len, seg.env]);
    }
  }
  return pts;
}

const ENV_COL = { open: 'rgba(235,227,208,0.55)', canyon: '#c98a4b', tunnel: '#58aee0' };

// Draw the heads-up strip for the running scene.
export function drawSceneHud(canvas, scene, tel, cache) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.fillStyle = 'rgba(15,14,12,0.88)';
  g.fillRect(0, 0, W, H);
  const def = SCENES[scene.id];
  const x = tel?.scene?.x ?? 0;
  g.font = `500 ${Math.round(10 * dpr)}px "B612 Mono", monospace`;
  const speed = speedText(tel?.speed ?? 0);
  if (scene.id === 'mountain') {
    const pts = (cache.outline ??= courseOutline(def.track));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 10 * dpr;
    const sc = Math.min((W * 0.55 - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
    const ox = W - pad - (maxX - minX) * sc, oy = pad;
    const P = (p) => [ox + (p[0] - minX) * sc, oy + (p[1] - minY) * sc];
    g.lineWidth = 3 * dpr;
    g.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = P(pts[i - 1]);
      const [x1, y1] = P(pts[i]);
      g.strokeStyle = ENV_COL[pts[i][3]] ?? ENV_COL.open;
      g.globalAlpha = pts[i][2] <= x ? 1 : 0.35;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    g.globalAlpha = 1;
    let car = pts[0];
    for (const p of pts) if (p[2] <= x) car = p;
    const [cx, cy] = P(car);
    g.fillStyle = '#ff5f1f';
    g.beginPath();
    g.arc(cx, cy, 5 * dpr, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(235,227,208,0.85)';
    g.textAlign = 'left';
    g.fillText(`${speed} · gear ${tel?.gear ?? '-'}`, 10 * dpr, 16 * dpr);
    g.fillStyle = 'rgba(235,227,208,0.55)';
    g.fillText(`${Math.round(x)} / ${Math.round(def.length)} m`, 10 * dpr, 30 * dpr);
    g.fillText(tel?.scene?.env === 'canyon' ? 'rock walls' : tel?.scene?.env === 'tunnel' ? 'tunnel' : 'open road', 10 * dpr, 44 * dpr);
    return;
  }
  const L = def.length;
  const x0 = 16 * dpr, x1 = W - 16 * dpr;
  const X = (d) => x0 + (Math.min(d, L) / L) * (x1 - x0);
  const yRoad = H * 0.58;
  g.strokeStyle = 'rgba(235,227,208,0.25)';
  g.setLineDash([8 * dpr, 8 * dpr]);
  g.beginPath();
  g.moveTo(x0, yRoad);
  g.lineTo(x1, yRoad);
  g.stroke();
  g.setLineDash([]);
  if (scene.id === 'tunnel') {
    const t = def.track.find((q) => q.env === 'tunnel');
    g.fillStyle = 'rgba(88,174,224,0.18)';
    g.fillRect(X(t.s), yRoad - 14 * dpr, X(t.s + t.len) - X(t.s), 28 * dpr);
    g.strokeStyle = '#58aee0';
    g.lineWidth = 2 * dpr;
    for (const e of [t.s, t.s + t.len]) {
      g.beginPath();
      g.arc(X(e), yRoad, 14 * dpr, Math.PI, 0);
      g.stroke();
    }
    g.fillStyle = '#58aee0';
    g.textAlign = 'center';
    // short strips (phones) keep the label clear of the readout line
    g.fillText('TUNNEL', (X(t.s) + X(t.s + t.len)) / 2, H / dpr < 70 ? yRoad + 22 * dpr : yRoad - 18 * dpr);
  } else if (scene.id === 'drag') {
    const labels = { '60ft': "60'", '330ft': "330'", eighth: '1/8', '1000ft': "1000'", quarter: '1/4' };
    g.textAlign = 'center';
    for (const [k, d] of def.marks) {
      g.strokeStyle = 'rgba(235,227,208,0.35)';
      g.beginPath();
      g.moveTo(X(d), yRoad - 10 * dpr);
      g.lineTo(X(d), yRoad + 10 * dpr);
      g.stroke();
      g.fillStyle = 'rgba(235,227,208,0.6)';
      g.fillText(labels[k], X(d), yRoad + 22 * dpr);
    }
  }
  g.fillStyle = '#ff5f1f';
  g.fillRect(X(x) - 9 * dpr, yRoad - 4 * dpr, 18 * dpr, 8 * dpr);
  g.fillStyle = 'rgba(235,227,208,0.85)';
  g.textAlign = 'left';
  const et = scene.id === 'drag' && scene.leaveT != null ? ` · ${((performance.now() - scene.leaveT) / 1000).toFixed(2)} s` : '';
  g.fillText(`${Math.round(x)} m · ${speed} · gear ${tel?.gear ?? '-'}${scene.id === 'drag' && scene.finished ? '' : et}`, 10 * dpr, 16 * dpr);
}

// Time slip text from the worklet's timing marks.
export function timeSlip(r, engine, best) {
  const f = (v) => (v == null ? '  —   ' : v.toFixed(3).padStart(7));
  const mph = (v) => (v == null ? '' : `  @ ${(v * 2.23694).toFixed(1)} mph`);
  const t = r.times;
  const lines = [
    `R/T     ${f(r.rt)}${r.foul ? '  RED LIGHT' : ''}`,
    `60'     ${f(t['60ft'])}`,
    `330'    ${f(t['330ft'])}`,
    `1/8     ${f(t.eighth)}${mph(t.eighth_v)}`,
    `1000'   ${f(t['1000ft'])}`,
    `1/4     ${f(t.quarter)}${mph(t.quarter_v)}`,
  ];
  if (t.quarter_v) lines.push(`        ${(t.quarter_v * 3.6).toFixed(1).padStart(14)} km/h`);
  if (best) lines.push('', `Best   ${f(best)}`);
  return { head: engine, lines };
}
