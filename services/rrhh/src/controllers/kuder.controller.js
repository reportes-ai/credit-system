'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   TEST DE KUDER — Inventario de preferencias/intereses vocacionales (10 áreas)
   Motor único para DOS usos:
     • SELECCIÓN: un candidato externo rinde el test por un link con token (sin
       login); el resultado queda asociado al cargo al que postula.
     • ANUAL: un colaborador lo rinde una vez al año desde Evaluaciones de
       Desempeño; el historial queda en su ficha.
   Ítems de TRIADA (forced-choice): en cada uno el evaluado marca la actividad que
   MÁS le gusta y la que MENOS. Puntaje por área: MÁS=+2, intermedia=+1, MENOS=0.
   El puntaje bruto de cada área se normaliza a 0-100 según sus apariciones
   (=interés relativo). El % de match se calcula contra el perfil esperado del
   CARGO (rh_cargos.kuder_perfil, definido junto a la descripción de cargo).
   TODO paramétrico: áreas e ítems se editan en el mantenedor (permiso rh_kuder).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const crypto = require('crypto');
const anthropic = require('../../../../shared/anthropic');
const ia = require('../../../../shared/ia');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── 10 áreas clásicas del Kuder ─────────────────────────────────────────────── */
const AREAS = [
  ['AIRE_LIBRE', 'Aire libre', 'Actividades al exterior, con plantas, animales o naturaleza', 1],
  ['MECANICO', 'Mecánico', 'Trabajar con máquinas, herramientas y objetos', 2],
  ['CALCULO', 'Cálculo', 'Trabajar con números y datos cuantitativos', 3],
  ['CIENTIFICO', 'Científico', 'Investigar, descubrir el porqué de las cosas', 4],
  ['PERSUASIVO', 'Persuasivo', 'Convencer, vender, dirigir e influir en personas', 5],
  ['ARTISTICO', 'Artístico', 'Crear con formas, colores y diseño', 6],
  ['LITERARIO', 'Literario', 'Leer y escribir, expresarse con palabras', 7],
  ['MUSICAL', 'Musical', 'Tocar, cantar o escuchar música', 8],
  ['SERVICIO_SOCIAL', 'Servicio social', 'Ayudar, enseñar y atender a otras personas', 9],
  ['OFICINA', 'Trabajo de oficina', 'Ordenar, registrar y organizar información con precisión', 10],
];

