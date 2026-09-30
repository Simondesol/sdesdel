'use strict';

// ---------- Datos (guardados en el teléfono) ----------
const KEY = 'sdesdel-v1';
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');

let db = load();
let lastUnit = 'kg';
const openHistory = new Set();   // ejercicios con el historial desplegado
let editingNote = null;          // ejercicio cuya nota se está editando
let editBuf = null;              // copia de un entrenamiento guardado que se está editando
let justFinished = null;         // entrenamiento recién guardado (para mostrar el resumen)

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.routines) && Array.isArray(d.workouts)) {
      d.notes = d.notes || {};   // agregado en v2: notas por ejercicio
      return d;
    }
  } catch (e) { /* datos corruptos o vacíos */ }
  return { routines: [], workouts: [], draft: null, notes: {} };
}
function save() { localStorage.setItem(KEY, JSON.stringify(db)); }

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
  return h ? `${h} h ${m} min` : `${m} min`;
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

function header(title, { back = false, sub = '' } = {}) {
  return `<header class="bar">
    ${back ? '<button class="icon" data-action="back" aria-label="Volver">‹</button>' : ''}
    <div class="titles"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
  </header>`;
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

const prefillSets = prev => (prev
  ? prev.ex.sets.map(s => ({ w: toField(s.w), r: toField(s.r) }))
  : [{ w: '', r: '' }]);

const setsChips = ex => `<div class="sets-list">${ex.sets.map(s => `<span>${fmtNum(s.w)} ${ex.unit} × ${fmtNum(s.r)}</span>`).join('')}</div>`;

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
  return `${header('Desdel', { sub: 'Entrena. Anota. Supera.' })}
    ${resume}
    ${routines || '<p class="empty">Aún no tienes rutinas. Crea la primera abajo.</p>'}
    <form class="add-row" data-form="new-routine">
      <input name="title" placeholder="Nueva rutina (ej. Brazo)" autocomplete="off" required>
      <button class="btn">Crear</button>
    </form>`;
}

