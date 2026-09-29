'use strict';

// ---------- Datos (guardados en el teléfono) ----------
const KEY = 'sdesdel-v1';
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');

let db = load();
let lastUnit = 'kg';
const openHistory = new Set();   // ejercicios con el historial desplegado
let editingNote = null;          // ejercicio cuya nota se está editando

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

function header(title, { back = false, sub = '' } = {}) {
  return `<header class="bar">
    ${back ? '<button class="icon" data-action="back" aria-label="Volver">‹</button>' : ''}
    <div class="titles"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
  </header>`;
}

// Última vez que se hizo un ejercicio
function lastFor(exerciseId) {
  for (let i = db.workouts.length - 1; i >= 0; i--) {
    const w = db.workouts[i];
    const ex = w.exercises.find(e => e.exerciseId === exerciseId);
    if (ex) return { date: w.date, ex };
  }
  return null;
}

// Todas las veces que se hizo un ejercicio, de la más reciente a la más antigua
function historyFor(exerciseId) {
  const rows = [];
  for (const w of db.workouts) {
    const ex = w.exercises.find(e => e.exerciseId === exerciseId);
    if (ex) rows.push({ w, ex });
  }
  return rows.reverse();
}

const setsChips = ex => `<div class="sets-list">${ex.sets.map(s => `<span>${fmtNum(s.w)} ${ex.unit} × ${fmtNum(s.r)}</span>`).join('')}</div>`;

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

// ---------- Pantallas ----------
function viewHome() {
  const d = db.draft;
  const resume = d ? `
    <a class="card resume" href="#/entrenar">
      <div class="grow"><strong>Entrenamiento en curso</strong><span class="muted">${esc(d.routineName)}</span></div>
      <span class="chev">›</span>
    </a>` : '';
  const routines = db.routines.map(r => `
    <div class="card routine">
      <a href="#/rutina/${r.id}">
        <strong>${esc(r.name) || '(sin nombre)'}</strong>
        <span class="muted">${plural(r.exercises.length, 'ejercicio')} · editar</span>
      </a>
      <button class="btn primary" data-action="start" data-id="${r.id}" ${r.exercises.length ? '' : 'disabled'}>Empezar</button>
    </div>`).join('');
  return `${header('SdeSdel')}
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
      <select name="unit" aria-label="Unidad">
        <option ${lastUnit === 'kg' ? 'selected' : ''}>kg</option>
        <option ${lastUnit === 'lb' ? 'selected' : ''}>lb</option>
      </select>
      <button class="btn">Agregar</button>
    </form>
    <button class="btn ghost block danger-text" data-action="del-routine" style="margin-top:32px">Eliminar rutina</button>`;
}

function viewWorkout() {
  const d = db.draft;
  if (!d) { location.replace('#/'); return ''; }
  const blocks = d.exercises.map((ex, i) => {
    const prev = lastFor(ex.exerciseId);
    const prevText = prev
      ? `Anterior (${fmtDate(prev.date)}): ${prev.ex.sets.map(s => `${fmtNum(s.w)}×${fmtNum(s.r)}`).join(' · ')} ${prev.ex.unit}`
      : 'Primera vez';
    const sets = ex.sets.map((s, j) => `
      <div class="set">
        <span class="n">${j + 1}</span>
        <input inputmode="decimal" data-bind="w" data-i="${i}" data-j="${j}" value="${esc(s.w)}" placeholder="peso" aria-label="Peso serie ${j + 1}">
        <span class="u">${ex.unit}</span>
        <span class="x">×</span>
        <input inputmode="numeric" data-bind="r" data-i="${i}" data-j="${j}" value="${esc(s.r)}" placeholder="reps" aria-label="Repeticiones serie ${j + 1}">
        <button class="icon danger" data-action="del-set" data-i="${i}" data-j="${j}" aria-label="Borrar serie">✕</button>
      </div>`).join('');
    const open = openHistory.has(ex.exerciseId);
    const past = open ? historyFor(ex.exerciseId).map(({ w, ex: pex }) => `
      <div class="hist-item">
        <div class="muted">${fmtDate(w.date)}</div>
        ${setsChips(pex)}
      </div>`).join('') || '<p class="muted">Aún no hay historial de este ejercicio.</p>' : '';
    return `<section class="card">
      <div class="ex-head"><strong>${esc(ex.name)}</strong></div>
      ${noteHtml(ex.exerciseId, i)}
      <p class="prev">${esc(prevText)}</p>
      ${sets}
      <div class="ex-actions">
        <button class="btn ghost" data-action="add-set" data-i="${i}">+ serie</button>
        <button class="btn ghost ${open ? 'on' : ''}" data-action="toggle-history" data-i="${i}">Historial ${open ? '▴' : '▾'}</button>
      </div>
      ${open ? `<div class="hist">${past}</div>` : ''}
    </section>`;
  }).join('');
  return `${header(d.routineName, { back: true, sub: fmtLongDate(d.start) })}
    ${blocks}
    <div class="actions">
      <button class="btn primary block" data-action="finish">Terminar y guardar</button>
      <button class="btn ghost block danger-text" data-action="discard">Descartar entrenamiento</button>
    </div>`;
}