/* ── Triadas sembradas (30 ítems, cada área ~9 apariciones) ──────────────────── */
// [ [areaA,textoA], [areaB,textoB], [areaC,textoC] ]
const TRIADAS = [
  [['AIRE_LIBRE', 'Cuidar un jardín'], ['MECANICO', 'Reparar un motor'], ['CALCULO', 'Cuadrar cuentas']],
  [['CIENTIFICO', 'Hacer un experimento'], ['PERSUASIVO', 'Vender un producto'], ['ARTISTICO', 'Dibujar un afiche']],
  [['LITERARIO', 'Escribir un cuento'], ['MUSICAL', 'Aprender un instrumento'], ['SERVICIO_SOCIAL', 'Enseñar a un niño']],
  [['OFICINA', 'Archivar documentos'], ['AIRE_LIBRE', 'Acampar en un cerro'], ['MECANICO', 'Armar un mueble']],
  [['CALCULO', 'Calcular un presupuesto'], ['CIENTIFICO', 'Estudiar las estrellas'], ['PERSUASIVO', 'Convencer a un cliente']],
  [['ARTISTICO', 'Pintar un cuadro'], ['LITERARIO', 'Corregir un texto'], ['MUSICAL', 'Componer una canción']],
  [['SERVICIO_SOCIAL', 'Atender a un enfermo'], ['OFICINA', 'Llevar una agenda'], ['AIRE_LIBRE', 'Trabajar en el campo']],
  [['MECANICO', 'Instalar un equipo'], ['CALCULO', 'Analizar estadísticas'], ['CIENTIFICO', 'Investigar una enfermedad']],
  [['PERSUASIVO', 'Liderar un equipo de ventas'], ['ARTISTICO', 'Diseñar un logotipo'], ['LITERARIO', 'Redactar un discurso']],
  [['MUSICAL', 'Dirigir un coro'], ['SERVICIO_SOCIAL', 'Orientar a un joven'], ['OFICINA', 'Registrar datos en el sistema']],
  [['AIRE_LIBRE', 'Guiar una excursión'], ['CIENTIFICO', 'Clasificar plantas'], ['PERSUASIVO', 'Negociar un acuerdo']],
  [['MECANICO', 'Reparar una máquina'], ['ARTISTICO', 'Modelar en arcilla'], ['SERVICIO_SOCIAL', 'Cuidar a un adulto mayor']],
  [['CALCULO', 'Llevar la contabilidad'], ['LITERARIO', 'Leer una novela'], ['OFICINA', 'Ordenar un archivo']],
  [['CIENTIFICO', 'Analizar en un laboratorio'], ['MUSICAL', 'Practicar piano'], ['AIRE_LIBRE', 'Sembrar hortalizas']],
  [['PERSUASIVO', 'Hacer campaña'], ['SERVICIO_SOCIAL', 'Ayudar a damnificados'], ['MECANICO', 'Soldar piezas']],
  [['ARTISTICO', 'Decorar un espacio'], ['CALCULO', 'Resolver problemas de matemática'], ['LITERARIO', 'Escribir un artículo']],
  [['MUSICAL', 'Grabar una melodía'], ['OFICINA', 'Preparar planillas'], ['CIENTIFICO', 'Comprobar una hipótesis']],
  [['SERVICIO_SOCIAL', 'Escuchar los problemas de otros'], ['AIRE_LIBRE', 'Observar aves'], ['PERSUASIVO', 'Presentar una propuesta']],
  [['MECANICO', 'Diseñar una herramienta'], ['LITERARIO', 'Editar un libro'], ['OFICINA', 'Controlar un inventario']],
  [['CALCULO', 'Proyectar un flujo de caja'], ['ARTISTICO', 'Hacer una escultura'], ['MUSICAL', 'Enseñar a cantar']],
  [['CIENTIFICO', 'Estudiar el clima'], ['SERVICIO_SOCIAL', 'Hacer voluntariado'], ['MECANICO', 'Ensamblar un aparato']],
  [['PERSUASIVO', 'Dirigir una reunión'], ['OFICINA', 'Redactar actas'], ['AIRE_LIBRE', 'Cultivar un huerto']],
  [['ARTISTICO', 'Diseñar ropa'], ['CIENTIFICO', 'Observar por un microscopio'], ['CALCULO', 'Auditar cifras']],
  [['LITERARIO', 'Dar una charla'], ['MUSICAL', 'Escribir una partitura'], ['SERVICIO_SOCIAL', 'Acompañar a un paciente']],
  [['OFICINA', 'Clasificar correspondencia'], ['MECANICO', 'Calibrar un instrumento'], ['PERSUASIVO', 'Cerrar una venta']],
  [['AIRE_LIBRE', 'Trabajar como guardaparques'], ['ARTISTICO', 'Fotografiar paisajes'], ['LITERARIO', 'Escribir una crónica']],
  [['CALCULO', 'Analizar un balance'], ['MUSICAL', 'Tocar en una banda'], ['CIENTIFICO', 'Formular una teoría']],
  [['SERVICIO_SOCIAL', 'Capacitar a un equipo'], ['PERSUASIVO', 'Motivar a vendedores'], ['OFICINA', 'Coordinar una agenda']],
  [['MECANICO', 'Mantener vehículos'], ['AIRE_LIBRE', 'Reforestar un terreno'], ['ARTISTICO', 'Ilustrar un libro']],
  [['LITERARIO', 'Traducir un documento'], ['OFICINA', 'Digitar información'], ['SERVICIO_SOCIAL', 'Orientar a las familias']],
];

