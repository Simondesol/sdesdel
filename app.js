// ---------- Datos ----------
// Cada usuario tiene una copia en el teléfono (para usar la app sin internet en el gym)
// que se sincroniza con su cuenta en la nube. El entrenamiento en curso solo vive en el teléfono.
const LEGACY_KEY = 'sdesdel-v1';                 // datos de antes de que existieran las cuentas
const userKey = id => `sdesdel-u-${id}`;
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');

const emptyDb = () => ({ routines: [], workouts: [], draft: null, notes: {} });
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
    ${list || '<p class="empty">Aún no hay entrenamientos guardados.</p>'}`;
}

// ---------- Cuenta ----------
function viewAuth(mode) {
  const reg = mode === 'registro';
  return `<div class="auth">
    <img class="auth-logo" src="icons/icon-192.png" alt="">
    <h1>Desdel</h1>
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
  return `${header('Cuenta')}
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
  const routine = { name: r.name, exercises: r.exercises.map(ex => ({ name: ex.name, unit: ex.unit, rest: ex.rest || 0 })) };
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
      return { id: mine ? mine.id : uid(), name: mine ? mine.name : ex.name, unit: mine ? mine.unit : ex.unit, rest: ex.rest || 0 };
    }),
  };
  db.routines.push(routine);
  importOpen = false;
  save();
  go('#/rutina/' + routine.id);
}

const logoImg = '<img class="auth-logo" src="icons/icon-192.png" alt="">';
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
    case 'sesion': html = viewSession(arg); break;
    case 'ejercicio': html = viewExercise(decodeURIComponent(arg)); break;
    case 'cuenta': html = viewAccount(); tab = 'cuenta'; break;
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
const mainData = () => ({ routines: db.routines, notes: db.notes });
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
  const remote = { routines: data.routines || [], notes: data.notes || {} };
  const r = stable(remote), local = stable(mainData());
  if (local !== synced.main) return;
  synced.main = r;
  if (r !== local) { db.routines = remote.routines; db.notes = remote.notes; refresh(); }
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