function viewHistory() {
  const list = db.workouts.slice().reverse().map(w => `
    <a class="card" href="#/sesion/${w.id}">
      <div class="grow">
        <strong>${esc(w.routineName)}</strong>
        <span class="muted">${fmtDate(w.date)} · ${plural(w.exercises.length, 'ejercicio')} · ${plural(setsCount(w), 'serie')}</span>
      </div>
      <span class="chev">›</span>
    </a>`).join('');
  return `${header('Historial')}${list || '<p class="empty">Aún no hay entrenamientos guardados.</p>'}`;
}

function viewSession(id) {
  const w = db.workouts.find(x => x.id === id);
  if (!w) { location.replace('#/historial'); return ''; }
  const blocks = w.exercises.map(ex => `
    <section class="card">
      <a class="ex-link" href="#/ejercicio/${encodeURIComponent(ex.exerciseId)}">${esc(ex.name)} <span class="chev">›</span></a>
      ${setsChips(ex)}
    </section>`).join('');
  return `${header(w.routineName, { back: true, sub: fmtLongDate(w.date) })}
    ${blocks}
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
  let html, tab = null;
  switch (screen) {
    case 'rutina': html = viewRoutine(); break;
    case 'entrenar': html = viewWorkout(); break;
    case 'historial': html = viewHistory(); tab = 'historial'; break;
    case 'sesion': html = viewSession(arg); break;
    case 'ejercicio': html = viewExercise(decodeURIComponent(arg)); break;
    default: html = viewHome(); tab = 'rutinas';
  }
  $app.innerHTML = html;
  $tabs.hidden = !tab;
  $tabs.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
}

const go = hash => { location.hash = hash; };

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// ---------- Acciones ----------
function startWorkout(r) {
  db.draft = {
    routineId: r.id,
    routineName: r.name,
    start: new Date().toISOString(),
    exercises: r.exercises.map(ex => {
      const prev = lastFor(ex.id);
      const sets = prev
        ? prev.ex.sets.map(s => ({ w: toField(s.w), r: toField(s.r) }))
        : [{ w: '', r: '' }];
      return { exerciseId: ex.id, name: ex.name, unit: ex.unit, sets };
    }),
  };
  save();
  go('#/entrenar');
}

function finishWorkout() {
  const d = db.draft;
  const exercises = d.exercises
    .map(ex => ({
      exerciseId: ex.exerciseId,
      name: ex.name,
      unit: ex.unit,
      sets: ex.sets.map(s => ({ w: num(s.w), r: num(s.r) })).filter(s => s.w != null || s.r != null),
    }))
    .filter(ex => ex.sets.length);
  if (!exercises.length) { alert('No hay series anotadas todavía.'); return; }
  db.workouts.push({ id: uid(), routineId: d.routineId, routineName: d.routineName, date: d.start, exercises });
  db.draft = null;
  save();
  location.replace('#/historial');
}

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
    case 'del-routine': {
      const r = curRoutine();
      if (!confirm(`¿Eliminar la rutina "${r.name}"? Tu historial se mantiene.`)) return;
      db.routines = db.routines.filter(x => x !== r);
      save(); history.back();
      break;
    }

    case 'add-set':
      db.draft.exercises[i].sets.push({ w: '', r: '' });
      save(); render();
      break;
    case 'toggle-history': {
      const exId = db.draft.exercises[i].exerciseId;
      if (!openHistory.delete(exId)) openHistory.add(exId);
      render();
      break;
    }
    case 'edit-note': {
      editingNote = db.draft.exercises[i].exerciseId;
      redrawNote(i);
      const input = $app.querySelector(`[data-note="${i}"] input`);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      break;
    }
    case 'del-set':
      db.draft.exercises[i].sets.splice(j, 1);
      save(); render();
      break;
    case 'finish':
      finishWorkout();
      break;
    case 'discard':
      if (!confirm('¿Descartar este entrenamiento? No se guardará nada.')) return;
      db.draft = null;
      save(); location.replace('#/');
      break;

    case 'del-session':
      if (!confirm('¿Eliminar este entrenamiento del historial?')) return;
      db.workouts = db.workouts.filter(w => w.id !== id);
      save(); history.back();
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
  else if (bind === 'w' || bind === 'r') db.draft.exercises[i].sets[j][bind] = el.value;
  else if (bind === 'note') {
    const exId = db.draft.exercises[i].exerciseId, text = el.value.trim();
    if (text) db.notes[exId] = text; else delete db.notes[exId];
  }
  save();
});

// Redibuja solo la nota (sin tocar el resto, para no perder el toque en otro botón)
function redrawNote(i) {
  const wrap = $app.querySelector(`[data-note="${i}"]`);
  if (wrap) wrap.outerHTML = noteHtml(db.draft.exercises[i].exerciseId, i);
}

$app.addEventListener('focusout', e => {
  if (e.target.dataset.bind !== 'note' || editingNote === null) return;
  editingNote = null;
  redrawNote(+e.target.dataset.i);
});

$app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset.bind === 'note') e.target.blur();
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
    curRoutine().exercises.push({ id: uid(), name: title, unit: lastUnit });
    save(); render();
    $app.querySelector('[data-form="new-ex"] input').focus();
  }
});

// ---------- Inicio ----------
render();

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
