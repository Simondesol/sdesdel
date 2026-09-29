'use strict';

// ---------- Datos (guardados en el teléfono) ----------
const KEY = 'sdesdel-v1';
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');

let db = load();
let lastUnit = 'kg';

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.routines) && Array.isArray(d.workouts)) return d;
  } catch (e) { /* datos corruptos o vacíos */ }
  return { routines: [], workouts: [], draft: null };
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
  return `${header('SdeSdeL')}
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
    return `<section class="card">
      <div class="ex-head"><strong>${esc(ex.name)}</strong></div>
      <p class="prev">${esc(prevText)}</p>
      ${sets}
      <button class="btn ghost" data-action="add-set" data-i="${i}">+ serie</button>
    </section>`;
  }).join('');
  return `${header(d.routineName, { back: true, sub: fmtLongDate(d.start) })}
    ${blocks}
    <div class="actions">
      <button class="btn primary block" data-action="finish">Terminar y guardar</button>
      <button class="btn ghost block danger-text" data-action="discard">Descartar entrenamiento</button>
    </div>`;
}

function viewHistory(mode) {
  const seg = `<div class="seg">
    <button class="${mode === 'sesiones' ? 'on' : ''}" data-action="seg" data-to="#/historial">Sesiones</button>
    <button class="${mode === 'ejercicios' ? 'on' : ''}" data-action="seg" data-to="#/historial/ejercicios">Ejercicios</button>
  </div>`;
  const empty = '<p class="empty">Aún no hay entrenamientos guardados.</p>';

  if (mode === 'sesiones') {
    const list = db.workouts.slice().reverse().map(w => `
      <a class="card" href="#/sesion/${w.id}">
        <div class="grow">
          <strong>${esc(w.routineName)}</strong>
          <span class="muted">${fmtDate(w.date)} · ${plural(w.exercises.length, 'ejercicio')} · ${plural(setsCount(w), 'serie')}</span>
        </div>
        <span class="chev">›</span>
      </a>`).join('');
    return `${header('Historial')}${seg}${list || empty}`;
  }

  const byId = new Map();
  for (const w of db.workouts) {
    for (const ex of w.exercises) {
      const e = byId.get(ex.exerciseId) || { id: ex.exerciseId, count: 0 };
      e.name = ex.name; e.date = w.date; e.count++;
      byId.set(ex.exerciseId, e);
    }
  }
  const list = [...byId.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'es'))
    .map(e => `
      <a class="card" href="#/ejercicio/${encodeURIComponent(e.id)}">
        <div class="grow">
          <strong>${esc(e.name)}</strong>
          <span class="muted">${plural(e.count, 'vez', 'veces')} · última: ${fmtDate(e.date)}</span>
        </div>
        <span class="chev">›</span>
      </a>`).join('');
  return `${header('Historial')}${seg}${list || empty}`;
}

function viewSession(id) {
  const w = db.workouts.find(x => x.id === id);
  if (!w) { location.replace('#/historial'); return ''; }
  const blocks = w.exercises.map(ex => `
    <section class="card">
      <a class="ex-link" href="#/ejercicio/${encodeURIComponent(ex.exerciseId)}">${esc(ex.name)} <span class="chev">›</span></a>
      <div class="sets-list">${ex.sets.map(s => `<span>${fmtNum(s.w)} ${ex.unit} × ${fmtNum(s.r)}</span>`).join('')}</div>
    </section>`).join('');
  return `${header(w.routineName, { back: true, sub: fmtLongDate(w.date) })}
    ${blocks}
    <button class="btn ghost block danger-text" data-action="del-session" data-id="${w.id}" style="margin-top:24px">Eliminar este entrenamiento</button>`;
}

function viewExercise(id) {
  const rows = [];
  for (const w of db.workouts) {
    const ex = w.exercises.find(e => e.exerciseId === id);
    if (ex) rows.push({ w, ex });
  }
  if (!rows.length) { location.replace('#/historial/ejercicios'); return ''; }
  const name = rows[rows.length - 1].ex.name;
  const blocks = rows.reverse().map(({ w, ex }) => `
    <section class="card">
      <div class="ex-head"><strong>${fmtDate(w.date)}</strong><span class="muted">${esc(w.routineName)}</span></div>
      <div class="sets-list">${ex.sets.map(s => `<span>${fmtNum(s.w)} ${ex.unit} × ${fmtNum(s.r)}</span>`).join('')}</div>
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
    case 'historial': html = viewHistory(arg === 'ejercicios' ? 'ejercicios' : 'sesiones'); tab = 'historial'; break;
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

    case 'add-set': {
      const sets = db.draft.exercises[i].sets;
      const last = sets[sets.length - 1];
      sets.push(last ? { ...last } : { w: '', r: '' });
      save(); render();
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

    case 'seg':
      location.replace(el.dataset.to);
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
  save();
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
// Pide al navegador que no borre los datos automáticamente
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
