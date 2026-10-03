// Conexión con Firebase: cuentas (correo + contraseña) y datos en la nube.
// Estructura en Firestore:
//   users/{uid}                 → { username, email, createdAt }
//   users/{uid}/data/main       → { routines, notes }
//   users/{uid}/workouts/{id}   → un entrenamiento guardado
//   users/{uid}/progressThumbs/{id} y progress/{id} → fotos de progreso (miniatura + grande)
//   shared/{código}             → rutina o dieta compartida { ownerUid, ownerName, routine | diet, createdAt }
//   invites/{código}            → código de gymbro { ownerUid, ownerName, createdAt }
//   chats/{uidA_uidB}           → chat entre dos gymbros { members, names, via, last, createdAt }
//   chats/{id}/messages/{id}    → mensaje { from, at, type, text | diet | routine }
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, signOut, updateProfile, updatePassword,
  reauthenticateWithCredential, EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, deleteDoc, onSnapshot, serverTimestamp,
  query, where, orderBy, limitToLast, updateDoc, writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);            // la sesión queda guardada en el teléfono hasta cerrar sesión
auth.languageCode = 'es';             // correos de recuperación en español
const fs = getFirestore(app);

const mainRef = uid => doc(fs, 'users', uid, 'data', 'main');
const workoutsRef = uid => collection(fs, 'users', uid, 'workouts');

export function onUser(cb) {
  onAuthStateChanged(auth, u => cb(u && { uid: u.uid, email: u.email, username: u.displayName || '' }));
}

export async function register(email, password, username) {
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(user, { displayName: username });
  await setDoc(doc(fs, 'users', user.uid), { username, email, createdAt: serverTimestamp() });
}

export const login = (email, password) => signInWithEmailAndPassword(auth, email, password);
export const resetPassword = email => sendPasswordResetEmail(auth, email);
export const logout = () => signOut(auth);

export async function updateUsername(uid, username) {
  await updateProfile(auth.currentUser, { displayName: username });
  await setDoc(doc(fs, 'users', uid), { username }, { merge: true });
}

// Por seguridad, Firebase pide la contraseña actual antes de cambiarla
export async function changePassword(current, next) {
  const u = auth.currentUser;
  await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, current));
  await updatePassword(u, next);
}

// Rutinas compartidas por código (si el código ya existe, las reglas lo rechazan)
export const shareRoutine = (code, data) => setDoc(doc(fs, 'shared', code), { ...data, createdAt: serverTimestamp() });
export async function getShared(code) {
  const snap = await getDoc(doc(fs, 'shared', code));
  return snap.exists() ? snap.data() : null;
}

export async function fetchAll(uid) {
  const [main, workouts] = await Promise.all([getDoc(mainRef(uid)), getDocs(workoutsRef(uid))]);
  return { main: main.exists() ? main.data() : null, workouts: workouts.docs.map(d => d.data()) };
}

export const putMain = (uid, data) => setDoc(mainRef(uid), data);
export const putWorkout = (uid, w) => setDoc(doc(workoutsRef(uid), w.id), w);
export const removeWorkout = (uid, id) => deleteDoc(doc(workoutsRef(uid), id));

// Avisa de cambios hechos desde otros dispositivos (ignora los propios que el servidor aún no confirma)
export function listen(uid, onMain, onWorkouts) {
  const stopMain = onSnapshot(mainRef(uid), snap => {
    if (!snap.metadata.hasPendingWrites && snap.exists()) onMain(snap.data());
  }, () => {});
  const stopWorkouts = onSnapshot(workoutsRef(uid), snap => {
    const changes = snap.docChanges()
      .filter(c => !c.doc.metadata.hasPendingWrites)
      .map(c => ({ type: c.type, id: c.doc.id, data: c.doc.data() }));
    if (changes.length) onWorkouts(changes);
  }, () => {});
  return () => { stopMain(); stopWorkouts(); };
}

// ---------- Gymbros: códigos y chats 1 a 1 ----------
const ms = t => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : Date.now());
const chatRef = id => doc(fs, 'chats', id);

