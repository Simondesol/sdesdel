import { BASE_FOODS, synonymsOf } from './foods-base.js';
import { QUIZ, QUIZ_CATS } from './quiz.js';
import { GUIDES, GUIDE_ZONES } from './ejercicios.js';
import { PROGRAMS, LEVELS } from './programas.js';
import { ANIMS, mountAnim } from './animaciones.js';

// ---------- Datos ----------
// Cada usuario tiene una copia en el teléfono (para usar la app sin internet en el gym)
// que se sincroniza con su cuenta en la nube. El entrenamiento en curso solo vive en el teléfono.
const LEGACY_KEY = 'sdesdel-v1';                 // datos de antes de que existieran las cuentas
const userKey = id => `sdesdel-u-${id}`;
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');

const emptyWater = () => ({ goalMl: null, days: {} });   // days: { 'AAAA-MM-DD': [{ at, ml }] }
// Nutrición: alimentos (valores por 100 g), dietas con comidas y el registro de comidas marcadas por día
const emptyNutrition = () => ({ foods: [], diets: [], activeDietId: null, log: {} });
const emptyDb = () => ({ routines: [], workouts: [], draft: null, notes: {}, bodyweight: [], body: {}, sleep: [], skinfolds: [], measures: [], programs: [], plan: null, planLog: [], water: emptyWater(), nutrition: emptyNutrition() });
const emptySynced = () => ({ main: null, w: {}, wAt: 0 });   // wAt: hasta cuándo tenemos los entrenamientos de la nube
let db = emptyDb();
let user = null;                 // { uid, email, username }
let synced = emptySynced();      // último estado confirmado por la nube (para saber qué falta subir)
let cloud = null;                // módulo de conexión (cloud.js)
let status = 'booting';          // booting | signed-out | ready | load-error | fatal
let pendingUsername = null;      // nombre elegido al registrarse (Firebase lo avisa un poco después)
let pendingBody = null;          // estatura y sexo elegidos al registrarse (se guardan al entrar)
let authUser = null;             // último usuario informado por Firebase
let firstOpen = true;            // la app recién se abrió (para volver al entrenamiento en curso)

let lastUnit = 'kg';
// Unidades de peso; "placas" es para máquinas con los números borrados (se anota cuántas placas)
const UNITS = ['kg', 'lb', 'placas'];
const unitShort = u => (u === 'placas' ? 'pl.' : u);
const unitKind = u => (u === 'placas' ? 'placas' : 'peso');
const openHistory = new Set();   // ejercicios con el historial desplegado
let editingNote = null;          // ejercicio cuya nota se está editando
let editBuf = null;              // copia de un entrenamiento guardado que se está editando
let justFinished = null;         // entrenamiento recién guardado (para mostrar el resumen)
let saveAsOpen = null, saveAsDone = null;   // "Guardar como rutina" de un entreno libre: abierto / descartado

function persistLocal() {
  if (user && !viewing) localStorage.setItem(userKey(user.uid), JSON.stringify({ db, synced }));
}
function save() {
  if (viewing) { scheduleCoachEdits(); return; }   // viendo a un alumno: sus rutinas cambiadas se le envían
  recordPlan();
  syncDraftRoutine();
  persistLocal(); scheduleSync(); scheduleProfile(); scheduleCoachSummary();
}

// Datos guardados en el teléfono antes de tener cuenta (se suben al iniciar sesión)
function readLegacy() {
  try {
    const d = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (d && Array.isArray(d.routines) && Array.isArray(d.workouts) && (d.routines.length || d.workouts.length)) {
      d.notes = d.notes || {};
      return d;
    }
  } catch (e) { /* datos corruptos o vacíos */ }
  return null;
}

// ---------- Utilidades ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = s => {
  const t = String(s ?? '').trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const fmtNum = n => (n == null ? '–' : String(n).replace('.', ','));
const toField = n => (n == null ? '' : String(n).replace('.', ','));
const fmtDate = iso => new Date(iso).toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLongDate = iso => new Date(iso).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const setsCount = w => w.exercises.reduce((a, ex) => a + ex.sets.length, 0);
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Descanso: se guarda en segundos y se muestra como m:ss
const fmtRest = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
function parseRest(text) {
  const t = text.trim().replace(',', '.');
  if (t === '') return 0;
  const m = t.match(/^(\d+):(\d{1,2})$/);
  if (m) return +m[1] * 60 + +m[2];
  const n = Number(t);                       // sin ":" se toma como minutos (ej. "5" o "1.5")
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 60) : null;
}

// Reloj desde que empezaste: "42:15" o "1:05:20"
function elapsedClock(startIso) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtDuration(sec) {
  if (sec < 60) return 'menos de 1 min';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

// ---------- Comparación de series ----------
// Una serie es mejor si su récord estimado (1RM, Epley + RIR) es mayor, igual que en Progreso:
// 110 × 1 no es mejor que 100 × 20. Con peso corporal se suma tu peso de ese día (bw).
// Las libras se pasan a kg para poder comparar ejercicios que cambiaron de unidad.
const toKg = (w, unit) => (w == null ? 0 : unit === 'lb' ? w * 0.45359237 : w);
const setStrength = x => epley((x.bw || 0) + toKg(x.w || 0, x.unit), x.r || 1, x.rir);
function cmpSet(a, b) {
  const diff = setStrength(a) - setStrength(b);
  return Math.abs(diff) < 0.05 ? 0 : diff > 0 ? 1 : -1;
}
// Tu peso de ese día, solo en ejercicios con peso corporal
const bwFor = (ex, dateIso) => (ex.unit !== 'placas' && isBwEx(ex) ? bwOn(dateIso) || 0 : 0);

// Mejor serie de cada posición (serie 1, serie 2...) en los entrenamientos anteriores a `before`
// unit: solo compara con sesiones de la misma clase (placas con placas; kg y lb entre sí)
// rid: solo los entrenos de esa rutina (en cada rutina rindes distinto según el orden y el cansancio); null = todos
function bestSets(exerciseId, before = db.workouts.length, unit = null, rid = null) {
  const best = [];
  for (let k = 0; k < before; k++) {
    if (rid && db.workouts[k].routineId !== rid) continue;
    const ex = db.workouts[k].exercises.find(e => e.exerciseId === exerciseId);
    if (!ex || (unit && unitKind(ex.unit) !== unitKind(unit))) continue;
    const bw = bwFor(ex, db.workouts[k].date);
    ex.sets.forEach((s, j) => {
      const c = { w: s.w, r: s.r, rir: s.rir, unit: ex.unit, bw };
      if (!best[j] || cmpSet(c, best[j]) > 0) best[j] = c;
    });
  }
  return best;
}

// Compara lo que se está escribiendo con la mejor marca (null si no hay nada que comparar)
function liveCmp(s, ex, best) {
  if (!best) return null;
  // Los íconos de progreso recién cuando escribes el peso y las repeticiones (con peso corporal basta con las repeticiones)
  const has = v => v !== '' && v != null;
  if (!has(s.r) || !(has(s.w) || isBwEx(ex))) return null;
  s = { ...s, ...bwEff(s, lastreEx(ex)) };
  const w = num(s.w), r = num(s.r);
  if (w == null && r == null) return null;
  return cmpSet({ w, r, rir: num(s.rir), unit: ex.unit, bw: bwFor(ex, new Date().toISOString()) }, best);
}

// Gráfico chico: sube (superaste), plano (igualaste), baja (bajo tu récord)
const TREND_ICON = {
  up: '<svg class="trend-ic" viewBox="0 0 24 24" aria-label="Superaste" role="img"><path d="M4 4v16h16"/><path d="M7.5 15.5l3.5-4 3 2.5 5-6.5"/><path d="M15.5 7.5H19V11"/></svg>',
  eq: '<svg class="trend-ic" viewBox="0 0 24 24" aria-label="Igualaste" role="img"><path d="M4 4v16h16"/><path d="M7.5 12.5h11"/><path d="M15.5 9.5l3 3-3 3"/></svg>',
  down: '<svg class="trend-ic" viewBox="0 0 24 24" aria-label="Bajo tu récord" role="img"><path d="M4 4v16h16"/><path d="M7.5 8l3.5 4 3-2.5 5 6.5"/><path d="M19 12.5V16h-3.5"/></svg>',
};
const markKind = c => (c > 0 ? 'up' : c < 0 ? 'down' : 'eq');
const markSpan = c => (c == null ? '' : `<span class="mark ${markKind(c)}">${TREND_ICON[markKind(c)]}</span>`);

function header(title, { back = false, home = false, sub = '', right = '', href = '', avatar = '' } = {}) {
  const titles = `${avatar}<div class="titles-text"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
  return `<header class="bar">
    ${back ? '<button class="icon" data-action="back" aria-label="Volver">‹</button>' : ''}
    ${home ? '<a class="icon home" href="#/" aria-label="Volver al inicio">‹</a>' : ''}
    ${href ? `<a class="titles" href="${href}">${titles}</a>` : `<div class="titles">${titles}</div>`}
    ${right}
  </header>`;
}

// ---------- Menú principal ----------
const GEAR = `<a class="icon gear" href="#/cuenta" aria-label="Cuenta y configuración">
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6a.5.5 0 0 0 .1-.6l-1.9-3.3a.5.5 0 0 0-.6-.2l-2.4 1a7.3 7.3 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-3.8a.5.5 0 0 0-.5.4l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.4-1a.5.5 0 0 0-.6.2L2.5 8.8a.5.5 0 0 0 .1.6l2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6a.5.5 0 0 0-.1.6l1.9 3.3c.1.2.4.3.6.2l2.4-1c.5.4 1.1.7 1.7 1l.4 2.6c0 .2.3.4.5.4h3.8c.2 0 .5-.2.5-.4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.4 1c.2.1.5 0 .6-.2l1.9-3.3a.5.5 0 0 0-.1-.6ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/></svg>
</a>`;

const bar = (value, goal) => `<div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${value}">
  <span style="width:${Math.min(100, goal ? (value / goal) * 100 : 0)}%"></span></div>`;

// "hoy", "ayer", "hace 3 días"
function agoText(iso) {
  const days = Math.round((Date.parse(bwIso(todayKey())) - Date.parse(bwIso(dayKeyOf(iso)))) / 86400000);
  return days <= 0 ? 'hoy' : days === 1 ? 'ayer' : `hace ${days} días`;
}
function entrenoCard() {
  const d = db.draft, t = todayKey(), plan = plannedRoutine(t);
  let body;
  if (d) body = `<a class="muted" href="#/entrenar">Entrenamiento en curso: ${esc(d.routineName)} ›</a>`;
  else if (plan === undefined) {
    // Sin programa activo: se sugiere la rutina que hace más tiempo no haces
    const lastDone = id => { for (let k = db.workouts.length - 1; k >= 0; k--) if (db.workouts[k].routineId === id) return db.workouts[k].date; return ''; };
    const next = db.routines.filter(r => r.exercises.length).map(r => ({ r, at: lastDone(r.id) })).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0];
    body = next
      ? `<div class="hub-value">Sugerida: <strong>${esc(next.r.name)}</strong>${next.at ? ` <span class="small">· última vez ${esc(agoText(next.at))}</span>` : ''}</div>
        <div class="hub-btns"><button class="btn primary" data-action="start" data-id="${next.r.id}">Empezar</button><a class="btn center" href="#/rutinas">Otra rutina</a></div>`
      : '<button class="btn primary block" data-action="start-free">Entrenar sin rutina</button>';
  }
  else if (plan === null) body = `<span class="muted">Hoy: descanso</span>
      ${viewing ? '' : '<div class="hub-btns"><a class="btn center" href="#/rutinas">Entrenar igual</a></div>'}`;
  else if (trainedOn(t, plan.id)) body = `<span class="muted">Hoy ya entrenaste <strong>${esc(plan.name)}</strong></span>`;
  else body = `<div class="hub-value">Hoy te toca: <strong>${esc(plan.name)}</strong></div>
      <button class="btn primary" data-action="start" data-id="${plan.id}" ${plan.exercises.length ? '' : 'disabled'}>Empezar</button>`;
  return `<div class="card hub">
      <a class="hub-top" href="#/rutinas"><span class="hub-icon">🏋️</span><strong>Entreno</strong></a>
      ${body}
    </div>`;
}


// ---------- Resumen semanal (Inicio) ----------
// Lunes a domingo: entrenos (y lo que tocaba según Mi plan), peso, sueño, agua, dieta y récords
let weekOffset = 0;   // 0 = esta semana, 1 = la pasada
const WEEK_LETTERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
function weekSummary(offset) {
  const mon = mondayOf(new Date());
  mon.setDate(mon.getDate() - 7 * offset);
  const keys = Array.from({ length: 7 }, (_, k) => { const d = new Date(mon); d.setDate(d.getDate() + k); return dayKeyOf(d); });
  const today = todayKey(), past = keys.filter(k => k <= today);
  const prevKeys = keys.map(k => { const d = new Date(bwIso(k)); d.setDate(d.getDate() - 7); return dayKeyOf(d); });
  const inWeek = (list, ks) => list.filter(e => e.date >= ks[0] && e.date <= ks[6]);

  // Entrenos: cada día, entrenado / tocaba y no fue / descanso o futuro
  const days = keys.map(k => {
    const plan = plannedRoutine(k), trained = trainedOn(k);
    return { k, trained, planned: !!plan, future: k >= today };   // hoy todavía no cuenta como perdido
  });
  const done = db.workouts.filter(w => dayKeyOf(w.date) >= keys[0] && dayKeyOf(w.date) <= keys[6]);
  const planned = keys.some(k => planOn(k)) ? days.filter(d => d.planned).length : null;

  const avg = list => (list.length ? list.reduce((a, v) => a + v, 0) / list.length : null);
  const kg = avg(inWeek(db.bodyweight, keys).map(e => e.kg)), kgPrev = avg(inWeek(db.bodyweight, prevKeys).map(e => e.kg));
  const sleep = avg(inWeek(db.sleep, keys).map(e => e.h));
  const goal = waterGoal().ml;
  const water = past.filter(k => waterDay(k).reduce((a, e) => a + e.ml, 0) >= goal).length;
  // Dieta cumplida: marcaste todas las comidas de la dieta de ese día
  const dietOk = past.filter(k => {
    const log = N().log[k], diet = log && dietById(log.dietId);
    return diet && diet.meals.length && diet.meals.every(m => (log.done || []).includes(m.id));
  }).length;
  const prs = [];
  for (const w of done) for (const pr of newPRs(w)) if (!prs.includes(pr.name)) prs.push(pr.name);
  return { keys, days, done: done.length, planned, kg, kgPrev, sleep, water, dietOk, past: past.length, prs };
}

function weekCard() {
  if (!db.workouts.length) return '';
  const s = weekSummary(weekOffset);
  const stat = (label, value, sub = '') => `<div class="wk-stat"><span class="muted small">${label}</span><strong>${value}</strong>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>`;
  // Solo lo que usas: peso y sueño si alguna vez los anotaste; agua y dieta si las anotaste en las últimas 2 semanas
  const recent = Array.from({ length: 14 }, (_, k) => { const d = new Date(); d.setDate(d.getDate() - k); return dayKeyOf(d); });
  const usesWater = recent.some(k => waterDay(k).length);
  const usesDiet = N().diets.length && recent.some(k => { const log = N().log[k]; return log && (log.done || []).length; });
  const stats = [
    ...(db.bodyweight.length ? [stat('Peso promedio', s.kg != null ? fmtKg(s.kg) : '—', s.kg != null && s.kgPrev != null ? (Math.abs(s.kg - s.kgPrev) < 0.05 ? 'igual que la anterior' : `${signed(s.kg - s.kgPrev)} kg vs la anterior`) : '')] : []),
    ...(db.sleep.length ? [stat('Sueño promedio', s.sleep != null ? fmtH(s.sleep) : '—')] : []),
    ...(usesWater ? [stat('Meta de agua', `${s.water} de ${s.past} días`)] : []),
    ...(usesDiet ? [stat('Dieta completa', `${s.dietOk} de ${s.past} días`)] : []),
  ];
  return `<section class="card hub week-card">
      <div class="hub-top"><span class="hub-icon">📅</span><strong>Tu semana</strong>
        <div class="range wk-range" role="group" aria-label="Semana">${[[0, 'Esta'], [1, 'Pasada']].map(([w, label]) =>
          `<button class="${w === weekOffset ? 'on' : ''}" data-action="week-sum" data-w="${w}">${label}</button>`).join('')}</div></div>
      <div class="wk-train">
        <span><strong>${s.planned ? `${s.done} de ${s.planned}` : s.done}</strong> ${s.planned ? 'entrenos del plan' : s.done === 1 ? 'entreno' : 'entrenos'}</span>
        <div class="wk-days">${s.days.map((d, k) =>
          `<button type="button" class="wk-day ${d.trained ? 'done' : d.planned && !d.future ? 'missed' : d.planned ? 'planned' : ''}" data-action="week-day" data-k="${d.k}" aria-label="${fmtDMY(d.k)}">${WEEK_LETTERS[k]}</button>`).join('')}</div>
      </div>
      ${stats.length ? `<div class="wk-stats">${stats.join('')}</div>` : ''}
      ${s.prs.length ? `<span class="muted small">${s.prs.length === 1 ? 'Récord' : `${s.prs.length} récords`}: <strong class="wk-prs">${s.prs.map(esc).join(', ')}</strong></span>` : ''}
    </section>`;
}

// Inicio: agua, peso y sueño (mirando a un alumno solo se muestra su peso; el resto está en el resumen semanal)
function waterSleepCards(ml, goal, streak) {
  return `<div class="card hub">
      <a class="hub-top" href="#/agua"><span class="hub-icon">💧</span><strong>Agua</strong>${streak >= 2 ? `<span class="badge on" title="Días seguidos cumpliendo tu meta">🔥 ${streak}</span>` : ''}</a>
      <a class="hub-value" href="#/agua"><strong>${fmtL(ml)} / ${fmtL(goal)}</strong> L${ml >= goal ? ' · ¡Meta cumplida! 🎉' : ''}</a>
      ${bar(ml, goal)}
      <div class="ex-actions">
        ${waterQuick().map(q => `<button class="btn" data-action="water-add" data-ml="${q.ml}">+${q.ml} ml</button>`).join('')}
      </div>
    </div>

    <div class="hub-pair">${bodyweightCard()}${sleepCard()}</div>`;
}

function viewHub() {
  const d = db.draft;
  const ml = waterToday(), goal = waterGoal().ml, streak = waterStreak();
  const tourOffer = tourSeen() || tourOpen || viewing ? '' : `<section class="card tour-offer">
      <div class="grow"><strong>¿Conoces todo lo que tiene Desdel?</strong><span class="muted small">Un recorrido corto por la app.</span></div>
      <button class="btn primary" data-action="tour-open">Ver tutorial</button>
      <button class="icon small" data-action="tour-offer-no" aria-label="No mostrar">✕</button>
    </section>`;
  return `${viewing ? '' : header('Desdel', { sub: 'Entrena. Anota. Supera.', right: GEAR })}
    <div class="hub-wrap">
    ${tourOffer}
    ${viewing ? studentCheckinsCard() : socialCard()}

    ${entrenoCard()}
    ${checkinCard()}

    ${viewing ? `<div class="hub-pair">${nutritionCard()}${bodyweightCard()}</div>` : `${nutritionCard()}
    ${waterSleepCards(ml, goal, streak)}`}

    ${weekCard()}
    ${viewing ? `<button class="btn ghost block danger-text" data-action="student-del" data-uid="${esc(viewing.uid)}" style="margin-top:16px">Quitar a ${esc(viewing.name)} de mis alumnos</button>` : ''}
    </div>
`;
}

// ---------- Nutrición ----------
// Alimentos: valores por 100 g. Dietas: comidas con alimentos y gramos; los totales se calculan solos.
// Cada día se marcan ✓ las comidas de la dieta que te comiste; la meta del día es el total de la dieta.
const N = () => db.nutrition;
const ZERO = { kcal: 0, p: 0, c: 0, f: 0 };
const fmtKcal = n => Math.round(n).toLocaleString('es-CL');
const fmtG = n => fmtNum(round1(n));
const BASE_BY_ID = new Map(BASE_FOODS.map(f => [f.id, f]));
const foodById = id => N().foods.find(f => f.id === id) || BASE_BY_ID.get(id);
// Busca por palabras (sin importar tildes ni mayúsculas): tus alimentos primero, después la base
const searchCache = new Map();
function searchText(f) {
  const key = `${f.name}|${f.alias || ''}`;
  if (!searchCache.has(key)) searchCache.set(key, normText(`${f.name} ${f.alias || ''} ${synonymsOf(f.name)}`).split(/[^a-z0-9%]+/));
  return searchCache.get(key);
}
function searchFoods(query, limit = 8) {
  const words = normText(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  // Cada palabra buscada debe coincidir con el comienzo de alguna palabra del nombre ("pollo" no encuentra "repollo")
  // Cada palabra buscada (o su singular) debe coincidir con el comienzo de alguna palabra del nombre,
  // de sus otros nombres o de sus sinónimos ("tallarines" encuentra "Fideos", también en tus alimentos)
  const sing = w => (w.length > 4 ? w.replace(/(es|s)$/, '') : w);
  const match = f => {
    const parts = searchText(f);
    return words.every(w => parts.some(x => x.startsWith(w) || x.startsWith(sing(w))));
  };
  const mine = N().foods.filter(match).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const myNames = new Set(N().foods.map(f => normText(f.name)));
  const base = BASE_FOODS.filter(f => match(f) && !myNames.has(normText(f.name)));
  return [...mine, ...base].slice(0, limit);
}
const foodResultBtn = (f, action, extra = '') => `<button type="button" class="food-pick" data-action="${action}" data-id="${f.id}" ${extra}>
  <span class="grow">${esc(f.name)}${f.base ? '' : ' <span class="badge on">Mío</span>'}</span>
  <span class="muted small">${f.unitG ? portionHint(f) : `${fmtKcal(f.kcal)} kcal${isUnit(f) ? ' c/u' : ''} · P ${fmtG(f.p)}`}</span></button>`;
const dietById = id => N().diets.find(d => d.id === id);
const sumM = list => list.reduce((a, m) => ({ kcal: a.kcal + m.kcal, p: a.p + m.p, c: a.c + m.c, f: a.f + m.f }), { ...ZERO });
// Alimentos por unidad (1 huevo, 1 rebanada...) o por 100 g
const isUnit = f => !!f && f.per === 'unit';
const perText = f => (isUnit(f) ? 'por unidad' : 'por 100 g');
// "120 g Carne molida" o "2 × Huevo"
// Porciones de la base: se puede anotar en unidades (it.n) o en gramos (it.g)
const byPortion = (food, it) => it.n != null && !!food.unitG;
const itemGrams = (food, it) => (byPortion(food, it) ? it.n * food.unitG : it.g || 0);
const portionPlural = (label, n) => (n === 1 ? label : `${label}s`);
const itemText = (food, it) => {
  if (isUnit(food)) return `${fmtNum(it.g)} × ${esc(food.name)}`;
  if (byPortion(food, it)) {
    const approx = ` (≈${fmtNum(Math.round(itemGrams(food, it)))} g)`;
    return food.unitLabel === 'unidad'
      ? `${fmtNum(it.n)} × ${esc(food.name)}${approx}`
      : `${fmtNum(it.n)} ${portionPlural(food.unitLabel, it.n)} ${esc(food.name)}${approx}`;
  }
  return `${fmtNum(it.g)} g ${esc(food.name)}`;
};
const portionHint = f => (f.unitG ? `1 ${f.unitLabel} ≈ ${f.unitG} g` : '');
function itemMacros(it) {
  const food = foodById(it.foodId);
  if (!food) return { ...ZERO };
  const k = isUnit(food) ? (it.g || 0) : itemGrams(food, it) / 100;   // it.g = gramos, o cantidad si es por unidad
  return { kcal: food.kcal * k, p: food.p * k, c: food.c * k, f: food.f * k };
}
const mealMacros = meal => sumM(meal.items.map(itemMacros));
const dietMacros = diet => sumM(diet.meals.map(mealMacros));
const macroLine = m => `P ${fmtG(m.p)} g · C ${fmtG(m.c)} g · G ${fmtG(m.f)} g`;
// Macros de un alimento en la dieta, en corto: "P 17 · C 86 · G 9"
const itemMacroText = m => `${fmtKcal(m.kcal)} kcal · P ${fmtNum(Math.round(m.p))} · C ${fmtNum(Math.round(m.c))} · G ${fmtNum(Math.round(m.f))}`;

// Hoy: qué dieta se usa y qué comidas están marcadas
// Dietas vinculadas a días: N().dietLinks = { rest: dietId, [id de rutina]: dietId } (cada día con una sola dieta).
// Cada día se usa la de la rutina que toca según Mi plan (o la que entrenaste hoy), o la de descanso.
function dietLinks() {
  const n = N();
  if (!n.dietLinks) {
    // Antes era "días de entreno / días de descanso": se pasa a cada rutina del plan
    const links = {}, pd = n.planDiets;
    if (pd) {
      if (pd.off) links.rest = pd.off;
      if (pd.on) for (const r of db.routines) links[r.id] = pd.on;
    }
    n.dietLinks = links;
    delete n.planDiets;
  }
  return n.dietLinks;
}
function planDietToday() {
  const links = dietLinks();
  if (!Object.keys(links).length) return null;
  const t = todayKey(), planned = plannedRoutine(t);
  const trained = db.workouts.filter(w => dayKeyOf(w.date) === t).pop();
  let key, label;
  if (trained && links[trained.routineId]) { key = trained.routineId; label = `día de ${trained.routineName}`; }
  else if (planned) { key = planned.id; label = `día de ${planned.name}`; }
  else if (planned === null && !trained) { key = 'rest'; label = 'día de descanso'; }
  else return null;
  return dietById(links[key]) ? { id: links[key], label } : null;
}

// En el editor de dieta: "Usar esta dieta los días de: [Descanso] [Pierna] [Brazo]…"
function dietLinksHtml(diet) {
  const links = dietLinks();
  const opts = [['rest', 'Descanso'], ...db.routines.map(r => [r.id, r.name || '(sin nombre)'])];
  const chips = opts.map(([k, name]) => {
    const other = links[k] && links[k] !== diet.id ? dietById(links[k]) : null;
    return `<button class="chip toggle ${links[k] === diet.id ? 'on' : ''}" data-action="diet-link" data-k="${k}">${esc(name)}${other ? `<small> · en ${esc(other.name)}</small>` : ''}</button>`;
  }).join('');
  return `<section class="card stack diet-links">
      <strong>Usar esta dieta los días de</strong>
      <div class="link-chips">${chips}</div>
      <span class="muted small">Cada día la app elige sola la dieta de la rutina que te toca en tu <a href="#/programas">programa activo</a> (o la que entrenaste), o la de descanso.${db.plan ? '' : ' Para saber qué días son de descanso, elige un programa.'}</span>
    </section>`;
}

function todayNutrition() {
  const log = N().log[todayKey()], auto = planDietToday();
  // Si hoy elegiste una dieta a mano, se respeta solo hoy; si no, la del plan
  const manual = !!(log && log.manual && dietById(log.dietId)) && !(auto && log.dietId === auto.id);
  const diet = (manual && dietById(log.dietId)) || (auto && dietById(auto.id)) || dietById(log && log.dietId) || dietById(N().activeDietId) || N().diets[0] || null;
  // Cada dieta recuerda sus comidas marcadas del día, aunque cambies de una a otra
  const done = !diet || !log ? [] : (log.byDiet && log.byDiet[diet.id]) || (log.dietId === diet.id ? log.done || [] : []);
  const eaten = sumM([
    ...(diet ? diet.meals.filter(m => done.includes(m.id)).map(mealMacros) : []),
    ...todayExtras().map(extraMacros),   // lo que comiste fuera de la dieta
  ]);
  return { diet, done, eaten, goal: diet ? dietMacros(diet) : { ...ZERO }, auto, manual };
}

// Guarda el registro de hoy (y borra los de hace más de 90 días para no acumular)
function setTodayLog(dietId, done) {
  const prev = N().log[todayKey()] || {};
  N().log[todayKey()] = { ...prev, dietId, done, byDiet: { ...(prev.byDiet || {}), [dietId]: done } };   // conserva los extras
  const limit = new Date(Date.now() - 90 * 86400000);
  const min = `${limit.getFullYear()}-${String(limit.getMonth() + 1).padStart(2, '0')}-${String(limit.getDate()).padStart(2, '0')}`;
  for (const k of Object.keys(N().log)) if (k < min) delete N().log[k];
}

// Cuerpo: Peso · % Grasa · Medidas · Fotos (como las pestañas de Nutrición)
const entrenoTabs = active => `<div class="range" role="tablist">${[['rutinas', 'Rutinas'], ['programas', 'Programas'], ['historial', 'Historial'], ['progreso', 'Progreso']]
  .map(([k, label]) => `<a class="${k === active ? 'on' : ''}" href="#/${k}" role="tab">${label}</a>`).join('')}</div>`;
const bodyTabs = active => `<div class="range" role="tablist">${[['peso', 'Peso'], ['grasa', '% Grasa'], ['medidas', 'Medidas'], ['fotos', 'Fotos']]
  .map(([k, label]) => `<a class="${k === active ? 'on' : ''}" href="#/${k}" role="tab">${label}</a>`).join('')}</div>`;
const nutriTabs = active => `<div class="range" role="tablist">${[['', 'Hoy'], ['dietas', 'Mis dietas'], ['alimentos', 'Mis alimentos']]
  .map(([k, label]) => `<a class="${k === active ? 'on' : ''}" href="#/nutricion${k ? `/${k}` : ''}" role="tab">${label}</a>`).join('')}</div>`;

function viewNutrition(section) {
  if (section === 'alimentos') return viewFoods();
  if (section === 'dietas') return viewDiets();
  const { diet, done, eaten, goal, auto, manual } = todayNutrition();
  const head = `${header('Nutrición', {})}${nutriTabs('')}`;
  if (!diet) {
    const ct = calorieTarget();
    return `${head}
      <p class="muted" style="margin:4px 0 12px">Arma tu dieta en 3 pasos:</p>
      <div class="stack start-steps">
        <a class="card" href="#/objetivo"><span class="step-n">1</span><div class="grow"><strong>Calcula tus kcal objetivo</strong>
          <span class="muted small">${ct.target ? `Listo: ${fmtKcal(ct.target)} kcal al día` : 'Cuántas kcal debe tener tu dieta'}</span></div><span class="chev">›</span></a>
        <a class="card" href="#/nutricion/alimentos"><span class="step-n">2</span><div class="grow"><strong>Revisa tus alimentos</strong>
          <span class="muted small">Usa los ${BASE_FOODS.length} de la base de Desdel o crea los tuyos con su etiqueta</span></div><span class="chev">›</span></a>
        <a class="card" href="#/nutricion/dietas"><span class="step-n">3</span><div class="grow"><strong>Arma tu dieta</strong>
          <span class="muted small">Comidas con sus alimentos y cantidades</span></div><span class="chev">›</span></a>
      </div>`;
  }
  const chooser = N().diets.length > 1 ? `<div class="steps">${N().diets.map(d => `
      <button class="step ${d.id === diet.id ? 'on' : ''}" data-action="nutri-use" data-id="${d.id}">${esc(d.name)}</button>`).join('')}</div>` : '';
  const meals = diet.meals.map(meal => {
    const m = mealMacros(meal), ok = done.includes(meal.id);
    return `<section class="card meal ${ok ? 'eaten' : ''}">
      <button class="check ${ok ? 'on' : ''}" data-action="nutri-done" data-id="${meal.id}" aria-pressed="${ok}" aria-label="Marcar ${esc(meal.name)}">${ok ? '✓' : ''}</button>
      <div class="grow">
        <div class="meal-head"><strong>${esc(meal.name)}</strong><span>${fmtKcal(m.kcal)} kcal</span></div>
        <div class="muted small">${macroLine(m)}</div>
        <div class="muted small">${meal.items.map(it => { const fd = foodById(it.foodId); return fd ? itemText(fd, it) : '(alimento borrado)'; }).join(' · ') || 'Sin alimentos'}</div>
      </div>
    </section>`;
  }).join('');
  // "Hoy: Día ON · día de entreno" (según tu plan)
  const planNote = auto ? `<p class="muted small plan-diet-note">${manual
      ? `Hoy elegiste <strong>${esc(diet.name)}</strong> a mano · <button class="link" data-action="nutri-auto">volver a la del plan</button>`
      : `Hoy: <strong>${esc(diet.name)}</strong> · ${esc(auto.label)}`}</p>` : '';
  return `${head}${planNote}${chooser}
    <section class="card nutri-sum">
      <div class="water-big"><strong>${fmtKcal(eaten.kcal)}</strong> / ${fmtKcal(goal.kcal)} kcal</div>
      ${bar(eaten.kcal, goal.kcal)}
      <div class="macros">
        <span>Proteína<br><strong>${fmtG(eaten.p)}</strong> / ${fmtG(goal.p)} g</span>
        <span>Carbos<br><strong>${fmtG(eaten.c)}</strong> / ${fmtG(goal.c)} g</span>
        <span>Grasas<br><strong>${fmtG(eaten.f)}</strong> / ${fmtG(goal.f)} g</span>
      </div>
      ${targetLine(goal.kcal)}
    </section>
    <h2>${esc(diet.name)} · toca ✓ cuando comas</h2>
    ${meals || '<p class="empty">Esta dieta no tiene comidas.</p>'}
    ${extrasSection()}`;
}

let foodQuery = '';
function viewFoods() {
  const foods = N().foods.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const list = foods.map(f => `
    <a class="card" href="#/alimento/${f.id}" data-search="${esc(normText(`${f.name} ${synonymsOf(f.name)}`))}">
      <div class="grow"><strong>${esc(f.name)}</strong>
        <span class="muted small">${fmtKcal(f.kcal)} kcal · P ${fmtG(f.p)} · C ${fmtG(f.c)} · G ${fmtG(f.f)} <span class="per">${perText(f)}</span></span>
      </div><span class="chev">›</span>
    </a>`).join('');
  return `${header('Nutrición', {})}${nutriTabs('alimentos')}
    <div class="ex-actions foods-top"><a class="btn primary center" href="#/alimento/nuevo">+ Nuevo alimento</a>
      <button class="btn scan-wide" data-action="scan">${BARCODE_ICON}Escanear código</button></div>
    <input class="search" type="search" data-bind="food-search" value="${esc(foodQuery)}" placeholder="🔍 Buscar en mis alimentos y en la base…" autocomplete="off" aria-label="Buscar alimento">
    <div class="food-list">${list || '<p class="empty">Todavía no agregas alimentos propios. Al armar tu dieta puedes usar los de la base de Desdel, o crear los tuyos con su etiqueta.</p>'}</div>
    <div class="base-results"></div>
    <p class="muted hint">Desdel incluye ${BASE_FOODS.length} alimentos comunes con valores aproximados por 100 g. Búscalos arriba; si quieres ajustar uno, tócalo y guárdalo como tuyo.</p>`;
}

function filterFoods() {
  const q = normText(foodQuery.trim());
  const words = q.split(/\s+/).filter(Boolean), sing = w => (w.length > 4 ? w.replace(/(es|s)$/, '') : w);
  $app.querySelectorAll('.food-list [data-search]').forEach(a => {
    const parts = a.dataset.search.split(/[^a-z0-9%]+/);
    a.hidden = words.length > 0 && !words.every(w => parts.some(x => x.startsWith(w) || x.startsWith(sing(w))));
  });
  const box = $app.querySelector('.base-results');
  if (!box) return;
  const base = q ? searchFoods(foodQuery, 30).filter(f => f.base) : [];
  box.innerHTML = base.length
    ? `<h2>De la base de Desdel (aprox.)</h2>${base.map(f => `<a class="card" href="#/alimento/nuevo/${encodeURIComponent(f.id)}">
        <div class="grow"><strong>${esc(f.name)}</strong>
          <span class="muted small">${fmtKcal(f.kcal)} kcal · P ${fmtG(f.p)} · C ${fmtG(f.c)} · G ${fmtG(f.f)} <span class="per">por 100 g</span></span></div>
        <span class="chev">›</span></a>`).join('')}`
    : '';
}

function viewFoodForm(id, fromId) {
  const food = id === 'nuevo' ? null : N().foods.find(f => f.id === id);
  if (id !== 'nuevo' && !food) { location.replace('#/nutricion/alimentos'); return ''; }
  const from = !food && fromId ? BASE_BY_ID.get(decodeURIComponent(fromId)) : null;   // copia desde la base
  const src = food || from;
  const v = k => (src ? toField(src[k]) : '');
  const field = (name, label, unit) => `<label class="field"><span>${label}</span>
      <div class="add-row" style="margin-top:0"><input name="${name}" inputmode="decimal" value="${v(name)}" autocomplete="off"><span class="unit-label">${unit}</span></div></label>`;
  const unit = isUnit(src);
  return `${header(food ? 'Editar alimento' : 'Nuevo alimento', { back: true })}
    <form class="stack card food-form" data-form="food" data-id="${food ? food.id : ''}" novalidate>
      ${from ? '<p class="muted small" style="margin:0">Copiado de la base de Desdel (valores aproximados). Ajústalo con tu etiqueta y guárdalo.</p>' : ''}
      <label class="field"><span>Nombre</span><input name="name" value="${src ? esc(src.name) : ''}" placeholder="Ej. Carne molida 10% grasa" autocomplete="off"></label>
      <div class="field"><span>Los valores son</span>
        <div class="per-choice">
          <label><input type="radio" name="per" value="100g" ${unit ? '' : 'checked'}> Por 100 g</label>
          <label><input type="radio" name="per" value="unit" ${unit ? 'checked' : ''}> Por unidad</label>
        </div>
      </div>
      <p class="muted small per-hint" style="margin:0">Escribe los macros de <strong class="when-100">100 g</strong><strong class="when-unit">1 unidad</strong> del alimento.</p>
      ${field('p', 'Proteínas', 'g')}
      ${field('c', 'Carbohidratos', 'g')}
      ${field('f', 'Grasas', 'g')}
      ${field('kcal', 'Calorías (si lo dejas vacío se calcula con los macros)', 'kcal')}
      <p class="form-msg" hidden></p>
      <button class="btn primary block">Guardar alimento</button>
    </form>
    ${food ? '<button class="btn ghost block danger-text" data-action="food-del" style="margin-top:16px">Eliminar alimento</button>' : ''}`;
}

function saveFood(f) {
  const name = f.elements.name.value.trim();
  const val = k => num(f.elements[k].value);
  const p = val('p'), c = val('c'), fat = val('f');
  if (!name) return formMsg(f, 'Escribe el nombre del alimento.');
  const unit = f.elements.per.value === 'unit';
  if ([p, c, fat].some(x => x == null || x < 0 || x > (unit ? 300 : 100))) {
    return formMsg(f, unit ? 'Escribe proteínas, carbohidratos y grasas en gramos de 1 unidad.' : 'Escribe proteínas, carbohidratos y grasas en gramos por 100 g (entre 0 y 100).');
  }
  let kcal = val('kcal');
  if (kcal == null) kcal = Math.round(p * 4 + c * 4 + fat * 9);       // 4 kcal por g de proteína y carbo, 9 por g de grasa
  if (kcal < 0 || kcal > (unit ? 3000 : 1000)) return formMsg(f, unit ? 'Revisa las calorías de 1 unidad.' : 'Las calorías por 100 g deben estar entre 0 y 1000.');
  const data = { name, kcal: round1(kcal), p: round1(p), c: round1(c), f: round1(fat) };
  if (unit) data.per = 'unit';
  const existing = f.dataset.id && N().foods.find(x => x.id === f.dataset.id);
  if (existing) {
    const changed = isUnit(existing) !== unit;
    delete existing.per; delete existing.unitName;
    Object.assign(existing, data);
    const used = N().diets.some(d => d.meals.some(m => m.items.some(it => it.foodId === existing.id)));
    if (changed && used) notice(`Cambiaste "${name}" a ${unit ? 'por unidad' : 'por 100 g'}. Revisa las cantidades en tus dietas: ahora se cuentan en ${unit ? 'unidades' : 'gramos'}.`);
  } else {
    N().foods.push({ id: uid(), ...data });
  }
  save();
  goBack();
}

// Promedio diario según tu plan: cada día del ciclo con la dieta que le toca (ej. Día ON ×9 + Día OFF ×5, ÷ 14)
function planDietAverage() {
  const p = db.plan, links = dietLinks();
  if (!p || !Object.keys(links).length) return null;
  const count = new Map();
  let total = 0, missing = 0, sum = { ...ZERO };
  for (const wk of p.days.slice(0, p.weeks)) {
    for (const id of wk.r) {
      total++;
      const routineOk = id && db.routines.some(r => r.id === id);
      const diet = dietById(links[routineOk ? id : 'rest']);
      if (!diet) { missing++; continue; }
      count.set(diet, (count.get(diet) || 0) + 1);
      sum = sumM([sum, dietMacros(diet)]);
    }
  }
  const days = total - missing;
  if (!days) return null;
  return { avg: { kcal: sum.kcal / days, p: sum.p / days, c: sum.c / days, f: sum.f / days }, count, total, missing };
}

function averageCard() {
  const a = planDietAverage();
  if (!a) return '';
  const ct = calorieTarget(), diff = ct.target ? Math.round(a.avg.kcal - ct.target) : null;
  const parts = [...a.count].map(([d, n]) => `${esc(d.name)} ×${n}`).join(' + ');
  return `<section class="card stack avg-card">
      <span class="muted small">Promedio diario según tu plan</span>
      <div class="target-kcal"><strong>${fmtKcal(a.avg.kcal)} kcal</strong> al día</div>
      <span class="muted small">${macroLine(a.avg)}</span>
      <span class="muted small">${parts} en ${plural(a.total / 7, 'semana')} (${a.total} días)${a.missing ? ` · ${plural(a.missing, 'día')} sin dieta asignada (no se cuenta${a.missing === 1 ? '' : 'n'})` : ''}</span>
      ${diff != null ? `<span class="muted small">Kcal objetivo: ${fmtKcal(ct.target)} · ${Math.abs(diff) < 50 ? 'calza' : `${diff > 0 ? '+' : '−'}${fmtKcal(Math.abs(diff))} al día`}</span>` : ''}
    </section>`;
}

// Tarjeta "Tus kcal objetivo: 2.750 kcal" (lleva a la pantalla del cálculo)
function targetBanner() {
  const ct = calorieTarget();
  return `<a class="card target-banner" href="#/objetivo">
      <div class="grow">${ct.target
        ? `<span class="muted small">Tus kcal objetivo</span>
           <div class="target-kcal"><strong>${fmtKcal(ct.target)} kcal</strong> al día</div>
           <span class="muted small">${ct.pace === 0 ? 'Mantener' : `${paceLabel(ct.pace)} al mes`} · Proteína ${Math.round(ct.kg * 1.6)}–${Math.round(ct.kg * 2)} g</span>`
        : `<strong>Calcula tus kcal objetivo</strong>
           <span class="muted small">Para saber cuántas kcal debe tener tu dieta</span>`}</div>
      <span class="chev">›</span>
    </a>`;
}

function viewDiets() {
  const active = todayNutrition().diet;
  const list = N().diets.map(d => {
    const m = dietMacros(d);
    return `<a class="card" href="#/dieta/${d.id}">
      <div class="grow"><strong>${esc(d.name)}${active && active.id === d.id ? ' <span class="badge on">Hoy</span>' : ''}</strong>
        <span class="muted small">${plural(d.meals.length, 'comida')} · ${fmtKcal(m.kcal)} kcal · ${macroLine(m)}</span></div>
      <span class="chev">›</span>
    </a>`;
  }).join('');
  return `${header('Nutrición', {})}${nutriTabs('dietas')}
    ${targetBanner()}
    ${averageCard()}
    <button class="btn primary block" data-action="diet-new" style="margin:0 0 12px">+ Crear dieta</button>
    ${list || `<p class="empty">${N().foods.length ? 'Crea tu primera dieta.' : 'Todavía no tienes dietas. Toca "+ Crear dieta" para armar la primera.'}</p>`}
    ${importForm('Importar dieta con código', 'dieta')}`;
}

function viewDietEditor(id) {
  const diet = dietById(id);
  if (!diet) { location.replace('#/nutricion/dietas'); return ''; }
  const total = dietMacros(diet);
  const meals = diet.meals.map((meal, mi) => {
    const m = mealMacros(meal);
    const items = meal.items.map((it, ii) => {
      const food = foodById(it.foodId), im = itemMacros(it);
      return `<div class="item-row">
        <span class="grow">${esc(food ? food.name : '(alimento borrado)')}
          <span class="item-macros muted" data-item-macros="${mi}-${ii}">${itemMacroText(im)}</span></span>
        <input class="grams" inputmode="decimal" data-bind="item-g" data-m="${mi}" data-i="${ii}" value="${toField(food && byPortion(food, it) ? it.n : it.g)}" aria-label="${food && (isUnit(food) || byPortion(food, it)) ? 'Cantidad' : 'Gramos'}">
        ${food && food.unitG
          ? `<button type="button" class="chip mode-chip" data-action="item-mode" data-m="${mi}" data-i="${ii}" title="${portionHint(food)}" aria-label="Cambiar entre gramos y unidades">${byPortion(food, it) ? 'u' : 'g'}</button>`
          : `<span class="unit-label">${isUnit(food) ? 'u' : 'g'}</span>`}
        <button class="icon small danger" data-action="item-del" data-m="${mi}" data-i="${ii}" aria-label="Quitar">${TRASH_ICON}</button>
      </div>`;
    }).join('');
    return `<section class="card meal-edit">
      <div class="meal-title">
        <input class="grow" data-bind="meal-name" data-m="${mi}" value="${esc(meal.name)}" aria-label="Nombre de la comida">
        <button class="icon small" data-action="meal-dup" data-m="${mi}" aria-label="Duplicar comida" title="Duplicar comida">⧉</button>
        <button class="icon small danger" data-action="meal-del" data-m="${mi}" aria-label="Eliminar comida">${TRASH_ICON}</button>
      </div>
      ${items || '<p class="muted small" style="margin:6px 0">Agrega alimentos a esta comida.</p>'}
      <form class="add-item" data-form="add-item" data-m="${mi}" novalidate>
        <div class="add-row" style="margin-top:0">
          <button type="button" class="icon scan-btn" data-action="scan" aria-label="Escanear código de barras">${BARCODE_ICON}</button>
          <input name="q" data-bind="food-q" data-m="${mi}" placeholder="🔍 Buscar alimento…" autocomplete="off" aria-label="Buscar alimento">
          <input name="g" inputmode="decimal" placeholder="g" class="grams" aria-label="Gramos">
          <button type="button" class="chip mode-chip" data-action="add-mode" hidden aria-label="Cambiar entre gramos y unidades">u</button>
          <button class="btn">+</button>
        </div>
        <div class="food-results" data-results="${mi}"></div>
      </form>
      <div class="meal-total" data-meal-total="${mi}"><strong>${fmtKcal(m.kcal)} kcal</strong> · ${macroLine(m)}</div>
    </section>`;
  }).join('');
  return `${header('Editar dieta', { back: true })}
    <label class="field"><span>Nombre de la dieta</span><input data-bind="diet-name" value="${esc(diet.name)}" autocomplete="off"></label>
    ${dietLinksHtml(diet)}
    <section class="card nutri-sum" style="margin-top:12px">
      <div class="muted small">Total de la dieta</div>
      <div data-diet-total><strong class="big">${fmtKcal(total.kcal)} kcal</strong><div class="muted small">${macroLine(total)}</div></div>
      <div data-diet-target>${dietTargetHtml(total.kcal)}</div>
    </section>
    ${meals}
    <button class="btn block" data-action="meal-add">+ Agregar comida ${diet.meals.length + 1}</button>
    <p class="muted hint">¿Falta un alimento? <a href="#/alimento/nuevo">Créalo aquí</a> y vuelve.</p>
    <button class="btn primary block" data-action="diet-done" style="margin-top:20px">Terminar dieta</button>
    ${shareBox(diet.id, 'Tu alumno toca el link y la dieta se le agrega sola (o ingresa el código en Nutrición → Mis dietas → "Importar dieta con código"). Se comparten las comidas, las cantidades y los alimentos que creaste tú. Si después cambias la dieta, comparte un código nuevo.')
      || '<button class="btn block" data-action="share-diet">Compartir dieta</button>'}
    <button class="btn ghost block danger-text" data-action="diet-del">Eliminar dieta</button>`;
}


// Ajusta el formulario de agregar según el modo (gramos o unidades) del alimento elegido
function setAddMode(form, food) {
  const units = isUnit(food) || (food.unitG && form.dataset.mode === 'u');
  const chip = form.querySelector('[data-action="add-mode"]');
  chip.textContent = form.dataset.mode === 'u' ? 'u' : 'g';
  chip.title = portionHint(food);
  form.elements.g.placeholder = units ? 'cant.' : 'g';
  form.elements.g.setAttribute('aria-label', units ? 'Cantidad' : 'Gramos');
}

// Actualiza los totales mientras cambias gramos (sin redibujar, para no cerrar el teclado)
// Barra "2.180 / 2.750 kcal del objetivo · faltan 570" en el editor de dietas
function dietTargetHtml(kcal) {
  const ct = calorieTarget();
  if (!ct.target) return '<a class="target-line" href="#/objetivo">Calcula tus kcal objetivo para saber cuántas debe tener esta dieta ›</a>';
  const diff = Math.round(ct.target - kcal);
  const status = Math.abs(diff) < 50 ? 'calza con tu objetivo' : diff > 0 ? `faltan ${fmtKcal(diff)}` : `te pasas por ${fmtKcal(-diff)}`;
  return `<div class="diet-target">
      <div class="goal-top"><span class="muted small"><strong>${fmtKcal(kcal)}</strong> / ${fmtKcal(ct.target)} kcal del objetivo</span>
        <span class="muted small">${status}</span></div>
      ${bar(kcal, ct.target)}
      <a class="muted small" href="#/objetivo">Ver cómo se calcula ›</a>
    </div>`;
}

function paintDietTotals(diet) {
  diet.meals.forEach((meal, mi) => {
    meal.items.forEach((it, ii) => {
      const mac = $app.querySelector(`[data-item-macros="${mi}-${ii}"]`);
      if (mac) mac.textContent = itemMacroText(itemMacros(it));
    });
    const m = mealMacros(meal), el = $app.querySelector(`[data-meal-total="${mi}"]`);
    if (el) el.innerHTML = `<strong>${fmtKcal(m.kcal)} kcal</strong> · ${macroLine(m)}`;
  });
  const t = dietMacros(diet), el = $app.querySelector('[data-diet-total]');
  if (el) el.innerHTML = `<strong class="big">${fmtKcal(t.kcal)} kcal</strong><div class="muted small">${macroLine(t)}</div>`;
  const tg = $app.querySelector('[data-diet-target]');
  if (tg) tg.innerHTML = dietTargetHtml(t.kcal);
}


function nutritionCard() {
  // Mirando a un alumno: solo el acceso (si cumplió la dieta se ve en su semana)
  if (viewing) return `<a class="card hub" href="#/nutricion"><div class="hub-top"><span class="hub-icon">🍽️</span><strong>Nutrición</strong><span class="chev">›</span></div></a>`;
  const t = todayNutrition();
  return `<a class="card hub" href="#/nutricion">
    <div class="hub-top"><span class="hub-icon">🍽️</span><strong>Nutrición</strong></div>
    ${t.diet
      ? `<div class="hub-value"><strong>${fmtKcal(t.eaten.kcal)} / ${fmtKcal(t.goal.kcal)}</strong> kcal</div>${bar(t.eaten.kcal, t.goal.kcal)}`
      : '<span class="muted">Crea tus alimentos y tu dieta</span>'}
  </a>`;
}

// ---------- Kcal objetivo (referencia) ----------
// Metabolismo basal: Katch-McArdle si tienes % de grasa (usa tu masa magra); si no, Mifflin-St Jeor (peso, estatura, edad, sexo).
// Gasto del día = basal × actividad. Objetivo = gasto ± 7.700 kcal por kg al ritmo que elijas.
const ACTIVITY = [
  ['sed', 'Sedentario', 'Poco o nada de ejercicio', 1.2],
  ['lig', 'Ligero', 'Ejercicio 1 a 3 días por semana', 1.375],
  ['mod', 'Moderado', 'Ejercicio 3 a 5 días por semana', 1.55],
  ['alt', 'Alto', 'Ejercicio 6 a 7 días por semana', 1.725],
  ['muy', 'Muy alto', 'Entrenas fuerte a diario o tu trabajo es físico', 1.9],
];
// Ritmo en kg al mes (1 kg al mes ≈ 7.700 ÷ 30,4 ≈ 253 kcal al día)
const KCAL_PER_KG = 7700, DAYS_PER_MONTH = 30.4;   // 1 kg al mes ≈ 7.700 ÷ 30,4 ≈ 253 kcal al día
const paceLabel = v => (v === 0 ? 'Mantener' : `${v < 0 ? 'Bajar' : 'Subir'} ${fmtNum(Math.abs(v))} kg`);
// Ritmo en kg al mes (negativo = bajar). Antes era por semana: se pasa a kg al mes
const paceMonth = b => b.paceMonth ?? (b.pace != null ? round1((b.pace * DAYS_PER_MONTH) / 7) : 0);
// Cuánto (sin signo): el del ritmo actual, o el último que escribiste si ahora estás en Mantener
const paceAmount = b => Math.abs(paceMonth(b)) || b.paceAmt || 0.5;
const round10 = n => Math.round(n / 10) * 10;
const fmt1 = n => fmtNum(round1(n));
const activityOf = b => ACTIVITY.find(x => x[0] === b.activity) || ACTIVITY[2];

function calorieTarget() {
  const b = db.body, last = db.bodyweight[db.bodyweight.length - 1];
  const bf = currentBf();
  const age = b.birthYear ? new Date().getFullYear() - b.birthYear : null;
  if (!last || (bf == null && (!b.heightCm || !b.sex || !age))) {
    const missing = [];
    if (!last) missing.push(['tu peso', '#/peso']);
    if (bf == null) {
      if (!b.heightCm) missing.push(['tu estatura', '#/cuenta']);
      if (!b.sex) missing.push(['tu sexo', '#/cuenta']);
      if (!age) missing.push(['tu año de nacimiento', '#/cuenta']);
    }
    return { missing };
  }
  // steps: líneas del desglose [nombre, fórmula usada, cuenta, resultado]
  const kg = last.kg, steps = [];
  let bmr;
  if (bf != null) {
    const lean = kg * (1 - bf / 100);
    bmr = 370 + 21.6 * lean;
    steps.push(['Metabolismo basal', '(Fórmula Katch-McArdle)', `370 + 21,6 × ${fmt1(lean)} kg de masa magra`, `${fmtKcal(bmr)} kcal`]);
  } else {
    bmr = 10 * kg + 6.25 * b.heightCm - 5 * age + (b.sex === 'h' ? 5 : -161);
    steps.push(['Metabolismo basal', '(Fórmula Mifflin-St Jeor)',
      `10 × ${fmt1(kg)} kg + 6,25 × ${b.heightCm} cm − 5 × ${age} años ${b.sex === 'h' ? '+ 5' : '− 161'}`, `${fmtKcal(bmr)} kcal`]);
  }
  const act = activityOf(b), tdee = bmr * act[3];
  steps.push([`Actividad (${act[1]})`, '', `${fmtKcal(bmr)} × ${fmtNum(act[3])}`, `${fmtKcal(tdee)} kcal`]);
  const pm = paceMonth(b), adj = (pm * KCAL_PER_KG) / DAYS_PER_MONTH;
  if (pm) steps.push(['Ritmo', '', `${pm > 0 ? '+' : '−'}${fmtNum(Math.abs(pm))} kg al mes × 7.700 ÷ 30,4`, `${adj > 0 ? '+' : '−'}${fmtKcal(Math.abs(adj))} kcal`]);
  const target = round10(tdee + adj);
  return { bmr: round10(bmr), tdee: round10(tdee), target, pace: pm, kg, katch: bf != null, low: target < bmr, steps };
}

// "Objetivo calculado: 2.250 kcal · tu dieta +150"
function targetLine(dietKcal) {
  const ct = calorieTarget();
  if (!ct.target) return '<a class="target-line" href="#/objetivo">Calcula tus kcal objetivo ›</a>';
  const diff = Math.round(dietKcal - ct.target);
  const cmp = Math.abs(diff) < 50 ? 'Tu dieta calza con tu objetivo calculado'
    : `Tu dieta tiene ${fmtKcal(Math.abs(diff))} kcal ${diff > 0 ? 'más' : 'menos'} que tu objetivo calculado`;
  return `<a class="target-line" href="#/objetivo">${cmp} ›</a>`;
}

function viewTarget() {
  const ct = calorieTarget(), b = db.body, pm = paceMonth(b), act = activityOf(b);
  const dir = pm < 0 ? 'Bajar' : pm > 0 ? 'Subir' : 'Mantener';
  const result = ct.missing
    ? `<p class="muted card">Para calcularlo falta ${ct.missing.map(([t, href]) => `<a href="${href}">${t}</a>`).join(', ').replace(/, ([^,]*)$/, ' y $1')}.
        <br><span class="small">Si anotas tu % de grasa en <a href="#/grasa">Cuerpo → % Grasa</a>, basta con tu peso.</span></p>`
    : `<section class="card stack target-card">
        <div class="water-big"><strong>${fmtKcal(ct.target)}</strong> kcal al día</div>
        <span class="muted">${ct.pace === 0 ? 'Para mantener tu peso' : `Para ${paceLabel(ct.pace).toLowerCase()} al mes`}</span>
        ${ct.low ? '<p class="goal-hint" style="color:var(--danger)">Ojo: queda bajo tu metabolismo basal. Mejor elige un ritmo más lento.</p>' : ''}
        <div class="prog-row"><span class="muted">Proteína sugerida</span><span>${Math.round(ct.kg * 1.6)}–${Math.round(ct.kg * 2)} g al día</span></div>
      </section>
      <h2>Cómo se calcula</h2>
      <section class="card breakdown">
        ${ct.steps.map(([name, sub, formula, value]) => `<div class="bd-row">
          <div><strong>${name}</strong>${sub ? `<div class="muted small">${sub}</div>` : ''}${formula ? `<div class="muted small">${formula}</div>` : ''}</div>
          <span class="bd-val">${value}</span>
        </div>`).join('')}
        <div class="bd-row bd-total"><strong>Objetivo</strong><span class="bd-val">${fmtKcal(ct.target)} kcal</span></div>
      </section>`;

  return `${header('Kcal objetivo', { back: true, sub: 'Referencia para armar tu dieta' })}
    ${result}
    <h2>¿Qué quieres?</h2>
    <section class="card stack">
      <div class="pace-sentence">
        <button class="btn pace-dir" data-action="pace-dir" aria-label="Cambiar entre Bajar, Mantener y Subir">${dir}</button>
        ${pm ? `<input data-bind="pace-amt" inputmode="decimal" value="${toField(Math.abs(pm))}" autocomplete="off" aria-label="Cuántos kg al mes">
        <span>kg al mes</span>` : ''}
      </div>
      <span class="muted small">Toca la palabra para cambiar entre Bajar, Mantener y Subir.</span>
    </section>
    <h2>Nivel de actividad</h2>
    <div class="stack">${ACTIVITY.map(([k, name, desc]) => `<button class="card choice ${k === act[0] ? 'on' : ''}" data-action="set-activity" data-v="${k}">
      <strong>${name}</strong><span class="muted small">${desc}</span></button>`).join('')}</div>
    <p class="muted hint">Cada kg equivale a unas 7.700 kcal. Es una estimación: ajústala según cómo cambie tu peso.</p>`;
}

// Bajar → Mantener → Subir → Bajar (el cuánto se recuerda al pasar por Mantener)
function nextPaceDir() {
  const b = db.body, pm = paceMonth(b), amt = paceAmount(b);
  b.paceAmt = amt;
  b.paceMonth = pm < 0 ? 0 : pm === 0 ? amt : -amt;
  delete b.pace;
}
// Escribir cuánto: se guarda si es válido (hasta 6 kg al mes para bajar y 4 para subir)
function setPaceAmount(el) {
  const v = num(el.value), b = db.body, pm = paceMonth(b);
  if (v == null || v <= 0 || v > (pm < 0 ? 6 : 4)) return;
  b.paceAmt = round1(v);
  b.paceMonth = pm < 0 ? -round1(v) : round1(v);
  delete b.pace;
}

// ---------- Extras fuera de la dieta ----------
// Se guardan en el registro del día: { id, foodId, g | n } (alimento) o { id, name, kcal, p, c, f } (a mano)
let extraMode = null;   // null | 'food' | 'manual'
const todayExtras = () => (N().log[todayKey()] || {}).extras || [];
function extraMacros(x) {
  return x.foodId ? itemMacros(x) : { kcal: x.kcal || 0, p: x.p || 0, c: x.c || 0, f: x.f || 0 };
}
function extraText(x) {
  if (!x.foodId) return esc(x.name);
  const fd = foodById(x.foodId);
  return fd ? itemText(fd, x) : '(alimento borrado)';
}
function addExtra(item) {
  const day = (N().log[todayKey()] ||= { dietId: null, done: [] });
  (day.extras ||= []).push({ id: uid(), ...item });
  extraMode = null;
  save();
  render();
}

function extrasSection() {
  const list = todayExtras().map(x => {
    const m = extraMacros(x);
    return `<div class="prog-row">
      <span class="grow">${extraText(x)}</span>
      <span class="bw-right">${fmtKcal(m.kcal)} kcal
        <button class="icon small danger" data-action="extra-del" data-id="${x.id}" aria-label="Quitar extra">${TRASH_ICON}</button></span>
    </div>`;
  }).join('');
  const form = extraMode === 'food'
    ? `<form class="add-item" data-form="extra-food" novalidate>
        <div class="add-row" style="margin-top:0">
          <button type="button" class="icon scan-btn" data-action="scan" aria-label="Escanear código de barras">${BARCODE_ICON}</button>
          <input name="q" data-bind="food-q" placeholder="🔍 Buscar alimento…" autocomplete="off" aria-label="Buscar alimento">
          <input name="g" inputmode="decimal" placeholder="g" class="grams" aria-label="Gramos">
          <button type="button" class="chip mode-chip" data-action="add-mode" hidden aria-label="Cambiar entre gramos y unidades">u</button>
          <button class="btn">+</button>
        </div>
        <div class="food-results"></div>
      </form>`
    : extraMode === 'manual'
      ? `<form class="stack" data-form="extra-manual" novalidate>
          <input name="name" placeholder="¿Qué comiste? (ej. Completo)" autocomplete="off" aria-label="Qué comiste">
          <div class="extra-macros">
            <label class="field"><span>Calorías</span><input name="kcal" inputmode="numeric" placeholder="kcal" autocomplete="off"></label>
            <label class="field"><span>Prot.</span><input name="p" inputmode="decimal" placeholder="g" autocomplete="off"></label>
            <label class="field"><span>Carbos</span><input name="c" inputmode="decimal" placeholder="g" autocomplete="off"></label>
            <label class="field"><span>Grasas</span><input name="f" inputmode="decimal" placeholder="g" autocomplete="off"></label>
          </div>
          <p class="muted small" style="margin:0">Solo el nombre y las calorías son obligatorios.</p>
          <p class="form-msg" hidden></p>
          <button class="btn primary block">Agregar</button>
        </form>`
      : '';
  return `<h2>Extras de hoy</h2>
    <section class="card stack">
      ${list || '<p class="muted small" style="margin:0">Lo que comas fuera de tu dieta se suma al día.</p>'}
      <div class="ex-actions extra-modes">
        <button class="btn ${extraMode === 'food' ? 'primary' : ''}" data-action="extra-mode" data-v="food">Buscar alimento</button>
        <button class="btn ${extraMode === 'manual' ? 'primary' : ''}" data-action="extra-mode" data-v="manual">Anotar a mano</button>
      </div>
      ${form}
    </section>`;
}

// Lee el formulario de buscar alimento (dieta o extras): { foodId, g } o { foodId, n }, o null si falta algo
// Elegir un alimento en el buscador de una comida o de los extras (al tocarlo en la lista, o al escanearlo)
function pickFoodIn(form, id) {
  const food = foodById(id);
  if (!form || !food) return;
  form.dataset.food = id;
  form.elements.q.value = food.name;
  form.querySelector('.food-results').innerHTML = '';
  // Alimentos de la base con porción: por defecto se anotan en unidades (se puede cambiar a gramos)
  const chip = form.querySelector('[data-action="add-mode"]');
  chip.hidden = !food.unitG;
  form.dataset.mode = food.unitG ? 'u' : 'g';
  setAddMode(form, food);
  form.elements.g.focus();
}

// ---------- Escanear código de barras ----------
// Con la cámara (en Android el teléfono lo lee solo; en iPhone se carga un lector) o escribiendo el número.
// Busca primero en tus alimentos (por su código) y si no en Open Food Facts, una base abierta con valores por 100 g.
// Lo revisas, se guarda en tus alimentos con su código y queda elegido donde lo escaneaste.
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
const TRASH_ICON = '<svg class="trash" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2l1-12M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7"/></svg>';
const BARCODE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V4h3M18 4h3v3M21 17v3h-3M6 20H3v-3M7 8v8M10 8v8M13 8v8M15.5 8v8M18 8v8"/></svg>';
const $scan = document.createElement('div');
$scan.hidden = true;
document.body.appendChild($scan);
let scanCtx = null, scanPushed = false;   // { target, stream, reader, timer }
const loadScript = src => new Promise((ok, fail) => {
  if (document.querySelector(`script[src="${src}"]`) && window.ZXing) return ok();
  const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = fail; document.head.appendChild(sc);
});
const scanMsg = t => { const m = $scan.querySelector('.scan-msg'); if (m) m.textContent = t; };
function stopCamera(ctx) {
  if (!ctx) return;
  clearTimeout(ctx.timer);
  if (ctx.reader) try { ctx.reader.reset(); } catch (e) { /* ya estaba detenido */ }
  if (ctx.stream) ctx.stream.getTracks().forEach(t => t.stop());
  ctx.stream = null; ctx.reader = null;
}
function openScanner(target) {
  closeScanner();
  scanCtx = { target };
  $scan.innerHTML = `<div class="modal-wrap scan-wrap">
    <div class="modal-back" data-scan="close"></div>
    <section class="modal card scan-modal" role="dialog" aria-modal="true" aria-label="Escanear código de barras">
      <div class="guide-head"><h2>Escanear código</h2><button class="icon small" data-scan="close" aria-label="Cerrar">✕</button></div>
      <div class="scan-view"><video playsinline muted></video><div class="scan-frame"></div></div>
      <p class="muted small scan-msg" style="margin:0">Abriendo la cámara…</p>
      <form class="add-row scan-code" style="margin:0" novalidate>
        <input name="code" inputmode="numeric" placeholder="O escribe el número del código" autocomplete="off" aria-label="Número del código de barras">
        <button class="btn">Buscar</button>
      </form>
      <div class="scan-result"></div>
    </section></div>`;
  $scan.hidden = false;
  history.pushState({ scan: 1 }, ''); scanPushed = true;   // "atrás" cierra el escáner
  startCamera(scanCtx);
}
function closeScanner() {
  if (!scanCtx) return;
  stopCamera(scanCtx);
  scanCtx = null;
  $scan.hidden = true; $scan.innerHTML = '';
  if (scanPushed) { scanPushed = false; history.back(); }
}
window.addEventListener('popstate', () => { if (scanPushed) { scanPushed = false; closeScanner(); } });
async function startCamera(ctx) {
  const view = $scan.querySelector('.scan-view'), video = $scan.querySelector('video');
  const noCam = t => { scanMsg(t); if (view) view.hidden = true; };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return noCam('Aquí no se puede usar la cámara. Escribe el número que está bajo las barras.');
  try { ctx.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
  catch (e) { return noCam('No se pudo abrir la cámara (revisa el permiso). Puedes escribir el número que está bajo las barras.'); }
  if (scanCtx !== ctx) return stopCamera(ctx);
  video.srcObject = ctx.stream;
  await video.play().catch(() => {});
  scanMsg('Apunta al código de barras del envase.');
  if ('BarcodeDetector' in window) {
    const bd = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
    const tick = async () => {
      if (scanCtx !== ctx || !ctx.stream) return;
      try { const r = await bd.detect(video); if (r[0] && r[0].rawValue) return scanFound(ctx, r[0].rawValue); } catch (e) { /* cuadro sin código */ }
      ctx.timer = setTimeout(tick, 250);
    };
    tick();
    return;
  }
  try { await loadScript(ZXING_URL); } catch (e) { return scanMsg('Sin internet no se puede leer el código con la cámara. Escribe el número.'); }
  if (scanCtx !== ctx || !window.ZXing) return;
  const Z = window.ZXing, hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
  ctx.reader = new Z.BrowserMultiFormatReader(hints);
  ctx.reader.decodeFromVideoElementContinuously(video, res => { if (res && scanCtx === ctx) scanFound(ctx, res.getText()); });
}
function scanFound(ctx, code) {
  stopCamera(ctx);
  if (navigator.vibrate) navigator.vibrate(60);
  lookupBarcode(code);
}
const offNum = (n, k) => { const v = Number(n[`${k}_100g`]); return Number.isFinite(v) ? round1(v) : null; };
async function lookupBarcode(raw) {
  const code = String(raw).replace(/\D/g, ''), ctx = scanCtx;
  if (!ctx) return;
  if (code.length < 8) { scanMsg('Ese número es muy corto: los códigos tienen 8 o 13 dígitos.'); return; }
  stopCamera(ctx);
  const view = $scan.querySelector('.scan-view'); if (view) view.hidden = true;
  const mine = N().foods.find(f => f.barcode === code);
  if (mine) return useScannedFood(mine);
  scanMsg(`Código ${code} · buscando…`);
  let prod = null, offline = false;
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_es,brands,nutriments`);
    const j = await r.json();
    if (j && j.status === 1 && j.product) {
      const n = j.product.nutriments || {};
      let kcal = offNum(n, 'energy-kcal');
      if (kcal == null && offNum(n, 'energy') != null) kcal = Math.round(offNum(n, 'energy') / 4.184);
      const brand = (j.product.brands || '').split(',')[0].trim();
      const name = (j.product.product_name_es || j.product.product_name || '').trim();
      prod = { name: [name, brand && !normText(name).includes(normText(brand)) ? brand : ''].filter(Boolean).join(' · '),
        kcal, p: offNum(n, 'proteins'), c: offNum(n, 'carbohydrates'), f: offNum(n, 'fat') };
    }
  } catch (e) { offline = true; }
  if (scanCtx !== ctx) return;
  scanMsg(prod ? `Código ${code} · encontrado en Open Food Facts` : offline ? `Código ${code} · sin internet para buscarlo` : `Código ${code} · no está en la base`);
  const v = k => (prod && prod[k] != null ? toField(prod[k]) : '');
  const field = (k, label, unit) => `<label class="field"><span>${label}</span>
      <div class="add-row" style="margin-top:0"><input name="${k}" inputmode="decimal" value="${v(k)}" autocomplete="off"><span class="unit-label">${unit}</span></div></label>`;
  $scan.querySelector('.scan-code').hidden = true;
  $scan.querySelector('.scan-result').innerHTML = `<form class="stack scan-food" data-code="${code}" novalidate>
      <p class="small" style="margin:0">${prod ? 'Revisa que coincida con la etiqueta (valores por 100 g). Los datos los sube la comunidad y a veces tienen errores.'
        : 'Cópialo de la etiqueta del envase, por 100 g. Queda guardado con su código: la próxima vez lo encuentras al escanear.'}</p>
      <label class="field"><span>Nombre</span><input name="name" value="${esc(prod ? prod.name : '')}" placeholder="Ej. Yoghurt protein frutilla" autocomplete="off"></label>
      ${field('p', 'Proteínas', 'g')}${field('c', 'Carbohidratos', 'g')}${field('f', 'Grasas', 'g')}
      ${field('kcal', 'Calorías (si lo dejas vacío se calcula con los macros)', 'kcal')}
      <p class="form-msg" hidden></p>
      <button class="btn primary block">Guardar${ctx.target ? ' y usar' : ''}</button>
      <button type="button" class="btn ghost block" data-scan="again">Escanear otro</button>
    </form>`;
}
function saveScanned(f) {
  const val = k => num(f.elements[k].value), name = f.elements.name.value.trim();
  const p = val('p'), c = val('c'), fat = val('f');
  if (!name) return formMsg(f, 'Escribe el nombre del alimento.');
  if ([p, c, fat].some(x => x == null || x < 0 || x > 100)) return formMsg(f, 'Escribe proteínas, carbohidratos y grasas por 100 g (entre 0 y 100).');
  let kcal = val('kcal');
  if (kcal == null) kcal = Math.round(p * 4 + c * 4 + fat * 9);
  if (kcal < 0 || kcal > 1000) return formMsg(f, 'Las calorías por 100 g deben estar entre 0 y 1000.');
  const food = { id: uid(), name, kcal: round1(kcal), p: round1(p), c: round1(c), f: round1(fat), barcode: f.dataset.code };
  N().foods.push(food);
  save();
  useScannedFood(food);
}
function useScannedFood(food) {
  const t = scanCtx && scanCtx.target;
  closeScanner();
  const form = t && $app.querySelector(t.m != null ? `[data-form="add-item"][data-m="${t.m}"]` : `[data-form="${t.form}"]`);
  if (form) { pickFoodIn(form, food.id); showNote(`${food.name}: escribe los gramos`); }
  else { render(); showNote(`Guardado en tus alimentos: ${food.name}`); }
}
$scan.addEventListener('click', e => {
  const a = e.target.closest('[data-scan]');
  if (!a) return;
  if (a.dataset.scan === 'close') closeScanner();
  else if (a.dataset.scan === 'again') openScanner(scanCtx && scanCtx.target);
});
$scan.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.matches('.scan-code')) lookupBarcode(e.target.elements.code.value);
  else if (e.target.matches('.scan-food')) saveScanned(e.target);
});

function readFoodForm(f) {
  const typed = normText(f.elements.q.value.trim());
  const exact = typed && [...N().foods, ...BASE_FOODS].find(x => normText(x.name) === typed);
  const foodId = f.dataset.food || (exact && exact.id), g = num(f.elements.g.value);
  if (!foodId) { notice('Busca el alimento y elígelo de la lista.'); f.elements.q.focus(); return null; }
  const food = foodById(foodId), portions = !!food.unitG && f.dataset.mode === 'u' && f.dataset.food === foodId;
  const count = isUnit(food) || portions;
  if (g == null || g <= 0 || g > (count ? 100 : 5000)) { notice(count ? 'Escribe la cantidad (ej. 2).' : 'Escribe los gramos (ej. 120).'); f.elements.g.focus(); return null; }
  return portions ? { foodId, n: round1(g) } : { foodId, g: round1(g) };
}

// ---------- Agua ----------
const fmtL = ml => fmtNum(Math.round(ml / 100) / 10);
const waterDay = (key = todayKey()) => db.water.days[key] || [];
const waterToday = () => waterDay().reduce((a, e) => a + e.ml, 0);

// Meta: la que escribas, o 35 ml por kg de tu último peso anotado (si no hay peso, 2,5 L)
function waterGoal() {
  if (db.water.goalMl) return { ml: db.water.goalMl, auto: false };
  const last = db.bodyweight[db.bodyweight.length - 1];
  return last ? { ml: Math.round((last.kg * 35) / 100) * 100, auto: true, kg: last.kg } : { ml: 2500, auto: true };
}

// Botones rápidos con los ml que elijas (ej. tu vaso de 200 ml y tu botella de 750 ml); hasta 4
const DEFAULT_QUICK = [{ name: 'Vaso', ml: 250 }, { name: 'Botella', ml: 500 }];
const waterQuick = () => (db.water.quick && db.water.quick.length ? db.water.quick : DEFAULT_QUICK);
function ensureQuick() {
  if (!db.water.quick || !db.water.quick.length) db.water.quick = DEFAULT_QUICK.map(q => ({ ...q }));
  return db.water.quick;
}
// Mientras escribes no se redibuja (para no cerrar el teclado); la cantidad solo se guarda si es válida
function setQuick(el) {
  const q = ensureQuick()[+el.dataset.k];
  if (!q) return;
  const ml = Math.round(num(el.value) || 0);
  if (ml >= 10 && ml <= 5000) q.ml = ml;
}
let waterEditing = null;   // registro de hoy que estás corrigiendo (posición en la lista)

// Racha: días seguidos cumpliendo la meta (si hoy todavía no la cumples, cuenta hasta ayer)
function waterStreak() {
  const goal = waterGoal().ml, d = new Date();
  const met = () => waterDay(dayKeyOf(d)).reduce((a, e) => a + e.ml, 0) >= goal;
  if (!met()) d.setDate(d.getDate() - 1);
  let n = 0;
  while (met() && n < 3650) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function addWater(ml) {
  const key = todayKey(), entry = { at: new Date().toISOString(), ml };
  (db.water.days[key] ||= []).push(entry);
  save(); render();
  showUndo(`+${ml} ml de agua`, () => {
    const list = db.water.days[key], k = list ? list.indexOf(entry) : -1;
    if (k >= 0) { list.splice(k, 1); if (!list.length) delete db.water.days[key]; save(); render(); }
  });
}

function viewWater() {
  const ml = waterToday(), g = waterGoal(), streak = waterStreak(), quick = waterQuick();
  const hhmmOf = at => new Date(at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const entries = waterDay().map((e, k) => (waterEditing === k
    ? `<form class="prog-row water-edit" data-form="water-edit" data-k="${k}" novalidate>
        <span class="muted">${hhmmOf(e.at)}</span>
        <span class="bw-right">
          <input name="ml" class="grams" inputmode="numeric" value="${e.ml}" aria-label="Cantidad en ml"><span class="unit-label">ml</span>
          <button class="btn primary small-btn">Guardar</button>
          <button type="button" class="icon small" data-action="water-edit-cancel" aria-label="Cancelar">✕</button>
        </span>
      </form>`
    : `<div class="prog-row">
        <span class="muted">${hhmmOf(e.at)}</span>
        <span class="bw-right">${e.ml} ml
          <button class="icon small" data-action="water-edit" data-k="${k}" aria-label="Corregir">✏️</button>
          <button class="icon small danger" data-action="water-del" data-k="${k}" aria-label="Borrar">${TRASH_ICON}</button>
        </span>
      </div>`)).reverse().join('');

  // Últimos 7 días (si en esos días anotaste algo)
  const days = [];
  let any7 = false;
  for (let k = 6; k >= 0; k--) {
    const d = new Date(); d.setDate(d.getDate() - k);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const total = waterDay(key).reduce((a, e) => a + e.ml, 0);
    if (total) any7 = true;
    days.push(`<div class="water-day">
      <span class="muted">${k === 0 ? 'hoy' : d.toLocaleDateString('es', { weekday: 'short', day: 'numeric' })}</span>
      ${bar(total, g.ml)}
      <span>${fmtL(total)} L</span>
    </div>`);
  }

  return `${header('Agua', { back: true, sub: 'Se reinicia cada día' })}
    <section class="card water-now">
      <div class="water-big"><strong>${fmtL(ml)}</strong> / ${fmtL(g.ml)} L</div>
      ${bar(ml, g.ml)}
      <div class="muted">${ml >= g.ml ? '¡Meta cumplida! 🎉' : `Te faltan ${fmtL(g.ml - ml)} L`}</div>
      ${streak ? `<div class="streak">🔥 ${streak === 1 ? '1 día cumpliendo tu meta' : `${streak} días seguidos cumpliendo tu meta`}</div>` : ''}
      <div class="ex-actions water-btns">
        ${quick.map(q => `<button class="btn primary" data-action="water-add" data-ml="${q.ml}">+${q.ml} ml</button>`).join('')}
      </div>
      <form class="add-row" data-form="water-custom" novalidate>
        <input name="ml" inputmode="numeric" placeholder="Otra cantidad (ml)" autocomplete="off" aria-label="Cantidad en ml">
        <button class="btn">Agregar</button>
      </form>
    </section>

    ${entries ? `<h2>Hoy</h2><section class="card">${entries}</section>` : ''}

    ${any7 ? `<h2>Últimos 7 días</h2>
    <section class="card">${days.join('')}</section>` : ''}

    ${sectionHead('agua-ajustes', 'Ajustes: botones rápidos y meta diaria')}
    ${openSections.has('agua-ajustes') ? `
    <h2>Botones rápidos</h2>
    <section class="card stack">
      <p class="muted small" style="margin:0">Pon los ml de tu vaso, botella o shaker para anotar de un toque.</p>
      ${quick.map((q, k) => `<div class="add-row quick-row" style="margin-top:0">
        <span class="grow muted">Botón ${k + 1}</span>
        <input class="grams" data-bind="wq-ml" data-k="${k}" inputmode="numeric" value="${q.ml}" autocomplete="off" aria-label="Cantidad en ml del botón ${k + 1}">
        <span class="unit-label">ml</span>
        <button class="icon small danger" data-action="wq-del" data-k="${k}" ${quick.length <= 1 ? 'disabled' : ''} aria-label="Quitar botón">${TRASH_ICON}</button>
      </div>`).join('')}
      ${quick.length < 4 ? '<button class="btn ghost" data-action="wq-add">+ Agregar botón</button>' : ''}
    </section>

    <h2>Meta diaria</h2>
    <form class="stack card" data-form="water-goal" novalidate>
      <p class="muted" style="margin:0">${g.auto
        ? (g.kg ? `Calculada con tu peso: 35 ml × ${fmtNum(g.kg)} kg = ${fmtL(g.ml)} L` : 'Anota tu peso en Cuerpo para calcularla. Por ahora: 2,5 L')
        : `Meta personalizada: ${fmtL(g.ml)} L`}</p>
      <div class="add-row" style="margin-top:0">
        <input name="liters" inputmode="decimal" placeholder="Litros (ej. 3)" value="${g.auto ? '' : fmtL(g.ml)}" autocomplete="off" aria-label="Meta en litros">
        <button class="btn">Guardar</button>
      </div>
      ${g.auto ? '' : '<button type="button" class="btn ghost" data-action="water-auto">Usar la meta calculada con mi peso</button>'}
      <p class="form-msg" hidden></p>
    </form>` : ''}`;
}

// Última vez que se hizo un ejercicio (antes de la posición `before` del historial)
function lastFor(exerciseId, before = db.workouts.length, rid = null) {
  for (let i = before - 1; i >= 0; i--) {
    const w = db.workouts[i];
    if (rid && w.routineId !== rid) continue;
    const ex = w.exercises.find(e => e.exerciseId === exerciseId);
    if (ex) return { date: w.date, ex };
  }
  return null;
}

// Todas las veces que se hizo un ejercicio, de la más reciente a la más antigua
function historyFor(exerciseId, skipId = null) {
  const rows = [];
  for (const w of db.workouts) {
    if (w.id === skipId) continue;
    const ex = w.exercises.find(e => e.exerciseId === exerciseId);
    if (ex) rows.push({ w, ex });
  }
  return rows.reverse();
}

// Series al empezar: vacías, con lo de la última vez en gris (pw, pr, prir) como referencia.
// Al guardar, lo que dejaste vacío se completa con lo de la vez pasada; un ejercicio sin nada anotado no se guarda.
// Si el objetivo pide más series que la última vez, las nuevas traen de referencia la última serie.
function prefillSets(prev, rir, goalSets = 0, dropset = false) {
  const ph = s => ({ w: '', r: '', ...(rir ? { rir: '' } : {}), pw: toField(s.w), pr: toField(s.r), ...(rir && s.rir != null ? { prir: toField(s.rir) } : {}) });
  const sets = prev ? prev.ex.sets.map(s => ({
    ...ph(s),
    ...(s.drops && s.drops.length ? { drops: s.drops.map(x => ({ w: '', r: '', pw: toField(x.w), pr: toField(x.r) })) } : {}),
  })) : [];
  while (sets.length < Math.max(1, goalSets || 0)) {
    const last = sets[sets.length - 1];
    sets.push(last ? { w: '', r: '', ...(rir ? { rir: '' } : {}), pw: last.pw, pr: last.pr } : { w: '', r: '', ...(rir ? { rir: '' } : {}) });
  }
  // Dropset: la última serie trae lista una fila para la primera bajada
  const lastSet = sets[sets.length - 1];
  if (dropset && !(lastSet.drops && lastSet.drops.length)) lastSet.drops = [{ w: '', r: '' }];
  return sets;
}
// Lo que vale de una serie: lo escrito o, si está vacío, lo de la vez pasada
const effSet = s => ({ w: s.w !== '' && s.w != null ? s.w : s.pw ?? '', r: s.r !== '' && s.r != null ? s.r : s.pr ?? '', rir: s.rir !== '' && s.rir != null ? s.rir : s.prir ?? '' });
// Peso corporal (dominadas, fondos…): el lastre vacío es 0, no el de la vez pasada
const lastreEx = ex => ex.unit !== 'placas' && isBwEx(ex);
const bwEff = (s, bw) => { const e = effSet(s); return bw && (s.w === '' || s.w == null) ? { ...e, w: '0' } : e; };
const typedSet = s => (s.w !== '' && s.w != null) || (s.r !== '' && s.r != null);
// La serie se guarda si tiene algo: lo que escribiste o, si no, lo de la vez pasada (para borrar una serie que no hiciste: el basurero)
const setCounts = s => { const e = effSet(s); return e.w !== '' || e.r !== ''; };
// Siguiente serie: trae de referencia la anterior
const nextSet = (sets, rir) => { const last = sets[sets.length - 1], e = last ? effSet(last) : null;
  return { w: '', r: '', ...(rir ? { rir: '' } : {}), ...(e && e.w !== '' ? { pw: e.w } : {}), ...(e && e.r !== '' ? { pr: e.r } : {}) }; };

// Objetivo opcional por ejercicio: series, rango de reps ("8-10") y RIR objetivo ("2" o "1-2")
function parseRange(text, maxV) {
  const m = String(text).trim().match(/^(\d{1,3})(?:\s*(?:-|–|a|,|\.|\/|\s)\s*(\d{1,3}))?$/i);
  if (!m) return null;
  const a = +m[1], b = m[2] != null ? +m[2] : a;
  if (b > maxV || b < a) return null;
  return a === b ? `${a}` : `${a}-${b}`;
}
const rangeTop = t => +String(t).split('-').pop();
// Plan del ejercicio en la rutina: objetivo, dropset y superset con el siguiente
const planFields = ex => ({ ...goalFields(ex), ...(ex.dropset ? { dropset: true } : {}), ...(ex.ssNext ? { ssNext: true } : {}), ...(ex.bw ? { bw: true } : {}), ...(ex.guide ? { guide: ex.guide } : {}) });
// Repeticiones distintas por serie: ex.goalRepsBy[j] (vacío = el rango general de Reps)
const hasRepsBy = ex => (ex.goalSets || 0) >= 2 && Array.isArray(ex.goalRepsBy) && ex.goalRepsBy.slice(0, ex.goalSets).some(Boolean);
const repsFor = (ex, j) => (hasRepsBy(ex) ? ex.goalRepsBy[j] || '' : ex.goalReps || '');
// RIR objetivo distinto por serie (con "Distinto por serie" y RIR activado): ex.goalRirBy[j]
const hasRirBy = ex => !!ex.rir && (ex.goalSets || 0) >= 2 && Array.isArray(ex.goalRirBy) && ex.goalRirBy.slice(0, ex.goalSets).some(Boolean);
const rirFor = (ex, j) => (hasRirBy(ex) ? ex.goalRirBy[j] || '' : ex.goalRir || '');
const rirText = ex => (hasRirBy(ex) ? ex.goalRirBy.slice(0, ex.goalSets).map(x => x || '–').join(' / ') : ex.goalRir || '');
const goalFields = ex => ({
  ...(ex.goalSets ? { goalSets: ex.goalSets } : {}),
  ...(ex.goalReps ? { goalReps: ex.goalReps } : {}),
  ...(hasRepsBy(ex) ? { goalRepsBy: ex.goalRepsBy.slice(0, ex.goalSets || ex.goalRepsBy.length) } : {}),
  ...(ex.goalRir ? { goalRir: ex.goalRir } : {}),
  ...(hasRirBy(ex) ? { goalRirBy: ex.goalRirBy.slice(0, ex.goalSets) } : {}),
});

// Texto de una serie guardada: "40 kg × 10" o "40 kg × 10 · RIR 2"
const dropsText = s => (s.drops && s.drops.length ? s.drops.map(x => ` ↓ ${fmtNum(x.w)}×${fmtNum(x.r)}`).join('') : '');
const setText = (s, unit) => `${fmtNum(s.w)} ${unit} × ${fmtNum(s.r)}${s.rir != null ? ` · RIR ${fmtNum(s.rir)}` : ''}${dropsText(s)}`;
const setsChips = ex => `<div class="sets-list">${ex.sets.map(s => `<span>${setText(s, ex.unit)}</span>`).join('')}</div>`;

const unitSelect = () => `<select name="unit" aria-label="Unidad">
  <option ${lastUnit === 'kg' ? 'selected' : ''}>kg</option>
  <option ${lastUnit === 'lb' ? 'selected' : ''}>lb</option>
  <option ${lastUnit === 'placas' ? 'selected' : ''}>placas</option>
</select>`;

function noteHtml(exerciseId, i) {
  const note = db.notes[exerciseId] || '';
  let inner;
  if (editingNote === exerciseId) {
    inner = `<input class="note-input" data-bind="note" data-i="${i}" value="${esc(note)}" placeholder="Ej. altura asiento 7" enterkeyhint="done" autocomplete="off">`;
  } else if (note) {
    inner = `<button class="note" data-action="edit-note" data-i="${i}">${esc(note)}</button>`;
  } else {
    inner = `<button class="note add" data-action="edit-note" data-i="${i}">+ nota</button>`;
  }
  return `<div class="note-wrap" data-note="${i}">${inner}</div>`;
}

const routeParts = () => location.hash.replace(/^#\/?/, '').split('/');
const curRoutine = () => db.routines.find(r => r.id === routeParts()[1]);
const isEditing = () => routeParts()[0] === 'editar';
// Sesión con la que se trabaja: el entrenamiento en curso o la copia de uno guardado
const cur = () => (isEditing() ? editBuf : db.draft);
// Posición en el historial hasta donde se compara (al editar, solo con lo anterior a esa sesión)
const beforeIndex = d => (d.editOf ? db.workouts.findIndex(w => w.id === d.editOf) : db.workouts.length);

// ---------- Pantallas ----------
function viewHome() {
  const d = db.draft;
  const resume = d ? `
    <a class="card resume" href="#/entrenar">
      <div class="grow"><strong>Entrenamiento en curso</strong><span class="muted">${esc(d.routineName)}</span></div>
      <span class="chev">›</span>
    </a>` : '';
  const last = db.routines.length - 1, todays = plannedRoutine(todayKey());
  const lastDone = id => { for (let k = db.workouts.length - 1; k >= 0; k--) if (db.workouts[k].routineId === id) return db.workouts[k].date; return ''; };
  const routines = db.routines.map((r, i) => {
    const at = lastDone(r.id);
    return `
    <div class="card routine">
      <a href="#/rutina/${r.id}">
        <strong>${esc(r.name) || '(sin nombre)'}${todays && todays.id === r.id ? ' <span class="badge on">Hoy</span>' : ''}</strong>
        <span class="muted small">${plural(r.exercises.length, 'ejercicio')}</span>${at ? `<span class="muted small" title="Última vez que la hiciste">${esc(agoText(at)[0].toUpperCase() + agoText(at).slice(1))}</span>` : ''}
      </a>
      ${routineSort ? `<div class="order">
        <button class="icon small" data-action="move-routine" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir rutina">↑</button>
        <button class="icon small" data-action="move-routine" data-i="${i}" data-d="1" ${i === last ? 'disabled' : ''} aria-label="Bajar rutina">↓</button>
      </div>` : `<a class="btn center routine-edit" href="#/rutina/${r.id}">Editar</a>
      <button class="btn primary" data-action="start" data-id="${r.id}" ${r.exercises.length ? '' : 'disabled'}>Empezar</button>`}
    </div>`;
  }).join('')
    + (last > 0 ? `<button class="link small routine-sort" data-action="routine-sort">${routineSort ? 'Listo' : 'Ordenar rutinas'}</button>` : '')
    + (guideRenames().length ? '<button class="link small routine-sort" data-action="rename-to-guides">Usar los nombres de la técnica</button>' : '')
    + (deletedRoutines().length ? `<button class="link small routine-sort" data-action="restore-open">${restoreOpen ? 'Ocultar rutinas borradas' : 'Recuperar una rutina borrada'}</button>
      ${restoreOpen ? `<section class="card restore-list">${deletedRoutines().map(x => `<div class="prog-row"><span class="grow"><strong>${esc(x.name)}</strong>
        <span class="muted small">${plural(x.count, 'entreno')} · última vez ${esc(agoText(x.date))}</span></span>
        <button class="btn small-btn" data-action="restore-routine" data-id="${esc(x.id)}">Recuperar</button></div>`).join('')}</section>` : ''}` : '');
  const free = d ? '' : routines
    ? '<button class="btn block" data-action="start-free" style="margin:0 0 12px">Entrenar sin rutina</button>'
    : `<section class="card stack free-start">
        <strong>¿Vas a entrenar ahora?</strong>
        <span class="muted small">Anota tus ejercicios a medida que los haces, sin armar nada antes.</span>
        <button class="btn primary block" data-action="start-free">Entrenar sin rutina</button>
        <a class="btn block center" href="#/programas">Elegir un programa</a>
      </section>`;
  return `${header('Entreno', {})}${entrenoTabs('rutinas')}
    ${resume}
    ${free}
    ${routines || '<p class="empty">O arma tu propia rutina: escribe su nombre abajo.</p>'}
    <form class="add-row" data-form="new-routine">
      <input name="title" placeholder="Nueva rutina (ej. Brazo)" autocomplete="off" required>
      <button class="btn">Crear</button>
    </form>
    ${importForm('Importar rutina con código', 'rutina')}`;
}

// Formulario para pegar un código (sirve tanto para rutinas como para dietas)
// kind: qué se espera importar en esa pantalla ('rutina', 'dieta' o 'gymbro'), para el botón y el mensaje de error
const importForm = (label, kind = '') => `<section class="import-box">
    <div class="muted small">${label}</div>
    ${importOpen ? `
    <form class="stack" data-form="import-code" data-kind="${kind}" novalidate>
      <div class="add-row">
        <input name="code" placeholder="Código (ej. K7P-9XQ)" autocomplete="off" autocapitalize="characters" maxlength="9" aria-label="Código">
        <button class="btn">${kind === 'gymbro' ? 'Agregar' : 'Importar'}</button>
      </div>
      <p class="muted small" style="margin:0">Escribe el código que te pasaron y toca ${kind === 'gymbro' ? 'Agregar' : 'Importar'}.</p>
      <p class="form-msg" hidden></p>
    </form>`
    : '<button class="btn block" data-action="paste-import">📋 Pegar código</button>'}
  </section>`;

// Saca el código de lo copiado: el código solo ("K7P-9XQ"), el link (?r=K7P9XQ) o el mensaje completo
function codeFromText(text) {
  const t = (text || '').toUpperCase();
  const m = t.match(/[?&][RGK]=([A-Z0-9]{6})\b/) || t.match(/\b([A-Z0-9]{3})-([A-Z0-9]{3})\b/) || t.trim().match(/^([A-Z0-9]{3})\s*-?\s*([A-Z0-9]{3})$/);
  return m ? m.slice(1).join('') : '';
}

// "Pegar código": lee lo copiado e importa de una vez; si no hay un código copiado, se abre el cuadro para escribirlo
async function pasteImport() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch (e) { /* el teléfono no dejó leer lo copiado */ }
  const code = codeFromText(text);
  importOpen = true;
  render();
  const f = $app.querySelector('[data-form="import-code"]');
  if (!code) {
    f.elements.code.focus();
    if (text.trim()) formMsg(f, 'Lo que copiaste no es un código de Desdel.');
    return;
  }
  f.elements.code.value = fmtCode(code);
  importRoutine(f);
}

// Secciones plegables (quedan abiertas o cerradas mientras usas la app)
const openSections = new Set();
const sectionHead = (key, title) => {
  const open = openSections.has(key);
  return `<button class="sec-head ${open ? 'open' : ''}" data-action="toggle-sec" data-k="${key}" aria-expanded="${open}">
    <span>${title}</span><span class="sec-arrow">${open ? '▴' : '▾'}</span></button>`;
};

const moreBtn = (key, total) => (total > 7
  ? `<button class="btn ghost block" data-action="toggle-sec" data-k="${key}">${openSections.has(key) ? 'Ver menos' : `Ver todos (${total})`}</button>` : '');

let openEx = null;   // ejercicio abierto en el editor de rutina (los demás se ven como resumen)
// Alternativa abierta en el editor (dentro del ejercicio openEx), y si al tocar Listo se vuelve al entreno
let altEdit = null, editReturn = false;
const edEx = i => { const ex = curRoutine().exercises[i], a = altEdit && ex && (ex.alts || []).find(x => x.id === altEdit); return a || ex; };
const repsByOpen = new Set();   // ejercicios con "Distinto por serie" activado (aunque todavía no tengan rangos)
const repsByOn = ex => (ex.goalSets || 0) >= 2 && (repsByOpen.has(ex.id) || hasRepsBy(ex) || hasRirBy(ex));
// Casilla Reps: normal, o "Por serie" cuando cada serie tiene su rango
const repsCell = (ex, i) => (repsByOn(ex)
  ? '<div class="goal-fixed-wrap"><span>Reps</span><span class="goal-fixed">Por serie</span></div>'
  : `<label>Reps<input data-bind="ex-goal-reps" data-i="${i}" inputmode="decimal" value="${esc(ex.goalReps || '')}" placeholder="8-10" autocomplete="off" aria-label="Rango de repeticiones objetivo"></label>`);
// Casilla RIR obj.: normal, "Por serie" (cada serie con el suyo) o "Fallo" sin RIR
const rirCell = (ex, i) => (!ex.rir
  ? '<div class="goal-fixed-wrap"><span>Hasta</span><span class="goal-fixed" title="Activa RIR para poner un RIR objetivo">Fallo</span></div>'
  : repsByOn(ex)
    ? '<div class="goal-fixed-wrap"><span>RIR obj.</span><span class="goal-fixed">Por serie</span></div>'
    : `<label>RIR obj.<input data-bind="ex-goal-rir" data-i="${i}" inputmode="decimal" value="${esc(ex.goalRir || '')}" placeholder="–" autocomplete="off" aria-label="RIR objetivo"></label>`);
// Una casilla por serie (se redibuja sola al cambiar el número de series); con RIR, una fila por serie: reps y RIR
const repsByBlock = (ex, i) => (ex.goalSets && ex.rir
  ? `<div class="reps-by rir-by" data-i="${i}"><span></span><span>Repeticiones</span><span>RIR</span>${Array.from({ length: ex.goalSets }, (_, j) => `<span>Serie ${j + 1}</span>
      <input data-bind="ex-repby" data-i="${i}" data-j="${j}" inputmode="decimal" value="${esc((ex.goalRepsBy || [])[j] || '')}" placeholder="8-10" autocomplete="off" aria-label="Repeticiones de la serie ${j + 1}">
      <input data-bind="ex-rirby" data-i="${i}" data-j="${j}" inputmode="decimal" value="${esc((ex.goalRirBy || [])[j] || '')}" placeholder="–" autocomplete="off" aria-label="RIR de la serie ${j + 1}">`).join('')}</div>`
  : ex.goalSets
  ? `<div class="reps-by" data-i="${i}">${Array.from({ length: ex.goalSets }, (_, j) => `<label><span>Serie ${j + 1}</span>
      <input data-bind="ex-repby" data-i="${i}" data-j="${j}" inputmode="decimal" value="${esc((ex.goalRepsBy || [])[j] || '')}" placeholder="8-10" autocomplete="off" aria-label="Repeticiones de la serie ${j + 1}"></label>`).join('')}</div>`
  : `<p class="muted small reps-by" data-i="${i}">Pon cuántas Series para escribir el rango de cada una.</p>`);
// ⓘ: explicación corta de una palabra técnica (se abre y se cierra al tocarla)
const INFO = {
  rm: '1RM = el peso máximo que podrías levantar 1 vez. Desdel lo estima con tu 1ª serie (peso y repeticiones), así ves si te estás haciendo más fuerte aunque cambies las repeticiones.',
  rir: 'RIR = repeticiones en reserva: cuántas más podrías haber hecho con buena técnica. RIR 2 es que te quedaban 2; RIR 0, que no podías hacer otra. No es lo mismo que el fallo: al fallo intentas otra repetición y no la completas.',
  opts: 'RIR: al entrenar anotas cuántas repeticiones te quedaban en cada serie (y puedes ponerle un RIR objetivo). Dropset: la última serie trae una fila para anotar la bajada de peso. Peso corporal: para dominadas, fondos y similares; lo que anotas es el lastre.',
};
const infoOpen = new Set();
const infoBtn = k => `<button class="info-btn ${infoOpen.has(k) ? 'on' : ''}" data-action="info" data-k="${k}" aria-label="¿Qué es?" aria-expanded="${infoOpen.has(k)}">ⓘ</button>`;
const infoBox = k => (infoOpen.has(k) ? `<p class="info-box">${INFO[k]}</p>` : '');
let routineSort = false;
// Miniatura del video de técnica en Editar rutina: tocarla lo reproduce ahí mismo (sin video: un recuadro vacío)
const thumbOf = g => g.video.replace('videos/', 'videos/thumbs/').replace(/\.mp4$/, '.jpg');
const exThumb = ex => { const g = guideFor(ex.name, ex.guide);
  return g && g.video
    ? `<button type="button" class="ex-thumb" data-action="thumb-play" aria-label="Ver el video de ${esc(g.name)}"><video src="${esc(g.video)}" poster="${esc(thumbOf(g))}" muted loop playsinline preload="none"></video><span class="ex-thumb-play" aria-hidden="true"></span></button>`
    : '<span class="ex-thumb none" aria-hidden="true">Sin video</span>'; };   // Rutinas: modo para cambiar el orden (flechas en vez de Editar / Empezar)

// "4 × 8-10 · RIR 2 · Dropset · Rest 1:30"
function exSummary(ex) {
  const parts = [];
  if (ex.goalSets && hasRepsBy(ex)) parts.push(`${ex.goalSets} × ${Array.from({ length: ex.goalSets }, (_, j) => repsFor(ex, j) || '–').join(' / ')}`);
  else if (ex.goalSets && ex.goalReps) parts.push(`${ex.goalSets} × ${ex.goalReps}`);
  else if (ex.goalSets) parts.push(plural(ex.goalSets, 'serie'));
  else if (ex.goalReps) parts.push(`${ex.goalReps} reps`);
  if (ex.rir) parts.push(rirText(ex) ? `RIR ${rirText(ex)}` : 'Con RIR');
  else if (ex.goalSets || ex.goalReps) parts.push('Al fallo');
  if (ex.dropset) parts.push('Dropset');
  if (ex.bw) parts.push('Peso corporal');
  if (ex.rest) parts.push(`Rest ${fmtRest(ex.rest)}`);
  if (ex.unit !== 'kg') parts.push(ex.unit);
  return parts.join(' · ') || 'Toca para configurar';
}

function viewRoutine() {
  const r = curRoutine();
  if (!r) { location.replace('#/rutinas'); return ''; }
  const last = r.exercises.length - 1;
  const blocks = groupsOf(r), blockOf = k => blocks.findIndex(g => g.includes(k));   // ↑↓ mueven el bloque (superset) completo
  const items = r.exercises.map((ex0, i) => {
    const alt = openEx === i && altEdit ? (ex0.alts || []).find(a => a.id === altEdit) : null, ex = alt || ex0;
    return (openEx === i ? `
    <li class="card ex-open">
      ${alt ? `<div class="alt-head muted small">Alternativa de <strong>${esc(ex0.name)}</strong> · la eliges con Cambiar al entrenar</div>` : ''}
      <input class="grow" data-bind="ex-name" data-i="${i}" value="${esc(ex.name)}" aria-label="Nombre del ejercicio">
      <button class="chip" data-action="toggle-unit" data-i="${i}" aria-label="Cambiar unidad">${ex.unit}</button>
      ${alt ? '<span class="grow"></span>' : `<button class="icon" data-action="move" data-i="${i}" data-d="-1" ${blockOf(i) === 0 ? 'disabled' : ''} aria-label="Subir">↑</button>
      <button class="icon" data-action="move" data-i="${i}" data-d="1" ${blockOf(i) === blocks.length - 1 ? 'disabled' : ''} aria-label="Bajar">↓</button>`}
      <button class="icon danger" data-action="del-ex" data-i="${i}" aria-label="${alt ? 'Quitar alternativa' : 'Quitar'}">${TRASH_ICON}</button>
      <div class="ex-goals" aria-label="Objetivo (opcional)">
        <label>Series<input data-bind="ex-goal-sets" data-i="${i}" inputmode="numeric" value="${ex.goalSets || ''}" placeholder="–" autocomplete="off" aria-label="Series objetivo"></label>
        <div class="reps-cell" data-i="${i}">${repsCell(ex, i)}</div>
        <div class="reps-cell rir-cell" data-i="${i}">${rirCell(ex, i)}</div>
        <label>Rest<input data-bind="ex-rest" data-i="${i}" value="${ex.rest ? fmtRest(ex.rest) : ''}" placeholder="m:ss" autocomplete="off" aria-label="Descanso entre series"></label>
      </div>
      <div class="reps-by-wrap" data-i="${i}">${repsByOn(ex) ? repsByBlock(ex, i) : ''}</div>
      <button class="link small reps-by-toggle" data-action="reps-by" data-i="${i}" ${ex.goalSets >= 2 ? '' : 'hidden'}>${repsByOn(ex) ? 'Usar un solo rango' : 'Distinto por serie'}</button>
      <div class="ex-toggles">
        <button class="chip toggle ${ex.rir ? 'on' : ''}" data-action="toggle-rir" data-i="${i}" aria-pressed="${!!ex.rir}">RIR</button>
        <button class="chip toggle ${ex.dropset ? 'on' : ''}" data-action="toggle-drop" data-i="${i}" aria-pressed="${!!ex.dropset}">Dropset</button>
        <button class="chip toggle ${ex.bw ? 'on' : ''}" data-action="toggle-bw" data-i="${i}" aria-pressed="${!!ex.bw}" title="Dominadas, dips…: lo que anotas es el lastre">Peso corporal</button>
      </div>
      <button class="link small" data-action="info" data-k="opts" style="justify-self:start">${infoOpen.has('opts') ? 'Ocultar' : '¿Qué hace cada opción?'}</button>
      ${infoBox('opts')}
      ${(g => {
        // Elegida por ti o con el mismo nombre: está bien. Conectada por un nombre parecido: puede ser otra
        const sure = g && ((ex.guide && ex.guide !== 'none') || guideKey(g.name) === guideKey(ex.name));
        return `<div class="ex-guide"><span class="muted small">Técnica: ${g ? `<strong>${esc(g.name)}</strong>${sure ? ' ✓' : ''}` : 'sin guía'}</span>
          ${sure ? '' : `<button class="link small" data-action="guide-pick" data-i="${i}">${g ? '¿Es otro? Cambiar' : 'Elegir guía'}</button>`}</div>`;
      })(guideFor(ex.name, ex.guide))}
      ${!alt && (ex.alts || []).length ? `<div class="ex-alts"><span class="muted small">Alternativas (las eliges con Cambiar al entrenar)</span>
        <div class="ex-alts-list">${ex.alts.map(a => `<button class="chip" data-action="alt-open" data-i="${i}" data-id="${a.id}">${esc(a.name)} ›</button>`).join('')}</div></div>` : ''}
      ${i < last && !alt ? `<button class="chip toggle ss-toggle ${ex.ssNext ? 'on' : ''}" data-action="toggle-ss" data-i="${i}" aria-pressed="${!!ex.ssNext}">🔗 ${ex.ssNext ? 'En superset con el siguiente' : 'Hacer superset con el siguiente'}</button>` : ''}
      <button class="btn block ex-done" data-action="ex-close">Listo</button>
    </li>`
    : `
    <li class="card ex-closed" data-action="ex-open" data-i="${i}" role="button" tabindex="0">
      ${exThumb(ex)}
      <div class="grow"><strong>${esc(ex.name) || '(sin nombre)'}</strong>
        ${zoneOf(ex) ? `<span class="ex-zone-chip">${zoneOf(ex)}</span>` : ''}
        <span class="muted small">${exSummary(ex)}</span></div>
      <button class="btn small-btn ex-edit-btn" data-action="ex-open" data-i="${i}">Editar</button>
    </li>`)
    + (i < last && ex0.ssNext ? '<li class="ss-join">🔗 Superset</li>' : ''); }).join('');
  return `${header('Editar rutina', { back: true })}
    <label class="field"><span>Nombre de la rutina</span>
      <input data-bind="routine-name" value="${esc(r.name)}" autocomplete="off">
    </label>
    <section class="card stack edit-hint" style="margin-top:14px">
      <span class="muted small">Aquí armas la rutina: ejercicios, series y repeticiones. Los pesos de cada serie se anotan al entrenar.</span>
      <button class="btn primary block" data-action="start" data-id="${r.id}" ${r.exercises.length ? '' : 'disabled'}>Empezar rutina</button>
    </section>
    <h2>Ejercicios</h2>
    <ul class="list ex-edit">${items || '<p class="empty">Agrega los ejercicios de esta rutina.</p>'}</ul>
    <button type="button" class="add-ex-field" data-action="explore-list">+ Agregar ejercicio</button>
    ${shareBox(r.id, 'Tu amigo toca el link y la rutina se le agrega sola (o ingresa el código en Rutinas → "Importar rutina con código"). Solo se comparten los ejercicios, el Rest y los objetivos, no tus pesos ni tu historial.')
      || '<button class="btn block" data-action="share-routine" style="margin-top:32px">Compartir rutina</button>'}
    <button class="btn block" data-action="dup-routine">Duplicar rutina</button>
    <button class="btn ghost block danger-text" data-action="del-routine">Eliminar rutina</button>
    ${guidePickerHtml()}
    ${exploreSheetHtml()}`;
}

// Agregar un ejercicio que ya está en la rutina: casi siempre se quería hacer otra serie
// Ya está en esta rutina: con el mismo nombre, o con otro nombre y la misma técnica ("Laterales mancuerna" = Elevaciones laterales)
async function okRepeatedEx(name, gid = null) {
  const r = curRoutine(), g = gid ? GUIDE_BY_ID.get(gid) : guideFor(name);
  let k = r.exercises.findIndex(ex => sameName(ex.name, name));
  if (k < 0 && g) k = r.exercises.findIndex(ex => (guideFor(ex.name, ex.guide) || {}).id === g.id);
  if (k < 0) return true;
  const same = sameName(r.exercises[k].name, name) ? '' : ` con la misma técnica (${g.name})`;
  if (await ask(`"${r.exercises[k].name}" ya está en esta rutina${same}.\n\nSi quieres hacer más series, no lo agregues otra vez: cambia el número de Series. Cada serie, con su peso, se anota al entrenar (Empezar rutina).\n\n¿Agregarlo igual?`, 'Agregar igual')) return true;
  openEx = k;   // se abre el que ya estaba, para cambiar sus series
  render();
  return false;
}

// Superset: los ejercicios unidos con el siguiente (ssNext) se hacen juntos, intercalando sus series
function groupsOf(d) {
  const groups = [];
  let g = [];
  d.exercises.forEach((ex, k) => {
    g.push(k);
    if (!ex.ssNext || k === d.exercises.length - 1) { groups.push(g); g = []; }
  });
  return groups;
}
const groupIndex = (groups, pos) => Math.max(0, groups.findIndex(g => g.includes(pos)));
const groupName = (d, g) => g.map(k => d.exercises[k].name).join(' + ');
const letterOf = n => String.fromCharCode(65 + n);   // A, B, C… en un superset

// Entreno libre (sin rutina): eliges cada ejercicio y cuántas series vas a hacer.
// freeAdd = null (cerrado), {} (eligiendo ejercicio) o { name, guide, known } (eligiendo cuántas series)
let freeAdd = null, freeQ = '';
const FREE_REST = 120;   // descanso por defecto de un ejercicio nuevo en el entreno libre

// Tus ejercicios (historial y rutinas), del más reciente al más antiguo, sin repetir
function ownExercises() {
  const seen = new Set(), out = [];
  const add = n => { const k = normText(n.trim()); if (k && !seen.has(k)) { seen.add(k); out.push(n); } };
  for (let i = db.workouts.length - 1; i >= 0; i--) for (const ex of db.workouts[i].exercises) add(ex.name);
  for (const r of db.routines) for (const ex of r.exercises) add(ex.name);
  return out;
}
const freePickBtn = (name, sub, g = '') => `<button type="button" class="food-pick" data-action="free-pick" data-name="${esc(name)}" data-g="${g}">
    <span class="grow"><strong>${esc(name)}</strong><span class="muted small">${esc(sub)}</span></span><span class="chev">+</span></button>`;
function freeSuggHtml(q) {
  const own = ownExercises(), text = q.trim();
  if (!text) {
    return own.length ? `<span class="muted small">Recientes</span>${own.slice(0, 6).map(n => freePickBtn(n, 'Ya lo has hecho')).join('')}`
      : '<span class="muted small">Escribe el nombre y elige de la lista. Si no aparece, agrégalo igual.</span>';
  }
  const mine = own.filter(n => normText(n).includes(normText(text))).slice(0, 3);
  const guides = searchGuides(text, 6).filter(g => !mine.some(n => sameName(n, g.name))).slice(0, 6 - mine.length);
  const exact = [...mine, ...guides.map(g => g.name)].some(n => sameName(n, text));
  return mine.map(n => freePickBtn(n, 'Ya lo has hecho')).join('')
    + guides.map(g => freePickBtn(g.name, g.musc, g.id)).join('')
    + (exact ? '' : freePickBtn(text[0].toUpperCase() + text.slice(1), 'Agregar este ejercicio'));
}
function freePickerHtml(d) {
  const fp = freeAdd || {};
  if (fp.name) {
    return `<section class="card stack free-pick">
      <strong>¿Cuántas series de ${esc(fp.name)}?</strong>
      <div class="free-sets">${[1, 2, 3, 4, 5, 6].map(n => `<button class="btn" data-action="free-sets" data-n="${n}">${n}</button>`).join('')}</div>
      ${fp.known ? '' : `<label class="free-unit muted small">Unidad ${unitSelect()}</label>`}
      <span class="muted small">Si después haces más, agregas otra con "+ serie".</span>
      <button class="link small" data-action="free-change" style="justify-self:start">Cambiar ejercicio</button>
    </section>`;
  }
  return `<section class="card stack free-pick">
      <strong>${d.exercises.length ? '¿Qué ejercicio sigue?' : '¿Qué ejercicio vas a hacer?'}</strong>
      <input data-bind="free-q" value="${esc(freeQ)}" placeholder="Ej. press militar" autocomplete="off" aria-label="Nombre del ejercicio">
      <div class="ex-sugg free-sugg">${freeSuggHtml(freeQ)}</div>
      ${d.exercises.length ? '<button class="link small" data-action="free-cancel" style="justify-self:start">Cancelar</button>' : ''}
    </section>`;
}
async function startFree() {
  if (db.draft && !await ask(`Tienes un entrenamiento de "${db.draft.routineName}" sin guardar. ¿Descartarlo y empezar uno nuevo?`, 'Descartar y empezar')) return;
  setTimer(null);
  db.draft = { free: true, routineId: null, routineName: 'Entreno libre', start: new Date().toISOString(), timer: null, exercises: [] };
  freeAdd = null; freeQ = '';
  save();
  go('#/entrenar');
}
function addFreeExercise(n) {
  const d = cur(), fp = freeAdd;
  if (!d || !fp || !fp.name) return;
  const found = findExercise(fp.name), id = found ? found.id : uid();
  if (d.exercises.some(e => e.exerciseId === id)) { notice(`"${fp.name}" ya está en este entrenamiento.`); return; }
  const sel = $app.querySelector('.free-pick select[name="unit"]');
  if (sel) lastUnit = sel.value;
  const rir = !!(found && found.rir);
  const sets = prefillSets(lastFor(id, beforeIndex(d)), rir, n).slice(0, n);
  // El que estabas haciendo queda con ✓ si anotaste algo
  const prev = d.exercises[d.pos || 0];
  if (prev && (d.touched || {})[prev.exerciseId] && !(d.done ||= []).includes(prev.exerciseId)) d.done.push(prev.exerciseId);
  d.exercises.push({
    exerciseId: id, name: found ? found.name : fp.name, unit: found ? found.unit : lastUnit,
    rest: (found && found.rest) || FREE_REST, rir, extra: true,
    ...(fp.guide ? { guide: fp.guide } : {}),
    sets,
  });
  d.pos = d.exercises.length - 1;
  freeAdd = null; freeQ = '';
  save(); render();
  window.scrollTo(0, 0);
}

function viewWorkout() {
  const d = cur();
  if (!d) { location.replace(isEditing() ? '#/historial' : '#/rutinas'); return ''; }
  // Entreno libre recién empezado: primero se elige el ejercicio
  if (!d.exercises.length) {
    return `${header(d.routineName, { back: true, sub: `Duración ${elapsedClock(d.start)}` })}
      ${freePickerHtml(d)}
      <div class="actions"><button class="btn ghost block danger-text" data-action="discard">Descartar entrenamiento</button></div>`;
  }
  const editing = !!d.editOf;
  const before = beforeIndex(d);

  // Un bloque a la vez (un ejercicio, o varios si van en superset): d.pos es un ejercicio del bloque en pantalla
  // y d.done los ejercicios que ya pasaste con "Siguiente"
  const groups = groupsOf(d);
  d.pos = Math.min(Math.max(d.pos || 0, 0), d.exercises.length - 1);
  d.done = d.done || [];
  const gi = groupIndex(groups, d.pos), group = groups[gi], isLast = gi === groups.length - 1;
  const ridOf = ex => (ex.extra ? null : d.routineId);
  const bests = new Map(group.map(k => [k, bestSets(d.exercises[k].exerciseId, before, d.exercises[k].unit, ridOf(d.exercises[k]))]));

  // "↓ drop" solo en ejercicios marcados como Dropset en la rutina (o que ya tienen bajadas, al editar uno guardado)
  const canDrop = ex => ex.dropset || ex.sets.some(st => st.drops && st.drops.length);
  // Fila de una serie, con sus bajadas de dropset debajo (label: "1", o "A1" en un superset)
  const setRow = (ex, i, s, j, label) => {
    const best = bests.get(i);
    const okCol = '';
    const drops = (s.drops || []).map((x, k) => `
      <div class="set drop ${ex.rir ? 'has-rir' : ''}">
        <span class="n">↓</span>
        <input inputmode="decimal" data-bind="dw" data-i="${i}" data-j="${j}" data-k="${k}" value="${esc(x.w)}" placeholder="${esc(x.pw || (ex.unit === 'placas' ? 'placas' : 'peso'))}" aria-label="Peso bajada ${k + 1} de la serie ${label}">
        <span class="u">${unitShort(ex.unit)}</span>
        <span class="x">×</span>
        <input inputmode="numeric" data-bind="dr" data-i="${i}" data-j="${j}" data-k="${k}" value="${esc(x.r)}" placeholder="${esc(x.pr || 'reps')}" aria-label="Repeticiones bajada ${k + 1} de la serie ${label}">
        ${ex.rir ? '<span></span>' : ''}
        <span></span>
        <button class="set-del" data-action="del-drop" data-i="${i}" data-j="${j}" data-k="${k}" aria-label="Quitar bajada">${TRASH_ICON}</button>
      </div>`).join('');
    const wPh = lastreEx(ex) ? '0' : s.pw || (ex.unit === 'placas' ? 'placas' : 'peso');
    return `
      <div class="set ${ex.rir ? 'has-rir' : ''}">
        <span class="n">${label}</span>
        <input inputmode="decimal" data-bind="w" data-i="${i}" data-j="${j}" value="${esc(s.w)}" placeholder="${esc(wPh)}" aria-label="${ex.unit === 'placas' ? 'Placas' : isBwEx(ex) ? 'Lastre' : 'Peso'} serie ${label}">
        <span class="u">${unitShort(ex.unit)}</span>
        <span class="x">×</span>
        <input inputmode="numeric" data-bind="r" data-i="${i}" data-j="${j}" value="${esc(s.r)}" placeholder="${esc(repsFor(ex, j) || s.pr || 'reps')}" aria-label="Repeticiones serie ${label}">
        ${ex.rir ? `<input class="rir" inputmode="numeric" data-bind="rir" data-i="${i}" data-j="${j}" value="${esc(s.rir ?? '')}" placeholder="${esc(rirFor(ex, j) || s.prir || 'RIR')}" aria-label="RIR serie ${label}">` : ''}
        <span class="mark-cell" data-mark="${i}-${j}">${markSpan(liveCmp(s, ex, best[j]))}</span>
        <button class="set-del" data-action="del-set" data-i="${i}" data-j="${j}" aria-label="Borrar serie">${TRASH_ICON}</button>
      </div>
      ${drops}
      <div class="set-ref"><span>${best[j] ? `Mejor: ${fmtNum(best[j].w)} ${best[j].unit} × ${fmtNum(best[j].r)}` : ''}</span>
        ${canDrop(ex) ? `<button class="drop-add" data-action="add-drop" data-i="${i}" data-j="${j}">↓ drop</button>` : ''}</div>`;
  };

  // Objetivo de la rutina (si tiene), aviso para subir el peso, nota y "Primera vez"
  const exInfo = (ex, i) => {
    // Sin RIR activado se va al fallo (se muestra junto al resto del objetivo)
    const goals = [['Series', ex.goalSets], ['Repeticiones', hasRepsBy(ex) ? 'Por serie' : ex.goalReps]].filter(([, v]) => v);
    if (ex.rir && (hasRirBy(ex) || ex.goalRir)) goals.push(['RIR', hasRirBy(ex) ? 'Por serie' : ex.goalRir]);
    else if (!ex.rir && goals.length) goals.push(['Hasta', 'Fallo']);
    let hint = '';
    if (!editing && (ex.goalReps || hasRepsBy(ex))) {
      const prev = lastFor(ex.exerciseId, before, ridOf(ex));
      const done = prev ? prev.ex.sets.filter(x => x.w != null) : [];
      const topOf = j => (repsFor(ex, j) ? rangeTop(repsFor(ex, j)) : Infinity);
      if (done.length && done.length >= (ex.goalSets || 1) && done.every((x, j) => (x.r || 0) >= topOf(j))) {
        hint = hasRepsBy(ex)
          ? '<p class="goal-hint">💡 La última vez llegaste al tope del rango en todas las series: prueba subir el peso.</p>'
          : `<p class="goal-hint">💡 La última vez llegaste a ${rangeTop(ex.goalReps)} repeticiones en todas las series: prueba subir el peso.</p>`;
      }
    }
    return `${goals.length ? `<div class="goal-chips">${goals.map(([k, v]) => `<span class="goal-chip"><small>${k}</small>${esc(String(v))}</span>`).join('')}${ex.rir ? infoBtn('rir') : ''}</div>${ex.rir ? infoBox('rir') : ''}` : ''}
      ${hint}
      ${noteHtml(ex.exerciseId, i)}
      ${bests.get(i).length ? '' : '<p class="prev">Primera vez</p>'}`;
  };
  const historyHtml = ex => historyFor(ex.exerciseId, d.editOf).map(({ w, ex: pex }) => `
      <div class="hist-item">
        <div class="muted">${fmtDate(w.date)}${w.routineName ? ` · ${esc(w.routineName)}` : ''}</div>
        ${setsChips(pex)}
      </div>`).join('') || '<p class="muted">Aún no hay historial de este ejercicio.</p>';
  // pre: letra del ejercicio en un superset ("A "), para saber de cuál es cada descanso
  const restBtn = (i, pre = '') => (!editing && d.exercises[i].rest
    ? `<button class="btn ghost" data-action="rest" data-i="${i}" data-rest="${i}" data-pre="${pre}">Rest ${pre}${fmtRest(d.exercises[i].rest)}</button>` : '');
  const dropBadge = ex => (ex.dropset ? '<span class="badge on">Dropset</span>' : '');
  const techBtn = i => `<button class="btn small-btn tech-btn" data-action="guide-view" data-i="${i}">Técnica</button>`;
  const exTitle = (ex, label) => `<div class="ex-title"><strong>${label}</strong></div>`;
  // El músculo va en una pestaña que sale del borde de arriba de la tarjeta (sale de la guía de técnica; sin guía no aparece)
  const muscleTab = list => { const z = [...new Set(list.map(zoneOf).filter(Boolean))].join(' · ');
    return z ? `<span class="ex-tab">${z}</span>` : ''; };
  const swapBtn = i => (editing ? '' : `<button class="btn small-btn swap-btn" data-action="swap-open" data-i="${i}">Cambiar</button>`);

  const exerciseBlock = (ex, i) => {
    const open = openHistory.has(ex.exerciseId);
    const tab = muscleTab([ex]);
    return `<section class="card${tab ? ' has-tab' : ''}" data-ex="${i}">${tab}
      <div class="ex-head">${exTitle(ex, esc(ex.name))}${dropBadge(ex)}${swapBtn(i)}${techBtn(i)}</div>
      ${exInfo(ex, i)}
      <div class="sets">${ex.sets.map((st, j) => setRow(ex, i, st, j, j + 1)).join('')}</div>
      <div class="ex-actions">
        <button class="btn ghost" data-action="add-set" data-i="${i}">+ serie</button>
        ${restBtn(i)}
        <button class="btn ghost ${open ? 'on' : ''}" data-action="toggle-history" data-i="${i}">Historial ${open ? '▴' : '▾'}</button>
        ${ex.extra ? `<button class="btn ghost danger-text" data-action="del-extra" data-i="${i}">Quitar ejercicio</button>` : ''}
      </div>
      ${open ? `<div class="hist">${historyHtml(ex)}</div>` : ''}
    </section>`;
  };

  // Superset: A1, B1, A2, B2… en una sola tarjeta; cada ejercicio tiene su propio Rest (haces A, descansas, haces B…)
  const supersetBlock = idx => {
    const rounds = Math.max(...idx.map(k => d.exercises[k].sets.length));
    let rows = '';
    for (let j = 0; j < rounds; j++) {
      rows += `<div class="ss-round">${idx.map((k, n) => {
        const ex = d.exercises[k], st = ex.sets[j];
        return st ? `<div class="ss-name">${letterOf(n)} · ${esc(ex.name)}</div>${setRow(ex, k, st, j, `${letterOf(n)}${j + 1}`)}` : '';
      }).join('')}</div>`;
    }
    const open = idx.some(k => openHistory.has(d.exercises[k].exerciseId));
    const tab = muscleTab(idx.map(k => d.exercises[k]));
    return `<section class="card superset${tab ? ' has-tab' : ''}" data-ex="${idx[0]}">${tab}
      <div class="ss-tag">🔗 Superset · alterna una serie de cada uno</div>
      ${idx.map((k, n) => `<div class="ss-ex">
        <div class="ex-head">${exTitle(d.exercises[k], `${letterOf(n)} · ${esc(d.exercises[k].name)}`)}${dropBadge(d.exercises[k])}${swapBtn(k)}${techBtn(k)}</div>
        ${exInfo(d.exercises[k], k)}
      </div>`).join('')}
      <div class="sets">${rows}</div>
      <div class="ex-actions">
        <button class="btn ghost" data-action="add-round" data-i="${idx[0]}">+ vuelta</button>
        ${(k => (k == null ? '' : restBtn(k)))(idx.slice().reverse().find(k => d.exercises[k].rest))}
        <button class="btn ghost ${open ? 'on' : ''}" data-action="toggle-history" data-i="${idx[0]}" data-group="1">Historial ${open ? '▴' : '▾'}</button>
      </div>
      ${open ? idx.map((k, n) => `<div class="hist"><strong>${letterOf(n)} · ${esc(d.exercises[k].name)}</strong>${historyHtml(d.exercises[k])}</div>`).join('') : ''}
    </section>`;
  };

  // Fila con todos los bloques para saltar a cualquiera (✓ = ya lo pasaste)
  const steps = `<nav class="steps" aria-label="Ejercicios">${groups.map((g, k) => {
    const done = g.every(x => d.done.includes(d.exercises[x].exerciseId));
    return `<button class="step ${k === gi ? 'on' : ''} ${done ? 'done' : ''}" data-action="go-ex" data-i="${g[0]}"
      ${k === gi ? 'aria-current="step"' : ''}>${done ? '✓ ' : ''}${g.length > 1 ? '🔗 ' : ''}${esc(groupName(d, g))}</button>`;
  }).join('')}
  </nav>`;
  const nav = `<div class="step-nav">
      <button class="btn" data-action="prev-ex" ${gi === 0 ? 'disabled' : ''}>‹ Anterior</button>
      ${isLast
        ? (editing ? '<button class="btn primary" data-action="save-edit">Guardar cambios</button>'
                   : '<button class="btn primary" data-action="finish">Terminar y guardar</button>')
        : `<button class="btn primary" data-action="next-ex">Siguiente: ${esc(groupName(d, groups[gi + 1]))} ›</button>`}
    </div>`;

  const title = editing ? `Editar · ${d.routineName}` : d.routineName;
  // Entrenando: cuánto llevas (se actualiza solo). Editando uno guardado: su fecha
  return `${header(title, { back: true, sub: `Ejercicio ${gi + 1} de ${groups.length} · ${editing ? fmtDate(d.start) : `Duración ${elapsedClock(d.start)}`}` })}
    ${steps}
    ${group.length > 1 ? supersetBlock(group) : exerciseBlock(d.exercises[group[0]], group[0])}
    ${editing ? '' : '<div id="quizcard" class="quiz card" hidden></div>'}
    ${d.free && isLast ? (freeAdd ? freePickerHtml(d) : '<button class="btn block free-more" data-action="free-open">+ Otro ejercicio</button>') : ''}
    ${d.free && freeAdd ? '' : nav}
    ${isLast ? `
    ${d.free ? '' : `<form class="add-row" data-form="extra-ex">
      <input name="title" placeholder="+ Ejercicio extra" autocomplete="off" required>
      ${unitSelect()}
      <button class="btn">Agregar</button>
    </form>`}
    <div class="actions">
      ${editing
        ? '<button class="btn ghost block" data-action="back">Cancelar</button>'
        : '<button class="btn ghost block danger-text" data-action="discard">Descartar entrenamiento</button>'}
    </div>` : ''}
    ${guideView != null ? guideViewHtml() : ''}
    ${guidePickerHtml()}
    ${swapSheetHtml()}
    ${editing ? '' : `<div id="restbar" class="restbar" hidden>
      <span class="rb-text"></span>
      <button class="btn rest-plus" data-action="rest-add">+30 s</button>
      <button class="icon" data-action="rest-stop" aria-label="Cerrar descanso">✕</button>
    </div>`}`;
}

// ---------- Historial (calendario) ----------
let histMonth = null;   // { y, m } del mes a la vista (m de 0 a 11)
let histDay = null;     // día elegido 'AAAA-MM-DD' (null = todo el mes)
const dayKeyOf = date => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthName = (y, m) => { const t = new Date(y, m, 1).toLocaleDateString('es', { month: 'long', year: 'numeric' }); return t[0].toUpperCase() + t.slice(1); };

const sessionCard = w => `
  <a class="card" href="#/sesion/${w.id}">
    <div class="grow">
      <strong>${esc(w.routineName)}</strong>
      <span class="muted">${fmtDate(w.date)} · ${plural(w.exercises.length, 'ejercicio')} · ${plural(setsCount(w), 'serie')}${w.durationSec ? ` · ${fmtDuration(w.durationSec)}` : ''}</span>
    </div>
    <span class="chev">›</span>
  </a>`;

function viewHistory() {
  const now = new Date();
  if (!histMonth) histMonth = { y: now.getFullYear(), m: now.getMonth() };
  const { y, m } = histMonth;

  // Entrenamientos por día
  const byDay = new Map();
  for (const w of db.workouts) {
    const k = dayKeyOf(w.date);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(w);
  }

  // Cuadrícula del mes: la semana parte el lunes
  const first = new Date(y, m, 1), daysInMonth = new Date(y, m + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const today = todayKey();
  const cells = [];
  for (let k = 0; k < lead; k++) cells.push('<span class="cal-cell empty"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const n = (byDay.get(key) || []).length, pl = plannedRoutine(key);
    const planned = !n && pl && key >= today, missed = !n && pl && key < today && (!db.plan || key >= db.plan.start);
    const cls = ['cal-cell', n ? 'trained' : '', planned ? 'planned' : '', missed ? 'missed' : '', key === today ? 'today' : '', key === histDay ? 'selected' : ''].join(' ');
    cells.push(`<button class="${cls}" data-action="hist-day" data-date="${key}" aria-label="${d}${n ? `, ${plural(n, 'entrenamiento')}` : ''}">
      ${d}${n > 1 ? `<small>${n}</small>` : ''}</button>`);
  }

  const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`;
  const monthWorkouts = db.workouts.filter(w => dayKeyOf(w.date).startsWith(monthKey)).reverse();
  const shown = histDay ? (byDay.get(histDay) || []).slice().reverse() : monthWorkouts;
  const title = histDay
    ? new Date(`${histDay}T12:00:00`).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })
    : `${plural(monthWorkouts.length, 'entrenamiento')} en ${new Date(y, m, 1).toLocaleDateString('es', { month: 'long' })}`;
  const isCurrent = y === now.getFullYear() && m === now.getMonth();

  return `${header('Entreno', {})}${entrenoTabs('historial')}
    <section class="card cal">
      <div class="cal-head">
        <button class="icon" data-action="hist-month" data-d="-1" aria-label="Mes anterior">‹</button>
        <strong>${monthName(y, m)}</strong>
        <button class="icon" data-action="hist-month" data-d="1" ${isCurrent && !db.plan ? 'disabled' : ''} aria-label="Mes siguiente">›</button>
      </div>
      <div class="cal-grid cal-week">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(d => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
      ${db.plan ? '<div class="cal-legend muted small"><span class="lg trained"></span>Entrenaste <span class="lg planned"></span>Te toca <span class="lg missed"></span>No hecho</div>' : ''}
    </section>
    <h2 class="hist-title">${title}${histDay ? ' <button class="link" data-action="hist-day" data-date="">Ver todo el mes</button>' : ''}</h2>
    ${histDay && plannedRoutine(histDay) !== undefined ? `<p class="muted plan-day-note">${plannedRoutine(histDay) ? `Según tu plan, ese día toca <strong>${esc(plannedRoutine(histDay).name)}</strong>` : 'Según tu plan, ese día es de descanso'}</p>` : ''}
    ${shown.map(sessionCard).join('') || `<p class="empty">${histDay ? (histDay > todayKey() ? 'Todavía no llega ese día.' : 'Ese día no entrenaste.') : 'No hay entrenamientos este mes.'}</p>`}`;
}

// ---------- Cuenta ----------
function viewAuth(mode) {
  const reg = mode === 'registro';
  return `<div class="auth">
    <h1><img class="auth-logo" src="icons/logo-full.png" alt="Desdel"></h1>
    <p class="muted">Entrena. Anota. Supera.</p>
    ${localStorage.getItem(PENDING_IMPORT) ? `<p class="auth-note">Abriste un link de Desdel. ${reg ? 'Crea tu cuenta' : 'Inicia sesión'} y se agrega automáticamente.</p>` : ''}
    ${readLegacy() ? `<p class="auth-note">Tienes rutinas guardadas en este celular. Al ${reg ? 'crear tu cuenta' : 'iniciar sesión'} se suben a tu cuenta automáticamente.</p>` : ''}
    <form class="auth-form" data-form="${reg ? 'register' : 'login'}" novalidate>
      <label class="field"><span>Correo</span>
        <input name="email" type="email" autocomplete="email" inputmode="email" required>
      </label>
      ${reg ? `<label class="field"><span>Nombre de usuario</span>
        <input name="username" autocomplete="nickname" maxlength="30" required>
      </label>` : ''}
      ${reg ? `<div class="reg-optional">
        <div class="two-fields">
          <label class="field"><span>Año nacim. (opcional)</span>
            <input name="birth" inputmode="numeric" placeholder="ej. 1998" autocomplete="bday-year" aria-label="Año de nacimiento">
          </label>
          <label class="field"><span>Estatura (opcional)</span>
            <div class="add-row" style="margin-top:0"><input name="height" inputmode="numeric" placeholder="ej. 175" autocomplete="off" aria-label="Estatura en cm"><span class="unit-label">cm</span></div>
          </label>
        </div>
        <div class="field"><span>Sexo (opcional)</span>
          <div class="per-choice">
            <label><input type="radio" name="sex" value="h"> Hombre</label>
            <label><input type="radio" name="sex" value="m"> Mujer</label>
          </div>
        </div>
      </div>` : ''}
      <label class="field"><span>Contraseña${reg ? ' (mínimo 6 caracteres)' : ''}</span>
        <input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
      </label>
      ${reg ? '<p class="muted small" style="margin:0">Se usan para calcular tu FFMI y tus kcal objetivo. Puedes cambiarlos después en ⚙️ Cuenta.</p>' : ''}
      <p class="auth-error" hidden></p>
      <button class="btn primary block">${reg ? 'Crear cuenta' : 'Entrar'}</button>
    </form>
    ${reg ? '' : '<button class="btn ghost block" data-action="reset-pass">¿Olvidaste tu contraseña?</button>'}
    <p class="auth-switch">${reg
      ? '¿Ya tienes cuenta? <a href="#/login">Inicia sesión</a>'
      : '¿No tienes cuenta? <a href="#/registro">Crear cuenta</a>'}</p>
  </div>`;
}

function syncHtml() {
  if (!hasUnsynced()) return '<span class="ok">Todo guardado en la nube</span>';
  return navigator.onLine
    ? '⏳ Guardando en la nube…'
    : '⏳ Sin internet: tus cambios se subirán cuando vuelva la conexión.';
}
const paintSync = () => { const el = $app.querySelector('[data-sync]'); if (el) el.innerHTML = syncHtml(); };

const IG_USER = 'desdel.app';   // cuenta de Instagram de Desdel (para las ideas por DM)
function viewAccount() {
  const bd = db.body;
  return `${header('Cuenta', { back: true })}
    <h2>Mis datos</h2>
    <form class="stack card" data-form="profile" novalidate>
      <label class="field"><span>Correo</span>
        <input class="readonly" value="${esc(user.email)}" readonly tabindex="-1" aria-label="Correo (no se puede cambiar)">
      </label>
      <label class="field"><span>Nombre de usuario</span>
        <input name="username" value="${esc(user.username)}" maxlength="30" autocomplete="nickname">
      </label>
      <div class="two-fields">
        <label class="field"><span>Año de nacimiento</span>
          <input name="birth" inputmode="numeric" value="${bd.birthYear || ''}" placeholder="ej. 1998" autocomplete="bday-year" aria-label="Año de nacimiento">
        </label>
        <label class="field"><span>Estatura</span>
          <div class="add-row" style="margin-top:0"><input name="height" inputmode="numeric" value="${bd.heightCm || ''}" placeholder="ej. 175" autocomplete="off" aria-label="Estatura en cm"><span class="unit-label">cm</span></div>
        </label>
      </div>
      <div class="field"><span>Sexo</span>
        <div class="per-choice">
          <label><input type="radio" name="sex" value="h" ${bd.sex === 'h' ? 'checked' : ''}> Hombre</label>
          <label><input type="radio" name="sex" value="m" ${bd.sex === 'm' ? 'checked' : ''}> Mujer</label>
        </div>
      </div>
      <p class="muted small" style="margin:0">Se usan para calcular tu FFMI (Cuerpo → % Grasa) y tus kcal objetivo (Nutrición).</p>
      <p class="form-msg" hidden></p>
      <button class="btn primary block">Guardar cambios</button>
    </form>

    <section class="card" data-sync style="margin-top:16px">${syncHtml()}</section>
    <p class="muted hint">Tus datos se guardan en tu cuenta. Inicia sesión con el mismo correo en otro teléfono para verlos.</p>

    <h2>Ayuda</h2>
    <section class="card stack">
      <button class="btn block" data-action="tour-open">Ver tutorial</button>
      <button class="btn ghost block" data-action="tips-reset">Volver a mostrar los consejos</button>
    </section>

    <h2>Quiz entre series</h2>
    <section class="card stack">
      <div class="quiz-set"><span class="muted">Preguntas cortas de entrenamiento, nutrición y salud mientras descansas.</span>
        <button class="chip toggle ${quizOn() ? 'on' : ''}" data-action="quiz-toggle" aria-pressed="${quizOn()}">${quizOn() ? 'Activado' : 'Desactivado'}</button></div>
      ${quizState().n ? `<span class="muted small">${quizName()}: llevas ${quizState().ok || 0} de ${quizState().n} correctas</span>` : ''}
    </section>

    <h2>Modo coach</h2>
    <section class="card stack">
      <div class="quiz-set"><span class="muted">Sigue a tus alumnos: ve sus entrenos, peso, medidas, nutrición y fotos, y cambia sus rutinas.</span>
        <button class="chip toggle ${coachOn() ? 'on' : ''}" data-action="${coachOn() ? 'coach-off' : 'coach-on'}" aria-pressed="${coachOn()}">${coachOn() ? 'Activado' : 'Desactivado'}</button></div>
      ${coachOn() ? '<a class="btn block center" href="#/alumnos" style="margin-top:0">Mis alumnos</a>' : ''}
    </section>

    <h2>Ideas</h2>
    <section class="card stack">
      <p class="muted" style="margin:0">¿Qué le falta a Desdel? Mándame tu idea o cuéntame si algo no funciona.</p>
      <a class="btn primary block center" href="https://ig.me/m/${IG_USER}" target="_blank" rel="noopener" style="margin-top:0">Sugerir una idea</a>
      <span class="muted small">Se abre un mensaje a @${IG_USER} en Instagram.</span>
    </section>

    <h2>Cambiar contraseña</h2>
    <form class="stack" data-form="password" novalidate>
      <label class="field"><span>Contraseña actual</span>
        <input name="current" type="password" autocomplete="current-password">
      </label>
      <label class="field"><span>Nueva contraseña (mínimo 6 caracteres)</span>
        <input name="next" type="password" autocomplete="new-password">
      </label>
      <p class="form-msg" hidden></p>
      <button class="btn block">Cambiar contraseña</button>
    </form>

    <button class="btn ghost block danger-text" data-action="logout" style="margin-top:32px">Cerrar sesión</button>`;
}

const formMsgOr = (f, text) => (f.querySelector('.form-msg') ? formMsg(f, text) : notice(text));

// Muestra un mensaje bajo un formulario (error en rojo o confirmación en verde)
function formMsg(f, text, ok = false) {
  const p = f.querySelector('.form-msg');
  p.textContent = text;
  p.classList.toggle('ok', ok);
  p.hidden = false;
}

// Algunas acciones necesitan internet; si no hay respuesta en 12 s se da por perdida
const withTimeout = p => Promise.race([p, new Promise((_, rej) =>
  setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'auth/network-request-failed' })), 12000))]);

async function busy(btn, text, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = text;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

async function saveProfileData(f) {
  const name = f.elements.username.value.trim();
  const hText = f.elements.height.value.trim(), h = num(hText), sex = f.elements.sex.value;
  if (!name) return formMsg(f, 'Escribe un nombre de usuario.');
  if (hText && (h == null || h < 100 || h > 250)) return formMsg(f, 'Escribe tu estatura en cm (ej. 175) o déjala vacía.');
  const yText = f.elements.birth.value.trim(), year = num(yText), now = new Date().getFullYear();
  if (yText && (year == null || year < now - 100 || year > now - 10)) return formMsg(f, 'Escribe tu año de nacimiento (ej. 1998) o déjalo vacío.');
  if (hText) db.body.heightCm = Math.round(h); else delete db.body.heightCm;
  if (yText) db.body.birthYear = Math.round(year); else delete db.body.birthYear;
  if (sex) db.body.sex = sex;
  save();
  if (name !== user.username) {
    try {
      await busy(f.querySelector('.btn.primary'), 'Guardando…', () => withTimeout(cloud.updateUsername(user.uid, name)));
      user.username = name;
    } catch (e) {
      render();
      return formMsg($app.querySelector('[data-form="profile"]'), authError(e));
    }
  }
  render();
  formMsg($app.querySelector('[data-form="profile"]'), 'Datos guardados', true);
}

async function submitPassword(f) {
  const current = f.elements.current.value, next = f.elements.next.value;
  if (!current) return formMsg(f, 'Escribe tu contraseña actual.');
  if (next.length < 6) return formMsg(f, 'La nueva contraseña debe tener al menos 6 caracteres.');
  if (next === current) return formMsg(f, 'La nueva contraseña es igual a la actual.');
  try {
    await busy(f.querySelector('button'), 'Cambiando…', () => withTimeout(cloud.changePassword(current, next)));
    f.reset();
    formMsg(f, 'Contraseña cambiada. Úsala la próxima vez que inicies sesión.', true);
  } catch (e) {
    formMsg(f, e && (e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password')
      ? 'La contraseña actual no es correcta.' : authError(e));
  }
}

// ---------- Compartir rutinas ----------
// Códigos de 6 caracteres sin letras que se confunden (0/O, 1/I)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.getRandomValues(new Uint32Array(6)), n => CODE_CHARS[n % CODE_CHARS.length]).join('');
const fmtCode = c => `${c.slice(0, 3)}-${c.slice(3)}`;
const normCode = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
let shareResult = null;   // { id, code, name, kind } del último código generado (rutina o dieta)
let importOpen = false;   // formulario "Importar con código" visible

// Link que abre Desdel y agrega la rutina (?r=CÓDIGO)
const PENDING_IMPORT = 'desdel-importar';
const shareLink = code => `${location.origin}${location.pathname}?r=${code}`;
const shareText = ({ name, code, kind }) => kind === 'program'
  ? `Te comparto el programa "${name}" en Desdel 📅\n\nTócalo para usarlo:\n${shareLink(code)}\n\n` +
    `Si no se abre, copia este código, abre Desdel y en Rutinas toca "Pegar código": ${fmtCode(code)}`
  : kind === 'diet'
  ? `Te comparto la dieta "${name}" en Desdel 🥗\n\nTócalo para agregarla:\n${shareLink(code)}\n\n` +
    `Si no se abre, copia este código, abre Desdel y en Nutrición → Mis dietas toca "Pegar código": ${fmtCode(code)}`
  : `Te comparto mi rutina "${name}" en Desdel 💪\n\nTócalo para agregarla:\n${shareLink(code)}\n\n` +
    `Si no se abre, copia este código, abre Desdel y en Rutinas toca "Pegar código": ${fmtCode(code)}`;

// Sube lo compartido con un código nuevo (si el código ya existe se prueba otro)
async function shareWithCode(btn, data, result) {
  await busy(btn, 'Generando código…', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = newCode();
      try {
        await withTimeout(cloud.shareRoutine(code, { ownerUid: user.uid, ownerName: user.username || '', ...data }));
        shareResult = { ...result, code };
        return;
      } catch (e) {
        if (e.code === 'permission-denied' && attempt < 2) continue;   // código repetido: se prueba otro
        notice(e.code === 'auth/network-request-failed'
          ? 'Se necesita internet para compartir.'
          : 'No se pudo generar el código. Intenta de nuevo en un rato.');
        return;
      }
    }
  });
  render();
}

async function shareRoutine(btn) {
  const r = curRoutine();
  if (!r.exercises.length) { notice('Agrega ejercicios a la rutina antes de compartirla.'); return; }
  // Solo se comparten los ejercicios: sin pesos, historial ni notas
  await shareWithCode(btn, { routine: routinePayload(r) }, { id: r.id, name: r.name, kind: 'routine' });
}
const routinePayload = r => ({ name: r.name, exercises: r.exercises.map(ex => ({ name: ex.name, unit: ex.unit, rest: ex.rest || 0, rir: !!ex.rir, ...planFields(ex) })) });

// Se comparten las comidas con sus cantidades y los alimentos propios que usa (los de la base ya los tiene todo el mundo)
async function shareDiet(btn) {
  const d = dietById(routeParts()[1]);
  if (!d.meals.some(m => m.items.length)) { notice('Agrega alimentos a la dieta antes de compartirla.'); return; }
  await shareWithCode(btn, { diet: dietPayload(d) }, { id: d.id, name: d.name, kind: 'diet' });
}
function dietPayload(d) {
  const foods = new Map();
  const meals = d.meals.map(m => ({
    name: m.name,
    items: m.items.filter(it => foodById(it.foodId)).map(it => {
      const f = foodById(it.foodId);
      if (!f.base) foods.set(f.id, { id: f.id, name: f.name, kcal: f.kcal, p: f.p, c: f.c, f: f.f, ...(isUnit(f) ? { per: 'unit' } : {}) });
      return it.n != null ? { foodId: it.foodId, n: it.n } : { foodId: it.foodId, g: it.g || 0 };
    }),
  }));
  return { name: d.name, meals, foods: [...foods.values()] };
}

// Cuadro con el código generado (rutina o dieta)
function shareBox(id, hint) {
  if (!shareResult || shareResult.id !== id) return '';
  return `<section class="card share-box" style="margin-top:32px">
      <div class="muted">Código para compartir "${esc(shareResult.name)}"</div>
      <div class="code">${fmtCode(shareResult.code)}</div>
      <div class="ex-actions">
        <button class="btn primary" data-action="send-code">Enviar</button>
        <button class="btn" data-action="copy-code">Copiar link</button>
      </div>
      <p class="muted hint">${hint}</p>
    </section>`;
}

// Formulario "Importar rutina con código"
async function importRoutine(f) {
  await busy(f.querySelector('button'), 'Buscando…',
    () => importByCode(normCode(f.elements.code.value), text => formMsg(f, text), f.dataset.kind));
}

// Se abrió un link de rutina compartida: se importa apenas haya sesión
async function importFromLink() {
  const code = localStorage.getItem(PENDING_IMPORT);
  if (!code) return;
  localStorage.removeItem(PENDING_IMPORT);
  await importByCode(code, text => notice(text));
}

async function importByCode(code, showError, kind = '') {
  if (code.length !== 6) return showError('El código tiene 6 caracteres (ej. K7P-9XQ).');
  let data;
  try {
    data = await withTimeout(cloud.getShared(code));
  } catch (e) {
    return showError(e.code === 'auth/network-request-failed' || !navigator.onLine
      ? 'Se necesita internet para importar.' : 'No se pudo buscar el código. Intenta de nuevo.');
  }
  if (!data || !(data.routine || data.diet || data.program)) {
    let inv = null;
    try { inv = await withTimeout(cloud.getInvite(code)); } catch (e) { /* sin internet: se avisa abajo */ }
    if (inv) return addGymbro(code, inv, showError);
    let cc = null;
    try { cc = await withTimeout(cloud.getCoachCode(code)); } catch (e) { /* sin internet: se avisa abajo */ }
    if (cc) return linkCoach(code, cc, showError);
    return showError(kind === 'gymbro' ? 'No existe ningún gymbro con ese código.'
      : kind === 'rutina' ? 'No existe ninguna rutina con ese código.'
      : kind === 'dieta' ? 'No existe ninguna dieta con ese código.'
      : 'No existe ninguna rutina, dieta, gymbro ni coach con ese código.');
  }
  if (data.diet) return importDiet(data);
  if (data.program) return useSharedProgram(data.program, data.ownerName);
  importRoutineData(data);
}

async function importRoutineData(data) {
  const r = data.routine;
  const repeated = db.routines.some(x => sameName(x.name, r.name))
    ? `\n\nYa tienes una rutina llamada "${r.name}"; se agregará otra.` : '';
  if (!await ask(`¿Agregar la rutina "${r.name}"${data.ownerName ? ` de ${data.ownerName}` : ''} (${plural(r.exercises.length, 'ejercicio')})?${repeated}`)) return;
  // Si ya tienes un ejercicio con el mismo nombre, se usa ese para mantener tu historial
  const used = new Set();
  const routine = {
    id: uid(),
    name: r.name,
    exercises: r.exercises.map(ex => {
      const found = findExercise(ex.name);
      const mine = found && !used.has(found.id) ? found : null;
      if (mine) used.add(mine.id);
      return { id: mine ? mine.id : uid(), name: mine ? mine.name : ex.name, unit: mine ? mine.unit : ex.unit, rest: ex.rest || 0, rir: !!ex.rir, ...planFields(ex) };
    }),
  };
  db.routines.push(routine);
  importOpen = false;
  save();
  go('#/rutina/' + routine.id);
}

// Calorías de una dieta compartida (con los alimentos que trae)
function sharedDietKcal(d) {
  const sharedFood = id => (d.foods || []).find(x => x.id === id) || BASE_BY_ID.get(id);
  return d.meals.reduce((sum, m) => sum + m.items.reduce((a, it) => {
    const f = sharedFood(it.foodId);
    if (!f) return a;
    const k = f.per === 'unit' ? (it.g || 0) : (it.n != null && f.unitG ? it.n * f.unitG : it.g || 0) / 100;
    return a + f.kcal * k;
  }, 0), 0);
}

async function importDiet(data) {
  const d = data.diet, from = data.ownerName || '';
  const kcal = sharedDietKcal(d);
  const repeated = N().diets.some(x => sameName(x.name, d.name)) ? `\n\nYa tienes una dieta llamada "${d.name}"; se agregará otra.` : '';
  if (!await ask(`¿Agregar la dieta "${d.name}"${from ? ` de ${from}` : ''} (${plural(d.meals.length, 'comida')}, ${fmtKcal(kcal)} kcal)?${repeated}`)) return;
  // Alimentos propios de quien la compartió: si ya tienes uno igual (mismo nombre y macros) se usa el tuyo; si no, se crea
  const ids = new Map();
  for (const f of d.foods || []) {
    const same = N().foods.find(x => sameName(x.name, f.name) && x.kcal === f.kcal && x.p === f.p && x.c === f.c && x.f === f.f && isUnit(x) === (f.per === 'unit'));
    if (same) { ids.set(f.id, same.id); continue; }
    const taken = N().foods.some(x => sameName(x.name, f.name));
    const food = { id: uid(), name: taken ? `${f.name} (${from || 'compartido'})` : f.name, kcal: f.kcal, p: f.p, c: f.c, f: f.f, ...(f.per === 'unit' ? { per: 'unit' } : {}) };
    N().foods.push(food);
    ids.set(f.id, food.id);
  }
  const diet = {
    id: uid(),
    name: d.name,
    meals: d.meals.map(m => ({
      id: uid(),
      name: m.name,
      items: m.items.map(it => ({ ...it, foodId: ids.get(it.foodId) || it.foodId })).filter(it => foodById(it.foodId)),
    })),
  };
  N().diets.push(diet);
  if (!N().activeDietId) N().activeDietId = diet.id;
  importOpen = false;
  save();
  go('#/dieta/' + diet.id);
}

const logoImg = '<img class="auth-logo" src="icons/logo-full.png" alt="Desdel">';

// En iPhone los links siempre se abren en Safari (no en la app instalada), así que se copia el código para pegarlo en la app
let handoffCode = null, handoffGymbro = false, handoffCoach = false;
// Navegador dentro de otra app (no deja instalar): { app, url } mientras se muestra el aviso
let inApp = null;
function viewInApp() {
  const chrome = inApp.android ? 'Chrome' : 'Safari';
  const u = new URL(inApp.url);
  const intent = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(inApp.url)};end`;
  return `<div class="auth handoff">${logoImg}
    <p><strong>Estás viendo Desdel dentro de ${esc(inApp.app)}</strong></p>
    <p class="muted" style="margin:0">Desde aquí no se puede instalar. Ábrela en <strong>${chrome}</strong>:</p>
    ${inApp.android ? `<a class="btn primary block center" href="${esc(intent)}">Abrir en Chrome</a>` : ''}
    <ol class="handoff-steps">
      ${inApp.android
        ? `<li>Si no se abre, toca <strong>⋮</strong> arriba a la derecha.</li>
           <li>Elige <strong>Abrir en Chrome</strong>.</li>
           <li>En Chrome toca <strong>⋮</strong> → <strong>Instalar app</strong> (o <strong>Agregar a la pantalla principal</strong>).</li>`
        : `<li>Toca <strong>⋯</strong> arriba a la derecha.</li>
           <li>Elige <strong>Abrir en navegador externo</strong>.</li>
           <li>En Safari toca <strong>Compartir</strong> → <strong>Agregar a inicio</strong>.</li>`}
    </ol>
    <button class="btn block" data-action="inapp-copy">Copiar link</button>
    <p class="muted small" style="margin:0;text-align:center">Si no encuentras el botón, copia el link y pégalo en ${chrome}.</p>
    <button class="btn ghost block" data-action="inapp-stay">Seguir aquí igual</button>
  </div>`;
}
function viewHandoff() {
  return `<div class="auth handoff">${logoImg}
    <p><strong>${handoffCoach ? 'Tu coach te invitó a Desdel 💪' : handoffGymbro ? 'Te invitaron a ser gymbro en Desdel 💪' : 'Te compartieron una rutina o una dieta'}</strong></p>
    <div class="code">${fmtCode(handoffCode)}</div>
    <button class="btn primary block" data-action="handoff-copy">📋 Copiar código</button>
    <ol class="handoff-steps">
      <li>Toca <strong>Copiar código</strong>.</li>
      <li>Abre <strong>Desdel</strong> desde tu pantalla de inicio.</li>
      <li>${handoffCoach ? 'En <strong>Social → Tengo coach</strong>' : handoffGymbro ? 'En <strong>Social → Agregar gymbro</strong>' : 'En <strong>Rutinas</strong> o en <strong>Nutrición → Mis dietas</strong>'} toca <strong>📋 Pegar código</strong>.</li>
    </ol>
    <p class="muted small">¿Todavía no tienes Desdel instalada? En Safari toca Compartir <span aria-hidden="true">⬆️</span> → <strong>Agregar a pantalla de inicio</strong>, ábrela desde ahí y pega el código.</p>
    <button class="btn ghost block" data-action="handoff-here">Seguir aquí en Safari</button>
  </div>`;
}
function viewStatus() {
  if (status === 'booting') return `<div class="auth">${logoImg}<p class="muted">Cargando…</p></div>`;
  if (status === 'load-error') {
    return `<div class="auth">${logoImg}
      <p>No se pudieron descargar tus datos.</p>
      <p class="muted">La primera vez en este teléfono se necesita internet.</p>
      <button class="btn primary block" data-action="retry">Reintentar</button>
      <button class="btn ghost block" data-action="logout">Cerrar sesión</button></div>`;
  }
  return `<div class="auth">${logoImg}
    <p>No se pudo abrir Desdel.</p>
    <p class="muted">Revisa tu conexión a internet y vuelve a abrir la app.</p>
    <button class="btn primary block" data-action="reload">Reintentar</button></div>`;
}

function viewSession(id) {
  const k = db.workouts.findIndex(x => x.id === id);
  const w = db.workouts[k];
  if (!w) { location.replace('#/historial'); return ''; }

  // Cada serie comparada con la mejor serie de esa posición en los entrenamientos anteriores
  const blocks = w.exercises.map(ex => {
    const best = bestSets(ex.exerciseId, k, ex.unit, w.routineId);
    const count = { up: 0, eq: 0, down: 0 };
    const chips = ex.sets.map((s, j) => {
      const c = best[j] ? cmpSet({ ...s, unit: ex.unit, bw: bwFor(ex, w.date) }, best[j]) : null;
      if (c != null) count[c > 0 ? 'up' : c < 0 ? 'down' : 'eq']++;
      return `<span>${setText(s, ex.unit)} ${markSpan(c)}</span>`;
    }).join('');
    const tally = !best.length ? '<span class="muted">Primera vez</span>'
      : ['up', 'eq', 'down'].filter(k => count[k]).map(k => `<span class="mark ${k}">${count[k]} ${TREND_ICON[k]}</span>`).join(' ')
        || '<span class="muted">Sin series para comparar</span>';
    return `<section class="card">
      <div class="ex-link">
        <a href="#/ejercicio/${encodeURIComponent(ex.exerciseId)}">${esc(ex.name)} <span class="chev">›</span></a>
        <span class="tally">${tally}</span>
      </div>
      <div class="sets-list">${chips}</div>
    </section>`;
  }).join('');

  const summary = `
    <section class="card summary">
      ${justFinished === id ? '<strong class="saved">¡Entrenamiento guardado!</strong>' : ''}
      ${w.durationSec ? `<div>Duración total: <strong>${fmtDuration(w.durationSec)}</strong></div>` : ''}
      <div class="legend-line muted small"><span class="mark up">${TREND_ICON.up}</span> superaste · <span class="mark eq">${TREND_ICON.eq}</span> igualaste · <span class="mark down">${TREND_ICON.down}</span> bajo tu récord</div>
    </section>`;

  // Entreno libre: se puede guardar como rutina (justo al terminar se ofrece; después, un botón chico)
  const asRoutine = !w.free || w.routineId || saveAsDone === w.id ? ''
    : justFinished === id || saveAsOpen === id ? `<form class="card stack" data-form="save-as-routine" data-id="${w.id}">
        <strong>¿Guardar estos ejercicios como rutina?</strong>
        <span class="muted small">La próxima vez la empiezas con un toque y te muestra lo que hiciste hoy.</span>
        <input name="title" value="" placeholder="Nombre (ej. Pecho y hombros)" autocomplete="off" required aria-label="Nombre de la rutina">
        <button class="btn primary block">Guardar como rutina</button>
        <button type="button" class="link small" data-action="saveas-no" data-id="${w.id}" style="justify-self:start">No, gracias</button>
      </form>`
    : `<button class="btn block" data-action="saveas-open" data-id="${w.id}" style="margin:0 0 10px">Guardar como rutina</button>`;
  return `${header(w.routineName, { back: true, sub: fmtLongDate(w.date) })}
    ${summary}
    ${coachCommentHtml(w)}
    ${asRoutine}
    ${(prs => (prs.length ? `<section class="card pr-card"><strong>🔥 ${prs.length === 1 ? 'Nuevo récord' : `${prs.length} récords nuevos`}</strong>
      ${prs.map(pr => `<span>${esc(pr.text + (pr.was || ''))}</span>`).join('')}
      <span class="muted small">Récord = superar tu mejor 1ª serie (en cualquier rutina), o tu mejor 2ª, 3ª… serie en esta rutina.${prsSent && prsSent.id === w.id ? ' Se lo avisamos a tus gymbros.' : ''}</span></section>` : ''))(newPRs(w))}
    ${viewing ? '' : `<button class="btn primary block" data-action="share-workout" data-id="${w.id}" style="margin:0 0 10px">📤 Compartir entrenamiento</button>`}
    ${blocks}
    ${viewing ? '' : `<a class="btn block center" href="#/editar/${w.id}">Editar entrenamiento</a>
    <button class="btn ghost block danger-text" data-action="del-session" data-id="${w.id}" style="margin-top:24px">Eliminar este entrenamiento</button>`}`;
}

// Mensaje para WhatsApp con el resumen de un entrenamiento guardado
function workoutShareText(w, forChat = false) {
  const k = db.workouts.indexOf(w);
  let ups = 0;
  const lines = w.exercises.map(ex => {
    const best = bestSets(ex.exerciseId, k, ex.unit, w.routineId);
    const sets = ex.sets.map((s, j) => {
      const c = best[j] ? cmpSet({ ...s, unit: ex.unit, bw: bwFor(ex, w.date) }, best[j]) : null;
      if (c > 0) ups++;
      const mark = c == null ? '' : c > 0 ? ' ▲' : c < 0 ? ' ▼' : ' =';
      return `${fmtNum(s.w)}×${fmtNum(s.r)}${dropsText(s)}${mark}`;
    });
    return `• ${ex.name} (${ex.unit}): ${sets.join(' · ')}`;
  });
  const title = `💪 ${forChat ? w.routineName : `*${w.routineName}*`}${w.durationSec ? ` · ${fmtDuration(w.durationSec)}` : ''}`;
  const closing = ups ? `🔥 Superé mi récord en ${plural(ups, 'serie')}` : '✅ Entrenamiento completado';
  const text = `${title}\n${fmtLongDate(w.date)}\n\n${lines.join('\n')}\n\n${closing}`;
  return forChat ? text : `${text}\n\nDesdel · ${location.origin}${location.pathname}`;
}

async function shareWorkout(btn, id) {
  const w = db.workouts.find(x => x.id === id);
  if (!w) return;
  const text = workoutShareText(w);
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (e) { /* se cerró el menú de compartir */ }
    return;
  }
  // Computador sin menú de compartir: se copia el texto
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copiado, pégalo en WhatsApp';
  } catch (e) {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }
}

// ---------- Modo coach ----------
// El alumno se vincula con el código de coach (coachLinks/{alumno}). El coach ve sus datos (solo mirar) y le cambia
// las rutinas: los cambios quedan en coachLinks/{alumno}/edits y la app del alumno los aplica sola.
let myCoach = null;                 // tu vínculo como alumno (null = sin coach)
let stopMyCoach = () => {}, stopCoachEdits = () => {};
let students = [], studentsLoaded = false, stopStudents = () => {};
let myCoachLoaded = false;
let coachComments = {}, stopComments = () => {};   // alumno: comentarios de tu coach por entreno
let viewing = null;                 // alumno que estás viendo: { uid, name, own (tus datos), base (sus rutinas), queued }
let coachCodeBusy = false, coachCodeError = false;
const me = () => (viewing ? viewing.own : db);   // tus propios datos, aunque estés viendo a un alumno
const dataUid = () => (viewing ? viewing.uid : user.uid);
const coachOn = () => !!me().body.coach;
const coachLink = code => `${location.origin}${location.pathname}?k=${code}`;
const coachInviteText = code => `Vincúlate conmigo como tu coach en Desdel 💪\n\nToca el link:\n${coachLink(code)}\n\n` +
  `Si no se abre, abre Desdel y en Social → Tengo coach pega este código: ${fmtCode(code)}`;

// Pantallas que se pueden mirar de un alumno; las de VIEW_EXIT te devuelven a tus datos
const VIEW_OK = ['', 'chat', 'rutinas', 'rutina', 'programas', 'miprograma', 'listos', 'programa', 'dieta', 'objetivo', 'historial', 'sesion', 'progreso', 'ejercicio', 'peso', 'grasa', 'medidas', 'fotos', 'nutricion', 'sueno', 'agua'];
const VIEW_EXIT = ['social', 'gymbro', 'perfil', 'privacidad', 'cuenta', 'alumnos', 'coach', 'asignar'];
// Lo que se puede tocar mirando a un alumno, y lo extra en el editor de rutinas
const VIEW_SAFE = new Set(['back', 'view-exit', 'vid-toggle', 'info', 'toggle-sec', 'range', 'toggle-history', 'hist-month', 'hist-day', 'skin-view', 'measure-view',
  'prog-open', 'prog-close', 'prog-filter', 'prog-retry', 'week-sum', 'week-day', 'guide-view', 'guide-close', 'explore-zone', 'explore-open', 'explore-back', 'explore-close', 'go-ex', 'prev-ex', 'next-ex', 'prog-rid', 'thumb-play']);
const VIEW_ROUTINE = new Set(['reps-by', 'toggle-drop', 'toggle-bw', 'toggle-ss', 'toggle-rir', 'toggle-unit', 'move', 'ex-open', 'ex-close', 'del-ex', 'dup-routine', 'del-routine',
  'guide-pick', 'guide-change', 'guide-set', 'guide-pick-close', 'explore-list', 'explore-add', 'explore-add-custom']);
const VIEW_PROGRAM = new Set(['myprog-new', 'myprog-weeks', 'myprog-stop', 'myprog-use', 'myprog-del', 'prog-level', 'prog-days', 'prog-add', 'prog-add-one']);
const VIEW_NUTRI = new Set(['diet-new', 'nutri-use', 'diet-link', 'diet-done', 'diet-del', 'meal-add', 'meal-dup', 'meal-del', 'item-del', 'item-mode', 'add-mode', 'pick-food', 'pace-dir', 'set-activity']);
const CHAT_BLOCK = new Set(['attach', 'attach-pick', 'attach-send', 'msg-add', 'gymbro-del']);   // usan tus datos: no mientras ves a un alumno
const viewAllowed = action => VIEW_SAFE.has(action) || action === 'student-del'
  || (routeParts()[0] === 'chat' && !CHAT_BLOCK.has(action)) || (routeParts()[0] === 'rutina' && VIEW_ROUTINE.has(action))
  || (['programas', 'miprograma', 'listos', 'programa'].includes(routeParts()[0]) && VIEW_PROGRAM.has(action))
  || (['nutricion', 'dieta', 'objetivo'].includes(routeParts()[0]) && VIEW_NUTRI.has(action));
const viewOnlyMsg = () => `Estás viendo los datos de ${viewing.name}. Puedes ver todo y cambiar sus rutinas, programas y dieta, pero no anotar ni borrar sus registros.`;
const viewBarHtml = () => `<div class="view-bar"><span class="grow"><span class="muted small">Modo coach</span><strong>${esc(viewing.name)}</strong></span>
  ${chats.some(c => c.id === [user.uid, viewing.uid].sort().join('_')) ? `<a class="btn small-btn" href="#/chat/${[user.uid, viewing.uid].sort().join('_')}">Chat</a>` : ''}
  <button class="btn small-btn" data-action="view-exit">Salir</button></div>`;

function startCoach(uid) {
  stopMyCoach = cloud.listenCoachLink(uid, link => {
    const had = myCoach;
    myCoach = link;
    myCoachLoaded = true;
    if (link && link.summary && Array.isArray(link.summary.log)) coachLog = link.summary.log;
    if (!link) coachLog = [];
    if (link && !had) {
      stopCoachEdits = cloud.listenCoachEdits(uid, onCoachEdits);
      stopComments = cloud.listenCoachComments(uid, list => {
        coachComments = Object.fromEntries(list.map(c => [c.id, c]));
        if (['sesion', 'historial'].includes(routeParts()[0])) refresh();
      });
      scheduleCoachSummary();
    }
    if (!link && had) { stopCoachEdits(); stopCoachEdits = () => {}; stopComments(); stopComments = () => {}; coachComments = {}; }
    if (['social', 'coach', '', 'checkin'].includes(routeParts()[0])) refresh();
  });
  if (coachOn()) startStudents(uid);
}
function startStudents(uid) {
  stopStudents();
  studentsLoaded = false;
  stopStudents = cloud.listenStudents(uid, list => {
    students = list; studentsLoaded = true;
    if (['social', 'alumnos'].includes(routeParts()[0])) refresh();
  }, () => { studentsLoaded = true; });
}
function stopCoach() {
  stopMyCoach(); stopMyCoach = () => {};
  stopCoachEdits(); stopCoachEdits = () => {};
  stopComments(); stopComments = () => {}; coachComments = {};
  stopStudents(); stopStudents = () => {};
  myCoach = null; myCoachLoaded = false; students = []; studentsLoaded = false;
  if (viewing) { viewing = null; document.body.classList.remove('viewing'); }
}
function setCoachMode(on) {
  db.body.coach = on || undefined;
  if (!on) delete db.body.coach;
  save();
  if (on) startStudents(user.uid); else { stopStudents(); stopStudents = () => {}; students = []; }
  if (on && routeParts()[0] !== 'alumnos') go('#/alumnos'); else render();
}

// Tu código de coach (se guarda en tu cuenta para que sea el mismo en todos tus teléfonos)
async function ensureCoachCode() {
  if (me().body.coachCode || coachCodeBusy || coachCodeError || viewing) return;
  coachCodeBusy = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newCode();
    try {
      await withTimeout(cloud.createCoachCode(code, { ownerUid: user.uid, ownerName: user.username || '' }));
      db.body.coachCode = code;
      save();
      break;
    } catch (e) {
      if (e.code === 'permission-denied' && attempt < 2) continue;
      coachCodeError = true;
      break;
    }
  }
  coachCodeBusy = false;
  if (routeParts()[0] === 'alumnos') refresh();
}

// Resumen para el panel del coach (lo escribe tu teléfono, así el coach lee un solo documento por alumno)
function coachSummary() {
  const last = db.workouts[db.workouts.length - 1], bw = db.bodyweight[db.bodyweight.length - 1], wk = weekSummary(0);
  const since = Date.now() - 30 * 864e5;
  return {
    last: last ? { date: last.date, name: last.routineName || '' } : null,
    week: wk.done, planned: wk.planned ?? null,
    month: db.workouts.filter(w => Date.parse(w.date) >= since).length,
    kg: bw ? bw.kg : null, kgDate: bw ? bw.date : null,
    log: coachLog,
    lastCheckin: lastCheckin || lastCheckinAt() || null,
  };
}
// Rutinas que te cambió tu coach (las últimas 15)
let coachLog = [];
let summaryTimer = null;
function scheduleCoachSummary() {
  if (!myCoach || viewing) return;
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(pushCoachSummary, 3000);
}
async function pushCoachSummary() {
  if (!myCoach || viewing || !user || status !== 'ready') return;
  const data = { summary: coachSummary(), studentName: user.username || '' }, json = stable(data), key = `desdel-coach-resumen-${user.uid}`;
  if (localStorage.getItem(key) === json) return;
  try { await cloud.updateCoachLink(user.uid, data); localStorage.setItem(key, json); } catch (e) { /* se intenta en el próximo cambio */ }
}

// Qué cambió tu coach en una rutina, en palabras ("Sentadilla: series 3 → 4")
function routineChanges(o, n) {
  if (!o) return [];
  const out = [], reps = ex => (hasRepsBy(ex) ? ex.goalRepsBy.slice(0, ex.goalSets).map(x => x || '–').join(' / ') : ex.goalReps || '');
  const rest = ex => (ex.rest ? fmtRest(ex.rest) : '');
  const ch = (label, a, b) => (String(a ?? '') !== String(b ?? '') ? `${label} ${a || '–'} → ${b || '–'}` : null);
  const onOff = (label, a, b) => (!!a !== !!b ? `${label} ${b ? 'activado' : 'desactivado'}` : null);
  if (o.name !== n.name) out.push(`Nombre: ${o.name} → ${n.name}`);
  const old = new Map(o.exercises.map(x => [x.id, x]));
  for (const ex of n.exercises) {
    const a = old.get(ex.id);
    if (!a) { out.push(`Agregó ${ex.name}${ex.goalSets ? ` (${plural(ex.goalSets, 'serie')}${reps(ex) ? ` × ${reps(ex)}` : ''})` : ''}`); continue; }
    const parts = [ch('series', a.goalSets, ex.goalSets), ch('repeticiones', reps(a), reps(ex)),
      !!a.rir !== !!ex.rir ? `RIR ${ex.rir ? `activado${rirText(ex) ? ` (${rirText(ex)})` : ''}` : 'desactivado'}` : ex.rir ? ch('RIR', rirText(a), rirText(ex)) : null,
      ch('descanso', rest(a), rest(ex)), onOff('dropset', a.dropset, ex.dropset), onOff('peso corporal', a.bw, ex.bw),
      ch('unidad', a.unit, ex.unit), a.guide !== ex.guide ? 'cambió la técnica' : null].filter(Boolean);
    if (a.name !== ex.name) out.push(`Cambió ${a.name} por ${ex.name}${parts.length ? ` (${parts.join(', ')})` : ''}`);
    else if (parts.length) out.push(`${ex.name}: ${parts.join(', ')}`);
  }
  for (const a of o.exercises) if (!n.exercises.some(x => x.id === a.id)) out.push(`Quitó ${a.name}`);
  const same = o.exercises.filter(x => n.exercises.some(y => y.id === x.id)).map(x => x.id).join(), now = n.exercises.filter(x => old.has(x.id)).map(x => x.id).join();
  if (same !== now) out.push('Cambió el orden de los ejercicios');
  // Superseries: qué ejercicio va unido al siguiente (solo entre los que estaban y siguen)
  const pairs = r => { const ids = r.exercises.filter(x => old.has(x.id) && n.exercises.some(y => y.id === x.id)).map(x => x.id);
    return r.exercises.filter((x, k) => x.ssNext && r.exercises[k + 1]).map((x, k, arr) => x.id).filter(id => ids.includes(id)).join(); };
  if (same === now && pairs(o) !== pairs(n)) out.push('Cambió las superseries');
  return out;
}

// Rutinas que te cambió tu coach: se aplican y se borran de la nube
// Un cambio del coach: { routine } | { program } | { plan } | { deleted, kind }.
// Se guarda con el id de la rutina, 'prog_' + id del programa, o 'plan' (el programa activo)
const editKind = ed => ed.kind || ['program', 'plan', 'diet', 'nutri', 'target'].find(k => k in ed) || 'routine';
const KIND_ORDER = { routine: 0, program: 1, plan: 2, diet: 3, nutri: 4, target: 5 };   // primero las rutinas, que el programa usa
// Objetivo de calorías (Nutrición → Objetivo): ritmo y actividad
const targetOf = b => ({ paceMonth: b.paceMonth ?? null, pace: b.pace ?? null, paceAmt: b.paceAmt ?? null, activity: b.activity ?? null });
const dietFood = (d, id) => (d.nutrition.foods.find(f => f.id === id) || BASE_BY_ID.get(id) || {}).name || 'un alimento';
const itemQty = (d, it) => { const f = d.nutrition.foods.find(x => x.id === it.foodId) || BASE_BY_ID.get(it.foodId);
  return it.n != null ? `${fmtNum(it.n)} u` : `${fmtNum(it.g)}${isUnit(f) ? ' u' : ' g'}`; };
function dietChanges(d, o, n) {
  if (!o) return [];
  const out = [], om = new Map(o.meals.map(m => [m.id, m]));
  if (o.name !== n.name) out.push(`Nombre: ${o.name} → ${n.name}`);
  for (const m of n.meals) {
    const a = om.get(m.id);
    if (!a) { out.push(`Agregó ${m.name}${m.items.length ? `: ${m.items.map(it => dietFood(d, it.foodId)).join(', ')}` : ''}`); continue; }
    const before = new Map(a.items.map(it => [it.foodId, it]));
    for (const it of m.items) {
      const b = before.get(it.foodId);
      if (!b) out.push(`${m.name}: agregó ${dietFood(d, it.foodId)} (${itemQty(d, it)})`);
      else if (itemQty(d, b) !== itemQty(d, it)) out.push(`${m.name}: ${dietFood(d, it.foodId)} ${itemQty(d, b)} → ${itemQty(d, it)}`);
    }
    for (const it of a.items) if (!m.items.some(x => x.foodId === it.foodId)) out.push(`${m.name}: quitó ${dietFood(d, it.foodId)}`);
    if (a.name !== m.name) out.push(`${a.name} ahora se llama ${m.name}`);
  }
  for (const a of o.meals) if (!n.meals.some(m => m.id === a.id)) out.push(`Quitó ${a.name}`);
  return out;
}
// Ejercicios de una rutina del coach: si ya tienes uno con el mismo nombre, se usa el tuyo (así sigue tu historial)
function remapExercises(d, old, r) {
  const keyOf = n => String(n || '').trim().toLowerCase(), mine = new Map(), oldIds = new Set((old ? old.exercises : []).map(e => e.id));
  for (const x of d.routines) for (const e of x.exercises) if (!mine.has(keyOf(e.name))) mine.set(keyOf(e.name), e.id);
  for (const w of d.workouts) for (const e of w.exercises) if (!mine.has(keyOf(e.name))) mine.set(keyOf(e.name), e.exerciseId);
  const used = new Set();
  return { ...r, exercises: r.exercises.map(e => {
    let id = e.id;
    if (!oldIds.has(id) && mine.has(keyOf(e.name))) id = mine.get(keyOf(e.name));
    if (used.has(id)) id = uid();
    used.add(id);
    return id === e.id ? e : { ...e, id };
  }) };
}
const byKind = (a, b) => KIND_ORDER[editKind(a)] - KIND_ORDER[editKind(b)] || (a.at || 0) - (b.at || 0);
const progName = (d, id) => ((d.programs.find(x => x.id === id) || {}).name || 'un programa');
function programChanges(d, o, n) {
  if (!o) return [];
  const rn = id => (id ? (d.routines.find(r => r.id === id) || {}).name || 'una rutina' : 'Descanso');
  const out = [];
  if (o.name !== n.name) out.push(`Nombre: ${o.name} → ${n.name}`);
  if (o.weeks !== n.weeks) out.push(`Ahora se repite cada ${plural(n.weeks, 'semana')}`);
  n.days.slice(0, n.weeks).forEach((wk, w) => wk.r.forEach((id, k) => {
    const was = ((o.days[w] || {}).r || [])[k] || null;
    if (was !== (id || null)) out.push(`${n.weeks > 1 ? `Semana ${w + 1}, ` : ''}${DAY_NAMES[k]}: ${rn(was)} → ${rn(id)}`);
  }));
  return out;
}
function applyEditTo(d, ed) {
  const kind = editKind(ed), n = d.nutrition;
  if (kind === 'diet') {
    const did = ed.id.replace(/^diet_/, ''), k = n.diets.findIndex(x => x.id === did);
    if (ed.deleted) {
      if (k < 0) return null;
      const name = n.diets[k].name;
      n.diets.splice(k, 1);
      if (n.activeDietId === did) n.activeDietId = n.diets[0] ? n.diets[0].id : null;
      return { text: `Eliminó la dieta ${name}` };
    }
    if (!ed.diet || (k >= 0 && stable(n.diets[k]) === stable(ed.diet))) return null;
    const changes = dietChanges(d, k < 0 ? null : n.diets[k], ed.diet);
    if (k < 0) n.diets.push(ed.diet); else n.diets[k] = ed.diet;
    return { text: k < 0 ? `Te creó la dieta ${ed.diet.name || ''} (${plural(ed.diet.meals.length, 'comida')})` : `Cambió la dieta ${ed.diet.name || ''}`, changes };
  }
  if (kind === 'nutri') {
    const x = ed.nutri || {}, out = [];
    if ((x.activeDietId || null) !== (n.activeDietId || null)) {
      n.activeDietId = x.activeDietId || null;
      if (n.activeDietId) out.push(`Tu dieta ahora es ${(n.diets.find(y => y.id === n.activeDietId) || {}).name || 'otra'}`);
    }
    if (stable(x.dietLinks || null) !== stable(n.dietLinks || null)) {
      if (x.dietLinks) n.dietLinks = x.dietLinks; else delete n.dietLinks;
      out.push('Cambió qué dieta va cada día');
    }
    return out.length ? { text: 'Cambió tu dieta', changes: out } : null;
  }
  if (kind === 'target') {
    const b = d.body, before = targetOf(b), t = ed.target || {};
    if (stable(before) === stable(targetOf({ ...b, ...t }))) return null;
    for (const [k2, v] of Object.entries(t)) { if (v == null) delete b[k2]; else b[k2] = v; }
    const out = [], act = v => (ACTIVITY.find(a => a[0] === v) || [])[1] || '–';
    if (paceMonth(before) !== paceMonth(b)) out.push(`Ritmo: ${paceLabel(paceMonth(before))} → ${paceLabel(paceMonth(b))} al mes`);
    if ((before.activity || null) !== (b.activity || null)) out.push(`Actividad: ${act(before.activity)} → ${act(b.activity)}`);
    return { text: 'Cambió tu objetivo de calorías', changes: out };
  }
  if (kind === 'plan') {
    const before = d.plan && d.plan.prog;
    if (stable(d.plan || null) === stable(ed.plan || null)) return null;
    d.plan = ed.plan || null;
    if (!d.plan) return before ? { text: 'Dejó de usar tu programa activo' } : null;
    return d.plan.prog && d.plan.prog !== before ? { text: `Activó el programa ${progName(d, d.plan.prog)}` } : null;   // los días ya se avisan en el programa
  }
  if (kind === 'program') {
    const pid = ed.id.replace(/^prog_/, ''), k = d.programs.findIndex(x => x.id === pid);
    if (ed.deleted) {
      if (k < 0) return null;
      const name = d.programs[k].name;
      d.programs.splice(k, 1);
      return { text: `Eliminó el programa ${name}` };
    }
    if (!ed.program) return null;
    if (k >= 0 && stable(d.programs[k]) === stable(ed.program)) return null;   // ya estaba así
    const changes = programChanges(d, k < 0 ? null : d.programs[k], ed.program);
    if (k < 0) d.programs.push(ed.program); else d.programs[k] = ed.program;
    return { text: k < 0 ? `Te creó el programa ${ed.program.name || ''} (${plural(myProgDays(ed.program.days), 'día')} por semana)` : `Cambió el programa ${ed.program.name || ''}`, changes };
  }
  const k = d.routines.findIndex(r => r.id === ed.id);
  if (ed.deleted) {
    if (k < 0) return null;
    const name = d.routines[k].name;
    d.routines.splice(k, 1);
    return { text: `Eliminó la rutina ${name}` };
  }
  if (!ed.routine) return null;
  const r = remapExercises(d, k < 0 ? null : d.routines[k], ed.routine);
  if (k >= 0 && stable(d.routines[k]) === stable(r)) return null;   // ya estaba así
  const changes = routineChanges(k < 0 ? null : d.routines[k], r);
  if (k < 0) d.routines.push(r); else d.routines[k] = r;
  return { text: k < 0 ? `Te creó la rutina ${r.name || ''} (${plural(r.exercises.length, 'ejercicio')})` : `Cambió la rutina ${r.name || ''}`, changes };
}
const appliedEdits = new Set();   // cambios del coach ya aplicados en esta sesión
function onCoachEdits(list) {
  if (!list.length || status !== 'ready' || !user) return;
  if (viewing) { viewing.queued.push(() => onCoachEdits(list)); return; }
  const done = [];
  for (const ed of list.sort(byKind)) {
    const key = `${ed.id}:${ed.at}`;
    if (appliedEdits.has(key)) continue;
    appliedEdits.add(key);
    const r = applyEditTo(db, ed);
    if (r) done.push(r);
    cloud.deleteCoachEdit(user.uid, ed.id).catch(() => {});
  }
  save();
  refresh();
  if (!done.length) return;
  // Queda anotado en el resumen (se ve en Mi coach, en todos tus teléfonos)
  const now = Date.now();
  coachLog = [...done.map(r => ({ text: r.text, at: now, ...(r.changes && r.changes.length ? { changes: r.changes.slice(0, 8) } : {}) })), ...coachLog].slice(0, 15);
  if (myCoach) cloud.updateCoachLink(user.uid, { summary: coachSummary() }).catch(() => {});
  // Aviso con el detalle de lo que cambió
  const who = (myCoach && myCoach.coachName) || 'Tu coach';
  const lines = done.map(r => {
    const ch = (r.changes || []).slice(0, 6), more = (r.changes || []).length - ch.length;
    return [r.text + (ch.length ? ':' : '.'), ...ch.map(x => `• ${x}`), ...(more > 0 ? [`• y ${plural(more, 'cambio')} más`] : [])].join('\n');
  });
  notice(`${who} cambió tu entrenamiento\n\n${lines.join('\n\n')}\n\nLo ves también en Social → Mi coach.`);
}

// Copia de los entrenos de cada alumno en este teléfono (IndexedDB), para bajar solo lo que cambió
const idb = (() => {
  let conn = null;
  const open = () => conn || (conn = new Promise((res, rej) => {
    const r = indexedDB.open('desdel-coach', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('alumnos');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const c = await open();
    return new Promise((res, rej) => {
      const t = c.transaction('alumnos', mode), q = fn(t.objectStore('alumnos'));
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
    });
  };
  return { get: k => run('readonly', st => st.get(k)).catch(() => null), set: (k, v) => run('readwrite', st => st.put(v, k)).catch(() => {}) };
})();
async function loadStudentData(sUid) {
  const key = `${user.uid}:${sUid}`, cached = (await idb.get(key)) || { workouts: [], wAt: 0 };
  const [main, ws, edits, comments, checkins] = await withTimeout(Promise.all([cloud.fetchMain(sUid), cloud.fetchWorkoutsSince(sUid, cached.wAt),
    cloud.listCoachEdits(sUid), cloud.listCoachComments(sUid), cloud.listCheckins(sUid)]));
  const byId = new Map(cached.workouts.map(w => [w.id, w]));
  for (const c of ws.changes) { if (c.removed) byId.delete(c.id); else byId.set(c.id, c.data); }
  const workouts = [...byId.values()];
  idb.set(key, { workouts, wAt: ws.wAt });
  return { main, workouts, edits, comments, checkins };
}
// Coach: mirar los datos de un alumno (los tuyos quedan guardados aparte)
async function viewStudent(link, btn) {
  if (db.draft) return notice('Termina o descarta tu entrenamiento en curso antes de ver a un alumno.');
  await busy(btn, 'Cargando…', async () => {
    while (syncing) await new Promise(r => setTimeout(r, 100));   // que termine de subir lo tuyo
    let data;
    try { data = await loadStudentData(link.studentUid); } catch (e) {
      return notice(`No se pudieron cargar los datos de ${link.studentName || 'tu alumno'}. Revisa tu internet e intenta de nuevo.`);
    }
    const sdb = dbFromCloud(data.main, data.workouts);
    for (const ed of data.edits.sort(byKind)) applyEditTo(sdb, ed);   // cambios que aún no le llegan
    viewing = { uid: link.studentUid, name: link.studentName || 'tu alumno', own: db, base: null, queued: [],
      comments: Object.fromEntries(data.comments.map(c => [c.id, c])), checkins: data.checkins };
    db = sdb;
    dietLinks();   // se arma igual que en su app, para que no cuente como un cambio tuyo
    viewing.base = coachMap(sdb);
    progList = null; progFull.clear(); progUid = null;
    markCheckinSeen(link);
    go('#/');
    render();
  });
}
// Lo que el coach puede cambiar del alumno, para saber qué enviarle
const coachMap = d => ({
  r: Object.fromEntries(d.routines.map(x => [x.id, stable(x)])),
  p: Object.fromEntries(d.programs.map(x => [x.id, stable(x)])),
  plan: stable(d.plan || null),
  d: Object.fromEntries(d.nutrition.diets.map(x => [x.id, stable(x)])),
  nutri: stable({ a: d.nutrition.activeDietId || null, l: d.nutrition.dietLinks || null }),
  target: stable(targetOf(d.body)),
});
function exitViewing() {
  if (!viewing) return;
  pushCoachEdits();
  const v = viewing;
  viewing = null;
  db = v.own;
  progList = null; progFull.clear(); progUid = null;
  openEx = null;
  document.body.classList.remove('viewing');
  for (const f of v.queued) f();
  if (routeParts()[0] === '' || VIEW_OK.includes(routeParts()[0])) location.replace('#/alumnos');
  else render();
}
// Envía al alumno las rutinas y programas que cambiaste (o borraste) y su programa activo
let editTimer = null;
function scheduleCoachEdits() { clearTimeout(editTimer); editTimer = setTimeout(pushCoachEdits, 700); }
function pushCoachEdits() {
  clearTimeout(editTimer);
  if (!viewing) return;
  const v = viewing, now = coachMap(db), at = Date.now(), by = user.uid, jobs = [];
  const put = (id, data) => jobs.push(cloud.putCoachEdit(v.uid, id, { ...data, at, by }));
  for (const [id, j] of Object.entries(now.r)) if (v.base.r[id] !== j) put(id, { routine: clone(db.routines.find(x => x.id === id)) });
  for (const id of Object.keys(v.base.r)) if (!(id in now.r)) put(id, { deleted: true, kind: 'routine' });
  for (const [id, j] of Object.entries(now.p)) if (v.base.p[id] !== j) put(`prog_${id}`, { program: clone(db.programs.find(x => x.id === id)) });
  for (const id of Object.keys(v.base.p)) if (!(id in now.p)) put(`prog_${id}`, { deleted: true, kind: 'program' });
  if (now.plan !== v.base.plan) put('plan', { plan: db.plan ? clone(db.plan) : null });
  for (const [id, j] of Object.entries(now.d)) if (v.base.d[id] !== j) put(`diet_${id}`, { diet: clone(db.nutrition.diets.find(x => x.id === id)) });
  for (const id of Object.keys(v.base.d)) if (!(id in now.d)) put(`diet_${id}`, { deleted: true, kind: 'diet' });
  if (now.nutri !== v.base.nutri) put('nutri', { nutri: { activeDietId: db.nutrition.activeDietId || null, dietLinks: db.nutrition.dietLinks ? clone(db.nutrition.dietLinks) : null } });
  if (now.target !== v.base.target) put('target', { target: targetOf(db.body) });
  v.base = now;
  if (jobs.length) Promise.all(jobs).then(() => showNote(`Enviado a ${v.name} ✓`), () => notice(`No se pudo enviar el cambio a ${v.name}. Revisa tu internet.`));
}

// Mirando a un alumno, los textos de la app hablan de él ("Hoy a Juan le toca", "Programas de Juan")
const POV = n => [
  [/^Hoy te toca:/, `Hoy a ${n} le toca:`], [/^Hoy ya entrenaste /, `Hoy ya entrenó `], [/^Hoy: descanso$/, `Hoy ${n} descansa`],
  [/^Entrenaste$/, 'Entrenó'], [/^Te toca$/, 'Le toca'], [/^Tu semana$/, `Semana de ${n}`], [/^Tu peso de hoy · último (.*)$/, 'Último peso: $1'], [/^Tu peso de hoy$/, 'Todavía no anota su peso'],
  [/^Mis programas$/i, `Programas de ${n}`], [/^Mis dietas$/, 'Dietas'], [/^Mis alimentos$/, 'Alimentos'],
  [/^Es el que estás usando: lo que cambies aquí se aplica a tu semana\.$/, `Es el que ${n} está usando: lo que cambies aquí se aplica a su semana.`],
  [/^Para enviárselo a un alumno.*$/, ''],
  [/^Tu dieta tiene/, 'Su dieta tiene'], [/que tu objetivo/, 'que su objetivo'], [/^Tus kcal objetivo$/, `Kcal objetivo de ${n}`],
  [/^Referencia para armar tu dieta$/, 'Referencia para armar su dieta'], [/^Para mantener tu peso$/, 'Para mantener su peso'],
  [/^¿Qué quieres\?$/i, `¿Qué quiere ${n}?`], [/^Horas que dormiste cada noche$/, 'Horas que durmió cada noche'], [/^Te faltan/, 'Le faltan'],
  [/^Fotos de progreso privadas: solo tú las ves\.$/, `Fotos de progreso de ${n}.`],
  [/^Todavía no tienes fotos\..*$/, `${n} todavía no tiene fotos de progreso.`],
  [/^Para ver tu FFMI falta tu % de grasa.*$/, 'Para ver su FFMI falta su % de grasa.'],
  [/^Todavía no agregas alimentos propios\..*$/, `${n} no tiene alimentos propios.`],
  [/^Cada día la app elige sola la dieta de la rutina que te toca en tu programa activo \(o la que entrenaste\), o la de descanso\.$/,
    'Cada día la app elige sola la dieta de la rutina que le toca en su programa activo (o la que entrenó), o la de descanso.'],
  [/^Aquí armas la rutina:.*$/, `Aquí armas la rutina de ${n}: ejercicios, series y repeticiones. Los pesos de cada serie los anota al entrenar.`],
  [/^Elige tu nivel y cuántos días puedes entrenar\..*$/, `Elige el nivel y los días. Lo que añadas queda en los programas de ${n}.`],
  [/^Añadir a mis programas$/, 'Añadir a sus programas'],
  [/^Queda en Mis programas:.*$/, `Queda en los programas de ${n}. Cada ejercicio trae sus series, repeticiones, RIR, descanso y guía de técnica.`],
  [/toca ✓ cuando comas/i, 'lo que marcó hoy'], [/^Lo que comas fuera de tu dieta se suma al día\.$/, 'Lo que comió fuera de su dieta.'],
  [/^Todavía no tienes dietas\..*$/, `${n} todavía no tiene dietas. Toca "+ Crear dieta" para armarle una.`],
  [/^Medidas de hoy con huincha.*$/, ''], [/^Hoy ya mediste con huincha.*$/, ''],
  [/^Toca para anotar hoy · /, ''], [/^superaste ·$/, 'superó ·'], [/^igualaste ·$/, 'igualó ·'], [/^bajo tu récord$/, 'bajo su récord'],
  [/la rutina que te toca en tu$/, 'la rutina que le toca en su'], [/^\(o la que entrenaste\), o la de descanso\./, '(o la que entrenó), o la de descanso.'],
  [/^Desdel incluye \d+ alimentos comunes.*$/, ''],
  [/según cómo cambie tu peso/, 'según cómo cambie su peso'],
];
function povTexts() {
  const rules = POV(viewing.name), walk = document.createTreeWalker($app, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (t.parentElement.closest('.view-bar, [data-form="coach-comment"]')) continue;
    const raw = t.nodeValue, txt = raw.trim();
    if (!txt) continue;
    let v = txt;
    for (const [re, to] of rules) v = v.replace(re, to);
    if (v !== txt) t.nodeValue = raw.replace(txt, v);
  }
}

// Mirando a un alumno, la barra de abajo no apila pantallas: así "atrás" desde una pestaña vuelve a su Inicio,
// y "atrás" desde su Inicio vuelve a Mis alumnos (sale de su vista)
const TOP_SCREENS = ['rutinas', 'programas', 'historial', 'progreso', 'nutricion', 'peso', 'grasa', 'medidas', 'fotos'];
document.addEventListener('click', e => {
  if (!viewing) return;
  const a = e.target.closest('#tabs a, .range a');
  if (!a) return;
  const to = (a.getAttribute('href') || '').replace(/^#\/?/, '').split('/')[0], here = routeParts()[0];
  if (to === here && !a.getAttribute('href').includes('/', 2)) { e.preventDefault(); return; }
  if (!TOP_SCREENS.includes(here)) return;   // desde su Inicio (o más adentro) se avanza normal
  e.preventDefault();
  if (to === '') history.back();             // a su Inicio: se vuelve atrás
  else location.replace(a.getAttribute('href'));   // entre pestañas: se reemplaza
}, true);
window.addEventListener('hashchange', () => {
  // Llegaste a Mis alumnos con "atrás" desde su Inicio: se sale de su vista
  if (viewing && routeParts()[0] === 'alumnos') exitViewing();
});

// Comentario del coach sobre un entreno: el coach lo escribe mirando al alumno; el alumno lo ve en ese entreno
function coachCommentHtml(w) {
  if (viewing) {
    const c = viewing.comments[w.id];
    return `<form class="card stack coach-comment" data-form="coach-comment" data-id="${esc(w.id)}">
      <strong>Comentario para ${esc(viewing.name)}</strong>
      <textarea name="text" rows="3" maxlength="1000" placeholder="Ej. Buena técnica en la sentadilla. La próxima sube 2,5 kg.">${esc(c ? c.text : '')}</textarea>
      <span class="muted small">Le aparece en este entreno y en su chat.</span>
      <button class="btn primary block">${c ? 'Guardar comentario' : 'Enviar comentario'}</button>
    </form>`;
  }
  const c = coachComments[w.id];
  return c ? `<section class="card coach-comment"><span class="muted small">Comentario de ${esc((myCoach && myCoach.coachName) || 'tu coach')}</span>
    <p class="coach-comment-text">${esc(c.text)}</p></section>` : '';
}
async function saveCoachComment(f) {
  const v = viewing, wid = f.dataset.id, text = f.elements.text.value.trim();
  if (!v) return;
  const w = db.workouts.find(x => x.id === wid);
  await busy(f.querySelector('button'), 'Enviando…', async () => {
    try {
      if (text) await withTimeout(cloud.putCoachComment(v.uid, wid, { text, at: Date.now(), by: user.uid }));
      else if (v.comments[wid]) await withTimeout(cloud.deleteCoachComment(v.uid, wid));
      else return;
    } catch (e) { return notice('No se pudo guardar el comentario. Revisa tu internet e intenta de nuevo.'); }
    const had = v.comments[wid];
    if (text) v.comments[wid] = { text }; else delete v.comments[wid];
    const chatId = [user.uid, v.uid].sort().join('_');
    if (text && (!had || had.text !== text) && chats.some(c => c.id === chatId)) {
      const what = w ? `tu entreno ${w.routineName} del ${fmtDMY(dayKeyOf(w.date))}` : 'tu entreno';
      sendMsg(chatId, { type: 'text', text: `Sobre ${what}:\n${text}` }, `Sobre ${what}: ${text}`);
    }
    render();
    showNote(text ? `Comentario enviado a ${v.name}` : 'Comentario borrado');
  });
}

// =============== Asignar una rutina o programa tuyo a uno o varios alumnos ===============
let assignSel = null, assignTo = new Set(), assignActivate = true;
const assignId = id => `c${id}`;   // la copia del alumno: si lo vuelves a asignar, se actualiza la misma
function assignEdits(sel, activate) {
  const copyR = r => ({ ...clone(r), id: assignId(r.id) });
  if (sel.kind === 'r') {
    const r = db.routines.find(x => x.id === sel.id);
    return r ? { name: r.name, edits: [[assignId(r.id), { routine: copyR(r) }]] } : null;
  }
  const pr = db.programs.find(x => x.id === sel.id);
  if (!pr) return null;
  const used = new Set(pr.days.slice(0, pr.weeks).flatMap(w => w.r).filter(id => id && db.routines.some(r => r.id === id)));
  const prog = { id: assignId(pr.id), name: pr.name, weeks: pr.weeks, days: pr.days.map(w => ({ r: w.r.map(x => (x && used.has(x) ? assignId(x) : null)) })) };
  const edits = db.routines.filter(r => used.has(r.id)).map(r => [assignId(r.id), { routine: copyR(r) }]);
  edits.push([`prog_${prog.id}`, { program: prog }]);
  if (activate) edits.push(['plan', { plan: { weeks: prog.weeks, start: dayKeyOf(mondayOf(new Date())), days: clone(prog.days), prog: prog.id } }]);
  return { name: pr.name, edits };
}
const joinNames = l => (l.length > 1 ? `${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}` : l[0] || '');
async function assignToStudents(btn) {
  const list = students.filter(x => assignTo.has(x.studentUid)), job = assignSel && assignEdits(assignSel, assignActivate);
  if (!job || !list.length) return;
  const names = list.map(x => x.studentName || 'Alumno');
  const prog = assignSel.kind === 'p';
  if (!await ask(`¿Asignar ${prog ? 'el programa' : 'la rutina'} "${job.name}" a ${joinNames(names)}?${prog && assignActivate ? '\n\nQueda como su programa activo.' : ''}\n\nSi ya se lo habías asignado, se actualiza.`, 'Asignar')) return;
  await busy(btn, 'Enviando…', async () => {
    const at = Date.now();
    try {
      await withTimeout(Promise.all(list.flatMap(x => job.edits.map(([id, data]) => cloud.putCoachEdit(x.studentUid, id, { ...data, at, by: user.uid })))));
    } catch (e) { return notice('No se pudo asignar. Revisa tu internet e intenta de nuevo.'); }
    assignTo.clear();
    render();
    showNote(`Asignado a ${joinNames(names)}: les llega al abrir la app`);
  });
}
function viewAssign() {
  if (!coachOn()) { location.replace('#/alumnos'); return ''; }
  const progs = db.programs.filter(x => myProgDays(x.days)), routines = db.routines.filter(r => r.exercises.length);
  const opt = (kind, id, name, sub) => `<label class="toggle-row small-toggle">
      <input type="radio" name="asg" data-action="assign-pick" data-kind="${kind}" data-id="${esc(id)}" ${assignSel && assignSel.kind === kind && assignSel.id === id ? 'checked' : ''}>
      <span class="grow">${esc(name || '(sin nombre)')}<br><span class="muted small">${sub}</span></span></label>`;
  const ready = assignSel && assignTo.size;
  return `${header('Asignar', { back: true, sub: 'Una rutina o un programa tuyo' })}
    <h2>Qué asignar</h2>
    ${progs.length ? `<section class="card profile-fields"><span class="muted small">Programas</span>${progs.map(x => opt('p', x.id, x.name, plural(myProgDays(x.days), 'día') + ' por semana')).join('')}</section>` : ''}
    ${routines.length ? `<section class="card profile-fields"><span class="muted small">Rutinas</span>${routines.map(r => opt('r', r.id, r.name, plural(r.exercises.length, 'ejercicio'))).join('')}</section>`
      : '<p class="muted card">Primero crea tus rutinas o programas en Entreno: después los asignas aquí.</p>'}
    ${assignSel && assignSel.kind === 'p' ? `<label class="card toggle-row"><input type="checkbox" data-action="assign-act" ${assignActivate ? 'checked' : ''}>
      <span class="grow">Dejarlo como su programa activo<br><span class="muted small">En su Inicio verá qué le toca cada día.</span></span></label>` : ''}
    <h2>A quién</h2>
    ${students.length ? `<section class="card profile-fields">${students.map(x => `<label class="toggle-row small-toggle">
      <input type="checkbox" data-action="assign-to" data-uid="${esc(x.studentUid)}" ${assignTo.has(x.studentUid) ? 'checked' : ''}>
      <span class="grow">${esc(x.studentName || 'Alumno')}</span></label>`).join('')}</section>` : '<p class="muted card">Todavía no tienes alumnos.</p>'}
    <button class="btn primary block" data-action="assign-go" ${ready ? '' : 'disabled'} style="margin-top:14px">Asignar${assignTo.size ? ` a ${plural(assignTo.size, 'alumno')}` : ''}</button>
    <p class="muted small">Les llega a su app con un aviso. Si ya tenían un ejercicio con el mismo nombre, se mantiene su historial.</p>`;
}

// =============== Check-in semanal (lo envía el alumno, lo lee el coach) ===============
let checkinDraft = {};
const CHECK_Q = [
  ['energy', 'Energía', 'muy baja', 'muy alta'],
  ['sleepQ', 'Calidad del sueño', 'muy mala', 'muy buena'],
  ['recovery', 'Recuperación', 'muy cansado o adolorido', 'muy recuperado'],
  ['hunger', 'Hambre', 'nada', 'mucha'],
  ['stress', 'Estrés', 'nada', 'mucho'],
  ['motivation', 'Motivación', 'nada', 'mucha'],
  ['diet', 'Cumplimiento de la dieta', 'nada', 'al 100%'],
];
// Fotos de progreso: la más reciente (para recordar las del mes en el check-in)
const lastPhotoDate = () => (progList && progList.length ? progList[progList.length - 1].date : null);
const lastCheckinAt = () => (myCoach && myCoach.summary && myCoach.summary.lastCheckin) || 0;
const checkinSnoozeKey = () => `desdel-checkin-despues-${user.uid}`;
const checkinDue = () => !!myCoach && !viewing && Date.now() - lastCheckinAt() > 6 * 864e5 && localStorage.getItem(checkinSnoozeKey()) !== todayKey();
// Tu última semana (7 días): entrenos, peso promedio (y el de la semana anterior) y sueño promedio
function checkinStats() {
  const keys = Array.from({ length: 7 }, (_, k) => { const d = new Date(); d.setDate(d.getDate() - k); return dayKeyOf(d); });
  const prev = keys.map(k => { const d = new Date(`${k}T12:00:00`); d.setDate(d.getDate() - 7); return dayKeyOf(d); });
  const avg = l => (l.length ? round1(l.reduce((a, v) => a + v, 0) / l.length) : null);
  return {
    workouts: db.workouts.filter(w => keys.includes(dayKeyOf(w.date))).length,
    planned: keys.some(k => planOn(k)) ? keys.filter(k => plannedRoutine(k)).length : null,
    kg: avg(db.bodyweight.filter(e => keys.includes(e.date)).map(e => e.kg)),
    kgPrev: avg(db.bodyweight.filter(e => prev.includes(e.date)).map(e => e.kg)),
    sleep: avg(db.sleep.filter(e => keys.includes(e.date)).map(e => e.h)),
  };
}
const statsText = c => [`Entrenos: ${c.workouts}${c.planned ? ` de ${c.planned}` : ''}`,
  c.kg ? `Peso promedio: ${fmtNum(c.kg)} kg${c.kgPrev ? ` (${c.kg - c.kgPrev >= 0 ? '+' : ''}${fmtNum(round1(c.kg - c.kgPrev))} kg)` : ''}` : '',
  c.sleep ? `Sueño: ${fmtNum(c.sleep)} h` : ''].filter(Boolean).join(' · ');
function checkinCard() {
  if (!checkinDue()) return '';
  return `<section class="card hub coach-checkin">
      <a class="hub-top" href="#/checkin"><span class="hub-icon">📋</span><strong>Check-in semanal</strong></a>
      <span>Cuéntale a ${esc(myCoach.coachName || 'tu coach')} cómo te fue esta semana.</span>
      <div class="hub-btns"><a class="btn primary center" href="#/checkin">Hacer check-in</a><button class="btn" data-action="checkin-later">Después</button></div>
    </section>`;
}
function viewCheckin() {
  if (!myCoach) {
    if (!myCoachLoaded) return `${header('Check-in semanal', { back: true })}<p class="empty">Cargando…</p>`;
    location.replace('#/'); return '';
  }
  const st = checkinStats();
  if (!progError) loadProgress();   // para saber cuándo subiste tus últimas fotos
  const ph = lastPhotoDate(), phDays = ph ? daysSince(ph) : null;
  const photos = progList == null ? ''
    : ph && phDays < 28 ? `<section class="card checkin-photos"><span class="grow">📸 Fotos del mes ✓<br><span class="muted small">Las últimas son del ${fmtDMY(ph)}</span></span></section>`
    : `<section class="card checkin-photos"><span class="grow"><strong>📸 Toca tus fotos del mes</strong><br><span class="muted small">Frente, perfil y espalda, con la misma luz y ropa. Tu coach las ve en tus Fotos.</span></span>
        <a class="btn primary small-btn" href="#/fotos">Ir a Fotos</a></section>`;
  const scale = ([k, label, lo, hi]) => `<div class="field"><span>${label}</span>
      <div class="scale">${[1, 2, 3, 4, 5].map(v => `<button type="button" class="chip toggle ${checkinDraft[k] === v ? 'on' : ''}" data-action="checkin-set" data-k="${k}" data-v="${v}">${v}</button>`).join('')}</div>
      <span class="muted small">1 = ${lo} · 5 = ${hi}</span></div>`;
  return `${header('Check-in semanal', { back: true, sub: `Para ${myCoach.coachName || 'tu coach'}` })}
    <section class="card stack"><strong>Tus últimos 7 días</strong><span class="muted">${statsText(st)}</span>
      <span class="muted small">Se calcula solo con lo que anotaste.</span></section>
    ${photos}
    <form class="stack" data-form="checkin" novalidate>
      <section class="card stack">${CHECK_Q.map(scale).join('')}</section>
      <label class="field"><span>¿Algo que contarle a tu coach?</span>
        <textarea name="note" rows="4" maxlength="1500" placeholder="Molestias, cómo te sentiste, qué te costó, qué te gustaría cambiar…"></textarea></label>
      <p class="form-msg" hidden></p>
      <button class="btn primary block">Enviar check-in</button>
    </form>`;
}
async function sendCheckin(f) {
  if (CHECK_Q.some(([k]) => !checkinDraft[k])) return formMsg(f, 'Elige un número (1 a 5) en cada pregunta.');
  const data = { at: Date.now(), date: todayKey(), ...checkinStats(), ...Object.fromEntries(CHECK_Q.map(([k]) => [k, checkinDraft[k]])), note: f.elements.note.value.trim(),
    ...(lastPhotoDate() ? { photoAt: lastPhotoDate() } : {}) };
  await busy(f.querySelector('button'), 'Enviando…', async () => {
    try {
      await withTimeout(cloud.putCheckin(user.uid, todayKey(), data));
      lastCheckin = data.at;
      await withTimeout(cloud.updateCoachLink(user.uid, { summary: coachSummary() }));
    } catch (e) { return formMsg(f, 'No se pudo enviar. Revisa tu internet e intenta de nuevo.'); }
    checkinDraft = {};
    const chatId = [user.uid, myCoach.coachUid].sort().join('_');
    if (chats.some(c => c.id === chatId)) sendMsg(chatId, { type: 'text', text: 'Te envié mi check-in semanal.' }, 'Te envié mi check-in semanal.');
    const who = myCoach.coachName || 'tu coach';
    location.replace('#/');
    setTimeout(() => showNote(`Check-in enviado a ${who}`), 100);   // después de cambiar de pantalla
  });
}
let lastCheckin = 0;   // cuándo enviaste tu último check-in (va en el resumen para tu coach)
// Coach: los check-ins del alumno que estás viendo (arriba en su Inicio) y el aviso de "nuevo" en Mis alumnos
const seenKey = () => `desdel-checkin-visto-${user.uid}`;
const seenMap = () => { try { return JSON.parse(localStorage.getItem(seenKey())) || {}; } catch (e) { return {}; } };
function markCheckinSeen(link) {
  const m = seenMap(), at = (link.summary || {}).lastCheckin || 0;
  if (at && m[link.studentUid] !== at) { m[link.studentUid] = at; localStorage.setItem(seenKey(), JSON.stringify(m)); }
}
const checkinNew = link => { const at = (link.summary || {}).lastCheckin || 0; return at && seenMap()[link.studentUid] !== at; };
function studentCheckinsCard() {
  const list = viewing.checkins || [];
  const arrow = (v, before) => (before == null || v == null || v === before ? '' : `<span class="ck-arrow ${v > before ? 'up' : 'down'}">${v > before ? '↑' : '↓'}${before}</span>`);
  const item = (c, k) => {
    const prev = list[k + 1] || {};
    const answers = CHECK_Q.filter(([q]) => c[q] != null).map(([q, label]) =>
      `<span class="ck-chip"><span class="muted">${label}</span><strong>${c[q]}</strong>${arrow(c[q], prev[q])}</span>`).join('');
    const newPhotos = c.photoAt && c.photoAt !== prev.photoAt;
    return `<div class="checkin-item">
      <div class="coach-log-head"><span class="grow"><strong>${fmtDMY(c.date || c.id)}</strong></span><span class="muted small">${daysAgo(new Date(c.at).toISOString())}</span></div>
      <div class="ck-grid">${answers}</div>
      <div class="muted small">${statsText(c)}</div>
      ${newPhotos ? `<a class="ck-photos" href="#/fotos">📸 Fotos nuevas del ${fmtDMY(c.photoAt)} · Ver ›</a>` : ''}
      ${c.note ? `<p class="coach-comment-text">${esc(c.note)}</p>` : ''}
    </div>`;
  };
  return `<section class="card stack"><strong>Check-ins de ${esc(viewing.name)}</strong>
    ${list.length ? item(list[0], 0) : '<span class="muted small">Todavía no envía check-ins. Le aparece uno a la semana en su Inicio.</span>'}
    ${list.length > 1 ? `<details class="ck-older"><summary>Ver anteriores (${Math.min(list.length - 1, 4)})</summary>${list.slice(1, 5).map((c, k) => item(c, k + 1)).join('')}</details>` : ''}
    ${list.length ? '<span class="muted small">↑↓ = cómo cambió desde su check-in anterior (el número es el de antes).</span>' : ''}</section>`;
}

// Alumno: vincularse con un coach
async function linkCoachForm(f) {
  await busy(f.querySelector('button'), 'Buscando…', async () => {
    const code = normCode(f.elements.code.value);
    if (code.length !== 6) return formMsg(f, 'El código tiene 6 caracteres (ej. K7P-9XQ).');
    let cc = null;
    try { cc = await withTimeout(cloud.getCoachCode(code)); } catch (e) { return formMsg(f, 'Se necesita internet para vincularte.'); }
    if (!cc) return formMsg(f, 'No existe ningún coach con ese código.');
    await linkCoach(code, cc, text => formMsg(f, text));
  });
}
async function linkCoach(code, cc, showError) {
  const name = cc.ownerName || 'Tu coach';
  if (cc.ownerUid === user.uid) return showError('Ese es tu propio código de coach. Mándaselo a tus alumnos.');
  if (myCoach && myCoach.coachUid === cc.ownerUid) { go('#/coach'); return; }
  if (myCoach && !await ask(`Ya tienes como coach a ${myCoach.coachName || 'otra persona'}. ¿Cambiar a ${name}?`, 'Cambiar')) return;
  if (!await ask(`¿Vincular a ${name} como tu coach?\n\n${name} podrá ver todos tus datos: entrenamientos, peso, medidas, nutrición y fotos de progreso. También podrá cambiar tus rutinas, programas y dieta, y crearte nuevos.\n\nPuedes desvincularlo cuando quieras.`, 'Vincular')) return;
  try {
    if (myCoach) await withTimeout(clearCoachLink());
    await withTimeout(cloud.createCoachLink(user.uid, {
      studentUid: user.uid, studentName: user.username || '', coachUid: cc.ownerUid, coachName: name,
      via: code, since: Date.now(), summary: coachSummary(),
    }));
  } catch (e) {
    return showError('No se pudo vincular. Revisa tu internet e intenta de nuevo.');
  }
  // Quedan como gymbros para poder chatear
  const members = [user.uid, cc.ownerUid].sort(), chatId = members.join('_');
  if (!chats.some(c => c.id === chatId)) {
    let existing = null;
    try { existing = await withTimeout(cloud.getChat(chatId)); } catch (e) { /* se intenta crear */ }
    if (!existing) {
      cloud.createChat(chatId, { members, via: code, last: null, names: { [user.uid]: user.username || 'Gymbro', [cc.ownerUid]: name } }).catch(() => {});
    }
  }
  importOpen = false;
  go('#/coach');
  showNote(`${name} ahora es tu coach`);
}
// Borra el vínculo y los cambios de rutina pendientes de ese coach
async function clearCoachLink() {
  try { for (const ed of await cloud.listCoachEdits(user.uid)) await cloud.deleteCoachEdit(user.uid, ed.id); } catch (e) { /* no hay */ }
  await cloud.deleteCoachLink(user.uid);
}
async function unlinkCoach() {
  if (!myCoach) return;
  const name = myCoach.coachName || 'tu coach';
  if (!await ask(`¿Desvincular a ${name}? Dejará de ver tus datos y de poder cambiar tus rutinas. Siguen siendo gymbros.`, 'Desvincular')) return;
  try { await withTimeout(clearCoachLink()); } catch (e) { notice('No se pudo desvincular. Revisa tu internet e intenta de nuevo.'); }
}

const daysAgo = iso => {
  const n = Math.round((Date.parse(todayKey()) - Date.parse(String(iso).slice(0, 10))) / 864e5);
  return n <= 0 ? 'hoy' : n === 1 ? 'ayer' : `hace ${n} días`;
};
const daysSince = iso => Math.round((Date.parse(todayKey()) - Date.parse(String(iso).slice(0, 10))) / 864e5);

// Social: tu coach, tus alumnos o la invitación a activar el modo coach
function coachRows() {
  const coach = myCoach
    ? `<a class="card coach-row" href="#/coach"><span class="grow"><span class="muted small">Tu coach</span><strong>${esc(myCoach.coachName || 'Coach')}</strong></span><span class="chev">›</span></a>`
    : `<a class="card coach-row" href="#/coach"><span class="grow"><strong>Tengo coach</strong><span class="muted small">Vincúlate con tu entrenador</span></span><span class="chev">›</span></a>`;
  const mine = coachOn()
    ? `<a class="card coach-row" href="#/alumnos"><span class="grow"><strong>Mis alumnos</strong><span class="muted small">${studentsLoaded ? plural(students.length, 'alumno') : 'Cargando…'}</span></span><span class="chev">›</span></a>`
    : localStorage.getItem(`desdel-no-coach-${user.uid}`) === '1' ? ''
    : `<div class="card coach-row coach-offer"><a class="grow coach-offer-link" href="#/alumnos"><strong>¿Eres coach?</strong><span class="muted small">Sigue a tus alumnos en Desdel</span></a>
        <a class="btn small-btn" href="#/alumnos">Activar</a><button class="link small" data-action="coach-hide">No soy coach</button></div>`;
  return `<div class="coach-rows">${mine}${coach}</div>`;
}

function viewStudents() {
  if (!coachOn()) {
    return `${header('Modo coach', { back: true })}
      <section class="card stack">
        <strong>Sigue a tus alumnos en Desdel</strong>
        <ul class="guide-ul">
          <li>Ve sus entrenamientos serie por serie, su progreso, peso, medidas, nutrición y fotos.</li>
          <li>Cambia sus rutinas, programas y dieta, o créales nuevos: les llegan solos a su app.</li>
          <li>Comenta sus entrenos y recibe su check-in semanal.</li>
          <li>Ve de un vistazo quién entrenó esta semana y quién no.</li>
          <li>Tus alumnos se vinculan con tu código de coach y pueden desvincularse cuando quieran.</li>
        </ul>
        <span class="muted small">Puedes seguir usando Desdel para tus propios entrenamientos.</span>
        <button class="btn primary block" data-action="coach-on">Activar modo coach</button>
      </section>`;
  }
  const code = me().body.coachCode;
  const sorted = students.slice().sort((a, b) => ((b.summary || {}).last?.date || '').localeCompare((a.summary || {}).last?.date || ''));
  const list = sorted.map(l => {
    const sm = l.summary || {}, last = sm.last, idle = last ? daysSince(last.date) : null;
    loadProfile(l.studentUid);   // su foto de perfil (si tiene)
    return `<section class="card student">
      <button class="student-main" data-action="student-view" data-uid="${esc(l.studentUid)}">
        ${avatarHtml(l.studentName || 'Alumno', ((profiles.get(l.studentUid) || {}).data || {}).stats?.photo || null)}
        <span class="grow"><strong>${esc(l.studentName || 'Alumno')}</strong>
          <span class="muted small">${last ? `Último entreno: ${esc(last.name || 'Entreno')} · ${daysAgo(last.date)}` : 'Todavía no anota entrenamientos'}</span>
          <span class="muted small">Esta semana: ${sm.planned ? `${sm.week || 0} de ${sm.planned}` : plural(sm.week || 0, 'entreno')}${sm.kg ? ` · Peso: ${fmtNum(sm.kg)} kg` : ''}</span>
          ${idle != null && idle >= 4 ? `<span class="student-alert">Sin registrar hace ${idle} días</span>` : ''}
          ${checkinNew(l) ? '<span class="student-new">Check-in nuevo</span>' : ''}</span>
        <span class="chev">›</span>
      </button>
      ${chats.some(c => c.id === [user.uid, l.studentUid].sort().join('_')) ? `<a class="icon student-chat" href="#/chat/${[user.uid, l.studentUid].sort().join('_')}" aria-label="Chat con ${esc(l.studentName || 'tu alumno')}"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z"/></svg></a>` : ''}
    </section>`;
  }).join('');
  const codeBox = `<section class="card share-box">
      <div class="muted">Tu código de coach</div>
      ${code ? `<div class="code">${fmtCode(code)}</div>
        <div class="ex-actions">
          <button class="btn primary" data-action="coach-send">Enviar</button>
        </div>`
      : coachCodeError ? '<p>No se pudo crear tu código. Revisa tu internet.</p><button class="btn primary" data-action="coach-retry">Reintentar</button>'
      : '<p class="muted">Creando tu código…</p>'}
      <p class="muted hint">Mándaselo solo a tus alumnos: quien lo use te da acceso a todos sus datos. Es distinto de tu código de gymbro.</p>
    </section>`;
  // Con alumnos, la lista va primero y el código queda chico abajo (Invitar alumno)
  const invite = code ? `<section class="card invite-row">
      <span class="grow"><span class="muted small">Tu código de coach</span><strong>${fmtCode(code)}</strong></span>
      <button class="btn primary small-btn" data-action="coach-send">+ Invitar alumno</button>
    </section>` : codeBox;
  return `${header('Mis alumnos', { back: true, sub: 'Modo coach' })}
    ${students.length ? '' : codeBox}
    ${students.length ? '<a class="btn block center" href="#/asignar" style="margin:0 0 12px">Asignar rutina o programa</a>' : ''}
    ${!studentsLoaded ? '<p class="empty">Cargando…</p>' : list || '<p class="empty">Todavía no tienes alumnos. Mándales tu código: en Desdel van a Social → Tengo coach.</p>'}
    ${students.length ? invite : ''}
    <p class="muted small" style="margin-top:20px">Para dejar de usar el modo coach, ve a Cuenta.</p>`;
}

function viewMyCoach() {
  if (myCoach) {
    const name = myCoach.coachName || 'tu coach', chatId = [user.uid, myCoach.coachUid].sort().join('_');
    const WHAT = { edit: 'Cambió', new: 'Te creó', del: 'Eliminó' };
    const log = coachLog.map(x => `<div class="coach-log"><div class="coach-log-head"><span class="grow">${x.text ? esc(x.text) : `${WHAT[x.what] || 'Cambió'} la rutina <strong>${esc(x.name)}</strong>`}</span><span class="muted small">${daysAgo(new Date(x.at).toISOString())}</span></div>
      ${(x.changes || []).length ? `<ul class="coach-log-list">${x.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</div>`).join('');
    return `${header('Mi coach', { back: true })}
      <section class="card stack">
        <div><span class="muted small">Tu coach</span><br><strong class="coach-name">${esc(name)}</strong></div>
        <span class="muted small">Desde el ${fmtDMY(new Date(myCoach.since || Date.now()).toISOString().slice(0, 10))}</span>
        ${chats.some(c => c.id === chatId) ? `<a class="btn primary block center" href="#/chat/${chatId}">Escribirle a ${esc(name)}</a>` : ''}
      </section>
      <h2>Lo que hizo tu coach</h2>
      <section class="card">${log || '<p class="muted" style="margin:0">Cuando tu coach te cambie o cree una rutina o un programa, aparecerá aquí. Los cambios te llegan solos.</p>'}</section>
      <p class="muted small" style="margin:24px 0 8px">${esc(name)} puede ver tus entrenamientos, peso, medidas, nutrición y fotos de progreso, y cambiar tus rutinas, programas y dieta.</p>
      <button class="btn ghost block danger-text" data-action="coach-unlink">Desvincular coach</button>`;
  }
  return `${header('Tengo coach', { back: true })}
    <section class="card stack">
      <p style="margin:0">Pídele a tu coach su <strong>código de coach</strong> y escríbelo aquí.</p>
      <p class="muted small" style="margin:0">Tu coach podrá ver todos tus datos (entrenamientos, peso, medidas, nutrición y fotos) y cambiar tus rutinas, programas y dieta. Puedes desvincularlo cuando quieras.</p>
      <form class="stack" data-form="coach-code" novalidate>
        <div class="add-row">
          <input name="code" placeholder="Código (ej. K7P-9XQ)" autocomplete="off" autocapitalize="characters" maxlength="9" aria-label="Código de coach">
          <button class="btn primary">Vincular</button>
        </div>
        <p class="form-msg" hidden></p>
      </form>
      <button class="btn block" data-action="coach-paste">📋 Pegar código</button>
    </section>`;
}

// ---------- Social: gymbros y chats 1 a 1 ----------
// Cada uno tiene un código de gymbro (invites/{código}). Quien lo usa crea el chat entre los dos (chats/{uidA_uidB}).
let chats = [];               // chats con tus gymbros, en vivo
let chatsLoaded = false, chatsError = false;
let stopChats = () => {};
let chatMsgs = { id: null, list: [], loaded: false, stop: () => {} };
let attach = null;            // panel para enviar: null | 'menu' | 'diet' | 'routine' | 'workout'
let selectedMsg = null;       // mensaje tuyo tocado o mantenido apretado (muestra Editar / Eliminar)
let editingMsg = null;        // mensaje tuyo que estás editando
let inviteBusy = false, inviteError = false;
let prsSent = null;           // { id, n } PRs avisados al terminar un entrenamiento

const inviteKey = () => `desdel-gymbro-${user.uid}`;
const inviteCode = () => localStorage.getItem(inviteKey());
const inviteLink = code => `${location.origin}${location.pathname}?g=${code}`;
const inviteText = code => `Agrégame como gymbro en Desdel 💪\n\nToca el link:\n${inviteLink(code)}\n\n` +
  `Si no se abre, copia este código, abre Desdel y en Social → Agregar gymbro toca "Pegar código": ${fmtCode(code)}`;
const autoPRKey = () => `desdel-avisar-pr-${user.uid}`;
const autoPR = () => localStorage.getItem(autoPRKey()) !== '0';

// Leídos: hasta qué mensaje viste cada chat (en este teléfono)
const readKey = () => `desdel-leido-${user.uid}`;
function readMap() { try { return JSON.parse(localStorage.getItem(readKey())) || {}; } catch (e) { return {}; } }
function markRead(chatId, at) {
  const m = readMap();
  if (!at || (m[chatId] || 0) >= at) return;
  m[chatId] = at;
  localStorage.setItem(readKey(), JSON.stringify(m));
}
const isUnread = c => !!c.last && c.last.from !== user.uid && c.last.at > (readMap()[c.id] || 0);
const otherUid = c => c.members.find(m => m !== user.uid);
const gymbroName = c => (c.names && c.names[otherUid(c)]) || 'Gymbro';
const hhmm = ms => new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const fmtWhen = ms => (sameDay(ms, Date.now()) ? hhmm(ms) : new Date(ms).toLocaleDateString('es', { day: 'numeric', month: 'short' }));
const dayLabel = ms => (sameDay(ms, Date.now()) ? 'Hoy' : sameDay(ms, Date.now() - 86400000) ? 'Ayer' : fmtDate(ms));

function onChats(list) {
  const first = !chatsLoaded;
  if (list.length && !chats.length) scheduleProfile();   // con gymbros, se publica tu perfil
  chats = list;
  chatsLoaded = true; chatsError = false;
  // Si cambiaste tu nombre de usuario, se actualiza en tus chats
  for (const c of chats) {
    if (user.username && c.names && c.names[user.uid] !== user.username) cloud.renameInChat(c.id, user.uid, user.username).catch(() => {});
  }
  const [screen, arg] = routeParts();
  if (screen === 'chat') {
    const c = chats.find(x => x.id === arg);
    if (c && c.last) markRead(c.id, c.last.at);
    if (!c || first || !$app.querySelector('.chat-msgs')) refresh();   // terminó de cargar o se borró
    return;
  }
  if (screen === '' || screen === 'social' || screen === 'alumnos') refresh();
  // Perfil: cuando terminan de cargar los chats, o si se borró ese gymbro
  else if (screen === 'perfil' && (first || (arg !== 'yo' && !chats.some(x => x.id === arg)))) refresh();
}

function startSocial(uid) {
  chatsLoaded = false; chatsError = false;
  stopChats = cloud.listenChats(uid, onChats, () => {
    chatsError = true; chatsLoaded = true;
    if (['', 'social', 'chat'].includes(routeParts()[0])) refresh();
  });
}
function stopSocial() {
  stopCoach();
  stopChats(); stopChats = () => {};
  closeMessages();
  chats = []; chatsLoaded = false;
}

function socialCard() {
  const unread = chats.filter(isUnread);
  if (!unread.length) return '';
  const names = unread.map(c => gymbroName(c));
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  return `<a class="card hub hub-msg" href="${unread.length === 1 ? `#/chat/${unread[0].id}` : '#/social'}">
      <span class="hub-icon">💬</span><span><strong>${esc(who)}</strong> ${unread.length === 1 ? 'te escribió' : 'te escribieron'}</span>
    </a>`;
}

function viewSocial() {
  const when = c => (c.last ? c.last.at : c.createdAt || 0);
  const list = chats.slice().sort((a, b) => when(b) - when(a)).map(c => {
    const name = gymbroName(c);
    loadProfile(otherUid(c));
    return `<a class="card chat-item" href="#/chat/${c.id}">
      ${avatarHtml(name, gymbroPhoto(c))}
      <div class="grow"><strong>${esc(name)}</strong>
        <span class="muted small">${c.last ? esc(`${c.last.from === user.uid ? 'Tú: ' : ''}${c.last.text}`) : 'Saluda a tu gymbro 👋'}</span></div>
      ${isUnread(c) ? '<span class="dot-new" aria-label="Mensajes nuevos"></span>' : `<span class="muted small">${c.last ? fmtWhen(c.last.at) : ''}</span>`}
    </a>`;
  }).join('');
  return `${header('Social', { sub: 'Chatea con tus gymbros' })}
    <div class="social-top">
      <a class="btn primary center" href="#/gymbro">+ Agregar gymbro</a>
      <a class="btn center" href="#/perfil/yo">Mi perfil</a>
    </div>
    ${coachRows()}
    ${!chatsLoaded ? '<p class="empty">Cargando…</p>'
      : chatsError && !chats.length ? '<p class="empty">No se pudieron cargar tus chats. Revisa tu internet y vuelve a abrir la app.</p>'
      : list || '<p class="empty">Todavía no tienes gymbros. Toca "Agregar gymbro" y mándale tu link a un amigo.</p>'}`;
}

// Mi perfil → Privacidad: qué ven tus gymbros y los avisos de PRs
function viewPrivacy() {
  const sessions = exerciseSessions(), pick = db.body.prPick || [];
  return `${header('Privacidad', { back: true, sub: 'Lo que ven tus gymbros en tu perfil' })}
    <label class="card toggle-row" style="margin-top:0">
      <input type="checkbox" data-action="share-profile" ${shareProfile() ? 'checked' : ''}>
      <span class="grow">Compartir mi perfil con mis gymbros<br><span class="muted small">Si lo apagas, solo ven tu nombre. Nadie más que tus gymbros puede verlo.</span></span>
    </label>
    ${shareProfile() ? `
    <h2>Mostrar en mi perfil</h2>
    <section class="card profile-fields">
      ${PROFILE_FIELDS.map(([k, label]) => `<label class="toggle-row small-toggle">
        <input type="checkbox" data-action="profile-field" data-k="${k}" ${showInProfile(k) ? 'checked' : ''}> <span>${label}</span>
      </label>`).join('')}
    </section>
    <h2>Récords destacados</h2>
    <p class="muted small" style="margin:0 0 8px">Elige hasta 5 (${pick.length}/5). Si no eliges ninguno, se muestran tus 5 ejercicios más entrenados.</p>
    ${sessions.length ? `<section class="card profile-fields">
      ${sessions.map(x => `<label class="toggle-row small-toggle">
        <input type="checkbox" data-action="pr-pick" data-id="${esc(x.id)}" ${pick.includes(x.id) ? 'checked' : ''} ${!pick.includes(x.id) && pick.length >= 5 ? 'disabled' : ''}>
        <span class="grow">${esc(x.name)}</span><span class="muted small">${plural(x.n, 'sesión', 'sesiones')}</span>
      </label>`).join('')}
    </section>` : '<p class="muted card">Cuando guardes entrenamientos podrás elegirlos aquí.</p>'}` : ''}
    <h2>Avisos</h2>
    <label class="card toggle-row" style="margin-top:0">
      <input type="checkbox" data-action="auto-pr" ${autoPR() ? 'checked' : ''}>
      <span class="grow">Avisar mis PRs a mis gymbros<br><span class="muted small">Cuando superes el récord estimado (1RM) de uno de tus récords destacados, se envía solo a tus chats.</span></span>
    </label>`;
}

function viewAddGymbro() {
  const code = inviteCode();
  return `${header('Agregar gymbro', { back: true })}
    <section class="card share-box">
      <div class="muted">Tu código de gymbro</div>
      ${code ? `<div class="code">${fmtCode(code)}</div>
        <div class="ex-actions">
          <button class="btn primary" data-action="send-invite">Enviar</button>
        </div>`
      : inviteError ? '<p>No se pudo crear tu código. Revisa tu internet.</p><button class="btn primary" data-action="make-invite">Reintentar</button>'
      : '<p class="muted">Creando tu código…</p>'}
      <p class="muted hint">Mándale tu link a un amigo. Cuando lo toque quedan conectados como gymbros y pueden chatear. Solo puede agregarte quien tenga tu código.</p>
    </section>
    ${importForm('¿Te pasaron un código de gymbro?', 'gymbro')}`;
}

// Crea tu código de gymbro la primera vez (si ya existe ese código se prueba otro)
async function ensureInvite() {
  if (inviteCode() || inviteBusy || inviteError) return;
  inviteBusy = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newCode();
    try {
      await withTimeout(cloud.createInvite(code, { ownerUid: user.uid, ownerName: user.username || '' }));
      localStorage.setItem(inviteKey(), code);
      break;
    } catch (e) {
      if (e.code === 'permission-denied' && attempt < 2) continue;
      inviteError = true;
      break;
    }
  }
  inviteBusy = false;
  if (routeParts()[0] === 'gymbro') refresh();
}

async function addGymbro(code, inv, showError) {
  if (inv.ownerUid === user.uid) return showError('Ese es tu propio código de gymbro. Mándaselo a un amigo.');
  const members = [user.uid, inv.ownerUid].sort();
  const id = members.join('_');
  let existing = chats.find(c => c.id === id);
  if (!existing) { try { existing = await withTimeout(cloud.getChat(id)); } catch (e) { /* se intenta crear */ } }
  if (!existing) {
    if (!await ask(`¿Agregar a ${inv.ownerName || 'este usuario'} como gymbro?`)) return;
    try {
      await withTimeout(cloud.createChat(id, {
        members, via: code, last: null,
        names: { [user.uid]: user.username || 'Gymbro', [inv.ownerUid]: inv.ownerName || 'Gymbro' },
      }));
    } catch (e) {
      return showError('No se pudo agregar. Revisa tu internet e intenta de nuevo.');
    }
  }
  importOpen = false;
  go('#/chat/' + id);
}

// Mensajes del chat abierto (en vivo mientras está en pantalla)
function openMessages(id) {
  if (chatMsgs.id === id) return;
  closeMessages();
  chatMsgs = { id, list: [], loaded: false, stop: () => {} };
  chatMsgs.stop = cloud.listenMessages(id, list => {
    if (chatMsgs.id !== id) return;
    chatMsgs.list = list;
    chatMsgs.loaded = true;
    const c = chats.find(x => x.id === id);
    if (c && c.last) markRead(id, c.last.at);
    paintMessages();
    if (routeParts()[0] === 'perfil') refresh();
  });
}
function closeMessages() {
  selectedMsg = null;
  editingMsg = null;
  chatMsgs.stop();
  chatMsgs = { id: null, list: [], loaded: false, stop: () => {} };
}

function viewChat(id) {
  const c = chats.find(x => x.id === id);
  if (!c) {
    if (chatsLoaded) { location.replace('#/social'); return ''; }
    return `${header('Chat', { back: true })}<p class="empty">Cargando…</p>`;
  }
  openMessages(id);
  loadProfile(otherUid(c));
  return `${header(gymbroName(c), { back: true, sub: 'Ver perfil ›', href: `#/perfil/${c.id}`, avatar: avatarHtml(gymbroName(c), gymbroPhoto(c), 'small') })}
    <div class="chat-msgs">${msgsHtml()}</div>
    ${attachPanel()}
    <form class="chat-bar ${editingMsg ? 'editing' : ''}" data-form="chat-send" novalidate>
      ${editingMsg ? `<div class="edit-banner"><span>✏️ Editando mensaje</span><button type="button" class="btn ghost small-btn" data-action="msg-edit-cancel">Cancelar</button></div>`
        : '<button type="button" class="icon" data-action="attach" aria-label="Enviar dieta, rutina o entrenamiento">＋</button>'}
      <input name="text" placeholder="Mensaje" autocomplete="off" maxlength="1000" enterkeyhint="${editingMsg ? 'done' : 'send'}" aria-label="Mensaje">
      <button class="btn primary">${editingMsg ? 'Guardar' : 'Enviar'}</button>
    </form>`;
}

function msgsHtml() {
  if (!chatMsgs.loaded) return '<p class="empty">Cargando…</p>';
  if (!chatMsgs.list.length) return '<p class="empty">Todavía no hay mensajes. ¡Saluda! 👋<br>Con ＋ puedes enviarle una dieta, una rutina o un entrenamiento.</p>';
  let lastDay = '';
  return chatMsgs.list.map(m => {
    const day = dayLabel(m.at);
    const sep = day !== lastDay ? `<div class="chat-day">${day}</div>` : '';
    lastDay = day;
    const mine = m.from === user.uid, sel = mine && selectedMsg === m.id;
    // Tus mensajes: al tocarlos aparece "Eliminar"
    return `${sep}<div class="msg ${mine ? 'mine' : ''} ${sel ? 'selected' : ''}" ${mine ? `data-action="msg-select" data-id="${esc(m.id)}"` : ''}>${msgBody(m, mine)}<span class="msg-time">${m.edited ? 'editado · ' : ''}${hhmm(m.at)}</span></div>
      ${sel ? `<div class="msg-actions">
        ${m.type === 'text' ? `<button class="btn small-btn" data-action="msg-edit" data-id="${esc(m.id)}">✏️ Editar</button>` : ''}
        <button class="btn small-btn danger-text" data-action="msg-del" data-id="${esc(m.id)}">🗑 Eliminar para los dos</button>
      </div>` : ''}`;
  }).join('');
}

function msgBody(m, mine) {
  const add = label => (mine ? '' : `<button class="btn" data-action="msg-add" data-id="${esc(m.id)}">${label}</button>`);
  switch (m.type) {
    case 'diet':
      return `<div class="msg-card"><span class="muted small">🥗 Dieta</span><strong>${esc(m.diet.name)}</strong>
        <span class="muted small">${plural(m.diet.meals.length, 'comida')} · ${fmtKcal(sharedDietKcal(m.diet))} kcal</span>${add('Agregar a mis dietas')}</div>`;
    case 'routine':
      return `<div class="msg-card"><span class="muted small">🏋️ Rutina</span><strong>${esc(m.routine.name)}</strong>
        <span class="muted small">${esc(m.routine.exercises.map(ex => ex.name).join(' · '))}</span>${add('Agregar a mis rutinas')}</div>`;
    case 'workout':
      return `<div class="msg-card"><span class="muted small">💪 Entrenamiento</span><div class="pre">${esc(m.text)}</div></div>`;
    case 'program':
      return `<div class="msg-card"><span class="muted small">📅 Programa</span><strong>${esc(m.program.name)}</strong>
        <span class="muted small">${plural(payloadDays(m.program), 'día')} por semana${m.program.weeks > 1 ? ` · se repite cada ${m.program.weeks} semanas` : ''}</span>
        <span class="muted small">${esc(payloadWeekLine(m.program))}</span>${add('Añadir a mis programas')}</div>`;
    case 'pr':
      return `<div class="msg-card"><span class="muted small">🔥 ¡Nuevo PR!</span><div class="pre">${esc(m.text)}</div></div>`;
    default:
      return `<div class="pre">${esc(m.text || '')}</div>`;
  }
}

// Repinta solo los mensajes (sin redibujar la pantalla, para no cerrar el teclado)
function paintMessages() {
  const box = $app.querySelector('.chat-msgs');
  if (!box) return;
  const doc = document.documentElement;
  const nearBottom = innerHeight + scrollY >= doc.scrollHeight - 160;
  box.innerHTML = msgsHtml();
  const last = chatMsgs.list[chatMsgs.list.length - 1];
  if (nearBottom || (last && last.from === user.uid)) scrollChatBottom();
}
const scrollChatBottom = () => requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));

function attachPanel() {
  if (!attach) return '';
  if (attach === 'menu') {
    return `<section class="card attach">
      <button class="btn block" data-action="attach-pick" data-kind="diet">🥗 Enviar una dieta</button>
      <button class="btn block" data-action="attach-pick" data-kind="routine">🏋️ Enviar una rutina</button>
      <button class="btn block" data-action="attach-pick" data-kind="workout">💪 Enviar un entrenamiento</button>
      <button class="btn block" data-action="attach-pick" data-kind="program">📅 Enviar un programa</button>
      <button class="btn ghost block" data-action="attach-close">Cancelar</button>
    </section>`;
  }
  const items = attach === 'program'
    ? db.programs.map(p => [p.id, p.name || '(sin nombre)', `${plural(myProgDays(p.days), 'día')} por semana`])
    : attach === 'diet'
    ? N().diets.map(d => [d.id, d.name, `${plural(d.meals.length, 'comida')} · ${fmtKcal(dietMacros(d).kcal)} kcal`])
    : attach === 'routine'
      ? db.routines.filter(r => r.exercises.length).map(r => [r.id, r.name || '(sin nombre)', plural(r.exercises.length, 'ejercicio')])
      : db.workouts.slice(-20).reverse().map(w => [w.id, w.routineName, fmtDate(w.date)]);
  const title = { diet: '¿Qué dieta?', routine: '¿Qué rutina?', workout: '¿Qué entrenamiento?', program: '¿Qué programa?' }[attach];
  const none = { diet: 'Todavía no tienes dietas.', routine: 'Todavía no tienes rutinas con ejercicios.', workout: 'Todavía no tienes entrenamientos guardados.',
    program: 'Todavía no tienes programas. Créalos en Entreno → Programas.' }[attach];
  return `<section class="card attach">
      <div class="muted small">${title}</div>
      ${items.map(([id, name, sub]) => `<button class="btn block attach-item" data-action="attach-send" data-id="${id}">
        <span class="grow">${esc(name)}</span><span class="muted small">${esc(sub)}</span></button>`).join('') || `<p class="muted">${none}</p>`}
      <button class="btn ghost block" data-action="attach-close">Cancelar</button>
    </section>`;
}

function sendMsg(chatId, msg, preview) {
  return cloud.sendMessage(chatId, { from: user.uid, ...msg }, preview.slice(0, 120))
    .catch(() => notice('No se pudo enviar el mensaje. Revisa tu internet e intenta de nuevo.'));
}

function sendText(f) {
  const text = f.elements.text.value.trim();
  if (!text) return;
  if (editingMsg) return saveMsgEdit(text);
  f.elements.text.value = '';
  f.elements.text.focus();
  sendMsg(routeParts()[1], { type: 'text', text }, text);
}

// Editar un mensaje tuyo: el texto pasa a la barra de abajo y "Guardar" lo cambia para los dos
function startMsgEdit(id) {
  const m = chatMsgs.list.find(x => x.id === id);
  if (!m || m.type !== 'text') return;
  editingMsg = id;
  selectedMsg = null;
  attach = null;
  render();
  const input = $app.querySelector('[data-form="chat-send"] input');
  input.value = m.text;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  const bubble = $app.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (bubble) bubble.scrollIntoView({ block: 'center' });   // que se vea el mensaje que estás editando
}
function cancelMsgEdit() {
  editingMsg = null;
  render();
}
function saveMsgEdit(text) {
  const id = editingMsg, chatId = chatMsgs.id, m = chatMsgs.list.find(x => x.id === id);
  editingMsg = null;
  if (m && m.text !== text) {
    const isLast = chatMsgs.list[chatMsgs.list.length - 1] === m;
    m.text = text; m.edited = true;   // se ve al tiro; la nube lo confirma después
    cloud.editMessage(chatId, id, text, isLast ? { text: text.slice(0, 120), from: m.from, at: m.at } : undefined)
      .catch(() => notice('No se pudo editar el mensaje. Revisa tu internet e intenta de nuevo.'));
  }
  render();
}

function sendAttachment(id) {
  const chatId = routeParts()[1];
  if (attach === 'program') {
    const p = db.programs.find(x => x.id === id), pr = p && checkSendable(p);
    if (!pr) return;
    sendMsg(chatId, { type: 'program', program: pr }, `📅 Programa: ${pr.name}`);
  } else if (attach === 'diet') {
    const d = dietById(id);
    sendMsg(chatId, { type: 'diet', diet: dietPayload(d) }, `🥗 Dieta: ${d.name}`);
  } else if (attach === 'routine') {
    const r = db.routines.find(x => x.id === id);
    sendMsg(chatId, { type: 'routine', routine: routinePayload(r) }, `🏋️ Rutina: ${r.name}`);
  } else {
    const w = db.workouts.find(x => x.id === id);
    sendMsg(chatId, { type: 'workout', text: workoutShareText(w, true) }, `💪 Entrenamiento: ${w.routineName}`);
  }
  attach = null;
  render();
  scrollChatBottom();
}

// Texto corto del mensaje para la lista de chats
const msgPreview = m => ({
  diet: () => `🥗 Dieta: ${m.diet.name}`,
  routine: () => `🏋️ Rutina: ${m.routine.name}`,
  workout: () => '💪 Entrenamiento',
  pr: () => '🔥 Nuevo PR',
  program: () => `📅 Programa: ${m.program.name}`,
}[m.type] || (() => m.text || ''))().slice(0, 120);

// Borra un mensaje tuyo para los dos; si era el último, la lista de chats muestra el anterior
function deleteMessage(id) {
  const k = chatMsgs.list.findIndex(x => x.id === id);
  if (k < 0) return;
  const chatId = chatMsgs.id;
  const rest = chatMsgs.list.filter(x => x.id !== id);
  const wasLast = k === chatMsgs.list.length - 1;
  const prev = rest[rest.length - 1];
  const last = !wasLast ? undefined : prev ? { text: msgPreview(prev), from: prev.from, at: prev.at } : null;
  selectedMsg = null;
  chatMsgs.list = rest;   // se quita al tiro de la pantalla
  paintMessages();
  cloud.deleteMessage(chatId, id, last).catch(() => notice('No se pudo eliminar el mensaje. Revisa tu internet e intenta de nuevo.'));
}

// Agregar a tu app la dieta o rutina que te mandaron
function addFromMessage(id) {
  const m = chatMsgs.list.find(x => x.id === id);
  const c = chats.find(x => x.id === chatMsgs.id);
  if (!m) return;
  const data = { ownerName: c ? gymbroName(c) : '' };
  if (m.type === 'program') useSharedProgram(m.program, data.ownerName);
  else if (m.type === 'diet') importDiet({ ...data, diet: m.diet });
  else if (m.type === 'routine') importRoutineData({ ...data, routine: m.routine });
}

// Básicos: sus récords muestran el 1RM estimado (o el lastre máx. en dominadas y fondos)
const E1RM_GUIDES = new Set(['sentadilla', 'sentadilla-frontal', 'peso-muerto', 'peso-muerto-sumo', 'peso-muerto-rumano', 'press-banca', 'press-inclinado-barra',
  'press-militar', 'press-militar-sentado', 'dominadas', 'dominadas-supinas', 'fondos']);
const showsE1rm = ex => { const g = guideFor(ex.name, (db.routines.flatMap(r => r.exercises).find(e => e.id === ex.exerciseId) || {}).guide); return !!g && E1RM_GUIDES.has(g.id); };
// PRs del entrenamiento: 1RM estimado de la 1ª serie mayor que el mejor anterior (en cualquier rutina),
// y desde la 2ª serie, superar a tu mejor serie de esa misma posición en esa rutina (lo que marca el gráfico que sube)
function newPRs(w) {
  const firstE1rm = (ex, date) => {
    const s = ex.sets.find(x => x.w != null);
    return s ? toKg(e1rmEx(ex, s, date), ex.unit) : 0;
  };
  const prs = [], idx = db.workouts.indexOf(w);
  for (const ex of w.exercises) {
    const cur = firstE1rm(ex, w.date);
    if (!cur) continue;
    let prev = 0;
    // Solo contra los entrenos anteriores (al mirar uno antiguo, los de después no cuentan)
    for (const o of db.workouts.slice(0, idx < 0 ? db.workouts.length : idx)) {
      const oe = o.exercises.find(e => e.exerciseId === ex.exerciseId);
      if (oe && unitKind(oe.unit) === unitKind(ex.unit)) prev = Math.max(prev, firstE1rm(oe, o.date));
    }
    if (prev > 0 && cur > prev + 0.01) {
      const s = ex.sets.find(x => x.w != null);
      const bw = isBwEx(ex);
      const est = showsE1rm(ex) ? ` → ${bw ? 'lastre máx.' : '1RM'} ≈ ${bw ? '+' : ''}${fmtNum(round1(e1rmEx(ex, s, w.date)))} ${ex.unit}` : '';
      prs.push({ id: ex.exerciseId, name: ex.name, text: `${ex.name}: ${fmtNum(s.w)} ${ex.unit} × ${fmtNum(s.r || 1)}${s.rir != null ? ` · RIR ${fmtNum(s.rir)}` : ''}${bw ? ' + peso corporal' : ''}${est}` });
    }
    const best = bestSets(ex.exerciseId, idx < 0 ? db.workouts.length : idx, ex.unit, ex.extra ? null : w.routineId);
    const first = ex.sets.findIndex(x => x.w != null);
    ex.sets.forEach((x, j) => {
      if (j <= first || x.w == null || !best[j]) return;
      const c = { w: x.w, r: x.r, rir: x.rir, unit: ex.unit, bw: bwFor(ex, w.date) };
      if (cmpSet(c, best[j]) > 0) {
        prs.push({ id: ex.exerciseId, name: ex.name, text: `${ex.name} · serie ${j + 1}: ${setText(x, ex.unit)}`, was: ` (antes ${fmtNum(best[j].w)} ${best[j].unit} × ${fmtNum(best[j].r)})` });
      }
    });
  }
  return prs;
}

function announcePRs(w) {
  const featured = featuredExerciseIds();
  const prs = newPRs(w).filter(pr => featured.includes(pr.id));   // solo de tus récords destacados
  if (!prs.length || !autoPR() || !chats.length) return;
  const text = prs.map(p => p.text).join('\n');
  const preview = `🔥 Nuevo PR: ${prs[0].name}${prs.length > 1 ? ` y ${prs.length - 1} más` : ''}`;
  for (const c of chats) sendMsg(c.id, { type: 'pr', text }, preview);
  prsSent = { id: w.id, n: prs.length };
}

// Mantener apretado un mensaje tuyo (como en WhatsApp) muestra Editar / Eliminar
let pressTimer = null, pressStart = null, longPressed = false;
$app.addEventListener('pointerdown', e => {
  const msg = e.target.closest('.msg.mine');
  if (!msg || e.target.closest('a, button')) return;
  pressStart = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longPressed = true;
    selectedMsg = msg.dataset.id;
    if (navigator.vibrate) navigator.vibrate(15);
    paintMessages();
  }, 450);
});
const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
$app.addEventListener('pointerup', cancelPress);
$app.addEventListener('pointercancel', cancelPress);
$app.addEventListener('pointermove', e => {
  if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();   // está haciendo scroll
});
// Sin el menú del navegador al mantener apretado
$app.addEventListener('contextmenu', e => { if (e.target.closest('.msg.mine')) e.preventDefault(); });

// ---------- Foto de perfil ----------
// Se achica a 256×256 (JPEG, ~20 KB) y se guarda en users/{uid}/data/photo (tus teléfonos) y en tu perfil (tus gymbros).
// Si pones foto, la ven tus gymbros; si no, se ve tu inicial.
const photoKey = () => `desdel-foto-${user.uid}`;
let myPhoto = null;
const safePhoto = url => (typeof url === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : null);
function avatarHtml(name, photo, cls = '') {
  const url = safePhoto(photo);
  return url
    ? `<img class="avatar ${cls}" src="${url}" alt="">`
    : `<span class="avatar ${cls}" aria-hidden="true">${esc((name || '').trim().charAt(0).toUpperCase() || '?')}</span>`;
}
const gymbroPhoto = c => ((profiles.get(otherUid(c)) || {}).data || {}).stats?.photo || null;

// Al entrar: la foto guardada en este teléfono, o la de la nube
async function loadMyPhoto(uid) {
  myPhoto = localStorage.getItem(`desdel-foto-${uid}`);
  if (myPhoto) return;
  try {
    const url = safePhoto(await cloud.getPhoto(uid));
    if (url && user && user.uid === uid) { myPhoto = url; localStorage.setItem(photoKey(), url); refresh(); }
  } catch (e) { /* sin internet: se intenta la próxima vez */ }
}

async function setMyPhoto(url) {
  const prev = myPhoto;
  myPhoto = url;
  if (url) localStorage.setItem(photoKey(), url); else localStorage.removeItem(photoKey());
  render();
  try {
    await withTimeout(url ? cloud.putPhoto(user.uid, url) : cloud.deletePhoto(user.uid));
    scheduleProfile();   // tus gymbros la ven en tu perfil
  } catch (e) {
    myPhoto = prev;
    if (prev) localStorage.setItem(photoKey(), prev); else localStorage.removeItem(photoKey());
    render();
    notice('No se pudo guardar la foto. Revisa tu internet e intenta de nuevo.');
  }
}

// Ajustar la foto antes de usarla: arrastrar para moverla y barra de zoom.
// Un recorte es { img, src, bw, bh (tamaño del cuadro en pantalla), base, zoom, ox, oy, drag }
const CROP_BOX = 240;
let photoEdit = null;   // recorte de la foto de perfil (se guarda el cuadrado del círculo)
let photoView = false;  // foto de perfil abierta en grande
function newCrop(img, src, bw, bh) {
  const base = Math.max(bw / img.width, bh / img.height);   // la foto cubre todo el cuadro
  return { img, src, bw, bh, base, zoom: 1, ox: (bw - img.width * base) / 2, oy: (bh - img.height * base) / 2 };
}
const activeCrop = () => photoEdit || (progNew && progNew.crop) || null;
function openPhotoEditor(file) {
  const src = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    photoEdit = newCrop(img, src, CROP_BOX, CROP_BOX);
    render();
  };
  img.onerror = () => { URL.revokeObjectURL(src); notice('No se pudo usar esa imagen. Prueba con otra.'); };
  img.src = src;
}
const cropScale = e => e.base * e.zoom;
function clampCrop(e) {
  const w = e.img.width * cropScale(e), h = e.img.height * cropScale(e);
  e.ox = Math.min(0, Math.max(e.bw - w, e.ox));
  e.oy = Math.min(0, Math.max(e.bh - h, e.oy));
}
// Mueve la foto en pantalla sin redibujar todo
function paintCrop(e) {
  const el = $app.querySelector('.crop-img');
  if (!el) return;
  el.style.width = `${e.img.width * cropScale(e)}px`;
  el.style.height = `${e.img.height * cropScale(e)}px`;
  el.style.transform = `translate(${e.ox}px, ${e.oy}px)`;
}
function setCropZoom(e, z) {
  const old = cropScale(e), mx = e.bw / 2, my = e.bh / 2;
  const cx = (mx - e.ox) / old, cy = (my - e.oy) / old;   // el centro del cuadro se mantiene
  e.zoom = z;
  e.ox = mx - cx * cropScale(e);
  e.oy = my - cy * cropScale(e);
  clampCrop(e);
  paintCrop(e);
}
// Cuadro para mover y hacer zoom (ring: círculo de la foto de perfil)
const cropBoxHtml = (e, ring) => `<div class="crop-box" style="width:${e.bw}px;height:${e.bh}px">
        <img class="crop-img" src="${e.src}" alt="" draggable="false"
          style="width:${e.img.width * cropScale(e)}px;height:${e.img.height * cropScale(e)}px;transform:translate(${e.ox}px, ${e.oy}px)">
        <span class="${ring ? 'crop-ring' : 'crop-frame'}" aria-hidden="true"></span>
      </div>
      <label class="crop-zoom"><span class="muted small">Zoom</span>
        <input type="range" min="1" max="3" step="0.01" value="${e.zoom}" data-bind="crop-zoom" aria-label="Zoom"></label>
      <span class="muted small" style="text-align:center">Arrastra la foto para moverla</span>`;
// Recorta lo que se ve en el cuadro, a `w`×`h` px (JPEG)
function cropToCanvas(e, w, h, q) {
  const sc = cropScale(e), canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(e.img, -e.ox / sc, -e.oy / sc, e.bw / sc, e.bh / sc, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', q);
}
function closePhotoEditor() {
  if (photoEdit) URL.revokeObjectURL(photoEdit.src);
  photoEdit = null;
  render();
}
function photoEditorHtml() {
  if (!photoEdit) return '';
  const e = photoEdit;
  return `<div class="modal-wrap">
    <div class="modal-back" data-action="crop-cancel"></div>
    <section class="modal card crop-modal" role="dialog" aria-modal="true" aria-label="Ajustar foto">
      <h2>Ajusta tu foto</h2>
      ${cropBoxHtml(e, true)}
      <div class="ex-actions">
        <button class="btn ghost" data-action="crop-cancel">Cancelar</button>
        <button class="btn primary" data-action="crop-use">Usar foto</button>
      </div>
    </section>
  </div>`;
}
const cropToDataUrl = () => cropToCanvas(photoEdit, 512, 512, 0.8);   // nítida también al verla en grande (~50 KB)
// Arrastrar la foto (mouse o dedo)
$app.addEventListener('pointerdown', e => {
  const box = e.target.closest('.crop-box'), c = activeCrop();
  if (!box || !c) return;
  e.preventDefault();
  c.drag = { x: e.clientX, y: e.clientY, ox: c.ox, oy: c.oy };
  box.setPointerCapture(e.pointerId);
});
$app.addEventListener('pointermove', e => {
  const c = activeCrop();
  if (!c || !c.drag) return;
  c.ox = c.drag.ox + (e.clientX - c.drag.x);
  c.oy = c.drag.oy + (e.clientY - c.drag.y);
  clampCrop(c);
  paintCrop(c);
});
const endCropDrag = () => { const c = activeCrop(); if (c) c.drag = null; };
$app.addEventListener('pointerup', endCropDrag);
$app.addEventListener('pointercancel', endCropDrag);

// ---------- Mi plan (calendario de entrenos) ----------
// db.plan = { weeks: 1 a 4, start: 'AAAA-MM-DD' (lunes de la semana 1), days: [{ r: [id de rutina o null ×7] } × weeks] }
// Se repite cada `weeks` semanas: la app sabe qué semana del ciclo es y qué rutina toca cada día.
const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const mondayOf = date => { const d = new Date(date); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
function planWeekIndex(plan, date) {
  const diff = Math.round((mondayOf(date) - mondayOf(`${plan.start}T12:00:00`)) / (7 * 86400000));
  return ((diff % plan.weeks) + plan.weeks) % plan.weeks;
}
// Rutina que toca ese día: la rutina, null si es descanso, undefined si no tienes plan
// Cuando cambias tu plan, el anterior queda guardado: los días pasados se comparan con el plan que tenías ese día
let planSeen = null;   // tu plan la última vez que se guardó (JSON)
function recordPlan() {
  const j = stable(db.plan || null);
  if (planSeen == null || j === planSeen) { planSeen = j; return; }
  const t = todayKey(), log = db.planLog || (db.planLog = []), last = log[log.length - 1];
  if (!last || last.until !== t) log.push({ until: t, plan: JSON.parse(planSeen) });   // varios cambios el mismo día: vale el de antes
  if (log.length > 60) log.splice(0, log.length - 60);
  planSeen = j;
}
function planOn(dateKey) {
  if (dateKey < todayKey()) for (const e of db.planLog || []) if (dateKey < e.until) return e.plan;
  return db.plan;
}
function plannedRoutine(dateKey) {
  const p = planOn(dateKey);
  if (!p) return undefined;
  const d = new Date(`${dateKey}T12:00:00`);
  const id = ((p.days[planWeekIndex(p, d)] || {}).r || [])[(d.getDay() + 6) % 7];
  return db.routines.find(r => r.id === id) || null;
}
const trainedOn = (dateKey, routineId) => db.workouts.some(w => dayKeyOf(w.date) === dateKey && (!routineId || w.routineId === routineId));

// Días del plan en que toca una rutina: ["lunes y jueves"] o ["semana 1: lunes", "semana 2: jueves"]
// Rutinas que ya no están pero tienen entrenos guardados: se pueden recuperar con sus ejercicios (y su historial)
let restoreOpen = false;
function deletedRoutines() {
  const have = new Set(db.routines.map(r => r.id)), map = new Map();
  for (const w of db.workouts) {
    if (!w.routineId || have.has(w.routineId)) continue;
    const x = map.get(w.routineId) || { id: w.routineId, count: 0 };
    x.count++; x.name = w.routineName || 'Rutina'; x.date = w.date;
    map.set(w.routineId, x);
  }
  return [...map.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}
// La arma con los ejercicios de sus últimos entrenos (en el orden de la última vez), con el mismo id: se conecta con su
// historial. Las series = las que hiciste la última vez; repeticiones y descanso no se guardan en los entrenos
function restoreRoutine(rid) {
  const ws = db.workouts.filter(w => w.routineId === rid).slice(-4).reverse();
  if (!ws.length) return null;
  const seen = new Map();
  for (const w of ws) for (const e of w.exercises) if (!seen.has(e.exerciseId)) seen.set(e.exerciseId, e);
  let name = ws[0].routineName || 'Rutina';
  for (let n = 2; db.routines.some(r => sameName(r.name, name)); n++) name = `${ws[0].routineName} ${n}`;
  const r = { id: rid, name, exercises: [...seen.values()].map(e => ({ id: e.exerciseId, name: e.name, unit: e.unit, rest: 0, goalSets: e.sets.length,
    ...(e.rir ? { rir: true } : {}), ...(e.bw ? { bw: true } : {}), ...(e.guide ? { guide: e.guide } : {}) })) };
  db.routines.push(r);
  // Vuelve a los días donde estaba en tu programa (lo dice el historial de tu plan), si esos días siguen libres
  const old = (db.planLog || []).slice().reverse().find(x => x.plan && x.plan.days.some(wk => wk.r.includes(rid)));
  if (old && db.plan && old.plan.prog === db.plan.prog) {
    const prog = db.programs.find(p => p.id === db.plan.prog);
    old.plan.days.forEach((wk, w) => wk.r.forEach((id, d) => {
      if (id !== rid) return;
      if (db.plan.days[w] && !db.plan.days[w].r[d]) db.plan.days[w].r[d] = rid;
      if (prog && prog.days[w] && !prog.days[w].r[d]) prog.days[w].r[d] = rid;
    }));
  }
  return r;
}

function planUses(routineId) {
  const p = db.plan;
  if (!p) return [];
  const join = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}` : list[0]);
  return p.days.slice(0, p.weeks).map((wk, w) => {
    const days = DAY_NAMES.filter((_, d) => wk.r[d] === routineId).map(n => n.toLowerCase());
    return days.length ? `${p.weeks > 1 ? `semana ${w + 1}: ` : ''}${join(days)}` : null;
  }).filter(Boolean);
}


// ---------- Perfil de gymbro ----------
// Cada uno publica un resumen (récords, estadísticas, últimos entrenamientos) en profiles/{uid}; solo sus gymbros lo pueden leer.
const shareProfileKey = () => `desdel-perfil-${user.uid}`;
const shareProfile = () => localStorage.getItem(shareProfileKey()) !== '0';
const profilePubKey = () => `desdel-perfil-pub-${user.uid}`;
const profiles = new Map();   // uid → { data, error, loading, at }
let profileTimer = null;

// Lunes de la semana (para la racha de semanas seguidas entrenando)
function weekStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function myProfile() {
  const ws = db.workouts, now = new Date();
  const month = ws.filter(w => { const d = new Date(w.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).length;
  const weeks = new Set(ws.map(w => weekStart(Date.parse(w.date))));
  let wk = weekStart(Date.now()), streak = 0;
  if (!weeks.has(wk)) wk = weekStart(wk - 3 * 86400000);   // si esta semana aún no entrena, la racha sigue viva
  while (weeks.has(wk)) { streak++; wk = weekStart(wk - 3 * 86400000); }
  // Récord de cada ejercicio: el mejor 1RM estimado de la 1ª serie (igual que el gráfico de Progreso)
  const best = new Map();
  for (const w of ws) {
    for (const ex of w.exercises) {
      const st = ex.sets.find(x => x.w != null);
      if (!st) continue;
      const e = e1rmEx(ex, st, w.date), kg = toKg(e, ex.unit), cur = best.get(ex.exerciseId), bw = isBwEx(ex);
      if (!cur || kg > cur.kg || unitKind(cur.unit) !== unitKind(ex.unit)) best.set(ex.exerciseId, { kg, name: ex.name, v: round1(e), unit: ex.unit, ...(bw ? { bw: true } : {}), set: `${fmtNum(st.w)} ${ex.unit} × ${fmtNum(st.r || 1)}${st.rir != null ? ` · RIR ${fmtNum(st.rir)}` : ''}${bw ? ' + peso corporal' : ''}`, date: w.date });
    }
  }
  // Récords destacados: los que elijas en Privacidad (hasta 5); si no eliges, tus 5 ejercicios más entrenados
  const sessions = exerciseSessions();
  const ids = featuredExerciseIds().filter(id => best.has(id));
  const prs = ids.map(id => best.get(id)).sort((a, b) => b.kg - a.kg).map(({ kg, ...pr }) => pr);
  const recent = ws.slice(-5).reverse().map(w => ({ routine: w.routineName || 'Entrenamiento', date: w.date, min: w.durationSec ? Math.round(w.durationSec / 60) : 0 }));
  const stats = { month, total: ws.length, streak };
  // Sobre mí (cada dato con su interruptor en Mi perfil → Privacidad)
  const b = db.body, lastBw = db.bodyweight[db.bodyweight.length - 1];
  if (showInProfile('age') && b.birthYear) stats.age = now.getFullYear() - b.birthYear;
  if (showInProfile('height') && b.heightCm) stats.heightCm = b.heightCm;
  if (showInProfile('weight') && lastBw) stats.weight = lastBw.kg;
  if (showInProfile('bf') && currentBf() != null) stats.bf = currentBf();
  const ff = showInProfile('ffmi') ? ffmiInfo() : null;
  if (ff) { stats.ffmi = ff.value; stats.ffmiLevel = ff.level; }
  if (showInProfile('goal') && (b.paceMonth != null || b.pace != null)) {
    const pm = paceMonth(b);
    stats.goal = pm === 0 ? 'Mantener peso' : `${pm < 0 ? 'Bajando' : 'Subiendo'} ${fmtNum(Math.abs(pm))} kg al mes`;
  }
  if (showInProfile('since') && ws.length) stats.since = ws[0].date;
  if (myPhoto) stats.photo = myPhoto;
  return { name: user.username || '', stats, prs, recent };
}

// Se publica unos segundos después de cada cambio, solo si cambió algo y si tienes gymbros
function scheduleProfile() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(publishProfile, 4000);
}
async function publishProfile() {
  if (!user || status !== 'ready' || !chats.length || viewing) return;
  // Sin compartir: tus gymbros solo ven tu nombre y tu foto
  const data = shareProfile() ? myProfile() : { name: user.username || '', stats: { hidden: true, ...(myPhoto ? { photo: myPhoto } : {}) }, prs: [], recent: [] };
  const json = stable(data);
  if (localStorage.getItem(profilePubKey()) === json) return;
  try {
    await cloud.putProfile(user.uid, data);
    localStorage.setItem(profilePubKey(), json);
  } catch (e) { /* sin internet: se intenta de nuevo en el próximo cambio */ }
}
function setShareProfile(on) {
  localStorage.setItem(shareProfileKey(), on ? '1' : '0');
  localStorage.removeItem(profilePubKey());
  publishProfile();
}

function loadProfile(uid) {
  const p = profiles.get(uid);
  if (p && (p.loading || Date.now() - p.at < 60000)) return;
  profiles.set(uid, { ...(p || {}), loading: true });
  cloud.getProfile(uid)
    .then(data => profiles.set(uid, { data, at: Date.now() }), () => profiles.set(uid, { error: true, at: Date.now() }))
    .then(() => { if (['perfil', 'social', 'chat', 'alumnos'].includes(routeParts()[0])) refresh(); });
}

// Datos del perfil que puedes ocultar (todos se muestran si no los apagas)
const PROFILE_FIELDS = [
  ['age', 'Edad'], ['height', 'Estatura'], ['weight', 'Peso'], ['bf', '% de grasa'], ['ffmi', 'FFMI'],
  ['goal', 'Objetivo actual (subir, bajar o mantener)'], ['since', 'Entrenando desde'],
];

// Récords destacados: los que elegiste en Privacidad (hasta 5) o, si no elegiste, tus 5 ejercicios más entrenados
function featuredExerciseIds() {
  const done = new Set(db.workouts.flatMap(w => w.exercises.map(ex => ex.exerciseId)));
  const picked = (db.body.prPick || []).filter(id => done.has(id));
  return picked.length ? picked : exerciseSessions().slice(0, 5).map(x => x.id);
}

// Veces que hiciste cada ejercicio, del más entrenado al menos
function exerciseSessions() {
  const count = new Map();
  for (const w of db.workouts) for (const ex of w.exercises) {
    const c = count.get(ex.exerciseId) || { id: ex.exerciseId, n: 0 };
    c.n++; c.name = ex.name;
    count.set(ex.exerciseId, c);
  }
  return [...count.values()].sort((a, b) => b.n - a.n);
}
const showInProfile = k => !(db.body.hide || {})[k];

function profileBody(d, me) {
  const st = d.stats || {};
  const about = [
    st.age != null && ['Edad', `${st.age} años`],
    st.heightCm != null && ['Estatura', `${fmtNum(st.heightCm / 100)} m`],
    st.weight != null && ['Peso hoy', fmtKg(st.weight)],
    st.bf != null && ['% de grasa', `${fmtNum(st.bf)} %`],
    st.ffmi != null && ['FFMI', `${st.ffmi.toFixed(1).replace('.', ',')} <span class="badge on">${FFMI_LEVELS[st.ffmiLevel] || ''}</span>`],
    st.goal && ['Objetivo', esc(st.goal)],
    st.since && ['Entrenando desde', new Date(st.since).toLocaleDateString('es', { month: 'long', year: 'numeric' })],
  ].filter(Boolean);
  const aboutCard = about.length ? `<section class="card about">${about.map(([k, v]) => `<div class="prog-row"><span class="muted">${k}</span><span>${v}</span></div>`).join('')}</section>` : '';
  const stats = `<div class="stats">
      <div class="stat"><span class="muted">Este mes</span><strong>${st.month || 0}</strong><span class="muted">${st.month === 1 ? 'entrenamiento' : 'entrenamientos'}</span></div>
      <div class="stat"><span class="muted">Total</span><strong>${st.total || 0}</strong><span class="muted">${st.total === 1 ? 'entrenamiento' : 'entrenamientos'}</span></div>
      <div class="stat"><span class="muted">Racha</span><strong>${st.streak || 0}</strong><span class="muted">${st.streak === 1 ? 'semana' : 'semanas'}</span></div>
    </div>`;
  const prs = (d.prs || []).map(pr => `<div class="prog-row">
      <span>${esc(pr.name)}</span>
      <span class="pr-val"><strong>${pr.bw ? '+' : ''}${fmtNum(pr.v)} ${esc(pr.unit)}</strong><span class="muted small">${esc(pr.set)}</span></span>
    </div>`).join('');
  const recent = (d.recent || []).map(w => `<div class="prog-row">
      <span>${esc(w.routine)}</span>
      <span class="muted">${dayLabel(Date.parse(w.date))}${w.min ? ` · ${w.min} min` : ''}</span>
    </div>`).join('');
  return `${aboutCard}
    ${stats}
    <h2>Récords destacados · 1RM estimado</h2>
    ${prs ? `<section class="card">${prs}</section>` : `<p class="empty">${me ? 'Todavía no tienes' : 'Todavía no tiene'} récords con peso anotado.</p>`}
    <h2>Últimos entrenamientos</h2>
    ${recent ? `<section class="card">${recent}</section>` : '<p class="empty">Todavía no hay entrenamientos.</p>'}`;
}

// Dietas y rutinas que se han enviado en el chat (las más nuevas primero)
function sharedInChat(c) {
  if (chatMsgs.id !== c.id || !chatMsgs.loaded) return '';
  const items = chatMsgs.list.filter(m => m.type === 'diet' || m.type === 'routine').reverse();
  if (!items.length) return '';
  return `<h2>Compartido en el chat</h2>
    <section class="card">${items.map(m => {
      const mine = m.from === user.uid, diet = m.type === 'diet';
      return `<div class="prog-row">
        <span class="grow">${diet ? '🥗' : '🏋️'} ${esc(diet ? m.diet.name : m.routine.name)}<br><span class="muted small">${mine ? 'Enviada por ti' : `Te la envió ${esc(gymbroName(c))}`} · ${dayLabel(m.at)}</span></span>
        ${mine ? '' : `<button class="btn small-btn" data-action="msg-add" data-id="${esc(m.id)}">Agregar</button>`}
      </div>`;
    }).join('')}</section>`;
}

function viewProfile(arg) {
  const me = arg === 'yo';
  const c = me ? null : chats.find(x => x.id === arg);
  if (!me && !c) {
    if (chatsLoaded) { location.replace('#/social'); return ''; }
    return `${header('Perfil', { back: true })}<p class="empty">Cargando…</p>`;
  }
  let p;
  if (me) p = { data: myProfile() };
  else {
    loadProfile(otherUid(c));
    openMessages(c.id);
    p = profiles.get(otherUid(c)) || { loading: true };
  }
  const name = me ? (user.username || 'Tú') : gymbroName(c);
  const photo = me ? myPhoto : p.data && p.data.stats && p.data.stats.photo;
  // Con foto: tocarla la abre en grande. En tu perfil, "Cambiar foto" (o tocar tu inicial si aún no tienes)
  const bigPhoto = safePhoto(photo)
    ? `<button class="photo-open" data-action="photo-view" aria-label="Ver foto en grande">${avatarHtml(name, photo, 'big')}</button>` : '';
  const head = `<section class="profile-head">
      ${me ? `${bigPhoto}
        <label class="photo-pick" aria-label="${photo ? 'Cambiar foto de perfil' : 'Poner foto de perfil'}">
          ${bigPhoto ? '' : avatarHtml(name, photo, 'big')}
          <input type="file" accept="image/*" data-bind="photo" hidden>
          <span class="small photo-hint">${photo ? 'Cambiar foto' : 'Poner foto'}</span>
        </label>
        ${photo ? '<button class="btn ghost small-btn" data-action="photo-del">Quitar foto</button>' : ''}`
      : bigPhoto || avatarHtml(name, photo, 'big')}
      <h2>${esc(name)}</h2>
      ${me ? '' : `<span class="muted small">Gymbros desde el ${fmtLongDate(c.createdAt)}</span>`}
    </section>`;
  let body;
  if (!p.data && p.loading) body = '<p class="empty">Cargando…</p>';
  else if (!p.data || (p.data.stats && p.data.stats.hidden)) body = `<p class="empty">${p.error ? 'No se pudo cargar el perfil. Revisa tu internet.' : `${esc(name)} todavía no comparte sus récords ni estadísticas.`}</p>`;
  else body = profileBody(p.data, me);
  if (me && !shareProfile()) body = '<p class="empty">No estás compartiendo tus récords ni estadísticas. Actívalo en Privacidad.</p>';
  return `${header(me ? 'Mi perfil' : 'Perfil', { back: true, right: me ? '<a class="btn small-btn privacy-btn" href="#/privacidad">Privacidad</a>' : '' })}
    ${head}
    ${body}
    ${me ? '' : sharedInChat(c)}
    ${me ? '' : '<button class="btn ghost block danger-text" data-action="gymbro-del" style="margin-top:24px">Eliminar gymbro</button>'}
    ${me ? photoEditorHtml() : ''}
    ${photoView && safePhoto(photo) ? `<div class="modal-wrap photo-viewer" data-action="photo-close" role="dialog" aria-label="Foto de ${esc(name)}">
      <img src="${safePhoto(photo)}" alt="Foto de ${esc(name)}">
    </div>` : ''}`;
}

// ---------- Progreso ----------
const RANGES = [['semana', 'Semana', 7], ['mes', 'Mes', 30], ['3m', '3 meses', 91], ['6m', '6 meses', 182]];      // peso corporal
const EX_RANGES = [['mes', 'Mes', 30], ['3m', '3 meses', 91], ['6m', '6 meses', 182], ['1a', '1 año', 365]];   // ejercicios
let progressRange = '3m';   // período del gráfico de ejercicios
let progressRid = { ex: null, r: '' };   // rutina elegida en el gráfico de un ejercicio ('' = todas; 'libre' = sin rutina)
const ridKey = w => w.routineId || 'libre';
let bwRange = '3m';         // período del gráfico de peso corporal
let chart = null;   // puntos del gráfico en pantalla (para el tooltip)

// Placas no se pueden pasar a kg: se dejan tal cual
const convertWeight = (w, from, to) => (from === to || from === 'placas' || to === 'placas' ? w : from === 'lb' ? w * 0.45359237 : w / 0.45359237);
const round1 = n => Math.round(n * 10) / 10;

// Récord estimado (1RM) con Epley + RIR: peso × (1 + (reps + RIR) / 30). Las reps en reserva cuentan como reps que
// podrías haber hecho; sin RIR anotado se toma como al fallo (RIR 0). Con 1 rep al fallo es el mismo peso.
const epley = (w, r, rir = 0) => { const n = (r || 1) + (rir || 0); return n > 1 ? w * (1 + n / 30) : w; };
const e1rmOf = s => epley(s.w, s.r || 1, s.rir);

// Ejercicios con peso corporal (dominadas, dips…): lo que anotas es el lastre.
// Se marca en la rutina; vale también para tu historial de ese ejercicio.
const isBwEx = ex => !!ex.bw || db.routines.some(r => r.exercises.some(e => e.id === ex.exerciseId && e.bw));
// Tu peso de ese día (el último anotado hasta esa fecha; si no hay, el primero que anotaste)
function bwOn(dateIso) {
  const key = dayKeyOf(dateIso);
  let found = null;
  for (const e of db.bodyweight) { if (e.date <= key) found = e; else break; }
  return (found || db.bodyweight[0] || {}).kg ?? null;
}
// 1RM estimado de una serie. Con peso corporal: lastre máximo = (tu peso + lastre) × fórmula − tu peso
function e1rmEx(ex, s, dateIso) {
  if (ex.unit !== 'placas' && isBwEx(ex)) {
    let bw = bwOn(dateIso);
    if (bw != null) {
      if (ex.unit === 'lb') bw /= 0.45359237;
      return epley(bw + (s.w || 0), s.r || 1, s.rir) - bw;
    }
  }
  return e1rmOf(s);
}

// Un punto por sesión: el 1RM estimado de la primera serie con peso
function progressPoints(exerciseId, days, rid = '') {
  const rows = historyFor(exerciseId).reverse().filter(({ w }) => !rid || ridKey(w) === rid);   // de la más antigua a la más reciente
  if (!rows.length) return { unit: 'kg', points: [] };
  const unit = rows[rows.length - 1].ex.unit;
  const since = Date.now() - days * 86400000;
  const points = [];
  for (const { w, ex } of rows) {
    const t = Date.parse(w.date);
    if (t < since || unitKind(ex.unit) !== unitKind(unit)) continue;   // placas no se mezclan con kg
    const s = ex.sets.find(x => x.w != null);
    if (!s) continue;
    const set = { w: s.w, r: s.r, rir: s.rir, unit: ex.unit };
    const y = round1(convertWeight(e1rmEx(ex, s, w.date), ex.unit, unit));
    points.push({ t, date: w.date, y, set, rname: w.routineName || 'Sin rutina', tip: `${fmtNum(y)} ${unit} <span class="muted">(${setText(set, set.unit)})</span>` });
  }
  return { unit, points };
}

// Marcas del eje con números redondos (ej. 90, 100, 110)
function niceTicks(lo, hi) {
  if (hi === lo) { lo -= 5; hi += 5; }
  const raw = (hi - lo) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

// opts.trend: línea de tendencia ({ t, y }); opts.goal: línea de meta; opts.dotsOnly: los registros van como puntos
function chartSvg(points, unit, days, label = 'Peso máximo por sesión', opts = {}) {
  const { trend = null, goal = null, dotsOnly = false, goalPath: gp = null } = opts;
  const W = 340, H = 200, L = 38, R = 14, T = 20, B = 26;
  const t1 = Math.max(Date.now(), ...points.map(p => p.t)), t0 = t1 - days * 86400000;
  const gpFrom = gp ? Math.max(t0, gp.start) : null;
  const ys = [...points.map(p => p.y), ...(trend ? trend.map(p => p.y) : []), ...(gp && gpFrom < t1 ? [gp.at(gpFrom), gp.at(t1)] : goal != null ? [goal] : [])];
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const x = t => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = v => H - B - ((v - y0) / (y1 - y0)) * (H - T - B);
  const dateLabel = t => new Date(t).toLocaleDateString('es', days <= 7 ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' });
  chart = { points: points.map(p => ({ ...p, x: x(p.t), yPx: y(p.y) })), unit, W, H, T, B };

  const grid = ticks.map(v => `
    <line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
    <text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="axis">${fmtNum(v)}</text>`).join('');
  const xLabels = [t0, (t0 + t1) / 2, t1].map((t, k) =>
    `<text x="${x(t)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][k]}" class="axis">${dateLabel(t)}</text>`).join('');
  const line = !dotsOnly && chart.points.length > 1
    ? `<polyline class="line" points="${chart.points.map(p => `${p.x},${p.yPx}`).join(' ')}"/>` : '';
  const trendLine = trend && trend.length > 1
    ? `<polyline class="line trend" points="${trend.map(p => `${x(p.t)},${y(p.y)}`).join(' ')}"/>` : '';
  const gpTimes = gp && gpFrom < t1 ? [gpFrom, ...(gp.reach > gpFrom && gp.reach < t1 ? [gp.reach] : []), t1] : null;
  const goalLine = gpTimes
    ? `<polyline class="goal-path" points="${gpTimes.map(t => `${x(t)},${y(gp.at(t))}`).join(' ')}"/>
       ${gp.reach < t1 ? `<text x="${x(Math.max(gp.reach, gpFrom))}" y="${y(gp.goal) + (gp.goal > gp.at(gpFrom) ? -6 : 14)}" class="axis">Meta ${fmtNum(gp.goal)}</text>` : ''}`
    : goal != null
    ? `<line class="goal-line" x1="${L}" x2="${W - R}" y1="${y(goal)}" y2="${y(goal)}"/>
       <text x="${L + 4}" y="${y(goal) - 5}" class="axis">Meta ${fmtNum(goal)}</text>` : '';
  // Con muchos puntos solo se dibuja la línea y el último punto (al tocar se marca el elegido);
  // si los registros van como puntos, se ven todos (más chicos cuando son muchos)
  const dense = chart.points.length > 20;
  const dots = chart.points.map((p, k) => {
    const r = dotsOnly ? (dense ? 2.5 : 3.5) : dense && k < chart.points.length - 1 ? 0 : 4;
    return `<circle class="dot ${dotsOnly ? 'raw' : ''}" data-k="${k}" data-r="${r}" cx="${p.x}" cy="${p.yPx}" r="${r}"/>`;
  }).join('');
  const last = chart.points[chart.points.length - 1];
  const lastLabel = `<text x="${Math.min(last.x, W - R)}" y="${last.yPx - 10}" text-anchor="${last.x > W - 50 ? 'end' : 'middle'}" class="value">${fmtNum(last.y)} ${unit}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${label}">
    ${grid}${xLabels}
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
    ${goalLine}${line}${dots}${trendLine}${lastLabel}
    <rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>
  </svg>`;
}

let progressQuery = '';   // texto del buscador de Progreso
const normText = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function viewProgress() {
  // Ejercicios que tienen historial
  const byId = new Map();
  for (const w of db.workouts) {
    for (const ex of w.exercises) {
      const e = byId.get(ex.exerciseId) || { id: ex.exerciseId, count: 0 };
      e.name = ex.name; e.date = w.date; e.count++;
      byId.set(ex.exerciseId, e);
    }
  }
  if (!byId.size) {
    return `${header('Entreno', {})}${entrenoTabs('progreso')}
      <p class="empty">Cuando guardes entrenamientos, aquí verás tu progreso en cada ejercicio.</p>`;
  }

  // Agrupados por rutina (en el orden de tus rutinas); los que no están en ninguna van en "Otros"
  const inRoutine = new Set();
  const groups = db.routines.map(r => {
    const items = r.exercises.filter(ex => byId.has(ex.id)).map(ex => { inRoutine.add(ex.id); return byId.get(ex.id); });
    return { name: r.name || '(sin nombre)', items };
  }).filter(g => g.items.length);
  const others = [...byId.values()].filter(e => !inRoutine.has(e.id)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (others.length) groups.push({ name: 'Otros', items: others });

  // Tendencia: el 1RM estimado de la última sesión contra el de hace ~1 mes (o la primera, si hay menos historial)
  const trend = id => {
    const { unit, points } = progressPoints(id, 3650);
    if (points.length < 2) return '';
    const last = points[points.length - 1], monthAgo = last.t - 25 * 86400000;
    const older = points.filter(q => q.t <= monthAgo), base = older.length ? older[older.length - 1] : points[0];
    const d = round1(last.y - base.y), when = older.length ? 'en 1 mes' : `desde ${fmtDate(base.date)}`;
    if (Math.abs(d) < 0.5) return `<span class="trend eq">= igual ${when}</span>`;
    return `<span class="trend ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲ +' : '▼ −'}${fmtNum(Math.abs(d))} ${unit} ${when}</span>`;
  };
  const item = e => `
    <a class="card" href="#/progreso/${encodeURIComponent(e.id)}" data-search="${esc(normText(e.name))}">
      <div class="grow">
        <strong>${esc(e.name)}</strong>
        <span class="muted">${trend(e.id) || plural(e.count, 'sesión', 'sesiones')} · última: ${fmtDate(e.date)}</span>
      </div>
      <span class="chev">›</span>
    </a>`;
  return `${header('Entreno', {})}${entrenoTabs('progreso')}
    <input class="search" type="search" data-bind="progress-search" value="${esc(progressQuery)}"
      placeholder="🔍 Buscar ejercicio…" autocomplete="off" aria-label="Buscar ejercicio">
    ${groups.map(g => `<section class="prog-group"><h2>${esc(g.name)}</h2>${g.items.map(item).join('')}</section>`).join('')}
    <p class="empty" data-no-results hidden>Ningún ejercicio coincide con la búsqueda.</p>`;
}

// Filtra la lista mientras escribes (sin redibujar, para no cerrar el teclado)
function filterProgress() {
  const q = normText(progressQuery.trim());
  let any = false;
  $app.querySelectorAll('.prog-group').forEach(g => {
    let visible = 0;
    g.querySelectorAll('[data-search]').forEach(a => {
      const show = !q || a.dataset.search.includes(q);
      a.hidden = !show;
      if (show) visible++;
    });
    g.hidden = !visible;
    if (visible) any = true;
  });
  const none = $app.querySelector('[data-no-results]');
  if (none) none.hidden = any;
}

const rangeButtons = (ranges, current, scope) => `<div class="range" role="group" aria-label="Período">${ranges.map(([key, label]) =>
  `<button class="${key === current ? 'on' : ''}" data-action="range" data-s="${scope}" data-r="${key}">${label}</button>`).join('')}</div>`;

// ---------- Peso corporal ----------
// Un registro por día: { date: 'AAAA-MM-DD', kg, bf? } (bf = % de grasa, opcional)
// Mis datos (db.body): { heightCm?, sex? ('h' | 'm'), goal?: { kg, startKg, startDate } }
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const bwIso = date => `${date}T12:00:00`;              // mediodía local, para ubicarlo bien en el gráfico
const bwDate = date => (date === todayKey() ? 'hoy' : fmtDate(bwIso(date)));
const fmtKg = n => `${fmtNum(round1(n))} kg`;
const signed = n => `${n > 0 ? '+' : ''}${fmtNum(round1(n))}`;
const bwDay = e => Date.parse(bwIso(e.date)) / 86400000;
const hasBody = b => !!b && Object.keys(b).length > 0;

// Cambio en los últimos `days` días: último registro menos el primero dentro del período
function bwChange(days) {
  const list = db.bodyweight, last = list[list.length - 1];
  if (!last) return null;
  const since = Date.parse(bwIso(last.date)) - days * 86400000;
  const first = list.find(e => Date.parse(bwIso(e.date)) >= since);
  return first && first !== last ? last.kg - first.kg : null;
}

// Ritmo en kg por semana: pendiente de la recta que mejor se ajusta a los registros
// (solo si entre el primero y el último hay al menos `minDays` días)
function weeklyRate(list, minDays = 7) {
  if (list.length < 2 || bwDay(list[list.length - 1]) - bwDay(list[0]) < minDays) return null;
  const xs = list.map(bwDay), ys = list.map(e => e.kg);
  const mx = xs.reduce((a, v) => a + v, 0) / xs.length, my = ys.reduce((a, v) => a + v, 0) / ys.length;
  let num = 0, den = 0;
  xs.forEach((x, k) => { num += (x - mx) * (ys[k] - my); den += (x - mx) ** 2; });
  return den ? (num / den) * 7 : null;
}
const rateLabel = r => (Math.abs(r) < 0.1 ? 'Estancado' : r < 0 ? 'Bajando' : 'Subiendo');

// Tendencia: promedio de los registros de los últimos 7 días en cada fecha (suaviza las subidas y bajadas diarias)
function bwTrend(list) {
  return list.map(e => {
    const d = bwDay(e), win = db.bodyweight.filter(x => bwDay(x) <= d && bwDay(x) > d - 7);
    return { t: Date.parse(bwIso(e.date)), y: win.reduce((a, x) => a + x.kg, 0) / win.length };
  });
}

// Meta de peso (opcional): avance desde el peso que tenías al ponerla y fecha estimada
// Camino a la meta: desde tu peso de inicio hasta la meta, a tu ritmo (la fecha meta, o si no, el ritmo de Nutrición);
// al llegar a la meta sigue plano. null si no hay cómo saber el ritmo
function goalPath() {
  const g = db.body.goal;
  if (!g || g.startKg == null || !g.startDate) return null;
  const dir = Math.sign(g.kg - g.startKg);
  if (!dir) return null;
  const start = Date.parse(bwIso(g.startDate));
  let perDay = null, src = 'date';
  if (g.by) { const d = (Date.parse(bwIso(g.by)) - start) / 86400000; if (d > 0) perDay = (g.kg - g.startKg) / d; }
  if (perDay == null) { const pm = paceMonth(db.body); if (pm && Math.sign(pm) === dir) { perDay = pm / DAYS_PER_MONTH; src = 'pace'; } }
  if (!perDay) return null;
  const reach = start + ((g.kg - g.startKg) / perDay) * 86400000;
  const at = t => (t <= start ? g.startKg : t >= reach ? g.kg : g.startKg + (perDay * (t - start)) / 86400000);
  return { start, reach, at, src, perMonth: perDay * DAYS_PER_MONTH, goal: g.kg };
}
function goalInfo() {
  const g = db.body.goal, last = db.bodyweight[db.bodyweight.length - 1];
  if (!g || !last || g.startKg == null) return null;
  const total = g.startKg - g.kg, done = g.startKg - last.kg;
  const reached = total >= 0 ? last.kg <= g.kg : last.kg >= g.kg;
  const pct = reached ? 100 : total === 0 ? 100 : Math.min(100, Math.max(0, (done / total) * 100));
  const left = Math.abs(last.kg - g.kg);
  // Pronóstico con el ritmo de las últimas 4 semanas (necesita 2 semanas de registros)
  const since = bwDay(last) - 28;
  const rate = weeklyRate(db.bodyweight.filter(e => bwDay(e) >= since), 14);
  let forecast;
  if (reached) forecast = '🎉 ¡Llegaste a tu meta!';
  else if (rate == null) forecast = 'Anota tu peso durante 2 semanas para estimar cuándo llegas.';
  else if (Math.abs(rate) >= 0.05 && Math.sign(rate) === Math.sign(g.kg - last.kg)) {
    const when = new Date(Date.now() + (left / Math.abs(rate)) * 7 * 86400000);
    forecast = `Con tu ritmo actual (${signed(rate)} kg/semana) llegarías aprox. el ${when.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}.`;
  } else forecast = `Con tu ritmo actual (${signed(rate)} kg/semana) no te estás acercando a tu meta.`;
  return { g, last, pct, left, reached, forecast };
}

// % de grasa: un solo dato, sin fecha (antes se anotaba junto al peso; si no hay, se usa el último de esos)
const currentBf = () => db.body.bf ?? (db.bodyweight.slice().reverse().find(x => x.bf != null) || {}).bf ?? null;
let goalEditing = false;   // formulario de la meta de peso abierto

// FFMI ajustado por estatura: masa magra ÷ estatura² + 6,1 × (1,8 − estatura)
const FFMI_LEVELS = ['Bajo el promedio', 'Promedio', 'Sobre el promedio', 'Excelente', 'Superior', 'Cerca del límite natural'];
const ffmiCuts = sex => (sex === 'm' ? [14, 16, 18, 19, 21] : [18, 20, 22, 23, 25]);
function ffmiInfo() {
  const { heightCm, sex } = db.body, bf = currentBf(), last = db.bodyweight[db.bodyweight.length - 1];
  if (!heightCm || !sex || bf == null || !last) return null;
  const m = heightCm / 100, lean = last.kg * (1 - bf / 100);
  const value = Math.round((lean / (m * m) + 6.1 * (1.8 - m)) * 10) / 10;   // con un decimal, igual que se muestra
  const cuts = ffmiCuts(sex);
  return { value, lean, bf, level: cuts.filter(c => value >= c).length, cuts };
}

// "tu estatura, tu sexo y tu % de grasa": lo que falta para calcular el FFMI
function ffmiMissing() {
  const miss = [];
  if (!db.body.heightCm) miss.push('tu estatura');
  if (!db.body.sex) miss.push('tu sexo');
  if (currentBf() == null) miss.push('tu % de grasa (anótalo aquí arriba)');
  if (!db.bodyweight.length) miss.push('tu peso');
  const list = miss.length > 1 ? `${miss.slice(0, -1).join(', ')} y ${miss[miss.length - 1]}` : miss[0];
  return `${list}.${!db.body.heightCm || !db.body.sex ? ' La estatura y el sexo se ponen en <a href="#/cuenta">⚙️ Cuenta → Mis datos</a>' : ''}`;
}

function bodyweightCard() {
  const last = db.bodyweight[db.bodyweight.length - 1];
  const change = bwChange(30), gi = goalInfo();
  if (viewing) {   // mirando a un alumno: toda la tarjeta lleva a su peso
    return `<a class="card hub" href="#/peso"><div class="hub-top"><span class="hub-icon">⚖️</span><strong>Cuerpo</strong></div>
      <span class="muted">${last ? `Último peso: ${fmtKg(last.kg)}` : 'Todavía no anota su peso'}</span></a>`;
  }
  if (!last || last.date !== todayKey()) {
    return `<div class="card hub">
      <a class="hub-top" href="#/peso"><span class="hub-icon">⚖️</span><strong>Cuerpo</strong></a>
      <form class="hub-bw" data-form="bodyweight" novalidate>
        <input name="kg" inputmode="decimal" placeholder="${last ? esc(toField(last.kg)) : 'kg'}" autocomplete="off" aria-label="Tu peso de hoy en kg">
        <button class="btn primary">Anotar</button>
        <p class="form-msg" hidden></p>
      </form>
      <span class="muted small">Tu peso de hoy${last ? ` · último ${fmtKg(last.kg)}` : ''}</span>
    </div>`;
  }
  return `<a class="card hub" href="#/peso">
      <div class="hub-top"><span class="hub-icon">⚖️</span><strong>Cuerpo</strong></div>
      ${last
        ? `<div class="hub-value"><strong>${fmtKg(last.kg)}</strong></div>
           ${gi ? `${bar(gi.pct, 100)}<span class="muted">${gi.reached ? '🎉 ¡Llegaste a tu meta!' : `${Math.round(gi.pct)}% de tu meta · faltan ${fmtKg(gi.left)}`}</span>`
             : `<span class="muted">${bwDate(last.date)}${change != null ? ` · ${signed(change)} kg en 30 días` : ''}</span>`}`
        : '<span class="muted">Anota tu peso y mira cómo evoluciona</span>'}
    </a>`;
}

function viewBodyweight() {
  const today = db.bodyweight.find(e => e.date === todayKey());
  const last = db.bodyweight[db.bodyweight.length - 1];
  const days = RANGES.find(r => r[0] === bwRange)[2];
  const since = Date.now() - days * 86400000;
  const inRange = db.bodyweight.filter(e => Date.parse(bwIso(e.date)) >= since);
  const points = inRange.map(e => ({
    t: Date.parse(bwIso(e.date)), date: bwIso(e.date), y: e.kg,
    tip: fmtKg(e.kg),
  }));
  const gi = goalInfo(), gp = gi ? goalPath() : null;
  chart = null;
  // Dónde deberías ir hoy según tu camino, contra tu tendencia
  const nowTrend = gp && !gi.reached && db.bodyweight.length ? (tr => tr[tr.length - 1].y)(bwTrend(db.bodyweight.slice(-1))) : null;
  const pathDiff = nowTrend != null ? round1(nowTrend - gp.at(Date.now())) : null;

  const form = `<form class="stack card" data-form="bodyweight" novalidate>
      ${today ? '<span class="muted small">Hoy ya anotaste tu peso; puedes corregirlo.</span>' : ''}
      <label class="field"><span>Peso de hoy</span>
        <div class="add-row" style="margin-top:0">
          <input name="kg" inputmode="decimal" value="${today ? toField(today.kg) : ''}"
            placeholder="${last ? toField(last.kg) : 'ej. 75,5'}" autocomplete="off" aria-label="Peso en kg">
          <span class="unit-label">kg</span>
          <button class="btn primary">Guardar</button>
        </div>
      </label>
      <p class="form-msg" hidden></p>
    </form>`;

  const g = db.body.goal;
  const goalCard = goalEditing
    ? `<form class="card stack" data-form="goal" novalidate>
        <label class="field"><span>Peso meta</span>
          <div class="add-row" style="margin-top:0">
            <input name="goal" inputmode="decimal" value="${g ? toField(g.kg) : ''}" placeholder="ej. 80" autocomplete="off" aria-label="Peso meta en kg">
            <span class="unit-label">kg</span>
            <button class="btn primary">Guardar</button>
          </div>
        </label>
        <label class="field"><span>Para cuándo (opcional)</span>
          <div class="date-field"><span class="date-show">${g && g.by ? fmtDMY(g.by) : 'Sin fecha: usa tu ritmo de Nutrición'}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>
            <input type="date" name="by" data-bind="goal-by" value="${g && g.by ? g.by : ''}" min="${todayKey()}" aria-label="Fecha meta"></div></label>
        <p class="form-msg" hidden></p>
        <div class="ex-actions">
          ${g && g.by ? '<button type="button" class="btn ghost" data-action="goal-by-clear">Sin fecha</button>' : ''}
          ${g ? '<button type="button" class="btn ghost danger-text" data-action="goal-del">Quitar meta</button>' : ''}
          <button type="button" class="btn ghost" data-action="goal-cancel">Cancelar</button>
        </div>
      </form>`
    : gi ? `<section class="card stack goal-card">
        <div class="goal-top"><span class="muted">Meta: <strong>${fmtKg(gi.g.kg)}</strong> · ${gi.reached ? '100%' : `${Math.round(gi.pct)}%`}</span>
          <button class="btn ghost small-btn" data-action="goal-edit">Cambiar</button></div>
        ${bar(gi.pct, 100)}
        <div class="goal-top"><span class="muted small">Inicio: ${fmtKg(gi.g.startKg)} (${bwDate(gi.g.startDate)})</span>
          <span class="muted small">${gi.reached ? '' : `Faltan ${fmtKg(gi.left)}`}</span></div>
        <p class="muted small" style="margin:0">${gi.forecast}</p>
        ${gi.reached ? '' : gp ? `<p class="small goal-path-note">Tu camino: ${signed(round1(gp.perMonth))} kg al mes${gp.src === 'date' ? ` hasta el ${fmtDMY(gi.g.by)}` : ' (tu ritmo de Nutrición)'}.
            Hoy deberías estar en ${fmtKg(round1(gp.at(Date.now())))}${pathDiff == null ? '' : Math.abs(pathDiff) < 0.3 ? ': vas justo en el camino.'
              : `: vas ${fmtKg(Math.abs(pathDiff))} ${(pathDiff > 0) === (gi.g.kg > gi.g.startKg) ? 'adelantado' : 'atrasado'}.`}</p>`
          : '<p class="muted small" style="margin:0">Pon una fecha a tu meta (Cambiar) o un ritmo en Nutrición para ver tu camino en el gráfico.</p>'}
      </section>`
    : g ? `<section class="card goal-top">
        <span class="muted">Meta: <strong>${fmtKg(g.kg)}</strong> · empieza a contar con tu primer peso</span>
        <button class="btn ghost small-btn" data-action="goal-edit">Cambiar</button>
      </section>`
    : '<button class="btn ghost block" data-action="goal-edit">+ Poner meta de peso (opcional)</button>';

  let body;
  if (!points.length) {
    body = `<p class="empty">${db.bodyweight.length ? 'No hay registros en este período.' : 'Todavía no anotas tu peso. Empieza hoy arriba 👆'}</p>`;
  } else {
    const ys = points.map(pt => pt.y);
    const change = points.length > 1 ? ys[ys.length - 1] - ys[0] : null;
    const rate = weeklyRate(inRange);
    const trend = points.length > 1 ? bwTrend(inRange) : null;
    body = `<div class="stats">
        <div class="stat"><span class="muted">Cambio</span><strong>${change != null ? `${signed(change)} kg` : '—'}</strong></div>
        <div class="stat"><span class="muted">Ritmo</span><strong>${rate != null ? `${signed(rate)} kg` : '—'}</strong>
          <span class="muted">${rate != null ? `por semana · ${rateLabel(rate)}` : 'falta 1 semana'}</span></div>
        <div class="stat"><span class="muted">Mín – Máx</span><strong>${fmtNum(round1(Math.min(...ys)))}–${fmtNum(round1(Math.max(...ys)))}</strong></div>
      </div>
      <section class="card chart-card">
        ${chartSvg(points, 'kg', days, 'Peso corporal por día', { trend, goal: gi ? gi.g.kg : null, goalPath: gp, dotsOnly: !!trend })}
        <div class="tip" hidden></div>
        ${trend || gi ? `<div class="chart-legend">
          <span><i class="lg-dot"></i>Pesajes</span>
          ${trend ? '<span><i class="lg-line"></i>Tendencia (7 días)</span>' : ''}
          ${gp ? '<span><i class="lg-path"></i>Camino a la meta</span>' : gi ? '<span><i class="lg-goal"></i>Meta</span>' : ''}
        </div>` : ''}
      </section>`;
  }

  return `${header('Cuerpo', {})}${bodyTabs('peso')}
    ${form}
    ${goalCard}
    ${rangeButtons(RANGES, bwRange, 'bw')}
    ${body}`;
}

// Cuerpo → % Grasa: tu % de grasa (a mano o con pliegues) y el FFMI
function viewBodyFat() {
  const ff = ffmiInfo(), bf = currentBf();
  const bfForm = `<form class="add-row bf-row" data-form="bf" novalidate style="margin-top:0">
      <span class="muted">% de grasa</span>
      <input name="bf" inputmode="decimal" value="${bf != null ? toField(bf) : ''}" placeholder="ej. 18" autocomplete="off" aria-label="Porcentaje de grasa">
      <span class="unit-label">%</span>
      <button class="btn">Guardar</button>
    </form>
    <a class="skin-link" href="#/pliegues">${db.skinfolds.length ? `Pliegues: última medición ${bwDate(db.skinfolds[db.skinfolds.length - 1].date)} ›` : 'Calcular con pliegues (plicómetro) ›'}</a>`;
  const ffmi = ff ? `<section class="card stack">
      <div class="ffmi-top"><strong class="ffmi-value">${ff.value.toFixed(1).replace('.', ',')}</strong>
        <span class="badge on">${FFMI_LEVELS[ff.level]}</span></div>
      <span class="muted small">Masa magra ${fmtKg(ff.lean)} (con tu último peso y ${fmtNum(ff.bf)} % de grasa)</span>
      <div class="ffmi-levels">${FFMI_LEVELS.map((name, k) => `<div class="ffmi-row ${k === ff.level ? 'on' : ''}">
        <span>${name}</span><span class="muted">${k === 0 ? `< ${ff.cuts[0]}` : k === FFMI_LEVELS.length - 1 ? `${ff.cuts[k - 1]}+` : `${ff.cuts[k - 1]} – ${ff.cuts[k]}`}</span>
      </div>`).join('')}</div>
      <p class="muted small" style="margin:0">Mide cuánta masa magra tienes para tu estatura. A diferencia del IMC, no confunde músculo con grasa.</p>
    </section>`
    : `<p class="muted card">Para ver tu FFMI falta ${ffmiMissing()}</p>`;

  return `${header('Cuerpo', {})}${bodyTabs('grasa')}
    <section class="card stack">${bfForm}</section>
    <h2>FFMI · masa libre de grasa</h2>
    ${ffmi}`;
}

function saveBodyweight(f) {
  const kg = num(f.elements.kg.value);
  if (kg == null || kg < 20 || kg > 400) return formMsg(f, 'Escribe tu peso en kg (ej. 75,5).');
  const date = todayKey();
  let entry = db.bodyweight.find(e => e.date === date);
  if (!entry) { entry = { date }; db.bodyweight.push(entry); }
  entry.kg = round1(kg);
  db.bodyweight.sort((a, b) => (a.date < b.date ? -1 : 1));
  // Meta puesta antes de anotar tu primer peso: empieza a contar desde hoy
  if (db.body.goal && db.body.goal.startKg == null) Object.assign(db.body.goal, { startKg: round1(kg), startDate: date });
  save();
  render();
  const after = $app.querySelector('[data-form="bodyweight"]');
  if (after) formMsg(after, `Guardado: ${fmtKg(kg)} hoy`, true);
}

// Meta de peso: la nueva parte desde tu último peso anotado
function saveGoal(f) {
  const g = num(f.elements.goal.value);
  if (g == null || g < 30 || g > 300) return formMsg(f, 'Escribe tu peso meta en kg (ej. 80).');
  if (!db.body.goal || db.body.goal.kg !== round1(g)) {
    const last = db.bodyweight[db.bodyweight.length - 1];
    db.body.goal = { kg: round1(g), startKg: last ? last.kg : null, startDate: last ? last.date : todayKey() };
  }
  const by = f.elements.by ? f.elements.by.value : '';
  if (by && by > todayKey()) db.body.goal.by = by; else delete db.body.goal.by;
  goalEditing = false;
  save();
  render();
}

function saveBf(f) {
  const t = f.elements.bf.value.trim(), v = num(t);
  if (t && (v == null || v < 3 || v > 60)) { notice('El % de grasa debe estar entre 3 y 60.'); return; }
  if (t) db.body.bf = round1(v);
  else { db.body.bf = null; db.bodyweight.forEach(e => delete e.bf); }   // vacío: se borra
  save();
  render();
}


// ---------- Pliegues (Jackson-Pollock, 3 pliegues) ----------
// db.skinfolds = [{ date: 'AAAA-MM-DD', s: { pecho, abdomen, muslo } (o tríceps, suprailíaco, muslo), bf }]
// Hombres: pecho, abdomen y muslo. Mujeres: tríceps, suprailíaco y muslo. % de grasa con la fórmula de Siri.
const SKIN_SITES = {
  h: [['pecho', 'Pecho', 'Diagonal, a mitad de camino entre la axila y el pezón'],
      ['abdomen', 'Abdomen', 'Vertical, 2 cm a la derecha del ombligo'],
      ['muslo', 'Muslo', 'Vertical, al frente del muslo, a mitad entre la cadera y la rodilla']],
  m: [['triceps', 'Tríceps', 'Vertical, atrás del brazo, a mitad entre el hombro y el codo'],
      ['suprailiaco', 'Suprailíaco', 'Diagonal, justo arriba del hueso de la cadera'],
      ['muslo', 'Muslo', 'Vertical, al frente del muslo, a mitad entre la cadera y la rodilla']],
};
let skinView = 'bf', skinRange = 'mes';
function jp3(sum, sex, age) {
  const bd = sex === 'm'
    ? 1.0994921 - 0.0009929 * sum + 0.0000023 * sum * sum - 0.0001392 * age
    : 1.10938 - 0.0008267 * sum + 0.0000016 * sum * sum - 0.0002574 * age;
  return 495 / bd - 450;
}
const skinAge = () => (db.body.birthYear ? new Date().getFullYear() - db.body.birthYear : null);

function viewSkinfolds() {
  const b = db.body, age = skinAge();
  if (!b.sex || !age) {
    return `${header('Pliegues', { back: true })}
      <p class="muted card">Para calcular tu % de grasa con pliegues falta ${[!b.sex && 'tu sexo', !age && 'tu año de nacimiento'].filter(Boolean).join(' y ')}. Ponlo en <a href="#/cuenta">⚙️ Cuenta → Mis datos</a>.</p>`;
  }
  const sites = SKIN_SITES[b.sex], today = db.skinfolds.find(e => e.date === todayKey());
  const form = `<form class="stack card" data-form="skin" novalidate>
      <span class="muted small">${today ? 'Hoy ya mediste; puedes corregirlo.' : 'Medición de hoy, en milímetros'}</span>
      <div class="skin-inputs">${sites.map(([k, name]) => `<label class="field"><span>${name}</span>
        <div class="add-row" style="margin-top:0"><input name="${k}" data-bind="skin" inputmode="decimal" value="${today ? toField(today.s[k]) : ''}" placeholder="mm" autocomplete="off" aria-label="${name} en mm"></div>
      </label>`).join('')}</div>
      <p class="skin-preview muted">${skinPreviewText(today ? sites.map(([k]) => today.s[k]) : [])}</p>
      <button class="btn primary block">Guardar y usar este %</button>
      <p class="form-msg" hidden></p>
    </form>`;
  const howTo = `${sectionHead('pliegues-como', 'Cómo medir')}
    ${openSections.has('pliegues-como') ? `<section class="card stack">
      ${sites.map(([, name, how]) => `<div><strong>${name}:</strong> <span class="muted">${how}.</span></div>`).join('')}
      <span class="muted small">Mide en el lado derecho, con la piel seca y antes de entrenar. Toma el pliegue con los dedos, pon el plicómetro 1 cm al lado y lee a los 2 segundos. Mide 2 veces y usa el promedio. Siempre a la misma hora para comparar bien.</span>
    </section>` : ''}`;

  // Evolución: % de grasa o cada pliegue
  const days = EX_RANGES.find(r => r[0] === skinRange)[2], since = Date.now() - days * 86400000;
  const inRange = db.skinfolds.filter(e => Date.parse(bwIso(e.date)) >= since);
  const isBf = skinView === 'bf', unit = isBf ? '%' : 'mm';
  const viewName = isBf ? '% de grasa' : (sites.find(([k]) => k === skinView) || [])[1];
  const points = inRange.filter(e => (isBf ? e.bf : e.s[skinView]) != null).map(e => {
    const y = isBf ? e.bf : e.s[skinView];
    return { t: Date.parse(bwIso(e.date)), date: bwIso(e.date), y, tip: `${fmtNum(y)} ${unit}` };
  });
  chart = null;
  const views = `<div class="skin-views">${[['bf', '% grasa'], ...sites.map(([k, name]) => [k, name])].map(([k, name]) =>
    `<button class="chip toggle ${k === skinView ? 'on' : ''}" data-action="skin-view" data-k="${k}">${name}</button>`).join('')}</div>`;
  let body;
  if (!db.skinfolds.length) body = '<p class="empty">Cuando guardes tu primera medición verás aquí su evolución.</p>';
  else if (!points.length) body = '<p class="empty">No hay mediciones en este período.</p>';
  else {
    const first = points[0], last = points[points.length - 1];
    body = `<div class="stats">
        <div class="stat"><span class="muted">Última</span><strong>${fmtNum(last.y)} ${unit}</strong><span class="muted">${bwDate(dayKeyOf(last.date))}</span></div>
        ${points.length > 1 ? `<div class="stat"><span class="muted">Cambio</span><strong>${signed(last.y - first.y)} ${unit}</strong><span class="muted">desde ${bwDate(dayKeyOf(first.date))}</span></div>` : ''}
      </div>
      <section class="card chart-card">
        ${chartSvg(points, unit, days, `${viewName} por medición`)}
        <div class="tip" hidden></div>
      </section>`;
  }
  const all = openSections.has('pliegues-lista');
  const list = db.skinfolds.slice().reverse().slice(0, all ? undefined : 7).map(e => `
    <div class="prog-row">
      <span class="muted">${bwDate(e.date)}</span>
      <span class="bw-right"><strong>${fmtNum(e.bf)} %</strong> <span class="muted small">${sites.map(([k]) => fmtNum(e.s[k] ?? 0)).join(' · ')} mm</span>
        <button class="icon small danger" data-action="del-skin" data-date="${e.date}" aria-label="Borrar medición">${TRASH_ICON}</button></span>
    </div>`).join('');

  return `${header('Pliegues', { back: true, sub: `Jackson-Pollock 3 pliegues · ${sites.map(([, n]) => n.toLowerCase()).join(', ')}` })}
    ${form}
    ${howTo}
    <h2>Evolución</h2>
    ${views}
    ${rangeButtons(EX_RANGES, skinRange, 'sk')}
    ${body}
    ${list ? `<h2>Mediciones</h2><section class="card">${list}</section>${moreBtn('pliegues-lista', db.skinfolds.length)}` : ''}`;
}

// "Suma: 42 mm → 13,8 % de grasa"
function skinPreviewText(vals) {
  const nums = vals.map(v => num(String(v ?? ''))).filter(v => v != null && v > 0);
  if (nums.length < 3) return 'Anota los 3 pliegues para calcular tu % de grasa.';
  const sum = nums.reduce((a, v) => a + v, 0);
  return `Suma: ${fmtNum(round1(sum))} mm → <strong>${fmtNum(round1(jp3(sum, db.body.sex, skinAge())))} % de grasa</strong>`;
}

function saveSkinfolds(f) {
  const sites = SKIN_SITES[db.body.sex], vals = {};
  for (const [k, name] of sites) {
    const v = num(f.elements[k].value);
    if (v == null || v < 2 || v > 80) return formMsg(f, `Escribe el pliegue de ${name.toLowerCase()} en mm (entre 2 y 80).`);
    vals[k] = round1(v);
  }
  const sum = Object.values(vals).reduce((a, v) => a + v, 0), bf = round1(jp3(sum, db.body.sex, skinAge()));
  const date = todayKey();
  let entry = db.skinfolds.find(e => e.date === date);
  if (!entry) { entry = { date }; db.skinfolds.push(entry); }
  Object.assign(entry, { s: vals, bf });
  db.skinfolds.sort((a, b) => (a.date < b.date ? -1 : 1));
  db.body.bf = bf;   // pasa a ser tu % de grasa (FFMI y kcal objetivo)
  save();
  render();
  formMsg($app.querySelector('[data-form="skin"]'), `Guardado: ${fmtNum(bf)} % de grasa`, true);
}


// ---------- Medidas con huincha ----------
// db.measures = [{ date: 'AAAA-MM-DD', m: { cintura: 82.5, … } }] en cm; cada medida es opcional.
// Brazo, muslo y pantorrilla van por lado: 'brazo' es el derecho (así se medía antes) y 'brazoI' el izquierdo.
const MEASURE_SITES = [
  ['cuello', 'Cuello', 'Justo debajo de la manzana de Adán'],
  ['hombros', 'Hombros', 'En la parte más ancha, con los brazos relajados'],
  ['pecho', 'Pecho', 'A la altura de los pezones, después de botar el aire normal'],
  ['cintura', 'Cintura', 'A la altura del ombligo, sin meter el estómago'],
  ['cadera', 'Cadera', 'En la parte más ancha de los glúteos'],
  ['brazo', 'Brazo der.', 'En la parte más gruesa, con el bíceps flexionado'],
  ['brazoI', 'Brazo izq.', 'En la parte más gruesa, con el bíceps flexionado'],
  ['muslo', 'Muslo der.', 'En la parte más gruesa, justo debajo del glúteo'],
  ['musloI', 'Muslo izq.', 'En la parte más gruesa, justo debajo del glúteo'],
  ['pantorrilla', 'Pantorrilla der.', 'En la parte más gruesa'],
  ['pantorrillaI', 'Pantorrilla izq.', 'En la parte más gruesa'],
];
const MEASURE_PAIRS = { brazo: 'brazoI', muslo: 'musloI', pantorrilla: 'pantorrillaI' };
// [derecho, izquierdo] si la medida va por lado
const measurePair = k => (MEASURE_PAIRS[k] ? [k, MEASURE_PAIRS[k]] : Object.entries(MEASURE_PAIRS).find(([, i]) => i === k) || null);
let measureView = 'cintura', measureRange = '3m';
// Último valor anotado de una medida (para mostrarlo de ejemplo)
const lastMeasure = k => { for (let n = db.measures.length - 1; n >= 0; n--) if (db.measures[n].m[k] != null) return db.measures[n].m[k]; return null; };

function viewMeasures() {
  const today = db.measures.find(e => e.date === todayKey());
  const form = `<form class="stack card" data-form="measures" novalidate>
      <span class="muted small">${today ? 'Hoy ya mediste con huincha; puedes corregirlo.' : 'Medidas de hoy con huincha, en cm. Anota solo las que quieras.'}</span>
      <div class="measure-inputs">${MEASURE_SITES.map(([k, name]) => {
        const last = lastMeasure(k);
        return `<label class="field"${MEASURE_PAIRS[k] ? ' style="grid-column:1"' : ''}><span>${name}</span>
          <input name="${k}" inputmode="decimal" value="${today && today.m[k] != null ? toField(today.m[k]) : ''}" placeholder="${last != null ? toField(last) : 'cm'}" autocomplete="off" aria-label="${name} en cm">
        </label>`;
      }).join('')}</div>
      <button class="btn primary block">Guardar</button>
      <p class="form-msg" hidden></p>
    </form>`;
  const howTo = `${sectionHead('medidas-como', 'Cómo medir')}
    ${openSections.has('medidas-como') ? `<section class="card stack">
      ${MEASURE_SITES.filter(([k]) => !Object.values(MEASURE_PAIRS).includes(k)).map(([k, name, how]) =>
        `<div><strong>${MEASURE_PAIRS[k] ? `${name.replace(' der.', '')} (cada lado)` : name}:</strong> <span class="muted">${how}.</span></div>`).join('')}
      <span class="muted small">La huincha debe quedar recta y pegada a la piel, sin apretar. Mide en ayunas y antes de entrenar, siempre a la misma hora. Es normal una diferencia pequeña entre lados: el lado dominante suele ser un poco más grande.</span>
    </section>` : ''}`;

  // Evolución de una medida a la vez (solo las que has anotado)
  const used = MEASURE_SITES.filter(([k]) => db.measures.some(e => e.m[k] != null));
  if (used.length && !used.some(([k]) => k === measureView)) measureView = used[0][0];
  const days = EX_RANGES.find(r => r[0] === measureRange)[2], since = Date.now() - days * 86400000;
  const name = (MEASURE_SITES.find(([k]) => k === measureView) || [])[1];
  const points = db.measures.filter(e => e.m[measureView] != null && Date.parse(bwIso(e.date)) >= since).map(e => ({
    t: Date.parse(bwIso(e.date)), date: bwIso(e.date), y: e.m[measureView], tip: `${fmtNum(e.m[measureView])} cm`,
  }));
  chart = null;
  let body;
  if (!used.length) body = '<p class="empty">Cuando guardes tus primeras medidas verás aquí su evolución.</p>';
  else if (!points.length) body = '<p class="empty">No hay mediciones en este período.</p>';
  else {
    const first = points[0], last = points[points.length - 1], h = db.body.heightCm;
    // Cintura / estatura: menos de 0,5 se considera saludable
    const whtr = measureView === 'cintura' && h ? last.y / h : null;
    // Derecho vs izquierdo: la última vez que mediste los dos lados
    const pair = measurePair(measureView);
    const both = pair && db.measures.slice().reverse().find(e => e.m[pair[0]] != null && e.m[pair[1]] != null);
    const side = both ? round1(both.m[pair[0]] - both.m[pair[1]]) : null;
    body = `<div class="stats">
        <div class="stat"><span class="muted">Última</span><strong>${fmtNum(last.y)} cm</strong><span class="muted">${bwDate(dayKeyOf(last.date))}</span></div>
        ${points.length > 1 ? `<div class="stat"><span class="muted">Cambio</span><strong>${signed(last.y - first.y)} cm</strong><span class="muted">desde ${bwDate(dayKeyOf(first.date))}</span></div>` : ''}
        ${both ? `<div class="stat"><span class="muted">Der. vs izq.</span><strong>${side ? `${fmtNum(Math.abs(side))} cm` : 'Iguales'}</strong><span class="muted">${side ? `más grande el ${side > 0 ? 'derecho' : 'izquierdo'}` : bwDate(both.date)}</span></div>` : ''}
        ${whtr ? `<div class="stat"><span class="muted">Cintura / estatura</span><strong>${whtr.toFixed(2).replace('.', ',')}</strong><span class="muted">${whtr < 0.5 ? 'saludable (bajo 0,5)' : 'sobre 0,5'}</span></div>` : ''}
      </div>
      <section class="card chart-card">
        ${chartSvg(points, 'cm', days, `${name} por medición`)}
        <div class="tip" hidden></div>
      </section>`;
  }
  const views = used.length > 1 ? `<div class="skin-views">${used.map(([k, n]) =>
    `<button class="chip toggle ${k === measureView ? 'on' : ''}" data-action="measure-view" data-k="${k}">${n}</button>`).join('')}</div>` : '';
  const all = openSections.has('medidas-lista');
  const list = db.measures.slice().reverse().slice(0, all ? undefined : 7).map(e => `
    <div class="prog-row">
      <span class="muted">${bwDate(e.date)}</span>
      <span class="bw-right"><span class="muted small measure-sum">${MEASURE_SITES.filter(([k]) => e.m[k] != null).map(([k, n]) => `${n} ${fmtNum(e.m[k])}`).join(' · ')}</span>
        <button class="icon small danger" data-action="del-measure" data-date="${e.date}" aria-label="Borrar medición">${TRASH_ICON}</button></span>
    </div>`).join('');

  return `${header('Cuerpo', {})}${bodyTabs('medidas')}
    ${form}
    ${howTo}
    <h2>Evolución</h2>
    ${views}
    ${rangeButtons(EX_RANGES, measureRange, 'ms')}
    ${body}
    ${list ? `<h2>Mediciones</h2><section class="card">${list}</section>${moreBtn('medidas-lista', db.measures.length)}` : ''}`;
}

function saveMeasures(f) {
  const vals = {};
  for (const [k, name] of MEASURE_SITES) {
    const t = f.elements[k].value.trim();
    if (!t) continue;
    const v = num(t);
    if (v == null || v < 10 || v > 250) return formMsg(f, `Escribe ${name.toLowerCase()} en cm (entre 10 y 250).`);
    vals[k] = round1(v);
  }
  const date = todayKey(), k = db.measures.findIndex(e => e.date === date);
  if (!Object.keys(vals).length) {
    if (k < 0) return formMsg(f, 'Anota al menos una medida.');
    db.measures.splice(k, 1);   // dejaste todo vacío: se borra la de hoy
  } else if (k >= 0) db.measures[k].m = vals;
  else { db.measures.push({ date, m: vals }); db.measures.sort((a, b) => (a.date < b.date ? -1 : 1)); }
  save();
  render();
  formMsg($app.querySelector('[data-form="measures"]'), 'Medidas guardadas', true);
}

// ---------- Fotos de progreso ----------
// Privadas (solo tú). Cada foto: miniatura con fecha y pose en users/{uid}/progressThumbs/{id}
// y la foto grande en users/{uid}/progress/{id}. No van en los datos principales para no hacerlos pesados.
const POSES = [['frente', 'Frente'], ['perfil', 'Perfil'], ['espalda', 'Espalda']];
const poseName = k => (POSES.find(p => p[0] === k) || [])[1] || '';
let progList = null;          // [{ id, date, pose, url (miniatura) }] o null si no se ha cargado
let progLoading = false, progError = false;
const progFull = new Map();   // id → foto grande (o 'loading' / 'error')
let progNew = null;           // foto nueva antes de guardarla: { crop, pose, date }
const PROG_BOX = [240, 320];  // cuadro 3:4 en pantalla
let progOpen = null;          // id de la foto abierta en grande
let progPose = '';            // filtro de pose ('' = todas)
let progCmp = null;           // [idAntes, idDespués] elegidos para comparar
const progCmpBy = {};         // lo elegido en cada pose (para no perderlo al cambiar de filtro)
let progUid = null;           // dueño de lo cargado (por si cambia la sesión)

async function loadProgress(force = false) {
  if (progUid !== dataUid()) { progList = null; progFull.clear(); progUid = dataUid(); }
  if ((progList && !force) || progLoading) return;
  progLoading = true; progError = false;
  const uid = dataUid();
  try {
    const list = await withTimeout(cloud.listProgress(uid));
    if (!user || dataUid() !== uid) { progLoading = false; return; }
    progList = list.filter(x => safePhoto(x.url)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  } catch (e) { progError = true; }
  progLoading = false;
  if (['fotos', 'checkin'].includes(routeParts()[0])) refresh();
}
function needFull(id) {
  if (progFull.has(id)) return;
  progFull.set(id, 'loading');
  const uid = dataUid();
  cloud.getProgressFull(uid, id).then(url => {
    if (dataUid() === uid) progFull.set(id, safePhoto(url) || 'error');
  }, () => progFull.set(id, 'error')).then(() => { if (user && dataUid() === uid && routeParts()[0] === 'fotos') refresh(); });
}
// La foto grande si ya llegó; mientras, la miniatura
const progSrc = x => { needFull(x.id); const f = progFull.get(x.id); return f && f !== 'loading' && f !== 'error' ? f : x.url; };
// Tu peso ese día (o el último anotado antes)
function weightOn(date) {
  let found = null;
  for (const e of db.bodyweight) { if (e.date <= date) found = e; else break; }
  return found && found.date >= dayKeyOf(new Date(Date.parse(bwIso(date)) - 7 * 86400000)) ? found.kg : null;
}
// "3 sept" (con el año si no es este año)
const shortDate = date => new Date(bwIso(date)).toLocaleDateString('es', { day: 'numeric', month: 'short', ...(date.slice(0, 4) !== todayKey().slice(0, 4) ? { year: 'numeric' } : {}) });
const daysBetween = (a, b) => Math.round((Date.parse(bwIso(b)) - Date.parse(bwIso(a))) / 86400000);

function openProgressNew(file) {
  const src = URL.createObjectURL(file), img = new Image();
  img.onload = () => { progNew = { crop: newCrop(img, src, ...PROG_BOX), pose: progPose || 'frente', date: todayKey() }; render(); };
  img.onerror = () => { URL.revokeObjectURL(src); notice('No se pudo usar esa imagen. Prueba con otra.'); };
  img.src = src;
}
function closeProgressNew() {
  if (progNew) URL.revokeObjectURL(progNew.crop.src);
  progNew = null;
}
async function saveProgressNew(btn) {
  const n = progNew, date = n.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayKey()) return notice('Elige una fecha válida (hoy o antes).');
  // Grande: hasta 810×1080 (sin agrandar más de lo que trae la foto); miniatura 240×320
  const c = n.crop, h = Math.round(Math.min(1080, c.bh / cropScale(c)));
  const full = cropToCanvas(c, Math.round(h * 3 / 4), h, 0.8), thumb = cropToCanvas(c, 240, 320, 0.7), id = uid();
  const meta = { date, pose: n.pose };
  await busy(btn, 'Subiendo…', async () => {
    try {
      await withTimeout(cloud.putProgress(user.uid, id, meta, thumb, full));
    } catch (e) {
      notice('No se pudo subir la foto. Revisa tu internet e intenta de nuevo.');
      return;
    }
    progFull.set(id, full);
    if (progList) {
      progList.push({ id, ...meta, url: thumb });
      progList.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
    progCmp = null;
    closeProgressNew();
    render();
  });
}
async function deleteProgress(id) {
  if (!await ask('¿Borrar esta foto? No se puede recuperar.')) return;
  try {
    await withTimeout(cloud.deleteProgress(user.uid, id));
  } catch (e) { notice('No se pudo borrar. Revisa tu internet e intenta de nuevo.'); return; }
  progList = progList.filter(x => x.id !== id);
  progFull.delete(id);
  progOpen = null;
  progCmp = null;
  render();
}

// "2026-10-15" → "15/10/2026"
const fmtDMY = key => (key ? key.split('-').reverse().join('/') : '');
function progressNewHtml() {
  const n = progNew;
  return `<div class="modal-wrap">
    <div class="modal-back" data-action="prog-cancel"></div>
    <section class="modal card prog-modal" role="dialog" aria-modal="true" aria-label="Nueva foto de progreso">
      <h2>Nueva foto</h2>
      ${cropBoxHtml(n.crop, false)}
      <div class="link-chips" role="group" aria-label="Pose">${POSES.map(([k, label]) =>
        `<button class="chip toggle ${n.pose === k ? 'on' : ''}" data-action="prog-pose-new" data-k="${k}" aria-pressed="${n.pose === k}">${label}</button>`).join('')}</div>
      <label class="field"><span>Fecha de la foto</span>
        <div class="date-field"><span class="date-show">${fmtDMY(n.date)}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>
          <input type="date" data-bind="prog-date" value="${n.date}" max="${todayKey()}" aria-label="Fecha de la foto"></div></label>
      <div class="ex-actions">
        <button class="btn ghost" data-action="prog-cancel">Cancelar</button>
        <button class="btn primary" data-action="prog-save">Guardar</button>
      </div>
    </section>
  </div>`;
}

function progressViewerHtml() {
  const x = progList && progList.find(p => p.id === progOpen);
  if (!x) return '';
  const kg = weightOn(x.date);
  return `<div class="modal-wrap photo-viewer prog-viewer" role="dialog" aria-label="Foto de progreso">
    <div class="modal-back" data-action="prog-close"></div>
    <img src="${progSrc(x)}" alt="Foto del ${bwDate(x.date)}" data-action="prog-close">
    <div class="prog-viewer-bar">
      <span>${esc(poseName(x.pose))} · ${fmtLongDate(bwIso(x.date))}${kg != null ? ` · ${fmtKg(kg)}` : ''}</span>
      <div class="ex-actions">
        <button class="btn ghost danger-text" data-action="prog-del" data-id="${x.id}">Borrar</button>
        <button class="btn" data-action="prog-close">Cerrar</button>
      </div>
    </div>
  </div>`;
}

function viewProgressPhotos() {
  loadProgress();
  const add = `<label class="btn primary block prog-add">Agregar foto
      <input type="file" accept="image/*" data-bind="prog-file" hidden></label>`;
  let body;
  if (!progList) {
    body = progError
      ? '<p class="empty">No se pudieron cargar tus fotos. Revisa tu internet. <button class="link" data-action="prog-retry">Reintentar</button></p>'
      : '<p class="empty">Cargando…</p>';
  } else if (!progList.length) {
    body = '<p class="empty">Todavía no tienes fotos. Sácate una de frente, de perfil y de espalda, con la misma luz y a la misma hora, y repítelo cada 2 a 4 semanas.</p>';
  } else {
    const poses = POSES.filter(([k]) => progList.some(x => x.pose === k));
    if (progPose && !poses.some(([k]) => k === progPose)) progPose = '';
    const list = progList.filter(x => !progPose || x.pose === progPose);
    const filter = poses.length > 1 ? `<div class="skin-views">${[['', 'Todas'], ...poses].map(([k, label]) =>
      `<button class="chip toggle ${k === progPose ? 'on' : ''}" data-action="prog-filter" data-k="${k}">${label}</button>`).join('')}</div>` : '';

    // Comparar: por defecto la última foto y la primera con la misma pose
    let cmp = '';
    if (list.length >= 2) {
      const ids = list.map(x => x.id), last = list[list.length - 1];
      const first = list.find(x => x.pose === last.pose && x !== last) || list[0];
      if (!progCmp || !ids.includes(progCmp[0]) || !ids.includes(progCmp[1])) progCmp = [first.id, last.id];
      const pick = (k, label) => `<select data-bind="prog-cmp" data-k="${k}" aria-label="${label}">${list.map(x =>
        `<option value="${x.id}" ${x.id === progCmp[k] ? 'selected' : ''}>${shortDate(x.date)}${progPose ? '' : ` · ${poseName(x.pose)}`}</option>`).join('')}</select>`;
      const [a, b] = progCmp.map(id => list.find(x => x.id === id));
      const side = (x, k, label) => {
        const kg = weightOn(x.date);
        return `<div class="cmp-side">
          <span class="muted small">${label}</span>
          ${pick(k, `Foto ${label.toLowerCase()}`)}
          <button class="cmp-img" data-action="prog-open" data-id="${x.id}" aria-label="Ver en grande"><img src="${progSrc(x)}" alt=""></button>
          <span class="muted small">${kg != null ? fmtKg(kg) : 'Sin peso ese día'}</span>
        </div>`;
      };
      const ka = weightOn(a.date), kb = weightOn(b.date), d = Math.abs(daysBetween(a.date, b.date));
      cmp = `<h2>Comparar</h2>
        <section class="card stack">
          <div class="cmp-row">${side(a, 0, 'Antes')}${side(b, 1, 'Después')}</div>
          <span class="muted small cmp-diff">${d ? `${plural(d, 'día')} entre las fotos` : 'Mismo día'}${ka != null && kb != null && d ? ` · ${signed(b.date >= a.date ? kb - ka : ka - kb)} kg` : ''}</span>
        </section>`;
    }
    const grid = list.slice().reverse().map(x => `<button class="prog-thumb" data-action="prog-open" data-id="${x.id}" aria-label="Foto del ${bwDate(x.date)}">
        <img src="${x.url}" alt="" loading="lazy"><span>${shortDate(x.date)}${progPose ? '' : ` · ${esc(poseName(x.pose))}`}</span>
      </button>`).join('');
    body = `${filter}${cmp}<h2>Todas (${list.length})</h2><div class="prog-grid">${grid}</div>`;
  }
  return `${header('Cuerpo', {})}${bodyTabs('fotos')}
    <p class="muted small prog-note">Fotos de progreso privadas: solo tú las ves.</p>
    ${add}
    ${body}
    ${progNew ? progressNewHtml() : ''}
    ${progOpen ? progressViewerHtml() : ''}`;
}

// ---------- Sueño ----------
// Un registro por día: { date: 'AAAA-MM-DD', h } con las horas que dormiste la noche anterior
let sleepRange = 'mes';
let sleepAsk = false;   // ventana "¿Cuántas horas dormiste anoche?" abierta
const fmtH = h => `${fmtNum(round1(h))} h`;
const sleepAskedKey = () => `desdel-sueno-pregunta-${user.uid}`;

// Acepta "7", "7,5" o "7:30"
function parseHours(text) {
  const t = String(text).trim().replace(',', '.');
  const m = t.match(/^(\d{1,2}):(\d{1,2})$/);
  if (m) return +m[1] + +m[2] / 60;
  const n = Number(t);
  return t && Number.isFinite(n) ? n : null;
}

function sleepAvg(days) {
  const since = Date.now() - days * 86400000;
  const list = db.sleep.filter(e => Date.parse(bwIso(e.date)) >= since);
  return list.length ? list.reduce((a, e) => a + e.h, 0) / list.length : null;
}

// ---------- Tutorial ----------
// Bienvenida de 5 pantallas: se abre sola al crear la cuenta y se puede ver de nuevo en Cuenta.
// A quien ya usaba la app se le ofrece una vez en el inicio. Se guarda en este teléfono.
const tourKey = () => `desdel-tour-${user.uid}`;
const tipsKey = () => `desdel-tips-${user.uid}`;
let tourOpen = false, tourStep = 0;
const tourSeen = () => { try { return !!localStorage.getItem(tourKey()); } catch (e) { return true; } };
function setTourSeen() { try { localStorage.setItem(tourKey(), 'done'); } catch (e) { /* sin almacenamiento */ } }
const TOUR = [
  { icon: '💪', title: 'Bienvenido a Desdel', text: 'Anota tu entreno y mira si de verdad estás progresando. Gratis y con todo en un solo lugar.' },
  { icon: '📅', title: 'Rutinas y programas', text: 'Elige un programa listo según los días que tienes y tu nivel, o arma tu propia rutina. Si prefieres, también puedes entrenar sin rutina.' },
  { icon: '🏋️', title: 'Entrenar', text: 'Toca Empezar y anota el peso y las repeticiones de cada serie. Te muestra lo que hiciste la vez anterior para que lo superes, y en el descanso te hace preguntas para aprender.' },
  { icon: '📈', title: 'Progreso', text: 'Mira el gráfico de cada ejercicio y tus récords: así sabes si estás subiendo o si te estancaste.' },
  { icon: '🧩', title: 'Todo lo demás', text: 'Peso, medidas, % de grasa y fotos. Dieta, agua y sueño. Y tus gymbros: chat, rutinas compartidas y récords. Todo está en el inicio.' },
];
function tourHtml() {
  const t = TOUR[tourStep], last = tourStep === TOUR.length - 1;
  return `<div class="modal-wrap tour-wrap">
    <div class="modal-back"></div>
    <section class="modal card tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div class="tour-top">
        <span class="muted small">${tourStep + 1} de ${TOUR.length}</span>
        ${last ? '' : '<button class="link small" data-action="tour-close">Saltar</button>'}
      </div>
      <div class="tour-icon" aria-hidden="true">${t.icon}</div>
      <h2 id="tour-title">${t.title}</h2>
      <p class="tour-text">${t.text}</p>
      <div class="tour-dots" aria-hidden="true">${TOUR.map((_, k) => `<span class="${k === tourStep ? 'on' : ''}"></span>`).join('')}</div>
      ${last ? `
        <button class="btn primary block" data-action="tour-go" data-to="free">Entrenar sin rutina</button>
        <button class="btn block" data-action="tour-go" data-to="#/listos">Elegir un programa</button>
        <button class="btn ghost block" data-action="tour-close">Explorar la app</button>`
      : `<div class="tour-nav">
          ${tourStep ? '<button class="btn" data-action="tour-prev">‹ Atrás</button>' : '<span></span>'}
          <button class="btn primary" data-action="tour-next">Siguiente ›</button>
        </div>`}
    </section>
  </div>`;
}
function openTour() { tourOpen = true; tourStep = 0; setTourSeen(); render(); }
function closeTour() { tourOpen = false; setTourSeen(); render(); }

// Consejo la primera vez que entras a una sección (se cierra con ✕ y no vuelve a salir)
const TIPS = {
  rutinas: 'Toca una rutina para editarla y Empezar para entrenarla. Si tienes un programa activo, la que te toca hoy aparece marcada.',
  entrenar: 'En gris está el peso de la vez anterior y tu objetivo de repeticiones. Si dejas una casilla vacía, se guarda lo que hiciste la vez anterior; si cambia, escribe lo nuevo. Un ejercicio en el que no anotas nada no se guarda. Si no hiciste una serie, bórrala con el basurero. Al lado de cada serie, un gráfico chico: sube si superaste tu mejor serie, plano si la igualaste, baja si quedaste bajo.',
  programas: 'Los programas listos traen la semana armada según tus días y nivel. El programa activo es el que te dice qué rutina te toca cada día.',
  historial: 'Toca un día del calendario para ver lo que entrenaste. Desde cada entreno lo puedes editar o compartir.',
  progreso: 'Toca un ejercicio para ver su gráfico y tus récords.',
  peso: 'Pésate en ayunas, varias veces por semana: el promedio de la semana dice más que un día suelto.',
  grasa: 'Anota tu % de grasa (o calcúlalo con pliegues) y mira tu FFMI: cuánto músculo tienes para tu estatura.',
  medidas: 'Mide cada 2 a 4 semanas, siempre en las mismas condiciones: así los gráficos muestran cambios reales.',
  fotos: 'Sácate las fotos con la misma luz, ropa y pose cada vez: así se nota el cambio.',
  nutricion: 'Arma tu dieta con alimentos y cantidades, y marca cada día las comidas que te comiste. Las calorías y proteínas se suman solas.',
  agua: 'Toca los botones para sumar lo que tomas. La meta se calcula con tu peso, y la puedes cambiar.',
  sueno: 'Anota cuántas horas dormiste. Cada mañana, al abrir la app, te lo pregunta.',
  social: 'Con tus gymbros pueden chatear, mandarse rutinas, dietas y programas, y ver sus récords. Para sumar a otro, toca "Agregar gymbro" y mándale tu link.',
};
function tipsClosed() { try { return JSON.parse(localStorage.getItem(tipsKey())) || []; } catch (e) { return []; } }
function closeTip(k) { try { localStorage.setItem(tipsKey(), JSON.stringify([...new Set([...tipsClosed(), k])])); } catch (e) { /* sin almacenamiento */ } }
const TIP_READY = {
  rutinas: () => db.routines.length, programas: () => db.programs.length, historial: () => db.workouts.length,
  progreso: () => db.workouts.length, peso: () => db.bodyweight.length, grasa: () => currentBf() != null,
  medidas: () => db.measures.length, fotos: () => progList && progList.length, nutricion: () => N().diets.length,
  sueno: () => db.sleep.length, social: () => chats.length,
};
function tipHtml(screen, arg) {
  const k = screen === 'entrenar' ? (arg ? null : 'entrenar') : screen === 'progreso' && arg ? null : screen;
  if (!k || !TIPS[k] || tourOpen || tipsClosed().includes(k)) return '';
  if (TIP_READY[k] && !TIP_READY[k]()) return '';
  return `<div class="card tip-card" data-tip="${k}"><span>💡 ${TIPS[k]}</span>
    <button class="icon small" data-action="tip-close" data-k="${k}" aria-label="Cerrar consejo">✕</button></div>`;
}

// Una vez al día, la primera vez que abres la app (en la pantalla que sea, salvo entrenando o en un chat),
// pregunta cuántas horas dormiste si todavía no lo anotas. Antes de las 4 AM no pregunta (todavía es "anoche").
function maybeAskSleep() {
  if (tourOpen || new Date().getHours() < 4) return;
  if (localStorage.getItem(sleepAskedKey()) === todayKey()) return;
  localStorage.setItem(sleepAskedKey(), todayKey());
  if (!db.sleep.some(e => e.date === todayKey())) sleepAsk = true;
}

const sleepQuick = () => `<div class="sleep-quick">${[5, 6, 7, 8, 9].map(h =>
  `<button type="button" class="btn" data-action="sleep-set" data-h="${h}">${h} h</button>`).join('')}</div>`;

function sleepModal() {
  return `<div class="modal-wrap">
    <div class="modal-back" data-action="sleep-skip"></div>
    <section class="modal card" role="dialog" aria-modal="true" aria-labelledby="sleep-title">
      <h2 id="sleep-title">😴 ¿Cuántas horas dormiste anoche?</h2>
      ${sleepQuick()}
      <form class="stack" data-form="sleep" novalidate>
        <div class="add-row" style="margin-top:0">
          <input name="h" inputmode="decimal" placeholder="Otra (ej. 7,5)" autocomplete="off" aria-label="Horas de sueño">
          <button class="btn primary">Guardar</button>
        </div>
        <p class="form-msg" hidden></p>
      </form>
      <button class="btn ghost block" data-action="sleep-skip">Ahora no</button>
    </section>
  </div>`;
}

function saveSleep(h, f) {
  if (h == null || h <= 0 || h > 16) return f ? formMsg(f, 'Escribe las horas que dormiste (ej. 7,5).') : null;
  const date = todayKey();
  const entry = db.sleep.find(e => e.date === date);
  if (entry) entry.h = round1(h);
  else db.sleep.push({ date, h: round1(h) });
  db.sleep.sort((a, b) => (a.date < b.date ? -1 : 1));
  sleepAsk = false;
  save();
  render();
  const form = $app.querySelector('.sleep-today[data-form="sleep"]');
  if (form) formMsg(form, `Guardado: ${fmtH(h)} anoche`, true);
}

function sleepCard() {
  const last = db.sleep[db.sleep.length - 1], avg = sleepAvg(7);
  const today = last && last.date === todayKey();
  return `<a class="card hub" href="#/sueno">
      <div class="hub-top"><span class="hub-icon">😴</span><strong>Sueño</strong></div>
      ${last
        ? `<div class="hub-value"><strong>${fmtH(last.h)}</strong> ${today ? 'anoche' : `· ${bwDate(last.date)}`}</div>
           <span class="muted">${today ? '' : 'Toca para anotar hoy · '}${avg != null ? `Promedio 7 días: ${fmtH(avg)}` : ''}</span>`
        : '<span class="muted">Anota cuántas horas duermes cada noche</span>'}
    </a>`;
}

function viewSleep() {
  const today = db.sleep.find(e => e.date === todayKey());
  const days = RANGES.find(r => r[0] === sleepRange)[2];
  const since = Date.now() - days * 86400000;
  const points = db.sleep
    .map(e => ({ t: Date.parse(bwIso(e.date)), date: bwIso(e.date), y: e.h, tip: fmtH(e.h) }))
    .filter(pt => pt.t >= since);
  chart = null;

  const form = `<section class="card stack">
      <span class="muted">${today ? `Anoche: <strong>${fmtH(today.h)}</strong> (puedes corregirlo)` : 'Horas que dormiste anoche'}</span>
      ${sleepQuick()}
      <form class="stack sleep-today" data-form="sleep" novalidate>
        <div class="add-row" style="margin-top:0">
          <input name="h" inputmode="decimal" placeholder="Otra (ej. 7,5 o 7:30)" autocomplete="off" aria-label="Horas de sueño">
          <button class="btn primary">Guardar</button>
        </div>
        <p class="form-msg" hidden></p>
      </form>
    </section>`;

  let body;
  if (!points.length) {
    body = `<p class="empty">${db.sleep.length ? 'No hay registros en este período.' : 'Todavía no anotas tu sueño. Empieza hoy arriba 👆'}</p>`;
  } else {
    const ys = points.map(pt => pt.y), avg = ys.reduce((a, v) => a + v, 0) / ys.length;
    body = `<div class="stats">
        <div class="stat"><span class="muted">Promedio</span><strong>${fmtH(avg)}</strong></div>
        <div class="stat"><span class="muted">Mínimo</span><strong>${fmtH(Math.min(...ys))}</strong></div>
        <div class="stat"><span class="muted">Máximo</span><strong>${fmtH(Math.max(...ys))}</strong></div>
      </div>
      <section class="card chart-card">
        ${chartSvg(points, 'h', days, 'Horas de sueño por noche')}
        <div class="tip" hidden></div>
      </section>`;
  }

  const allSl = openSections.has('sueno-lista');
  const list = db.sleep.slice().reverse().slice(0, allSl ? undefined : 7).map(e => `
    <div class="prog-row">
      <span class="muted">${bwDate(e.date)}</span>
      <span class="bw-right">${fmtH(e.h)}
        <button class="icon small danger" data-action="del-sleep" data-date="${e.date}" aria-label="Borrar registro">${TRASH_ICON}</button>
      </span>
    </div>`).join('');

  return `${header('Sueño', { back: true, sub: 'Horas que dormiste cada noche' })}
    ${form}
    ${rangeButtons(RANGES, sleepRange, 'sl')}
    ${body}
    ${list ? `<h2>Registros</h2><section class="card">${list}</section>${moreBtn('sueno-lista', db.sleep.length)}` : ''}`;
}

function viewProgressExercise(id) {
  const rows = historyFor(id);
  if (!rows.length) { location.replace('#/progreso'); return ''; }
  const name = rows[0].ex.name;
  const days = EX_RANGES.find(r => r[0] === progressRange)[2];
  // Rutinas donde lo hiciste: si son varias, se puede ver cada una por separado (al principio o al final de la rutina rindes distinto)
  if (progressRid.ex !== id) progressRid = { ex: id, r: '' };
  const rids = new Map();
  for (const { w } of rows) if (!rids.has(ridKey(w))) rids.set(ridKey(w), (db.routines.find(r => r.id === w.routineId) || {}).name || w.routineName || 'Sin rutina');
  if (!rids.has(progressRid.r)) progressRid.r = '';
  const rid = progressRid.r;
  const { unit, points } = progressPoints(id, days, rid);
  chart = null;

  const range = rangeButtons(EX_RANGES, progressRange, 'ex') + (rids.size > 1 ? `<div class="prog-rids" role="group" aria-label="Rutina">
      ${[['', 'Todas'], ...rids].map(([k, n]) => `<button class="chip toggle ${rid === k ? 'on' : ''}" data-action="prog-rid" data-r="${esc(k)}" aria-pressed="${rid === k}">${esc(n)}</button>`).join('')}</div>` : '');
  const bwEx = isBwEx({ exerciseId: id, bw: rows[0].ex.bw });
  const sub = bwEx ? 'Lastre máximo estimado' : 'Tu fuerza estimada (1RM)';

  if (!points.length) {
    return `${header(name, { back: true, sub })}${range}
      <p class="empty">No entrenaste este ejercicio en este período${rows.some(r => r.ex.sets.some(s => s.w != null)) ? '' : ' (o no tiene peso anotado)'}.</p>`;
  }

  const max = points.reduce((a, p) => (p.y > a.y ? p : a));
  const first = points[0], last = points[points.length - 1];
  const diff = round1(last.y - first.y);
  const stats = `<div class="stats">
    <div class="stat"><span class="muted">${bwEx ? 'Mejor lastre del período' : `Mejor 1RM ${infoBtn('rm')}`}</span><strong>${bwEx ? '+' : ''}${fmtNum(max.y)} ${unit}</strong><span class="muted">${fmtDate(max.date)}</span></div>
    ${points.length > 1 ? `<div class="stat"><span class="muted">Cambio</span><strong>${diff > 0 ? '+' : ''}${fmtNum(diff)} ${unit}</strong><span class="muted">desde ${fmtDate(first.date)}</span></div>` : ''}
  </div>${bwEx ? '' : infoBox('rm')}`;

  const table = points.slice().reverse().map(p => `
    <div class="prog-row"><span class="muted">${fmtDate(p.date)}${rids.size > 1 && !rid ? `<br><span class="small">${esc(p.rname)}</span>` : ''}</span><span>${setText(p.set, p.set.unit)} <span class="muted">→ ${bwEx ? '+' : ''}${fmtNum(p.y)} ${unit}</span></span></div>`).join('');

  return `${header(name, { back: true, sub })}
    ${range}
    ${stats}
    <section class="card chart-card">
      ${chartSvg(points, unit, days, sub)}
      <div class="tip" hidden></div>
    </section>
    <p class="muted hint">${bwEx
      ? 'Es el lastre máximo que podrías levantar 1 vez, calculado con la 1ª serie y tu peso de ese día.<br>Ej: pesando 90 kg, 30 kg × 7 ≈ +58 kg de lastre'
      : 'Es una estimación del peso máximo que podrías levantar, calculada con la 1ª serie.<br>Ej: 100 kg × 8 con RIR 2 ≈ 133 kg'}</p>
    <h2>Sesiones</h2>
    <section class="card">${table}</section>`;
}

// Tooltip: al pasar o tocar el gráfico se marca la sesión más cercana
function showChartTip(e) {
  const svg = e.target.closest('svg.chart');
  if (!svg || !chart) return;
  const box = svg.getBoundingClientRect();
  const px = ((e.clientX - box.left) / box.width) * chart.W;
  const k = chart.points.reduce((best, p, i) => (Math.abs(p.x - px) < Math.abs(chart.points[best].x - px) ? i : best), 0);
  const p = chart.points[k];
  const cross = svg.querySelector('.cross');
  cross.setAttribute('x1', p.x); cross.setAttribute('x2', p.x); cross.setAttribute('visibility', 'visible');
  svg.querySelectorAll('.dot').forEach(d => d.setAttribute('r', +d.dataset.k === k ? 6 : d.dataset.r));
  const tip = svg.parentElement.querySelector('.tip');
  tip.innerHTML = `<span class="muted">${fmtDate(p.date)}</span><strong>${p.tip}</strong>`;
  tip.hidden = false;
  const left = (p.x / chart.W) * box.width, half = tip.offsetWidth / 2;
  tip.style.left = `${Math.min(Math.max(left, half + 4), box.width - half - 4)}px`;
  tip.style.top = `${(p.yPx / chart.H) * box.height - 12}px`;
}
$app.addEventListener('pointermove', e => { if (e.target.closest('svg.chart')) showChartTip(e); });
$app.addEventListener('pointerdown', e => { if (e.target.closest('svg.chart')) showChartTip(e); });
$app.addEventListener('pointerleave', e => {
  if (e.pointerType !== 'mouse') return;
  const svg = $app.querySelector('svg.chart');
  if (!svg) return;
  svg.querySelector('.cross').setAttribute('visibility', 'hidden');
  svg.querySelectorAll('.dot').forEach(d => d.setAttribute('r', d.dataset.r));
  svg.parentElement.querySelector('.tip').hidden = true;
}, true);

function viewExercise(id) {
  const rows = historyFor(id);
  if (!rows.length) { location.replace('#/historial'); return ''; }
  const name = rows[0].ex.name;
  const blocks = rows.map(({ w, ex }) => `
    <section class="card">
      <div class="ex-head"><strong>${fmtDate(w.date)}</strong><span class="muted">${esc(w.routineName)}</span></div>
      ${setsChips(ex)}
    </section>`).join('');
  return `${header(name, { back: true, sub: plural(rows.length, 'sesión', 'sesiones') })}
    <a class="btn block center" href="#/progreso/${encodeURIComponent(id)}" style="margin:0 0 12px">📈 Ver gráfico de progreso</a>
    ${blocks}`;
}

// ---------- Render / navegación ----------
function render() {
  const [screen, arg = ''] = routeParts();
  const authScreen = screen === 'login' || screen === 'registro';
  if (inApp) { $app.innerHTML = viewInApp(); $tabs.hidden = true; return; }
  if (handoffCode) { $app.innerHTML = viewHandoff(); $tabs.hidden = true; return; }

  // Sin sesión: solo pantallas de acceso. Cargando o con error: pantalla de estado.
  if (status !== 'ready') {
    $app.innerHTML = status === 'signed-out' ? viewAuth(screen === 'registro' ? 'registro' : 'login') : viewStatus();
    $tabs.hidden = true;
    return;
  }
  if (authScreen) { location.replace('#/'); return; }
  // Viendo a un alumno: Social, Cuenta, etc. vuelven a tus datos; entrenar o editar sus entrenos no se puede
  if (viewing && !VIEW_OK.includes(screen)) {
    if (VIEW_EXIT.includes(screen)) exitViewing();
    else { notice(viewOnlyMsg()); history.back(); return; }
  }

  if (screen !== 'editar') editBuf = null;
  else if (!editBuf || editBuf.editOf !== arg) editBuf = makeEditBuf(arg);
  if (screen !== 'rutina') { altEdit = null; editReturn = false; }
  if (screen !== 'sesion' || arg !== justFinished) justFinished = null;
  if (screen !== 'rutina' && screen !== 'dieta' && screen !== 'miprograma') shareResult = null;
  if (screen !== 'chat') { attach = null; editingMsg = null; selectedMsg = null; }
  if (screen !== 'agua') waterEditing = null;
  if (screen !== 'peso') goalEditing = false;
  if (screen !== 'rutina') openEx = null;
  if (screen !== 'rutinas') routineSort = false;
  if (screen !== 'perfil' && photoEdit) { URL.revokeObjectURL(photoEdit.src); photoEdit = null; }
  if (screen !== 'perfil') photoView = false;
  if (screen !== 'fotos') { closeProgressNew(); progOpen = null; }
  const hadModal = !!guidePick || guideView != null || exploreOpen;
  if (screen !== 'entrenar' && screen !== 'editar') guideView = null;
  if (screen !== 'rutina') { exploreOpen = false; exploreView = null; }
  if (screen !== 'rutina' && screen !== 'entrenar' && screen !== 'editar') guidePick = null;
  if (hadModal && !guidePick && guideView == null && !exploreOpen) modalPushed = false;   // se cerró por salir de la pantalla
  if (screen !== 'nutricion') extraMode = null;
  if (screen !== 'chat' && screen !== 'perfil') closeMessages();   // el perfil muestra lo compartido en el chat

  let html, tab = null;
  switch (screen) {
    case 'rutina': html = viewRoutine(); break;
    case 'entrenar':
    case 'editar': html = viewWorkout(); break;
    case 'historial': html = viewHistory(); tab = 'historial'; break;
    case 'progreso':
      html = arg ? viewProgressExercise(decodeURIComponent(arg)) : viewProgress();
      tab = arg ? null : 'progreso';
      break;
    case 'sesion': html = viewSession(arg); break;
    case 'ejercicio': html = viewExercise(decodeURIComponent(arg)); break;
    case 'cuenta': html = viewAccount(); break;
    case 'agua': html = viewWater(); break;
    case 'rutinas': html = viewHome(); tab = 'rutinas'; break;
    case 'peso': html = viewBodyweight(); break;
    case 'sueno': html = viewSleep(); break;
    case 'objetivo': html = viewTarget(); break;
    case 'nutricion': html = viewNutrition(arg); break;
    case 'alimento': html = viewFoodForm(arg, routeParts()[2]); break;
    case 'dieta': html = viewDietEditor(arg); break;
    case 'social': html = viewSocial(); break;
    case 'alumnos': html = viewStudents(); break;
    case 'coach': html = viewMyCoach(); break;
    case 'asignar': html = viewAssign(); break;
    case 'checkin': html = viewCheckin(); break;
    case 'gymbro': html = viewAddGymbro(); break;
    case 'chat': html = viewChat(arg); break;
    case 'perfil': html = viewProfile(arg); break;
    case 'privacidad': html = viewPrivacy(); break;
    case 'plan': location.replace(activeProgram() ? `#/miprograma/${activeProgram().id}` : '#/programas'); return;   // antes: pantalla Mi plan
    case 'grasa': html = viewBodyFat(); break;
    case 'pliegues': html = viewSkinfolds(); break;
    case 'programas': html = viewPrograms(); tab = 'programas'; break;
    case 'ejercicios': location.replace('#/rutinas'); return;   // antes: pestaña Ejercicios (ahora está al editar una rutina)
    case 'miprograma': html = viewMyProgram(arg); break;
    case 'listos': html = viewReadyPrograms(); break;
    case 'programa': html = viewProgram(arg); break;
    case 'medidas': html = viewMeasures(); break;
    case 'fotos': html = viewProgressPhotos(); break;
    default: html = viewHub();   // Inicio: sin pestañas
  }
  const stepsLeft = $app.querySelector('.steps')?.scrollLeft;   // fila de ejercicios del entrenamiento
  const tip = viewing ? '' : tipHtml(screen, arg);
  if (tip) {
    let at = html.indexOf('</header>') + '</header>'.length;
    const tabsAt = html.indexOf('<div class="range" role="tablist">', at);
    if (tabsAt >= 0 && !html.slice(at, tabsAt).trim()) at = html.indexOf('</div>', tabsAt) + '</div>'.length;
    html = html.slice(0, at) + tip + html.slice(at);
  }
  if (!viewing && !['entrenar', 'editar', 'chat'].includes(screen)) maybeAskSleep();
  if (sleepAsk && !tourOpen && !viewing && !['entrenar', 'editar', 'chat'].includes(screen)) html += sleepModal();
  if (tourOpen) html += tourHtml();
  if (viewing && screen !== 'chat') html = viewBarHtml() + html;
  document.body.classList.toggle('viewing', !!viewing && screen !== 'chat');
  document.body.classList.toggle('viewing-chat', !!viewing && screen === 'chat');   // su chat: sin enviar tus rutinas o dietas
  $app.innerHTML = html;
  if (viewing && screen !== 'chat') document.body.style.setProperty('--viewbar', `${$app.querySelector('.view-bar').offsetHeight}px`);   // el título queda bajo la barra azul
  // Viendo a un alumno: fuera del editor de rutinas solo se mira (los buscadores sí funcionan)
  if (viewing && screen !== 'chat') povTexts();
  if (viewing && !['rutina', 'rutinas', 'miprograma', 'dieta', 'objetivo', 'chat'].includes(screen)) {
    $app.querySelectorAll('#app input, #app select, #app textarea').forEach(x => {
      if (x.type === 'search' || /(-search|-q)$/.test(x.dataset.bind || '') || x.closest('[data-form="coach-comment"]')) return;
      x.disabled = true;
    });
  }
  const steps = $app.querySelector('.steps');
  if (steps) {
    const chip = steps.querySelector('.step.on');
    if (stepsLeft != null) steps.scrollLeft = stepsLeft;
    else if (chip) steps.scrollLeft = chip.offsetLeft - (steps.clientWidth - chip.offsetWidth) / 2;
  }
  const NAV = {
    rutinas: 'entreno', rutina: 'entreno', programas: 'entreno', miprograma: 'entreno', listos: 'entreno', programa: 'entreno',
    historial: 'entreno', sesion: 'entreno', progreso: 'entreno', ejercicio: 'entreno',
    nutricion: 'nutricion', alimento: 'nutricion', dieta: 'nutricion', objetivo: 'nutricion',
    peso: 'cuerpo', grasa: 'cuerpo', pliegues: 'cuerpo', medidas: 'cuerpo', fotos: 'cuerpo',
    social: 'social', gymbro: 'social', perfil: 'social', privacidad: 'social', alumnos: 'social', coach: 'social', asignar: 'social',
  };
  tab = ['entrenar', 'editar', 'chat'].includes(screen) ? null : NAV[screen] || 'inicio';
  $tabs.hidden = !tab;
  $tabs.querySelectorAll('a').forEach(a => { a.classList.toggle('active', a.dataset.tab === tab); a.toggleAttribute('aria-current', a.dataset.tab === tab); });
  $tabs.querySelector('[data-tab="social"]').classList.toggle('dot', chats.some(isUnread));
  if (screen === 'progreso' && !arg && progressQuery) filterProgress();
  if (screen === 'nutricion' && arg === 'alimentos' && foodQuery) filterFoods();   // al volver, mantiene la búsqueda aplicada
  if (screen === 'gymbro') ensureInvite();
  if (screen === 'alumnos' && coachOn()) ensureCoachCode();
  if (screen === 'chat') scrollChatBottom();
  paintTimer();
  paintQuiz();
  // Animación de técnica (si la guía abierta tiene una)
  const anim = $app.querySelector('.guide-anim');
  if (anim) mountAnim(anim, anim.dataset.anim);
}

const go = hash => { location.hash = hash; };

// Al volver atrás, la pantalla queda donde la dejaste; al entrar a una pantalla nueva, parte arriba
const scrollPos = new Map(), visited = [location.hash];
window.addEventListener('scroll', () => scrollPos.set(visited[visited.length - 1], window.scrollY), { passive: true });
window.addEventListener('hashchange', () => {
  hideToast();
  const back = visited.length > 1 && visited[visited.length - 2] === location.hash;
  if (back) visited.pop(); else visited.push(location.hash);
  render();
  window.scrollTo(0, back ? scrollPos.get(location.hash) || 0 : 0);
});

// Pantalla "de arriba" de cada pantalla (para volver cuando no hay historial)
function parentRoute() {
  const [screen, arg] = routeParts();
  return {
    rutina: '#/rutinas', plan: '#/rutinas', editar: '#/historial', sesion: '#/historial',
    progreso: arg ? '#/progreso' : '#/', ejercicio: '#/progreso',
    listos: '#/programas', programa: '#/listos', miprograma: '#/programas',
    alimento: '#/nutricion/alimentos', dieta: '#/nutricion/dietas', objetivo: '#/nutricion/dietas',
    chat: '#/social', gymbro: '#/social', perfil: '#/social', privacidad: '#/perfil/yo', pliegues: '#/grasa',
  }[screen] || '#/';
}
// Volver atrás. Si no hay pantalla anterior (ej. la app se reabrió directo en el entrenamiento),
// va a la pantalla de arriba en vez de quedarse sin hacer nada.
function goBack() {
  const fallback = parentRoute();
  let moved = false;
  const onPop = () => { moved = true; };
  window.addEventListener('popstate', onPop, { once: true });
  history.back();
  setTimeout(() => {
    window.removeEventListener('popstate', onPop);
    if (!moved) location.replace(fallback);
  }, 350);
}

// Bienvenida: deslizar a la izquierda avanza, a la derecha vuelve
let tourTouch = null;
$app.addEventListener('touchstart', e => { tourTouch = e.target.closest('.tour') ? e.touches[0].clientX : null; }, { passive: true });
$app.addEventListener('touchend', e => {
  if (tourTouch == null || !tourOpen) return;
  const dx = e.changedTouches[0].clientX - tourTouch;
  tourTouch = null;
  if (Math.abs(dx) < 50) return;
  const next = Math.min(Math.max(tourStep + (dx < 0 ? 1 : -1), 0), TOUR.length - 1);
  if (next !== tourStep) { tourStep = next; render(); }
});

// Deslizar a la derecha = volver (lo mismo que la flecha ‹ de arriba).
// No cuenta si empiezas en una casilla, un gráfico, un video o una fila que se desliza de lado, ni con una ventana abierta
let swipe = null;
const $swipeHint = document.createElement('div');
$swipeHint.className = 'swipe-hint'; $swipeHint.textContent = '‹'; $swipeHint.setAttribute('aria-hidden', 'true');
document.body.appendChild($swipeHint);
const swipeBackBtn = () => $app.querySelector('header.bar [data-action="back"], header.bar a.home');
const scrollsX = el => {
  for (; el && el !== $app; el = el.parentElement) if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  return false;
};
const swipeHint = dx => { const k = Math.max(0, Math.min(1, (dx - 20) / 60)); $swipeHint.style.opacity = k; $swipeHint.style.transform = `translate(${-44 + 56 * k}px, -50%)`; };
document.addEventListener('touchstart', e => {
  swipe = null;
  if (e.touches.length !== 1 || tourOpen || document.querySelector('.modal-back') || !swipeBackBtn()) return;
  const t = e.target;
  if (!$app.contains(t) || t.closest('input, textarea, select, video, svg.chart, [contenteditable]') || scrollsX(t)) return;
  swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now(), hash: location.hash };
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!swipe) return;
  const dx = e.touches[0].clientX - swipe.x, dy = e.touches[0].clientY - swipe.y;
  if (Math.abs(dy) > 30 && Math.abs(dy) > dx) { swipe = null; swipeHint(0); return; }   // estás bajando o subiendo
  swipeHint(dx);
}, { passive: true });
document.addEventListener('touchend', e => {
  const sw = swipe; swipe = null; swipeHint(0);
  if (!sw || location.hash !== sw.hash) return;   // el teléfono ya volvió con su propio gesto
  const dx = e.changedTouches[0].clientX - sw.x, dy = e.changedTouches[0].clientY - sw.y;
  if (dx > 80 && Math.abs(dy) < dx * 0.5 && Date.now() - sw.at < 800) { const b = swipeBackBtn(); if (b) b.click(); }
});
document.addEventListener('touchcancel', () => { swipe = null; swipeHint(0); });

// ---------- Avisos y confirmaciones ----------
// Reemplazan a alert() y confirm() del navegador (que en el teléfono muestran "simondesol.github.io dice…").
// Van fuera de #app para que un render() no los borre. Uno a la vez: si llega otro, espera su turno.
const $dialog = document.createElement('div');
$dialog.className = 'dlg-wrap';
$dialog.hidden = true;
document.body.appendChild($dialog);
let dlgQueue = Promise.resolve();
function dialog(msg, { ok = 'Aceptar', cancel = null, danger = false } = {}) {
  const run = () => new Promise(resolve => {
    $dialog.innerHTML = `<div class="modal-back"></div>
      <section class="modal card dlg" role="alertdialog" aria-modal="true"><p class="dlg-msg"></p>
        <div class="dlg-btns">${cancel ? `<button class="btn" data-r="0">${esc(cancel)}</button>` : ''}<button class="btn ${danger ? 'dlg-danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>
      </section>`;
    $dialog.querySelector('.dlg-msg').textContent = msg;
    $dialog.hidden = false;
    const key = e => { if (e.key === 'Escape') done(false); };
    const done = r => { $dialog.hidden = true; $dialog.innerHTML = ''; $dialog.onclick = null; document.removeEventListener('keydown', key); resolve(r); };
    $dialog.onclick = e => {
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r === '1');
      else if (e.target.classList.contains('modal-back')) done(false);
    };
    document.addEventListener('keydown', key);
    $dialog.querySelector('[data-r="1"]').focus({ preventScroll: true });
  });
  const pr = dlgQueue.then(run);
  dlgQueue = pr.catch(() => {});
  return pr;
}
// Aviso con un solo botón (no hace falta esperarlo)
const notice = msg => dialog(msg);
// Pregunta Sí/No: el botón dice lo que va a pasar ("Eliminar", "Descartar"…); lo que borra va en rojo
function ask(msg, okLabel) {
  const m = /^¿(Eliminar|Borrar|Descartar|Quitar|Cerrar sesión|Agregar|Usar|Dejar de usar)/.exec(msg);
  const danger = !!m && /^(Eliminar|Borrar|Descartar|Quitar|Cerrar sesión)$/.test(m[1]);
  return dialog(msg, { ok: okLabel || (m ? m[1] : 'Aceptar'), cancel: 'Cancelar', danger });
}

// ---------- Aviso con "Deshacer" ----------
const $toast = document.createElement('div');
$toast.className = 'toast';
$toast.hidden = true;
document.body.appendChild($toast);
let undoFn = null, toastTimer = null;

function showUndo(text, fn) {
  undoFn = fn;
  $toast.innerHTML = `<span>${esc(text)}</span><button class="btn ghost" data-undo>Deshacer</button>`;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
// Borrar al tiro con "Deshacer": restore() lo deja como estaba. wait: si la pantalla cambia al borrar, el aviso sale después
function undoDel(text, restore, wait = 0) {
  const f = () => showUndo(text, () => { restore(); save(); render(); });
  if (wait) setTimeout(f, wait); else f();
}
// Aviso corto sin "Deshacer"
function showNote(text) {
  undoFn = null;
  $toast.innerHTML = `<span>${esc(text)}</span>`;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() {
  $toast.hidden = true;
  undoFn = null;
  clearTimeout(toastTimer);
}
$toast.addEventListener('click', e => {
  if (e.target.closest('[data-undo]') && undoFn) undoFn();
  hideToast();
});

// ---------- Entrenamiento ----------
// Firma de la rutina (para saber si la editaste con el entreno en curso)
const routineSig = r => { const t = stable(r.exercises); let h = 0; for (let k = 0; k < t.length; k++) h = (h * 31 + t.charCodeAt(k)) | 0; return String(h); };
const draftEx = (ex, last, rid) => ({
  exerciseId: ex.id, name: ex.name, unit: ex.unit, rest: ex.rest || 0, rir: !!ex.rir, ...planFields(ex),
  ...(last ? { ssNext: false } : {}),   // el último no se une con nada
  sets: prefillSets(lastFor(ex.id, db.workouts.length, rid), ex.rir, ex.goalSets, ex.dropset),
});
// Editaste la rutina del entreno en curso: el entreno toma los cambios sin perder lo que ya anotaste
function syncDraftRoutine() {
  const d = db.draft;
  if (!d || !d.routineId || d.free) return;
  const r = db.routines.find(x => x.id === d.routineId);
  if (!r) return;
  const sig = routineSig(r);
  if (d.rsig === sig) return;
  const first = d.rsig == null; d.rsig = sig;
  if (first) return;   // entreno empezado con la versión anterior de la app
  const used = s => typedSet(s) || (s.rir !== '' && s.rir != null);
  const posId = (d.exercises[d.pos || 0] || {}).exerciseId, timerId = d.timer ? (d.exercises[d.timer.i] || {}).exerciseId : null;
  const old = new Map(d.exercises.map(e => [e.swapOf || e.exerciseId, e])), lastK = r.exercises.length - 1;
  const out = r.exercises.map((ex0, k) => {
    const o = old.get(ex0.id), ap = o && o.swapOf ? altPlan(ex0, o.exerciseId) : null;
    const ex = ap ? { ...ap, ssNext: ex0.ssNext } : ex0, fresh = draftEx(ex, k === lastK, r.id);
    if (!o) return fresh;
    let sets = o.sets;
    if ((o.goalSets || 0) !== (ex.goalSets || 0) && ex.goalSets) {   // cambió el número de series
      sets = [...sets];
      while (sets.length < ex.goalSets) sets.push(fresh.sets[sets.length] || nextSet(sets, ex.rir));
      while (sets.length > ex.goalSets && !used(sets[sets.length - 1])) sets.pop();
    }
    if (ex.rir && !o.rir) sets = sets.map(x => ({ rir: '', ...x }));
    const { sets: _, ...plan } = fresh;
    const keep = o.swapOf ? { exerciseId: o.exerciseId, name: o.name, unit: o.unit, swapOf: o.swapOf, ...(o.guide ? { guide: o.guide } : {}) } : {};
    return { ...plan, ...keep, sets };
  });
  // Los que sacaste de la rutina: se quedan si ya anotaste algo (o si los agregaste mientras entrenabas)
  d.exercises.forEach((e, k) => {
    if (r.exercises.some(x => x.id === (e.swapOf || e.exerciseId)) || !(e.extra || touchedEx(e))) return;
    out.splice(Math.min(k, out.length), 0, { ...e, extra: true, ssNext: false });
  });
  d.exercises = out;
  const at = id => out.findIndex(e => e.exerciseId === id);
  d.pos = Math.max(0, Math.min(posId != null && at(posId) >= 0 ? at(posId) : d.pos || 0, out.length - 1));
  if (d.timer) { const t = timerId != null ? at(timerId) : -1; if (t >= 0) d.timer.i = t; else d.timer = null; }
}
function startWorkout(r) {
  db.draft = {
    routineId: r.id,
    routineName: r.name,
    start: new Date().toISOString(),
    timer: null,
    rsig: routineSig(r),
    exercises: r.exercises.map((ex, k) => draftEx(ex, k === r.exercises.length - 1, r.id)),
  };
  save();
  go('#/entrenar');
}

// Convierte las series escritas en números y quita las vacías
const touchedEx = ex => ex.sets.some(s => typedSet(s) || (s.rir !== '' && s.rir != null) || (s.drops || []).some(x => x.w !== '' || x.r !== ''));
const cleanExercises = d => d.exercises
  .filter(touchedEx)   // si no anotaste nada en un ejercicio, no se guarda (ni siquiera lo de la vez pasada)
  .map(ex => ({
    exerciseId: ex.exerciseId,
    name: ex.name,
    unit: ex.unit,
    ...(ex.rir ? { rir: true } : {}),
    ...(ex.bw ? { bw: true } : {}),
    ...(ex.guide && ex.guide !== 'none' ? { guide: ex.guide } : {}),   // su técnica: así se reconoce aunque lo saques de la rutina
    sets: ex.sets
      .filter(s => { const e = bwEff(s, lastreEx(ex)); return lastreEx(ex) ? e.r !== '' : e.w !== '' || e.r !== ''; })
      .map(s => {
        const e = bwEff(s, lastreEx(ex));
        const set = { w: num(e.w), r: num(e.r) }; const rir = num(e.rir); if (ex.rir && rir != null) set.rir = rir;
        const drops = (s.drops || []).map(effSet).map(x => ({ w: num(x.w), r: num(x.r) })).filter(x => x.w != null || x.r != null);
        if (drops.length) set.drops = drops;   // bajadas del dropset
        return set;
      })
      .filter(s => s.w != null || s.r != null),
  }))
  .filter(ex => ex.sets.length);

function finishWorkout() {
  const d = db.draft;
  const exercises = cleanExercises(d);
  if (!exercises.length) { notice('No hay series anotadas todavía.'); return; }
  setTimer(null);
  const id = uid();
  const durationSec = Math.max(0, Math.round((Date.now() - new Date(d.start).getTime()) / 1000));
  const w = { id, routineId: d.routineId, routineName: d.routineName, date: d.start, durationSec, exercises, ...(d.free ? { free: true } : {}) };
  db.workouts.push(w);
  db.draft = null;
  save();
  announcePRs(w);
  justFinished = id;
  location.replace('#/sesion/' + id);
}

// Entreno libre → rutina: mismos ejercicios (mismo historial) y sus series como objetivo
function saveFreeAsRoutine(id, title) {
  const w = db.workouts.find(x => x.id === id);
  if (!w) return;
  const rests = new Map();
  for (const r of db.routines) for (const ex of r.exercises) if (ex.rest && !rests.has(ex.id)) rests.set(ex.id, ex.rest);
  const r = {
    id: uid(), name: uniqueRoutineName(title),
    exercises: w.exercises.map(ex => ({
      id: ex.exerciseId, name: ex.name, unit: ex.unit, rest: rests.get(ex.exerciseId) || FREE_REST, goalSets: ex.sets.length,
      ...(ex.rir ? { rir: true } : {}), ...(ex.bw ? { bw: true } : {}),
    })),
  };
  const before = { routineId: w.routineId, routineName: w.routineName };
  db.routines.push(r);
  w.routineId = r.id;
  w.routineName = r.name;
  save();
  go('#/rutinas');
  setTimeout(() => showUndo(`Rutina "${r.name}" guardada`, () => {
    db.routines = db.routines.filter(x => x !== r);
    Object.assign(w, before);
    save(); render();
  }), 100);
}

function makeEditBuf(id) {
  const w = db.workouts.find(x => x.id === id);
  if (!w) return null;
  return {
    editOf: w.id,
    routineId: w.routineId,
    routineName: w.routineName,
    start: w.date,
    exercises: w.exercises.map(ex => ({
      exerciseId: ex.exerciseId, name: ex.name, unit: ex.unit, rest: 0,
      rir: !!ex.rir, ...(ex.bw ? { bw: true } : {}), ...(ex.guide ? { guide: ex.guide } : {}),
      sets: ex.sets.map(s => ({
        w: toField(s.w), r: toField(s.r), ...(ex.rir ? { rir: toField(s.rir) } : {}),
        ...(s.drops ? { drops: s.drops.map(x => ({ w: toField(x.w), r: toField(x.r) })) } : {}),
      })),
    })),
  };
}

function saveEdit() {
  const w = db.workouts.find(x => x.id === editBuf.editOf);
  const exercises = cleanExercises(editBuf);
  if (!exercises.length) { notice('El entrenamiento quedó sin series. Si quieres borrarlo, usa "Eliminar este entrenamiento".'); return; }
  w.exercises = exercises;
  save();
  goBack();
}

// Ejercicio nuevo en una rutina: si ya lo tienes en otra (mismo nombre), es el mismo (historial y progreso juntos).
// Repetido en esta misma rutina ("Agregar igual"): uno aparte. Si lo tienes con OTRO nombre y la misma técnica (y con
// historial), pregunta si es el mismo: "Abs colgado" → "Elevación de piernas colgado" sigue con su historial
async function exIdForAdd(name, r, gid = null) {
  if (!r.exercises.some(e => sameName(e.name, name)) && findExercise(name)) return findExercise(name).id;
  const g = gid ? GUIDE_BY_ID.get(gid) : guideFor(name);
  const cand = g && (myGuideMap().get(g.id) || []).find(c => c.hist && !sameName(c.name, name) && !r.exercises.some(e => e.id === c.id));
  if (cand && await dialog(`Ya tienes "${cand.name}" con esta misma técnica. ¿Es el mismo ejercicio?

Si es el mismo, sigue con su historial.`, { ok: 'Sí, es el mismo', cancel: 'No, es otro' })) return cand.id;
  return uid();
}
// Busca un ejercicio que ya exista con ese nombre (en rutinas o historial) para mantener su historial
function findExercise(name) {
  for (const r of db.routines) {
    const ex = r.exercises.find(e => sameName(e.name, name));
    if (ex) return { id: ex.id, name: ex.name, unit: ex.unit, rest: ex.rest || 0, rir: !!ex.rir };
  }
  for (let i = db.workouts.length - 1; i >= 0; i--) {
    const ex = db.workouts[i].exercises.find(e => sameName(e.name, name));
    if (ex) return { id: ex.exerciseId, name: ex.name, unit: ex.unit, rest: 0, rir: !!ex.rir };
  }
  return null;
}

function addExtraExercise(name, unit) {
  const d = cur();
  const found = findExercise(name);
  const id = found ? found.id : uid();
  if (d.exercises.some(e => e.exerciseId === id)) { notice(`"${name}" ya está en este entrenamiento.`); return; }
  const before = beforeIndex(d);
  d.exercises.push({
    exerciseId: id,
    name: found ? found.name : name,
    unit: found ? found.unit : unit,
    rest: found ? found.rest : 0,
    rir: found ? found.rir : false,
    extra: true,   // agregado mientras entrenabas: se puede quitar
    sets: prefillSets(lastFor(id, before), found && found.rir),
  });
  d.pos = d.exercises.length - 1;
  save(); render();
  $app.querySelector(`[data-ex="${d.exercises.length - 1}"]`).scrollIntoView({ block: 'center' });
}

// ---------- Cronómetro de descanso ----------
let wakeLock = null;
async function keepScreenOn(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) { /* el navegador no lo permite; no pasa nada */ }
}

function setTimer(t) {
  if (db.draft) { db.draft.timer = t; save(); }
  keepScreenOn(!!t);
  if (!t) quizCur = null;   // terminó el descanso: se va la pregunta
  paintTimer();
  paintQuiz();
}

// ---------- Mis programas (creados por ti: tus rutinas ordenadas por día) ----------
// db.programs = [{ id, name, weeks: 1–4, days: [{ r: [id de rutina o null ×7] }], from?: quién te lo envió }]
// Se pueden usar como tu plan, enviar por el chat o compartir con código. Al recibir uno, sus rutinas quedan
// marcadas con prog = id del programa: si te mandan una versión nueva, reemplaza a la anterior (el historial se mantiene).
const myProgDays = days => (days[0] ? days[0].r.filter(Boolean).length : 0);
const myWeekLine = p => (p.days[0] ? p.days[0].r : []).map((id, d) => {
  const r = id && db.routines.find(x => x.id === id);
  return r ? `${DAY_SHORT[d]} ${r.name || '(sin nombre)'}` : null;
}).filter(Boolean).join(' · ');
const uniqueRoutineName = name => { let n = name || 'Rutina'; for (let k = 2; db.routines.some(r => sameName(r.name, n)); k++) n = `${name} ${k}`; return n; };

// Lo que viaja al compartir: las rutinas (sin pesos ni historial) y en qué día va cada una (por posición)
function programPayload(p) {
  const days = p.days.slice(0, p.weeks);
  const ids = [...new Set(days.flatMap(w => w.r).filter(id => id && db.routines.some(r => r.id === id && r.exercises.length)))];
  return {
    pid: p.id, name: p.name || 'Programa', weeks: days.length,
    routines: ids.map(id => routinePayload(db.routines.find(r => r.id === id))),
    days: days.map(w => ({ r: w.r.map(id => { const k = ids.indexOf(id); return k >= 0 ? k : null; }) })),
  };
}
const payloadWeekLine = pr => ((pr.days[0] || {}).r || []).map((k, d) => (k != null && pr.routines[k] ? `${DAY_SHORT[d]} ${pr.routines[k].name}` : null)).filter(Boolean).join(' · ');
const payloadDays = pr => ((pr.days[0] || {}).r || []).filter(k => k != null).length;

// Programa recibido (por chat o código): agrega sus rutinas y queda en Mis programas.
// Si ya tenías una versión anterior, se reemplaza (y si era tu programa activo, sigue activo con los cambios).
async function useSharedProgram(pr, from) {
  if (!pr || !Array.isArray(pr.routines) || !Array.isArray(pr.days) || !pr.routines.length) { notice('Este programa no trae rutinas.'); return; }
  const prev = db.routines.filter(r => r.prog && r.prog === pr.pid);
  if ((prev.length || db.programs.some(p => p.id === pr.pid))
    && !await ask(`Ya tienes "${pr.name}" en Mis programas. ¿Reemplazarlo por esta versión${from ? ` de ${from}` : ''}?\n\nTu historial se mantiene.`)) return;
  const before = { routines: clone(db.routines), plan: db.plan ? clone(db.plan) : null, programs: clone(db.programs) };
  const oldEx = new Map();
  for (const r of prev) for (const ex of r.exercises) oldEx.set(guideKey(ex.name), ex);
  db.routines = db.routines.filter(r => !(r.prog && r.prog === pr.pid));
  const ids = pr.routines.map(rt => {
    const used = new Set();
    const r = {
      id: uid(), name: uniqueRoutineName(rt.name), prog: pr.pid,
      exercises: (rt.exercises || []).map(ex => {
        const old = oldEx.get(guideKey(ex.name));
        const found = old ? { id: old.id, name: old.name, unit: old.unit } : findExercise(ex.name);
        const mine = found && !used.has(found.id) ? found : null;
        if (mine) used.add(mine.id);
        return { id: mine ? mine.id : uid(), name: mine ? mine.name : ex.name, unit: mine ? mine.unit : ex.unit, rest: ex.rest || 0, rir: !!ex.rir, ...planFields(ex) };
      }),
    };
    db.routines.push(r);
    return r.id;
  });
  const days = pr.days.slice(0, 4).map(w => ({ r: Array.from({ length: 7 }, (_, d) => { const k = (w.r || [])[d]; return k == null ? null : ids[k] || null; }) }));
  const prog = { id: pr.pid, name: pr.name, weeks: days.length || 1, days: days.length ? days : [{ r: Array(7).fill(null) }], ...(from ? { from } : {}) };
  db.programs = db.programs.filter(p => p.id !== pr.pid);
  db.programs.push(prog);
  planFromProgram(prog);   // si era tu programa activo, tu semana se actualiza
  save();
  go('#/miprograma/' + prog.id);
  // Después de cambiar de pantalla (al cambiar de pantalla se esconden los avisos)
  setTimeout(() => showUndo(prev.length ? `"${pr.name}" actualizado` : `Añadido a Mis programas con ${plural(ids.length, 'rutina')}`, () => {
    db.routines = before.routines; db.plan = before.plan; db.programs = before.programs;
    save();
    history.back();
  }), 100);
}

// El programa activo ES tu plan: db.plan.prog = id del programa. Lo que cambias en uno se ve en el otro.
const activeProgram = () => (db.plan && db.plan.prog && db.programs.find(p => p.id === db.plan.prog)) || null;
const planIsLoose = () => !!(db.plan && !activeProgram() && db.plan.days.some(w => w.r.some(Boolean)));   // plan sin programa guardado
const validDays = days => days.map(w => ({ r: w.r.map(id => (id && db.routines.some(r => r.id === id) ? id : null)) }));
function activateProgram(p) {
  const start = db.plan && db.plan.start ? db.plan.start : dayKeyOf(mondayOf(new Date()));
  db.plan = { weeks: p.weeks, start, days: validDays(clone(p.days)), prog: p.id };
}
// Cambiaste el programa activo: tu plan se actualiza
function planFromProgram(p) {
  if (!db.plan || db.plan.prog !== p.id) return;
  db.plan.weeks = p.weeks;
  db.plan.days = validDays(clone(p.days));
}
const nextProgramName = () => { let n = db.programs.length + 1; while (db.programs.some(p => sameName(p.name, `Programa ${n}`))) n++; return `Programa ${n}`; };
// Quien ya tenía su plan armado (antes de existir los programas): se guarda solo como programa activo
// Una alternativa elegida de la lista (se llama igual que la guía) que quedó separada de tu ejercicio con esa misma
// técnica ("Prensa de piernas" nuevo, cuando ya tenías "Prensa"): pasa a ser tu ejercicio y sus series se juntan con su historial
function relinkGuideAlts() {
  let changed = false;
  for (const r of db.routines) for (const ex of r.exercises) for (const a of ex.alts || []) {
    const g = a.guide && GUIDE_BY_ID.get(a.guide);
    if (!g || a.name !== g.name) continue;   // las creadas a mano ("Pec deck · máquina 2") quedan aparte a propósito
    const mine = (myGuideMap().get(g.id) || []).find(c => c.id !== a.id && c.hist && unitKind(c.unit) === unitKind(a.unit));
    if (!mine || mine.id === ex.id || ex.alts.some(x => x.id === mine.id)) continue;
    const from = a.id;
    Object.assign(a, { id: mine.id, name: mine.name, unit: mine.unit });
    for (const w of db.workouts) {
      if (w.exercises.some(e => e.exerciseId === mine.id)) continue;   // ese día hiciste los dos: quedan separados
      for (const e of w.exercises) if (e.exerciseId === from) { e.exerciseId = mine.id; e.name = mine.name; }
    }
    if (db.draft) for (const e of db.draft.exercises) if (e.exerciseId === from) { e.exerciseId = mine.id; e.name = mine.name; }
    changed = true;
  }
  return changed;
}
// Mismo nombre en distintas rutinas (o en tu historial) con ids distintos: pasan a ser uno (el con más sesiones).
// No se juntan: dos iguales dentro de una misma rutina, ni dos iguales dentro de un mismo entreno.
function unifyExerciseIds() {
  const key = n => normText(String(n || '').trim()), groups = new Map(), inGroups = new Map();
  const note = (name, id, n) => {
    const k = key(name);
    if (!k || !id) return;
    const g = groups.get(k) || new Map(); g.set(id, (g.get(id) || 0) + n); groups.set(k, g);
    (inGroups.get(id) || inGroups.set(id, new Set()).get(id)).add(k);
  };
  for (const r of db.routines) for (const e of r.exercises) note(e.name, e.id, 0);
  for (const w of db.workouts) for (const e of w.exercises) note(e.name, e.exerciseId, 1);
  const to = new Map();
  for (const g of groups.values()) {
    if (g.size < 2) continue;
    const ids = [...g.keys()].filter(id => inGroups.get(id).size === 1);   // uno renombrado (aparece con 2 nombres) queda como está
    if (ids.length < 2) continue;
    const keep = ids.reduce((a, b) => (g.get(b) > g.get(a) ? b : a));
    for (const id of ids) if (id !== keep) to.set(id, keep);
  }
  // Dos de ellos en la misma rutina: ese nombre no se junta
  for (const r of db.routines) {
    const seen = new Map();
    for (const e of r.exercises) {
      const t = to.get(e.id) || e.id;
      if (seen.has(t) && seen.get(t) !== e.id) for (const [a, b] of [...to]) if (b === t) to.delete(a);
      seen.set(t, e.id);
    }
  }
  if (!to.size) return false;
  const m = id => to.get(id) || id;
  for (const r of db.routines) for (const e of r.exercises) {
    e.id = m(e.id);
    if (e.alts) { e.alts = e.alts.filter((a, k, all) => (a.id = m(a.id)) !== e.id && all.findIndex(x => m(x.id) === a.id) === k); if (!e.alts.length) delete e.alts; }
  }
  const remap = list => { const ids = list.map(e => m(e.exerciseId)); list.forEach((e, k) => { if (ids.indexOf(ids[k]) === ids.lastIndexOf(ids[k])) e.exerciseId = ids[k]; }); };
  for (const w of db.workouts) remap(w.exercises);
  if (db.draft) { remap(db.draft.exercises); for (const e of db.draft.exercises) if (e.swapOf) e.swapOf = m(e.swapOf); }
  for (const [a, b] of to) { if (db.notes[a] && !db.notes[b]) db.notes[b] = db.notes[a]; delete db.notes[a]; }
  if (db.body.prPick) db.body.prPick = [...new Set(db.body.prPick.map(m))];
  return true;
}
// Ejercicios con el nombre antiguo de una guía que cambiamos de nombre: pasan al nombre nuevo (mismo ejercicio, mismo
// historial). Así al agregarlo de nuevo desde la lista se reconoce como el mismo
const OLD_GUIDE_NAMES = { 'press declinado': 'press-declinado', 'escaladores': 'escaladores', 'curl bayesiano en polea': 'curl-bayesiano',
  'sentadilla bulgara': 'sentadilla-bulgara', 'zancada hacia atras': 'zancada-inversa', 'zancada estatica (split squat)': 'split-squat',
  'zancadas': 'zancadas', 'jalon a una mano en polea': 'jalon-unilateral', 'press frances': 'press-frances',
  'curl invertido': 'curl-invertido', 'extension de triceps sobre la cabeza con barra': 'triceps-sobre-cabeza-barra', 'peso muerto desde soportes': 'rack-pull', 'sissy squat': 'sissy-squat' };
function renameOldGuideNames() {
  let changed = false;
  const fix = e => {
    const gid = OLD_GUIDE_NAMES[normText(String(e.name || '').trim())];
    if (!gid || (e.guide && e.guide !== gid)) return;
    e.name = GUIDE_BY_ID.get(gid).name; changed = true;
  };
  for (const r of db.routines) for (const e of r.exercises) { fix(e); (e.alts || []).forEach(fix); }
  for (const w of db.workouts) w.exercises.forEach(fix);
  if (db.draft) db.draft.exercises.forEach(fix);
  return changed;
}
// Le cambiaste el nombre a un ejercicio de tu rutina ("Dips" → "Fondos en paralelas"): su historial pasa a llamarse igual,
// así lo encuentras con el nombre nuevo en Historial y Progreso. Si el mismo ejercicio tiene nombres distintos en dos
// rutinas, no se toca
// Ejercicios de tus rutinas cuyo nombre no es el de su guía de técnica ("Laterales mancuerna" → Elevaciones laterales).
// No se tocan las alternativas ni los que chocarían con otro ejercicio tuyo que ya se llama así (ej. "Pec deck · máquina 2")
function guideRenames() {
  const taken = new Map();   // nombre → ids que ya lo usan
  const note = (id, n) => { const k = normText(String(n || '').trim()); (taken.get(k) || taken.set(k, new Set()).get(k)).add(id); };
  for (const r of db.routines) for (const e of r.exercises) { note(e.id, e.name); for (const a of e.alts || []) note(a.id, a.name); }
  const out = [];
  for (const r of db.routines) for (const e of r.exercises) {
    if (e.guide === 'none') continue;
    const g = guideFor(e.name, e.guide);
    if (!g || normText(e.name.trim()) === normText(g.name)) continue;
    const users = taken.get(normText(g.name));
    if (users && [...users].some(id => id !== e.id)) continue;
    out.push({ e, to: g.name, gid: g.id });
  }
  return out;
}
function syncHistoryNames() {
  const name = new Map(), clash = new Set();
  const note = (id, n) => { n = String(n || '').trim(); if (!n) return; if (name.has(id) && name.get(id) !== n) clash.add(id); else name.set(id, n); };
  for (const r of db.routines) for (const e of r.exercises) { note(e.id, e.name); for (const a of e.alts || []) note(a.id, a.name); }
  let changed = false;
  for (const w of db.workouts) for (const e of w.exercises) {
    const n = name.get(e.exerciseId);
    if (n && !clash.has(e.exerciseId) && e.name !== n) { e.name = n; changed = true; }
  }
  return changed;
}
function backfillWorkoutGuides() {
  const guide = new Map();
  for (const r of db.routines) for (const e of r.exercises) {
    if (e.guide && e.guide !== 'none') guide.set(e.id, e.guide);
    for (const a of e.alts || []) if (a.guide) guide.set(a.id, a.guide);
  }
  let changed = false;
  for (const w of db.workouts) for (const e of w.exercises) if (!e.guide && guide.has(e.exerciseId)) { e.guide = guide.get(e.exerciseId); changed = true; }
  return changed;
}
function migrateLoosePlan() {
  if (!planIsLoose()) return;
  let name = 'Mi programa';
  for (let n = 2; db.programs.some(x => sameName(x.name, name)); n++) name = `Mi programa ${n}`;
  const p = { id: uid(), name, weeks: db.plan.weeks, days: clone(db.plan.days) };
  db.programs.push(p);
  db.plan.prog = p.id;
  save();
}

// Uno tuyo: pasa a ser el activo (tu plan)
async function useMyProgram(p) {
  if (!myProgDays(p.days)) { notice('Elige al menos una rutina en algún día.'); return; }
  const act = activeProgram();
  if (!await ask(`¿Usar "${p.name || 'este programa'}" como tu programa activo?${act ? `\n\nDejarás de usar "${act.name || 'tu programa actual'}" (no se borra, sigue en Mis programas).` : ''}`)) return;
  const before = db.plan ? clone(db.plan) : null;
  activateProgram(p);
  save(); render();
  showUndo(`"${p.name || 'Programa'}" es tu programa activo`, () => { db.plan = before; save(); render(); });
}

function checkSendable(p) {
  const pr = programPayload(p);
  if (!pr.routines.length) { notice('El programa no tiene rutinas con ejercicios. Elige qué rutina va cada día.'); return null; }
  return pr;
}

function viewMyProgram(id) {
  const p = db.programs.find(x => x.id === id);
  if (!p) { location.replace('#/programas'); return ''; }
  const options = sel => `<option value="">Descanso</option>${db.routines.map(r =>
    `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name || '(sin nombre)')}</option>`).join('')}`;
  const weeks = p.days.slice(0, p.weeks).map((wk, w) => `
    <h2>${p.weeks > 1 ? `Semana ${w + 1}` : 'Días'}</h2>
    <section class="card plan-week">${DAY_NAMES.map((name, d) => `
      <label class="plan-row"><span>${name}</span>
        <select data-bind="myprog-day" data-w="${w}" data-d="${d}" aria-label="${name}">${options(wk.r[d])}</select>
      </label>`).join('')}
    </section>`).join('');
  const active = activeProgram() === p;
  return `${header('Programa', { back: true, sub: `${plural(myProgDays(p.days), 'día')} por semana` })}
    ${active
      ? `<section class="card active-prog"><strong>Programa activo</strong><span class="muted small">Es el que estás usando: lo que cambies aquí se aplica a tu semana.</span>
          <button class="link small" data-action="myprog-stop" style="justify-self:start">Dejar de usar</button></section>`
      : '<button class="btn primary block" data-action="myprog-use" style="margin:0 0 14px">Usar este programa</button>'}
    ${p.from ? `<p class="muted small" style="margin:0 0 8px">Te lo envió ${esc(p.from)}</p>` : ''}
    <label class="field"><span>Nombre del programa</span>
      <input data-bind="myprog-name" value="${esc(p.name)}" placeholder="ej. Programa Juan" autocomplete="off"></label>
    <section class="card stack">
      <div class="pace-sentence">
        <span>Se repite cada</span>
        <button class="btn pace-dir plan-n" data-action="myprog-weeks" data-v="${(p.weeks % 4) + 1}" aria-label="Cambiar cada cuántas semanas se repite">${p.weeks}</button>
        <span>${p.weeks === 1 ? 'semana' : 'semanas'}</span>
      </div>
      <span class="muted small">Toca el número para cambiarlo (de 1 a 4).</span>
    </section>
    ${db.routines.length ? weeks : '<p class="empty">Primero crea tus rutinas en la pestaña Rutinas; después eliges qué día va cada una.</p>'}
    ${(v => volumeHtml(v.planned, v.missing))(myProgVolume(p))}
    <p class="muted small" style="margin:14px 0 0">Para enviárselo a un alumno o gymbro, en su chat toca ＋ → Enviar un programa.</p>
    <button class="btn ghost block danger-text" data-action="myprog-del" style="margin-top:20px">Eliminar programa</button>`;
}

// ---------- Series por músculo a la semana (en los programas) ----------
// Cada ejercicio suma sus series objetivo a su músculo principal (el de su guía de técnica)
const VOL_RANGE = [6, 15];   // series por semana por músculo: lo típico para hipertrofia
const VOL_MAX = 20;          // tope de la barra
const zoneOfEx = (name, guide) => { const g = guideFor(name, guide); return g ? g.zone : ''; };
const addTo = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
// Lo que planifica uno de tus programas (si se repite cada 2+ semanas, el promedio por semana)
function myProgVolume(p) {
  const planned = new Map(); let missing = 0;
  for (const wk of p.days.slice(0, p.weeks)) for (const rid of wk.r) {
    const r = rid && db.routines.find(x => x.id === rid);
    for (const e of r ? r.exercises : []) { if (e.goalSets) addTo(planned, zoneOfEx(e.name, e.guide), e.goalSets / p.weeks); else missing++; }
  }
  return { planned, missing };
}
function volumeHtml(planned, missing = 0) {
  const zones = [...Object.keys(GUIDE_ZONES), ''].filter(z => planned.get(z));
  if (!zones.length) return '';
  const pct = n => `${Math.min(100, (n / VOL_MAX) * 100)}%`;
  const rows = zones.map(z => {
    const pl = round1(planned.get(z) || 0);
    const cls = !z ? 'none' : pl < VOL_RANGE[0] ? 'low' : pl > VOL_RANGE[1] ? 'high' : 'ok';
    return `<div class="vol-row ${cls}"><span class="vol-name">${z ? GUIDE_ZONES[z] : 'Sin músculo'}</span>
      <span class="vol-bar"><i class="pl" style="width:${pct(pl)}"></i></span>
      <span class="vol-n">${fmtNum(pl)}</span></div>`;
  }).join('');
  return `<h2>Series por semana</h2>
    <section class="card vol-card">
      ${rows}
      <p class="muted small" style="margin:6px 0 0"><span class="vol-key ok">Verde</span>: entre ${VOL_RANGE[0]} y ${VOL_RANGE[1]} series por semana, lo típico para hipertrofia (la franja de la barra). Gris: menos. <span class="vol-key high">Amarillo</span>: más.
        Cuenta el músculo principal de cada ejercicio.${planned.get('') ? ' "Sin músculo": ejercicios sin guía de técnica (elígela en Editar rutina).' : ''}${missing ? ` ${plural(missing, 'ejercicio')} sin series objetivo no se ${missing === 1 ? 'cuenta' : 'cuentan'}.` : ''}</p>
    </section>`;
}

// ---------- Programas (rutinas listas + plan semanal) ----------
let progDays = 0;      // filtro por días a la semana (0 = todos)
let progLevel = 'p';   // Principiante o Intermedio
const BW_GUIDES = new Set(['dominadas', 'dominadas-supinas', 'fondos']);   // se anota el lastre
const DAY_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const progById = id => PROGRAMS.find(p => p.id === id);
const progKeys = lv => [...new Set(lv.week.filter(Boolean))];   // rutinas en el orden de la semana
const weekLine = lv => lv.week.map((k, d) => (k ? `${DAY_SHORT[d]} ${lv.routines[k].name}` : null)).filter(Boolean).join(' · ');
const levelToggle = () => `<div class="range" role="group" aria-label="Nivel">${Object.entries(LEVELS).map(([k, name]) =>
  `<button class="${k === progLevel ? 'on' : ''}" data-action="prog-level" data-l="${k}">${name}</button>`).join('')}</div>`;

function viewPrograms() {
  const act = activeProgram();
  const mine = db.programs.slice().sort((a, b) => (b === act) - (a === act)).map(p => `<a class="card prog-item ${p === act ? 'active-prog' : ''}" href="#/miprograma/${p.id}">
      <div class="grow"><strong>${esc(p.name || '(sin nombre)')}</strong>
        <span class="prog-badges">${p === act ? '<span class="badge on">Activo</span>' : ''}<span class="badge">${plural(myProgDays(p.days), 'día')}</span></span>
        ${p.from ? `<span class="muted small">De ${esc(p.from)}</span>` : ''}
        <span class="muted small prog-week">${esc(myWeekLine(p)) || 'Sin días todavía'}</span></div>
      <span class="chev">›</span></a>`).join('');
  return `${header('Entreno', {})}${entrenoTabs('programas')}
    <h2>Mis programas</h2>
    ${mine || '<p class="muted small" style="margin:0 0 8px">Arma un programa con tus rutinas para usarlo como tu plan o enviárselo a un gymbro.</p>'}
    <div class="prog-actions">
      <button class="btn" data-action="myprog-new">+ Crear programa</button>
      <a class="btn primary" href="#/listos">Programas listos</a>
    </div>`;
}

// Programas listos (hechos por un coach): se abren desde el botón en Programas
function viewReadyPrograms() {
  const list = PROGRAMS.filter(p => !progDays || p.days === progDays);
  const days = [...new Set(PROGRAMS.map(p => p.days))].sort((a, b) => a - b);
  return `${header('Programas listos', { back: true, sub: 'Hechos por un coach' })}
    <p class="muted" style="margin:0 0 12px">Elige tu nivel y cuántos días puedes entrenar. Añádelo a Mis programas para usarlo como tu plan, o cámbialo y envíaselo a un alumno.</p>
    ${levelToggle()}
    <div class="skin-views">${[0, ...days].map(n => `<button class="chip toggle ${n === progDays ? 'on' : ''}" data-action="prog-days" data-n="${n}">${n ? `${n} días` : 'Todos'}</button>`).join('')}</div>
    ${list.map(p => `<a class="card prog-item" href="#/programa/${p.id}">
      <div class="grow"><strong>${esc(p.name)}</strong><span class="badge on">${p.days} días</span>
        <span class="muted small">${esc(p.desc)}</span>
        <span class="muted small prog-week">${esc(weekLine(p.levels[progLevel]))}</span></div>
      <span class="chev">›</span></a>`).join('')}`;
}

function viewProgram(id) {
  const p = progById(id);
  if (!p) { location.replace('#/programas'); return ''; }
  const lv = p.levels[progLevel];
  const week = `<div class="prog-days">${lv.week.map((k, d) => `<div class="${k ? 'on' : ''}"><b>${DAY_SHORT[d]}</b><span>${k ? esc(lv.routines[k].name) : '–'}</span></div>`).join('')}</div>`;
  const routines = progKeys(lv).map(k => {
    const rt = lv.routines[k];
    return `<section class="card prog-routine">
      <div class="goal-top"><strong>${esc(rt.name)}</strong><span class="muted small">${plural(rt.ex.length, 'ejercicio')}</span></div>
      <ul class="prog-ex">${rt.ex.map(([gid, sets, reps, rir, rest]) => `<li><span>${esc(GUIDE_BY_ID.get(gid).name)}</span>
        <span class="muted small">${sets} × ${reps} · RIR ${rir} · ${fmtRest(rest)}</span></li>`).join('')}</ul>
      <button class="link small" data-action="prog-add-one" data-k="${k}">Agregar solo esta rutina</button>
    </section>`;
  }).join('');
  return `${header(p.name, { back: true, sub: `${p.days} días por semana` })}
    <p class="muted" style="margin:0 0 12px">${esc(p.desc)}</p>
    ${levelToggle()}
    ${week}
    <button class="btn primary block" data-action="prog-add" style="margin:0 0 16px">Añadir a mis programas</button>
    ${(() => { const planned = new Map();
      for (const k of lv.week) if (k) for (const [gid, sets] of lv.routines[k].ex) addTo(planned, GUIDE_BY_ID.get(gid).zone, sets);
      return volumeHtml(planned); })()}
    ${routines}
    <p class="muted small">Queda en Mis programas: desde ahí lo usas como tu plan, o lo cambias y se lo envías a un alumno. Cada ejercicio trae sus series, repeticiones, RIR, descanso y guía de técnica.</p>
    <button class="btn primary block" data-action="prog-add">Añadir a mis programas</button>`;
}

// Copia una rutina del programa a tus rutinas (si ya hiciste ese ejercicio, se usa el tuyo para mantener tu historial)
function routineFromProgram(rt) {
  const used = new Set();
  const taken = name => db.routines.some(r => sameName(r.name, name));
  let name = rt.name;
  for (let n = 2; taken(name); n++) name = `${rt.name} ${n}`;
  return {
    id: uid(), name,
    exercises: rt.ex.map(([gid, sets, reps, rir, rest]) => {
      const g = GUIDE_BY_ID.get(gid), found = findExercise(g.name), mine = found && !used.has(found.id) ? found : null;
      if (mine) used.add(mine.id);
      return { id: mine ? mine.id : uid(), name: mine ? mine.name : g.name, unit: mine ? mine.unit : 'kg', rest,
        rir: true, goalSets: sets, goalReps: reps, goalRir: rir, guide: gid, ...(BW_GUIDES.has(gid) ? { bw: true } : {}) };
    }),
  };
}

// Añade el programa listo a Mis programas (con sus rutinas), sin cambiar tu plan: lo puedes usar o
// tomarlo como base, cambiarlo y enviárselo a un alumno
function addReadyProgram(p) {
  const lv = p.levels[progLevel], keys = progKeys(lv), ids = {};
  for (const k of keys) { const r = routineFromProgram(lv.routines[k]); db.routines.push(r); ids[k] = r.id; }
  let name = `${p.name} ${p.days} días · ${LEVELS[progLevel]}`;
  for (let n = 2; db.programs.some(x => sameName(x.name, name)); n++) name = `${p.name} ${p.days} días · ${LEVELS[progLevel]} ${n}`;
  const prog = { id: uid(), name, weeks: 1, days: [{ r: lv.week.map(k => (k ? ids[k] : null)) }] };
  db.programs.push(prog);
  // Si no tienes un plan en uso, queda activo de una (así Inicio te dice qué toca hoy); si tienes uno, se pregunta
  const before = db.plan ? clone(db.plan) : null;
  const inUse = !!(db.plan && db.plan.days.some(w => w.r.some(Boolean)));
  if (!inUse) activateProgram(prog);
  save();
  go('#/miprograma/' + prog.id);
  const added = Object.values(ids);
  const undo = () => {
    db.routines = db.routines.filter(r => !added.includes(r.id));
    db.programs = db.programs.filter(x => x !== prog);
    db.plan = before;
    save();
    location.replace('#/listos');
  };
  // Después de cambiar de pantalla (al cambiar de pantalla se esconden los avisos)
  setTimeout(async () => {
    if (!inUse) { showUndo(`"${name}" añadido y activado: en Inicio verás qué toca cada día`, undo); return; }
    const act = activeProgram();
    if (await ask(`¿Empezar a usar "${name}" ahora?

Dejarás de usar "${(act && act.name) || 'tu programa actual'}" (no se borra, sigue en Mis programas).`, 'Usar este')) {
      activateProgram(prog); save(); render();
      showUndo(`"${name}" es tu programa activo`, undo);
    } else showUndo(`Añadido a Mis programas con ${plural(keys.length, 'rutina')}`, undo);
  }, 100);
}

// ---------- Guías de técnica ----------
// Cada ejercicio de la rutina puede tener su guía (ex.guide = id, o 'none' si elegiste "sin guía").
// Si no elegiste ninguna, se busca por el nombre (o sus alias: "Banca" → Press banca).
const GUIDE_BY_ID = new Map(GUIDES.map(g => [g.id, g]));
// Ejercicios de un músculo en orden alfabético (las variantes quedan junto a su ejercicio base)
const guidesOf = z => GUIDES.filter(g => g.zone === z).sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
const guideKey = s => normText(String(s || '')).replace(/[^a-z0-9ñ]+/g, ' ').trim();
let guideNames = null;
function guideByName(name) {
  if (!guideNames) {
    guideNames = new Map();
    for (const g of GUIDES) for (const n of [g.name, ...g.alias]) guideNames.set(guideKey(n), g);
  }
  return guideNames.get(guideKey(name)) || null;
}
const guideFor = (name, chosen) => (chosen === 'none' ? null : GUIDE_BY_ID.get(chosen) || guideByName(name));
// Búsqueda por palabras (sin tildes): "press incl" encuentra Press inclinado
function searchGuides(q, limit = 6) {
  const words = guideKey(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const g of GUIDES) {
    const texts = [g.name, ...g.alias].map(guideKey);
    const all = texts.join(' ').split(' ');
    if (!words.every(w => all.some(t => t.startsWith(w)))) continue;
    // Primero los que coinciden por el nombre principal; después los que coinciden solo por un alias
    const phrase = words.join(' '), nameWords = texts[0].split(' ');
    // Si escribiste justo el nombre o un sinónimo, ese va primero ("curl barra z" → Curl con barra Z)
    const score = texts.includes(phrase) ? -1 : texts[0].startsWith(phrase) ? 0 : words.every(w => nameWords.some(t => t.startsWith(w))) ? 1 : texts.some(t => t.startsWith(phrase)) ? 2 : 3;
    hits.push({ g, score });
  }
  // A igual puntaje, en orden alfabético (cada ejercicio queda junto a sus variantes, como en la lista por músculo)
  return hits.sort((a, b) => a.score - b.score || a.g.name.localeCompare(b.g.name, 'es')).slice(0, limit).map(h => h.g);
}

let guideView = null;   // índice del ejercicio (en el entrenamiento) cuya guía está abierta
let modalPushed = false;   // hay un paso extra en el historial para que "atrás" cierre la ventana
function syncModalHistory() {
  const open = !!guidePick || guideView != null || exploreOpen || !!swapPick;
  if (open && !modalPushed) { history.pushState({ modal: 1 }, ''); modalPushed = true; }
  else if (!open && modalPushed) { modalPushed = false; history.back(); }
}
window.addEventListener('popstate', () => {
  if (!modalPushed) return;
  modalPushed = false;
  if (guidePick || guideView != null || exploreOpen || swapPick) { guidePick = null; guideView = null; exploreOpen = false; exploreView = null; swapPick = null; render(); }
});
let guidePick = null;   // { rid, exId, q } elegir la guía de un ejercicio a mano
const zoneOf = ex => { const g = guideFor(ex.name, ex.guide); return g ? GUIDE_ZONES[g.zone] : ''; };

// Cambiar un ejercicio del entreno (máquina ocupada, otra variante…). Cada alternativa es otro ejercicio con su propio
// historial, así no se mezclan los pesos. La rutina las recuerda en ex.alts = [{ id, name, unit, guide }]
let swapPick = null;   // { i, always } ejercicio del entreno que vas a cambiar
const routineExOf = (d, dx) => { const r = d.routineId && !dx.extra && db.routines.find(x => x.id === d.routineId);
  return r ? r.exercises.find(e => e.id === (dx.swapOf || dx.exerciseId)) || null : null; };
const PLAN_KEYS = ['rest', 'rir', 'goalSets', 'goalReps', 'goalRepsBy', 'goalRir', 'goalRirBy', 'dropset', 'bw'];
const planOf = x => Object.fromEntries(PLAN_KEYS.filter(k => x[k] != null && x[k] !== false).map(k => [k, Array.isArray(x[k]) ? [...x[k]] : x[k]]));
const altOf = x => ({ id: x.id, name: x.name, unit: x.unit, ...(x.guide && x.guide !== 'none' ? { guide: x.guide } : {}), ...planOf(x), own: true });
// Configuración con la que se entrena una alternativa: la suya, o (alternativas antiguas) la del ejercicio de la rutina
const altPlan = (rex, id) => { const a = rex && (rex.alts || []).find(x => x.id === id); return a && a.own ? a : null; };
function swapSheetHtml() {
  const d = db.draft, dx = swapPick && d && d.exercises[swapPick.i];
  if (!dx) return '';
  const rex = routineExOf(d, dx);
  const g = guideFor(dx.name, dx.guide);
  const lastTxt = a => lastSetText(a.id);
  const alts = [...(rex && dx.swapOf ? [{ ...altOf(rex), orig: true }] : []), ...(rex ? rex.alts || [] : [])].filter(a => a.id !== dx.exerciseId);
  const others = swapOthers(dx, alts, rex, g, swapPick.q);
  const altRow = a => `<div class="swap-alt">
      <button type="button" class="food-pick" data-action="swap-to" data-id="${a.id}">
        <span class="grow"><strong>${a.orig ? 'Volver a ' : ''}${esc(a.name)}</strong><span class="muted small">${lastTxt(a)}</span></span><span class="chev">›</span></button>
      ${a.orig ? '' : `<button class="btn small-btn" data-action="swap-alt-edit" data-id="${a.id}" aria-label="Editar ${esc(a.name)}">Editar</button>
        <button class="icon small danger" data-action="swap-alt-del" data-id="${a.id}" aria-label="Quitar ${esc(a.name)} de tus alternativas">${TRASH_ICON}</button>`}</div>`;
  const always = !!(rex && swapPick.always);
  return `<div class="modal-wrap">
    <div class="modal-back" data-action="swap-close"></div>
    <section class="modal card guide-modal swap-modal" role="dialog" aria-modal="true" aria-label="Cambiar ejercicio">
      <div class="guide-head"><h2>Cambiar ${esc(dx.name)}</h2><button class="icon small" data-action="swap-close" aria-label="Cerrar">✕</button></div>
      ${rex ? `<div class="swap-mode" role="group" aria-label="Por cuánto tiempo">
        <button class="chip toggle ${always ? '' : 'on'}" data-action="swap-mode" data-v="0" aria-pressed="${!always}">Solo hoy</button>
        <button class="chip toggle ${always ? 'on' : ''}" data-action="swap-mode" data-v="1" aria-pressed="${always}">Siempre en la rutina</button></div>
        <p class="muted small" style="margin:0">${always ? 'Queda en tu rutina en vez de este.' : 'La próxima vez la rutina vuelve a este ejercicio.'} Cada uno guarda sus propios pesos.</p>` : ''}
      ${alts.length ? `<h3 class="guide-zone">Tus alternativas</h3><div class="guide-list">${alts.map(altRow).join('')}</div>` : ''}
      <form class="add-row" data-form="swap-new">
        <input name="title" placeholder="${esc(dx.name)} · máquina 2" autocomplete="off" required aria-label="Nombre de la alternativa">
        <button class="btn">Crear</button>
      </form>
      <p class="muted small" style="margin:0">Otra máquina o variante del mismo ejercicio: crea una alternativa con su propio historial.</p>
      <h3 class="guide-zone">${g ? `Otros de ${GUIDE_ZONES[g.zone]}` : 'Otros ejercicios'}</h3>
      <input data-bind="swap-q" value="${esc(swapPick.q || '')}" placeholder="Buscar cualquier ejercicio" autocomplete="off" aria-label="Buscar ejercicio">
      <div class="guide-list swap-others">${swapOthersHtml(others, swapPick.q)}</div>
      <button class="btn block" data-action="swap-close">Cancelar</button>
    </section>
  </div>`;
}
// Tus ejercicios agrupados por su guía de técnica (rutinas, sus alternativas e historial), para no crear uno nuevo
// cuando ya lo tienes con otro nombre. Cada guía → [{ id, name, unit, hist }] (primero los de tus rutinas)
function myGuideMap() {
  const hist = new Set(db.workouts.flatMap(w => w.exercises.map(e => e.exerciseId)));
  const map = new Map(), seen = new Set();
  const add = (id, name, unit, guide) => {
    if (seen.has(id)) return;
    seen.add(id);
    const g = guideFor(name, guide);
    if (!g) return;
    if (!map.has(g.id)) map.set(g.id, []);
    map.get(g.id).push({ id, name, unit, hist: hist.has(id) });
  };
  for (const r of db.routines) for (const e of r.exercises) { add(e.id, e.name, e.unit, e.guide); for (const a of e.alts || []) add(a.id, a.name, a.unit, a.guide); }
  for (let k = db.workouts.length - 1; k >= 0; k--) for (const e of db.workouts[k].exercises) add(e.exerciseId, e.name, e.unit, e.guide);
  return map;
}
const mineFor = (map, gid) => { const l = map.get(gid) || []; return l.find(c => c.hist) || l[0] || null; };
const lastSetText = id => { const pv = lastFor(id); const st = pv && pv.ex.sets[0];
  return st ? `Última vez ${fmtNum(st.w)} ${pv.ex.unit} × ${fmtNum(st.r)}` : 'Sin historial todavía'; };
// Otros ejercicios: los del mismo músculo, o al buscar, cualquiera por su nombre (con tu nombre si ya lo tienes)
function swapOthers(dx, alts, rex, g, q) {
  const map = myGuideMap(), taken = new Set([dx.exerciseId, ...(rex ? [rex.id] : []), ...alts.map(a => a.id)]);
  const skip = x => sameName(x.name, dx.name) || alts.some(a => sameName(a.name, x.name)) || (rex && sameName(rex.name, x.name))
    || (g && x.id === g.id) || (mineFor(map, x.id) && taken.has(mineFor(map, x.id).id));
  return (q && q.trim() ? searchGuides(q, 40) : g ? guidesOf(g.zone) : []).filter(x => !skip(x)).map(x => ({ ...x, mine: mineFor(map, x.id) }));
}
const swapOthersHtml = (list, q) => (list.length ? list.map(o => `<button type="button" class="food-pick" data-action="swap-to" data-g="${o.id}">
    <span class="grow"><strong>${esc(o.mine ? o.mine.name : o.name)}</strong><span class="muted small">${o.mine ? `Tu ejercicio · ${lastSetText(o.mine.id)}` : esc(o.musc)}</span></span><span class="chev">›</span></button>`).join('')
  : `<p class="muted small" style="margin:0">${q && q.trim() ? 'No hay ejercicios con ese nombre. Puedes crearlo arriba como alternativa.' : 'Busca un ejercicio por su nombre.'}</p>`);
// edit: después de cambiarlo se abre su editor (botón Editar de una alternativa)
async function swapExercise(alt, edit = false) {
  const d = db.draft, i = swapPick.i, dx = d && d.exercises[i];
  if (!dx) return;
  if (alt.id === dx.exerciseId) { if (edit) openAltEditor(d.routineId, routineExOf(d, dx), alt.id); return; }
  if (touchedEx(dx) && !await ask(`Ya anotaste series en "${dx.name}". ¿Cambiarlo igual? Esas series no se guardan.`, 'Cambiar')) return;
  const rex = routineExOf(d, dx), always = !!(rex && swapPick.always);
  // Nueva: parte con la configuración del ejercicio que reemplaza, y se abre para ajustarla
  const isNew = !!rex && alt.id !== rex.id && !(rex.alts || []).some(a => a.id === alt.id);
  if (isNew) (rex.alts ||= []).push({ ...planOf(rex), ...altOf(alt), ...planOf(rex), unit: alt.unit, own: true });   // la próxima vez es un toque
  if (always && alt.id !== rex.id) {   // la alternativa pasa a la rutina y el de antes queda como alternativa
    const a = rex.alts.find(x => x.id === alt.id), src = a && a.own ? a : rex;
    const plan = planOf(src);
    rex.alts = [altOf(rex), ...rex.alts.filter(x => x.id !== alt.id)];
    for (const k of PLAN_KEYS) delete rex[k];
    Object.assign(rex, { id: alt.id, name: alt.name, unit: alt.unit }, plan);
    if (alt.guide) rex.guide = alt.guide; else delete rex.guide;
  }
  const plan = (rex && alt.id !== rex.id && altPlan(rex, alt.id)) || rex || dx, { guide: _g, ...pf } = planFields(plan);
  d.exercises[i] = {
    exerciseId: alt.id, name: alt.name, unit: alt.unit, rest: plan.rest || 0, rir: !!plan.rir, ...pf,
    ...(alt.guide ? { guide: alt.guide } : {}), ...('ssNext' in dx ? { ssNext: dx.ssNext } : {}), ...(dx.extra ? { extra: true } : {}),
    ...(rex && alt.id !== rex.id ? { swapOf: rex.id } : {}),
    sets: prefillSets(lastFor(alt.id, db.workouts.length, dx.extra ? null : d.routineId) || lastFor(alt.id), dx.rir, plan.goalSets, plan.dropset),
  };
  d.done = (d.done || []).filter(x => x !== dx.exerciseId);
  swapPick = null;
  save();
  showNote(always ? `Ahora tu rutina usa ${alt.name}` : `Hoy haces ${alt.name}`);
  if (isNew || always || edit) return openAltEditor(d.routineId, rex, always ? null : alt.id);   // ajustar series, reps, RIR, descanso…
  render(); syncModalHistory();
}
// Abre el editor de la rutina en ese ejercicio (o su alternativa); "Listo" vuelve al entreno
function openAltEditor(rid, rex, altId) {
  const r = db.routines.find(x => x.id === rid), k = r ? r.exercises.indexOf(rex) : -1;
  if (k < 0) { render(); syncModalHistory(); return; }
  openEx = k; altEdit = altId; editReturn = true; swapPick = null;
  if (modalPushed) { modalPushed = false; location.replace(`#/rutina/${rid}`); }   // reemplaza el paso de la ventana
  else go(`#/rutina/${rid}`);
}
function swapNew(f) {
  const name = f.elements.title.value.trim(), d = db.draft, dx = swapPick && d && d.exercises[swapPick.i];
  if (!name || !dx) return;
  if (sameName(name, dx.name)) { notice('Ponle otro nombre, por ejemplo "' + dx.name + ' · máquina 2".'); return; }
  const found = findExercise(name), g = guideFor(dx.name, dx.guide);
  // Otra máquina del mismo ejercicio: misma técnica (y mismo músculo), distinto historial
  swapExercise({ id: found ? found.id : uid(), name: found ? found.name : name, unit: found ? found.unit : dx.unit, ...(g ? { guide: g.id } : {}) });
}
function setGuide(ctx, id) {
  const r = db.routines.find(x => x.id === ctx.rid), ex = r && (r.exercises.find(e => e.id === ctx.exId) || r.exercises.flatMap(e => e.alts || []).find(a => a.id === ctx.exId));
  if (ex) ex.guide = id;
  const d = cur();
  const dx = d && d.exercises.find(e => e.exerciseId === ctx.exId);
  if (dx) dx.guide = id;
  save();
}
const guideItem = g => `<button type="button" class="food-pick" data-action="guide-set" data-g="${g.id}">
    <span class="grow"><strong>${esc(g.name)}</strong><span class="muted small">${esc(g.musc)}</span></span><span class="chev">›</span></button>`;
function guideListHtml(q) {
  if (q && q.trim()) {
    const res = searchGuides(q, 30);
    return res.length ? res.map(guideItem).join('') : '<p class="muted small">No hay guías con ese nombre todavía.</p>';
  }
  return Object.entries(GUIDE_ZONES).map(([z, name]) => `<h3 class="guide-zone">${name}</h3>${guidesOf(z).map(guideItem).join('')}`).join('');
}
function guidePickerHtml() {
  if (!guidePick) return '';
  return `<div class="modal-wrap">
    <div class="modal-back" data-action="guide-pick-close"></div>
    <section class="modal card guide-modal" role="dialog" aria-modal="true" aria-label="Elegir guía de técnica">
      <div class="picker-top">
        <div class="guide-head"><h2>Elegir guía de técnica</h2><button class="icon small" data-action="guide-pick-close" aria-label="Cerrar">✕</button></div>
        <input data-bind="guide-q" placeholder="Buscar ejercicio" autocomplete="off" value="${esc(guidePick.q || '')}" aria-label="Buscar ejercicio">
      </div>
      <div class="guide-list">${guideListHtml(guidePick.q)}</div>
      <button class="btn ghost block" data-action="guide-set" data-g="none">Sin guía</button>
      <button class="btn block" data-action="guide-pick-close">Cancelar</button>
    </section>
  </div>`;
}
const guideBody = g => `${g.video
    ? `<video class="guide-video${g.sq ? ' sq' : ''}" src="${esc(g.video)}" autoplay muted loop playsinline preload="auto" data-action="vid-toggle" title="Toca para pausar"></video>`
    : ANIMS[g.id] && isLocal ? `<div class="guide-anim" data-anim="${g.id}" title="Toca para pausar"></div>` : ''}
  <h3>Puntos clave</h3>
  <ul class="guide-ul">${g.cues.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
  <h3>Errores comunes</h3>
  <ul class="guide-ul bad">${g.errs.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
  <p class="muted small" style="margin:0">Guía general. Si tienes una lesión o sientes dolor, consulta a un profesional.</p>`;

// ---------- Ver ejercicios por músculo (al editar una rutina): técnica y video antes de añadirlo ----------
let exploreOpen = false, exploreQ = '', exploreZone = '', exploreView = null, exploreScroll = 0, exploreChips = 0;   // lista abierta, búsqueda, grupo, ejercicio abierto
// Cada ejercicio: video chico (play ahí mismo), nombre (abre su técnica) y Agregar
const inRoutine = g => { const r = curRoutine(); return !!r && r.exercises.some(e => sameName(e.name, g.name) || (guideFor(e.name, e.guide) || {}).id === g.id); };
const exploreItem = g => `<div class="explore-item">
    ${exThumb({ name: g.name, guide: g.id })}
    <button type="button" class="explore-name" data-action="explore-open" data-g="${g.id}"><strong>${esc(g.name)}</strong><span class="muted small">${esc(g.musc)}</span></button>
    ${inRoutine(g) ? '<button type="button" class="btn small-btn added" data-action="explore-add" data-g="' + g.id + '">Agregado ✓</button>'
      : `<button type="button" class="btn small-btn primary" data-action="explore-add" data-g="${g.id}">Agregar</button>`}</div>`;
// Lo escrito no es ninguno de la lista: se puede agregar como ejercicio propio
const customAddHtml = q => (q.trim() && !GUIDES.some(g => normText(g.name) === normText(q.trim()))
  ? `<button type="button" class="food-pick custom-add" data-action="explore-add-custom"><span class="grow"><strong>+ Agregar "${esc(q.trim())}"</strong><span class="muted small">Como ejercicio propio (sin video)</span></span></button>` : '');
function exploreListHtml() {
  if (exploreQ.trim()) {   // busca dentro del músculo elegido (o en todos)
    const res = searchGuides(exploreQ, 999).filter(g => !exploreZone || g.zone === exploreZone).slice(0, 60);
    return (res.length ? res.map(exploreItem).join('')
      : `<p class="muted small">No hay ejercicios${exploreZone ? ` de ${GUIDE_ZONES[exploreZone]}` : ''} con ese nombre todavía.</p>`) + customAddHtml(exploreQ);
  }
  return Object.entries(GUIDE_ZONES).filter(([z]) => !exploreZone || z === exploreZone)
    .map(([z, name]) => `<h3 class="guide-zone">${name}</h3>${guidesOf(z).map(exploreItem).join('')}`).join('');
}
function exploreSheetHtml() {
  if (!exploreOpen) return '';
  const g = exploreView && GUIDE_BY_ID.get(exploreView);
  const inner = g
    ? `<div class="guide-head"><button class="icon small" data-action="explore-back" aria-label="Volver a la lista">‹</button><h2 class="grow">${esc(g.name)}</h2><button class="icon small" data-action="explore-close" aria-label="Cerrar">✕</button></div>
       <span class="muted small">Trabaja: ${esc(g.musc)}</span>
       ${guideBody(g)}
       ${inRoutine(g) ? '<button class="btn block added" data-action="explore-add">Agregado a la rutina ✓</button>' : '<button class="btn primary block" data-action="explore-add">Agregar a esta rutina</button>'}
       <button class="btn block" data-action="explore-back">Volver a la lista</button>`
    : `<div class="picker-top">
         <div class="guide-head"><h2>Agregar ejercicio</h2><button class="icon small" data-action="explore-close" aria-label="Cerrar">✕</button></div>
         <input type="search" data-bind="explore-q" placeholder="Busca o escribe el nombre" value="${esc(exploreQ)}" autocomplete="off" aria-label="Buscar ejercicio">
         <div class="explore-zones">${[['', 'Todos'], ...Object.entries(GUIDE_ZONES)]
           .map(([z, n]) => `<button type="button" class="chip toggle ${z === exploreZone ? 'on' : ''}" data-action="explore-zone" data-z="${z}">${n}</button>`).join('')}</div>
       </div>
       <p class="muted small" style="margin:0">Toca el nombre para ver su técnica, o Agregar para sumarlo a la rutina.</p>
       <div class="guide-list explore-list">${exploreListHtml()}</div>`;
  return `<div class="modal-wrap">
    <div class="modal-back" data-action="explore-close"></div>
    <section class="modal card guide-modal explore-sheet" role="dialog" aria-modal="true" aria-label="${g ? `Técnica de ${esc(g.name)}` : 'Ejercicios por músculo'}">${inner}</section>
  </div>`;
}

function guideViewHtml() {
  const d = cur(), ex = d && d.exercises[guideView];
  if (!ex) return '';
  const g = guideFor(ex.name, ex.guide);
  const body = g
    ? `<span class="muted small">${guideKey(g.name) === guideKey(ex.name) ? '' : `${esc(g.name)} · `}Trabaja: ${esc(g.musc)}</span>
       ${guideBody(g)}
       <button class="link small" data-action="guide-change" style="justify-self:start">¿No es este ejercicio? Cambiar guía</button>`
    : `<p class="muted" style="margin:0">Todavía no hay guía para este ejercicio.</p>
       <button class="btn block" data-action="guide-change">Elegir una guía</button>
       <a class="btn primary block center" href="https://ig.me/m/${IG_USER}" target="_blank" rel="noopener">Pide esta guía</a>
       <span class="muted small">Se abre un mensaje a @${IG_USER} en Instagram. Cuéntanos qué ejercicio es.</span>`;
  return `<div class="modal-wrap">
    <div class="modal-back" data-action="guide-close"></div>
    <section class="modal card guide-modal" role="dialog" aria-modal="true" aria-label="Técnica de ${esc(ex.name)}">
      <div class="guide-head"><h2>Técnica · ${esc(ex.name)}</h2><button class="icon small" data-action="guide-close" aria-label="Cerrar">✕</button></div>
      ${body}
    </section>
  </div>`;
}

// ---------- Quiz entre series ----------
// Al empezar un descanso aparece una pregunta corta (Quiz Gymbro / Gymsis). Es opcional: se apaga con
// "No mostrar más" o en Cuenta. Lo que ya viste y tu puntaje se guardan en este teléfono.
const quizKey = () => `desdel-quiz-${user.uid}`;
function quizState() { try { return JSON.parse(localStorage.getItem(quizKey())) || {}; } catch (e) { return {}; } }
function saveQuizState(st) { try { localStorage.setItem(quizKey(), JSON.stringify(st)); } catch (e) { /* sin almacenamiento */ } }
const quizOn = () => !quizState().off;
const quizName = () => (db.body.sex === 'h' ? 'Quiz Gymbro' : db.body.sex === 'm' ? 'Quiz Gymsis' : 'Quiz Gym');
let quizCur = null;   // { q, order: orden de las alternativas, picked: alternativa elegida o null, hidden }

// Primero las que nunca viste; después repasa las que fallaste o las que viste hace más tiempo
function pickQuiz() {
  const st = quizState(), seen = st.seen || {}, wrong = st.wrong || [];
  let pool = QUIZ.filter(x => !seen[x[0]]);
  // Entre las nuevas, aprox. 1 de cada 3 es difícil
  const hard = pool.filter(x => x[6] === 2), basic = pool.filter(x => x[6] !== 2);
  if (hard.length && basic.length) pool = Math.random() < 0.35 ? hard : basic;
  if (!pool.length) {
    // Las falladas vuelven para aprenderlas, pero no al tiro: después de 2 días y de otras 20 preguntas
    const recent = new Set(Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id]) => id));
    const missed = QUIZ.filter(x => wrong.includes(x[0]) && !recent.has(x[0]) && Date.now() - (seen[x[0]] || 0) > 2 * 864e5);
    pool = missed.length && Math.random() < 0.6 ? missed : QUIZ.filter(x => !recent.has(x[0])).sort((a, b) => seen[a[0]] - seen[b[0]]).slice(0, 20);
    if (!pool.length) pool = QUIZ;
  }
  const q = pool[Math.floor(Math.random() * pool.length)];
  const order = q[3].map((_, k) => k);
  for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
  st.seen = { ...seen, [q[0]]: Date.now() };
  saveQuizState(st);
  return { q, order, picked: null, hidden: false };
}
// Al empezar un descanso: pregunta nueva (si la anterior quedó sin responder, se mantiene)
function startQuiz() {
  if (!quizOn()) return;
  if (!quizCur || quizCur.picked != null || quizCur.hidden) quizCur = pickQuiz();
  paintQuiz();
}
function answerQuiz(k) {
  if (!quizCur || quizCur.picked != null) return;
  quizCur.picked = k;
  const st = quizState(), id = quizCur.q[0], ok = k === quizCur.q[4];
  st.n = (st.n || 0) + 1;
  if (ok) st.ok = (st.ok || 0) + 1;
  const wrong = (st.wrong || []).filter(x => x !== id);
  st.wrong = ok ? wrong : [...wrong, id];
  saveQuizState(st);
  paintQuiz();
}
function quizHtml() {
  const [, cat, text, opts, right, why, level] = quizCur.q, picked = quizCur.picked, done = picked != null, st = quizState();
  return `<div class="quiz-top"><strong>${quizName()}</strong><span class="muted small">${QUIZ_CATS[cat]}</span>
      <button class="icon small" data-action="quiz-hide" aria-label="Cerrar pregunta">✕</button></div>
    <p class="quiz-q">${esc(text)}</p>
    <div class="quiz-opts">${quizCur.order.map(k => `<button class="btn quiz-opt ${done && k === right ? 'ok' : done && k === picked ? 'bad' : ''}"
      data-action="quiz-ans" data-k="${k}" ${done ? 'disabled' : ''}>${esc(opts[k])}</button>`).join('')}</div>
    ${done
      ? `<p class="quiz-why"><strong>${picked === right ? '¡Correcto!' : 'Casi.'}</strong> ${esc(why)}</p>
         <div class="quiz-end"><span class="muted small">Llevas ${st.ok || 0} de ${st.n || 0} correctas</span>
           <button class="btn small-btn" data-action="quiz-next">Otra pregunta</button></div>`
      : '<button class="link quiz-off" data-action="quiz-off">No mostrar más</button>'}`;
}
// Se muestra mientras corre el descanso, justo debajo de las series. La primera vez que aparece una pregunta,
// la pantalla baja lo justo para que se vea entera (sin tapar las series).
let quizShown = null;
function paintQuiz() {
  const el = $app.querySelector('#quizcard');
  if (!el) return;
  const show = !!(quizCur && !quizCur.hidden && db.draft && db.draft.timer && routeParts()[0] === 'entrenar');
  el.hidden = !show;
  if (show) el.innerHTML = quizHtml();
  if (show && quizShown !== quizCur) {
    quizShown = quizCur;
    requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
}


// Actualiza solo los textos del cronómetro (sin redibujar la pantalla)
const DONE_SHOW = 8;   // segundos que se ve "¡A darle!" antes de desaparecer
function paintTimer() {
  const d = db.draft;
  if (d && d.timer && Date.now() - d.timer.endsAt > DONE_SHOW * 1000) { setTimer(null); return; }
  const t = routeParts()[0] === 'entrenar' && d && d.timer ? d.timer : null;
  const left = t ? Math.ceil((t.endsAt - Date.now()) / 1000) : 0;

  if (!d) return;
  if (routeParts()[0] === 'entrenar') {
    const sub = $app.querySelector('.bar .sub');
    if (sub) sub.textContent = sub.textContent.replace(/Duración .*$/, `Duración ${elapsedClock(d.start)}`);
  }
  $app.querySelectorAll('[data-rest]').forEach(b => {
    const i = +b.dataset.rest;
    if (!d.exercises[i]) return;
    const active = t && t.i === i;
    b.classList.toggle('running', !!active && left > 0);
    b.classList.toggle('done', !!active && left <= 0);
    const pre = b.dataset.pre || '';
    b.textContent = !active ? `Rest ${pre}${fmtRest(d.exercises[i].rest)}` : left > 0 ? `Rest ${pre}${fmtRest(left)}` : '¡A darle!';
  });

  const bar = document.getElementById('restbar');
  if (!bar) return;
  bar.hidden = !t;
  if (!t) return;
  const ex = d.exercises[t.i];
  bar.classList.toggle('done', left <= 0);
  bar.querySelector('.rb-text').textContent = left > 0
    ? `Rest · ${ex ? ex.name : ''} · ${fmtRest(left)}`
    : `¡A darle! · ${ex ? ex.name : ''}`;
}

setInterval(paintTimer, 500);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    paintTimer();
    if (db.draft && db.draft.timer) keepScreenOn(true);
    // Si la app quedó abierta y es un día nuevo, vuelve a preguntar por el sueño (en la pantalla en que estés)
    if (status === 'ready' && user && !['entrenar', 'editar', 'chat'].includes(routeParts()[0]) && localStorage.getItem(sleepAskedKey()) !== todayKey()) refresh();
  }
});

// ---------- Sincronización con la nube ----------
// Texto estable de un valor (mismas claves en el mismo orden) para comparar versiones
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
const clone = v => JSON.parse(JSON.stringify(v));
// El peso corporal solo se incluye si hay registros: así un teléfono con la versión anterior
// no ve una diferencia y no sobrescribe en la nube los pesos anotados en otro teléfono
const hasWater = w => !!w && (w.goalMl != null || Object.keys(w.days || {}).length > 0 || (w.quick || []).length > 0);
const mainData = () => ({
  routines: db.routines, notes: db.notes,
  ...(db.bodyweight.length ? { bodyweight: db.bodyweight } : {}),
  ...(db.sleep.length ? { sleep: db.sleep } : {}),
  ...(db.skinfolds.length ? { skinfolds: db.skinfolds } : {}),
  ...(db.measures.length ? { measures: db.measures } : {}),
  ...(db.programs.length ? { programs: db.programs } : {}),
  ...(hasBody(db.body) ? { body: db.body } : {}),
  ...(db.plan ? { plan: db.plan } : {}),
  ...(db.planLog && db.planLog.length ? { planLog: db.planLog } : {}),
  ...(hasWater(db.water) ? { water: db.water } : {}),
  ...(hasNutrition(db.nutrition) ? { nutrition: db.nutrition } : {}),
});
function hasNutrition(n) { return !!n && ((n.foods || []).length > 0 || (n.diets || []).length > 0); }
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

function hasUnsynced() {
  if (!user) return false;
  if (stable(mainData()) !== synced.main) return true;
  if (db.workouts.some(w => stable(w) !== synced.w[w.id])) return true;
  return Object.keys(synced.w).some(id => !db.workouts.some(w => w.id === id));
}

let syncTimer = null, syncing = false, syncAgain = false;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 800);
}

// Sube a la nube lo que cambió desde la última vez. Sin internet, Firebase espera y lo sube al volver.
async function sync() {
  if (!user || status !== 'ready' || viewing) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  const uid = user.uid;
  paintSync();
  try {
    const m = stable(mainData());
    if (m !== synced.main) {
      await cloud.putMain(uid, clone(mainData()));
      synced.main = m;
    }
    for (const w of [...db.workouts]) {
      const j = stable(w);
      if (synced.w[w.id] === j) continue;
      await cloud.putWorkout(uid, clone(w));
      synced.w[w.id] = j;
    }
    for (const id of Object.keys(synced.w)) {
      if (db.workouts.some(w => w.id === id)) continue;
      await cloud.removeWorkout(uid, id);
      delete synced.w[id];
    }
  } catch (e) { /* se reintenta en el próximo cambio o al volver internet */ }
  syncing = false;
  if (!user || user.uid !== uid) return;     // se cerró sesión mientras subía
  persistLocal();
  paintSync();
  if (syncAgain) { syncAgain = false; sync(); }
}

// Cambios que llegan desde otro dispositivo. Si aquí hay cambios sin subir, ganan los de aquí.
function applyRemoteMain(data) {
  if (viewing) { viewing.queued.push(() => applyRemoteMain(data)); return; }   // se aplica al volver a tus datos
  const bw = data.bodyweight || [], sl = data.sleep || [], body = data.body || {}, plan = data.plan || null, sk = data.skinfolds || [], ms = data.measures || [], pgs = data.programs || [];
  const water = hasWater(data.water) ? { ...emptyWater(), ...data.water } : emptyWater();
  const remote = {
    routines: data.routines || [], notes: data.notes || {},
    ...(bw.length ? { bodyweight: bw } : {}),
    ...(sl.length ? { sleep: sl } : {}),
    ...(sk.length ? { skinfolds: sk } : {}),
    ...(ms.length ? { measures: ms } : {}),
    ...(pgs.length ? { programs: pgs } : {}),
    ...(hasBody(body) ? { body } : {}),
    ...(plan ? { plan } : {}),
    ...(Array.isArray(data.planLog) && data.planLog.length ? { planLog: data.planLog } : {}),
    ...(hasWater(water) ? { water } : {}),
    ...(hasNutrition(data.nutrition) ? { nutrition: data.nutrition } : {}),
  };
  const r = stable(remote), local = stable(mainData());
  if (local !== synced.main) return;
  synced.main = r;
  if (r !== local) { db.routines = remote.routines; db.notes = remote.notes; db.bodyweight = bw; db.sleep = sl; db.skinfolds = sk; db.measures = ms; db.programs = pgs; db.body = body; db.plan = plan; db.planLog = data.planLog || []; planSeen = stable(plan || null); db.water = water; db.nutrition = hasNutrition(data.nutrition) ? { ...emptyNutrition(), ...data.nutrition } : emptyNutrition(); refresh(); }
  persistLocal();
}

function applyRemoteWorkouts(changes, maxAt = 0) {
  if (viewing) { viewing.queued.push(() => applyRemoteWorkouts(changes, maxAt)); return; }
  let changed = false;
  if (maxAt > (synced.wAt || 0)) synced.wAt = maxAt;
  for (const c of changes) {
    const idx = db.workouts.findIndex(w => w.id === c.id);
    const localJ = idx >= 0 ? stable(db.workouts[idx]) : undefined;
    const dirty = localJ !== synced.w[c.id];
    if (c.type === 'removed') {
      if (idx >= 0 && !dirty) { db.workouts.splice(idx, 1); changed = true; }
      if (!dirty || idx < 0) delete synced.w[c.id];
      continue;
    }
    if (dirty && idx >= 0) continue;
    const j = stable(c.data);
    if (idx < 0) { db.workouts.push(c.data); changed = true; }
    else if (localJ !== j) { db.workouts[idx] = c.data; changed = true; }
    synced.w[c.id] = j;
  }
  if (changed) { db.workouts.sort(byDate); refresh(); }
  persistLocal();
}

// Redibuja con los datos nuevos, salvo que estés escribiendo en ese momento
let refreshPending = false;
function refresh() {
  if (document.activeElement && document.activeElement.matches('#app input')) { refreshPending = true; return; }
  render();
}

// ---------- Sesión ----------
let stopListening = () => {};

// Arma los datos de la app con lo que llega de la nube (tuyos, o de un alumno si eres su coach)
function dbFromCloud(main, workouts) {
  const d = emptyDb();
  if (main) {
    d.routines = main.routines || [];
    d.notes = main.notes || {};
    d.bodyweight = main.bodyweight || [];
    d.sleep = main.sleep || [];
    d.skinfolds = main.skinfolds || [];
    d.measures = main.measures || [];
    d.programs = main.programs || [];
    d.body = main.body || {};
    d.plan = main.plan || null;
    d.planLog = main.planLog || [];
    d.water = hasWater(main.water) ? { ...emptyWater(), ...main.water } : emptyWater();
    d.nutrition = hasNutrition(main.nutrition) ? { ...emptyNutrition(), ...main.nutrition } : emptyNutrition();
  }
  d.workouts = workouts.sort(byDate);
  return d;
}

// Primera vez en este teléfono: descarga todo desde la nube
async function loadFromCloud() {
  const { main, workouts, wAt } = await cloud.fetchAll(user.uid);
  db = dbFromCloud(main, workouts);
  synced = emptySynced();
  if (main) synced.main = stable(mainData());
  for (const w of db.workouts) synced.w[w.id] = stable(w);
  synced.wAt = wAt || 0;
}

// Sube a la cuenta lo que se guardó en este teléfono antes de tener cuenta
function migrateLegacy(legacy) {
  const cloudEmpty = !db.routines.length && !db.workouts.length;
  const merge = cloudEmpty || window.confirm(
    `Este celular tiene ${plural(legacy.routines.length, 'rutina')} y ${plural(legacy.workouts.length, 'entrenamiento')} ` +
    'guardados de antes de tener cuenta.\n\n¿Agregarlos a tu cuenta?');
  if (merge) {
    for (const r of legacy.routines) if (!db.routines.some(x => x.id === r.id)) db.routines.push(r);
    for (const w of legacy.workouts) if (!db.workouts.some(x => x.id === w.id)) db.workouts.push(w);
    db.workouts.sort(byDate);
    db.notes = { ...legacy.notes, ...db.notes };
    if (!db.draft && legacy.draft) db.draft = legacy.draft;
  }
  // Se guarda una copia por si acaso y se deja de usar
  localStorage.setItem(`${LEGACY_KEY}-respaldo`, localStorage.getItem(LEGACY_KEY));
  localStorage.removeItem(LEGACY_KEY);
}

async function handleUser(u) {
  authUser = u;
  stopListening();
  stopListening = () => {};
  stopSocial();
  if (!u) {
    user = null;
    progList = null; progFull.clear(); progUid = null;
    db = emptyDb();
    synced = emptySynced();
    status = 'signed-out';
    render();
    return;
  }

  user = { uid: u.uid, email: u.email, username: u.username || pendingUsername || '' };
  pendingUsername = null;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(userKey(u.uid))); } catch (e) { /* sin copia local */ }

  if (cached && cached.db) {
    db = { ...emptyDb(), ...cached.db };
    synced = cached.synced || emptySynced();
  } else {
    status = 'booting';
    render();
    try { await loadFromCloud(); } catch (e) { status = 'load-error'; render(); return; }
  }
  if (authUser !== u) return;            // cambió la sesión mientras descargaba

  const legacy = readLegacy();
  if (legacy) migrateLegacy(legacy);
  // Estatura y sexo que pusiste al crear la cuenta
  const fresh = pendingBody !== null;
  if (pendingBody && Object.keys(pendingBody).length) db.body = { ...pendingBody, ...db.body };
  pendingBody = null;
  if (fresh && !tourSeen()) {
    tourOpen = true; tourStep = 0; setTourSeen();
    try { localStorage.setItem(sleepAskedKey(), todayKey()); } catch (e) { /* sin almacenamiento */ }
  }

  status = 'ready';
  planSeen = stable(db.plan || null);
  migrateLoosePlan();
  if ([renameOldGuideNames(), relinkGuideAlts(), unifyExerciseIds(), backfillWorkoutGuides(), syncHistoryNames()].some(Boolean)) save();
  // Si el teléfono cerró la app en medio del entrenamiento, al abrirla vuelves a él (no al inicio)
  if (firstOpen && db.draft && routeParts()[0] === '') location.replace('#/entrenar');
  firstOpen = false;
  persistLocal();
  stopListening = cloud.listen(u.uid, applyRemoteMain, applyRemoteWorkouts, synced.wAt || 0);
  startSocial(u.uid);
  startCoach(u.uid);
  loadMyPhoto(u.uid);
  sync();
  render();
  if (db.draft && db.draft.timer) keepScreenOn(true);
  importFromLink();
}

async function logout() {
  const pending = hasUnsynced();
  const msg = pending
    ? 'Hay cambios que todavía no se suben a la nube (sin internet). Si cierras sesión ahora, se pierden.\n\n¿Cerrar sesión igual?'
    : `¿Cerrar sesión?${db.draft ? ' Se descarta el entrenamiento en curso.' : ''} Tus datos quedan guardados en tu cuenta.`;
  if (!await ask(msg)) return;
  keepScreenOn(false);
  stopListening();
  stopSocial();
  if (user) localStorage.removeItem(userKey(user.uid));
  user = null;
  await cloud.logout();                  // Firebase avisa y se muestra la pantalla de acceso
  location.replace('#/');
}

const AUTH_ERRORS = {
  'auth/email-already-in-use': 'Ya existe una cuenta con ese correo. Inicia sesión.',
  'auth/invalid-email': 'El correo no es válido.',
  'auth/missing-email': 'Escribe tu correo.',
  'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
  'auth/missing-password': 'Escribe tu contraseña.',
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/wrong-password': 'Correo o contraseña incorrectos.',
  'auth/user-not-found': 'Correo o contraseña incorrectos.',
  'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos y vuelve a intentar.',
  'auth/network-request-failed': 'Sin conexión a internet.',
};
const authError = e => AUTH_ERRORS[e && e.code] || 'Algo salió mal. Intenta de nuevo.';

async function submitAuth(f) {
  const reg = f.dataset.form === 'register';
  const email = f.elements.email.value.trim();
  const password = f.elements.password.value;
  const username = reg ? f.elements.username.value.trim() : '';
  const $err = f.querySelector('.auth-error'), $btn = f.querySelector('button');
  const showError = text => { $err.textContent = text; $err.hidden = false; };

  if (!email) return showError('Escribe tu correo.');
  if (reg && !username) return showError('Escribe un nombre de usuario.');
  if (!password) return showError('Escribe tu contraseña.');
  const hText = reg ? f.elements.height.value.trim() : '', h = num(hText), sex = reg ? f.elements.sex.value : '';
  if (hText && (h == null || h < 100 || h > 250)) return showError('Escribe tu estatura en cm (ej. 175) o déjala vacía.');
  const yText = reg ? f.elements.birth.value.trim() : '', year = num(yText), thisYear = new Date().getFullYear();
  if (yText && (year == null || year < thisYear - 100 || year > thisYear - 10)) return showError('Escribe tu año de nacimiento (ej. 1998) o déjalo vacío.');

  $err.hidden = true;
  $btn.disabled = true;
  $btn.textContent = reg ? 'Creando cuenta…' : 'Entrando…';
  try {
    if (reg) {
      pendingUsername = username;
      pendingBody = { ...(hText ? { heightCm: Math.round(h) } : {}), ...(yText ? { birthYear: Math.round(year) } : {}), ...(sex ? { sex } : {}) };
      await cloud.register(email, password, username);
    }
    else await cloud.login(email, password);
    // handleUser se encarga del resto cuando Firebase confirma la sesión
  } catch (e) {
    pendingUsername = null;
    pendingBody = null;
    showError(authError(e));
    $btn.disabled = false;
    $btn.textContent = reg ? 'Crear cuenta' : 'Entrar';
  }
}

async function resetPassword() {
  const email = ($app.querySelector('[name="email"]') || {}).value?.trim();
  if (!email) { notice('Escribe tu correo arriba y vuelve a tocar "¿Olvidaste tu contraseña?".'); return; }
  try {
    await cloud.resetPassword(email);
    notice(`Si existe una cuenta con ${email}, te llegará un correo para crear una contraseña nueva. Revisa también la carpeta de spam.`);
  } catch (e) {
    notice(authError(e));
  }
}

// ---------- Acciones ----------
$app.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const { action, id } = el.dataset;
  const i = +el.dataset.i, j = +el.dataset.j;
  if (viewing && !viewAllowed(action)) { notice(viewOnlyMsg()); return; }

  switch (action) {
    case 'back':
      goBack();
      break;

    // Modo coach
    case 'view-exit':
      exitViewing();
      break;
    case 'coach-on':
      setCoachMode(true);
      break;
    case 'coach-off':
      if (await ask('¿Desactivar el modo coach? Tus alumnos siguen vinculados; los vuelves a ver al activarlo de nuevo.', 'Desactivar')) setCoachMode(false);
      break;
    case 'coach-send': {
      const text = coachInviteText(me().body.coachCode);
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      break;
    }
    case 'coach-retry':
      coachCodeError = false;
      render();
      break;
    case 'student-view': {
      const link = students.find(x => x.studentUid === el.dataset.uid);
      if (link) viewStudent(link, el);
      break;
    }
    case 'student-del': {
      const link = students.find(x => x.studentUid === el.dataset.uid);
      if (!link || !await ask(`¿Quitar a ${link.studentName || 'este alumno'} de tus alumnos? Dejarás de ver sus datos y de poder cambiar sus rutinas. Siguen siendo gymbros.`, 'Quitar')) return;
      try { await withTimeout(cloud.deleteCoachLink(link.studentUid)); } catch (e) { notice('No se pudo quitar. Revisa tu internet e intenta de nuevo.'); return; }
      if (viewing) exitViewing();
      break;
    }
    case 'coach-hide':
      localStorage.setItem(`desdel-no-coach-${user.uid}`, '1');
      render();
      showNote('Listo. Si algún día eres coach, actívalo en Cuenta.');
      break;
    case 'assign-pick':
      assignSel = { kind: el.dataset.kind, id: el.dataset.id };
      render();
      break;
    case 'assign-to':
      if (assignTo.has(el.dataset.uid)) assignTo.delete(el.dataset.uid); else assignTo.add(el.dataset.uid);
      render();
      break;
    case 'assign-act':
      assignActivate = !assignActivate;
      render();
      break;
    case 'assign-go':
      assignToStudents(el);
      break;
    case 'checkin-set':
      checkinDraft[el.dataset.k] = +el.dataset.v;
      $app.querySelectorAll(`[data-action="checkin-set"][data-k="${el.dataset.k}"]`).forEach(x => x.classList.toggle('on', x === el));
      break;
    case 'checkin-later':
      localStorage.setItem(checkinSnoozeKey(), todayKey());
      render();
      break;
    case 'coach-unlink':
      unlinkCoach();
      break;
    case 'coach-paste': {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch (e) { /* el teléfono no dejó leer lo copiado */ }
      const f = $app.querySelector('[data-form="coach-code"]'), code = codeFromText(text);
      if (!f) return;
      if (!code) { f.elements.code.focus(); if (text.trim()) formMsg(f, 'Lo que copiaste no es un código de Desdel.'); return; }
      f.elements.code.value = fmtCode(code);
      linkCoachForm(f);
      break;
    }

    case 'start-free':
      startFree();
      break;
    case 'reps-by': {
      const ex = edEx(i);
      if (!repsByOn(ex)) {
        // Activar: cada serie parte con el rango que tenías
        ex.goalRepsBy = Array.from({ length: ex.goalSets || 0 }, () => ex.goalReps || '');
        if (ex.rir) ex.goalRirBy = Array.from({ length: ex.goalSets || 0 }, () => ex.goalRir || '');
        repsByOpen.add(ex.id);
      } else {
        if ((hasRepsBy(ex) || hasRirBy(ex)) && !(await ask('¿Usar lo mismo en todas las series? Se borra lo que pusiste en cada serie.', 'Usar lo mismo'))) return;
        if (!ex.goalReps) { const first = (ex.goalRepsBy || []).find(Boolean); if (first) ex.goalReps = first; }
        if (!ex.goalRir) { const first = (ex.goalRirBy || []).find(Boolean); if (first) ex.goalRir = first; }
        delete ex.goalRepsBy; delete ex.goalRirBy;
        repsByOpen.delete(ex.id);
      }
      save(); render();
      break;
    }
    case 'thumb-play': {   // miniatura en Editar rutina: play / pausa ahí mismo
      const v = el.querySelector('video');
      if (v.paused) { v.play().catch(() => {}); el.classList.add('playing'); } else { v.pause(); el.classList.remove('playing'); }
      break;
    }
    case 'vid-toggle':   // video de técnica: tocar pausa o sigue
      if (el.paused) el.play().catch(() => {}); else el.pause();
      break;
    case 'info':
      if (infoOpen.has(el.dataset.k)) infoOpen.delete(el.dataset.k); else infoOpen.add(el.dataset.k);
      render();
      break;
    case 'restore-open':
      restoreOpen = !restoreOpen;
      render();
      break;
    case 'restore-routine': {
      const r = restoreRoutine(el.dataset.id);
      if (!r) break;
      restoreOpen = false;
      save();
      go('#/rutina/' + r.id);
      setTimeout(() => showNote('Recuperada: revisa las repeticiones y el descanso de cada ejercicio'), 300);
      break;
    }
    case 'rename-to-guides': {
      const list = guideRenames();
      if (!list.length) break;
      const lines = [...new Set(list.map(x => `${x.e.name} → ${x.to}`))];
      const shown = lines.slice(0, 15).join('\n') + (lines.length > 15 ? `\n… y ${lines.length - 15} más` : '');
      if (!await ask(`¿Usar los nombres de la técnica? Tus ejercicios pasan a llamarse como su guía (su historial también):\n\n${shown}`, 'Cambiar nombres')) break;
      for (const { e, to, gid } of list) { e.name = to; e.guide = gid; }
      syncHistoryNames();
      save(); render();
      showNote(`Listo: ${plural(lines.length, 'nombre')} cambiado${lines.length === 1 ? '' : 's'}`);
      break;
    }
    case 'routine-sort':
      routineSort = !routineSort;
      render();
      break;
    case 'tour-open':
      openTour();
      break;
    case 'tour-offer-no':
      setTourSeen();
      render();
      break;
    case 'tour-next':
      tourStep = Math.min(tourStep + 1, TOUR.length - 1);
      render();
      break;
    case 'tour-prev':
      tourStep = Math.max(tourStep - 1, 0);
      render();
      break;
    case 'tour-close':
      closeTour();
      break;
    case 'tour-go':
      tourOpen = false;
      if (el.dataset.to === 'free') startFree();
      else go(el.dataset.to);
      render();
      break;
    case 'tip-close':
      closeTip(el.dataset.k);
      el.closest('.tip-card')?.remove();
      break;
    case 'tips-reset':
      try { localStorage.removeItem(tipsKey()); } catch (e) { /* sin almacenamiento */ }
      notice('Listo: los consejos volverán a aparecer al entrar a cada sección.');
      break;
    case 'free-open':   // mientras eliges el ejercicio no se muestra "Terminar y guardar" (no se toca sin querer)
      freeAdd = {}; freeQ = '';
      render();
      $app.querySelector('.free-pick')?.scrollIntoView({ block: 'start' });
      $app.querySelector('[data-bind="free-q"]')?.focus({ preventScroll: true });
      break;
    case 'free-cancel':
      freeAdd = null;
      render();
      break;
    case 'free-change':
      freeAdd = {};
      render();
      $app.querySelector('[data-bind="free-q"]')?.focus();
      break;
    case 'free-pick': {
      const d = cur(), name = el.dataset.name, g = el.dataset.g, found = findExercise(name);
      const id2 = found && found.id;
      if (d && id2 && d.exercises.some(e => e.exerciseId === id2)) { notice(`"${found.name}" ya está en este entrenamiento.`); return; }
      freeAdd = { name: found ? found.name : name, guide: g || null, known: !!found };
      render();
      $app.querySelector('.free-pick')?.scrollIntoView({ block: 'nearest' });
      break;
    }
    case 'free-sets':
      addFreeExercise(+el.dataset.n);
      break;
    case 'saveas-open':
      saveAsOpen = el.dataset.id;
      render();
      $app.querySelector('[data-form="save-as-routine"] input')?.focus();
      break;
    case 'saveas-no':
      saveAsDone = el.dataset.id;
      render();
      break;
    case 'start': {
      const r = db.routines.find(x => x.id === id);
      if (!r) return;
      if (db.draft && !await ask(`Tienes un entrenamiento de "${db.draft.routineName}" sin guardar. ¿Descartarlo y empezar "${r.name}"?`, 'Descartar y empezar')) return;
      startWorkout(r);
      break;
    }

    // Rutina
    case 'sleep-set':
      saveSleep(+el.dataset.h);
      break;
    case 'sleep-skip':
      sleepAsk = false;
      render();
      break;
    case 'del-sleep': {
      const k = db.sleep.findIndex(e => e.date === el.dataset.date);
      if (k < 0) return;
      const [removed] = db.sleep.splice(k, 1);
      save(); render();
      showUndo(`Registro de ${bwDate(removed.date)} borrado`, () => {
        db.sleep.push(removed);
        db.sleep.sort((a, b) => (a.date < b.date ? -1 : 1));
        save(); render();
      });
      break;
    }
    case 'goal-edit':
      goalEditing = true;
      render();
      { const input = $app.querySelector('[data-form="goal"] input'); if (input) { input.focus(); input.select(); } }
      break;
    case 'goal-cancel':
      goalEditing = false;
      render();
      break;
    case 'goal-by-clear': {
      const inp = $app.querySelector('[data-bind="goal-by"]');
      if (inp) { inp.value = ''; inp.dispatchEvent(new Event('change', { bubbles: true })); }
      el.remove();
      break;
    }
    case 'goal-del': {
      const goal = db.body.goal;
      delete db.body.goal;
      goalEditing = false;
      save(); render();
      if (goal) undoDel('Meta borrada', () => { db.body.goal = goal; });
      break;
    }
    case 'prog-rid':
      progressRid.r = el.dataset.r;
      render();
      break;
    case 'range':
      if (el.dataset.s === 'bw') bwRange = el.dataset.r;
      else if (el.dataset.s === 'sl') sleepRange = el.dataset.r;
      else if (el.dataset.s === 'sk') skinRange = el.dataset.r;
      else if (el.dataset.s === 'ms') measureRange = el.dataset.r;
      else progressRange = el.dataset.r;
      render();
      break;
    case 'toggle-drop':
    case 'toggle-bw':
    case 'toggle-ss': {
      const ex = edEx(i), key = { 'toggle-drop': 'dropset', 'toggle-bw': 'bw', 'toggle-ss': 'ssNext' }[action];
      if (ex[key]) delete ex[key]; else ex[key] = true;
      save(); render();
      if (ex[key] && action === 'toggle-drop') showNote('Dropset activado: cuando entrenes, la última serie trae una fila para anotar la bajada de peso.');
      if (ex[key] && action === 'toggle-bw') showNote('Peso corporal activado: cuando entrenes, anota solo el lastre (0 si no usas).');
      break;
    }
    case 'toggle-rir': {
      const ex = edEx(i);
      ex.rir = !ex.rir;
      save(); render();
      if (ex.rir) showNote('RIR activado: cuando entrenes, anotas cuántas repeticiones te quedaban en cada serie. Arriba puedes poner un RIR objetivo.');
      break;
    }
    case 'toggle-unit': {
      const ex = edEx(i);
      ex.unit = UNITS[(UNITS.indexOf(ex.unit) + 1) % UNITS.length];   // kg → lb → placas → kg
      save(); render();
      break;
    }
    case 'move': {
      // Se mueve por bloques: un superset se mueve completo y sus ejercicios siguen unidos
      const r = curRoutine(), opened = openEx != null ? r.exercises[openEx] : null;
      const groups = groupsOf(r).map(g => g.map(k => r.exercises[k]));
      const gi = groups.findIndex(g => g.includes(r.exercises[i])), gj = gi + Number(el.dataset.d);
      if (gj < 0 || gj >= groups.length) return;
      [groups[gi], groups[gj]] = [groups[gj], groups[gi]];
      for (const g of groups) g.forEach((ex, k) => { if (k < g.length - 1) ex.ssNext = true; else delete ex.ssNext; });
      r.exercises = groups.flat();
      if (opened) openEx = r.exercises.indexOf(opened);   // el ejercicio abierto sigue abierto en su nuevo lugar
      save(); render();
      break;
    }
    case 'ex-open':
      openEx = i; altEdit = null; editReturn = false;
      render();
      { const card = $app.querySelector('.ex-open'); if (card) card.scrollIntoView({ block: 'nearest' }); }
      break;
    case 'ex-close':
      if (editReturn) { editReturn = false; openEx = null; altEdit = null; goBack(); break; }   // vuelve al entreno
      if (altEdit) altEdit = null; else openEx = null;
      render();
      break;
    case 'alt-open': {   // editar una alternativa (las antiguas parten con la configuración del ejercicio)
      const ex = curRoutine().exercises[i], a = (ex.alts || []).find(x => x.id === el.dataset.id);
      if (!a) break;
      if (!a.own) Object.assign(a, planOf(ex), { own: true });
      openEx = i; altEdit = a.id;
      render();
      { const card = $app.querySelector('.ex-open'); if (card) card.scrollIntoView({ block: 'nearest' }); }
      break;
    }
    case 'toggle-sec':
      if (!openSections.delete(el.dataset.k)) openSections.add(el.dataset.k);
      render();
      break;
    case 'del-ex': {
      const r = curRoutine();
      if (altEdit) {
        const ex = r.exercises[i], a = (ex.alts || []).find(x => x.id === altEdit);
        if (!a) return;
        const prevAlts = ex.alts.slice();
        ex.alts = ex.alts.filter(x => x !== a);
        if (!ex.alts.length) delete ex.alts;
        altEdit = null;
        save(); render();
        undoDel(`"${a.name}" quitado de tus alternativas`, () => { ex.alts = prevAlts; });
        break;
      }
      const [removed] = r.exercises.splice(i, 1);
      openEx = null;
      save(); render();
      undoDel(`"${removed.name}" quitado de la rutina`, () => { r.exercises.splice(Math.min(i, r.exercises.length), 0, removed); });
      break;
    }
    case 'move-routine': {
      const list = db.routines, k = i + Number(el.dataset.d);
      [list[i], list[k]] = [list[k], list[i]];
      save(); render();
      break;
    }
    case 'dup-routine': {
      // La copia usa los mismos ejercicios, así comparten historial y mejores marcas
      const r = curRoutine();
      const copy = { id: uid(), name: `${r.name} (copia)`, exercises: r.exercises.map(ex => ({ ...ex })) };
      db.routines.splice(db.routines.indexOf(r) + 1, 0, copy);
      save();
      location.replace('#/rutina/' + copy.id);
      setTimeout(() => {
        const input = $app.querySelector('[data-bind="routine-name"]');
        if (input) { input.focus(); input.select(); }
      }, 50);
      break;
    }
    case 'del-routine': {
      const r = curRoutine(), uses = planUses(r.id);
      const warn = uses.length ? `

Está en tu plan: ${uses.join(' · ')}. Esos días quedarán de descanso.` : '';
      if (!await ask(`¿Eliminar la rutina "${r.name}"? Tu historial se mantiene.${warn}`)) return;
      const before = { routines: [...db.routines], plan: db.plan ? clone(db.plan) : null, programs: clone(db.programs) };
      db.routines = db.routines.filter(x => x !== r);
      if (db.plan) for (const wk of db.plan.days) wk.r = wk.r.map(id => (id === r.id ? null : id));
      for (const pg of db.programs) for (const wk of pg.days) wk.r = wk.r.map(id => (id === r.id ? null : id));
      save(); goBack();
      setTimeout(() => showUndo(`Rutina "${r.name}" eliminada`, () => { Object.assign(db, before); save(); render(); hideToast(); }), 450);   // después de volver (al cambiar de pantalla se esconde el aviso)
      break;
    }

    // Entrenamiento (en curso o editando uno guardado)
    case 'go-ex':
    case 'prev-ex':
    case 'next-ex': {
      const d = cur(), groups = groupsOf(d), gi = groupIndex(groups, d.pos);
      const touched = groups[gi].some(k => (d.touched || {})[d.exercises[k].exerciseId]);
      if (action === 'next-ex' || (action === 'go-ex' && touched)) {
        for (const k of groups[gi]) if (!d.done.includes(d.exercises[k].exerciseId)) d.done.push(d.exercises[k].exerciseId);
      }
      d.pos = action === 'go-ex' ? i : groups[Math.min(Math.max(gi + (action === 'next-ex' ? 1 : -1), 0), groups.length - 1)][0];
      hideToast();
      save(); render();
      window.scrollTo(0, 0);
      const chip = $app.querySelector('.step.on');
      if (chip) chip.scrollIntoView({ inline: 'center', block: 'nearest' });
      break;
    }
    case 'del-extra': {
      const d = cur(), ex = d.exercises[i];
      if (!ex) return;
      const prevDone = (d.done || []).slice(), prevPos = d.pos;
      d.exercises.splice(i, 1);
      d.done = (d.done || []).filter(x => x !== ex.exerciseId);
      undoDel(`"${ex.name}" quitado del entrenamiento`, () => {
        if (cur() !== d) return;               // ya no estás en ese entrenamiento
        d.exercises.splice(Math.min(i, d.exercises.length), 0, ex);
        d.done = prevDone; d.pos = prevPos;
        if (d.timer && d.timer.i >= i) d.timer.i++;
      });
      d.pos = Math.max(0, Math.min(i, d.exercises.length - 1));
      // el descanso en curso sigue apuntando a su ejercicio
      if (d.timer) { if (d.timer.i === i) d.timer = null; else if (d.timer.i > i) d.timer.i--; }
      save(); render();
      break;
    }
    case 'add-set': {
      const ex = cur().exercises[i];
      ex.sets.push(nextSet(ex.sets, ex.rir));
      save(); render();
      break;
    }

    case 'del-set': {
      const d = cur(), sets = d.exercises[i].sets;
      const [removed] = sets.splice(j, 1);
      save(); render();
      showUndo('Serie borrada', () => {
        if (cur() !== d) return;               // ya no estás en ese entrenamiento
        sets.splice(Math.min(j, sets.length), 0, removed);
        save(); render();
      });
      break;
    }
    case 'toggle-history': {
      // En un superset se abren o cierran los historiales de todos sus ejercicios
      const d = cur(), ids = (el.dataset.group ? groupsOf(d).find(g => g.includes(i)) : [i]).map(k => d.exercises[k].exerciseId);
      const open = ids.some(x => openHistory.has(x));
      ids.forEach(x => (open ? openHistory.delete(x) : openHistory.add(x)));
      render();
      break;
    }
    case 'add-round': {
      // Superset: una serie más para cada ejercicio
      const d = cur();
      for (const k of groupsOf(d).find(g => g.includes(i))) d.exercises[k].sets.push(nextSet(d.exercises[k].sets, d.exercises[k].rir));
      save(); render();
      break;
    }
    case 'add-drop': {
      const st = cur().exercises[i].sets[j];
      (st.drops ||= []).push({ w: '', r: '' });
      save(); render();
      const input = $app.querySelector(`[data-bind="dw"][data-i="${i}"][data-j="${j}"][data-k="${st.drops.length - 1}"]`);
      if (input) input.focus();
      break;
    }
    case 'del-drop': {
      const d = cur(), st = d.exercises[i].sets[j], k = +el.dataset.k;
      const [removed] = st.drops.splice(k, 1);
      if (!st.drops.length) delete st.drops;
      save(); render();
      undoDel('Bajada borrada', () => {
        if (cur() !== d) return;
        (st.drops ||= []).splice(Math.min(k, st.drops.length), 0, removed);
      });
      break;
    }
    case 'edit-note': {
      editingNote = cur().exercises[i].exerciseId;
      redrawNote(i);
      const input = $app.querySelector(`[data-note="${i}"] input`);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      break;
    }
    case 'rest': {
      const t = db.draft.timer;
      if (t && t.i === i && t.endsAt > Date.now()) setTimer(null);    // tocar de nuevo lo detiene (si ya terminó, empieza otro)
      else { setTimer({ i, endsAt: Date.now() + db.draft.exercises[i].rest * 1000 }); startQuiz(); }
      break;
    }
    case 'myprog-new': {
      const p = { id: uid(), name: nextProgramName(), weeks: 1, days: [{ r: Array(7).fill(null) }] };
      db.programs.push(p);
      save();
      go('#/miprograma/' + p.id);
      break;
    }
    case 'myprog-weeks': {
      const p = db.programs.find(x => x.id === routeParts()[1]), n = Number(el.dataset.v);
      if (!p) return;
      while (p.days.length < n) p.days.push({ r: Array(7).fill(null) });
      p.weeks = n;
      planFromProgram(p);
      save(); render();
      break;
    }
    case 'myprog-stop':
      if (!await ask('¿Dejar de usar este programa? No se borra; sigue en Mis programas. Mientras no tengas uno activo, la app no te dirá qué te toca cada día.')) return;
      db.plan = null;
      save(); render();
      break;
    case 'myprog-use': {
      const p = db.programs.find(x => x.id === routeParts()[1]);
      if (p) useMyProgram(p);
      break;
    }
    case 'myprog-del': {
      const p = db.programs.find(x => x.id === routeParts()[1]);
      if (!p || !await ask(`¿Eliminar el programa "${p.name || '(sin nombre)'}"? Tus rutinas y tu plan no se borran.`)) return;
      db.programs = db.programs.filter(x => x !== p);
      if (db.plan && db.plan.prog === p.id) delete db.plan.prog;   // tu plan sigue igual, pero ya no es de un programa
      save();
      location.replace('#/programas');
      break;
    }
    case 'prog-level':
      progLevel = el.dataset.l;
      render();
      break;
    case 'prog-days':
      progDays = +el.dataset.n;
      render();
      break;
    case 'prog-add': {
      const p = progById(routeParts()[1]);
      if (p) addReadyProgram(p);
      break;
    }
    case 'prog-add-one': {
      const p = progById(routeParts()[1]), rt = p && p.levels[progLevel].routines[el.dataset.k];
      if (!rt) return;
      const r = routineFromProgram(rt);
      db.routines.push(r);
      save(); render();
      showUndo(`Rutina "${r.name}" agregada a tus rutinas`, () => { db.routines = db.routines.filter(x => x.id !== r.id); save(); render(); });
      break;
    }
    case 'guide-view':
      guideView = i;
      render();
      syncModalHistory();
      break;
    case 'guide-close':
      guideView = null;
      render();
      syncModalHistory();
      break;
    case 'guide-pick': {   // desde el editor de rutina
      const r = curRoutine();
      guidePick = { rid: r.id, exId: edEx(i).id, q: '' };
      render();
      syncModalHistory();
      break;
    }
    case 'guide-change': {   // desde la guía abierta mientras entrenas
      const d = cur(), ex = d.exercises[guideView];
      guidePick = { rid: d.routineId, exId: ex.exerciseId, q: '' };
      render();
      syncModalHistory();
      break;
    }
    case 'guide-set':
      setGuide(guidePick, el.dataset.g);
      guidePick = null;
      render();
      syncModalHistory();
      break;
    case 'explore-zone':   // grupo muscular en Ejercicios (sin redibujar todo, para no perder dónde estabas)
      exploreZone = el.dataset.z;
      $app.querySelectorAll('.explore-zones .chip').forEach(b => b.classList.toggle('on', b.dataset.z === exploreZone));
      $app.querySelector('.explore-list').innerHTML = exploreListHtml();
      break;
    case 'explore-list':   // abrir la lista desde el editor de rutina (lista para escribir)
      exploreOpen = true; exploreView = null; exploreQ = '';
      render();
      syncModalHistory();
      $app.querySelector('[data-bind="explore-q"]')?.focus();
      break;
    case 'explore-open': {   // ver la técnica de uno (se recuerda dónde ibas en la lista)
      exploreScroll = $app.querySelector('.explore-sheet')?.scrollTop || 0;
      exploreChips = $app.querySelector('.explore-zones')?.scrollLeft || 0;
      exploreView = el.dataset.g;
      render();
      break;
    }
    case 'explore-back': {
      exploreView = null;
      render();
      const sh = $app.querySelector('.explore-sheet'), chips = $app.querySelector('.explore-zones');
      if (sh) sh.scrollTop = exploreScroll;
      if (chips) chips.scrollLeft = exploreChips;   // la fila de músculos queda donde la dejaste
      break;
    }
    case 'explore-close':
      exploreOpen = false; exploreView = null;
      render();
      syncModalHistory();
      break;
    case 'explore-add':   // agregar a la rutina (desde la lista o desde su técnica); la lista sigue abierta para agregar más
    case 'explore-add-custom': {
      const r = curRoutine(), g = action === 'explore-add' ? GUIDE_BY_ID.get(el.dataset.g || exploreView) : null;
      const name = g ? g.name : exploreQ.trim();
      if (!r || !name) return;
      const top = $app.querySelector('.explore-sheet')?.scrollTop || 0;
      if (!(await okRepeatedEx(name, g ? g.id : null))) { openEx = null; render(); return; }
      const id = await exIdForAdd(name, r, g ? g.id : null);
      r.exercises.push({ id, name, unit: lastUnit, rest: 0, ...(g ? { guide: g.id } : {}) });
      save(); render();
      const sh = $app.querySelector('.explore-sheet'); if (sh) sh.scrollTop = top;
      showNote(`${name}: agregado a la rutina`);
      break;
    }
    case 'guide-pick-close':
      guidePick = null;
      render();
      syncModalHistory();
      break;
    case 'swap-open':
      swapPick = { i, always: false, q: '' };
      render(); syncModalHistory();
      break;
    case 'swap-close':
      swapPick = null;
      render(); syncModalHistory();
      break;
    case 'swap-mode':
      swapPick.always = el.dataset.v === '1';
      render();
      break;
    case 'swap-to': {
      const d = db.draft, dx = d.exercises[swapPick.i], rex = routineExOf(d, dx);
      let alt;
      if (el.dataset.g) {   // otro ejercicio del mismo músculo (con su guía)
        const g = GUIDE_BY_ID.get(el.dataset.g), found = findExercise(g.name) || mineFor(myGuideMap(), g.id);
        alt = { id: found ? found.id : uid(), name: found ? found.name : g.name, unit: found ? found.unit : dx.unit === 'lb' ? 'lb' : 'kg', guide: g.id };
      } else alt = [...(rex ? [altOf(rex), ...(rex.alts || [])] : [])].find(a => a.id === el.dataset.id);
      if (alt) await swapExercise(alt);
      break;
    }
    case 'swap-alt-del': {
      const d = db.draft, rex = routineExOf(d, d.exercises[swapPick.i]), a = rex && (rex.alts || []).find(x => x.id === el.dataset.id);
      if (!a) return;
      const prevAlts = rex.alts.slice();
      rex.alts = rex.alts.filter(x => x !== a);
      if (!rex.alts.length) delete rex.alts;
      save(); render();
      undoDel(`"${a.name}" quitado de tus alternativas`, () => { rex.alts = prevAlts; });
      break;
    }
    case 'swap-alt-edit': {
      const d = db.draft, rex = routineExOf(d, d.exercises[swapPick.i]), a = rex && (rex.alts || []).find(x => x.id === el.dataset.id);
      if (!a) break;
      if (!a.own) Object.assign(a, planOf(rex), { own: true });
      await swapExercise(a, true);   // queda elegida en el entreno y se abre para editarla
      break;
    }
    case 'quiz-ans':
      answerQuiz(+el.dataset.k);
      break;
    case 'quiz-next':   // seguir respondiendo en el mismo descanso
      quizCur = pickQuiz();
      paintQuiz();
      break;
    case 'quiz-hide':
      if (quizCur) quizCur.hidden = true;
      paintQuiz();
      break;
    case 'quiz-off': {
      const st = quizState();
      saveQuizState({ ...st, off: true });
      quizCur = null;
      paintQuiz();
      showUndo('Quiz desactivado. Puedes activarlo en Cuenta', () => { saveQuizState({ ...quizState(), off: false }); });
      break;
    }
    case 'quiz-toggle':
      saveQuizState({ ...quizState(), off: quizOn() });
      render();
      break;
    case 'rest-stop':
      setTimer(null);
      break;
    case 'rest-add': {
      // +30 s al descanso en curso (si ya terminó, cuenta 30 s desde ahora)
      const t = db.draft && db.draft.timer;
      if (t) setTimer({ ...t, endsAt: Math.max(t.endsAt, Date.now()) + 30000 });
      break;
    }
    case 'finish':
      finishWorkout();
      break;
    case 'discard':
      if (!await ask('¿Descartar este entrenamiento? No se guardará nada.')) return;
      setTimer(null);
      db.draft = null;
      save(); location.replace('#/rutinas');
      break;
    case 'save-edit':
      saveEdit();
      break;

    // Historial
    case 'hist-month': {
      const d = new Date(histMonth.y, histMonth.m + Number(el.dataset.d), 1);
      histMonth = { y: d.getFullYear(), m: d.getMonth() };
      histDay = null;
      render();
      break;
    }
    case 'hist-day':
      histDay = el.dataset.date && el.dataset.date !== histDay ? el.dataset.date : null;   // tocar de nuevo = todo el mes
      render();
      break;
    case 'scan': {   // desde una comida de la dieta, los extras de hoy o Mis alimentos
      const form = el.closest('form');
      openScanner(form ? (form.dataset.m != null ? { m: form.dataset.m } : { form: form.dataset.form }) : null);
      break;
    }
    case 'pick-food':
      pickFoodIn(el.closest('form'), id);
      break;
    case 'add-mode': {
      const form = el.closest('form'), food = foodById(form.dataset.food);
      form.dataset.mode = form.dataset.mode === 'u' ? 'g' : 'u';
      setAddMode(form, food);
      form.elements.g.focus();
      break;
    }
    case 'item-mode': {
      // Cambia una fila entre gramos y unidades, convirtiendo la cantidad
      const diet = dietById(routeParts()[1]), it = diet.meals[+el.dataset.m].items[i], food = foodById(it.foodId);
      if (it.n != null) { it.g = Math.round(it.n * food.unitG); delete it.n; }
      else { it.n = Math.max(0.5, Math.round(((it.g || 0) / food.unitG) * 2) / 2); delete it.g; }
      save(); render();
      break;
    }
    case 'nutri-use': {
      const log = N().log[todayKey()];
      N().activeDietId = id;
      setTodayLog(id, (log && log.byDiet && log.byDiet[id]) || []);
      // Elegida a mano (solo por hoy); si elegiste justo la del plan, ya no cuenta como a mano
      const auto = planDietToday(), day = N().log[todayKey()];
      if (auto && auto.id !== id) day.manual = true; else delete day.manual;
      save(); render();
      break;
    }
    case 'skin-view':
      skinView = el.dataset.k;
      render();
      break;
    case 'measure-view':
      measureView = el.dataset.k;
      render();
      break;
    case 'del-measure': {
      const k = db.measures.findIndex(e => e.date === el.dataset.date);
      if (k < 0) return;
      const [removed] = db.measures.splice(k, 1);
      save(); render();
      showUndo(`Medición de ${bwDate(removed.date)} borrada`, () => {
        db.measures.push(removed);
        db.measures.sort((a, b) => (a.date < b.date ? -1 : 1));
        save(); render();
      });
      break;
    }
    case 'prog-cancel':
      closeProgressNew();
      render();
      break;
    case 'prog-pose-new':
      progNew.pose = el.dataset.k;
      render();
      break;
    case 'prog-save':
      saveProgressNew(el);
      break;
    case 'prog-open':
      progOpen = el.dataset.id;
      render();
      break;
    case 'prog-close':
      progOpen = null;
      render();
      break;
    case 'prog-del':
      deleteProgress(el.dataset.id);
      break;
    case 'prog-filter':
      if (progCmp) progCmpBy[progPose] = progCmp;
      progPose = el.dataset.k;
      progCmp = progCmpBy[progPose] || null;
      render();
      break;
    case 'prog-retry':
      loadProgress(true);
      render();
      break;
    case 'week-sum':
      weekOffset = +el.dataset.w;
      render();
      break;
    case 'week-day': {   // un día del resumen semanal: su entreno (o el historial de ese mes)
      const ws = db.workouts.filter(w => dayKeyOf(w.date) === el.dataset.k);
      if (ws.length === 1) go('#/sesion/' + ws[0].id);
      else { histMonth = { y: +el.dataset.k.slice(0, 4), m: +el.dataset.k.slice(5, 7) - 1 }; go('#/historial'); }
      break;
    }
    case 'del-skin': {
      const k = db.skinfolds.findIndex(e => e.date === el.dataset.date);
      if (k < 0) return;
      const [removed] = db.skinfolds.splice(k, 1);
      save(); render();
      showUndo(`Medición de ${bwDate(removed.date)} borrada`, () => {
        db.skinfolds.push(removed);
        db.skinfolds.sort((a, b) => (a.date < b.date ? -1 : 1));
        save(); render();
      });
      break;
    }
    case 'diet-link': {
      // Cada día va con una sola dieta: si estaba en otra, se pasa a esta
      const links = dietLinks(), diet = dietById(routeParts()[1]), k = el.dataset.k;
      if (links[k] === diet.id) delete links[k]; else links[k] = diet.id;
      save(); render();
      break;
    }
    case 'nutri-auto': {
      const log = N().log[todayKey()];
      if (log) delete log.manual;
      save(); render();
      break;
    }
    case 'nutri-done': {
      const t = todayNutrition();
      const done = t.done.includes(id) ? t.done.filter(x => x !== id) : [...t.done, id];
      setTodayLog(t.diet.id, done);
      save(); render();
      break;
    }
    case 'food-del': {
      const food = foodById(routeParts()[1]);
      const before = { diets: clone(N().diets), foods: [...N().foods] };
      undoDel(`"${food.name}" eliminado`, () => { Object.assign(N(), before); }, 450);
      for (const d of N().diets) for (const m of d.meals) m.items = m.items.filter(it => it.foodId !== food.id);
      N().foods = N().foods.filter(f => f !== food);
      save(); goBack();
      break;
    }
    case 'diet-new': {
      const diet = { id: uid(), name: `Dieta ${N().diets.length + 1}`, meals: [{ id: uid(), name: 'Comida 1', items: [] }] };
      N().diets.push(diet);
      if (!N().activeDietId) N().activeDietId = diet.id;
      save();
      go('#/dieta/' + diet.id);
      break;
    }
    case 'extra-mode':
      extraMode = extraMode === el.dataset.v ? null : el.dataset.v;
      render();
      { const input = $app.querySelector('[data-form="extra-food"] [name="q"], [data-form="extra-manual"] [name="name"]'); if (input) input.focus(); }
      break;
    case 'extra-del': {
      const day = N().log[todayKey()];
      if (!day || !day.extras) return;
      const k = day.extras.findIndex(x => x.id === id);
      if (k < 0) return;
      const [removed] = day.extras.splice(k, 1);
      save(); render();
      showUndo('Extra quitado', () => { (N().log[todayKey()].extras ||= []).splice(k, 0, removed); save(); render(); });
      break;
    }
    case 'pace-dir':
      nextPaceDir();
      save(); render();
      break;
    case 'set-activity':
      db.body.activity = el.dataset.v;
      save(); render();
      break;
    case 'meal-add': {
      const diet = dietById(routeParts()[1]);
      diet.meals.push({ id: uid(), name: `Comida ${diet.meals.length + 1}`, items: [] });
      save(); render();
      break;
    }
    case 'meal-dup': {
      // Copia la comida (mismos alimentos y gramos) justo debajo
      const diet = dietById(routeParts()[1]), m = +el.dataset.m, meal = diet.meals[m];
      const copy = { id: uid(), name: `${meal.name} (copia)`, items: meal.items.map(it => ({ ...it })) };
      diet.meals.splice(m + 1, 0, copy);
      save(); render();
      const input = $app.querySelector(`[data-bind="meal-name"][data-m="${m + 1}"]`);
      if (input) { input.scrollIntoView({ block: 'center' }); input.focus(); input.select(); }
      break;
    }
    case 'meal-del': {
      const diet = dietById(routeParts()[1]), meal = diet.meals[+el.dataset.m];
      if (meal.items.length && !await ask(`¿Eliminar "${meal.name}" con sus alimentos?`)) return;
      diet.meals.splice(+el.dataset.m, 1);
      save(); render();
      break;
    }
    case 'item-del': {
      const meal = dietById(routeParts()[1]).meals[+el.dataset.m], [removed] = meal.items.splice(i, 1);
      save(); render();
      const fd = foodById(removed.foodId);
      undoDel(`${fd ? `"${fd.name}"` : 'Alimento'} quitado`, () => { meal.items.splice(Math.min(i, meal.items.length), 0, removed); });
      break;
    }
    case 'diet-done':
      location.replace('#/nutricion/dietas');
      break;
    case 'diet-del': {
      const diet = dietById(routeParts()[1]);
      if (!await ask(`¿Eliminar la dieta "${diet.name}"?`)) return;
      N().diets = N().diets.filter(d => d !== diet);
      if (N().activeDietId === diet.id) N().activeDietId = N().diets[0] ? N().diets[0].id : null;
      save(); location.replace('#/nutricion/dietas');
      break;
    }
    case 'water-add':
      addWater(Number(el.dataset.ml));
      break;
    case 'water-del': {
      const key = todayKey(), list = db.water.days[key] || [];
      const [removed] = list.splice(Number(el.dataset.k), 1);
      if (!list.length) delete db.water.days[key];
      save(); render();
      if (removed) showUndo(`${removed.ml} ml borrados`, () => {
        (db.water.days[key] ||= []).push(removed);
        db.water.days[key].sort((a, b) => (a.at < b.at ? -1 : 1));
        save(); render();
      });
      break;
    }
    case 'water-edit': {
      waterEditing = Number(el.dataset.k);
      render();
      const input = $app.querySelector('[data-form="water-edit"] input');
      if (input) { input.focus(); input.select(); }
      break;
    }
    case 'water-edit-cancel':
      waterEditing = null;
      render();
      break;
    case 'wq-add': {
      const quick = ensureQuick();
      if (quick.length >= 4) return;
      quick.push({ name: '', ml: 330 });
      save(); render();
      const input = $app.querySelector(`[data-bind="wq-ml"][data-k="${quick.length - 1}"]`);
      if (input) { input.focus(); input.select(); }
      break;
    }
    case 'wq-del': {
      const quick = ensureQuick();
      if (quick.length <= 1) return;
      const k = Number(el.dataset.k), [removed] = quick.splice(k, 1);
      save(); render();
      undoDel(`Botón ${removed.name ? `${removed.name} ` : ''}(${removed.ml} ml) quitado`, () => { const q = ensureQuick(); q.splice(Math.min(k, q.length), 0, removed); });
      break;
    }
    case 'water-auto':
      db.water.goalMl = null;
      save(); render();
      break;
    case 'share-workout':
      shareWorkout(el, el.dataset.id);
      break;
    case 'del-session':
      if (!await ask('¿Eliminar este entrenamiento del historial?')) return;
      db.workouts = db.workouts.filter(w => w.id !== id);
      save(); goBack();
      break;

    // Compartir rutinas
    case 'share-routine':
      shareRoutine(el);
      break;
    case 'copy-code':
      navigator.clipboard.writeText(shareLink(shareResult.code))
        .then(() => { el.textContent = 'Link copiado'; }, () => notice(`Link: ${shareLink(shareResult.code)}`));
      break;
    case 'share-diet':
      shareDiet(el);
      break;

    // Social
    case 'auto-pr':
      localStorage.setItem(autoPRKey(), el.checked ? '1' : '0');
      break;
    case 'photo-del':
      if (await ask('¿Quitar tu foto de perfil?')) setMyPhoto(null);
      break;
    case 'photo-view':
      photoView = true;
      render();
      break;
    case 'photo-close':
      photoView = false;
      render();
      break;
    case 'crop-cancel':
      closePhotoEditor();
      break;
    case 'crop-use': {
      const url = cropToDataUrl();
      closePhotoEditor();
      setMyPhoto(url);
      break;
    }
    case 'pr-pick': {
      // Récords destacados: hasta 5
      const pick = (db.body.prPick ||= []), k = pick.indexOf(id);
      if (k >= 0) pick.splice(k, 1); else if (pick.length < 5) pick.push(id);
      save(); render();
      break;
    }
    case 'profile-field': {
      const hide = (db.body.hide ||= {});
      if (el.checked) delete hide[el.dataset.k]; else hide[el.dataset.k] = true;
      save();   // el perfil se vuelve a publicar solo
      break;
    }
    case 'share-profile':
      setShareProfile(el.checked);
      render();   // muestra u oculta las opciones de qué mostrar
      break;
    case 'make-invite':
      inviteError = false;
      render();
      break;
    case 'send-invite': {
      const text = inviteText(inviteCode());
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      break;
    }
    case 'attach':
      attach = attach ? null : 'menu';
      render();
      break;
    case 'attach-pick':
      attach = el.dataset.kind;
      render();
      break;
    case 'attach-close':
      attach = null;
      render();
      break;
    case 'attach-send':
      sendAttachment(id);
      break;
    case 'msg-add':
      addFromMessage(id);
      break;
    case 'msg-select':
      if (e.target.closest('a, button')) return;
      if (longPressed) { longPressed = false; return; }   // ya se abrió al mantenerlo apretado
      selectedMsg = selectedMsg === id ? null : id;
      paintMessages();
      break;
    case 'msg-edit':
      startMsgEdit(id);
      break;
    case 'msg-edit-cancel':
      cancelMsgEdit();
      break;
    case 'msg-del':
      if (await ask('¿Eliminar este mensaje? Se borra para ti y para tu gymbro.')) deleteMessage(id);
      break;
    case 'gymbro-del': {
      const c = chats.find(x => x.id === routeParts()[1]);
      if (!c || !await ask(`¿Eliminar a ${gymbroName(c)} de tus gymbros? El chat se borra para los dos.`)) return;
      cloud.deleteChat(c.id).then(() => location.replace('#/social'), () => notice('No se pudo eliminar. Revisa tu internet.'));
      break;
    }
    case 'send-code': {
      const text = shareText(shareResult);
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      break;
    }
    case 'paste-import':
      pasteImport();
      break;

    // Cuenta
    case 'logout':
      logout();
      break;
    case 'reset-pass':
      resetPassword();
      break;
    case 'retry':
      handleUser(authUser);
      break;
    case 'reload':
      location.reload();
      break;
    case 'handoff-copy':
      navigator.clipboard.writeText(fmtCode(handoffCode))
        .then(() => { el.textContent = 'Código copiado. Ahora abre Desdel'; }, () => notice(`Código: ${fmtCode(handoffCode)}`));
      break;
    case 'inapp-copy':
      navigator.clipboard.writeText(inApp.url)
        .then(() => { el.textContent = 'Link copiado'; }, () => prompt('Copia este link:', inApp.url));
      break;
    case 'inapp-stay':
      try { sessionStorage.setItem('desdel-inapp-ok', '1'); } catch (e) { /* sin almacenamiento */ }
      inApp = null;
      render();
      break;
    case 'handoff-here':
      // Sigue el camino normal: inicia sesión aquí y se importa
      localStorage.setItem(PENDING_IMPORT, handoffCode);
      handoffCode = null;
      if (status === 'ready') importFromLink();
      render();
      break;
  }
});

// Escritura en campos: se guarda al instante, sin redibujar (para no perder el foco)
// Foto de perfil elegida
$app.addEventListener('change', async e => {
  const b = e.target.dataset.bind;
  if (b === 'prog-cmp') { progCmp[+e.target.dataset.k] = e.target.value; render(); return; }
  if (b === 'goal-by') {
    const show = e.target.parentElement.querySelector('.date-show');
    if (show) show.textContent = e.target.value ? fmtDMY(e.target.value) : 'Sin fecha: usa tu ritmo de Nutrición';
    return;
  }
  if (b === 'prog-date') {
    if (progNew && e.target.value) progNew.date = e.target.value;
    const show = e.target.parentElement.querySelector('.date-show');
    if (show && progNew) show.textContent = fmtDMY(progNew.date);
    return;
  }
  if (b === 'prog-file' && e.target.files && e.target.files[0]) { openProgressNew(e.target.files[0]); e.target.value = ''; return; }
  if (e.target.dataset.bind !== 'photo' || !e.target.files || !e.target.files[0]) return;
  openPhotoEditor(e.target.files[0]);
  e.target.value = '';   // permite elegir la misma foto otra vez
});

$app.addEventListener('input', e => {
  const el = e.target, bind = el.dataset.bind;
  if (!bind) return;
  if (bind === 'progress-search') { progressQuery = el.value; filterProgress(); return; }
  if (bind === 'food-search') { foodQuery = el.value; filterFoods(); return; }
  if (bind === 'free-q') {
    freeQ = el.value;
    const box = $app.querySelector('.free-sugg');
    if (box) box.innerHTML = freeSuggHtml(freeQ);
    return;
  }
  if (bind === 'explore-q') {
    exploreQ = el.value;
    const list = $app.querySelector('.explore-list');
    if (list) list.innerHTML = exploreListHtml();
    return;
  }
  if (bind === 'swap-q') {
    const d = db.draft, dx = swapPick && d && d.exercises[swapPick.i];
    if (!dx) return;
    swapPick.q = el.value;
    const rex = routineExOf(d, dx), alts = [...(rex && dx.swapOf ? [altOf(rex)] : []), ...(rex ? rex.alts || [] : [])];
    const list = $app.querySelector('.swap-others');
    if (list) list.innerHTML = swapOthersHtml(swapOthers(dx, alts, rex, guideFor(dx.name, dx.guide), el.value), el.value);
    return;
  }
  if (bind === 'guide-q') {
    if (guidePick) guidePick.q = el.value;
    const list = $app.querySelector('.guide-list');
    if (list) list.innerHTML = guideListHtml(el.value);
    return;
  }
  if (bind === 'food-q') {
    const form = el.closest('form');
    delete form.dataset.food;                                   // se cambió el texto: hay que volver a elegir
    const res = searchFoods(el.value);
    form.querySelector('.food-results').innerHTML = el.value.trim()
      ? (res.map(f => foodResultBtn(f, 'pick-food')).join('') || '<p class="muted small">No hay coincidencias. Puedes crearlo en Mis alimentos.</p>')
      : '';
    return;
  }
  if (bind === 'diet-name' || bind === 'meal-name' || bind === 'item-g') {
    const diet = dietById(routeParts()[1]), m = +el.dataset.m;
    if (!diet) return;
    if (bind === 'diet-name') diet.name = el.value;
    else if (bind === 'meal-name') diet.meals[m].name = el.value;
    else { const g = num(el.value), it = diet.meals[m].items[+el.dataset.i]; if (g != null && g >= 0) { if (it.n != null) it.n = g; else it.g = g; paintDietTotals(diet); } }
    save();
    return;
  }
  const i = +el.dataset.i, j = +el.dataset.j;
  if (bind === 'skin') {
    // Vista previa del % mientras escribes
    const f = el.closest('form'), prev = f.querySelector('.skin-preview');
    if (prev) prev.innerHTML = skinPreviewText(SKIN_SITES[db.body.sex].map(([k]) => f.elements[k].value));
    return;
  }
  if (bind === 'crop-zoom') { const c = activeCrop(); if (c) setCropZoom(c, Number(el.value)); return; }
  if (bind === 'myprog-name' || bind === 'myprog-day') {
    const p = db.programs.find(x => x.id === routeParts()[1]);
    if (!p) return;
    if (bind === 'myprog-name') p.name = el.value;
    else {
      p.days[+el.dataset.w].r[+el.dataset.d] = el.value || null;
      planFromProgram(p);
      const sub = $app.querySelector('.bar .sub');
      if (sub) sub.textContent = `${plural(myProgDays(p.days), 'día')} por semana`;
    }
    save();
    return;
  }
  if (bind === 'wq-ml') setQuick(el);
  else if (bind === 'pace-amt') setPaceAmount(el);
  else if (bind === 'routine-name') curRoutine().name = el.value;
  else if (bind === 'ex-name') edEx(i).name = el.value;
  else if (bind === 'ex-rest') {
    const sec = parseRest(el.value);
    if (sec !== null) edEx(i).rest = sec;
  }
  else if (bind === 'ex-repby') {
    const ex = edEx(i), text = el.value.trim();
    const by = Array.from({ length: Math.max(ex.goalSets || 0, j + 1) }, (_, k) => (ex.goalRepsBy || [])[k] || '');
    if (!text) by[j] = '';
    else { const v = parseRange(text, 100); if (v) by[j] = v; }
    ex.goalRepsBy = by;
    repsByOpen.add(ex.id);
  }
  else if (bind === 'ex-rirby') {
    const ex = edEx(i), text = el.value.trim();
    const by = Array.from({ length: Math.max(ex.goalSets || 0, j + 1) }, (_, k) => (ex.goalRirBy || [])[k] || '');
    if (!text) by[j] = '';
    else { const v = parseRange(text, 10); if (v) by[j] = v; }
    ex.goalRirBy = by;
    repsByOpen.add(ex.id);
  }
  else if (bind === 'ex-goal-sets' || bind === 'ex-goal-reps' || bind === 'ex-goal-rir') {
    // Vacío = sin objetivo; si lo escrito no es válido se mantiene lo anterior
    const ex = edEx(i), text = el.value.trim();
    const key = { 'ex-goal-sets': 'goalSets', 'ex-goal-reps': 'goalReps', 'ex-goal-rir': 'goalRir' }[bind];
    if (!text) delete ex[key];
    else if (key === 'goalSets') { const n = parseInt(text, 10); if (n >= 1 && n <= 20 && String(n) === text) ex.goalSets = n; }
    if (key === 'goalSets' && (repsByOpen.has(ex.id) || Array.isArray(ex.goalRepsBy))) {
      // Solo se agregan casillas (las nuevas copian la última); nunca se borran las que ya escribiste,
      // ni siquiera si la casilla de Series queda vacía un momento mientras escribes otro número
      const by = ex.goalRepsBy || [], last = by[by.length - 1] || ex.goalReps || '';
      ex.goalRepsBy = Array.from({ length: Math.max(by.length, ex.goalSets || 0) }, (_, k) => (k < by.length ? by[k] : last));
      // Con 1 serie vuelve la casilla Reps normal, con el rango que tenía esa serie
      if ((ex.goalSets || 0) < 2 && ex.goalRepsBy[0]) ex.goalReps = ex.goalRepsBy[0];
    }
    if (key === 'goalSets' && Array.isArray(ex.goalRirBy)) {   // lo mismo con el RIR de cada serie
      const by = ex.goalRirBy, last = by[by.length - 1] || ex.goalRir || '';
      ex.goalRirBy = Array.from({ length: Math.max(by.length, ex.goalSets || 0) }, (_, k) => (k < by.length ? by[k] : last));
      if ((ex.goalSets || 0) < 2 && ex.goalRirBy[0]) ex.goalRir = ex.goalRirBy[0];
    }
    if (key === 'goalSets') {   // se actualiza sin redibujar todo (para no cerrar el teclado)
      const cell = $app.querySelector(`.reps-cell:not(.rir-cell)[data-i="${i}"]`), wrap = $app.querySelector(`.reps-by-wrap[data-i="${i}"]`);
      const tgl = $app.querySelector(`.reps-by-toggle[data-i="${i}"]`);
      if (cell) cell.innerHTML = repsCell(ex, i);
      const rcell = $app.querySelector(`.rir-cell[data-i="${i}"]`);
      if (rcell) rcell.innerHTML = rirCell(ex, i);
      if (wrap) wrap.innerHTML = repsByOn(ex) ? repsByBlock(ex, i) : '';
      if (tgl) { tgl.hidden = !(ex.goalSets >= 2); tgl.textContent = repsByOn(ex) ? 'Usar un solo rango' : 'Distinto por serie'; }
    }
    else { const v = parseRange(text, key === 'goalReps' ? 100 : 10); if (v) ex[key] = v; }
  }
  else if (bind === 'w' || bind === 'r' || bind === 'rir') {
    const d = cur(), ex = d.exercises[i];
    ex.sets[j][bind] = el.value;
    const cell = $app.querySelector(`[data-mark="${i}-${j}"]`);
    if (cell) cell.innerHTML = markSpan(liveCmp(ex.sets[j], ex, bestSets(ex.exerciseId, beforeIndex(d), ex.unit, ex.extra ? null : d.routineId)[j]));
  }
  else if (bind === 'dw' || bind === 'dr') cur().exercises[i].sets[j].drops[+el.dataset.k][bind === 'dw' ? 'w' : 'r'] = el.value;
  else if (bind === 'note') {
    const exId = cur().exercises[i].exerciseId, text = el.value.trim();
    if (text) db.notes[exId] = text; else delete db.notes[exId];
  }
  // Anotaste series en este ejercicio: al saltar a otro, queda con ✓
  if (['w', 'r', 'rir', 'dw', 'dr'].includes(bind)) { const d = cur(); (d.touched ||= {})[d.exercises[i].exerciseId] = true; }
  save();
});

// Redibuja solo la nota (sin tocar el resto, para no perder el toque en otro botón)
function redrawNote(i) {
  const wrap = $app.querySelector(`[data-note="${i}"]`);
  if (wrap) wrap.outerHTML = noteHtml(cur().exercises[i].exerciseId, i);
}

$app.addEventListener('focusout', e => {
  // Llegaron datos de otro dispositivo mientras escribías: se muestran al terminar
  if (refreshPending) setTimeout(() => {
    if (refreshPending && !(document.activeElement && document.activeElement.matches('#app input'))) {
      refreshPending = false;
      render();
    }
  }, 300);
  const bind = e.target.dataset.bind;
  if (bind === 'note' && editingNote !== null) {
    editingNote = null;
    redrawNote(+e.target.dataset.i);
  } else if (bind === 'ex-name') {
    if (syncHistoryNames()) save();   // al terminar de escribir: el historial toma el nombre nuevo
  } else if (bind === 'ex-rest') {
    const ex = curRoutine() && edEx(+e.target.dataset.i);
    if (ex) e.target.value = ex.rest ? fmtRest(ex.rest) : '';   // muestra el tiempo como m:ss
  } else if (bind === 'pace-amt') {
    refresh();   // al salir del cuadro se recalculan las calorías
  } else if (bind === 'wq-ml') {
    refresh();   // al salir del cuadro se ven los botones rápidos actualizados
  } else if (bind === 'ex-repby' || bind === 'ex-rirby') {
    const ex = curRoutine() && edEx(+e.target.dataset.i);
    if (ex) e.target.value = (ex[bind === 'ex-repby' ? 'goalRepsBy' : 'goalRirBy'] || [])[+e.target.dataset.j] || '';
  } else if (bind && bind.startsWith('ex-goal-')) {
    // Muestra el objetivo guardado ("8 10" queda "8-10"; si no era válido vuelve a lo anterior)
    const ex = curRoutine() && edEx(+e.target.dataset.i);
    if (ex) e.target.value = { 'ex-goal-sets': ex.goalSets, 'ex-goal-reps': ex.goalReps, 'ex-goal-rir': ex.goalRir }[bind] || '';
  }
});

$app.addEventListener('focusin', e => {
  if (e.target.matches('[data-bind="myprog-name"]')) e.target.select();
});

$app.addEventListener('keydown', e => {
  const bind = e.target.dataset.bind || '';
  if (e.key === 'Enter' && (bind === 'note' || bind === 'ex-rest' || bind === 'pace-amt' || bind.startsWith('ex-goal-'))) e.target.blur();
});

$app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (viewing && !['new-routine', 'coach-comment', 'add-item', 'chat-send'].includes(f.dataset.form)) { notice(viewOnlyMsg()); return; }
  switch (f.dataset.form) {
    case 'coach-code': linkCoachForm(f); return;
    case 'coach-comment': saveCoachComment(f); return;
    case 'checkin': sendCheckin(f); return;
    case 'swap-new': swapNew(f); return;
    case 'login':
    case 'register': submitAuth(f); return;
    case 'profile': saveProfileData(f); return;
    case 'password': submitPassword(f); return;
    case 'import-code': importRoutine(f); return;
    case 'chat-send': sendText(f); return;
    case 'bodyweight': saveBodyweight(f); return;
    case 'goal': saveGoal(f); return;
    case 'bf': saveBf(f); return;
    case 'skin': saveSkinfolds(f); return;
    case 'measures': saveMeasures(f); return;
    case 'sleep': saveSleep(parseHours(f.elements.h.value), f); return;
    case 'food': saveFood(f); return;
    case 'add-item': {
      const diet = dietById(routeParts()[1]), m = +f.dataset.m, item = readFoodForm(f);
      if (!item) return;
      diet.meals[m].items.push(item);
      save(); render();
      return;
    }
    case 'extra-food': {
      const item = readFoodForm(f);
      if (item) addExtra(item);
      return;
    }
    case 'extra-manual': {
      const name = f.elements.name.value.trim(), kcal = num(f.elements.kcal.value);
      const macro = k => { const v = num(f.elements[k].value); return v != null && v >= 0 ? round1(v) : 0; };
      if (!name) return formMsg(f, 'Escribe qué comiste.');
      if (kcal == null || kcal <= 0 || kcal > 5000) return formMsg(f, 'Escribe las calorías (ej. 450).');
      addExtra({ name, kcal: Math.round(kcal), p: macro('p'), c: macro('c'), f: macro('f') });
      return;
    }
    case 'water-edit': {
      const ml = Math.round(num(f.elements.ml.value) || 0), entry = waterDay()[Number(f.dataset.k)];
      if (ml < 10 || ml > 5000) { notice('Escribe una cantidad en ml (ej. 300).'); return; }
      if (entry) entry.ml = ml;
      waterEditing = null;
      save(); render();
      return;
    }
    case 'water-custom': {
      const ml = Math.round(num(f.elements.ml.value) || 0);
      if (ml < 10 || ml > 5000) return formMsgOr(f, 'Escribe una cantidad en ml (ej. 330).');
      addWater(ml);
      return;
    }
    case 'water-goal': {
      const liters = num(f.elements.liters.value);
      if (liters == null || liters < 0.5 || liters > 10) return formMsg(f, 'Escribe tu meta en litros (ej. 3 o 2,5).');
      db.water.goalMl = Math.round(liters * 1000);
      save(); render();
      formMsg($app.querySelector('[data-form="water-goal"]'), `Meta guardada: ${fmtL(db.water.goalMl)} L`, true);
      return;
    }
  }
  const title = f.elements.title.value.trim();
  if (!title) return;
  if (f.dataset.form === 'save-as-routine') saveFreeAsRoutine(f.dataset.id, title);
  else if (f.dataset.form === 'new-routine') {
    const r = { id: uid(), name: title, exercises: [] };
    db.routines.push(r);
    save();
    go('#/rutina/' + r.id);
  } else if (f.dataset.form === 'extra-ex') {
    lastUnit = f.elements.unit.value;
    addExtraExercise(title, lastUnit);
  }
});

// ---------- Inicio ----------
// Link de rutina compartida (?r=CÓDIGO): se guarda para importarla y se limpia la dirección
const linkParams = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const isIPhone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
// Abierta dentro de Instagram, Facebook o TikTok: se avisa que hay que abrirla en Chrome o Safari.
// Se guarda el link completo (con ?g= o ?r=) para no perder la invitación al cambiar de navegador. En local: ?ig
const inAppName = /Instagram/i.test(navigator.userAgent) ? 'Instagram'
  : /FBAN|FBAV|FB_IAB|FBIOS|Messenger/i.test(navigator.userAgent) ? 'Facebook'
  : /TikTok|musical_ly|BytedanceWebview/i.test(navigator.userAgent) ? 'TikTok'
  : isLocal && linkParams.has('ig') ? 'Instagram' : null;
if (inAppName && !isInstalled && sessionStorage.getItem('desdel-inapp-ok') !== '1') {
  const u = new URL(location.href);
  u.searchParams.delete('ig'); u.hash = '';
  inApp = { app: inAppName, url: u.href, android: /Android/i.test(navigator.userAgent) || (isLocal && linkParams.has('android')) };
}
const linkCode = linkParams.get('r') || linkParams.get('g') || linkParams.get('k');   // r = rutina o dieta, g = gymbro, k = coach
if (linkCode) {
  // En Safari de iPhone (fuera de la app) se muestra el código para copiarlo; en local se prueba con ?ios
  if ((isIPhone && !isInstalled) || (isLocal && linkParams.has('ios'))) {
    handoffCode = normCode(linkCode);
    handoffGymbro = linkParams.has('g');
    handoffCoach = linkParams.has('k');
  } else localStorage.setItem(PENDING_IMPORT, normCode(linkCode));
  linkParams.delete('r');
  linkParams.delete('g');
  linkParams.delete('k');
  const qs = linkParams.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
}

render();   // pantalla de carga

window.addEventListener('online', () => { sync(); paintSync(); });
window.addEventListener('offline', paintSync);

try {
  // En el computador de desarrollo se puede probar sin Firebase con ?fake
  const fake = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('fake');
  cloud = await import(fake ? './cloud-fake.js' : './cloud.js');
  cloud.onUser(handleUser);
} catch (e) {
  console.error(e);
  status = 'fatal';
  render();
}

if ('serviceWorker' in navigator) {
  // Si llega una versión nueva de la app, recarga una vez para mostrarla (los datos ya están guardados)
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js');
}
// Pide al navegador que no borre los datos automáticamente
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
// Videos de técnica: con internet se guardan todos en el teléfono (de a uno y en segundo plano)
// para verlos sin internet. Se bajan una sola vez; los que ya no se usan se borran.
const VIDEO_CACHE = 'desdel-videos-v5';   // el mismo nombre que en sw.js
async function saveVideos() {
  if (!('caches' in window) || !navigator.onLine) return;
  try {
    const cache = await caches.open(VIDEO_CACHE);
    const want = [...new Set(GUIDES.filter(g => g.video).flatMap(g => [g.video, thumbOf(g)]).map(u => new URL(u, location.href).href))];
    const have = await cache.keys();
    for (const r of have) if (!want.includes(r.url)) await cache.delete(r);
    const saved = new Set(have.map(r => r.url));
    for (const url of want) {
      if (saved.has(url)) continue;
      if (!navigator.onLine) return;
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.status === 200) await cache.put(url, res);
    }
  } catch (e) { /* sin internet o sin espacio: se intenta de nuevo la próxima vez */ }
}
setTimeout(saveVideos, 6000);
