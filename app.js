import { BASE_FOODS, synonymsOf } from './foods-base.js';

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
const emptyDb = () => ({ routines: [], workouts: [], draft: null, notes: {}, bodyweight: [], body: {}, sleep: [], skinfolds: [], measures: [], plan: null, water: emptyWater(), nutrition: emptyNutrition() });
const emptySynced = () => ({ main: null, w: {} });
let db = emptyDb();
let user = null;                 // { uid, email, username }
let synced = emptySynced();      // último estado confirmado por la nube (para saber qué falta subir)
let cloud = null;                // módulo de conexión (cloud.js)
let status = 'booting';          // booting | signed-out | ready | load-error | fatal
let pendingUsername = null;      // nombre elegido al registrarse (Firebase lo avisa un poco después)
let pendingBody = null;          // estatura y sexo elegidos al registrarse (se guardan al entrar)
let authUser = null;             // último usuario informado por Firebase

let lastUnit = 'kg';
// Unidades de peso; "placas" es para máquinas con los números borrados (se anota cuántas placas)
const UNITS = ['kg', 'lb', 'placas'];
const unitShort = u => (u === 'placas' ? 'pl.' : u);
const unitKind = u => (u === 'placas' ? 'placas' : 'peso');
const openHistory = new Set();   // ejercicios con el historial desplegado
let editingNote = null;          // ejercicio cuya nota se está editando
let editBuf = null;              // copia de un entrenamiento guardado que se está editando
let justFinished = null;         // entrenamiento recién guardado (para mostrar el resumen)

