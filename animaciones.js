// Animaciones de técnica: una figura de perfil que repite el movimiento en bucle.
// Cada ejercicio define sus posiciones clave y una función pose() que arma el esqueleto (tobillo, rodilla,
// cadera, hombro) y la barra; los brazos llegan solos a la barra. Los músculos que trabajan se pintan en
// verde y se encienden más en la fase de esfuerzo. Para agregar uno: una entrada en ANIMS con el id de su guía.

const L = { shin: 44, thigh: 46, torso: 52, neck: 7, head: 9.5, upper: 28, fore: 27 };
const rad = d => (d * Math.PI) / 180;
const add = (p, len, ang) => ({ x: p.x + len * Math.cos(rad(ang)), y: p.y + len * Math.sin(rad(ang)) });
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const along = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
const unitN = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1; return { x: -dy / d, y: dx / d }; };
const off = (p, n, s) => ({ x: p.x + n.x * s, y: p.y + n.y * s });
const f1 = v => v.toFixed(1);
const pt = p => `${f1(p.x)} ${f1(p.y)}`;

// Codo: hay dos posiciones posibles; se elige la más cercana a la dirección `bend` (grados desde el hombro)
// s: largo aparente del brazo (si los brazos van abiertos hacia los lados, de perfil se ven más cortos)
function elbowFor(sh, hand, bend, s = 1) {
  const up = L.upper * s, fo = L.fore * s, dx = hand.x - sh.x, dy = hand.y - sh.y;
  const d = Math.min(Math.hypot(dx, dy), up + fo - 0.01);
  const a = Math.atan2(dy, dx);
  const c = Math.acos(Math.max(-1, Math.min(1, (up ** 2 + d ** 2 - fo ** 2) / (2 * up * d))));
  const e1 = { x: sh.x + up * Math.cos(a + c), y: sh.y + up * Math.sin(a + c) };
  const e2 = { x: sh.x + up * Math.cos(a - c), y: sh.y + up * Math.sin(a - c) };
  const gap = e => Math.abs(((Math.atan2(e.y - sh.y, e.x - sh.x) * 180 / Math.PI - bend) % 360 + 540) % 360 - 180);
  return gap(e1) <= gap(e2) ? e1 : e2;
}
// La mano no puede llegar más lejos que el largo del brazo
function reach(sh, hand, s = 1) {
  const dx = hand.x - sh.x, dy = hand.y - sh.y, d = Math.hypot(dx, dy), max = (L.upper + L.fore) * s - 0.5;
  return d <= max ? hand : { x: sh.x + (dx * max) / d, y: sh.y + (dy * max) / d };
}
// Pierna desde el tobillo (de pie): rodilla y cadera
function legs(ankle, shin, thigh) {
  const knee = add(ankle, L.shin, shin);
  return { knee, hip: add(knee, L.thigh, thigh) };
}

