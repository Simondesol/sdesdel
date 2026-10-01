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
const emptyDb = () => ({ routines: [], workouts: [], draft: null, notes: {}, bodyweight: [], water: emptyWater(), nutrition: emptyNutrition() });
const emptySynced = () => ({ main: null, w: {} });
let db = emptyDb();
let user = null;                 // { uid, email, username }
let synced = emptySynced();      // último estado confirmado por la nube (para saber qué falta subir)
let cloud = null;                // módulo de conexión (cloud.js)
let status = 'booting';          // booting | signed-out | ready | load-error | fatal
let pendingUsername = null;      // nombre elegido al registrarse (Firebase lo avisa un poco después)
let authUser = null;             // último usuario informado por Firebase

let lastUnit = 'kg';
const openHistory = new Set();   // ejercicios con el historial desplegado
let editingNote = null;          // ejercicio cuya nota se está editando
let editBuf = null;              // copia de un entrenamiento guardado que se está editando
let justFinished = null;         // entrenamiento recién guardado (para mostrar el resumen)

function persistLocal() {
  if (user) localStorage.setItem(userKey(user.uid), JSON.stringify({ db, synced }));
}
function save() { persistLocal(); scheduleSync(); }

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
// Una serie es mejor si tiene más peso; con el mismo peso, si tiene más reps.
// Las libras se pasan a kg para poder comparar ejercicios que cambiaron de unidad.
const toKg = (w, unit) => (w == null ? 0 : unit === 'lb' ? w * 0.45359237 : w);
function cmpSet(a, b) {
  const dw = toKg(a.w, a.unit) - toKg(b.w, b.unit);
  if (Math.abs(dw) > 0.01) return dw > 0 ? 1 : -1;
  const dr = (a.r ?? 0) - (b.r ?? 0);
  return dr === 0 ? 0 : dr > 0 ? 1 : -1;
}

// Mejor serie de cada posición (serie 1, serie 2...) en los entrenamientos anteriores a `before`
function bestSets(exerciseId, before = db.workouts.length) {
  const best = [];
  for (let k = 0; k < before; k++) {
    const ex = db.workouts[k].exercises.find(e => e.exerciseId === exerciseId);
    if (!ex) continue;
    ex.sets.forEach((s, j) => {
      const c = { w: s.w, r: s.r, unit: ex.unit };
      if (!best[j] || cmpSet(c, best[j]) > 0) best[j] = c;
    });
  }
  return best;
}

// Compara lo que se está escribiendo con la mejor marca (null si no hay nada que comparar)
function liveCmp(s, unit, best) {
  if (!best) return null;
  const w = num(s.w), r = num(s.r);
  if (w == null && r == null) return null;
  return cmpSet({ w, r, unit }, best);
}

const markSpan = c => (c == null ? '' :
  `<span class="mark ${c > 0 ? 'up' : c < 0 ? 'down' : 'eq'}">${c > 0 ? '▲' : c < 0 ? '▼' : '='}</span>`);

function header(title, { back = false, home = false, sub = '', right = '' } = {}) {
  return `<header class="bar">
    ${back ? '<button class="icon" data-action="back" aria-label="Volver">‹</button>' : ''}
    ${home ? '<a class="icon home" href="#/" aria-label="Volver al inicio">‹</a>' : ''}
    <div class="titles"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
    ${right}
  </header>`;
}

// ---------- Menú principal ----------
const GEAR = `<a class="icon gear" href="#/cuenta" aria-label="Cuenta y configuración">
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6a.5.5 0 0 0 .1-.6l-1.9-3.3a.5.5 0 0 0-.6-.2l-2.4 1a7.3 7.3 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-3.8a.5.5 0 0 0-.5.4l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.4-1a.5.5 0 0 0-.6.2L2.5 8.8a.5.5 0 0 0 .1.6l2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6a.5.5 0 0 0-.1.6l1.9 3.3c.1.2.4.3.6.2l2.4-1c.5.4 1.1.7 1.7 1l.4 2.6c0 .2.3.4.5.4h3.8c.2 0 .5-.2.5-.4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.4 1c.2.1.5 0 .6-.2l1.9-3.3a.5.5 0 0 0-.1-.6ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/></svg>
</a>`;

const bar = (value, goal) => `<div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${value}">
  <span style="width:${Math.min(100, goal ? (value / goal) * 100 : 0)}%"></span></div>`;

