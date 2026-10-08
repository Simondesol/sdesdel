// Programas de entrenamiento listos: rutinas armadas + qué día toca cada una (Mi plan).
// Cada ejercicio: [id de la guía de técnica, series, reps, RIR objetivo, descanso en segundos].
// Niveles: p = Principiante, i = Intermedio. week: lunes a domingo (clave de la rutina o null = descanso).
// Los id de programa no se cambian (con ellos se reconoce qué programa usaste).
export const LEVELS = { p: 'Principiante', i: 'Intermedio' };

// RIR: principiante deja más reps en reserva; intermedio va más cerca del fallo (aislamiento 0–1)
const R = (name, ex) => ({ name, ex });

// ---------- Rutinas que se repiten entre programas ----------
// Cuerpo completo — principiante
const FB_P_A = R('Cuerpo completo A', [['prensa', 3, '10-12', '2', 120], ['press-maquina-pecho', 3, '8-12', '2', 120], ['jalon-pecho', 3, '8-12', '2', 120], ['curl-femoral-acostado', 2, '10-15', '1-2', 90], ['elevaciones-laterales', 2, '12-15', '1-2', 60], ['crunch-polea', 2, '10-15', '1-2', 60]]);
const FB_P_B = R('Cuerpo completo B', [['peso-muerto-rumano', 3, '10-12', '2', 120], ['press-mancuernas', 3, '8-12', '2', 120], ['remo-polea', 3, '10-12', '2', 120], ['extension-cuadriceps', 2, '12-15', '1-2', 90], ['curl-mancuernas', 2, '10-12', '1-2', 60], ['triceps-polea', 2, '10-12', '1-2', 60]]);
const FB_P_C = R('Cuerpo completo C', [['sentadilla', 3, '8-10', '2', 150], ['press-hombros-mancuernas', 3, '8-12', '2', 120], ['remo-mancuerna', 3, '10-12', '2', 90], ['hip-thrust', 3, '10-12', '2', 120], ['pec-deck', 2, '12-15', '1-2', 60], ['elevacion-piernas', 2, '10-12', '1-2', 60]]);
// Cuerpo completo — intermedio
const FB_I_A = R('Cuerpo completo A', [['sentadilla', 4, '6-8', '1-2', 180], ['press-banca', 4, '6-8', '1-2', 180], ['remo-barra', 3, '8-10', '1-2', 150], ['curl-femoral-acostado', 3, '10-12', '0-1', 90], ['elevaciones-laterales', 3, '12-15', '0-1', 60], ['curl-inclinado', 2, '10-12', '0-1', 60]]);
const FB_I_B = R('Cuerpo completo B', [['peso-muerto', 3, '4-6', '2', 210], ['press-militar', 3, '6-8', '1-2', 150], ['dominadas', 3, '6-10', '1-2', 150], ['prensa', 3, '10-12', '1-2', 120], ['fondos', 2, '8-12', '1', 120], ['triceps-sobre-cabeza', 3, '10-12', '0-1', 75], ['crunch-polea', 3, '10-15', '0-1', 60]]);
const FB_I_C = R('Cuerpo completo C', [['sentadilla-bulgara', 3, '8-10', '1-2', 120], ['press-inclinado-mancuernas', 3, '8-10', '1-2', 120], ['jalon-pecho', 3, '8-12', '1-2', 120], ['peso-muerto-rumano', 3, '8-10', '1-2', 150], ['laterales-polea', 3, '12-15', '0-1', 60], ['curl-martillo', 2, '10-12', '0-1', 60], ['triceps-polea', 2, '10-12', '0-1', 60]]);