function viewRoutine() {
  const r = curRoutine();
  if (!r) { location.replace('#/'); return ''; }
  const last = r.exercises.length - 1;
  const items = r.exercises.map((ex, i) => `
    <li class="card">
      <input class="grow" data-bind="ex-name" data-i="${i}" value="${esc(ex.name)}" aria-label="Nombre del ejercicio">
      <button class="chip" data-action="toggle-unit" data-i="${i}" aria-label="Cambiar unidad">${ex.unit}</button>
      <button class="icon" data-action="move" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir">↑</button>
      <button class="icon" data-action="move" data-i="${i}" data-d="1" ${i === last ? 'disabled' : ''} aria-label="Bajar">↓</button>
      <label class="rest-field">Rest
        <input data-bind="ex-rest" data-i="${i}" value="${ex.rest ? fmtRest(ex.rest) : ''}" placeholder="m:ss" autocomplete="off" aria-label="Descanso entre series">
      </label>
      <button class="icon danger" data-action="del-ex" data-i="${i}" aria-label="Quitar">✕</button>
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
    <button class="btn block" data-action="dup-routine" style="margin-top:32px">Duplicar rutina</button>
    <button class="btn ghost block danger-text" data-action="del-routine">Eliminar rutina</button>`;
}

function viewWorkout() {
  const d = cur();
  if (!d) { location.replace(isEditing() ? '#/historial' : '#/'); return ''; }
  const editing = !!d.editOf;
  const before = beforeIndex(d);

  const blocks = d.exercises.map((ex, i) => {
    const best = bestSets(ex.exerciseId, before);
    const sets = ex.sets.map((s, j) => `
      <div class="set">
        <span class="n">${j + 1}</span>
        <input inputmode="decimal" data-bind="w" data-i="${i}" data-j="${j}" value="${esc(s.w)}" placeholder="peso" aria-label="Peso serie ${j + 1}">
        <span class="u">${ex.unit}</span>
        <span class="x">×</span>
        <input inputmode="numeric" data-bind="r" data-i="${i}" data-j="${j}" value="${esc(s.r)}" placeholder="reps" aria-label="Repeticiones serie ${j + 1}">
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
  }).join('');

  const title = editing ? `Editar · ${d.routineName}` : d.routineName;
  return `${header(title, { back: true, sub: fmtLongDate(d.start) })}
    ${blocks}
    <form class="add-row" data-form="extra-ex">
      <input name="title" placeholder="+ Ejercicio extra" autocomplete="off" required>
      ${unitSelect()}
      <button class="btn">Agregar</button>
    </form>
    <div class="actions">
      ${editing
        ? `<button class="btn primary block" data-action="save-edit">Guardar cambios</button>
           <button class="btn ghost block" data-action="back">Cancelar</button>`
        : `<button class="btn primary block" data-action="finish">Terminar y guardar</button>
           <button class="btn ghost block danger-text" data-action="discard">Descartar entrenamiento</button>`}
    </div>
    ${editing ? '' : `<div id="restbar" class="restbar" hidden>
      <span class="rb-text"></span>
      <button class="icon" data-action="rest-stop" aria-label="Cerrar descanso">✕</button>
    </div>`}`;
}

function viewHistory() {
  const list = db.workouts.slice().reverse().map(w => `
    <a class="card" href="#/sesion/${w.id}">
      <div class="grow">
        <strong>${esc(w.routineName)}</strong>
        <span class="muted">${fmtDate(w.date)} · ${plural(w.exercises.length, 'ejercicio')} · ${plural(setsCount(w), 'serie')}${w.durationSec ? ` · ${fmtDuration(w.durationSec)}` : ''}</span>
      </div>
      <span class="chev">›</span>
    </a>`).join('');
  return `${header('Historial')}
    ${list || '<p class="empty">Aún no hay entrenamientos guardados.</p>'}
    <h2>Respaldo</h2>
    <p class="muted hint">Guarda un archivo con todas tus rutinas, notas e historial, o restaura uno anterior (por ejemplo, si cambias de celular).</p>
    <div class="ex-actions">
      <button class="btn" data-action="export">Exportar respaldo</button>
      <label class="btn file-btn">Importar<input type="file" accept=".json,application/json" data-file="import" hidden></label>
    </div>`;
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
      return `<span>${fmtNum(s.w)} ${ex.unit} × ${fmtNum(s.r)} ${markSpan(c)}</span>`;
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
    ${blocks}
    <a class="btn block center" href="#/editar/${w.id}">Editar entrenamiento</a>
    <button class="btn ghost block danger-text" data-action="del-session" data-id="${w.id}" style="margin-top:24px">Eliminar este entrenamiento</button>`;
}

function viewExercise(id) {
  const rows = historyFor(id);
  if (!rows.length) { location.replace('#/historial'); return ''; }
  const name = rows[0].ex.name;
  const blocks = rows.map(({ w, ex }) => `
    <section class="card">
      <div class="ex-head"><strong>${fmtDate(w.date)}</strong><span class="muted">${esc(w.routineName)}</span></div>
      ${setsChips(ex)}
    </section>`).join('');
  return `${header(name, { back: true, sub: plural(rows.length, 'sesión', 'sesiones') })}${blocks}`;
}

// ---------- Render / navegación ----------
function render() {
  const [screen, arg = ''] = routeParts();
  if (screen !== 'editar') editBuf = null;
  else if (!editBuf || editBuf.editOf !== arg) editBuf = makeEditBuf(arg);
  if (screen !== 'sesion' || arg !== justFinished) justFinished = null;

  let html, tab = null;
  switch (screen) {
    case 'rutina': html = viewRoutine(); break;
    case 'entrenar':
    case 'editar': html = viewWorkout(); break;
    case 'historial': html = viewHistory(); tab = 'historial'; break;
    case 'sesion': html = viewSession(arg); break;
    case 'ejercicio': html = viewExercise(decodeURIComponent(arg)); break;
    default: html = viewHome(); tab = 'rutinas';
  }
  $app.innerHTML = html;
  $tabs.hidden = !tab;
  $tabs.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
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
      exerciseId: ex.id, name: ex.name, unit: ex.unit, rest: ex.rest || 0,
      sets: prefillSets(lastFor(ex.id)),
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
    sets: ex.sets.map(s => ({ w: num(s.w), r: num(s.r) })).filter(s => s.w != null || s.r != null),
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
      sets: ex.sets.map(s => ({ w: toField(s.w), r: toField(s.r) })),
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
    if (ex) return { id: ex.id, name: ex.name, unit: ex.unit, rest: ex.rest || 0 };
  }
  for (let i = db.workouts.length - 1; i >= 0; i--) {
    const ex = db.workouts[i].exercises.find(e => sameName(e.name, name));
    if (ex) return { id: ex.exerciseId, name: ex.name, unit: ex.unit, rest: 0 };
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
    sets: prefillSets(lastFor(id, before)),
  });
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

// ---------- Respaldo ----------
function exportBackup() {
  const payload = {
    app: 'sdesdel',
    exportedAt: new Date().toISOString(),
    data: { routines: db.routines, workouts: db.workouts, notes: db.notes },
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sdesdel-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importBackup(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const data = parsed.data || parsed;
    if (!Array.isArray(data.routines) || !Array.isArray(data.workouts)) throw new Error('formato');
    const msg = `Este respaldo tiene ${plural(data.routines.length, 'rutina')} y ${plural(data.workouts.length, 'entrenamiento')}.\n\n` +
      'Va a REEMPLAZAR todo lo que tienes ahora en la app. ¿Continuar?';
    if (!confirm(msg)) return;
    db = { routines: data.routines, workouts: data.workouts, notes: data.notes || {}, draft: null };
    save();
    setTimer(null);
    render();
    alert('Respaldo restaurado.');
  } catch (e) {
    alert('No se pudo leer el archivo. Asegúrate de elegir un respaldo exportado desde Desdel.');
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
    case 'add-set':
      cur().exercises[i].sets.push({ w: '', r: '' });
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
      save(); location.replace('#/');
      break;
    case 'save-edit':
      saveEdit();
      break;

    // Historial
    case 'del-session':
      if (!confirm('¿Eliminar este entrenamiento del historial?')) return;
      db.workouts = db.workouts.filter(w => w.id !== id);
      save(); history.back();
      break;
    case 'export':
      exportBackup();
      break;
  }
});

// Escritura en campos: se guarda al instante, sin redibujar (para no perder el foco)
$app.addEventListener('input', e => {
  const el = e.target, bind = el.dataset.bind;
  if (!bind) return;
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
  else if (bind === 'note') {
    const exId = cur().exercises[i].exerciseId, text = el.value.trim();
    if (text) db.notes[exId] = text; else delete db.notes[exId];
  }
  save();
});

$app.addEventListener('change', e => {
  if (e.target.dataset.file === 'import' && e.target.files[0]) {
    importBackup(e.target.files[0]);
    e.target.value = '';
  }
});

// Redibuja solo la nota (sin tocar el resto, para no perder el toque en otro botón)
function redrawNote(i) {
  const wrap = $app.querySelector(`[data-note="${i}"]`);
  if (wrap) wrap.outerHTML = noteHtml(cur().exercises[i].exerciseId, i);
}

$app.addEventListener('focusout', e => {
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
render();
if (db.draft && db.draft.timer) keepScreenOn(true);

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