export const createInvite = (code, data) => setDoc(doc(fs, 'invites', code), { ...data, createdAt: serverTimestamp() });
export async function getInvite(code) {
  const snap = await getDoc(doc(fs, 'invites', code));
  return snap.exists() ? snap.data() : null;
}
export async function getChat(id) {
  const snap = await getDoc(chatRef(id));
  return snap.exists() ? { id, ...snap.data() } : null;
}
export const createChat = (id, data) => setDoc(chatRef(id), { ...data, createdAt: serverTimestamp() });
export const deleteChat = id => deleteDoc(chatRef(id));
export const renameInChat = (id, uid, name) => updateDoc(chatRef(id), { [`names.${uid}`]: name });

// Mensaje + resumen del último mensaje del chat, juntos
export function sendMessage(chatId, msg, preview) {
  const batch = writeBatch(fs);
  batch.set(doc(collection(fs, 'chats', chatId, 'messages')), { ...msg, at: serverTimestamp() });
  batch.update(chatRef(chatId), { last: { text: preview, from: msg.from, at: serverTimestamp() } });
  return batch.commit();
}

// Cambia el texto de un mensaje tuyo; `last` (si viene) actualiza el resumen del chat
export function editMessage(chatId, msgId, text, last) {
  const batch = writeBatch(fs);
  batch.update(doc(fs, 'chats', chatId, 'messages', msgId), { text, edited: true });
  if (last !== undefined) batch.update(chatRef(chatId), { last });
  return batch.commit();
}

// Borra un mensaje tuyo; `last` (si viene) es el nuevo resumen del chat
export function deleteMessage(chatId, msgId, last) {
  const batch = writeBatch(fs);
  batch.delete(doc(fs, 'chats', chatId, 'messages', msgId));
  if (last !== undefined) batch.update(chatRef(chatId), { last });
  return batch.commit();
}

export function listenChats(uid, cb, onError = () => {}) {
  return onSnapshot(query(collection(fs, 'chats'), where('members', 'array-contains', uid)), snap => {
    cb(snap.docs.map(d => {
      const c = d.data({ serverTimestamps: 'estimate' });
      return { ...c, id: d.id, createdAt: ms(c.createdAt), last: c.last ? { ...c.last, at: ms(c.last.at) } : null };
    }));
  }, onError);
}

export function listenMessages(chatId, cb) {
  const q = query(collection(fs, 'chats', chatId, 'messages'), orderBy('at'), limitToLast(200));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => { const m = d.data({ serverTimestamps: 'estimate' }); return { ...m, id: d.id, at: ms(m.at) }; }));
  }, () => {});
}

// Perfil de gymbro: resumen que solo tus gymbros pueden leer
export const putProfile = (uid, data) => setDoc(doc(fs, 'profiles', uid), { ...data, updatedAt: serverTimestamp() });
export const deleteProfile = uid => deleteDoc(doc(fs, 'profiles', uid));
export async function getProfile(uid) {
  const snap = await getDoc(doc(fs, 'profiles', uid));
  return snap.exists() ? snap.data() : null;
}

// Foto de perfil (solo tú la lees aquí; tus gymbros la ven en tu perfil)
const photoRef = uid => doc(fs, 'users', uid, 'data', 'photo');
export const putPhoto = (uid, url) => setDoc(photoRef(uid), { url });
export const deletePhoto = uid => deleteDoc(photoRef(uid));
export async function getPhoto(uid) {
  const snap = await getDoc(photoRef(uid));
  return snap.exists() ? snap.data().url : null;
}

// Fotos de progreso (privadas): miniatura con fecha y pose, y la foto grande aparte
const progThumbs = uid => collection(fs, 'users', uid, 'progressThumbs');
const progFullRef = (uid, id) => doc(fs, 'users', uid, 'progress', id);
export async function listProgress(uid) {
  const snap = await getDocs(progThumbs(uid));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function getProgressFull(uid, id) {
  const snap = await getDoc(progFullRef(uid, id));
  return snap.exists() ? snap.data().url : null;
}
export function putProgress(uid, id, meta, thumb, full) {
  const batch = writeBatch(fs);
  batch.set(doc(progThumbs(uid), id), { ...meta, url: thumb });
  batch.set(progFullRef(uid, id), { url: full });
  return batch.commit();
}
export function deleteProgress(uid, id) {
  const batch = writeBatch(fs);
  batch.delete(doc(progThumbs(uid), id));
  batch.delete(progFullRef(uid, id));
  return batch.commit();
}