export const ANIMS = {
  // Sentadilla con barra alta: la barra baja y sube sobre la mitad del pie (el torso se inclina lo justo)
  sentadilla: {
    keys: [{ shin: 86, thigh: 94 }, { shin: 57, thigh: 177 }],
    phases: [[0, 0.6, 'Parte de pie, con la barra sobre la espalda alta'], [1, 1.7, 'Baja controlado, rodillas hacia las puntas'],
      [1, 0.35, 'Abajo: espalda neutra y pies completos en el suelo'], [0, 1.2, 'Sube empujando todo el pie contra el suelo', 1]],
    midfoot: 119,
    pose(k) {
      const ankle = { x: 112, y: 7 }, mid = 119;
      const { knee, hip } = legs(ankle, k.shin, k.thigh);
      const bo = { x: -7, y: 4 };   // la barra queda detrás y sobre el hombro
      const torso = Math.acos(Math.max(-1, Math.min(1, (mid - bo.x - hip.x) / L.torso))) * 180 / Math.PI;
      const sh = add(hip, L.torso, torso);
      const bar = { x: sh.x + bo.x, y: sh.y + bo.y };
      // Agarre abierto: de perfil el brazo se ve corto, con el codo abajo y atrás
      return { ankle, knee, hip, sh, torso, bar, hand: { x: bar.x - 3, y: bar.y - 3 }, bend: torso + 170, arm: 0.6 };
    },
    work: ['quad', 'glute'],
  },
  // Press banca: acostado, la barra baja a la parte baja del pecho y sube sobre los hombros
  'press-banca': {
    keys: [{ bx: 84, by: 104 }, { bx: 96, by: 66 }],
    phases: [[0, 0.6, 'Escápulas juntas, la barra sobre los hombros'], [1, 1.5, 'Baja controlado a la parte baja del pecho'],
      [1, 0.3, 'Toca el pecho sin rebotar'], [0, 1.0, 'Empuja hacia arriba y un poco hacia atrás', 1]],
    pose(k) {
      const sh = { x: 84, y: 55 }, hip = { x: 135, y: 53 };
      const knee = { x: 172, y: 58 }, ankle = { x: 186, y: 7 };
      const torso = Math.atan2(sh.y - hip.y, sh.x - hip.x) * 180 / Math.PI;
      return { ankle, knee, hip, sh, torso, bar: { x: k.bx, y: k.by }, hand: { x: k.bx, y: k.by }, bend: 285, bench: true };
    },
    work: ['chest', 'triceps', 'frontdelt'],
  },
  // Remo con barra: torso inclinado y quieto; la barra sube hasta la parte baja del abdomen
  'remo-barra': {
    keys: [{ t: 0 }, { t: 1 }],
    phases: [[0, 0.6, 'Torso inclinado y espalda neutra, brazos estirados'], [1, 0.9, 'Tira los codos hacia atrás', 1],
      [1, 0.45, 'Aprieta la espalda arriba', 1], [0, 1.4, 'Baja lento hasta estirar los brazos']],
    pose(k) {
      const ankle = { x: 112, y: 7 };
      const { knee, hip } = legs(ankle, 82, 128);
      const torso = 40, sh = add(hip, L.torso, torso);
      const low = { x: 121, y: sh.y - 53 };
      const top = add(hip, L.torso * 0.5, torso); top.y -= 9; top.x += 4;
      const bar = { x: lerp(low.x, top.x, k.t), y: lerp(low.y, top.y, k.t) };
      return { ankle, knee, hip, sh, torso, bar, hand: bar, bend: 195 };
    },
    work: ['lats', 'upperback', 'biceps'],
  },
};

// ---------- Dibujo ----------
const SKIN = '#b9c1d0', FAR = '#6f7789', GREEN = '#4cad34';