// Torso / Pierna
const UL_P_TA = R('Torso A', [['press-maquina-pecho', 3, '8-12', '2', 120], ['jalon-pecho', 3, '8-12', '2', 120], ['press-hombros-mancuernas', 2, '10-12', '2', 90], ['remo-polea', 3, '10-12', '2', 120], ['curl-mancuernas', 2, '10-12', '1-2', 60], ['triceps-polea', 2, '10-12', '1-2', 60]]);
const UL_P_PA = R('Pierna A', [['prensa', 3, '10-12', '2', 120], ['curl-femoral-acostado', 3, '10-12', '1-2', 90], ['extension-cuadriceps', 2, '12-15', '1-2', 90], ['pantorrillas-pie', 3, '10-15', '1-2', 60], ['crunch-polea', 2, '10-15', '1-2', 60]]);
const UL_P_TB = R('Torso B', [['press-mancuernas', 3, '8-12', '2', 120], ['remo-mancuerna', 3, '10-12', '2', 90], ['elevaciones-laterales', 3, '12-15', '1-2', 60], ['remo-maquina', 3, '10-12', '2', 90], ['pec-deck', 2, '12-15', '1-2', 60], ['curl-martillo', 2, '10-12', '1-2', 60], ['triceps-sobre-cabeza', 2, '10-12', '1-2', 60]]);
const UL_P_PB = R('Pierna B', [['sentadilla', 3, '8-10', '2', 150], ['peso-muerto-rumano', 3, '10-12', '2', 120], ['hip-thrust', 2, '10-12', '2', 90], ['curl-femoral-sentado', 2, '12-15', '1-2', 90], ['elevacion-piernas', 2, '10-12', '1-2', 60]]);
const UL_I_TA = R('Torso A', [['press-banca', 4, '6-8', '1-2', 180], ['remo-barra', 4, '6-10', '1-2', 150], ['press-hombros-mancuernas', 3, '8-10', '1-2', 120], ['jalon-pecho', 3, '8-12', '1-2', 120], ['cruces-polea', 2, '12-15', '0-1', 60], ['laterales-polea', 3, '12-15', '0-1', 60], ['curl-barra', 3, '8-12', '0-1', 75], ['triceps-polea', 3, '10-12', '0-1', 75]]);
const UL_I_PA = R('Pierna A', [['sentadilla', 4, '6-8', '1-2', 180], ['peso-muerto-rumano', 3, '8-10', '1-2', 150], ['prensa', 3, '10-12', '1-2', 120], ['curl-femoral-acostado', 3, '10-12', '0-1', 90], ['pantorrillas-pie', 4, '10-15', '0-1', 60], ['crunch-polea', 3, '10-15', '0-1', 60]]);
const UL_I_TB = R('Torso B', [['press-militar', 3, '6-8', '1-2', 150], ['dominadas', 4, '6-10', '1-2', 150], ['press-inclinado-mancuernas', 4, '8-10', '1-2', 120], ['remo-polea', 3, '10-12', '1-2', 120], ['elevaciones-laterales', 3, '12-15', '0-1', 60], ['curl-inclinado', 3, '10-12', '0-1', 75], ['press-frances', 3, '8-12', '0-1', 75]]);
const UL_I_PB = R('Pierna B', [['peso-muerto', 3, '4-6', '2', 210], ['sentadilla-bulgara', 3, '8-10', '1-2', 120], ['extension-cuadriceps', 3, '12-15', '0-1', 90], ['curl-femoral-sentado', 3, '10-12', '0-1', 90], ['hip-thrust', 3, '8-12', '1-2', 120], ['pantorrillas-sentado', 3, '12-15', '0-1', 60], ['elevacion-piernas', 3, '10-15', '1', 60]]);