require('../../../../shared/migrate').enFila('rrhh-kuder', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_kuder_areas (
    codigo VARCHAR(24) PRIMARY KEY, nombre VARCHAR(60) NOT NULL, descripcion VARCHAR(200) NULL,
    orden INT DEFAULT 0, activo TINYINT(1) DEFAULT 1)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_kuder_items (
    id INT AUTO_INCREMENT PRIMARY KEY, orden INT DEFAULT 0, activo TINYINT(1) DEFAULT 1,
    a_area VARCHAR(24) NOT NULL, a_texto VARCHAR(120) NOT NULL,
    b_area VARCHAR(24) NOT NULL, b_texto VARCHAR(120) NOT NULL,
    c_area VARCHAR(24) NOT NULL, c_texto VARCHAR(120) NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_kuder_tests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo VARCHAR(12) NOT NULL,                 -- SELECCION | ANUAL
    id_usuario INT NULL,                       -- colaborador (ANUAL) o null (candidato)
    candidato_nombre VARCHAR(160) NULL, candidato_rut VARCHAR(16) NULL, candidato_email VARCHAR(160) NULL,
    id_cargo INT NULL,                         -- cargo objetivo (para el match)
    token VARCHAR(40) NULL UNIQUE,             -- link del candidato
    estado VARCHAR(12) NOT NULL DEFAULT 'PENDIENTE',   -- PENDIENTE | COMPLETADO
    resultado MEDIUMTEXT NULL,                 -- JSON { area: score0100 }
    match_pct DECIMAL(5,1) NULL,
    creado_por INT NULL, creado_nombre VARCHAR(160) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completado_at DATETIME NULL,
    INDEX idx_usuario (id_usuario), INDEX idx_cargo (id_cargo), INDEX idx_estado (estado))`);
  // Perfil Kuder esperado por cargo (junto a la descripción de cargo)
  try { await pool.query(`ALTER TABLE rh_cargos ADD COLUMN kuder_perfil TEXT NULL`); } catch (e) { if (e.errno !== 1060) throw e; }
  // Informe IA cacheado por test
  for (const col of ['informe_ia MEDIUMTEXT NULL', 'informe_ia_at DATETIME NULL']) {
    try { await pool.query(`ALTER TABLE rh_kuder_tests ADD COLUMN ${col}`); } catch (e) { if (e.errno !== 1060) throw e; }
  }
  try { await ia.registrarFuncionalidad({ codigo: 'kuder_informe', nombre: 'Informe IA — Test de Kuder',
    descripcion: 'Interpreta el perfil de intereses y su ajuste al cargo (selección o desarrollo)', modelo: 'claude-haiku-4-5' }); } catch (_) {}

  // Seeds idempotentes
  for (const [c, n, d, o] of AREAS)
    await pool.query(`INSERT INTO rh_kuder_areas (codigo,nombre,descripcion,orden) VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), descripcion=VALUES(descripcion), orden=VALUES(orden)`, [c, n, d, o]);
  const [[cnt]] = await pool.query(`SELECT COUNT(*) n FROM rh_kuder_items`);
  if (!cnt.n) {
    let i = 1;
    for (const t of TRIADAS)
      await pool.query(`INSERT INTO rh_kuder_items (orden,a_area,a_texto,b_area,b_texto,c_area,c_texto) VALUES (?,?,?,?,?,?,?)`,
        [i++, t[0][0], t[0][1], t[1][0], t[1][1], t[2][0], t[2][1]]);
  }

  // Funcionalidad + permisos (heredados de Desempeño)
  const [[mod]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (mod) {
    const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_kuder' LIMIT 1`);
    if (!f) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo,nombre,codigo,href,icono)
        VALUES (?, 'Test de Kuder (intereses)', 'rh_kuder', '/recursos-humanos/kuder/', 'bi-compass')`, [mod.id_modulo]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil,id_funcionalidad,habilitado)
        SELECT pp.id_perfil, ?, 1 FROM permisos_perfil pp JOIN funcionalidades f2 ON f2.id_funcionalidad=pp.id_funcionalidad
        WHERE f2.codigo='rh_desempeno' AND pp.habilitado=1`, [r.insertId]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil,id_funcionalidad,habilitado) VALUES (1,?,1)`, [r.insertId]);
    }
  }
  console.log('[rrhh-kuder] listo');
});

/* ── Motor de cálculo (único) ────────────────────────────────────────────────── */
// respuestas: [{ item, mas:'a|b|c', menos:'a|b|c' }]  → { AREA: score 0-100 }
async function calcular(respuestas) {
  const [items] = await pool.query(`SELECT id,a_area,b_area,c_area FROM rh_kuder_items WHERE activo=1`);
  const mapItem = new Map(items.map(it => [it.id, it]));
  const bruto = {}, aparic = {};
  for (const [c] of AREAS) { bruto[c] = 0; aparic[c] = 0; }
  for (const r of respuestas) {
    const it = mapItem.get(Number(r.item)); if (!it) continue;
    const areas = { a: it.a_area, b: it.b_area, c: it.c_area };
    for (const k of ['a', 'b', 'c']) if (areas[k] in aparic) aparic[areas[k]] += 2;   // tope por aparición
    // MÁS=+2, MENOS=0, intermedia=+1
    const mas = areas[r.mas], menos = areas[r.menos];
    for (const k of ['a', 'b', 'c']) {
      const ar = areas[k];
      if (ar === mas) bruto[ar] += 2; else if (ar === menos) bruto[ar] += 0; else bruto[ar] += 1;
    }
  }
  const perfil = {};
  for (const [c] of AREAS) perfil[c] = aparic[c] ? Math.round(bruto[c] / aparic[c] * 100) : 0;
  return perfil;
}

// match% del perfil de la persona vs el perfil esperado del cargo (JSON {area:0-100})
function matchCargo(perfilPersona, perfilCargo) {
  if (!perfilCargo || typeof perfilCargo !== 'object') return null;
  const claves = Object.keys(perfilCargo).filter(k => perfilCargo[k] != null && perfilCargo[k] !== '');
  if (!claves.length) return null;
  let sum = 0;
  const detalle = [];
  for (const k of claves) {
    const esp = Number(perfilCargo[k]) || 0, real = Number(perfilPersona[k]) || 0;
    const dif = Math.abs(esp - real);
    sum += dif;
    detalle.push({ area: k, esperado: esp, real, gap: real - esp });
  }
  const match = Math.max(0, Math.round((100 - sum / claves.length) * 10) / 10);
  return { match, detalle };
}

/* ── GET /api/rrhh/kuder/test — áreas + ítems para rendir (self o por token) ──── */
exports.test = async (_req, res) => {
  try {
    const [areas] = await pool.query(`SELECT codigo,nombre,descripcion FROM rh_kuder_areas WHERE activo=1 ORDER BY orden`);
    const [items] = await pool.query(`SELECT id,a_texto,b_texto,c_texto FROM rh_kuder_items WHERE activo=1 ORDER BY orden`);
    ok(res, { areas, items });
  } catch (e) { console.error('[kuder test]', e.message); fail(res, 'Error interno'); }
};

/* ── POST /api/rrhh/kuder/rendir — colaborador ANUAL (con login) ─────────────── */
exports.rendir = async (req, res) => {
  try {
    const idU = req.usuario.id_usuario;
    const respuestas = req.body.respuestas;
    if (!Array.isArray(respuestas) || !respuestas.length) return fail(res, 'Faltan respuestas', 400);
    const perfil = await calcular(respuestas);
    const [[u]] = await pool.query(`SELECT cargo FROM usuarios WHERE id_usuario=?`, [idU]);
    let idCargo = null, mp = null;
    if (u && u.cargo) {
      const [[cg]] = await pool.query(`SELECT id, kuder_perfil FROM rh_cargos WHERE nombre=? AND activo=1`, [u.cargo]);
      if (cg) { idCargo = cg.id; const m = matchCargo(perfil, safeJSON(cg.kuder_perfil)); mp = m ? m.match : null; }
    }
    const nombre = [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ');
    await pool.query(`INSERT INTO rh_kuder_tests (tipo,id_usuario,id_cargo,estado,resultado,match_pct,creado_por,creado_nombre,completado_at)
      VALUES ('ANUAL',?,?,'COMPLETADO',?,?,?,?,NOW())`, [idU, idCargo, JSON.stringify(perfil), mp, idU, nombre]);
    ok(res, { perfil, match_pct: mp });
  } catch (e) { console.error('[kuder rendir]', e.message); fail(res, 'Error interno'); }
};

/* ── GET /api/rrhh/kuder/mi — último resultado propio ────────────────────────── */
exports.mi = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id, resultado, match_pct, DATE_FORMAT(completado_at,'%Y-%m-%d') fecha
      FROM rh_kuder_tests WHERE id_usuario=? AND estado='COMPLETADO' ORDER BY completado_at DESC`, [req.usuario.id_usuario]);
    const hist = rows.map(r => ({ id: r.id, fecha: r.fecha, match_pct: r.match_pct, perfil: safeJSON(r.resultado) }));
    ok(res, { ultimo: hist[0] || null, historial: hist });
  } catch (e) { console.error('[kuder mi]', e.message); fail(res, 'Error interno'); }
};