function viewHub() {
  const d = db.draft;
  const ml = waterToday(), goal = waterGoal().ml;
  return `${header('Desdel', { sub: 'Entrena. Anota. Supera.', right: GEAR })}
    <div class="hub-wrap">
    <a class="card hub" href="#/rutinas">
      <div class="hub-top"><span class="hub-icon">🏋️</span><strong>Entreno</strong><span class="chev">›</span></div>
      <span class="muted">${d ? `Entrenamiento en curso: ${esc(d.routineName)}` : 'Rutinas · Historial · Progreso'}</span>
    </a>

    ${nutritionCard()}

    <div class="card hub">
      <a class="hub-top" href="#/agua"><span class="hub-icon">💧</span><strong>Agua</strong><span class="chev">›</span></a>
      <a class="hub-value" href="#/agua"><strong>${fmtL(ml)} / ${fmtL(goal)}</strong> L${ml >= goal ? ' · ¡Meta cumplida! 🎉' : ''}</a>
      ${bar(ml, goal)}
      <div class="ex-actions">
        <button class="btn" data-action="water-add" data-ml="250">+250 ml</button>
        <button class="btn" data-action="water-add" data-ml="500">+500 ml</button>
      </div>
    </div>

    ${bodyweightCard()}
    </div>`;
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
  <span class="muted small">${fmtKcal(f.kcal)} kcal${isUnit(f) ? ' c/u' : ''} · P ${fmtG(f.p)}</span></button>`;
const dietById = id => N().diets.find(d => d.id === id);
const sumM = list => list.reduce((a, m) => ({ kcal: a.kcal + m.kcal, p: a.p + m.p, c: a.c + m.c, f: a.f + m.f }), { ...ZERO });
// Alimentos por unidad (1 huevo, 1 rebanada...) o por 100 g
const isUnit = f => !!f && f.per === 'unit';
const perText = f => (isUnit(f) ? 'por unidad' : 'por 100 g');
// "120 g Carne molida" o "2 × Huevo"
const itemText = (food, n) => (isUnit(food) ? `${fmtNum(n)} × ${esc(food.name)}` : `${fmtNum(n)} g ${esc(food.name)}`);
function itemMacros(it) {
  const food = foodById(it.foodId);
  if (!food) return { ...ZERO };
  const k = isUnit(food) ? (it.g || 0) : (it.g || 0) / 100;   // it.g = gramos, o cantidad si es por unidad
  return { kcal: food.kcal * k, p: food.p * k, c: food.c * k, f: food.f * k };
}
const mealMacros = meal => sumM(meal.items.map(itemMacros));
const dietMacros = diet => sumM(diet.meals.map(mealMacros));
const macroLine = m => `P ${fmtG(m.p)} g · C ${fmtG(m.c)} g · G ${fmtG(m.f)} g`;

// Hoy: qué dieta se usa y qué comidas están marcadas
function todayNutrition() {
  const log = N().log[todayKey()];
  const diet = dietById(log && log.dietId) || dietById(N().activeDietId) || N().diets[0] || null;
  // Cada dieta recuerda sus comidas marcadas del día, aunque cambies de una a otra
  const done = !diet || !log ? [] : (log.byDiet && log.byDiet[diet.id]) || (log.dietId === diet.id ? log.done || [] : []);
  const eaten = diet ? sumM(diet.meals.filter(m => done.includes(m.id)).map(mealMacros)) : { ...ZERO };
  return { diet, done, eaten, goal: diet ? dietMacros(diet) : { ...ZERO } };
}

// Guarda el registro de hoy (y borra los de hace más de 90 días para no acumular)
function setTodayLog(dietId, done) {
  const prev = N().log[todayKey()] || {};
  N().log[todayKey()] = { dietId, done, byDiet: { ...(prev.byDiet || {}), [dietId]: done } };
  const limit = new Date(Date.now() - 90 * 86400000);
  const min = `${limit.getFullYear()}-${String(limit.getMonth() + 1).padStart(2, '0')}-${String(limit.getDate()).padStart(2, '0')}`;
  for (const k of Object.keys(N().log)) if (k < min) delete N().log[k];
}

const nutriTabs = active => `<div class="range" role="tablist">${[['', 'Hoy'], ['alimentos', 'Mis alimentos'], ['dietas', 'Mis dietas']]
  .map(([k, label]) => `<a class="${k === active ? 'on' : ''}" href="#/nutricion${k ? `/${k}` : ''}" role="tab">${label}</a>`).join('')}</div>`;

function viewNutrition(section) {
  if (section === 'alimentos') return viewFoods();
  if (section === 'dietas') return viewDiets();
  const { diet, done, eaten, goal } = todayNutrition();
  const head = `${header('Nutrición', { home: true })}${nutriTabs('')}`;
  if (!diet) {
    return `${head}<p class="empty">Todavía no tienes dietas.<br>Primero agrega tus alimentos en <a href="#/nutricion/alimentos">Mis alimentos</a> y luego crea tu dieta en <a href="#/nutricion/dietas">Mis dietas</a>.</p>`;
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
        <div class="muted small">${meal.items.map(it => { const fd = foodById(it.foodId); return fd ? itemText(fd, it.g) : '(alimento borrado)'; }).join(' · ') || 'Sin alimentos'}</div>
      </div>
    </section>`;
  }).join('');
  return `${head}${chooser}
    <section class="card nutri-sum">
      <div class="water-big"><strong>${fmtKcal(eaten.kcal)}</strong> / ${fmtKcal(goal.kcal)} kcal</div>
      ${bar(eaten.kcal, goal.kcal)}
      <div class="macros">
        <span>Proteína<br><strong>${fmtG(eaten.p)}</strong> / ${fmtG(goal.p)} g</span>
        <span>Carbos<br><strong>${fmtG(eaten.c)}</strong> / ${fmtG(goal.c)} g</span>
        <span>Grasas<br><strong>${fmtG(eaten.f)}</strong> / ${fmtG(goal.f)} g</span>
      </div>
    </section>
    <h2>${esc(diet.name)} · toca ✓ cuando comas</h2>
    ${meals || '<p class="empty">Esta dieta no tiene comidas.</p>'}`;
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
    <button class="btn primary block" data-action="diet-new" style="margin:0 0 12px">+ Crear dieta</button>
    ${list || `<p class="empty">${N().foods.length ? 'Crea tu primera dieta.' : 'Primero agrega tus alimentos en <a href="#/nutricion/alimentos">Mis alimentos</a>.'}</p>`}`;
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
        <span class="grow">${esc(food ? food.name : '(alimento borrado)')}</span>
        <input class="grams" inputmode="decimal" data-bind="item-g" data-m="${mi}" data-i="${ii}" value="${toField(it.g)}" aria-label="${isUnit(food) ? 'Cantidad' : 'Gramos'}">
        <span class="unit-label">${isUnit(food) ? 'u' : 'g'}</span>
        <span class="item-kcal" data-item-kcal="${mi}-${ii}">${fmtKcal(im.kcal)} kcal</span>
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
          <button class="btn">+</button>
        </div>
        <div class="food-results" data-results="${mi}"></div>
      </form>
      <div class="meal-total" data-meal-total="${mi}"><strong>${fmtKcal(m.kcal)} kcal</strong> · ${macroLine(m)}</div>
    </section>`;
  }).join('');
  return `${header('Editar dieta', { back: true })}
    <label class="field"><span>Nombre de la dieta</span><input data-bind="diet-name" value="${esc(diet.name)}" autocomplete="off"></label>
    <section class="card nutri-sum" style="margin-top:12px">
      <div class="muted small">Total de la dieta</div>
      <div data-diet-total><strong class="big">${fmtKcal(total.kcal)} kcal</strong><div class="muted small">${macroLine(total)}</div></div>
    </section>
    ${meals}
    <button class="btn block" data-action="meal-add">+ Agregar comida ${diet.meals.length + 1}</button>
    <p class="muted hint">¿Falta un alimento? <a href="#/alimento/nuevo">Créalo aquí</a> y vuelve.</p>
    <button class="btn primary block" data-action="diet-done" style="margin-top:20px">Terminar dieta</button>
    <button class="btn ghost block danger-text" data-action="diet-del">Eliminar dieta</button>`;
}

// Actualiza los totales mientras cambias gramos (sin redibujar, para no cerrar el teclado)
function paintDietTotals(diet) {
  diet.meals.forEach((meal, mi) => {
    meal.items.forEach((it, ii) => {
      const el = $app.querySelector(`[data-item-kcal="${mi}-${ii}"]`);
      if (el) el.textContent = `${fmtKcal(itemMacros(it).kcal)} kcal`;
    });
    const m = mealMacros(meal), el = $app.querySelector(`[data-meal-total="${mi}"]`);
    if (el) el.innerHTML = `<strong>${fmtKcal(m.kcal)} kcal</strong> · ${macroLine(m)}`;
  });
  const t = dietMacros(diet), el = $app.querySelector('[data-diet-total]');
  if (el) el.innerHTML = `<strong class="big">${fmtKcal(t.kcal)} kcal</strong><div class="muted small">${macroLine(t)}</div>`;
}