// Empuje / Tirón / Pierna
const PPL_P_E = R('Empuje', [['press-banca', 3, '6-10', '2', 150], ['press-inclinado-mancuernas', 3, '8-12', '2', 120], ['press-hombros-mancuernas', 3, '8-12', '2', 120], ['elevaciones-laterales', 3, '12-15', '1-2', 60], ['triceps-polea', 3, '10-15', '1-2', 60]]);
const PPL_P_T = R('Tirón', [['jalon-pecho', 3, '8-12', '2', 120], ['remo-polea', 3, '10-12', '2', 120], ['remo-mancuerna', 2, '10-12', '2', 90], ['face-pull', 2, '12-15', '1-2', 60], ['curl-mancuernas', 3, '10-12', '1-2', 60]]);
const PPL_P_P = R('Pierna', [['prensa', 3, '10-12', '2', 120], ['peso-muerto-rumano', 3, '10-12', '2', 120], ['extension-cuadriceps', 2, '12-15', '1-2', 90], ['curl-femoral-acostado', 2, '12-15', '1-2', 90], ['pantorrillas-pie', 3, '12-15', '1-2', 60], ['crunch-polea', 2, '10-15', '1-2', 60]]);
const PPL_P_EB = R('Empuje B', [['press-maquina-pecho', 3, '8-12', '2', 120], ['press-hombros-mancuernas', 2, '10-12', '2', 90], ['cruces-polea', 2, '12-15', '1-2', 60], ['laterales-polea', 3, '12-15', '1-2', 60], ['triceps-sobre-cabeza', 2, '10-12', '1-2', 60]]);
const PPL_P_TB = R('Tirón B', [['remo-maquina', 3, '10-12', '2', 90], ['jalon-pecho', 3, '10-12', '2', 120], ['pullover-polea', 2, '12-15', '1-2', 60], ['pajaros', 2, '12-15', '1-2', 60], ['curl-martillo', 2, '10-12', '1-2', 60]]);
const PPL_P_PB = R('Pierna B', [['sentadilla', 3, '8-10', '2', 150], ['hip-thrust', 3, '10-12', '2', 120], ['curl-femoral-sentado', 2, '12-15', '1-2', 90], ['zancadas', 2, '10-12', '2', 90], ['pantorrillas-sentado', 3, '12-15', '1-2', 60], ['elevacion-piernas', 2, '10-12', '1-2', 60]]);
const PPL_I_E = R('Empuje', [['press-banca', 4, '6-8', '1-2', 180], ['press-militar', 3, '6-10', '1-2', 150], ['press-inclinado-mancuernas', 3, '8-10', '1-2', 120], ['elevaciones-laterales', 4, '12-15', '0-1', 60], ['fondos', 3, '8-12', '1', 120], ['triceps-sobre-cabeza', 3, '10-12', '0-1', 75]]);
const PPL_I_T = R('Tirón', [['dominadas', 4, '6-10', '1-2', 150], ['remo-barra', 4, '6-10', '1-2', 150], ['remo-polea', 3, '10-12', '1-2', 120], ['face-pull', 3, '12-15', '0-1', 60], ['curl-barra', 3, '8-12', '0-1', 75], ['curl-martillo', 2, '10-12', '0-1', 60]]);
const PPL_I_P = R('Pierna', [['sentadilla', 4, '6-8', '1-2', 180], ['peso-muerto-rumano', 3, '8-10', '1-2', 150], ['prensa', 3, '10-12', '1-2', 120], ['curl-femoral-sentado', 3, '10-12', '0-1', 90], ['pantorrillas-pie', 4, '10-15', '0-1', 60], ['elevacion-piernas', 3, '10-15', '1', 60]]);
const PPL_I_EB = R('Empuje B', [['press-militar', 4, '6-8', '1-2', 150], ['press-inclinado-barra', 3, '6-10', '1-2', 150], ['press-mancuernas', 3, '8-12', '1-2', 120], ['laterales-polea', 4, '12-15', '0-1', 60], ['press-frances', 3, '8-12', '0-1', 75], ['triceps-polea', 2, '12-15', '0-1', 60]]);
const PPL_I_TB = R('Tirón B', [['dominadas-supinas', 3, '6-10', '1-2', 150], ['remo-mancuerna', 3, '8-12', '1-2', 90], ['remo-maquina', 3, '10-12', '1-2', 90], ['pajaros', 3, '12-15', '0-1', 60], ['curl-inclinado', 3, '10-12', '0-1', 75], ['encogimientos', 3, '10-15', '0-1', 60]]);
const PPL_I_PB = R('Pierna B', [['peso-muerto', 3, '4-6', '2', 210], ['hack', 3, '8-10', '1-2', 150], ['sentadilla-bulgara', 3, '8-10', '1-2', 120], ['curl-femoral-acostado', 3, '10-12', '0-1', 90], ['extension-cuadriceps', 3, '12-15', '0-1', 90], ['pantorrillas-sentado', 4, '12-15', '0-1', 60]]);

// Brazo y hombro (para el de 5 días)
const BH_P = R('Brazo y hombro', [['press-hombros-mancuernas', 3, '10-12', '2', 90], ['elevaciones-laterales', 3, '12-15', '1-2', 60], ['curl-mancuernas', 3, '10-12', '1-2', 60], ['triceps-polea', 3, '10-12', '1-2', 60], ['curl-martillo', 2, '10-12', '1-2', 60], ['triceps-sobre-cabeza', 2, '10-12', '1-2', 60]]);
const BH_I = R('Brazo y hombro', [['laterales-polea', 4, '12-15', '0-1', 60], ['pajaros', 3, '12-15', '0-1', 60], ['curl-barra', 3, '8-12', '0-1', 75], ['press-cerrado', 3, '6-10', '1-2', 120], ['curl-inclinado', 3, '10-12', '0-1', 75], ['triceps-sobre-cabeza', 3, '10-12', '0-1', 75], ['curl-martillo', 2, '10-12', '0-1', 60]]);