/* ── SELECCIÓN: generar link para un candidato ───────────────────────────────── */
exports.generarLink = async (req, res) => {
  try {
    const { nombre, rut, email, id_cargo } = req.body || {};
    if (!nombre || !id_cargo) return fail(res, 'Nombre y cargo son obligatorios', 400);
    const token = crypto.randomBytes(16).toString('hex');
    const quien = [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ');
    const [r] = await pool.query(`INSERT INTO rh_kuder_tests (tipo,candidato_nombre,candidato_rut,candidato_email,id_cargo,token,estado,creado_por,creado_nombre)
      VALUES ('SELECCION',?,?,?,?,?, 'PENDIENTE',?,?)`, [nombre, rut || null, email || null, id_cargo, token, req.usuario.id_usuario, quien]);
    ok(res, { id: r.insertId, token, url: `/kuder-test/?t=${token}` });
  } catch (e) { console.error('[kuder link]', e.message); fail(res, 'Error interno'); }
};

/* ── PÚBLICO: candidato abre su test por token ───────────────────────────────── */
exports.publicoInfo = async (req, res) => {
  try {
    const [[t]] = await pool.query(`SELECT k.candidato_nombre, k.estado, c.nombre cargo
      FROM rh_kuder_tests k LEFT JOIN rh_cargos c ON c.id=k.id_cargo WHERE k.token=?`, [req.params.token]);
    if (!t) return fail(res, 'Link inválido', 404);
    ok(res, { nombre: t.candidato_nombre, cargo: t.cargo, ya: t.estado === 'COMPLETADO' });
  } catch (e) { console.error('[kuder pubinfo]', e.message); fail(res, 'Error interno'); }
};

/* ── PÚBLICO: candidato envía sus respuestas ─────────────────────────────────── */
exports.publicoEnviar = async (req, res) => {
  try {
    const [[t]] = await pool.query(`SELECT id, id_cargo, estado FROM rh_kuder_tests WHERE token=?`, [req.params.token]);
    if (!t) return fail(res, 'Link inválido', 404);
    if (t.estado === 'COMPLETADO') return fail(res, 'Este test ya fue respondido', 400);
    const respuestas = req.body.respuestas;
    if (!Array.isArray(respuestas) || !respuestas.length) return fail(res, 'Faltan respuestas', 400);
    const perfil = await calcular(respuestas);
    let mp = null;
    if (t.id_cargo) {
      const [[cg]] = await pool.query(`SELECT kuder_perfil FROM rh_cargos WHERE id=?`, [t.id_cargo]);
      const m = cg ? matchCargo(perfil, safeJSON(cg.kuder_perfil)) : null; mp = m ? m.match : null;
    }
    await pool.query(`UPDATE rh_kuder_tests SET estado='COMPLETADO', resultado=?, match_pct=?, completado_at=NOW() WHERE id=?`,
      [JSON.stringify(perfil), mp, t.id]);
    ok(res, { gracias: true });
  } catch (e) { console.error('[kuder pubenviar]', e.message); fail(res, 'Error interno'); }
};

/* ── RRHH: resultados (con detalle de match vs cargo) ────────────────────────── */
exports.resultados = async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT k.id, k.tipo, k.estado, k.match_pct, k.resultado,
        COALESCE(TRIM(CONCAT_WS(' ',u.nombre,u.apellido)), k.candidato_nombre) nombre,
        c.nombre cargo, c.kuder_perfil,
        DATE_FORMAT(k.created_at,'%Y-%m-%d') creado, DATE_FORMAT(k.completado_at,'%Y-%m-%d') completado
      FROM rh_kuder_tests k LEFT JOIN usuarios u ON u.id_usuario=k.id_usuario
      LEFT JOIN rh_cargos c ON c.id=k.id_cargo ORDER BY k.created_at DESC LIMIT 500`);
    const data = rows.map(r => {
      const perfil = safeJSON(r.resultado);
      const m = perfil ? matchCargo(perfil, safeJSON(r.kuder_perfil)) : null;
      return { id: r.id, tipo: r.tipo, estado: r.estado, nombre: r.nombre, cargo: r.cargo,
        match_pct: r.match_pct, perfil, detalle: m ? m.detalle : null, creado: r.creado, completado: r.completado };
    });
    ok(res, { resultados: data });
  } catch (e) { console.error('[kuder resultados]', e.message); fail(res, 'Error interno'); }
};

/* ── RRHH: perfil Kuder por cargo (GET/PUT) ──────────────────────────────────── */
exports.cargos = async (_req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id, nombre, kuder_perfil, (descripcion IS NOT NULL AND TRIM(descripcion)<>'') tiene_desc
      FROM rh_cargos WHERE activo=1 ORDER BY nombre`);
    ok(res, { cargos: rows.map(c => ({ id: c.id, nombre: c.nombre, tiene_desc: !!c.tiene_desc, perfil: safeJSON(c.kuder_perfil) || {} })) });
  } catch (e) { console.error('[kuder cargos]', e.message); fail(res, 'Error interno'); }
};
exports.guardarCargoPerfil = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const perfil = req.body.perfil || {};
    // Validación: solo áreas conocidas, valores 0-100
    const cods = new Set(AREAS.map(a => a[0])); const limpio = {};
    for (const [k, v] of Object.entries(perfil)) {
      if (!cods.has(k)) continue;
      const n = Number(v); if (v === '' || v == null || isNaN(n)) continue;
      limpio[k] = Math.max(0, Math.min(100, Math.round(n)));
    }
    await pool.query(`UPDATE rh_cargos SET kuder_perfil=? WHERE id=?`, [Object.keys(limpio).length ? JSON.stringify(limpio) : null, id]);
    ok(res, { perfil: limpio });
  } catch (e) { console.error('[kuder guardarcargo]', e.message); fail(res, 'Error interno'); }
};