function nutritionCard() {
  const t = todayNutrition();
  return `<a class="card hub" href="#/nutricion">
    <div class="hub-top"><span class="hub-icon">🍽️</span><strong>Nutrición</strong><span class="chev">›</span></div>
    ${t.diet
      ? `<div class="hub-value"><strong>${fmtKcal(t.eaten.kcal)} / ${fmtKcal(t.goal.kcal)}</strong> calorías</div>${bar(t.eaten.kcal, t.goal.kcal)}`
      : '<span class="muted">Crea tus alimentos y tu dieta</span>'}
  </a>`;
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
  const ml = waterToday(), g = waterGoal();
  const entries = waterDay().map((e, k) => `
    <div class="prog-row">
      <span class="muted">${new Date(e.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="bw-right">${e.ml} ml
        <button class="icon small danger" data-action="water-del" data-k="${k}" aria-label="Borrar">✕</button>
      </span>
    </div>`).reverse().join('');

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
      <div class="ex-actions water-btns">
        <button class="btn primary" data-action="water-add" data-ml="250">+250 ml</button>
        <button class="btn primary" data-action="water-add" data-ml="500">+500 ml</button>
      </div>
      <form class="add-row" data-form="water-custom" novalidate>
        <input name="ml" inputmode="numeric" placeholder="Otra cantidad (ml)" autocomplete="off" aria-label="Cantidad en ml">
        <button class="btn">Agregar</button>
      </form>
    </section>

    ${entries ? `<h2>Hoy</h2><section class="card">${entries}</section>` : ''}

    <h2>Últimos 7 días</h2>
    <section class="card">${days.join('')}</section>

    <h2>Meta diaria</h2>
    <form class="stack card" data-form="water-goal" novalidate>
      <p class="muted" style="margin:0">${g.auto
        ? (g.kg ? `Calculada con tu peso: 35 ml × ${fmtNum(g.kg)} kg = ${fmtL(g.ml)} L` : 'Anota tu peso en Progreso para calcularla. Por ahora: 2,5 L')
        : `Meta personalizada: ${fmtL(g.ml)} L`}</p>
      <div class="add-row" style="margin-top:0">
        <input name="liters" inputmode="decimal" placeholder="Litros (ej. 3)" value="${g.auto ? '' : fmtL(g.ml)}" autocomplete="off" aria-label="Meta en litros">
        <button class="btn">Guardar</button>
      </div>
      ${g.auto ? '' : '<button type="button" class="btn ghost" data-action="water-auto">Usar la meta calculada con mi peso</button>'}
      <p class="form-msg" hidden></p>
    </form>`;
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
const prefillSets = (prev, rir) => (prev
  ? prev.ex.sets.map(s => ({ w: toField(s.w), r: toField(s.r), ...(rir ? { rir: toField(s.rir) } : {}) }))
  : [{ w: '', r: '', ...(rir ? { rir: '' } : {}) }]);

// Texto de una serie guardada: "40 kg × 10" o "40 kg × 10 · RIR 2"
const setText = (s, unit) => `${fmtNum(s.w)} ${unit} × ${fmtNum(s.r)}${s.rir != null ? ` · RIR ${fmtNum(s.rir)}` : ''}`;
const setsChips = ex => `<div class="sets-list">${ex.sets.map(s => `<span>${setText(s, ex.unit)}</span>`).join('')}</div>`;

const unitSelect = () => `<select name="unit" aria-label="Unidad">
  <option ${lastUnit === 'kg' ? 'selected' : ''}>kg</option>
  <option ${lastUnit === 'lb' ? 'selected' : ''}>lb</option>
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
  const last = db.routines.length - 1;
  const routines = db.routines.map((r, i) => `
    <div class="card routine">
      <a href="#/rutina/${r.id}">
        <strong>${esc(r.name) || '(sin nombre)'}</strong>
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
    ${routines || '<p class="empty">Aún no tienes rutinas. Crea la primera abajo.</p>'}
    <form class="add-row" data-form="new-routine">
      <input name="title" placeholder="Nueva rutina (ej. Brazo)" autocomplete="off" required>
      <button class="btn">Crear</button>
    </form>
    ${importOpen ? `
    <form class="stack import-box" data-form="import-code" novalidate>
      <div class="add-row">
        <input name="code" placeholder="Código (ej. K7P-9XQ)" autocomplete="off" autocapitalize="characters" maxlength="9" aria-label="Código de rutina">
        <button class="btn">Importar</button>
      </div>
      <p class="form-msg" hidden></p>
    </form>`
    : '<button class="btn ghost block" data-action="show-import">Importar rutina con código</button>'}`;
}

function viewRoutine() {
  const r = curRoutine();
  if (!r) { location.replace('#/rutinas'); return ''; }
  const last = r.exercises.length - 1;
  const items = r.exercises.map((ex, i) => `
    <li class="card">
      <input class="grow" data-bind="ex-name" data-i="${i}" value="${esc(ex.name)}" aria-label="Nombre del ejercicio">
      <button class="chip" data-action="toggle-unit" data-i="${i}" aria-label="Cambiar unidad">${ex.unit}</button>
      <button class="icon" data-action="move" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir">↑</button>
      <button class="icon" data-action="move" data-i="${i}" data-d="1" ${i === last ? 'disabled' : ''} aria-label="Bajar">↓</button>
      <button class="icon danger" data-action="del-ex" data-i="${i}" aria-label="Quitar">✕</button>
      <div class="ex-opts">
        <label class="rest-field">Rest
          <input data-bind="ex-rest" data-i="${i}" value="${ex.rest ? fmtRest(ex.rest) : ''}" placeholder="m:ss" autocomplete="off" aria-label="Descanso entre series">
        </label>
        <button class="chip toggle ${ex.rir ? 'on' : ''}" data-action="toggle-rir" data-i="${i}" aria-pressed="${!!ex.rir}">RIR ${ex.rir ? '✓' : ''}</button>
      </div>
    </li>`).join('');
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
    ${shareResult && shareResult.routineId === r.id ? `
    <section class="card share-box" style="margin-top:32px">
      <div class="muted">Código para compartir "${esc(r.name)}"</div>
      <div class="code">${fmtCode(shareResult.code)}</div>
      <div class="ex-actions">
        <button class="btn primary" data-action="send-code">Enviar</button>
        <button class="btn" data-action="copy-code">Copiar link</button>
      </div>
      <p class="muted hint">Tu amigo toca el link y la rutina se le agrega sola (o ingresa el código en Rutinas → "Importar rutina con código"). Solo se comparten los ejercicios y el Rest, no tus pesos ni tu historial.</p>
    </section>`
    : '<button class="btn block" data-action="share-routine" style="margin-top:32px">Compartir rutina</button>'}
    <button class="btn block" data-action="dup-routine">Duplicar rutina</button>
    <button class="btn ghost block danger-text" data-action="del-routine">Eliminar rutina</button>`;
}

function viewWorkout() {
  const d = cur();
  if (!d) { location.replace(isEditing() ? '#/historial' : '#/rutinas'); return ''; }
  const editing = !!d.editOf;
  const before = beforeIndex(d);

  // Un ejercicio a la vez: d.pos es el ejercicio en pantalla y d.done los que ya pasaste con "Siguiente"
  const last = d.exercises.length - 1;
  d.pos = Math.min(Math.max(d.pos || 0, 0), last);
  d.done = d.done || [];

  const exerciseBlock = (ex, i) => {
    const best = bestSets(ex.exerciseId, before);
    const sets = ex.sets.map((s, j) => `
      <div class="set ${ex.rir ? 'has-rir' : ''}">
        <span class="n">${j + 1}</span>
        <input inputmode="decimal" data-bind="w" data-i="${i}" data-j="${j}" value="${esc(s.w)}" placeholder="peso" aria-label="Peso serie ${j + 1}">
        <span class="u">${ex.unit}</span>
        <span class="x">×</span>
        <input inputmode="numeric" data-bind="r" data-i="${i}" data-j="${j}" value="${esc(s.r)}" placeholder="reps" aria-label="Repeticiones serie ${j + 1}">
        ${ex.rir ? `<input class="rir" inputmode="numeric" data-bind="rir" data-i="${i}" data-j="${j}" value="${esc(s.rir ?? '')}" placeholder="RIR" aria-label="RIR serie ${j + 1}">` : ''}
        <span class="mark-cell" data-mark="${i}-${j}">${markSpan(liveCmp(s, ex.unit, best[j]))}</span>
        <button class="icon danger" data-action="del-set" data-i="${i}" data-j="${j}" aria-label="Borrar serie">✕</button>
      </div>
      ${best[j] ? `<div class="set-ref">Mejor: ${fmtNum(best[j].w)} ${best[j].unit} × ${fmtNum(best[j].r)}</div>` : ''}`).join('');
    const open = openHistory.has(ex.exerciseId);
    const past = open ? historyFor(ex.exerciseId, d.editOf).map(({ w, ex: pex }) => `
      <div class="hist-item">
        <div class="muted">${fmtDate(w.date)}</div>
        ${setsChips(pex)}
      </div>`).join('') || '<p class="muted">Aún no hay historial de este ejercicio.</p>' : '';
    const restBtn = !editing && ex.rest
      ? `<button class="btn ghost" data-action="rest" data-i="${i}" data-rest="${i}">Rest ${fmtRest(ex.rest)}</button>` : '';
    return `<section class="card" data-ex="${i}">
      <div class="ex-head"><strong>${esc(ex.name)}</strong></div>
      ${noteHtml(ex.exerciseId, i)}
      ${best.length ? '' : '<p class="prev">Primera vez</p>'}
      <div class="sets">${sets}</div>
      <div class="ex-actions">
        <button class="btn ghost" data-action="add-set" data-i="${i}">+ serie</button>
        ${restBtn}
        <button class="btn ghost ${open ? 'on' : ''}" data-action="toggle-history" data-i="${i}">Historial ${open ? '▴' : '▾'}</button>
      </div>
      ${open ? `<div class="hist">${past}</div>` : ''}
    </section>`;
  };

  const i = d.pos, isLast = i === last;
  // Fila con todos los ejercicios para saltar a cualquiera (✓ = ya lo pasaste)
  const steps = `<nav class="steps" aria-label="Ejercicios">${d.exercises.map((ex, k) => `
    <button class="step ${k === i ? 'on' : ''} ${d.done.includes(ex.exerciseId) ? 'done' : ''}" data-action="go-ex" data-i="${k}"
      ${k === i ? 'aria-current="step"' : ''}>${d.done.includes(ex.exerciseId) ? '✓ ' : ''}${esc(ex.name)}</button>`).join('')}
  </nav>`;
  const nav = `<div class="step-nav">
      <button class="btn" data-action="prev-ex" ${i === 0 ? 'disabled' : ''}>‹ Anterior</button>
      ${isLast
        ? (editing ? '<button class="btn primary" data-action="save-edit">Guardar cambios</button>'
                   : '<button class="btn primary" data-action="finish">Terminar y guardar</button>')
        : `<button class="btn primary" data-action="next-ex">Siguiente: ${esc(d.exercises[i + 1].name)} ›</button>`}
    </div>`;

  const title = editing ? `Editar · ${d.routineName}` : d.routineName;
  return `${header(title, { back: true, sub: `Ejercicio ${i + 1} de ${last + 1} · ${fmtDate(d.start)}` })}
    ${steps}
    ${exerciseBlock(d.exercises[i], i)}
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
    const n = (byDay.get(key) || []).length;
    const cls = ['cal-cell', n ? 'trained' : '', key === today ? 'today' : '', key === histDay ? 'selected' : ''].join(' ');
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
        <button class="icon" data-action="hist-month" data-d="1" ${isCurrent ? 'disabled' : ''} aria-label="Mes siguiente">›</button>
      </div>
      <div class="cal-grid cal-week">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(d => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
    </section>
    <h2 class="hist-title">${title}${histDay ? ' <button class="link" data-action="hist-day" data-date="">Ver todo el mes</button>' : ''}</h2>
    ${shown.map(sessionCard).join('') || `<p class="empty">${histDay ? 'Ese día no entrenaste.' : 'No hay entrenamientos este mes.'}</p>`}`;
}

// ---------- Cuenta ----------
function viewAuth(mode) {
  const reg = mode === 'registro';
  return `<div class="auth">
    <h1><img class="auth-logo" src="icons/logo-full.png" alt="Desdel"></h1>
    <p class="muted">Entrena. Anota. Supera.</p>
    ${localStorage.getItem(PENDING_IMPORT) ? `<p class="auth-note">Te compartieron una rutina. ${reg ? 'Crea tu cuenta' : 'Inicia sesión'} y se agrega automáticamente.</p>` : ''}
    ${readLegacy() ? `<p class="auth-note">Tienes rutinas guardadas en este celular. Al ${reg ? 'crear tu cuenta' : 'iniciar sesión'} se suben a tu cuenta automáticamente.</p>` : ''}
    <form class="auth-form" data-form="${reg ? 'register' : 'login'}" novalidate>
      <label class="field"><span>Correo</span>
        <input name="email" type="email" autocomplete="email" inputmode="email" required>
      </label>
      ${reg ? `<label class="field"><span>Nombre de usuario</span>
        <input name="username" autocomplete="nickname" maxlength="30" required>
      </label>` : ''}
      <label class="field"><span>Contraseña${reg ? ' (mínimo 6 caracteres)' : ''}</span>
        <input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
      </label>
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
  if (!hasUnsynced()) return '<span class="ok">✓ Todo guardado en la nube</span>';
  return navigator.onLine
    ? '⏳ Guardando en la nube…'
    : '⏳ Sin internet: tus cambios se subirán cuando vuelva la conexión.';
}
const paintSync = () => { const el = $app.querySelector('[data-sync]'); if (el) el.innerHTML = syncHtml(); };

function viewAccount() {
  return `${header('Cuenta', { back: true })}
    <section class="card">
      <strong>${esc(user.username || 'Sin nombre de usuario')}</strong>
      <div class="muted">${esc(user.email)}</div>
    </section>
    <section class="card" data-sync>${syncHtml()}</section>
    <p class="muted hint">Tus rutinas e historial se guardan en tu cuenta. Inicia sesión con el mismo correo en otro teléfono para verlos.</p>

    <h2>Nombre de usuario</h2>
    <form class="stack" data-form="username" novalidate>
      <div class="add-row" style="margin-top:0">
        <input name="username" value="${esc(user.username)}" maxlength="30" autocomplete="nickname" aria-label="Nombre de usuario">
        <button class="btn">Guardar</button>
      </div>
      <p class="form-msg" hidden></p>
    </form>

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

async function submitUsername(f) {
  const name = f.elements.username.value.trim();
  if (!name) return formMsg(f, 'Escribe un nombre de usuario.');
  if (name === user.username) return formMsg(f, 'Ese ya es tu nombre de usuario.', true);
  try {
    await busy(f.querySelector('button'), 'Guardando…', () => withTimeout(cloud.updateUsername(user.uid, name)));
    user.username = name;
    render();
    formMsg($app.querySelector('[data-form="username"]'), '✓ Nombre actualizado', true);
  } catch (e) { formMsg(f, authError(e)); }
}

async function submitPassword(f) {
  const current = f.elements.current.value, next = f.elements.next.value;
  if (!current) return formMsg(f, 'Escribe tu contraseña actual.');
  if (next.length < 6) return formMsg(f, 'La nueva contraseña debe tener al menos 6 caracteres.');
  if (next === current) return formMsg(f, 'La nueva contraseña es igual a la actual.');
  try {
    await busy(f.querySelector('button'), 'Cambiando…', () => withTimeout(cloud.changePassword(current, next)));
    f.reset();
    formMsg(f, '✓ Contraseña cambiada. Úsala la próxima vez que inicies sesión.', true);
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
let shareResult = null;   // { routineId, code } del último código generado
let importOpen = false;   // formulario "Importar rutina" visible en inicio

// Link que abre Desdel y agrega la rutina (?r=CÓDIGO)
const PENDING_IMPORT = 'desdel-importar';
const shareLink = code => `${location.origin}${location.pathname}?r=${code}`;
const shareText = (name, code) =>
  `Te comparto mi rutina "${name}" en Desdel 💪\n\nTócalo para agregarla:\n${shareLink(code)}\n\n` +
  `Si no se abre, en Desdel toca "Importar rutina con código" y pega: ${fmtCode(code)}`;

async function shareRoutine(btn) {
  const r = curRoutine();
  if (!r.exercises.length) { alert('Agrega ejercicios a la rutina antes de compartirla.'); return; }
  // Solo se comparten los ejercicios: sin pesos, historial ni notas
  const routine = { name: r.name, exercises: r.exercises.map(ex => ({ name: ex.name, unit: ex.unit, rest: ex.rest || 0, rir: !!ex.rir })) };
  await busy(btn, 'Generando código…', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = newCode();
      try {
        await withTimeout(cloud.shareRoutine(code, { ownerUid: user.uid, ownerName: user.username || '', routine }));
        shareResult = { routineId: r.id, code };
        return;
      } catch (e) {
        if (e.code === 'permission-denied' && attempt < 2) continue;   // código repetido: se prueba otro
        alert(e.code === 'auth/network-request-failed'
          ? 'Se necesita internet para compartir una rutina.'
          : 'No se pudo generar el código. Intenta de nuevo en un rato.');
        return;
      }
    }
  });
  render();
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
      ? 'Se necesita internet para importar una rutina.' : 'No se pudo buscar el código. Intenta de nuevo.');
  }
  if (!data) return showError('No existe ninguna rutina con ese código.');
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
      return { id: mine ? mine.id : uid(), name: mine ? mine.name : ex.name, unit: mine ? mine.unit : ex.unit, rest: ex.rest || 0, rir: !!ex.rir };
    }),
  };
  db.routines.push(routine);
  importOpen = false;
  save();
  go('#/rutina/' + routine.id);
}

const logoImg = '<img class="auth-logo" src="icons/logo-full.png" alt="Desdel">';
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
    const best = bestSets(ex.exerciseId, k);
    const count = { up: 0, eq: 0, down: 0 };
    const chips = ex.sets.map((s, j) => {
      const c = best[j] ? cmpSet({ ...s, unit: ex.unit }, best[j]) : null;
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
      <div class="legend">
        <div><span class="mark up">▲</span> Superaste tu récord</div>
        <div><span class="mark eq">=</span> Igualaste tu récord</div>
        <div><span class="mark down">▼</span> Quedaste por debajo de tu récord</div>
      </div>
    </section>`;

  return `${header(w.routineName, { back: true, sub: fmtLongDate(w.date) })}
    ${summary}
    <button class="btn primary block" data-action="share-workout" data-id="${w.id}" style="margin:0 0 10px">📤 Compartir entrenamiento</button>
    ${blocks}
    <a class="btn block center" href="#/editar/${w.id}">Editar entrenamiento</a>
    <button class="btn ghost block danger-text" data-action="del-session" data-id="${w.id}" style="margin-top:24px">Eliminar este entrenamiento</button>`;
}

// Mensaje para WhatsApp con el resumen de un entrenamiento guardado
function workoutShareText(w) {
  const k = db.workouts.indexOf(w);
  let ups = 0;
  const lines = w.exercises.map(ex => {
    const best = bestSets(ex.exerciseId, k);
    const sets = ex.sets.map((s, j) => {
      const c = best[j] ? cmpSet({ ...s, unit: ex.unit }, best[j]) : null;
      if (c > 0) ups++;
      const mark = c == null ? '' : c > 0 ? ' ▲' : c < 0 ? ' ▼' : ' =';
      return `${fmtNum(s.w)}×${fmtNum(s.r)}${mark}`;
    });
    return `• ${ex.name} (${ex.unit}): ${sets.join(' · ')}`;
  });
  const title = `💪 *${w.routineName}*${w.durationSec ? ` · ${fmtDuration(w.durationSec)}` : ''}`;
  const closing = ups ? `🔥 Superé mi récord en ${plural(ups, 'serie')}` : '✅ Entrenamiento completado';
  return `${title}\n${fmtLongDate(w.date)}\n\n${lines.join('\n')}\n\n${closing}\n\nDesdel · ${location.origin}${location.pathname}`;
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
    btn.textContent = '✓ Copiado, pégalo en WhatsApp';
  } catch (e) {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }
}

// ---------- Progreso ----------
const RANGES =[['semana', 'Semana', 7], ['mes', 'Mes', 30], ['3m', '3 meses', 91], ['6m', '6 meses', 182]];
let progressRange = '3m';
let chart = null;   // puntos del gráfico en pantalla (para el tooltip)

const convertWeight = (w, from, to) => (from === to ? w : from === 'lb' ? w * 0.45359237 : w / 0.45359237);
const round1 = n => Math.round(n * 10) / 10;

// Un punto por sesión: la mejor serie del día (más peso; con igual peso, más reps)
function progressPoints(exerciseId, days) {
  const rows = historyFor(exerciseId).reverse();          // de la más antigua a la más reciente
  if (!rows.length) return { unit: 'kg', points: [] };
  const unit = rows[rows.length - 1].ex.unit;
  const since = Date.now() - days * 86400000;
  const points = [];
  for (const { w, ex } of rows) {
    const t = Date.parse(w.date);
    if (t < since) continue;
    let best = null;
    for (const s of ex.sets) {
      if (s.w == null) continue;
      const c = { w: s.w, r: s.r, rir: s.rir, unit: ex.unit };
      if (!best || cmpSet(c, best) > 0) best = c;
    }
    if (best) points.push({ t, date: w.date, y: round1(convertWeight(best.w, best.unit, unit)), set: best, tip: setText(best, best.unit) });
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

function chartSvg(points, unit, days, label = 'Peso máximo por sesión') {
  const W = 340, H = 200, L = 38, R = 14, T = 20, B = 26;
  const t1 = Math.max(Date.now(), ...points.map(p => p.t)), t0 = t1 - days * 86400000;
  const ticks = niceTicks(Math.min(...points.map(p => p.y)), Math.max(...points.map(p => p.y)));
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
  const line = chart.points.length > 1
    ? `<polyline class="line" points="${chart.points.map(p => `${p.x},${p.yPx}`).join(' ')}"/>` : '';
  // Con muchos puntos solo se dibuja la línea y el último punto (al tocar se marca el elegido)
  const dense = chart.points.length > 20;
  const dots = chart.points.map((p, k) => {
    const r = dense && k < chart.points.length - 1 ? 0 : 4;
    return `<circle class="dot" data-k="${k}" data-r="${r}" cx="${p.x}" cy="${p.yPx}" r="${r}"/>`;
  }).join('');
  const last = chart.points[chart.points.length - 1];
  const lastLabel = `<text x="${Math.min(last.x, W - R)}" y="${last.yPx - 10}" text-anchor="${last.x > W - 50 ? 'end' : 'middle'}" class="value">${fmtNum(last.y)} ${unit}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${label}">
    ${grid}${xLabels}
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
    ${line}${dots}${lastLabel}
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

const rangeButtons = () => `<div class="range" role="group" aria-label="Período">${RANGES.map(([key, label]) =>
  `<button class="${key === progressRange ? 'on' : ''}" data-action="range" data-r="${key}">${label}</button>`).join('')}</div>`;

// ---------- Peso corporal ----------
// Un registro por día: { date: 'AAAA-MM-DD', kg }
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const bwIso = date => `${date}T12:00:00`;              // mediodía local, para ubicarlo bien en el gráfico
const bwDate = date => (date === todayKey() ? 'hoy' : fmtDate(bwIso(date)));
const fmtKg = n => `${fmtNum(round1(n))} kg`;
const signed = n => `${n > 0 ? '+' : ''}${fmtNum(round1(n))}`;

// Cambio en los últimos `days` días: último registro menos el primero dentro del período
function bwChange(days) {
  const list = db.bodyweight, last = list[list.length - 1];
  if (!last) return null;
  const since = Date.parse(bwIso(last.date)) - days * 86400000;
  const first = list.find(e => Date.parse(bwIso(e.date)) >= since);
  return first && first !== last ? last.kg - first.kg : null;
}

function bodyweightCard() {
  const last = db.bodyweight[db.bodyweight.length - 1];
  const change = bwChange(30);
  return `<a class="card hub" href="#/peso">
      <div class="hub-top"><span class="hub-icon">⚖️</span><strong>Peso</strong><span class="chev">›</span></div>
      ${last
        ? `<div class="hub-value"><strong>${fmtKg(last.kg)}</strong></div>
           <span class="muted">${bwDate(last.date)}${change != null ? ` · ${signed(change)} kg en 30 días` : ''}</span>`
        : '<span class="muted">Anota tu peso y mira cómo evoluciona</span>'}
    </a>`;
}

function viewBodyweight() {
  const today = db.bodyweight.find(e => e.date === todayKey());
  const last = db.bodyweight[db.bodyweight.length - 1];
  const days = RANGES.find(r => r[0] === progressRange)[2];
  const since = Date.now() - days * 86400000;
  const points = db.bodyweight
    .map(e => ({ t: Date.parse(bwIso(e.date)), date: bwIso(e.date), y: e.kg, tip: fmtKg(e.kg) }))
    .filter(p => p.t >= since);
  chart = null;

  const form = `<form class="stack card" data-form="bodyweight" novalidate>
      <label class="field"><span>${today ? 'Peso de hoy (ya anotado, puedes corregirlo)' : 'Peso de hoy'}</span>
        <div class="add-row" style="margin-top:0">
          <input name="kg" inputmode="decimal" value="${today ? toField(today.kg) : ''}"
            placeholder="${last ? toField(last.kg) : 'ej. 75,5'}" autocomplete="off" aria-label="Peso en kg">
          <span class="unit-label">kg</span>
          <button class="btn primary">Guardar</button>
        </div>
      </label>
      <p class="form-msg" hidden></p>
    </form>`;

  let body;
  if (!points.length) {
    body = `<p class="empty">${db.bodyweight.length ? 'No hay registros en este período.' : 'Todavía no anotas tu peso. Empieza hoy arriba 👆'}</p>`;
  } else {
    const ys = points.map(p => p.y);
    const change = points.length > 1 ? points[points.length - 1].y - points[0].y : null;
    body = `<div class="stats">
        <div class="stat"><span class="muted">Máximo</span><strong>${fmtKg(Math.max(...ys))}</strong></div>
        <div class="stat"><span class="muted">Mínimo</span><strong>${fmtKg(Math.min(...ys))}</strong></div>
        ${change != null ? `<div class="stat"><span class="muted">Cambio</span><strong>${signed(change)} kg</strong></div>` : ''}
      </div>
      <section class="card chart-card">
        ${chartSvg(points, 'kg', days, 'Peso corporal por día')}
        <div class="tip" hidden></div>
      </section>`;
  }

  const list = db.bodyweight.slice().reverse().map(e => `
    <div class="prog-row">
      <span class="muted">${bwDate(e.date)}</span>
      <span class="bw-right">${fmtKg(e.kg)}
        <button class="icon small danger" data-action="del-bw" data-date="${e.date}" aria-label="Borrar registro">✕</button>
      </span>
    </div>`).join('');

  return `${header('Peso corporal', { back: true, sub: 'Un registro por día, en kg' })}
    ${form}
    ${rangeButtons()}
    ${body}
    ${list ? `<h2>Registros</h2><section class="card">${list}</section>` : ''}`;
}

function saveBodyweight(f) {
  const kg = num(f.elements.kg.value);
  if (kg == null || kg < 20 || kg > 400) return formMsg(f, 'Escribe tu peso en kg (ej. 75,5).');
  const date = todayKey();
  const entry = db.bodyweight.find(e => e.date === date);
  if (entry) entry.kg = round1(kg);
  else db.bodyweight.push({ date, kg: round1(kg) });
  db.bodyweight.sort((a, b) => (a.date < b.date ? -1 : 1));
  save();
  render();
  formMsg($app.querySelector('[data-form="bodyweight"]'), `✓ Guardado: ${fmtKg(kg)} hoy`, true);
}

function viewProgressExercise(id) {
  const rows = historyFor(id);
  if (!rows.length) { location.replace('#/progreso'); return ''; }
  const name = rows[0].ex.name;
  const days = RANGES.find(r => r[0] === progressRange)[2];
  const { unit, points } = progressPoints(id, days);
  chart = null;

  const range = rangeButtons();

  if (!points.length) {
    return `${header(name, { back: true, sub: 'Peso máximo por sesión' })}${range}
      <p class="empty">No entrenaste este ejercicio en este período${rows.some(r => r.ex.sets.some(s => s.w != null)) ? '' : ' (o no tiene peso anotado)'}.</p>`;
  }

  const max = points.reduce((a, p) => (p.y > a.y ? p : a));
  const first = points[0], last = points[points.length - 1];
  const diff = round1(last.y - first.y);
  const stats = `<div class="stats">
    <div class="stat"><span class="muted">Máximo del período</span><strong>${fmtNum(max.y)} ${unit}</strong><span class="muted">${fmtDate(max.date)}</span></div>
    ${points.length > 1 ? `<div class="stat"><span class="muted">Cambio</span><strong>${diff > 0 ? '+' : ''}${fmtNum(diff)} ${unit}</strong><span class="muted">desde ${fmtDate(first.date)}</span></div>` : ''}
  </div>`;

  const table = points.slice().reverse().map(p => `
    <div class="prog-row"><span class="muted">${fmtDate(p.date)}</span><span>${setText(p.set, p.set.unit)}</span></div>`).join('');

  return `${header(name, { back: true, sub: 'Peso máximo por sesión' })}
    ${range}
    ${stats}
    <section class="card chart-card">
      ${chartSvg(points, unit, days)}
      <div class="tip" hidden></div>
    </section>
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
  if (screen !== 'rutina') shareResult = null;

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
    case 'nutricion': html = viewNutrition(arg); break;
    case 'alimento': html = viewFoodForm(arg, routeParts()[2]); break;
    case 'dieta': html = viewDietEditor(arg); break;
    default: html = viewHub();   // Inicio: sin pestañas
  }
  $app.innerHTML = html;
  $tabs.hidden = !tab;
  $tabs.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  if (tab === 'progreso' && progressQuery) filterProgress();
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
    exercises: r.exercises.map(ex => ({
      exerciseId: ex.id, name: ex.name, unit: ex.unit, rest: ex.rest || 0, rir: !!ex.rir,
      sets: prefillSets(lastFor(ex.id), ex.rir),
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
    sets: ex.sets
      .map(s => { const set = { w: num(s.w), r: num(s.r) }; const rir = num(s.rir); if (ex.rir && rir != null) set.rir = rir; return set; })
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
  db.workouts.push({ id, routineId: d.routineId, routineName: d.routineName, date: d.start, durationSec, exercises });
  db.draft = null;
  save();
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
      sets: ex.sets.map(s => ({ w: toField(s.w), r: toField(s.r), ...(ex.rir ? { rir: toField(s.rir) } : {}) })),
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
    b.textContent = !active ? `Rest ${fmtRest(d.exercises[i].rest)}` : left > 0 ? `Rest ${fmtRest(left)}` : '¡A darle!';
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
const hasWater = w => !!w && (w.goalMl != null || Object.keys(w.days || {}).length > 0);
const mainData = () => ({
  routines: db.routines, notes: db.notes,
  ...(db.bodyweight.length ? { bodyweight: db.bodyweight } : {}),
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
  const bw = data.bodyweight || [];
  const water = hasWater(data.water) ? { ...emptyWater(), ...data.water } : emptyWater();
  const remote = {
    routines: data.routines || [], notes: data.notes || {},
    ...(bw.length ? { bodyweight: bw } : {}),
    ...(hasWater(water) ? { water } : {}),
    ...(hasNutrition(data.nutrition) ? { nutrition: data.nutrition } : {}),
  };
  const r = stable(remote), local = stable(mainData());
  if (local !== synced.main) return;
  synced.main = r;
  if (r !== local) { db.routines = remote.routines; db.notes = remote.notes; db.bodyweight = bw; db.water = water; db.nutrition = hasNutrition(data.nutrition) ? { ...emptyNutrition(), ...data.nutrition } : emptyNutrition(); refresh(); }
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
  if (!u) {
    user = null;
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

  status = 'ready';
  persistLocal();
  stopListening = cloud.listen(u.uid, applyRemoteMain, applyRemoteWorkouts);
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

  $err.hidden = true;
  $btn.disabled = true;
  $btn.textContent = reg ? 'Creando cuenta…' : 'Entrando…';
  try {
    if (reg) { pendingUsername = username; await cloud.register(email, password, username); }
    else await cloud.login(email, password);
    // handleUser se encarga del resto cuando Firebase confirma la sesión
  } catch (e) {
    pendingUsername = null;
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
    case 'del-bw': {
      const k = db.bodyweight.findIndex(e => e.date === el.dataset.date);
      if (k < 0) return;
      const [removed] = db.bodyweight.splice(k, 1);
      save(); render();
      showUndo(`Registro de ${bwDate(removed.date)} borrado`, () => {
        db.bodyweight.push(removed);
        db.bodyweight.sort((a, b) => (a.date < b.date ? -1 : 1));
        save(); render();
      });
      break;
    }
    case 'range':
      progressRange = el.dataset.r;
      render();
      break;
    case 'toggle-rir': {
      const ex = curRoutine().exercises[i];
      ex.rir = !ex.rir;
      save(); render();
      break;
    }
    case 'toggle-unit': {
      const ex = curRoutine().exercises[i];
      ex.unit = ex.unit === 'kg' ? 'lb' : 'kg';
      save(); render();
      break;
    }
    case 'move': {
      const list = curRoutine().exercises, k = i + Number(el.dataset.d);
      [list[i], list[k]] = [list[k], list[i]];
      save(); render();
      break;
    }
    case 'del-ex': {
      const r = curRoutine();
      if (!confirm(`¿Quitar "${r.exercises[i].name}" de la rutina? Su historial se mantiene.`)) return;
      r.exercises.splice(i, 1);
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
      const r = curRoutine();
      if (!confirm(`¿Eliminar la rutina "${r.name}"? Tu historial se mantiene.`)) return;
      db.routines = db.routines.filter(x => x !== r);
      save(); history.back();
      break;
    }

    // Entrenamiento (en curso o editando uno guardado)
    case 'go-ex':
    case 'prev-ex':
    case 'next-ex': {
      const d = cur();
      if (action === 'next-ex' && !d.done.includes(d.exercises[d.pos].exerciseId)) d.done.push(d.exercises[d.pos].exerciseId);
      d.pos = action === 'go-ex' ? i : d.pos + (action === 'next-ex' ? 1 : -1);
      hideToast();
      save(); render();
      window.scrollTo(0, 0);
      const chip = $app.querySelector('.step.on');
      if (chip) chip.scrollIntoView({ inline: 'center', block: 'nearest' });
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
      const exId = cur().exercises[i].exerciseId;
      if (!openHistory.delete(exId)) openHistory.add(exId);
      render();
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
      form.elements.g.placeholder = isUnit(food) ? 'cant.' : 'g';
      form.elements.g.setAttribute('aria-label', isUnit(food) ? 'Cantidad' : 'Gramos');
      form.elements.g.focus();
      break;
    }
    case 'nutri-use': {
      const log = N().log[todayKey()];
      N().activeDietId = id;
      setTodayLog(id, (log && log.byDiet && log.byDiet[id]) || []);
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
        .then(() => { el.textContent = '✓ Link copiado'; }, () => alert(`Link: ${shareLink(shareResult.code)}`));
      break;
    case 'send-code': {
      const text = shareText(curRoutine().name, shareResult.code);
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      break;
    }
    case 'show-import':
      importOpen = true;
      render();
      $app.querySelector('[data-form="import-code"] input').focus();
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
  }
});

// Escritura en campos: se guarda al instante, sin redibujar (para no perder el foco)
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
    else { const g = num(el.value); if (g != null && g >= 0) { diet.meals[m].items[+el.dataset.i].g = g; paintDietTotals(diet); } }
    save();
    return;
  }
  const i = +el.dataset.i, j = +el.dataset.j;
  if (bind === 'routine-name') curRoutine().name = el.value;
  else if (bind === 'ex-name') curRoutine().exercises[i].name = el.value;
  else if (bind === 'ex-rest') {
    const sec = parseRest(el.value);
    if (sec !== null) curRoutine().exercises[i].rest = sec;
  }
  else if (bind === 'w' || bind === 'r') {
    const d = cur(), ex = d.exercises[i];
    ex.sets[j][bind] = el.value;
    const cell = $app.querySelector(`[data-mark="${i}-${j}"]`);
    if (cell) cell.innerHTML = markSpan(liveCmp(ex.sets[j], ex.unit, bestSets(ex.exerciseId, beforeIndex(d))[j]));
  }
  else if (bind === 'rir') cur().exercises[i].sets[j].rir = el.value;
  else if (bind === 'note') {
    const exId = cur().exercises[i].exerciseId, text = el.value.trim();
    if (text) db.notes[exId] = text; else delete db.notes[exId];
  }
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
  }
});

$app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.target.dataset.bind === 'note' || e.target.dataset.bind === 'ex-rest')) e.target.blur();
});