// Pierna con énfasis en cuádriceps y día de cadena posterior (para los de 4 y 5 días)
const CUAD_P = R('Pierna (cuádriceps)', [['sentadilla', 3, '8-10', '2', 150], ['prensa', 3, '10-12', '2', 120], ['extension-cuadriceps', 3, '12-15', '1-2', 90], ['pantorrillas-pie', 3, '12-15', '1-2', 60], ['crunch-polea', 2, '10-15', '1-2', 60]]);
const CUAD_I = R('Pierna (cuádriceps)', [['sentadilla', 4, '6-8', '1-2', 180], ['hack', 3, '8-10', '1-2', 150], ['sentadilla-bulgara', 3, '8-10', '1-2', 120], ['extension-cuadriceps', 3, '12-15', '0-1', 90], ['pantorrillas-pie', 4, '10-15', '0-1', 60], ['elevacion-piernas', 3, '10-15', '1', 60]]);
const POST_P = R('Cadena posterior', [['peso-muerto-rumano', 3, '10-12', '2', 120], ['hip-thrust', 3, '10-12', '2', 120], ['curl-femoral-acostado', 3, '10-12', '1-2', 90], ['hiperextensiones', 2, '12-15', '1-2', 75], ['pantorrillas-sentado', 2, '12-15', '1-2', 60]]);
const POST_I = R('Cadena posterior', [['peso-muerto', 3, '4-6', '2', 210], ['hip-thrust', 3, '8-12', '1-2', 120], ['curl-femoral-sentado', 3, '10-12', '0-1', 90], ['curl-femoral-acostado', 2, '10-12', '0-1', 90], ['hiperextensiones', 3, '10-15', '1', 75], ['pantorrillas-sentado', 3, '12-15', '0-1', 60]]);
const CUAD_ABS_P = R('Cuádriceps y abdomen', [['prensa', 3, '10-12', '2', 120], ['sentadilla', 3, '8-10', '2', 150], ['extension-cuadriceps', 3, '12-15', '1-2', 90], ['pantorrillas-pie', 3, '12-15', '1-2', 60], ['crunch-polea', 3, '10-15', '1-2', 60], ['elevacion-piernas', 2, '10-12', '1-2', 60]]);
const CUAD_ABS_I = R('Cuádriceps y abdomen', [['sentadilla', 4, '6-8', '1-2', 180], ['hack', 3, '8-10', '1-2', 150], ['sentadilla-bulgara', 3, '8-10', '1-2', 120], ['extension-cuadriceps', 3, '12-15', '0-1', 90], ['pantorrillas-pie', 4, '10-15', '0-1', 60], ['crunch-polea', 3, '10-15', '0-1', 60], ['elevacion-piernas', 3, '10-15', '1', 60]]);

// Pecho-hombro-bíceps / Espalda-tríceps-hombro posterior (para el de 4 días)
const PHB_P = R('Pecho, hombro y bíceps', [['press-maquina-pecho', 3, '8-12', '2', 120], ['press-inclinado-mancuernas', 3, '8-12', '2', 120], ['pec-deck', 2, '12-15', '1-2', 60], ['press-hombros-mancuernas', 3, '10-12', '2', 90], ['elevaciones-laterales', 3, '12-15', '1-2', 60], ['curl-mancuernas', 3, '10-12', '1-2', 60], ['curl-martillo', 2, '10-12', '1-2', 60]]);
const PHB_I = R('Pecho, hombro y bíceps', [['press-banca', 4, '6-8', '1-2', 180], ['press-inclinado-mancuernas', 3, '8-10', '1-2', 120], ['cruces-polea', 2, '12-15', '0-1', 60], ['press-militar', 3, '6-10', '1-2', 150], ['laterales-polea', 4, '12-15', '0-1', 60], ['curl-barra', 3, '8-12', '0-1', 75], ['curl-inclinado', 3, '10-12', '0-1', 75]]);
const ETP_P = R('Espalda, tríceps y hombro posterior', [['jalon-pecho', 3, '8-12', '2', 120], ['remo-polea', 3, '10-12', '2', 120], ['remo-mancuerna', 2, '10-12', '2', 90], ['pajaros', 3, '12-15', '1-2', 60], ['triceps-polea', 3, '10-12', '1-2', 60], ['triceps-sobre-cabeza', 2, '10-12', '1-2', 60]]);
const ETP_I = R('Espalda, tríceps y hombro posterior', [['dominadas', 4, '6-10', '1-2', 150], ['remo-barra', 4, '6-10', '1-2', 150], ['remo-polea', 3, '10-12', '1-2', 120], ['face-pull', 3, '12-15', '0-1', 60], ['pajaros', 2, '12-15', '0-1', 60], ['press-frances', 3, '8-12', '0-1', 75], ['triceps-polea', 3, '10-12', '0-1', 75]]);

const lvl = (routines, week) => ({ routines, week });