/* ── RRHH: mantenedor de ítems (listar/guardar/eliminar) ─────────────────────── */
exports.items = async (_req, res) => {
  try {
    const [areas] = await pool.query(`SELECT codigo,nombre FROM rh_kuder_areas WHERE activo=1 ORDER BY orden`);
    const [items] = await pool.query(`SELECT * FROM rh_kuder_items ORDER BY orden`);
    ok(res, { areas, items });
  } catch (e) { console.error('[kuder items]', e.message); fail(res, 'Error interno'); }
};
exports.guardarItem = async (req, res) => {
  try {
    const { id, orden, a_area, a_texto, b_area, b_texto, c_area, c_texto, activo } = req.body || {};
    const cods = new Set(AREAS.map(a => a[0]));
    for (const a of [a_area, b_area, c_area]) if (!cods.has(a)) return fail(res, 'Área inválida', 400);
    if (!a_texto || !b_texto || !c_texto) return fail(res, 'Faltan textos de las 3 actividades', 400);
    if (id) await pool.query(`UPDATE rh_kuder_items SET orden=?,a_area=?,a_texto=?,b_area=?,b_texto=?,c_area=?,c_texto=?,activo=? WHERE id=?`,
      [orden || 0, a_area, a_texto, b_area, b_texto, c_area, c_texto, activo ? 1 : 0, id]);
    else await pool.query(`INSERT INTO rh_kuder_items (orden,a_area,a_texto,b_area,b_texto,c_area,c_texto) VALUES (?,?,?,?,?,?,?)`,
      [orden || 0, a_area, a_texto, b_area, b_texto, c_area, c_texto]);
    ok(res, {});
  } catch (e) { console.error('[kuder guardaritem]', e.message); fail(res, 'Error interno'); }
};
exports.eliminarItem = async (req, res) => {
  try { await pool.query(`DELETE FROM rh_kuder_items WHERE id=?`, [Number(req.params.id)]); ok(res, {}); }
  catch (e) { console.error('[kuder delitem]', e.message); fail(res, 'Error interno'); }
};