$app.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  switch (f.dataset.form) {
    case 'login':
    case 'register': submitAuth(f); return;
    case 'username': submitUsername(f); return;
    case 'password': submitPassword(f); return;
    case 'import-code': importRoutine(f); return;
    case 'bodyweight': saveBodyweight(f); return;
    case 'food': saveFood(f); return;
    case 'add-item': {
      const diet = dietById(routeParts()[1]), m = +f.dataset.m;
      const typed = normText(f.elements.q.value.trim());
      const exact = typed && [...N().foods, ...BASE_FOODS].find(x => normText(x.name) === typed);
      const foodId = f.dataset.food || (exact && exact.id), g = num(f.elements.g.value);
      if (!foodId) { alert('Busca el alimento y elígelo de la lista.'); f.elements.q.focus(); return; }
      const unitFood = isUnit(foodById(foodId));
      if (g == null || g <= 0 || g > (unitFood ? 100 : 5000)) { alert(unitFood ? 'Escribe la cantidad (ej. 2).' : 'Escribe los gramos (ej. 120).'); f.elements.g.focus(); return; }
      diet.meals[m].items.push({ foodId, g: round1(g) });
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
      formMsg($app.querySelector('[data-form="water-goal"]'), `✓ Meta guardada: ${fmtL(db.water.goalMl)} L`, true);
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
if (linkParams.get('r')) {
  localStorage.setItem(PENDING_IMPORT, normCode(linkParams.get('r')));
  linkParams.delete('r');
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