function persistLocal() {
  if (user) localStorage.setItem(userKey(user.uid), JSON.stringify({ db, synced }));
}
function save() { persistLocal(); scheduleSync(); scheduleProfile(); }

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
function bestSets(exerciseId, before = db.workouts.length, unit = null) {
  const best = [];
  for (let k = 0; k < before; k++) {
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
  const w = num(s.w), r = num(s.r);
  if (w == null && r == null) return null;
  return cmpSet({ w, r, rir: num(s.rir), unit: ex.unit, bw: bwFor(ex, new Date().toISOString()) }, best);
}

const markSpan = c => (c == null ? '' :
  `<span class="mark ${c > 0 ? 'up' : c < 0 ? 'down' : 'eq'}">${c > 0 ? '▲' : c < 0 ? '▼' : '='}</span>`);

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

function entrenoCard() {
  const d = db.draft, t = todayKey(), plan = plannedRoutine(t);
  let body;
  if (d) body = `<a class="muted" href="#/entrenar">Entrenamiento en curso: ${esc(d.routineName)} ›</a>`;
  else if (plan === undefined) body = '<span class="muted">Rutinas · Historial · Progreso</span>';
  else if (plan === null) body = '<span class="muted">Hoy: descanso</span>';
  else if (trainedOn(t, plan.id)) body = `<span class="muted">Hoy ya entrenaste <strong>${esc(plan.name)}</strong></span>`;
  else body = `<div class="hub-value">Hoy te toca: <strong>${esc(plan.name)}</strong></div>
      <button class="btn primary" data-action="start" data-id="${plan.id}" ${plan.exercises.length ? '' : 'disabled'}>Empezar</button>`;
  return `<div class="card hub">
      <a class="hub-top" href="#/rutinas"><span class="hub-icon">🏋️</span><strong>Entreno</strong><span class="chev">›</span></a>
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
  const planned = db.plan ? days.filter(d => d.planned).length : null;

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
  const s = weekSummary(weekOffset);
  const stat = (label, value, sub = '') => `<div class="wk-stat"><span class="muted small">${label}</span><strong>${value}</strong>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>`;
  const stats = [
    stat('Peso promedio', s.kg != null ? fmtKg(s.kg) : '—', s.kg != null && s.kgPrev != null ? (Math.abs(s.kg - s.kgPrev) < 0.05 ? 'igual que la anterior' : `${signed(s.kg - s.kgPrev)} kg vs la anterior`) : ''),
    stat('Sueño promedio', s.sleep != null ? fmtH(s.sleep) : '—'),
    stat('Meta de agua', `${s.water} de ${s.past} días`),
    ...(N().diets.length ? [stat('Dieta completa', `${s.dietOk} de ${s.past} días`)] : []),
  ];
  return `<section class="card hub week-card">
      <div class="hub-top"><span class="hub-icon">📅</span><strong>Tu semana</strong>
        <div class="range wk-range" role="group" aria-label="Semana">${[[0, 'Esta'], [1, 'Pasada']].map(([w, label]) =>
          `<button class="${w === weekOffset ? 'on' : ''}" data-action="week-sum" data-w="${w}">${label}</button>`).join('')}</div></div>
      <div class="wk-train">
        <span><strong>${s.planned != null ? `${s.done} de ${s.planned}` : s.done}</strong> ${s.planned != null ? 'entrenos del plan' : s.done === 1 ? 'entreno' : 'entrenos'}</span>
        <div class="wk-days" aria-hidden="true">${s.days.map((d, k) =>
          `<span class="wk-day ${d.trained ? 'done' : d.planned && !d.future ? 'missed' : d.planned ? 'planned' : ''}">${WEEK_LETTERS[k]}</span>`).join('')}</div>
      </div>
      <div class="wk-stats">${stats.join('')}</div>
      ${s.prs.length ? `<span class="muted small">${s.prs.length === 1 ? 'Récord' : `${s.prs.length} récords`}: <strong class="wk-prs">${s.prs.map(esc).join(', ')}</strong></span>` : ''}
    </section>`;
}

function viewHub() {
  maybeAskSleep();
  const d = db.draft;
  const ml = waterToday(), goal = waterGoal().ml, streak = waterStreak();
  return `${header('Desdel', { sub: 'Entrena. Anota. Supera.', right: GEAR })}
    <div class="hub-wrap">
    ${entrenoCard()}

    ${nutritionCard()}

    ${socialCard()}

    <div class="card hub">
      <a class="hub-top" href="#/agua"><span class="hub-icon">💧</span><strong>Agua</strong>${streak >= 2 ? `<span class="badge on" title="Días seguidos cumpliendo tu meta">🔥 ${streak}</span>` : ''}<span class="chev">›</span></a>
      <a class="hub-value" href="#/agua"><strong>${fmtL(ml)} / ${fmtL(goal)}</strong> L${ml >= goal ? ' · ¡Meta cumplida! 🎉' : ''}</a>
      ${bar(ml, goal)}
      <div class="ex-actions">
        ${waterQuick().map(q => `<button class="btn" data-action="water-add" data-ml="${q.ml}">+${q.ml} ml</button>`).join('')}
      </div>
    </div>

    <div class="hub-pair">${bodyweightCard()}${sleepCard()}</div>

    ${weekCard()}
    </div>
    ${sleepAsk ? sleepModal() : ''}`;
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
      <span class="muted small">Cada día la app elige sola la dieta de la rutina que te toca en <a href="#/plan">Mi plan</a> (o la que entrenaste), o la de descanso.${db.plan ? '' : ' Para saber qué días son de descanso, arma tu plan.'}</span>
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
const bodyTabs = active => `<div class="range" role="tablist">${[['peso', 'Peso'], ['grasa', '% Grasa'], ['medidas', 'Medidas'], ['fotos', 'Fotos']]
  .map(([k, label]) => `<a class="${k === active ? 'on' : ''}" href="#/${k}" role="tab">${label}</a>`).join('')}</div>`;
const nutriTabs = active => `<div class="range" role="tablist">${[['', 'Hoy'], ['dietas', 'Mis dietas'], ['alimentos', 'Mis alimentos']]
  .map(([k, label]) => `<a class="${k === active ? 'on' : ''}" href="#/nutricion${k ? `/${k}` : ''}" role="tab">${label}</a>`).join('')}</div>`;

function viewNutrition(section) {
  if (section === 'alimentos') return viewFoods();
  if (section === 'dietas') return viewDiets();
  const { diet, done, eaten, goal, auto, manual } = todayNutrition();
  const head = `${header('Nutrición', { home: true })}${nutriTabs('')}`;
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
  return `${header('Nutrición', { home: true })}${nutriTabs('alimentos')}
    <a class="btn primary block center" href="#/alimento/nuevo" style="margin:0 0 12px">+ Nuevo alimento</a>
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
    if (changed && used) alert(`Cambiaste "${name}" a ${unit ? 'por unidad' : 'por 100 g'}. Revisa las cantidades en tus dietas: ahora se cuentan en ${unit ? 'unidades' : 'gramos'}.`);
  } else {
    N().foods.push({ id: uid(), ...data });
  }
  save();
  history.back();
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
  return `${header('Nutrición', { home: true })}${nutriTabs('dietas')}
    ${targetBanner()}
    ${averageCard()}
    <button class="btn primary block" data-action="diet-new" style="margin:0 0 12px">+ Crear dieta</button>
    ${list || `<p class="empty">${N().foods.length ? 'Crea tu primera dieta.' : 'Primero agrega tus alimentos en <a href="#/nutricion/alimentos">Mis alimentos</a>.'}</p>`}
    ${importForm('Importar dieta con código')}`;
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
        <button class="icon small danger" data-action="item-del" data-m="${mi}" data-i="${ii}" aria-label="Quitar">✕</button>
      </div>`;
    }).join('');
    return `<section class="card meal-edit">
      <div class="meal-title">
        <input class="grow" data-bind="meal-name" data-m="${mi}" value="${esc(meal.name)}" aria-label="Nombre de la comida">
        <button class="icon small" data-action="meal-dup" data-m="${mi}" aria-label="Duplicar comida" title="Duplicar comida">⧉</button>
        <button class="icon small danger" data-action="meal-del" data-m="${mi}" aria-label="Eliminar comida">✕</button>
      </div>
      ${items || '<p class="muted small" style="margin:6px 0">Agrega alimentos a esta comida.</p>'}
      <form class="add-item" data-form="add-item" data-m="${mi}" novalidate>
        <div class="add-row" style="margin-top:0">
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
  const t = todayNutrition();
  return `<a class="card hub" href="#/nutricion">
    <div class="hub-top"><span class="hub-icon">🍽️</span><strong>Nutrición</strong><span class="chev">›</span></div>
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
  const cmp = Math.abs(diff) < 50 ? 'tu dieta calza' : `tu dieta ${diff > 0 ? '+' : '−'}${fmtKcal(Math.abs(diff))}`;
  return `<a class="target-line" href="#/objetivo">Objetivo calculado: <strong>${fmtKcal(ct.target)} kcal</strong> · ${cmp} ›</a>`;
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
        <button class="icon small danger" data-action="extra-del" data-id="${x.id}" aria-label="Quitar extra">✕</button></span>
    </div>`;
  }).join('');
  const form = extraMode === 'food'
    ? `<form class="add-item" data-form="extra-food" novalidate>
        <div class="add-row" style="margin-top:0">
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
function readFoodForm(f) {
  const typed = normText(f.elements.q.value.trim());
  const exact = typed && [...N().foods, ...BASE_FOODS].find(x => normText(x.name) === typed);
  const foodId = f.dataset.food || (exact && exact.id), g = num(f.elements.g.value);
  if (!foodId) { alert('Busca el alimento y elígelo de la lista.'); f.elements.q.focus(); return null; }
  const food = foodById(foodId), portions = !!food.unitG && f.dataset.mode === 'u' && f.dataset.food === foodId;
  const count = isUnit(food) || portions;
  if (g == null || g <= 0 || g > (count ? 100 : 5000)) { alert(count ? 'Escribe la cantidad (ej. 2).' : 'Escribe los gramos (ej. 120).'); f.elements.g.focus(); return null; }
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
          <button class="icon small danger" data-action="water-del" data-k="${k}" aria-label="Borrar">✕</button>
        </span>
      </div>`)).reverse().join('');

  // Últimos 7 días
  const days = [];
  for (let k = 6; k >= 0; k--) {
    const d = new Date(); d.setDate(d.getDate() - k);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const total = waterDay(key).reduce((a, e) => a + e.ml, 0);
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

    <h2>Últimos 7 días</h2>
    <section class="card">${days.join('')}</section>

    ${sectionHead('agua-ajustes', 'Ajustes: botones rápidos y meta diaria')}
    ${openSections.has('agua-ajustes') ? `
    <h2>Botones rápidos</h2>
    <section class="card stack">
      <p class="muted small" style="margin:0">Pon los ml de tu vaso, botella o shaker para anotar de un toque.</p>
      ${quick.map((q, k) => `<div class="add-row quick-row" style="margin-top:0">
        <span class="grow muted">Botón ${k + 1}</span>
        <input class="grams" data-bind="wq-ml" data-k="${k}" inputmode="numeric" value="${q.ml}" autocomplete="off" aria-label="Cantidad en ml del botón ${k + 1}">
        <span class="unit-label">ml</span>
        <button class="icon small danger" data-action="wq-del" data-k="${k}" ${quick.length <= 1 ? 'disabled' : ''} aria-label="Quitar botón">✕</button>
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
function lastFor(exerciseId, before = db.workouts.length) {
  for (let i = before - 1; i >= 0; i--) {
    const w = db.workouts[i];
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

// Series prellenadas con la última vez (peso, reps y RIR si el ejercicio lo usa)
// Series al empezar: las de la última vez (o una vacía); si el objetivo pide más series, se agregan vacías
function prefillSets(prev, rir, goalSets = 0, dropset = false) {
  const empty = () => ({ w: '', r: '', ...(rir ? { rir: '' } : {}) });
  const sets = prev ? prev.ex.sets.map(s => ({
    w: toField(s.w), r: toField(s.r), ...(rir ? { rir: toField(s.rir) } : {}),
    ...(s.drops && s.drops.length ? { drops: s.drops.map(x => ({ w: toField(x.w), r: toField(x.r) })) } : {}),
  })) : [];
  while (sets.length < Math.max(1, goalSets || 0)) sets.push(empty());
  // Dropset: la última serie trae lista una fila para la primera bajada
  const lastSet = sets[sets.length - 1];
  if (dropset && !(lastSet.drops && lastSet.drops.length)) lastSet.drops = [{ w: '', r: '' }];
  return sets;
}

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
const planFields = ex => ({ ...goalFields(ex), ...(ex.dropset ? { dropset: true } : {}), ...(ex.ssNext ? { ssNext: true } : {}), ...(ex.bw ? { bw: true } : {}) });
const goalFields = ex => ({
  ...(ex.goalSets ? { goalSets: ex.goalSets } : {}),
  ...(ex.goalReps ? { goalReps: ex.goalReps } : {}),
  ...(ex.goalRir ? { goalRir: ex.goalRir } : {}),
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
  const planCard = `<a class="card plan-card" href="#/plan">
      <div class="grow"><strong>Mi plan</strong>
        <span class="muted small">${todays === undefined ? 'Arma tu calendario: qué rutina te toca cada día'
          : `${todays ? `Hoy te toca: ${esc(todays.name)}` : 'Hoy: descanso'} · se repite cada ${plural(db.plan.weeks, 'semana')}`}</span></div>
      <span class="chev">›</span>
    </a>`;
  const routines = db.routines.map((r, i) => `
    <div class="card routine">
      <a href="#/rutina/${r.id}">
        <strong>${esc(r.name) || '(sin nombre)'}${todays && todays.id === r.id ? ' <span class="badge on">Hoy</span>' : ''}</strong>
        <span class="muted">${plural(r.exercises.length, 'ejercicio')} · editar</span>
      </a>
      ${last > 0 ? `<div class="order">
        <button class="icon small" data-action="move-routine" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir rutina">↑</button>
        <button class="icon small" data-action="move-routine" data-i="${i}" data-d="1" ${i === last ? 'disabled' : ''} aria-label="Bajar rutina">↓</button>
      </div>` : ''}
      <button class="btn primary" data-action="start" data-id="${r.id}" ${r.exercises.length ? '' : 'disabled'}>Empezar</button>
    </div>`).join('');
  return `${header('Rutinas', { home: true })}
    ${resume}
    ${planCard}
    ${routines || '<p class="empty">Aún no tienes rutinas. Crea la primera abajo.</p>'}
    <form class="add-row" data-form="new-routine">
      <input name="title" placeholder="Nueva rutina (ej. Brazo)" autocomplete="off" required>
      <button class="btn">Crear</button>
    </form>
    ${importForm('Importar rutina con código')}`;
}

// Formulario para pegar un código (sirve tanto para rutinas como para dietas)
const importForm = label => `<section class="import-box">
    <div class="muted small">${label}</div>
    ${importOpen ? `
    <form class="stack" data-form="import-code" novalidate>
      <div class="add-row">
        <input name="code" placeholder="Código (ej. K7P-9XQ)" autocomplete="off" autocapitalize="characters" maxlength="9" aria-label="Código">
        <button class="btn">Importar</button>
      </div>
      <p class="muted small" style="margin:0">Escribe el código que te pasaron y toca Importar.</p>
      <p class="form-msg" hidden></p>
    </form>`
    : '<button class="btn block" data-action="paste-import">📋 Pegar código</button>'}
  </section>`;

// Saca el código de lo copiado: el código solo ("K7P-9XQ"), el link (?r=K7P9XQ) o el mensaje completo
function codeFromText(text) {
  const t = (text || '').toUpperCase();
  const m = t.match(/[?&][RG]=([A-Z0-9]{6})\b/) || t.match(/\b([A-Z0-9]{3})-([A-Z0-9]{3})\b/) || t.trim().match(/^([A-Z0-9]{3})\s*-?\s*([A-Z0-9]{3})$/);
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

// "4 × 8-10 · RIR 2 · Dropset · Rest 1:30"
function exSummary(ex) {
  const parts = [];
  if (ex.goalSets && ex.goalReps) parts.push(`${ex.goalSets} × ${ex.goalReps}`);
  else if (ex.goalSets) parts.push(plural(ex.goalSets, 'serie'));
  else if (ex.goalReps) parts.push(`${ex.goalReps} reps`);
  if (ex.rir) parts.push(ex.goalRir ? `RIR ${ex.goalRir}` : 'Con RIR');
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
  const items = r.exercises.map((ex, i) => (openEx === i ? `
    <li class="card ex-open">
      <input class="grow" data-bind="ex-name" data-i="${i}" value="${esc(ex.name)}" aria-label="Nombre del ejercicio">
      <button class="chip" data-action="toggle-unit" data-i="${i}" aria-label="Cambiar unidad">${ex.unit}</button>
      <button class="icon" data-action="move" data-i="${i}" data-d="-1" ${blockOf(i) === 0 ? 'disabled' : ''} aria-label="Subir">↑</button>
      <button class="icon" data-action="move" data-i="${i}" data-d="1" ${blockOf(i) === blocks.length - 1 ? 'disabled' : ''} aria-label="Bajar">↓</button>
      <button class="icon danger" data-action="del-ex" data-i="${i}" aria-label="Quitar">✕</button>
      <div class="ex-goals" aria-label="Objetivo (opcional)">
        <label>Series<input data-bind="ex-goal-sets" data-i="${i}" inputmode="numeric" value="${ex.goalSets || ''}" placeholder="–" autocomplete="off" aria-label="Series objetivo"></label>
        <label>Reps<input data-bind="ex-goal-reps" data-i="${i}" inputmode="decimal" value="${esc(ex.goalReps || '')}" placeholder="8-10" autocomplete="off" aria-label="Rango de repeticiones objetivo"></label>
        ${ex.rir   // con RIR activado se escribe el RIR objetivo; sin RIR, la serie va al fallo
          ? `<label>RIR obj.<input data-bind="ex-goal-rir" data-i="${i}" inputmode="decimal" value="${esc(ex.goalRir || '')}" placeholder="–" autocomplete="off" aria-label="RIR objetivo"></label>`
          : '<div class="goal-fixed-wrap"><span>Hasta</span><span class="goal-fixed" title="Activa RIR para poner un RIR objetivo">Fallo</span></div>'}
        <label>Rest<input data-bind="ex-rest" data-i="${i}" value="${ex.rest ? fmtRest(ex.rest) : ''}" placeholder="m:ss" autocomplete="off" aria-label="Descanso entre series"></label>
      </div>
      <div class="ex-toggles">
        <button class="chip toggle ${ex.rir ? 'on' : ''}" data-action="toggle-rir" data-i="${i}" aria-pressed="${!!ex.rir}">RIR</button>
        <button class="chip toggle ${ex.dropset ? 'on' : ''}" data-action="toggle-drop" data-i="${i}" aria-pressed="${!!ex.dropset}">Dropset</button>
        <button class="chip toggle ${ex.bw ? 'on' : ''}" data-action="toggle-bw" data-i="${i}" aria-pressed="${!!ex.bw}" title="Dominadas, dips…: lo que anotas es el lastre">Peso corporal</button>
      </div>
      ${i < last ? `<button class="chip toggle ss-toggle ${ex.ssNext ? 'on' : ''}" data-action="toggle-ss" data-i="${i}" aria-pressed="${!!ex.ssNext}">🔗 ${ex.ssNext ? 'En superset con el siguiente' : 'Hacer superset con el siguiente'}</button>` : ''}
      <button class="btn block ex-done" data-action="ex-close">Listo</button>
    </li>`
    : `
    <li class="card ex-closed" data-action="ex-open" data-i="${i}" role="button" tabindex="0">
      <div class="grow"><strong>${esc(ex.name) || '(sin nombre)'}</strong><span class="muted small">${exSummary(ex)}</span></div>
      <span class="chev">›</span>
    </li>`)
    + (i < last && ex.ssNext ? '<li class="ss-join">🔗 Superset</li>' : '')).join('');
  return `${header('Editar rutina', { back: true })}
    <label class="field"><span>Nombre de la rutina</span>
      <input data-bind="routine-name" value="${esc(r.name)}" autocomplete="off">
    </label>
    <h2>Ejercicios</h2>
    <ul class="list ex-edit">${items || '<p class="empty">Agrega los ejercicios de esta rutina.</p>'}</ul>
    <form class="add-row" data-form="new-ex">
      <input name="title" placeholder="Nombre del ejercicio" autocomplete="off" required>
      ${unitSelect()}
      <button class="btn">Agregar</button>
    </form>
    ${shareBox(r.id, 'Tu amigo toca el link y la rutina se le agrega sola (o ingresa el código en Rutinas → "Importar rutina con código"). Solo se comparten los ejercicios, el Rest y los objetivos, no tus pesos ni tu historial.')
      || '<button class="btn block" data-action="share-routine" style="margin-top:32px">Compartir rutina</button>'}
    <button class="btn block" data-action="dup-routine">Duplicar rutina</button>
    <button class="btn ghost block danger-text" data-action="del-routine">Eliminar rutina</button>`;
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

function viewWorkout() {
  const d = cur();
  if (!d) { location.replace(isEditing() ? '#/historial' : '#/rutinas'); return ''; }
  const editing = !!d.editOf;
  const before = beforeIndex(d);

  // Un bloque a la vez (un ejercicio, o varios si van en superset): d.pos es un ejercicio del bloque en pantalla
  // y d.done los ejercicios que ya pasaste con "Siguiente"
  const groups = groupsOf(d);
  d.pos = Math.min(Math.max(d.pos || 0, 0), d.exercises.length - 1);
  d.done = d.done || [];
  const gi = groupIndex(groups, d.pos), group = groups[gi], isLast = gi === groups.length - 1;
  const bests = new Map(group.map(k => [k, bestSets(d.exercises[k].exerciseId, before, d.exercises[k].unit)]));

  // "↓ drop" solo en ejercicios marcados como Dropset en la rutina (o que ya tienen bajadas, al editar uno guardado)
  const canDrop = ex => ex.dropset || ex.sets.some(st => st.drops && st.drops.length);
  // Fila de una serie, con sus bajadas de dropset debajo (label: "1", o "A1" en un superset)
  const setRow = (ex, i, s, j, label) => {
    const best = bests.get(i);
    const drops = (s.drops || []).map((x, k) => `
      <div class="set drop ${ex.rir ? 'has-rir' : ''}">
        <span class="n">↓</span>
        <input inputmode="decimal" data-bind="dw" data-i="${i}" data-j="${j}" data-k="${k}" value="${esc(x.w)}" placeholder="${ex.unit === 'placas' ? 'placas' : 'peso'}" aria-label="Peso bajada ${k + 1} de la serie ${label}">
        <span class="u">${unitShort(ex.unit)}</span>
        <span class="x">×</span>
        <input inputmode="numeric" data-bind="dr" data-i="${i}" data-j="${j}" data-k="${k}" value="${esc(x.r)}" placeholder="reps" aria-label="Repeticiones bajada ${k + 1} de la serie ${label}">
        ${ex.rir ? '<span></span>' : ''}
        <span></span>
        <button class="icon danger" data-action="del-drop" data-i="${i}" data-j="${j}" data-k="${k}" aria-label="Quitar bajada">✕</button>
      </div>`).join('');
    return `
      <div class="set ${ex.rir ? 'has-rir' : ''}">
        <span class="n">${label}</span>
        <input inputmode="decimal" data-bind="w" data-i="${i}" data-j="${j}" value="${esc(s.w)}" placeholder="${ex.unit === 'placas' ? 'placas' : isBwEx(ex) ? 'lastre' : 'peso'}" aria-label="${ex.unit === 'placas' ? 'Placas' : isBwEx(ex) ? 'Lastre' : 'Peso'} serie ${label}">
        <span class="u">${unitShort(ex.unit)}</span>
        <span class="x">×</span>
        <input inputmode="numeric" data-bind="r" data-i="${i}" data-j="${j}" value="${esc(s.r)}" placeholder="reps" aria-label="Repeticiones serie ${label}">
        ${ex.rir ? `<input class="rir" inputmode="numeric" data-bind="rir" data-i="${i}" data-j="${j}" value="${esc(s.rir ?? '')}" placeholder="RIR" aria-label="RIR serie ${label}">` : ''}
        <span class="mark-cell" data-mark="${i}-${j}">${markSpan(liveCmp(s, ex, best[j]))}</span>
        <button class="icon danger" data-action="del-set" data-i="${i}" data-j="${j}" aria-label="Borrar serie">✕</button>
      </div>
      ${drops}
      <div class="set-ref"><span>${best[j] ? `Mejor: ${fmtNum(best[j].w)} ${best[j].unit} × ${fmtNum(best[j].r)}` : ''}</span>
        ${canDrop(ex) ? `<button class="drop-add" data-action="add-drop" data-i="${i}" data-j="${j}">↓ drop</button>` : ''}</div>`;
  };

  // Objetivo de la rutina (si tiene), aviso para subir el peso, nota y "Primera vez"
  const exInfo = (ex, i) => {
    // Sin RIR activado se va al fallo (se muestra junto al resto del objetivo)
    const goals = [['Series', ex.goalSets], ['Reps', ex.goalReps]].filter(([, v]) => v);
    if (ex.rir && ex.goalRir) goals.push(['RIR', ex.goalRir]);
    else if (!ex.rir && goals.length) goals.push(['Hasta', 'Fallo']);
    let hint = '';
    if (!editing && ex.goalReps) {
      const prev = lastFor(ex.exerciseId, before), top = rangeTop(ex.goalReps);
      const done = prev ? prev.ex.sets.filter(x => x.w != null) : [];
      if (done.length && done.length >= (ex.goalSets || 1) && done.every(x => (x.r || 0) >= top)) {
        hint = `<p class="goal-hint">💡 La última vez llegaste a ${top} reps en todas las series: prueba subir el peso.</p>`;
      }
    }
    return `${goals.length ? `<div class="goal-chips">${goals.map(([k, v]) => `<span class="goal-chip"><small>${k}</small>${esc(String(v))}</span>`).join('')}</div>` : ''}
      ${hint}
      ${noteHtml(ex.exerciseId, i)}
      ${bests.get(i).length ? '' : '<p class="prev">Primera vez</p>'}`;
  };
  const historyHtml = ex => historyFor(ex.exerciseId, d.editOf).map(({ w, ex: pex }) => `
      <div class="hist-item">
        <div class="muted">${fmtDate(w.date)}</div>
        ${setsChips(pex)}
      </div>`).join('') || '<p class="muted">Aún no hay historial de este ejercicio.</p>';
  // pre: letra del ejercicio en un superset ("A "), para saber de cuál es cada descanso
  const restBtn = (i, pre = '') => (!editing && d.exercises[i].rest
    ? `<button class="btn ghost" data-action="rest" data-i="${i}" data-rest="${i}" data-pre="${pre}">Rest ${pre}${fmtRest(d.exercises[i].rest)}</button>` : '');
  const dropBadge = ex => (ex.dropset ? '<span class="badge on">Dropset</span>' : '');

  const exerciseBlock = (ex, i) => {
    const open = openHistory.has(ex.exerciseId);
    return `<section class="card" data-ex="${i}">
      <div class="ex-head"><strong>${esc(ex.name)}</strong>${dropBadge(ex)}</div>
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
    return `<section class="card superset" data-ex="${idx[0]}">
      <div class="ss-tag">🔗 Superset · alterna una serie de cada uno</div>
      ${idx.map((k, n) => `<div class="ss-ex">
        <div class="ex-head"><strong>${letterOf(n)} · ${esc(d.exercises[k].name)}</strong>${dropBadge(d.exercises[k])}</div>
        ${exInfo(d.exercises[k], k)}
      </div>`).join('')}
      <div class="sets">${rows}</div>
      <div class="ex-actions">
        <button class="btn ghost" data-action="add-round" data-i="${idx[0]}">+ vuelta</button>
        ${idx.map((k, n) => restBtn(k, `${letterOf(n)} `)).join('')}
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
  return `${header(title, { back: true, sub: `Ejercicio ${gi + 1} de ${groups.length} · ${fmtDate(d.start)}` })}
    ${steps}
    ${group.length > 1 ? supersetBlock(group) : exerciseBlock(d.exercises[group[0]], group[0])}
    ${nav}
    ${isLast ? `
    <form class="add-row" data-form="extra-ex">
      <input name="title" placeholder="+ Ejercicio extra" autocomplete="off" required>
      ${unitSelect()}
      <button class="btn">Agregar</button>
    </form>
    <div class="actions">
      ${editing
        ? '<button class="btn ghost block" data-action="back">Cancelar</button>'
        : '<button class="btn ghost block danger-text" data-action="discard">Descartar entrenamiento</button>'}
    </div>` : ''}
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

  return `${header('Historial', { home: true })}
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

const formMsgOr = (f, text) => (f.querySelector('.form-msg') ? formMsg(f, text) : alert(text));

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
const shareText = ({ name, code, kind }) => kind === 'diet'
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
        alert(e.code === 'auth/network-request-failed'
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
  if (!r.exercises.length) { alert('Agrega ejercicios a la rutina antes de compartirla.'); return; }
  // Solo se comparten los ejercicios: sin pesos, historial ni notas
  await shareWithCode(btn, { routine: routinePayload(r) }, { id: r.id, name: r.name, kind: 'routine' });
}
const routinePayload = r => ({ name: r.name, exercises: r.exercises.map(ex => ({ name: ex.name, unit: ex.unit, rest: ex.rest || 0, rir: !!ex.rir, ...planFields(ex) })) });

// Se comparten las comidas con sus cantidades y los alimentos propios que usa (los de la base ya los tiene todo el mundo)
async function shareDiet(btn) {
  const d = dietById(routeParts()[1]);
  if (!d.meals.some(m => m.items.length)) { alert('Agrega alimentos a la dieta antes de compartirla.'); return; }
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
    () => importByCode(normCode(f.elements.code.value), text => formMsg(f, text)));
}

// Se abrió un link de rutina compartida: se importa apenas haya sesión
async function importFromLink() {
  const code = localStorage.getItem(PENDING_IMPORT);
  if (!code) return;
  localStorage.removeItem(PENDING_IMPORT);
  await importByCode(code, text => alert(text));
}

async function importByCode(code, showError) {
  if (code.length !== 6) return showError('El código tiene 6 caracteres (ej. K7P-9XQ).');
  let data;
  try {
    data = await withTimeout(cloud.getShared(code));
  } catch (e) {
    return showError(e.code === 'auth/network-request-failed' || !navigator.onLine
      ? 'Se necesita internet para importar.' : 'No se pudo buscar el código. Intenta de nuevo.');
  }
  if (!data || !(data.routine || data.diet)) {
    let inv = null;
    try { inv = await withTimeout(cloud.getInvite(code)); } catch (e) { /* sin internet: se avisa abajo */ }
    if (inv) return addGymbro(code, inv, showError);
    return showError('No existe ninguna rutina, dieta ni gymbro con ese código.');
  }
  if (data.diet) return importDiet(data);
  importRoutineData(data);
}

function importRoutineData(data) {
  const r = data.routine;
  const repeated = db.routines.some(x => sameName(x.name, r.name))
    ? `\n\nYa tienes una rutina llamada "${r.name}"; se agregará otra.` : '';
  if (!confirm(`¿Agregar la rutina "${r.name}"${data.ownerName ? ` de ${data.ownerName}` : ''} (${plural(r.exercises.length, 'ejercicio')})?${repeated}`)) return;
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

function importDiet(data) {
  const d = data.diet, from = data.ownerName || '';
  const kcal = sharedDietKcal(d);
  const repeated = N().diets.some(x => sameName(x.name, d.name)) ? `\n\nYa tienes una dieta llamada "${d.name}"; se agregará otra.` : '';
  if (!confirm(`¿Agregar la dieta "${d.name}"${from ? ` de ${from}` : ''} (${plural(d.meals.length, 'comida')}, ${fmtKcal(kcal)} kcal)?${repeated}`)) return;
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
let handoffCode = null, handoffGymbro = false;
function viewHandoff() {
  return `<div class="auth handoff">${logoImg}
    <p><strong>${handoffGymbro ? 'Te invitaron a ser gymbro en Desdel 💪' : 'Te compartieron una rutina o una dieta'}</strong></p>
    <div class="code">${fmtCode(handoffCode)}</div>
    <button class="btn primary block" data-action="handoff-copy">📋 Copiar código</button>
    <ol class="handoff-steps">
      <li>Toca <strong>Copiar código</strong>.</li>
      <li>Abre <strong>Desdel</strong> desde tu pantalla de inicio.</li>
      <li>${handoffGymbro ? 'En <strong>Social → Agregar gymbro</strong>' : 'En <strong>Rutinas</strong> o en <strong>Nutrición → Mis dietas</strong>'} toca <strong>📋 Pegar código</strong>.</li>
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
    const best = bestSets(ex.exerciseId, k, ex.unit);
    const count = { up: 0, eq: 0, down: 0 };
    const chips = ex.sets.map((s, j) => {
      const c = best[j] ? cmpSet({ ...s, unit: ex.unit, bw: bwFor(ex, w.date) }, best[j]) : null;
      if (c != null) count[c > 0 ? 'up' : c < 0 ? 'down' : 'eq']++;
      return `<span>${setText(s, ex.unit)} ${markSpan(c)}</span>`;
    }).join('');
    const tally = !best.length ? '<span class="muted">Primera vez</span>'
      : [count.up && `<span class="mark up">${count.up} ▲</span>`,
         count.eq && `<span class="mark eq">${count.eq} =</span>`,
         count.down && `<span class="mark down">${count.down} ▼</span>`].filter(Boolean).join(' ')
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
      <div class="legend-line muted small"><span class="mark up">▲</span> superaste · <span class="mark eq">=</span> igualaste · <span class="mark down">▼</span> bajo tu récord</div>
    </section>`;

  return `${header(w.routineName, { back: true, sub: fmtLongDate(w.date) })}
    ${summary}
    ${prsSent && prsSent.id === w.id ? `<p class="pr-note">🔥 ¡${prsSent.n === 1 ? 'Nuevo PR' : `${prsSent.n} PRs nuevos`}! Se lo avisamos a tus gymbros.</p>` : ''}
    <button class="btn primary block" data-action="share-workout" data-id="${w.id}" style="margin:0 0 10px">📤 Compartir entrenamiento</button>
    ${blocks}
    <a class="btn block center" href="#/editar/${w.id}">Editar entrenamiento</a>
    <button class="btn ghost block danger-text" data-action="del-session" data-id="${w.id}" style="margin-top:24px">Eliminar este entrenamiento</button>`;
}

// Mensaje para WhatsApp con el resumen de un entrenamiento guardado
function workoutShareText(w, forChat = false) {
  const k = db.workouts.indexOf(w);
  let ups = 0;
  const lines = w.exercises.map(ex => {
    const best = bestSets(ex.exerciseId, k, ex.unit);
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
  if (screen === '' || screen === 'social') refresh();
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
  stopChats(); stopChats = () => {};
  closeMessages();
  chats = []; chatsLoaded = false;
}

function socialCard() {
  const n = chats.filter(isUnread).length;
  return `<a class="card hub" href="#/social">
      <div class="hub-top"><span class="hub-icon">👥</span><strong>Social</strong>${n ? `<span class="badge on">${n}</span>` : ''}<span class="chev">›</span></div>
      <span class="muted">${n ? `${plural(n, 'chat')} con mensajes nuevos` : chats.length ? `${plural(chats.length, 'gymbro')} · Chatea y comparte` : 'Agrega a tus gymbros y chatea con ellos'}</span>
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
  return `${header('Social', { home: true, sub: 'Chatea con tus gymbros' })}
    <div class="social-top">
      <a class="btn primary center" href="#/gymbro">+ Agregar gymbro</a>
      <a class="btn center" href="#/perfil/yo">Mi perfil</a>
    </div>
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
          <button class="btn" data-action="copy-invite">Copiar link</button>
        </div>`
      : inviteError ? '<p>No se pudo crear tu código. Revisa tu internet.</p><button class="btn primary" data-action="make-invite">Reintentar</button>'
      : '<p class="muted">Creando tu código…</p>'}
      <p class="muted hint">Mándale tu link a un amigo. Cuando lo toque quedan conectados como gymbros y pueden chatear. Solo puede agregarte quien tenga tu código.</p>
    </section>
    ${importForm('¿Te pasaron un código de gymbro?')}`;
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
    if (!confirm(`¿Agregar a ${inv.ownerName || 'este usuario'} como gymbro?`)) return;
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
      <button class="btn ghost block" data-action="attach-close">Cancelar</button>
    </section>`;
  }
  const items = attach === 'diet'
    ? N().diets.map(d => [d.id, d.name, `${plural(d.meals.length, 'comida')} · ${fmtKcal(dietMacros(d).kcal)} kcal`])
    : attach === 'routine'
      ? db.routines.filter(r => r.exercises.length).map(r => [r.id, r.name || '(sin nombre)', plural(r.exercises.length, 'ejercicio')])
      : db.workouts.slice(-20).reverse().map(w => [w.id, w.routineName, fmtDate(w.date)]);
  const title = { diet: '¿Qué dieta?', routine: '¿Qué rutina?', workout: '¿Qué entrenamiento?' }[attach];
  const none = { diet: 'Todavía no tienes dietas.', routine: 'Todavía no tienes rutinas con ejercicios.', workout: 'Todavía no tienes entrenamientos guardados.' }[attach];
  return `<section class="card attach">
      <div class="muted small">${title}</div>
      ${items.map(([id, name, sub]) => `<button class="btn block attach-item" data-action="attach-send" data-id="${id}">
        <span class="grow">${esc(name)}</span><span class="muted small">${esc(sub)}</span></button>`).join('') || `<p class="muted">${none}</p>`}
      <button class="btn ghost block" data-action="attach-close">Cancelar</button>
    </section>`;
}

function sendMsg(chatId, msg, preview) {
  return cloud.sendMessage(chatId, { from: user.uid, ...msg }, preview.slice(0, 120))
    .catch(() => alert('No se pudo enviar el mensaje. Revisa tu internet e intenta de nuevo.'));
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
      .catch(() => alert('No se pudo editar el mensaje. Revisa tu internet e intenta de nuevo.'));
  }
  render();
}

function sendAttachment(id) {
  const chatId = routeParts()[1];
  if (attach === 'diet') {
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
  cloud.deleteMessage(chatId, id, last).catch(() => alert('No se pudo eliminar el mensaje. Revisa tu internet e intenta de nuevo.'));
}

// Agregar a tu app la dieta o rutina que te mandaron
function addFromMessage(id) {
  const m = chatMsgs.list.find(x => x.id === id);
  const c = chats.find(x => x.id === chatMsgs.id);
  if (!m) return;
  const data = { ownerName: c ? gymbroName(c) : '' };
  if (m.type === 'diet') importDiet({ ...data, diet: m.diet });
  else if (m.type === 'routine') importRoutineData({ ...data, routine: m.routine });
}

// PRs del entrenamiento recién guardado: 1RM estimado de la 1ª serie mayor que el mejor anterior
function newPRs(w) {
  const firstE1rm = (ex, date) => {
    const s = ex.sets.find(x => x.w != null);
    return s ? toKg(e1rmEx(ex, s, date), ex.unit) : 0;
  };
  const prs = [];
  for (const ex of w.exercises) {
    const cur = firstE1rm(ex, w.date);
    if (!cur) continue;
    let prev = 0;
    for (const o of db.workouts) {
      if (o === w) continue;
      const oe = o.exercises.find(e => e.exerciseId === ex.exerciseId);
      if (oe && unitKind(oe.unit) === unitKind(ex.unit)) prev = Math.max(prev, firstE1rm(oe, o.date));
    }
    if (prev > 0 && cur > prev + 0.01) {
      const s = ex.sets.find(x => x.w != null);
      const bw = isBwEx(ex);
      prs.push({ id: ex.exerciseId, name: ex.name, text: `${ex.name}: ${fmtNum(s.w)} ${ex.unit} × ${fmtNum(s.r || 1)}${s.rir != null ? ` · RIR ${fmtNum(s.rir)}` : ''}${bw ? ' + peso corporal' : ''} → ${bw ? 'lastre máx.' : '1RM'} ≈ ${bw ? '+' : ''}${fmtNum(round1(e1rmEx(ex, s, w.date)))} ${ex.unit}` });
    }
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
    alert('No se pudo guardar la foto. Revisa tu internet e intenta de nuevo.');
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
  img.onerror = () => { URL.revokeObjectURL(src); alert('No se pudo usar esa imagen. Prueba con otra.'); };
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
const defaultPlan = () => ({ weeks: 1, start: dayKeyOf(mondayOf(new Date())), days: [{ r: Array(7).fill(null) }] });
function planWeekIndex(plan, date) {
  const diff = Math.round((mondayOf(date) - mondayOf(`${plan.start}T12:00:00`)) / (7 * 86400000));
  return ((diff % plan.weeks) + plan.weeks) % plan.weeks;
}
// Rutina que toca ese día: la rutina, null si es descanso, undefined si no tienes plan
function plannedRoutine(dateKey) {
  const p = db.plan;
  if (!p) return undefined;
  const d = new Date(`${dateKey}T12:00:00`);
  const id = ((p.days[planWeekIndex(p, d)] || {}).r || [])[(d.getDay() + 6) % 7];
  return db.routines.find(r => r.id === id) || null;
}
const trainedOn = (dateKey, routineId) => db.workouts.some(w => dayKeyOf(w.date) === dateKey && (!routineId || w.routineId === routineId));

// Días del plan en que toca una rutina: ["lunes y jueves"] o ["semana 1: lunes", "semana 2: jueves"]
function planUses(routineId) {
  const p = db.plan;
  if (!p) return [];
  const join = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}` : list[0]);
  return p.days.slice(0, p.weeks).map((wk, w) => {
    const days = DAY_NAMES.filter((_, d) => wk.r[d] === routineId).map(n => n.toLowerCase());
    return days.length ? `${p.weeks > 1 ? `semana ${w + 1}: ` : ''}${join(days)}` : null;
  }).filter(Boolean);
}

function viewPlan() {
  const p = db.plan || defaultPlan();
  if (!db.routines.length) {
    return `${header('Mi plan', { back: true })}<p class="empty">Primero crea tus rutinas en <a href="#/rutinas">Rutinas</a>; después eliges qué día toca cada una.</p>`;
  }
  const nowWeek = planWeekIndex(p, new Date()), nowDay = (new Date().getDay() + 6) % 7;
  const options = sel => `<option value="">Descanso</option>${db.routines.map(r =>
    `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name || '(sin nombre)')}</option>`).join('')}`;
  const weeks = p.days.slice(0, p.weeks).map((wk, w) => `
    <h2>Semana ${w + 1}${p.weeks > 1 && w === nowWeek ? ' · esta semana' : ''}</h2>
    <section class="card plan-week">${DAY_NAMES.map((name, d) => `
      <label class="plan-row ${w === nowWeek && d === nowDay ? 'today' : ''}">
        <span>${name}${w === nowWeek && d === nowDay ? ' <span class="badge on">Hoy</span>' : ''}</span>
        <select data-bind="plan-day" data-w="${w}" data-d="${d}" aria-label="${name} de la semana ${w + 1}">${options(wk.r[d])}</select>
      </label>`).join('')}
    </section>`).join('');
  return `${header('Mi plan', { back: true, sub: 'Qué rutina te toca cada día' })}
    <section class="card stack">
      <div class="pace-sentence">
        <span>Se repite cada</span>
        <button class="btn pace-dir plan-n" data-action="plan-weeks" data-v="${(p.weeks % 4) + 1}" aria-label="Cambiar cada cuántas semanas se repite">${p.weeks}</button>
        <span>${p.weeks === 1 ? 'semana' : 'semanas'}</span>
      </div>
      <span class="muted small">Toca el número para cambiarlo (de 1 a 4).</span>
    </section>
    ${weeks}
    ${db.plan ? '<button class="btn ghost block danger-text" data-action="plan-del" style="margin-top:20px">Quitar plan</button>' : ''}`;
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
  if (!user || status !== 'ready' || !chats.length) return;
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
    .then(() => { if (['perfil', 'social', 'chat'].includes(routeParts()[0])) refresh(); });
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
function progressPoints(exerciseId, days) {
  const rows = historyFor(exerciseId).reverse();          // de la más antigua a la más reciente
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
    points.push({ t, date: w.date, y, set, tip: `${fmtNum(y)} ${unit} <span class="muted">(${setText(set, set.unit)})</span>` });
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
  const { trend = null, goal = null, dotsOnly = false } = opts;
  const W = 340, H = 200, L = 38, R = 14, T = 20, B = 26;
  const t1 = Math.max(Date.now(), ...points.map(p => p.t)), t0 = t1 - days * 86400000;
  const ys = [...points.map(p => p.y), ...(trend ? trend.map(p => p.y) : []), ...(goal != null ? [goal] : [])];
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
  const goalLine = goal != null
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
    return `${header('Progreso', { home: true })}
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

  const item = e => `
    <a class="card" href="#/progreso/${encodeURIComponent(e.id)}" data-search="${esc(normText(e.name))}">
      <div class="grow">
        <strong>${esc(e.name)}</strong>
        <span class="muted">${plural(e.count, 'sesión', 'sesiones')} · última: ${fmtDate(e.date)}</span>
      </div>
      <span class="chev">›</span>
    </a>`;
  return `${header('Progreso', { home: true, sub: 'Elige un ejercicio para ver su gráfico' })}
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
  return `<a class="card hub" href="#/peso">
      <div class="hub-top"><span class="hub-icon">⚖️</span><strong>Cuerpo</strong><span class="chev">›</span></div>
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
  const gi = goalInfo();
  chart = null;

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
        <p class="form-msg" hidden></p>
        <div class="ex-actions">
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
        ${chartSvg(points, 'kg', days, 'Peso corporal por día', { trend, goal: gi ? gi.g.kg : null, dotsOnly: !!trend })}
        <div class="tip" hidden></div>
        ${trend || gi ? `<div class="chart-legend">
          <span><i class="lg-dot"></i>Pesajes</span>
          ${trend ? '<span><i class="lg-line"></i>Tendencia (7 días)</span>' : ''}
          ${gi ? '<span><i class="lg-goal"></i>Meta</span>' : ''}
        </div>` : ''}
      </section>`;
  }

  return `${header('Cuerpo', { home: true })}${bodyTabs('peso')}
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

  return `${header('Cuerpo', { home: true })}${bodyTabs('grasa')}
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
  formMsg($app.querySelector('[data-form="bodyweight"]'), `Guardado: ${fmtKg(kg)} hoy`, true);
}

// Meta de peso: la nueva parte desde tu último peso anotado
function saveGoal(f) {
  const g = num(f.elements.goal.value);
  if (g == null || g < 30 || g > 300) return formMsg(f, 'Escribe tu peso meta en kg (ej. 80).');
  if (!db.body.goal || db.body.goal.kg !== round1(g)) {
    const last = db.bodyweight[db.bodyweight.length - 1];
    db.body.goal = { kg: round1(g), startKg: last ? last.kg : null, startDate: last ? last.date : todayKey() };
  }
  goalEditing = false;
  save();
  render();
}

function saveBf(f) {
  const t = f.elements.bf.value.trim(), v = num(t);
  if (t && (v == null || v < 3 || v > 60)) { alert('El % de grasa debe estar entre 3 y 60.'); return; }
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
        <button class="icon small danger" data-action="del-skin" data-date="${e.date}" aria-label="Borrar medición">✕</button></span>
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
// db.measures = [{ date: 'AAAA-MM-DD', m: { cintura: 82.5, … } }] en cm; cada medida es opcional
const MEASURE_SITES = [
  ['cuello', 'Cuello', 'Justo debajo de la manzana de Adán'],
  ['hombros', 'Hombros', 'En la parte más ancha, con los brazos relajados'],
  ['pecho', 'Pecho', 'A la altura de los pezones, después de botar el aire normal'],
  ['brazo', 'Brazo', 'En la parte más gruesa, con el bíceps flexionado'],
  ['cintura', 'Cintura', 'A la altura del ombligo, sin meter el estómago'],
  ['cadera', 'Cadera', 'En la parte más ancha de los glúteos'],
  ['muslo', 'Muslo', 'En la parte más gruesa, justo debajo del glúteo'],
  ['pantorrilla', 'Pantorrilla', 'En la parte más gruesa'],
];
let measureView = 'cintura', measureRange = '3m';
// Último valor anotado de una medida (para mostrarlo de ejemplo)
const lastMeasure = k => { for (let n = db.measures.length - 1; n >= 0; n--) if (db.measures[n].m[k] != null) return db.measures[n].m[k]; return null; };

function viewMeasures() {
  const today = db.measures.find(e => e.date === todayKey());
  const form = `<form class="stack card" data-form="measures" novalidate>
      <span class="muted small">${today ? 'Hoy ya mediste con huincha; puedes corregirlo.' : 'Medidas de hoy con huincha, en cm. Anota solo las que quieras.'}</span>
      <div class="measure-inputs">${MEASURE_SITES.map(([k, name]) => {
        const last = lastMeasure(k);
        return `<label class="field"><span>${name}</span>
          <input name="${k}" inputmode="decimal" value="${today && today.m[k] != null ? toField(today.m[k]) : ''}" placeholder="${last != null ? toField(last) : 'cm'}" autocomplete="off" aria-label="${name} en cm">
        </label>`;
      }).join('')}</div>
      <button class="btn primary block">Guardar</button>
      <p class="form-msg" hidden></p>
    </form>`;
  const howTo = `${sectionHead('medidas-como', 'Cómo medir')}
    ${openSections.has('medidas-como') ? `<section class="card stack">
      ${MEASURE_SITES.map(([, name, how]) => `<div><strong>${name}:</strong> <span class="muted">${how}.</span></div>`).join('')}
      <span class="muted small">La huincha debe quedar recta y pegada a la piel, sin apretar. Mide el lado derecho, en ayunas y antes de entrenar, siempre a la misma hora.</span>
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
    body = `<div class="stats">
        <div class="stat"><span class="muted">Última</span><strong>${fmtNum(last.y)} cm</strong><span class="muted">${bwDate(dayKeyOf(last.date))}</span></div>
        ${points.length > 1 ? `<div class="stat"><span class="muted">Cambio</span><strong>${signed(last.y - first.y)} cm</strong><span class="muted">desde ${bwDate(dayKeyOf(first.date))}</span></div>` : ''}
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
        <button class="icon small danger" data-action="del-measure" data-date="${e.date}" aria-label="Borrar medición">✕</button></span>
    </div>`).join('');

  return `${header('Cuerpo', { home: true })}${bodyTabs('medidas')}
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
let progUid = null;           // dueño de lo cargado (por si cambia la sesión)

async function loadProgress(force = false) {
  if (progUid !== user.uid) { progList = null; progFull.clear(); progUid = user.uid; }
  if ((progList && !force) || progLoading) return;
  progLoading = true; progError = false;
  const uid = user.uid;
  try {
    const list = await withTimeout(cloud.listProgress(uid));
    if (!user || user.uid !== uid) { progLoading = false; return; }
    progList = list.filter(x => safePhoto(x.url)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  } catch (e) { progError = true; }
  progLoading = false;
  if (routeParts()[0] === 'fotos') refresh();
}
function needFull(id) {
  if (progFull.has(id)) return;
  progFull.set(id, 'loading');
  const uid = user.uid;
  cloud.getProgressFull(uid, id).then(url => {
    progFull.set(id, safePhoto(url) || 'error');
  }, () => progFull.set(id, 'error')).then(() => { if (user && user.uid === uid && routeParts()[0] === 'fotos') refresh(); });
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
  img.onerror = () => { URL.revokeObjectURL(src); alert('No se pudo usar esa imagen. Prueba con otra.'); };
  img.src = src;
}
function closeProgressNew() {
  if (progNew) URL.revokeObjectURL(progNew.crop.src);
  progNew = null;
}
async function saveProgressNew(btn) {
  const n = progNew, date = n.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayKey()) return alert('Elige una fecha válida (hoy o antes).');
  // Grande: hasta 810×1080 (sin agrandar más de lo que trae la foto); miniatura 240×320
  const c = n.crop, h = Math.round(Math.min(1080, c.bh / cropScale(c)));
  const full = cropToCanvas(c, Math.round(h * 3 / 4), h, 0.8), thumb = cropToCanvas(c, 240, 320, 0.7), id = uid();
  const meta = { date, pose: n.pose };
  await busy(btn, 'Subiendo…', async () => {
    try {
      await withTimeout(cloud.putProgress(user.uid, id, meta, thumb, full));
    } catch (e) {
      alert('No se pudo subir la foto. Revisa tu internet e intenta de nuevo.');
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
  if (!confirm('¿Borrar esta foto? No se puede recuperar.')) return;
  try {
    await withTimeout(cloud.deleteProgress(user.uid, id));
  } catch (e) { alert('No se pudo borrar. Revisa tu internet e intenta de nuevo.'); return; }
  progList = progList.filter(x => x.id !== id);
  progFull.delete(id);
  progOpen = null;
  progCmp = null;
  render();
}

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
        <input type="date" data-bind="prog-date" value="${n.date}" max="${todayKey()}"></label>
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
  return `${header('Cuerpo', { home: true })}${bodyTabs('fotos')}
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

// Una vez al día, al abrir la app, pregunta cuántas horas dormiste (si todavía no lo anotas)
function maybeAskSleep() {
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
      <div class="hub-top"><span class="hub-icon">😴</span><strong>Sueño</strong><span class="chev">›</span></div>
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
        <button class="icon small danger" data-action="del-sleep" data-date="${e.date}" aria-label="Borrar registro">✕</button>
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
  const { unit, points } = progressPoints(id, days);
  chart = null;

  const range = rangeButtons(EX_RANGES, progressRange, 'ex');
  const bwEx = isBwEx({ exerciseId: id, bw: rows[0].ex.bw });
  const sub = bwEx ? 'Lastre máximo estimado de la 1ª serie' : 'Récord estimado (1RM) de la 1ª serie';

  if (!points.length) {
    return `${header(name, { back: true, sub })}${range}
      <p class="empty">No entrenaste este ejercicio en este período${rows.some(r => r.ex.sets.some(s => s.w != null)) ? '' : ' (o no tiene peso anotado)'}.</p>`;
  }

  const max = points.reduce((a, p) => (p.y > a.y ? p : a));
  const first = points[0], last = points[points.length - 1];
  const diff = round1(last.y - first.y);
  const stats = `<div class="stats">
    <div class="stat"><span class="muted">${bwEx ? 'Mejor lastre del período' : 'Mejor 1RM del período'}</span><strong>${bwEx ? '+' : ''}${fmtNum(max.y)} ${unit}</strong><span class="muted">${fmtDate(max.date)}</span></div>
    ${points.length > 1 ? `<div class="stat"><span class="muted">Cambio</span><strong>${diff > 0 ? '+' : ''}${fmtNum(diff)} ${unit}</strong><span class="muted">desde ${fmtDate(first.date)}</span></div>` : ''}
  </div>`;

  const table = points.slice().reverse().map(p => `
    <div class="prog-row"><span class="muted">${fmtDate(p.date)}</span><span>${setText(p.set, p.set.unit)} <span class="muted">→ ${bwEx ? '+' : ''}${fmtNum(p.y)} ${unit}</span></span></div>`).join('');

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
  if (handoffCode) { $app.innerHTML = viewHandoff(); $tabs.hidden = true; return; }

  // Sin sesión: solo pantallas de acceso. Cargando o con error: pantalla de estado.
  if (status !== 'ready') {
    $app.innerHTML = status === 'signed-out' ? viewAuth(screen === 'registro' ? 'registro' : 'login') : viewStatus();
    $tabs.hidden = true;
    return;
  }
  if (authScreen) { location.replace('#/'); return; }

  if (screen !== 'editar') editBuf = null;
  else if (!editBuf || editBuf.editOf !== arg) editBuf = makeEditBuf(arg);
  if (screen !== 'sesion' || arg !== justFinished) justFinished = null;
  if (screen !== 'rutina' && screen !== 'dieta') shareResult = null;
  if (screen !== 'chat') { attach = null; editingMsg = null; selectedMsg = null; }
  if (screen !== 'agua') waterEditing = null;
  if (screen !== 'peso') goalEditing = false;
  if (screen !== 'rutina') openEx = null;
  if (screen !== 'perfil' && photoEdit) { URL.revokeObjectURL(photoEdit.src); photoEdit = null; }
  if (screen !== 'perfil') photoView = false;
  if (screen !== 'fotos') { closeProgressNew(); progOpen = null; }
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
    case 'gymbro': html = viewAddGymbro(); break;
    case 'chat': html = viewChat(arg); break;
    case 'perfil': html = viewProfile(arg); break;
    case 'privacidad': html = viewPrivacy(); break;
    case 'plan': html = viewPlan(); break;
    case 'grasa': html = viewBodyFat(); break;
    case 'pliegues': html = viewSkinfolds(); break;
    case 'medidas': html = viewMeasures(); break;
    case 'fotos': html = viewProgressPhotos(); break;
    default: html = viewHub();   // Inicio: sin pestañas
  }
  $app.innerHTML = html;
  $tabs.hidden = !tab;
  $tabs.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  if (tab === 'progreso' && progressQuery) filterProgress();
  if (screen === 'nutricion' && arg === 'alimentos' && foodQuery) filterFoods();   // al volver, mantiene la búsqueda aplicada
  if (screen === 'gymbro') ensureInvite();
  if (screen === 'chat') scrollChatBottom();
  paintTimer();
}

const go = hash => { location.hash = hash; };

window.addEventListener('hashchange', () => { hideToast(); render(); window.scrollTo(0, 0); });

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
function startWorkout(r) {
  db.draft = {
    routineId: r.id,
    routineName: r.name,
    start: new Date().toISOString(),
    timer: null,
    exercises: r.exercises.map((ex, k) => ({
      exerciseId: ex.id, name: ex.name, unit: ex.unit, rest: ex.rest || 0, rir: !!ex.rir, ...planFields(ex),
      ...(k === r.exercises.length - 1 ? { ssNext: false } : {}),   // el último no se une con nada
      sets: prefillSets(lastFor(ex.id), ex.rir, ex.goalSets, ex.dropset),
    })),
  };
  save();
  go('#/entrenar');
}

// Convierte las series escritas en números y quita las vacías
const cleanExercises = d => d.exercises
  .map(ex => ({
    exerciseId: ex.exerciseId,
    name: ex.name,
    unit: ex.unit,
    ...(ex.rir ? { rir: true } : {}),
    ...(ex.bw ? { bw: true } : {}),
    sets: ex.sets
      .map(s => {
        const set = { w: num(s.w), r: num(s.r) }; const rir = num(s.rir); if (ex.rir && rir != null) set.rir = rir;
        const drops = (s.drops || []).map(x => ({ w: num(x.w), r: num(x.r) })).filter(x => x.w != null || x.r != null);
        if (drops.length) set.drops = drops;   // bajadas del dropset
        return set;
      })
      .filter(s => s.w != null || s.r != null),
  }))
  .filter(ex => ex.sets.length);

function finishWorkout() {
  const d = db.draft;
  const exercises = cleanExercises(d);
  if (!exercises.length) { alert('No hay series anotadas todavía.'); return; }
  setTimer(null);
  const id = uid();
  const durationSec = Math.max(0, Math.round((Date.now() - new Date(d.start).getTime()) / 1000));
  const w = { id, routineId: d.routineId, routineName: d.routineName, date: d.start, durationSec, exercises };
  db.workouts.push(w);
  db.draft = null;
  save();
  announcePRs(w);
  justFinished = id;
  location.replace('#/sesion/' + id);
}

function makeEditBuf(id) {
  const w = db.workouts.find(x => x.id === id);
  if (!w) return null;
  return {
    editOf: w.id,
    routineName: w.routineName,
    start: w.date,
    exercises: w.exercises.map(ex => ({
      exerciseId: ex.exerciseId, name: ex.name, unit: ex.unit, rest: 0,
      rir: !!ex.rir,
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
  if (!exercises.length) { alert('El entrenamiento quedó sin series. Si quieres borrarlo, usa "Eliminar este entrenamiento".'); return; }
  w.exercises = exercises;
  save();
  history.back();
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
  if (d.exercises.some(e => e.exerciseId === id)) { alert(`"${name}" ya está en este entrenamiento.`); return; }
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
  paintTimer();
}

// Actualiza solo los textos del cronómetro (sin redibujar la pantalla)
function paintTimer() {
  const d = db.draft;
  const t = routeParts()[0] === 'entrenar' && d && d.timer ? d.timer : null;
  const left = t ? Math.ceil((t.endsAt - Date.now()) / 1000) : 0;

  if (!d) return;
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
    // Si la app quedó abierta y es un día nuevo, el inicio vuelve a preguntar por el sueño
    if (status === 'ready' && routeParts()[0] === '' && user && localStorage.getItem(sleepAskedKey()) !== todayKey()) refresh();
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
  ...(hasBody(db.body) ? { body: db.body } : {}),
  ...(db.plan ? { plan: db.plan } : {}),
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
  if (!user || status !== 'ready') return;
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
  const bw = data.bodyweight || [], sl = data.sleep || [], body = data.body || {}, plan = data.plan || null, sk = data.skinfolds || [], ms = data.measures || [];
  const water = hasWater(data.water) ? { ...emptyWater(), ...data.water } : emptyWater();
  const remote = {
    routines: data.routines || [], notes: data.notes || {},
    ...(bw.length ? { bodyweight: bw } : {}),
    ...(sl.length ? { sleep: sl } : {}),
    ...(sk.length ? { skinfolds: sk } : {}),
    ...(ms.length ? { measures: ms } : {}),
    ...(hasBody(body) ? { body } : {}),
    ...(plan ? { plan } : {}),
    ...(hasWater(water) ? { water } : {}),
    ...(hasNutrition(data.nutrition) ? { nutrition: data.nutrition } : {}),
  };
  const r = stable(remote), local = stable(mainData());
  if (local !== synced.main) return;
  synced.main = r;
  if (r !== local) { db.routines = remote.routines; db.notes = remote.notes; db.bodyweight = bw; db.sleep = sl; db.skinfolds = sk; db.measures = ms; db.body = body; db.plan = plan; db.water = water; db.nutrition = hasNutrition(data.nutrition) ? { ...emptyNutrition(), ...data.nutrition } : emptyNutrition(); refresh(); }
  persistLocal();
}

function applyRemoteWorkouts(changes) {
  let changed = false;
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

// Primera vez en este teléfono: descarga todo desde la nube
async function loadFromCloud() {
  const { main, workouts } = await cloud.fetchAll(user.uid);
  db = emptyDb();
  synced = emptySynced();
  if (main) {
    db.routines = main.routines || [];
    db.notes = main.notes || {};
    db.bodyweight = main.bodyweight || [];
    db.sleep = main.sleep || [];
    db.skinfolds = main.skinfolds || [];
    db.measures = main.measures || [];
    db.body = main.body || {};
    db.plan = main.plan || null;
    db.water = hasWater(main.water) ? { ...emptyWater(), ...main.water } : emptyWater();
    db.nutrition = hasNutrition(main.nutrition) ? { ...emptyNutrition(), ...main.nutrition } : emptyNutrition();
    synced.main = stable(mainData());
  }
  db.workouts = workouts.sort(byDate);
  for (const w of db.workouts) synced.w[w.id] = stable(w);
}

// Sube a la cuenta lo que se guardó en este teléfono antes de tener cuenta
function migrateLegacy(legacy) {
  const cloudEmpty = !db.routines.length && !db.workouts.length;
  const merge = cloudEmpty || confirm(
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
  if (pendingBody && Object.keys(pendingBody).length) db.body = { ...pendingBody, ...db.body };
  pendingBody = null;

  status = 'ready';
  persistLocal();
  stopListening = cloud.listen(u.uid, applyRemoteMain, applyRemoteWorkouts);
  startSocial(u.uid);
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
  if (!confirm(msg)) return;
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
  if (!email) { alert('Escribe tu correo arriba y vuelve a tocar "¿Olvidaste tu contraseña?".'); return; }
  try {
    await cloud.resetPassword(email);
    alert(`Si existe una cuenta con ${email}, te llegará un correo para crear una contraseña nueva. Revisa también la carpeta de spam.`);
  } catch (e) {
    alert(authError(e));
  }
}

// ---------- Acciones ----------
$app.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const { action, id } = el.dataset;
  const i = +el.dataset.i, j = +el.dataset.j;

  switch (action) {
    case 'back':
      history.back();
      break;

    case 'start': {
      const r = db.routines.find(x => x.id === id);
      if (!r) return;
      if (db.draft && !confirm(`Tienes un entrenamiento de "${db.draft.routineName}" sin guardar. ¿Descartarlo y empezar "${r.name}"?`)) return;
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
    case 'goal-del':
      delete db.body.goal;
      goalEditing = false;
      save(); render();
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
      const ex = curRoutine().exercises[i], key = { 'toggle-drop': 'dropset', 'toggle-bw': 'bw', 'toggle-ss': 'ssNext' }[action];
      if (ex[key]) delete ex[key]; else ex[key] = true;
      save(); render();
      break;
    }
    case 'toggle-rir': {
      const ex = curRoutine().exercises[i];
      ex.rir = !ex.rir;
      save(); render();
      break;
    }
    case 'toggle-unit': {
      const ex = curRoutine().exercises[i];
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
      openEx = i;
      render();
      { const card = $app.querySelector('.ex-open'); if (card) card.scrollIntoView({ block: 'nearest' }); }
      break;
    case 'ex-close':
      openEx = null;
      render();
      break;
    case 'toggle-sec':
      if (!openSections.delete(el.dataset.k)) openSections.add(el.dataset.k);
      render();
      break;
    case 'del-ex': {
      const r = curRoutine();
      if (!confirm(`¿Quitar "${r.exercises[i].name}" de la rutina? Su historial se mantiene.`)) return;
      r.exercises.splice(i, 1);
      openEx = null;
      save(); render();
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
      if (!confirm(`¿Eliminar la rutina "${r.name}"? Tu historial se mantiene.${warn}`)) return;
      db.routines = db.routines.filter(x => x !== r);
      if (db.plan) for (const wk of db.plan.days) wk.r = wk.r.map(id => (id === r.id ? null : id));
      save(); history.back();
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
      if (!ex || !confirm(`¿Quitar "${ex.name}" de este entrenamiento?`)) return;
      d.exercises.splice(i, 1);
      d.done = (d.done || []).filter(x => x !== ex.exerciseId);
      d.pos = Math.max(0, Math.min(i, d.exercises.length - 1));
      // el descanso en curso sigue apuntando a su ejercicio
      if (d.timer) { if (d.timer.i === i) d.timer = null; else if (d.timer.i > i) d.timer.i--; }
      save(); render();
      break;
    }
    case 'add-set':
      cur().exercises[i].sets.push({ w: '', r: '', ...(cur().exercises[i].rir ? { rir: '' } : {}) });
      save(); render();
      break;
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
      for (const k of groupsOf(d).find(g => g.includes(i))) d.exercises[k].sets.push({ w: '', r: '', ...(d.exercises[k].rir ? { rir: '' } : {}) });
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
      const st = cur().exercises[i].sets[j];
      st.drops.splice(+el.dataset.k, 1);
      if (!st.drops.length) delete st.drops;
      save(); render();
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
      if (t && t.i === i) setTimer(null);    // tocar de nuevo lo detiene
      else setTimer({ i, endsAt: Date.now() + db.draft.exercises[i].rest * 1000 });
      break;
    }
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
      if (!confirm('¿Descartar este entrenamiento? No se guardará nada.')) return;
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
    case 'pick-food': {
      const form = el.closest('form'), food = foodById(id);
      form.dataset.food = id;
      form.elements.q.value = food.name;
      form.querySelector('.food-results').innerHTML = '';
      // Alimentos de la base con porción: por defecto se anotan en unidades (se puede cambiar a gramos)
      const chip = form.querySelector('[data-action="add-mode"]');
      chip.hidden = !food.unitG;
      form.dataset.mode = food.unitG ? 'u' : 'g';
      setAddMode(form, food);
      form.elements.g.focus();
      break;
    }
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
      progPose = el.dataset.k;
      progCmp = null;
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
      const uses = N().diets.filter(d => d.meals.some(m => m.items.some(it => it.foodId === food.id)));
      if (!confirm(uses.length
        ? `"${food.name}" está en ${plural(uses.length, 'dieta')} (${uses.map(d => d.name).join(', ')}). Si lo eliminas, se quitará de ellas. ¿Eliminar?`
        : `¿Eliminar "${food.name}"?`)) return;
      for (const d of N().diets) for (const m of d.meals) m.items = m.items.filter(it => it.foodId !== food.id);
      N().foods = N().foods.filter(f => f !== food);
      save(); history.back();
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
      if (meal.items.length && !confirm(`¿Eliminar "${meal.name}" con sus alimentos?`)) return;
      diet.meals.splice(+el.dataset.m, 1);
      save(); render();
      break;
    }
    case 'item-del':
      dietById(routeParts()[1]).meals[+el.dataset.m].items.splice(i, 1);
      save(); render();
      break;
    case 'diet-done':
      location.replace('#/nutricion/dietas');
      break;
    case 'diet-del': {
      const diet = dietById(routeParts()[1]);
      if (!confirm(`¿Eliminar la dieta "${diet.name}"?`)) return;
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
      quick.splice(Number(el.dataset.k), 1);
      save(); render();
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
      if (!confirm('¿Eliminar este entrenamiento del historial?')) return;
      db.workouts = db.workouts.filter(w => w.id !== id);
      save(); history.back();
      break;

    // Compartir rutinas
    case 'share-routine':
      shareRoutine(el);
      break;
    case 'copy-code':
      navigator.clipboard.writeText(shareLink(shareResult.code))
        .then(() => { el.textContent = 'Link copiado'; }, () => alert(`Link: ${shareLink(shareResult.code)}`));
      break;
    case 'share-diet':
      shareDiet(el);
      break;

    // Social
    case 'auto-pr':
      localStorage.setItem(autoPRKey(), el.checked ? '1' : '0');
      break;
    case 'photo-del':
      if (confirm('¿Quitar tu foto de perfil?')) setMyPhoto(null);
      break;
    case 'plan-weeks': {
      // Si bajas el número, las semanas que sobran se ocultan pero no se borran (vuelven si lo subes de nuevo)
      const p = (db.plan ||= defaultPlan()), n = Number(el.dataset.v);
      while (p.days.length < n) p.days.push({ r: Array(7).fill(null) });
      p.weeks = n;
      save(); render();
      break;
    }
    case 'plan-del':
      if (!confirm('¿Quitar tu plan? Tus rutinas no se borran.')) return;
      db.plan = null;
      save(); render();
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
    case 'copy-invite':
      navigator.clipboard.writeText(inviteLink(inviteCode()))
        .then(() => { el.textContent = 'Link copiado'; }, () => alert(`Link: ${inviteLink(inviteCode())}`));
      break;
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
      if (confirm('¿Eliminar este mensaje? Se borra para ti y para tu gymbro.')) deleteMessage(id);
      break;
    case 'gymbro-del': {
      const c = chats.find(x => x.id === routeParts()[1]);
      if (!c || !confirm(`¿Eliminar a ${gymbroName(c)} de tus gymbros? El chat se borra para los dos.`)) return;
      cloud.deleteChat(c.id).then(() => location.replace('#/social'), () => alert('No se pudo eliminar. Revisa tu internet.'));
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
        .then(() => { el.textContent = 'Código copiado. Ahora abre Desdel'; }, () => alert(`Código: ${fmtCode(handoffCode)}`));
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
  if (b === 'prog-date') { if (progNew) progNew.date = e.target.value; return; }
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
  if (bind === 'plan-day') {
    const p = (db.plan ||= defaultPlan());
    p.days[+el.dataset.w].r[+el.dataset.d] = el.value || null;
    save();
    return;
  }
  if (bind === 'wq-ml') setQuick(el);
  else if (bind === 'pace-amt') setPaceAmount(el);
  else if (bind === 'routine-name') curRoutine().name = el.value;
  else if (bind === 'ex-name') curRoutine().exercises[i].name = el.value;
  else if (bind === 'ex-rest') {
    const sec = parseRest(el.value);
    if (sec !== null) curRoutine().exercises[i].rest = sec;
  }
  else if (bind === 'ex-goal-sets' || bind === 'ex-goal-reps' || bind === 'ex-goal-rir') {
    // Vacío = sin objetivo; si lo escrito no es válido se mantiene lo anterior
    const ex = curRoutine().exercises[i], text = el.value.trim();
    const key = { 'ex-goal-sets': 'goalSets', 'ex-goal-reps': 'goalReps', 'ex-goal-rir': 'goalRir' }[bind];
    if (!text) delete ex[key];
    else if (key === 'goalSets') { const n = parseInt(text, 10); if (n >= 1 && n <= 20 && String(n) === text) ex.goalSets = n; }
    else { const v = parseRange(text, key === 'goalReps' ? 100 : 10); if (v) ex[key] = v; }
  }
  else if (bind === 'w' || bind === 'r' || bind === 'rir') {
    const d = cur(), ex = d.exercises[i];
    ex.sets[j][bind] = el.value;
    const cell = $app.querySelector(`[data-mark="${i}-${j}"]`);
    if (cell) cell.innerHTML = markSpan(liveCmp(ex.sets[j], ex, bestSets(ex.exerciseId, beforeIndex(d), ex.unit)[j]));
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
  } else if (bind === 'ex-rest') {
    const ex = curRoutine() && curRoutine().exercises[+e.target.dataset.i];
    if (ex) e.target.value = ex.rest ? fmtRest(ex.rest) : '';   // muestra el tiempo como m:ss
  } else if (bind === 'pace-amt') {
    refresh();   // al salir del cuadro se recalculan las calorías
  } else if (bind === 'wq-ml') {
    refresh();   // al salir del cuadro se ven los botones rápidos actualizados
  } else if (bind && bind.startsWith('ex-goal-')) {
    // Muestra el objetivo guardado ("8 10" queda "8-10"; si no era válido vuelve a lo anterior)
    const ex = curRoutine() && curRoutine().exercises[+e.target.dataset.i];
    if (ex) e.target.value = { 'ex-goal-sets': ex.goalSets, 'ex-goal-reps': ex.goalReps, 'ex-goal-rir': ex.goalRir }[bind] || '';
  }
});

$app.addEventListener('keydown', e => {
  const bind = e.target.dataset.bind || '';
  if (e.key === 'Enter' && (bind === 'note' || bind === 'ex-rest' || bind === 'pace-amt' || bind.startsWith('ex-goal-'))) e.target.blur();
});

$app.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  switch (f.dataset.form) {
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
      if (ml < 10 || ml > 5000) { alert('Escribe una cantidad en ml (ej. 300).'); return; }
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
  if (f.dataset.form === 'new-routine') {
    const r = { id: uid(), name: title, exercises: [] };
    db.routines.push(r);
    save();
    go('#/rutina/' + r.id);
  } else if (f.dataset.form === 'new-ex') {
    lastUnit = f.elements.unit.value;
    curRoutine().exercises.push({ id: uid(), name: title, unit: lastUnit, rest: 0 });
    openEx = curRoutine().exercises.length - 1;   // el nuevo queda abierto para configurarlo
    save(); render();
    $app.querySelector('[data-form="new-ex"] input').focus();
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
const linkCode = linkParams.get('r') || linkParams.get('g');   // r = rutina o dieta, g = gymbro
if (linkCode) {
  // En Safari de iPhone (fuera de la app) se muestra el código para copiarlo; en local se prueba con ?ios
  if ((isIPhone && !isInstalled) || (isLocal && linkParams.has('ios'))) {
    handoffCode = normCode(linkCode);
    handoffGymbro = linkParams.has('g');
  } else localStorage.setItem(PENDING_IMPORT, normCode(linkCode));
  linkParams.delete('r');
  linkParams.delete('g');
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