/* ── Informe IA (bajo demanda, cacheado) ─────────────────────────────────────── */
// GET /api/rrhh/kuder/:id/informe-ia — devuelve el informe cacheado (o null)
exports.informeGet = async (req, res) => {
  try {
    const [[t]] = await pool.query(`SELECT informe_ia FROM rh_kuder_tests WHERE id=?`, [Number(req.params.id)]);
    if (!t) return fail(res, 'Test no encontrado', 404);
    ok(res, { informe: safeJSON(t.informe_ia) });
  } catch (e) { console.error('[kuder informeGet]', e.message); fail(res, 'Error interno'); }
};

// POST /api/rrhh/kuder/:id/informe-ia — genera (o regenera si ?force=1) el informe
exports.informeGenerar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[t]] = await pool.query(`SELECT k.tipo, k.estado, k.resultado, k.informe_ia,
        COALESCE(TRIM(CONCAT_WS(' ',u.nombre,u.apellido)), k.candidato_nombre) nombre,
        c.nombre cargo, c.descripcion cargo_desc, c.kuder_perfil
      FROM rh_kuder_tests k LEFT JOIN usuarios u ON u.id_usuario=k.id_usuario
      LEFT JOIN rh_cargos c ON c.id=k.id_cargo WHERE k.id=?`, [id]);
    if (!t) return fail(res, 'Test no encontrado', 404);
    if (t.estado !== 'COMPLETADO') return fail(res, 'El test aún no está completado', 400);
    if (t.informe_ia && !req.query.force) return ok(res, { informe: safeJSON(t.informe_ia), cacheado: true });

    const perfil = safeJSON(t.resultado) || {};
    const perfilCargo = safeJSON(t.kuder_perfil);
    const m = matchCargo(perfil, perfilCargo);
    const nom = c => (AREAS.find(a => a[0] === c) || [null, c])[1];
    const perfilTxt = AREAS.map(a => `${a[1]}: ${perfil[a[0]] ?? 0}/100`).join(', ');
    const gapsTxt = m ? m.detalle.map(d => `${nom(d.area)}: esperado ${d.esperado}, real ${d.real} (${d.gap >= 0 ? '+' : ''}${d.gap})`).join('; ') : 'El cargo no tiene perfil Kuder definido.';
    const esSeleccion = t.tipo === 'SELECCION';

    const system = `Eres psicólogo laboral experto en el Test de Kuder de intereses vocacionales. Interpretas resultados de forma profesional, prudente y útil, en español de Chile. Un puntaje alto en un área = mayor interés/gusto por ese tipo de actividad (NO es aptitud ni capacidad). El test es ipsativo (intereses relativos). ${esSeleccion ? 'Contexto: SELECCIÓN de un candidato para un cargo — evalúa idoneidad de intereses vs lo que el cargo requiere, sin descartar por un solo dato.' : 'Contexto: revisión ANUAL de un colaborador — enfócate en desarrollo, motivación y posibles ajustes de rol o tareas.'} No inventes datos que no estén en el input. Sé concreto y breve.`;
    const prompt = `Persona: ${t.nombre || 'sin nombre'}
Cargo ${esSeleccion ? 'al que postula' : 'actual'}: ${t.cargo || 'no especificado'}
${t.cargo_desc ? 'Descripción del cargo: ' + String(t.cargo_desc).slice(0, 1500) : 'El cargo no tiene descripción cargada.'}

Perfil de intereses (0-100 por área): ${perfilTxt}
Match global vs perfil esperado del cargo: ${m ? m.match + '%' : 'sin perfil definido'}
Brechas por área (esperado vs real): ${gapsTxt}

Redacta un informe con estos campos JSON:
{
 "sintesis": "2-3 frases: qué tipo de trabajo disfruta según sus áreas dominantes",
 "areas_dominantes": ["área 1","área 2","área 3"],
 "ajuste_cargo": "párrafo interpretando el match y las brechas frente a lo que el cargo requiere",
 "fortalezas": ["punto donde sus intereses calzan bien con el cargo", "..."],
 "brechas": ["área donde su interés es menor al que el cargo pide y qué implica", "..."],
 "${esSeleccion ? 'recomendacion_seleccion' : 'recomendacion_desarrollo'}": "${esSeleccion ? 'lectura de idoneidad y qué explorar en entrevista' : 'sugerencias de desarrollo, motivación o ajuste de tareas/rol'}",
 "semaforo": "VERDE|AMARILLO|ROJO (idoneidad global de intereses para el cargo)"
}`;

    let out;
    try {
      out = await anthropic.analizar({ codigo: 'kuder_informe', system, prompt, json: true, max_tokens: 1400, id_usuario: req.usuario.id_usuario });
    } catch (e) {
      if (e.code === 'IA_OFF') return fail(res, 'La IA está desactivada para esta funcionalidad', 400);
      if (!anthropic.disponible()) return fail(res, 'Falta configurar ANTHROPIC_API_KEY', 400);
      throw e;
    }
    const informe = out.datos;
    if (!informe) return fail(res, 'La IA no devolvió un informe válido, reintenta', 502);
    await pool.query(`UPDATE rh_kuder_tests SET informe_ia=?, informe_ia_at=NOW() WHERE id=?`, [JSON.stringify(informe), id]);
    ok(res, { informe, cacheado: false });
  } catch (e) { console.error('[kuder informe]', e.message); fail(res, 'Error generando el informe'); }
};

function safeJSON(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