// Segmento con volumen: ancho detrás (+n) y delante (−n) al inicio, al medio y al final
function limb(a, b, back, front, fill) {
  const n = unitN(a, b), m = along(a, b, 0.5);
  const b0 = off(a, n, back[0]), b1 = off(m, n, back[1]), b2 = off(b, n, back[2]);
  const r0 = off(a, n, -front[0]), r1 = off(m, n, -front[1]), r2 = off(b, n, -front[2]);
  const ctrl = (p, q, r) => ({ x: 2 * q.x - (p.x + r.x) / 2, y: 2 * q.y - (p.y + r.y) / 2 });   // la curva pasa por el medio
  const cb = ctrl(b0, b1, b2), cf = ctrl(r2, r1, r0);
  const ca = along(b0, r0, 0.5), cz = along(b2, r2, 0.5);
  return `<path d="M${pt(b0)} Q${pt(cb)} ${pt(b2)} L${pt(r2)} Q${pt(cf)} ${pt(r0)} Z" fill="${fill}"/>`
    + `<circle cx="${f1(ca.x)}" cy="${f1(ca.y)}" r="${f1((back[0] + front[0]) / 2)}" fill="${fill}"/>`
    + `<circle cx="${f1(cz.x)}" cy="${f1(cz.y)}" r="${f1((back[2] + front[2]) / 2)}" fill="${fill}"/>`;
}
// Músculo: una franja curva sobre un segmento (lado +1 = atrás, −1 = adelante)
function muscle(a, b, t0, t1, side, dist, width, op) {
  const n = unitN(a, b), p0 = off(along(a, b, t0), n, side * dist), p1 = off(along(a, b, t1), n, side * dist);
  const c = off(along(p0, p1, 0.5), n, side * width * 0.35);
  return `<path d="M${pt(p0)} Q${pt(c)} ${pt(p1)}" stroke="${GREEN}" stroke-width="${width}" stroke-linecap="round" fill="none" opacity="${op.toFixed(2)}"/>`;
}
const arrow = (from, dir, len) => {
  const to = { x: from.x + dir.x * len, y: from.y + dir.y * len }, n = { x: -dir.y, y: dir.x };
  const h1 = { x: to.x - dir.x * 6 + n.x * 4, y: to.y - dir.y * 6 + n.y * 4 }, h2 = { x: to.x - dir.x * 6 - n.x * 4, y: to.y - dir.y * 6 - n.y * 4 };
  return `<path d="M${pt(from)} L${pt(to)} M${pt(h1)} L${pt(to)} L${pt(h2)}" stroke="#f0a43a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
};

function body(p, color, far) {
  const hand = reach(p.sh, p.hand, p.arm || 1), elbow = elbowFor(p.sh, hand, p.bend, p.arm || 1);
  const neck = add(p.sh, L.neck, p.torso), head = add(neck, L.head + 1, p.torso);
  const heel = { x: p.ankle.x - 7, y: 1.5 }, toe = { x: p.ankle.x + 19, y: 1.5 };
  const foot = `<path d="M${pt(heel)} L${pt(toe)} Q${f1(toe.x + 2)} ${f1(toe.y + 5)} ${f1(toe.x - 6)} ${f1(toe.y + 6)} L${f1(p.ankle.x + 3)} ${f1(p.ankle.y + 4)} L${f1(heel.x)} ${f1(heel.y + 6)} Z" fill="${color}"/>`;
  const leg = limb(p.ankle, p.knee, [3.5, 6.5, 4.6], [3, 3.8, 4.6], color) + limb(p.knee, p.hip, [4.8, 6.4, 9], [4.8, 8, 7], color);
  const arm = limb(p.sh, elbow, [5.6, 5, 3.6], [5.6, 5.2, 3.6], color) + limb(elbow, hand, [3.8, 4, 2.6], [3.6, 3.8, 2.6], color)
    + `<circle cx="${f1(hand.x)}" cy="${f1(hand.y)}" r="3.8" fill="${color}"/>`;
  if (far) return { leg: foot + leg, arm };
  const trunk = limb(p.hip, p.sh, [10, 9, 10], [8, 8.5, 11.5], color);
  const headSvg = limb(p.sh, neck, [4.5, 4.5, 4.5], [4.5, 4.5, 4.5], color) + `<circle cx="${f1(head.x)}" cy="${f1(head.y)}" r="${L.head}" fill="${color}"/>`;
  return { leg: foot + leg, arm, trunk, head: headSvg, elbow, hand };
}

function frame(anim, k, fx) {
  const p = anim.pose(k);
  const op = 0.5 + 0.45 * fx.effort;
  const shift = q => ({ x: q.x + 3, y: q.y + 2 });
  const farP = { ...p, ankle: shift(p.ankle), knee: shift(p.knee), hip: shift(p.hip), sh: shift(p.sh), hand: shift(p.hand) };
  const far = body(farP, FAR, true), near = body(p, SKIN, false);
  const w = new Set(anim.work), e = near.elbow;
  const trunkMus = [
    w.has('quad') ? muscle(p.knee, p.hip, 0.12, 0.82, -1, 3.2, 8, op) : '',
    w.has('glute') ? muscle(p.knee, p.hip, 0.68, 1.04, 1, 5.5, 9, op) : '',
    w.has('chest') ? muscle(p.hip, p.sh, 0.62, 0.9, -1, 6.5, 8, op) : '',
    w.has('lats') ? muscle(p.hip, p.sh, 0.3, 0.78, 1, 5.5, 8, op) : '',
    w.has('upperback') ? muscle(p.hip, p.sh, 0.8, 1.02, 1, 6, 7, op) : '',
  ].join('');
  const armMus = [
    w.has('triceps') ? muscle(p.sh, e, 0.18, 0.85, -1, 1.8, 5.5, op) : '',
    w.has('biceps') ? muscle(p.sh, e, 0.18, 0.85, 1, 1.8, 5.5, op) : '',
    w.has('frontdelt') ? muscle(p.sh, e, -0.12, 0.15, -1, 2, 7, op) : '',
  ].join('');
  const bench = p.bench ? `<rect x="56" y="38" width="122" height="11" rx="5" fill="#343b4b"/><rect x="74" y="0" width="7" height="38" fill="#2a303d"/>
    <rect x="152" y="0" width="7" height="38" fill="#2a303d"/><rect x="68" y="0" width="19" height="4" rx="2" fill="#2a303d"/><rect x="146" y="0" width="19" height="4" rx="2" fill="#2a303d"/>` : '';
  const plate = `<circle cx="${f1(p.bar.x)}" cy="${f1(p.bar.y)}" r="21" fill="#0f1218" fill-opacity=".55" stroke="#7b8396" stroke-width="3"/>
    <circle cx="${f1(p.bar.x)}" cy="${f1(p.bar.y)}" r="13" fill="none" stroke="#454c5c" stroke-width="1.5"/><circle cx="${f1(p.bar.x)}" cy="${f1(p.bar.y)}" r="4" fill="#9aa3b5"/>`;
  const guide = anim.midfoot ? `<line x1="${anim.midfoot}" y1="2" x2="${anim.midfoot}" y2="150" stroke="#f0a43a" stroke-width="1.2" stroke-dasharray="3 4" opacity=".55"/>` : '';
  const arr = fx.dir ? arrow({ x: p.bar.x + 27, y: p.bar.y - fx.dir.y * 7 }, fx.dir, 14) : '';
  const shadow = `<ellipse cx="${f1(p.ankle.x + 4)}" cy="0" rx="34" ry="3" fill="#000" opacity=".35"/>`;
  return `${shadow}${guide}${bench}${far.leg}${far.arm}${near.leg}${near.trunk}${trunkMus}${near.head}${plate}${near.arm}${armMus}${arr}`;
}

// Una posición fija (para probar): k = valores entre las posiciones clave
export const previewSvg = (id, k, fx = { effort: 1, dir: null }) =>
  `<svg viewBox="0 0 240 190"><g transform="translate(0,182) scale(1,-1)"><line x1="8" y1="0" x2="232" y2="0" stroke="#2c3140" stroke-width="2"/>${frame(ANIMS[id], k, fx)}</g></svg>`;

// Arma la animación dentro de `el` y la repite hasta que el elemento salga de la pantalla. Tocar = pausa.
export function mountAnim(el, id) {
  const anim = ANIMS[id];
  if (!el || !anim) return;
  const total = anim.phases.reduce((a, [, s]) => a + s, 0);
  const barAt = key => anim.pose(anim.keys[key]).bar;   // para la flecha: hacia dónde va la barra
  el.innerHTML = `<svg viewBox="0 0 240 190" role="img" aria-label="Animación del ejercicio"><g transform="translate(0,182) scale(1,-1)">
      <line x1="8" y1="0" x2="232" y2="0" stroke="#2c3140" stroke-width="2"/><g class="fig"></g></g></svg>
    <p class="anim-cap muted small"></p>`;
  const fig = el.querySelector('.fig'), cap = el.querySelector('.anim-cap');
  let paused = false, t0 = performance.now(), pausedAt = 0, lastCap = '', effort = 0, last = performance.now();
  el.onclick = () => {
    paused = !paused;
    if (paused) pausedAt = performance.now(); else t0 += performance.now() - pausedAt;
    el.classList.toggle('paused', paused);
  };
  const draw = now => {
    if (!el.isConnected) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!paused) {
      let s = ((now - t0) / 1000) % total, prev = anim.phases[anim.phases.length - 1][0];
      let k = anim.keys[0], text = '', dir = null, hard = 0;
      for (const [to, dur, label, isHard] of anim.phases) {
        if (s <= dur) {
          const a = anim.keys[prev], b = anim.keys[to], e = ease(Math.min(1, s / dur));
          k = Object.fromEntries(Object.keys(a).map(n => [n, lerp(a[n], b[n], e)]));
          text = label; hard = isHard ? 1 : 0;
          if (prev !== to && s / dur < 0.92) {
            const p0 = barAt(prev), p1 = barAt(to), d = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
            dir = { x: (p1.x - p0.x) / d, y: (p1.y - p0.y) / d };
          }
          break;
        }
        s -= dur; prev = to;
      }
      effort += (hard - effort) * Math.min(1, dt * 5);   // el verde sube y baja suave
      fig.innerHTML = frame(anim, k, { effort, dir });
      if (text !== lastCap) { cap.textContent = text; lastCap = text; }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}