export const PROGRAMS = [
  { id: 'cc2', name: 'Cuerpo completo', days: 2,
    desc: 'Todo el cuerpo en cada sesión. Ideal si tienes poco tiempo.',
    levels: {
      p: lvl({ A: FB_P_A, B: FB_P_B }, ['A', null, null, 'B', null, null, null]),
      i: lvl({ A: FB_I_A, B: FB_I_B }, ['A', null, null, 'B', null, null, null]),
    } },
  { id: 'cc3', name: 'Cuerpo completo', days: 3,
    desc: 'El clásico para empezar: cada músculo 3 veces por semana, con días de descanso entre medio.',
    levels: {
      p: lvl({ A: FB_P_A, B: FB_P_B, C: FB_P_C }, ['A', null, 'B', null, 'C', null, null]),
      i: lvl({ A: FB_I_A, B: FB_I_B, C: FB_I_C }, ['A', null, 'B', null, 'C', null, null]),
    } },
  { id: 'tp4', name: 'Torso / Pierna', days: 4,
    desc: 'El más equilibrado: cada músculo 2 veces por semana.',
    levels: {
      p: lvl({ TA: UL_P_TA, PA: UL_P_PA, TB: UL_P_TB, PB: UL_P_PB }, ['TA', 'PA', null, 'TB', 'PB', null, null]),
      i: lvl({ TA: UL_I_TA, PA: UL_I_PA, TB: UL_I_TB, PB: UL_I_PB }, ['TA', 'PA', null, 'TB', 'PB', null, null]),
    } },
  { id: 'phbcp4', name: 'Split por grupos', days: 4,
    desc: 'Un día para cada grupo: empujes con bíceps, cadena posterior, tirones con tríceps, y cuádriceps con abdomen.',
    levels: {
      p: lvl({ PHB: PHB_P, CP: POST_P, ETP: ETP_P, CA: CUAD_ABS_P }, ['PHB', 'CP', null, 'ETP', 'CA', null, null]),
      i: lvl({ PHB: PHB_I, CP: POST_I, ETP: ETP_I, CA: CUAD_ABS_I }, ['PHB', 'CP', null, 'ETP', 'CA', null, null]),
    } },
  { id: 'etp3', name: 'Empuje / Tirón / Pierna', days: 3,
    desc: 'Push, pull, legs: un día de empujes, uno de tirones y uno de pierna.',
    levels: {
      p: lvl({ E: PPL_P_E, T: PPL_P_T, P: PPL_P_P }, ['E', null, 'T', null, 'P', null, null]),
      i: lvl({ E: PPL_I_E, T: PPL_I_T, P: PPL_I_P }, ['E', null, 'T', null, 'P', null, null]),
    } },
  { id: 'etpcp5', name: 'Empuje / Tirón / Pierna + Cadena posterior', days: 5,
    desc: 'Push, pull y legs, un día de descanso, otro empuje y un día de cadena posterior.',
    levels: {
      p: lvl({ E: PPL_P_E, T: PPL_P_T, P: CUAD_P, EB: PPL_P_EB, CP: POST_P }, ['E', 'T', 'P', null, 'EB', 'CP', null]),
      i: lvl({ E: PPL_I_E, T: PPL_I_T, P: CUAD_I, EB: PPL_I_EB, CP: POST_I }, ['E', 'T', 'P', null, 'EB', 'CP', null]),
    } },
  { id: 'tpbh5', name: 'Torso / Pierna + Brazo y hombro', days: 5,
    desc: 'Torso y pierna 2 veces por semana, más un día extra para brazos y hombros.',
    levels: {
      p: lvl({ TA: UL_P_TA, PA: UL_P_PA, TB: UL_P_TB, PB: UL_P_PB, BH: BH_P }, ['TA', 'PA', null, 'TB', 'PB', 'BH', null]),
      i: lvl({ TA: UL_I_TA, PA: UL_I_PA, TB: UL_I_TB, PB: UL_I_PB, BH: BH_I }, ['TA', 'PA', null, 'TB', 'PB', 'BH', null]),
    } },
  { id: 'etp6', name: 'Empuje / Tirón / Pierna', days: 6,
    desc: 'Push, pull, legs dos veces por semana, con una versión distinta (B) en la segunda vuelta.',
    levels: {
      p: lvl({ E: PPL_P_E, T: PPL_P_T, P: PPL_P_P, EB: PPL_P_EB, TB: PPL_P_TB, PB: PPL_P_PB }, ['E', 'T', 'P', 'EB', 'TB', 'PB', null]),
      i: lvl({ E: PPL_I_E, T: PPL_I_T, P: PPL_I_P, EB: PPL_I_EB, TB: PPL_I_TB, PB: PPL_I_PB }, ['E', 'T', 'P', 'EB', 'TB', 'PB', null]),
    } },
];
