// Conexión con Firebase: cuentas (correo + contraseña) y datos en la nube.
// Estructura en Firestore:
//   users/{uid}                 → { username, email, createdAt }
//   users/{uid}/data/main       → { routines, notes }
//   users/{uid}/workouts/{id}   → un entrenamiento guardado
//   shared/{código}             → rutina o dieta compartida { ownerUid, ownerName, routine | diet, createdAt }
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, signOut, updateProfile, updatePassword,
  reauthenticateWithCredential, EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, deleteDoc, onSnapshot, serverTimestamp,
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
