'use strict';
/**
 * Fichas de Incorporación de Concesionarios (Dealers).
 * Flujo: Ejecutivo Comercial llena la ficha → imprime → cliente firma →
 * sube PDF/foto → envía a revisión (pool de Analistas de Operaciones) →
 * aprobada (crea el dealer + avisa al ejecutivo) o rechazada (con motivo;
 * el ejecutivo corrige/apela y reenvía).
 */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
let pdfParse = null; try { pdfParse = require('pdf-parse'); } catch (e) { /* opcional */ }

/* ── Comisiones pactadas por defecto ──────────────────────────────────────────
 * NO se hardcodean: se derivan de la PIZARRA (mantenedor "Arriendos y Comisiones
 * Parque y Calle" → parametros_credito). La columna del dealer manda:
 *   CALLE/GENERAL → dealer_calle_pct_*    ·    PARQUE → dealer_pct_* (porción dealer)
 * Mapeo de tramos pizarra→ficha: 12→6_12, 24→13_24, 36→25_36, 99→37 (>36m).
 * El fallback (instructivo) calza con los valores sembrados hoy. ───────────── */
const COM_FALLBACK = {
  GENERAL: { com_6_12: 2.5, com_13_24: 5.0,  com_25_36: 7.5, com_37: 10.0 },
  PARQUE:  { com_6_12: 0.0, com_13_24: 2.5,  com_25_36: 5.0, com_37: 7.5  },
};
async function comDefaults() {
  try {
    const [rows] = await pool.query(
      `SELECT clave, valor FROM parametros_credito WHERE clave IN
         ('dealer_pct_12','dealer_pct_24','dealer_pct_36','dealer_pct_99',
          'dealer_calle_pct_12','dealer_calle_pct_24','dealer_calle_pct_36','dealer_calle_pct_99')`);
    if (!rows.length) return COM_FALLBACK;
    const p = {}; rows.forEach(r => { p[r.clave] = parseFloat(r.valor); });
    const pick = (k, fb) => (p[k] == null || isNaN(p[k]) ? fb : p[k]);
    return {
      GENERAL: { com_6_12: pick('dealer_calle_pct_12', 2.5), com_13_24: pick('dealer_calle_pct_24', 5.0),
                 com_25_36: pick('dealer_calle_pct_36', 7.5), com_37: pick('dealer_calle_pct_99', 10.0) },
      PARQUE:  { com_6_12: pick('dealer_pct_12', 0.0),        com_13_24: pick('dealer_pct_24', 2.5),
                 com_25_36: pick('dealer_pct_36', 5.0),        com_37: pick('dealer_pct_99', 7.5) },
    };
  } catch (e) { console.error('[comDefaults]', e.message); return COM_FALLBACK; }
}

/* ── Migración: tabla + registro de módulo/funcionalidades/permisos ───────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_fichas (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        tipo             VARCHAR(10)  NOT NULL DEFAULT 'GENERAL',
        estado           VARCHAR(20)  NOT NULL DEFAULT 'BORRADOR',
        id_ejecutivo     INT          NULL,
        ejecutivo_email  VARCHAR(150) NULL,
        ejecutivo_nombre VARCHAR(200) NULL,
        fecha_solicitud  DATE         NULL,
        rut              VARCHAR(20)  NULL,
        nombre_razon     VARCHAR(200) NULL,
        nombre_fantasia  VARCHAR(200) NULL,
        direccion        VARCHAR(300) NULL,
        comuna           VARCHAR(120) NULL,
        cc_nombre        VARCHAR(150) NULL,
        cc_telefono      VARCHAR(40)  NULL,
        cc_email         VARCHAR(150) NULL,
        cf_nombre        VARCHAR(150) NULL,
        cf_telefono      VARCHAR(40)  NULL,
        cf_email         VARCHAR(150) NULL,
        com_6_12         DECIMAL(5,2) NULL,
        com_13_24        DECIMAL(5,2) NULL,
        com_25_36        DECIMAL(5,2) NULL,
        com_37           DECIMAL(5,2) NULL,
        tipo_documento   VARCHAR(10)  NULL,
        cuenta_tipo      VARCHAR(10)  NULL,
        banco            VARCHAR(80)  NULL,
        rut_cuenta       VARCHAR(20)  NULL,
        num_cuenta       VARCHAR(40)  NULL,
        correo_confirmacion VARCHAR(150) NULL,
        observaciones    TEXT         NULL,
        ficha_nombre     VARCHAR(200) NULL,
        ficha_mime       VARCHAR(100) NULL,
        ficha_data       LONGBLOB     NULL,
        tomada_por       INT          NULL,
        tomada_por_nombre VARCHAR(200) NULL,
        fecha_tomada     DATETIME     NULL,
        revisor_id       INT          NULL,
        revisor_nombre   VARCHAR(200) NULL,
        fecha_revision   DATETIME     NULL,
        motivo_rechazo   TEXT         NULL,
        apelacion        TEXT         NULL,
        id_dealer        INT          NULL,
        created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_estado (estado),
        INDEX idx_ejecutivo (id_ejecutivo),
        INDEX idx_rut (rut)
      )
    `);
  } catch (e) { if (e.errno !== 1050) console.error('[dealer_fichas migration]', e.message); }

  // Columnas geográficas derivadas de la comuna (provincia/región) — incrementales.
  try {
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS provincia VARCHAR(120) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS region VARCHAR(120) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS excepciones JSON NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS excepciones_comentarios JSON NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS diferencias JSON NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS rep_legal_origen VARCHAR(15) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS rl_nombre VARCHAR(150) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS rl_telefono VARCHAR(40) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS rl_email VARCHAR(150) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS tipo_cuenta VARCHAR(30) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS nombre_cuenta VARCHAR(150) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS firma_sospecha TINYINT(1) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS firma_detalle VARCHAR(200) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS ficha_faltantes JSON NULL`);
    // Si la ficha MODIFICA un dealer ya existente, aquí va su id_dealer (NULL = creación).
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS id_dealer_origen INT NULL`);
    // Participación especial: comisión pactada por sobre la pizarra → requiere visto de Gerencia.
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS part_especial TINYINT(1) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS part_especial_por VARCHAR(200) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS part_especial_por_id INT NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS part_especial_fecha DATETIME NULL`);
    // Nivel actual dentro de la cadena de autorización paramétrica (NULL = no está autorizándose).
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS nivel_actual INT NULL`);
    // Socios de la empresa (hasta 3) + resultado de los informes comerciales al enviar.
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS socios JSON NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS informes_resumen JSON NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS informes_alerta_grave TINYINT(1) NULL`);
  } catch (e) { console.error('[dealer_fichas alter cols]', e.message); }

  // Archivos adjuntos múltiples (informes comerciales empresa/socios, hasta 3 c/u).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_ficha_archivos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        id_ficha    INT          NOT NULL,
        categoria   VARCHAR(20)  NOT NULL,
        nombre      VARCHAR(200) NULL,
        mime        VARCHAR(100) NULL,
        data        LONGBLOB     NULL,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ficha (id_ficha)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[dealer_ficha_archivos migration]', e.message); }

  // Cadena de aprobación PARAMÉTRICA: niveles que autorizan la ficha antes de imprimir/firmar.
  // condicion: SIEMPRE | COMISION_SOBRE_PIZARRA | DEPOSITO_MODIFICADO
  // permiso: código de funcionalidad que habilita autorizar ese nivel (gobernado por la matriz de Perfiles).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_aprob_niveles (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        orden     INT          NOT NULL DEFAULT 1,
        nombre    VARCHAR(120) NOT NULL,
        condicion VARCHAR(30)  NOT NULL DEFAULT 'SIEMPRE',
        permiso   VARCHAR(60)  NOT NULL,
        activo    TINYINT(1)   NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM dealer_aprob_niveles');
    if (!n) await pool.query(
      `INSERT INTO dealer_aprob_niveles (orden, nombre, condicion, permiso, activo) VALUES
        (1, 'Análisis Operaciones/Crédito', 'SIEMPRE', 'dealer_ficha_revisar', 1),
        (2, 'Visto de Gerencia (participación especial)', 'COMISION_SOBRE_PIZARRA', 'dealer_part_especial', 1)`);
  } catch (e) { if (e.errno !== 1050) console.error('[dealer_aprob_niveles migration]', e.message); }

  // Autorizaciones registradas por ficha (quién autorizó cada nivel) → letra chica en la ficha impresa.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_ficha_autorizaciones (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_ficha       INT          NOT NULL,
        orden          INT          NOT NULL,
        nombre_nivel   VARCHAR(120) NULL,
        permiso        VARCHAR(60)  NULL,
        usuario_id     INT          NULL,
        usuario_nombre VARCHAR(200) NULL,
        perfil         VARCHAR(120) NULL,
        fecha          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ficha (id_ficha)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[dealer_ficha_autorizaciones migration]', e.message); }

  // Registro del módulo en el menú (idempotente).
  try {
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (370001, 'Creación/Mantenedor de Dealer', 'Fichas de incorporación de concesionarios y mantención de dealers', 'bi-building-add', '/dealers-incorporacion/', 104, 'activo')`);
    const funcs = [
      ['Creación/Mantenedor de Dealer', 'dealer_inc_ver',     '/dealers-incorporacion/', 'bi-building-add'],
      ['Crear ficha de dealer',         'dealer_ficha_crear', null,                      null],
      ['Revisar fichas de dealer',      'dealer_ficha_revisar', null,                    null],
      ['Mantener dealers',              'dealer_mantener',    null,                      null],
      ['Aprobar participación especial (Gerencia)', 'dealer_part_especial', null,        null],
      ['Configurar niveles de aprobación de dealer', 'dealer_aprob_config', '/dealers-incorporacion/niveles.html', 'bi-diagram-3'],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (370001,?,?,?,?)`,
        [nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    // Permisos por defecto: { codigo: [perfiles] }
    // 1 Admin · 4 Ejecutivo Comercial · 6 Analista de Operaciones
    // 90008 Gerente de Operaciones y Crédito · 90009 Gerente General
    const seed = {
      dealer_inc_ver:       [1, 4, 6, 90008, 90009],
      dealer_ficha_crear:   [1, 4],
      dealer_ficha_revisar: [1, 6, 90008],
      dealer_mantener:      [1, 6, 90008],
      dealer_part_especial: [1, 90008, 90009],   // visto de Gerencia para comisión sobre la pizarra
      dealer_aprob_config:  [1],                  // configurar la cadena de niveles (restringible por usuario)
    };
    for (const [codigo, perfiles] of Object.entries(seed)) {
      const idf = idFunc[codigo]; if (!idf) continue;
      for (const idp of perfiles) {
        const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
      }
    }
    console.log('[dealers-incorporacion] módulo registrado');
  } catch (e) { console.error('[dealers-incorporacion migration]', e.message); }
})();

/* ── Helpers ──────────────────────────────────────────────────────────────── */
const norm = s => String(s || '').trim();
const num  = v => { const n = Number(String(v ?? '').replace(',', '.').replace(/[^\d.-]/g, '')); return isNaN(n) ? null : n; };

// Usuarios activos que pueden revisar (pool) — Administradores + quien tenga el permiso.
async function idsRevisores(excluirId) {
  const [rows] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE p.nombre='Administrador' AND u.estado='activo'
     UNION
     SELECT u.id_usuario FROM usuarios u
       JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil
       JOIN funcionalidades f  ON f.id_funcionalidad=pp.id_funcionalidad
     WHERE f.codigo='dealer_ficha_revisar' AND pp.habilitado=1 AND u.estado='activo'`
  );
  return rows.map(r => r.id_usuario).filter(id => id !== excluirId);
}

// ¿El usuario puede revisar (pool de Analistas de Operaciones + Admin)?
function puedeRevisar(req) {
  if ((req.usuario || {}).perfil_nombre === 'Administrador') return true;
  return tieneFunc(req.usuario.id_usuario, 'dealer_ficha_revisar');
}

// Pool de Gerencia (Gerente General / Operaciones y Crédito + Admin) para participación especial.
async function idsGerencia() {
  const [rows] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE p.nombre='Administrador' AND u.estado='activo'
     UNION
     SELECT u.id_usuario FROM usuarios u
       JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil
       JOIN funcionalidades f  ON f.id_funcionalidad=pp.id_funcionalidad
     WHERE f.codigo='dealer_part_especial' AND pp.habilitado=1 AND u.estado='activo'`);
  return [...new Set(rows.map(r => r.id_usuario))];
}

// ¿La comisión pactada de la ficha supera la PIZARRA de su tipo? → participación especial.
async function esEspecial(f) {
  try {
    const defs = await comDefaults();
    const d = defs[f.tipo === 'PARQUE' ? 'PARQUE' : 'GENERAL'];
    const gt = (v, base) => v != null && v !== '' && Number(v) > Number(base) + 1e-9;
    return gt(f.com_6_12, d.com_6_12) || gt(f.com_13_24, d.com_13_24) || gt(f.com_25_36, d.com_25_36) || gt(f.com_37, d.com_37);
  } catch (e) { console.error('[esEspecial]', e.message); return false; }
}

// En una modificación, ¿cambió el depósito (banco/cuenta/RUT de pago) vs el dealer actual?
async function depositoCambioVsDealer(f) {
  if (!f.id_dealer_origen) return false;
  try {
    const [[dl]] = await pool.query('SELECT banco, num_cuenta, rut_pago FROM dealers WHERE id_dealer=?', [f.id_dealer_origen]);
    if (!dl) return false;
    const nz = v => String(v == null ? '' : v).trim().toUpperCase();
    return nz(f.banco) !== nz(dl.banco) || nz(f.num_cuenta) !== nz(dl.num_cuenta) || normRut(f.rut_cuenta) !== normRut(dl.rut_pago);
  } catch (e) { console.error('[depositoCambio]', e.message); return false; }
}

/* ── Motor de la cadena de aprobación paramétrica ─────────────────────────── */
// Pool de usuarios (Admin + quien tenga el permiso) — para notificar/validar un nivel.
async function idsConPermiso(codigo, excluir) {
  const [rows] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE p.nombre='Administrador' AND u.estado='activo'
     UNION
     SELECT u.id_usuario FROM usuarios u
       JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil
       JOIN funcionalidades f  ON f.id_funcionalidad=pp.id_funcionalidad
     WHERE f.codigo=? AND pp.habilitado=1 AND u.estado='activo'`, [codigo]);
  return [...new Set(rows.map(r => r.id_usuario))].filter(id => id !== excluir);
}
async function nivelesActivos() {
  const [rows] = await pool.query('SELECT id, orden, nombre, condicion, permiso FROM dealer_aprob_niveles WHERE activo=1 ORDER BY orden, id');
  return rows;
}
// ¿Aplica este nivel a esta ficha, según su condición?
async function nivelAplica(niv, f) {
  if (niv.condicion === 'COMISION_SOBRE_PIZARRA') return await esEspecial(f);
  if (niv.condicion === 'DEPOSITO_MODIFICADO')    return await depositoCambioVsDealer(f);
  return true;   // SIEMPRE (o condición desconocida → fail-safe: exige autorización)
}
// Niveles aplicables a la ficha, en orden.
async function nivelesAplicables(f) {
  const out = [];
  for (const n of await nivelesActivos()) if (await nivelAplica(n, f)) out.push(n);
  return out;
}
// Siguiente nivel aplicable con orden > despues (o null si no hay más).
async function siguienteNivel(f, despues) {
  for (const n of await nivelesAplicables(f)) if (n.orden > despues) return n;
  return null;
}

/* ── Alertas de cada etapa, configurables en el mantenedor de Alertas ──────── */
const SONIDOS_DEALER = ['campana', 'dingdong', 'alarma', 'aplausos'];
const EVENTOS_DEALER = [
  { evento: 'dealer_para_autorizar', titulo: 'Dealer — ficha por autorizar',        son_def: 'dingdong' },
  { evento: 'dealer_autorizada',     titulo: 'Dealer — ficha autorizada (imprimir/firmar)', son_def: 'aplausos' },
  { evento: 'dealer_firmada',        titulo: 'Dealer — ficha firmada (revisar y cerrar)',   son_def: 'dingdong' },
  { evento: 'dealer_cerrada',        titulo: 'Dealer — creado/actualizado',          son_def: 'dingdong' },
  { evento: 'dealer_rechazada',      titulo: 'Dealer — ficha rechazada',             son_def: 'alarma' },
];
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS dealer_alertas_config (
      evento            VARCHAR(40) PRIMARY KEY,
      perfiles          TEXT,
      incluir_ejecutivo TINYINT(1) NOT NULL DEFAULT 0,
      usuarios_extra    TEXT,
      activo            TINYINT(1) NOT NULL DEFAULT 1,
      prioridad         VARCHAR(10) NOT NULL DEFAULT 'alta',
      sonido            TINYINT(1) NOT NULL DEFAULT 1,
      sonido_tipo       VARCHAR(20) NOT NULL DEFAULT 'dingdong',
      sonido_cada_seg   INT NOT NULL DEFAULT 30,
      sonido_max_min    INT NOT NULL DEFAULT 5
    )`);
    for (const e of EVENTOS_DEALER)
      await pool.query(
        `INSERT IGNORE INTO dealer_alertas_config (evento, perfiles, incluir_ejecutivo, activo, prioridad, sonido, sonido_tipo) VALUES (?,?,0,1,'alta',1,?)`,
        [e.evento, '', e.son_def]);
  } catch (e) { console.error('[dealer_alertas migration]', e.message); }
})();

// Envía la alerta de una etapa respetando su configuración (activo/perfiles/sonido).
// idsBase = destinatarios intrínsecos del flujo (pool del nivel o el ejecutivo); el
// mantenedor puede sumar perfiles/usuarios y togglear activo/sonido/prioridad.
async function notificarEventoDealer(evento, { idsBase = [], ejecutivo = null, titulo, mensaje, href, clave } = {}) {
  try {
    const [[cfg]] = await pool.query('SELECT * FROM dealer_alertas_config WHERE evento=?', [evento]);
    if (cfg && !cfg.activo) return;   // desactivado en el mantenedor de Alertas
    const ids = new Set((idsBase || []).filter(Boolean));
    if (cfg) {
      const perfiles = String(cfg.perfiles || '').split(',').map(s => s.trim()).filter(Boolean);
      if (perfiles.length) {
        const [us] = await pool.query(
          `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
           WHERE p.nombre IN (?) AND (u.estado IS NULL OR u.estado<>'inactivo')`, [perfiles]);
        us.forEach(u => ids.add(u.id_usuario));
      }
      if (cfg.incluir_ejecutivo && ejecutivo) ids.add(ejecutivo);
      String(cfg.usuarios_extra || '').split(',').map(s => parseInt(s.trim())).filter(Boolean).forEach(id => ids.add(id));
    }
    if (!ids.size) return;
    let dest = [...ids];
    try { dest = await require('../../../../shared/backups').expandirAlerta(dest); } catch (_) {}
    const def = EVENTOS_DEALER.find(e => e.evento === evento) || {};
    const prioridad = cfg?.prioridad || 'alta';
    const sonar = cfg ? (cfg.sonido ? 1 : 0) : 1;
    const sonTipo = SONIDOS_DEALER.includes(cfg?.sonido_tipo) ? cfg.sonido_tipo : (def.son_def || 'dingdong');
    const sonCada = cfg?.sonido_cada_seg || 30;
    const sonMax = cfg?.sonido_max_min || 5;
    const k = clave || `dealerficha:${evento}:${Date.now()}`;
    for (const uid of dest) {
      const [[ex]] = await pool.query('SELECT 1 FROM notificaciones WHERE id_usuario=? AND clave=? AND leida=0 LIMIT 1', [uid, k]);
      if (ex) continue;
      await pool.query(
        `INSERT INTO notificaciones (id_usuario, tipo, titulo, mensaje, href, clave, prioridad, sonar, son_cada, son_max, son_tipo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [uid, 'DEALER_FICHA', titulo || def.titulo, mensaje, href, k, prioridad, sonar, sonCada, sonMax, sonTipo]);
    }
  } catch (e) { console.error('[notificarEventoDealer]', evento, e.message); }
}

/* ── GET/PUT /alertas-config — para el mantenedor de Alertas ───────────────── */
const getAlertasConfig = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM dealer_alertas_config');
    const map = {}; rows.forEach(r => { map[r.evento] = r; });
    const data = EVENTOS_DEALER.map(e => {
      const c = map[e.evento] || {};
      return { evento: e.evento, titulo: e.titulo,
        perfiles: c.perfiles || '', incluir_ejecutivo: !!c.incluir_ejecutivo,
        usuarios_extra: c.usuarios_extra || '', activo: c.activo === undefined ? 1 : c.activo,
        prioridad: c.prioridad || 'alta', sonido: c.sonido === undefined ? 1 : c.sonido,
        sonido_tipo: c.sonido_tipo || e.son_def, sonido_cada_seg: c.sonido_cada_seg || 30,
        sonido_max_min: c.sonido_max_min || 5 };
    });
    res.json({ success: true, data, sonidos: SONIDOS_DEALER, error: null });
  } catch (e) { console.error('[dealer alertas-config get]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const setAlertasConfig = async (req, res) => {
  try {
    const lista = Array.isArray(req.body?.config) ? req.body.config : [];
    for (const c of lista) {
      if (!EVENTOS_DEALER.find(e => e.evento === c.evento)) continue;
      const sonTipo = SONIDOS_DEALER.includes(c.sonido_tipo) ? c.sonido_tipo : 'dingdong';
      await pool.query(
        `INSERT INTO dealer_alertas_config (evento, perfiles, incluir_ejecutivo, usuarios_extra, activo, prioridad, sonido, sonido_tipo, sonido_cada_seg, sonido_max_min)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE perfiles=VALUES(perfiles), incluir_ejecutivo=VALUES(incluir_ejecutivo),
           usuarios_extra=VALUES(usuarios_extra), activo=VALUES(activo), prioridad=VALUES(prioridad),
           sonido=VALUES(sonido), sonido_tipo=VALUES(sonido_tipo), sonido_cada_seg=VALUES(sonido_cada_seg), sonido_max_min=VALUES(sonido_max_min)`,
        [c.evento, String(c.perfiles || ''), c.incluir_ejecutivo ? 1 : 0, String(c.usuarios_extra || ''), c.activo ? 1 : 0,
         c.prioridad === 'alta' ? 'alta' : 'normal', c.sonido ? 1 : 0, sonTipo,
         Math.max(5, parseInt(c.sonido_cada_seg) || 30), Math.max(1, parseInt(c.sonido_max_min) || 5)]);
    }
    res.json({ success: true, data: { actualizados: lista.length }, error: null });
  } catch (e) { console.error('[dealer alertas-config set]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// Campos editables de la ficha (todo menos workflow/archivo).
const CAMPOS = ['tipo','ejecutivo_nombre','fecha_solicitud','rut','nombre_razon','nombre_fantasia','direccion','comuna','provincia','region',
  'cc_nombre','cc_telefono','cc_email','cf_nombre','cf_telefono','cf_email',
  'rep_legal_origen','rl_nombre','rl_telefono','rl_email',
  'com_6_12','com_13_24','com_25_36','com_37','tipo_documento','cuenta_tipo','tipo_cuenta','nombre_cuenta','banco',
  'rut_cuenta','num_cuenta','correo_confirmacion','observaciones'];

const CATEGORIAS = ['EMPRESA', 'SOCIOS', 'SOCIO1', 'SOCIO2', 'SOCIO3', 'PODER_SIMPLE', 'PODER_REP_LEGAL'];   // adjuntos
const normRut = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();

// Comentario de excepción válido: ≥10 caracteres y al menos un espacio (no se avisan las reglas al usuario).
const comentarioOK = c => { const s = String(c || '').trim(); return s.length >= 10 && /\s/.test(s); };

// Socios de la empresa (hasta 3): normaliza [{rut, nombre}] desde el payload.
function normSocios(body) {
  let s = body && body.socios;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = []; } }
  if (!Array.isArray(s)) return [];
  return s.slice(0, 3).map(x => ({
    rut: String((x && x.rut) || '').trim(),
    nombre: String((x && x.nombre) || '').trim(),
  })).filter(x => x.rut || x.nombre);
}

// Normaliza el payload de excepciones y valida sus comentarios.
function excepcionesDe(body) {
  const exc = Array.isArray(body.excepciones) ? body.excepciones : [];
  const com = Array.isArray(body.excepciones_comentarios) ? body.excepciones_comentarios : [];
  return { exc, com };
}

function armarValores(body) {
  const v = {};
  for (const k of CAMPOS) {
    if (!(k in body)) continue;
    if (k.startsWith('com_')) v[k] = num(body[k]);
    else if (k === 'tipo') v[k] = (norm(body[k]).toUpperCase() === 'PARQUE') ? 'PARQUE' : 'GENERAL';
    else if (k === 'fecha_solicitud') v[k] = body[k] || null;
    else v[k] = norm(body[k]) || null;
  }
  return v;
}

/* ── GET /ejecutivos — nombres elegibles para la ficha ────────────────────── */
const ejecutivos = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT(COALESCE(u.nombre,''),' ',COALESCE(u.apellido,''))) AS nombre, p.nombre AS perfil
       FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
       WHERE u.estado='activo' AND p.nombre IN ('Ejecutivo Comercial','Jefe Comercial','Analista de Operaciones')
       ORDER BY u.nombre, u.apellido`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[fichas ejecutivos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /fichas — lista (ejecutivo ve las suyas; revisores ven todas) ─────── */
const listar = async (req, res) => {
  try {
    const rev = await puedeRevisar(req);
    const { estado, q } = req.query;
    const where = [], vals = [];
    if (!rev) { where.push('id_ejecutivo = ?'); vals.push(req.usuario.id_usuario); }
    if (estado) { where.push('estado = ?'); vals.push(estado); }
    if (q) { where.push('(rut LIKE ? OR nombre_razon LIKE ? OR nombre_fantasia LIKE ? OR ejecutivo_nombre LIKE ?)');
      const like = '%' + q + '%'; vals.push(like, like, like, like); }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await pool.query(
      `SELECT df.id, df.tipo, df.estado, df.id_ejecutivo, df.ejecutivo_nombre, df.fecha_solicitud, df.rut, df.nombre_razon, df.nombre_fantasia,
              df.comuna, df.direccion, df.apelacion, df.tomada_por, df.tomada_por_nombre, df.revisor_nombre, df.fecha_revision, df.motivo_rechazo,
              df.com_6_12, df.com_13_24, df.com_25_36, df.com_37, df.tipo_documento, df.cuenta_tipo, df.banco, df.num_cuenta, df.rut_cuenta,
              df.cc_nombre, df.cc_telefono, df.cc_email, df.id_dealer, df.id_dealer_origen, df.part_especial, df.part_especial_por, df.nivel_actual,
              (SELECT n.nombre  FROM dealer_aprob_niveles n WHERE n.orden=df.nivel_actual AND n.activo=1 ORDER BY n.id LIMIT 1) AS nivel_actual_nombre,
              (SELECT n.permiso FROM dealer_aprob_niveles n WHERE n.orden=df.nivel_actual AND n.activo=1 ORDER BY n.id LIMIT 1) AS nivel_actual_permiso,
              (df.ficha_data IS NOT NULL) AS tiene_ficha,
              df.firma_sospecha, JSON_LENGTH(df.diferencias) AS n_diferencias, JSON_LENGTH(df.ficha_faltantes) AS n_faltantes,
              df.created_at, df.updated_at
       FROM dealer_fichas df ${whereStr} ORDER BY
         FIELD(df.estado,'RECHAZADA','PEND_AUTORIZACION','PEND_CIERRE','TOMADA','AUTORIZADA','BORRADOR','APROBADA'), df.updated_at DESC
       LIMIT 500`, vals);
    res.json({ success: true, data: { rows, puede_revisar: rev }, error: null });
  } catch (e) { console.error('[fichas listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /fichas/:id ──────────────────────────────────────────────────────── */
const obtener = async (req, res) => {
  try {
    const [[f]] = await pool.query(
      `SELECT id, tipo, estado, id_ejecutivo, ejecutivo_email, ejecutivo_nombre, fecha_solicitud,
              rut, nombre_razon, nombre_fantasia, direccion, comuna, provincia, region,
              cc_nombre, cc_telefono, cc_email, cf_nombre, cf_telefono, cf_email,
              rep_legal_origen, rl_nombre, rl_telefono, rl_email,
              com_6_12, com_13_24, com_25_36, com_37, tipo_documento, cuenta_tipo, tipo_cuenta, nombre_cuenta, banco,
              rut_cuenta, num_cuenta, correo_confirmacion, observaciones,
              excepciones, excepciones_comentarios, diferencias, firma_sospecha, firma_detalle, ficha_faltantes,
              ficha_nombre, ficha_mime, (ficha_data IS NOT NULL) AS tiene_ficha,
              tomada_por, tomada_por_nombre, fecha_tomada, revisor_id, revisor_nombre, fecha_revision,
              motivo_rechazo, apelacion, id_dealer, id_dealer_origen, nivel_actual,
              socios, informes_resumen, informes_alerta_grave,
              part_especial, part_especial_por, part_especial_fecha, created_at, updated_at
       FROM dealer_fichas WHERE id = ?`, [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (!(await puedeRevisar(req)) && f.id_ejecutivo !== req.usuario.id_usuario)
      return res.status(403).json({ success: false, data: null, error: 'Sin acceso a esta ficha' });
    // Autorizaciones registradas (para la letra chica) + nombre del nivel actual pendiente.
    const [autoriz] = await pool.query(
      'SELECT orden, nombre_nivel, usuario_nombre, perfil, fecha FROM dealer_ficha_autorizaciones WHERE id_ficha=? ORDER BY orden, id', [req.params.id]);
    f.autorizaciones = autoriz;
    if (f.estado === 'PEND_AUTORIZACION') {
      const [[niv]] = await pool.query('SELECT nombre FROM dealer_aprob_niveles WHERE orden=? AND activo=1 ORDER BY id LIMIT 1', [f.nivel_actual]);
      f.nivel_actual_nombre = niv ? niv.nombre : null;
    }
    res.json({ success: true, data: f, error: null });
  } catch (e) { console.error('[fichas obtener]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas — crear borrador ────────────────────────────────────────── */
const crear = async (req, res) => {
  try {
    const v = armarValores(req.body);
    if (!v.tipo) v.tipo = 'GENERAL';
    // Comisiones por defecto (derivadas de la pizarra Parque/Calle) si no vienen
    const defs = await comDefaults();
    const def = defs[v.tipo] || defs.GENERAL;
    for (const k of ['com_6_12','com_13_24','com_25_36','com_37'])
      if (v[k] == null) v[k] = def[k];
    const u = req.usuario;
    // ejecutivo_nombre es editable (otro Ejecutivo/Jefe Comercial/Analista); default = creador.
    if (!v.ejecutivo_nombre) v.ejecutivo_nombre = [u.nombre, u.apellido].filter(Boolean).join(' ') || null;
    // Excepciones (comisión modificada, boleta…) — cada una requiere comentario válido.
    const { exc, com } = excepcionesDe(req.body);
    if (exc.length && !com.every(c => comentarioOK(c.comentario)))
      return res.status(400).json({ success: false, data: null, error: 'Cada excepción requiere un comentario válido' });
    const idOrigen = Number(req.body.id_dealer_origen) || null;   // dealer existente que esta ficha modifica
    const cols = ['id_ejecutivo','ejecutivo_email', ...Object.keys(v), 'excepciones','excepciones_comentarios','id_dealer_origen','socios'];
    const ph   = cols.map(() => '?').join(',');
    const vals = [u.id_usuario, u.email || null, ...Object.values(v),
      JSON.stringify(exc), JSON.stringify(com), idOrigen, JSON.stringify(normSocios(req.body))];
    const [r] = await pool.query(`INSERT INTO dealer_fichas (${cols.join(',')}) VALUES (${ph})`, vals);
    auditar({ req, accion: 'CREAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: r.insertId,
      detalle: `Creó ficha de incorporación (${v.tipo}) ${v.nombre_razon || v.rut || ''}`.trim()
        + (exc.length ? ` · ${exc.length} excepción(es)` : ''), rut: v.rut, meta: exc.length ? { excepciones: exc } : null });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[fichas crear]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── PUT /fichas/:id — editar (solo dueño, en BORRADOR/RECHAZADA) ──────────── */
const editar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT id_ejecutivo, estado FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Solo el ejecutivo que la creó puede editarla' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha está en revisión o aprobada; no se puede editar' });
    const v = armarValores(req.body);
    const setCols = Object.keys(v).map(k => `${k}=?`);
    const setVals = Object.values(v);
    // Excepciones (si vienen en el payload): validar comentarios y persistir.
    if ('excepciones' in req.body) {
      const { exc, com } = excepcionesDe(req.body);
      if (exc.length && !com.every(c => comentarioOK(c.comentario)))
        return res.status(400).json({ success: false, data: null, error: 'Cada excepción requiere un comentario válido' });
      setCols.push('excepciones=?', 'excepciones_comentarios=?');
      setVals.push(JSON.stringify(exc), JSON.stringify(com));
    }
    // Modo creación/modificación: id_dealer_origen (NULL = creación).
    if ('id_dealer_origen' in req.body) {
      setCols.push('id_dealer_origen=?');
      setVals.push(Number(req.body.id_dealer_origen) || null);
    }
    // Socios de la empresa (hasta 3).
    if ('socios' in req.body) {
      setCols.push('socios=?');
      setVals.push(JSON.stringify(normSocios(req.body)));
    }
    if (!setCols.length) return res.status(400).json({ success: false, data: null, error: 'Sin cambios' });
    await pool.query(`UPDATE dealer_fichas SET ${setCols.join(',')} WHERE id=?`, [...setVals, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Editó ficha de dealer #${req.params.id}`, meta: { campos: Object.keys(v) } });
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { console.error('[fichas editar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas/:id/archivo — subir ficha firmada (base64) ───────────────── */
const subirFicha = async (req, res) => {
  try {
    const { archivo_nombre, mime_type, archivo_data } = req.body || {};
    if (!archivo_data) return res.status(400).json({ success: false, data: null, error: 'Falta el archivo' });
    const [[f]] = await pool.query('SELECT id_ejecutivo, estado FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Sin permiso' });
    // La ficha firmada se sube DESPUÉS de la autorización (AUTORIZADA), o se reemplaza antes del cierre.
    if (!['AUTORIZADA', 'PEND_CIERRE'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha firmada se sube una vez AUTORIZADA' });
    const buffer = Buffer.from(archivo_data, 'base64');
    await pool.query('UPDATE dealer_fichas SET ficha_nombre=?, ficha_mime=?, ficha_data=? WHERE id=?',
      [archivo_nombre || 'ficha.pdf', mime_type || 'application/octet-stream', buffer, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Subió ficha firmada de dealer #${req.params.id} (${archivo_nombre || ''})` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[fichas subir]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /fichas/:id/archivo — ver/descargar ficha firmada ─────────────────── */
// Content-Disposition seguro: el header HTTP no admite caracteres fuera de
// Latin-1 (ej. "—" U+2014) → Node lanza ERR_INVALID_CHAR. Fallback ASCII +
// RFC 5987 (filename*) para conservar el nombre real en navegadores modernos.
function dispFilename(name) {
  const n = String(name || 'archivo').replace(/"/g, '');
  const ascii = n.replace(/[^\x20-\x7E]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(n)}`;
}

const verFicha = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT id_ejecutivo, ficha_nombre, ficha_mime, ficha_data FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f || !f.ficha_data) return res.status(404).json({ success: false, data: null, error: 'Sin archivo' });
    if (!(await puedeRevisar(req)) && f.id_ejecutivo !== req.usuario.id_usuario)
      return res.status(403).json({ success: false, data: null, error: 'Sin acceso' });
    auditar({ req, accion: 'VER_DOCUMENTO', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Visualizó ficha firmada de dealer #${req.params.id}` });
    res.set('Content-Type', f.ficha_mime || 'application/octet-stream');
    res.set('Content-Disposition', dispFilename(f.ficha_nombre || 'ficha'));
    res.send(f.ficha_data);
  } catch (e) { console.error('[fichas verFicha]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* Compara la ficha contra el dealer ya existente en el sistema (match por RUT). */
async function calcularDiferencias(f) {
  const dif = [];
  try {
    const [rows] = await pool.query('SELECT * FROM dealers WHERE rut IS NOT NULL', []);
    // Compara contra el dealer que la ficha declara modificar (id_dealer_origen);
    // si no, cae al match por RUT (RUT es UNIQUE en dealers).
    let dl = f.id_dealer_origen ? rows.find(d => d.id_dealer === f.id_dealer_origen) : null;
    if (!dl) dl = rows.find(d => normRut(d.rut) === normRut(f.rut));
    if (!dl) return dif;
    const cmp = (campo, fv, sv) => {
      const a = (fv == null ? '' : String(fv)).trim(), b = (sv == null ? '' : String(sv)).trim();
      if (a && a.toUpperCase() !== b.toUpperCase()) dif.push({ campo, ficha: a, sistema: b || '—' });
    };
    cmp('Razón Social', f.nombre_razon, dl.nombre_razon);
    cmp('Nombre Fantasía', f.nombre_fantasia, dl.nombre_indexa);
    cmp('Dirección', f.direccion, dl.direccion);
    cmp('Banco', f.banco, dl.banco);
    cmp('N° Cuenta', f.num_cuenta, dl.num_cuenta);
    cmp('RUT Cuenta', f.rut_cuenta, dl.rut_pago);
    const fDoc = f.tipo_documento === 'FACTURA' ? 'FACTURA' : 'BOLETA';
    const sDoc = dl.tiene_factura ? 'FACTURA' : 'BOLETA';
    if (fDoc !== sDoc) dif.push({ campo: 'Documento tributario', ficha: fDoc, sistema: sDoc });
    // Comisiones pactadas por tramo (clave para la "participación especial").
    const cmpCom = (campo, fv, sv) => {
      const a = (fv == null || fv === '') ? null : Number(fv);
      const b = (sv == null || sv === '') ? null : Number(sv);
      if (a != null && a !== b) dif.push({ campo, ficha: a + '%', sistema: (b == null ? '—' : b + '%') });
    };
    cmpCom('Comisión 6–12', f.com_6_12, dl.com_6_12);
    cmpCom('Comisión 13–24', f.com_13_24, dl.com_13_24);
    cmpCom('Comisión 25–36', f.com_25_36, dl.com_25_36);
    cmpCom('Comisión 37+', f.com_37, dl.com_37);
  } catch (e) { console.error('[calcularDiferencias]', e.message); }
  return dif;
}

/* Verifica (sin IA) si la ficha subida parece venir firmada. Heurística: una ficha
   firmada se imprime, firma y escanea/fotografía (PDF imagen o JPG/PNG, sin capa de
   texto). Si el archivo es el PDF DIGITAL de la plantilla (con texto del formulario),
   es muy probable que NO esté firmado → sospecha. */
async function verificarFirma(buffer, mime) {
  try {
    if (!buffer) return { sospecha: 1, detalle: 'No se adjuntó la ficha firmada.' };
    const m = String(mime || '').toLowerCase();
    if (m.includes('pdf') && pdfParse) {
      const data = await pdfParse(buffer).catch(() => null);
      const txt = ((data && data.text) || '').replace(/\s+/g, ' ').trim();
      const marcadores = ['FICHA DE INCORPORACIÓN', 'REPRESENTANTE LEGAL', 'FORMA DE PAGO', 'COMISIÓN PACTADA', 'CONTACTO COMERCIAL', 'DATOS DE CONCESIONARIO'];
      const hits = marcadores.filter(k => txt.toUpperCase().includes(k)).length;
      if (txt.length > 250 && hits >= 2)
        return { sospecha: 1, detalle: 'El archivo es el PDF digital de la ficha (con texto), no un escaneo/foto: probablemente NO está firmado.' };
      return { sospecha: 0, detalle: 'PDF escaneado (sin texto): la firma no se puede confirmar automáticamente, revisar visualmente.' };
    }
    return { sospecha: 0, detalle: 'Imagen (foto/escaneo): la firma no se puede confirmar automáticamente, revisar visualmente.' };
  } catch (e) { return { sospecha: 0, detalle: 'No se pudo analizar el archivo.' }; }
}

/* Compara el TEXTO del archivo subido (si es PDF con texto) contra los datos
   ingresados en la ficha. Devuelve los campos cuyo valor no aparece en el
   documento (solo aplica a PDFs con capa de texto; los escaneos/fotos no se
   pueden leer y se omiten). */
const _norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
async function compararFichaTexto(buffer, mime, f) {
  try {
    if (!buffer || !pdfParse || !String(mime || '').toLowerCase().includes('pdf')) return { revisado: false, faltantes: [] };
    const data = await pdfParse(buffer).catch(() => null);
    const txt = _norm((data && data.text) || '');
    if (txt.length < 80) return { revisado: false, faltantes: [] };   // escaneo/sin texto útil
    const campos = [
      ['RUT concesionario', f.rut], ['Razón Social', f.nombre_razon], ['Nombre Fantasía', f.nombre_fantasia],
      ['Dirección', f.direccion], ['Comuna', f.comuna], ['Contacto comercial', f.cc_nombre],
      ['Representante Legal', f.rl_nombre], ['Banco', f.banco], ['N° Cuenta', f.num_cuenta], ['RUT cuenta', f.rut_cuenta],
    ];
    const faltantes = [];
    for (const [label, val] of campos) {
      const n = _norm(val);
      if (n.length >= 3 && !txt.includes(n)) faltantes.push({ campo: label, valor: String(val) });
    }
    return { revisado: true, faltantes };
  } catch (e) { return { revisado: false, faltantes: [] }; }
}

/* ── POST /fichas/:id/enviar — manda a AUTORIZACIÓN (cadena paramétrica) ────
   Antes de imprimir/firmar: valida datos + informes + poderes (NO la firma).  */

/* ── Informes comerciales: set por entidad + verificación/auto-solicitud DealerNet ──
   Empresa + hasta 3 socios. Si la entidad NO subió informes, Business Suite revisa el
   repositorio y, si falta o supera el umbral (15 días), los pide a DealerNet y arma un
   resumen. Alerta GRAVE si hay registros penales/judiciales. NO bloquea el envío: deja
   el resultado en la ficha (informes_resumen / informes_alerta_grave). */
async function setsFichaInformes() {
  try {
    const [emp] = await pool.query("SELECT codigo FROM dealernet_productos WHERE ficha_empresa=1 ORDER BY orden, codigo");
    const [soc] = await pool.query("SELECT codigo FROM dealernet_productos WHERE ficha_socio=1 ORDER BY orden, codigo");
    return { empresa: emp.map(x => String(x.codigo)), socio: soc.map(x => String(x.codigo)) };
  } catch { return { empresa: [], socio: [] }; }
}

async function procesarInformesFicha(f, porCat, usuario) {
  const dnet = (() => { try { return require('../../../clientes/src/controllers/dealernet-ws.controller'); } catch { return null; } })();
  const sets = await setsFichaInformes();
  let socios = f.socios;
  if (typeof socios === 'string') { try { socios = JSON.parse(socios); } catch { socios = []; } }
  if (!Array.isArray(socios)) socios = [];
  const entidades = [
    { tipo: 'EMPRESA', cat: 'EMPRESA', rut: f.rut, nombre: f.nombre_razon || f.rut, productos: sets.empresa },
    ...socios.slice(0, 3).map((s, i) => ({ tipo: 'SOCIO' + (i + 1), cat: 'SOCIO' + (i + 1),
      rut: s && s.rut, nombre: (s && s.nombre) || (s && s.rut) || ('Socio ' + (i + 1)), productos: sets.socio })),
  ].filter(e => e.rut && String(e.rut).trim());

  const resumen = []; let grave = false;
  for (const e of entidades) {
    const subio = (porCat[e.cat] || 0) > 0;
    const r = { tipo: e.tipo, nombre: e.nombre, rut: e.rut, modo: null, rating: 'sin_datos', grave: false, productos: [], advertencias: [] };
    if (subio) {
      r.modo = 'subido';
      r.advertencias.push('Informes adjuntados manualmente por el ejecutivo.');
    } else if (dnet && dnet.asegurarInformes && e.productos.length) {
      r.modo = 'dealernet';
      try {
        const a = await dnet.asegurarInformes({ rut: e.rut, productos: e.productos, usuario });
        const items = a.items || [];
        r.productos = items;
        const RANK = { sin_datos: 0, bueno: 1, regular: 2, malo: 3, grave: 4 };
        const disp = items.filter(it => it.disponible);
        r.rating = disp.length ? disp.reduce((w, it) => (RANK[it.severidad] || 0) > (RANK[w] || 0) ? it.severidad : w, 'bueno') : 'sin_datos';
        r.grave = r.rating === 'grave';
        if (a.faltaban && a.faltaban.length) r.advertencias.push(a.consultado
          ? 'No se habían consultado previamente; Business Suite los solicitó a DealerNet.'
          : ('Faltaban informes y no se pudieron obtener: ' + (a.error || 'sin credenciales/contacto') + '.'));
        const conObs = (a.items || []).filter(it => it.tiene_registros).map(it => it.nombre);
        r.advertencias.push(conObs.length ? ('Con observaciones: ' + conObs.join(', ') + '.') : 'Sin observaciones relevantes.');
        // Análisis con IA (si está activo): refina el rating + crea/actualiza cliente + información comercial.
        try {
          const iaCtrl = require('../../../ia/src/controllers/informe-dealernet.controller');
          const ai = await iaCtrl.analizarRut({ rut: e.rut, nombre: e.nombre, id_usuario: usuario && usuario.id_usuario });
          if (ai && ai.ok) {
            const penal = (ai.causas_judiciales || []).some(c => String(c.tipo || '').toUpperCase() === 'PENAL');
            const nr = String(ai.nivel_riesgo || '').toUpperCase();
            r.rating = penal ? 'grave' : (nr === 'ALTO' ? 'malo' : nr === 'MEDIO' ? 'regular' : 'bueno');
            r.grave = r.rating === 'grave';
            r.ia = true;
            if (ai.resumen) r.advertencias.push('IA: ' + ai.resumen);
            if (ai.guardado && ai.guardado.ok) r.advertencias.push('Base de clientes ' + (ai.guardado.creado ? 'creada' : 'actualizada') + ' + información comercial.');
          }
        } catch (eIA) {
          if (eIA.code === 'IA_OFF') r.advertencias.push('Análisis con IA desactivado (Mantenedores → Inteligencia Artificial).');
          else if (eIA.code === 'NO_KEY') r.advertencias.push('IA sin API key configurada en el servidor.');
          // otros errores: queda el rating heurístico, sin romper el envío
        }
      } catch (err) { r.advertencias.push('Error consultando DealerNet: ' + err.message); }
    } else {
      r.modo = 'sin_set';
      r.advertencias.push('Sin informes configurados para esta entidad (o módulo DealerNet no disponible).');
    }
    if (r.grave) grave = true;
    resumen.push(r);
  }
  try { await pool.query('UPDATE dealer_fichas SET informes_resumen=?, informes_alerta_grave=? WHERE id=?',
    [JSON.stringify(resumen), grave ? 1 : 0, f.id]); } catch (_) {}
  return { resumen, grave };
}

const enviar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT * FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Solo el ejecutivo que la creó puede enviarla' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha ya está en proceso de autorización o aprobada' });
    if (!f.rut || !f.nombre_razon) return res.status(400).json({ success: false, data: null, error: 'Faltan datos obligatorios (RUT y Razón Social)' });
    // Informes comerciales: si la entidad no subió archivos, Business Suite los verifica
    // y solicita en DealerNet (repositorio 15 días). No bloquea el envío; deja el resumen.
    const [cats] = await pool.query('SELECT categoria, COUNT(*) n FROM dealer_ficha_archivos WHERE id_ficha=? GROUP BY categoria', [req.params.id]);
    const porCat = Object.fromEntries(cats.map(c => [c.categoria, c.n]));
    const informes = await procesarInformesFicha(f, porCat, req.usuario);
    // Poderes obligatorios: cuenta de tercero o modificación que cambia el depósito.
    const cuentaTercero = f.rut_cuenta && normRut(f.rut_cuenta) !== normRut(f.rut);
    const depCambio = await depositoCambioVsDealer(f);
    if (cuentaTercero || depCambio) {
      const motivo = cuentaTercero ? 'La cuenta es de un tercero' : 'Modificaste el depósito del dealer';
      if (!porCat.PODER_SIMPLE)    return res.status(400).json({ success: false, data: null, error: `${motivo}: debes cargar el Poder Simple firmado antes de enviar` });
      if (!porCat.PODER_REP_LEGAL) return res.status(400).json({ success: false, data: null, error: `${motivo}: debes cargar los Poderes del Representante Legal antes de enviar` });
    }

    const diferencias = await calcularDiferencias(f);
    const especial = await esEspecial(f);
    const apelacion = norm(req.body.apelacion) || null;
    const reenvio = f.estado === 'RECHAZADA';
    // Reinicia la cadena: limpia autorizaciones, sellos y firma previa.
    await pool.query('DELETE FROM dealer_ficha_autorizaciones WHERE id_ficha=?', [f.id]);
    const niveles = await nivelesAplicables(f);   // niveles que aplican a ESTA ficha (paramétrico)
    const baseSet = `apelacion=?, diferencias=?, part_especial=?, part_especial_por=NULL, part_especial_por_id=NULL, part_especial_fecha=NULL,
       firma_sospecha=NULL, firma_detalle=NULL, ficha_faltantes=NULL, motivo_rechazo=NULL, fecha_revision=NULL, revisor_id=NULL, revisor_nombre=NULL,
       tomada_por=NULL, tomada_por_nombre=NULL, fecha_tomada=NULL`;
    const baseVals = [apelacion, JSON.stringify(diferencias), especial ? 1 : 0];

    if (!niveles.length) {
      // Sin niveles configurados → directo a AUTORIZADA (listo para imprimir/firmar).
      await pool.query(`UPDATE dealer_fichas SET estado='AUTORIZADA', nivel_actual=NULL, ${baseSet} WHERE id=?`, [...baseVals, f.id]);
      await notificarEventoDealer('dealer_autorizada', { idsBase: [f.id_ejecutivo],
        titulo: '🖨️ Ficha autorizada — imprime y firma',
        mensaje: `Tu ficha de ${f.nombre_razon || f.rut || ''} quedó autorizada. Imprímela, hazla firmar y súbela.`,
        href: '/dealers-incorporacion/mantencion.html?tab=mias' });
    } else {
      const n0 = niveles[0];
      await pool.query(`UPDATE dealer_fichas SET estado='PEND_AUTORIZACION', nivel_actual=?, ${baseSet} WHERE id=?`, [n0.orden, ...baseVals, f.id]);
      const ids = await idsConPermiso(n0.permiso, req.usuario.id_usuario);
      await notificarEventoDealer('dealer_para_autorizar', { idsBase: ids, ejecutivo: f.id_ejecutivo,
        titulo: reenvio ? '🔁 Ficha de dealer corregida' : '🛎️ Ficha de dealer para autorizar',
        mensaje: `${f.ejecutivo_nombre || 'Un ejecutivo'} envió la ficha de ${f.nombre_razon || f.rut || ''} — nivel: ${n0.nombre}`
          + (diferencias.length ? ` · ⚠ ${diferencias.length} diferencia(s) con el sistema` : '')
          + (especial ? ' · ⭐ participación especial' : '')
          + (informes.grave ? ' · 🚨 ALERTA GRAVE: registros penales/judiciales' : ''),
        href: '/dealers-incorporacion/mantencion.html?tab=revision', clave: `dealerficha:${f.id}:rev` });
    }
    auditar({ req, accion: reenvio ? 'EDITAR' : 'CREAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: f.id,
      detalle: `${reenvio ? 'Reenvió' : 'Envió'} a autorización la ficha de ${f.nombre_razon || f.rut || ''}`, rut: f.rut });
    res.json({ success: true, data: { estado: niveles.length ? 'PEND_AUTORIZACION' : 'AUTORIZADA',
      informes: informes.resumen, alerta_grave: informes.grave }, error: null });
  } catch (e) { console.error('[fichas enviar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas/:id/autorizar — un nivel de la cadena autoriza los términos ── */
const autorizar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT * FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.estado !== 'PEND_AUTORIZACION')
      return res.status(400).json({ success: false, data: null, error: 'La ficha no está pendiente de autorización' });
    // Nivel actual de la cadena.
    const [[niv]] = await pool.query('SELECT * FROM dealer_aprob_niveles WHERE orden=? AND activo=1 ORDER BY id LIMIT 1', [f.nivel_actual]);
    if (!niv) return res.status(409).json({ success: false, data: null, error: 'El nivel de autorización ya no existe; reenvía la ficha' });
    // ¿El usuario tiene el permiso que exige este nivel?
    const esAdmin = req.usuario.perfil_nombre === 'Administrador';
    if (!esAdmin && !(await tieneFunc(req.usuario.id_usuario, niv.permiso)))
      return res.status(403).json({ success: false, data: null, error: `No tienes el permiso para autorizar el nivel "${niv.nombre}"` });

    const nombre = [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email;
    await pool.query(
      'INSERT INTO dealer_ficha_autorizaciones (id_ficha, orden, nombre_nivel, permiso, usuario_id, usuario_nombre, perfil) VALUES (?,?,?,?,?,?,?)',
      [f.id, niv.orden, niv.nombre, niv.permiso, req.usuario.id_usuario, nombre, req.usuario.perfil_nombre || null]);
    // Si este nivel es el de participación especial, sella "aprobada por XXXX".
    if (niv.condicion === 'COMISION_SOBRE_PIZARRA')
      await pool.query('UPDATE dealer_fichas SET part_especial=1, part_especial_por=?, part_especial_por_id=?, part_especial_fecha=NOW() WHERE id=?',
        [nombre, req.usuario.id_usuario, f.id]);
    await pool.query('DELETE FROM notificaciones WHERE clave=? AND leida=0', [`dealerficha:${f.id}:rev`]).catch(() => {});

    const next = await siguienteNivel(f, niv.orden);
    if (next) {
      await pool.query('UPDATE dealer_fichas SET nivel_actual=? WHERE id=?', [next.orden, f.id]);
      const ids = await idsConPermiso(next.permiso, req.usuario.id_usuario);
      await notificarEventoDealer('dealer_para_autorizar', { idsBase: ids, ejecutivo: f.id_ejecutivo,
        titulo: '🛎️ Ficha de dealer para autorizar',
        mensaje: `${f.nombre_razon || f.rut || ''} — nivel: ${next.nombre}`,
        href: '/dealers-incorporacion/mantencion.html?tab=revision', clave: `dealerficha:${f.id}:rev` });
    } else {
      await pool.query('UPDATE dealer_fichas SET estado=\'AUTORIZADA\', nivel_actual=NULL WHERE id=?', [f.id]);
      await notificarEventoDealer('dealer_autorizada', { idsBase: [f.id_ejecutivo],
        titulo: '🖨️ Ficha autorizada — imprime y firma',
        mensaje: `Tu ficha de ${f.nombre_razon || f.rut || ''} fue autorizada por todos los niveles. Imprímela, hazla firmar y súbela.`,
        href: '/dealers-incorporacion/mantencion.html?tab=mias' });
    }
    auditar({ req, accion: 'APROBAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: f.id,
      detalle: `Autorizó el nivel "${niv.nombre}" de la ficha de ${f.nombre_razon || f.rut || ''}`, rut: f.rut });
    res.json({ success: true, data: { estado: next ? 'PEND_AUTORIZACION' : 'AUTORIZADA', siguiente: next ? next.nombre : null }, error: null });
  } catch (e) { console.error('[fichas autorizar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas/:id/enviar-firmada — ficha firmada subida → vuelve al cierre ── */
const enviarFirmada = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT * FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Solo el ejecutivo que la creó puede enviarla' });
    if (f.estado !== 'AUTORIZADA')
      return res.status(400).json({ success: false, data: null, error: 'La ficha debe estar AUTORIZADA para subir la firmada' });
    if (!f.ficha_data) return res.status(400).json({ success: false, data: null, error: 'Debes subir la ficha firmada (PDF o foto) antes de enviar' });
    // Verifica la firma + compara el documento con los datos ingresados (para el analista).
    const firma = await verificarFirma(f.ficha_data, f.ficha_mime);
    const cmpTexto = await compararFichaTexto(f.ficha_data, f.ficha_mime, f);
    await pool.query(
      `UPDATE dealer_fichas SET estado='PEND_CIERRE', firma_sospecha=?, firma_detalle=?, ficha_faltantes=? WHERE id=?`,
      [firma.sospecha, firma.detalle, JSON.stringify(cmpTexto.faltantes), f.id]);
    const ids = await idsConPermiso('dealer_ficha_revisar', req.usuario.id_usuario);
    await notificarEventoDealer('dealer_firmada', { idsBase: ids, ejecutivo: f.id_ejecutivo,
      titulo: '✍️ Ficha firmada — revisar y cerrar',
      mensaje: `${f.nombre_razon || f.rut || ''}: ${f.ejecutivo_nombre || 'el ejecutivo'} subió la ficha firmada para el cierre`
        + (firma.sospecha ? ' · ⚠ posible SIN FIRMA' : '')
        + (cmpTexto.faltantes.length ? ` · ⚠ ${cmpTexto.faltantes.length} dato(s) no coinciden con el documento` : ''),
      href: '/dealers-incorporacion/mantencion.html?tab=revision', clave: `dealerficha:${f.id}:rev` });
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: f.id,
      detalle: `Subió la ficha firmada de ${f.nombre_razon || f.rut || ''} para el cierre`, rut: f.rut });
    res.json({ success: true, data: { estado: 'PEND_CIERRE' }, error: null });
  } catch (e) { console.error('[fichas enviarFirmada]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas/:id/tomar — un revisor la reclama (anula aviso al resto) ──── */
const tomar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT id, estado, tomada_por FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.estado === 'TOMADA' && f.tomada_por && f.tomada_por !== req.usuario.id_usuario)
      return res.status(409).json({ success: false, data: null, error: 'Otro analista ya está revisando esta ficha' });
    if (!['PEND_CIERRE', 'TOMADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha no está en revisión de cierre' });
    const nombre = [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email;
    await pool.query('UPDATE dealer_fichas SET estado=\'TOMADA\', tomada_por=?, tomada_por_nombre=?, fecha_tomada=NOW() WHERE id=?',
      [req.usuario.id_usuario, nombre, req.params.id]);
    // Anula el aviso del pool para los demás (el que la toma primero lo elimina al resto)
    await pool.query('DELETE FROM notificaciones WHERE clave=? AND id_usuario<>? AND leida=0',
      [`dealerficha:${f.id}:rev`, req.usuario.id_usuario]).catch(() => {});
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: f.id,
      detalle: `Tomó para revisión la ficha de dealer #${f.id}` });
    res.json({ success: true, data: { estado: 'TOMADA', tomada_por: req.usuario.id_usuario }, error: null });
  } catch (e) { console.error('[fichas tomar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* Asegura que la tabla `dealers` (donde se guardan hoy los dealers) tenga las
   columnas de la ficha. Idempotente; se ejecuta una sola vez (promesa cacheada). */
let _dealersColsReady = null;
function ensureDealersCols() {
  if (_dealersColsReady) return _dealersColsReady;
  const cols = [
    'comuna VARCHAR(120)', 'provincia VARCHAR(120)', 'region VARCHAR(120)', 'tipo_ficha VARCHAR(10)',
    'cf_nombre VARCHAR(150)', 'cf_telefono VARCHAR(40)', 'cf_email VARCHAR(150)',
    'rl_nombre VARCHAR(150)', 'rl_telefono VARCHAR(40)', 'rl_email VARCHAR(150)',
    'com_6_12 DECIMAL(5,2)', 'com_13_24 DECIMAL(5,2)', 'com_25_36 DECIMAL(5,2)', 'com_37 DECIMAL(5,2)',
    'cuenta_tipo VARCHAR(10)', 'tipo_cuenta VARCHAR(30)', 'nombre_cuenta VARCHAR(150)',
    'part_especial_por VARCHAR(200)', 'part_especial_fecha DATETIME',
  ];
  _dealersColsReady = (async () => {
    for (const c of cols) { try { await pool.query(`ALTER TABLE dealers ADD COLUMN IF NOT EXISTS ${c} NULL`); } catch (e) {} }
  })();
  return _dealersColsReady;
}

/* Crea (o ACTUALIZA si es modificación) el dealer a partir de la ficha aprobada.
   Copia el sello de participación especial (part_especial_por/fecha) al dealer.
   Devuelve {idDealer, numero, esMod}. */
async function finalizarDealer(f) {
  await ensureDealersCols();
  const partPor = f.part_especial_por || null, partFecha = f.part_especial_fecha || null;
  // MODIFICACIÓN: ACTUALIZA el dealer de origen (no crea uno nuevo; el RUT es UNIQUE). ccs_parque se preserva.
  if (f.id_dealer_origen) {
    const [[dl]] = await pool.query('SELECT id_dealer, numero FROM dealers WHERE id_dealer=?', [f.id_dealer_origen]);
    if (dl) {
      await pool.query(
        `UPDATE dealers SET rut=?, nombre_indexa=?, nombre_razon=?, tipo_ficha=?, direccion=?,
           comuna=?, provincia=?, region=?, contacto=?, telefono=?, correo=?,
           cf_nombre=?, cf_telefono=?, cf_email=?, rl_nombre=?, rl_telefono=?, rl_email=?,
           com_6_12=?, com_13_24=?, com_25_36=?, com_37=?,
           cuenta_tipo=?, tipo_cuenta=?, nombre_cuenta=?, num_cuenta=?, banco=?, rut_pago=?,
           tiene_factura=?, observaciones=?, part_especial_por=?, part_especial_fecha=? WHERE id_dealer=?`,
        [f.rut, f.nombre_fantasia || f.nombre_razon, f.nombre_razon, f.tipo, f.direccion,
         f.comuna, f.provincia, f.region, f.cc_nombre, f.cc_telefono, f.cc_email,
         f.cf_nombre, f.cf_telefono, f.cf_email, f.rl_nombre, f.rl_telefono, f.rl_email,
         f.com_6_12, f.com_13_24, f.com_25_36, f.com_37,
         f.cuenta_tipo, f.tipo_cuenta, f.nombre_cuenta, f.num_cuenta, f.banco, f.rut_cuenta,
         f.tipo_documento === 'FACTURA' ? 1 : 0, f.observaciones, partPor, partFecha, dl.id_dealer]);
      return { idDealer: dl.id_dealer, numero: dl.numero, esMod: true };
    }
  }
  // CREACIÓN: dealer nuevo con número correlativo y la info COMPLETA de la ficha.
  const [[{ maxN }]] = await pool.query('SELECT COALESCE(MAX(numero),0)+1 AS maxN FROM dealers');
  const [d] = await pool.query(
    `INSERT INTO dealers (numero, rut, nombre_indexa, nombre_razon, ccs_parque, tipo_ficha, direccion,
       comuna, provincia, region, fecha_incorporacion, contacto, telefono, correo,
       cf_nombre, cf_telefono, cf_email, rl_nombre, rl_telefono, rl_email,
       com_6_12, com_13_24, com_25_36, com_37,
       cuenta_tipo, tipo_cuenta, nombre_cuenta, num_cuenta, banco, rut_pago,
       activo, tiene_factura, observaciones, part_especial_por, part_especial_fecha)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
    [maxN, f.rut, f.nombre_fantasia || f.nombre_razon, f.nombre_razon, f.tipo, f.tipo, f.direccion,
     f.comuna, f.provincia, f.region, f.fecha_solicitud, f.cc_nombre, f.cc_telefono, f.cc_email,
     f.cf_nombre, f.cf_telefono, f.cf_email, f.rl_nombre, f.rl_telefono, f.rl_email,
     f.com_6_12, f.com_13_24, f.com_25_36, f.com_37,
     f.cuenta_tipo, f.tipo_cuenta, f.nombre_cuenta, f.num_cuenta, f.banco, f.rut_cuenta,
     f.tipo_documento === 'FACTURA' ? 1 : 0, f.observaciones, partPor, partFecha]);
  return { idDealer: d.insertId, numero: maxN, esMod: false };
}

// Aviso al ejecutivo (+ analista si lo cerró Gerencia) cuando el dealer queda creado/actualizado.
async function avisarFinalizado(f, numero, esMod, sello) {
  const avisar = new Set();
  if (f.id_ejecutivo) avisar.add(f.id_ejecutivo);
  if (sello && f.revisor_id) avisar.add(f.revisor_id);
  if (!avisar.size) return;
  await notificarEventoDealer('dealer_cerrada', { idsBase: [...avisar],
    titulo: esMod ? '✅ Dealer actualizado' : '✅ Dealer creado',
    mensaje: `${sello ? 'Participación especial de ' : 'Tu ficha de '}${f.nombre_razon || f.rut || ''} ${sello ? 'aprobada por ' + sello : 'fue aprobada'} — el dealer N°${numero} ${esMod ? 'fue actualizado' : 'ya está'} en el sistema.`,
    href: '/dealers-incorporacion/mantencion.html' });
}

/* ── POST /fichas/:id/cerrar — el analista revisa la ficha FIRMADA y cierra:
   crea/actualiza el dealer en el sistema. ────────────────────────────────── */
const cerrar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT * FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (!['PEND_CIERRE', 'TOMADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha no está en revisión de cierre' });
    if (!f.ficha_data) return res.status(400).json({ success: false, data: null, error: 'No hay ficha firmada para cerrar' });
    const { idDealer, numero, esMod } = await finalizarDealer(f);
    const nombre = [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email;
    await pool.query(
      `UPDATE dealer_fichas SET estado='APROBADA', revisor_id=?, revisor_nombre=?, fecha_revision=NOW(), motivo_rechazo=NULL, id_dealer=? WHERE id=?`,
      [req.usuario.id_usuario, nombre, idDealer, req.params.id]);
    await pool.query('DELETE FROM notificaciones WHERE clave=? AND leida=0', [`dealerficha:${f.id}:rev`]).catch(() => {});
    await avisarFinalizado(f, numero, esMod, f.part_especial_por || null);
    auditar({ req, accion: 'APROBAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: f.id,
      detalle: `Cerró la ficha de ${f.nombre_razon || f.rut || ''} → dealer N°${numero}${esMod ? ' (modificación)' : ''}`, rut: f.rut, meta: { id_dealer: idDealer, numero, modificacion: esMod } });
    res.json({ success: true, data: { estado: 'APROBADA', id_dealer: idDealer, numero, modificacion: esMod }, error: null });
  } catch (e) { console.error('[fichas cerrar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas/:id/rechazar — exige motivo y avisa al ejecutivo ─────────── */
const rechazar = async (req, res) => {
  try {
    const motivo = norm(req.body.motivo);
    if (motivo.length < 5) return res.status(400).json({ success: false, data: null, error: 'Debes indicar un motivo de rechazo válido' });
    const [[f]] = await pool.query('SELECT * FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (!['PEND_AUTORIZACION', 'PEND_CIERRE', 'TOMADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha no está en un estado que permita rechazo' });
    // Quién puede rechazar: en autorización, el permiso del nivel actual; en cierre, el analista.
    const esAdmin = req.usuario.perfil_nombre === 'Administrador';
    if (!esAdmin) {
      if (f.estado === 'PEND_AUTORIZACION') {
        const [[niv]] = await pool.query('SELECT permiso FROM dealer_aprob_niveles WHERE orden=? AND activo=1 ORDER BY id LIMIT 1', [f.nivel_actual]);
        if (!niv || !(await tieneFunc(req.usuario.id_usuario, niv.permiso)))
          return res.status(403).json({ success: false, data: null, error: 'No tienes el permiso para rechazar este nivel' });
      } else if (!(await tieneFunc(req.usuario.id_usuario, 'dealer_ficha_revisar'))) {
        return res.status(403).json({ success: false, data: null, error: 'Solo el analista de cierre puede rechazar en esta etapa' });
      }
    }
    const nombre = [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email;
    await pool.query(
      `UPDATE dealer_fichas SET estado='RECHAZADA', revisor_id=?, revisor_nombre=?, fecha_revision=NOW(), motivo_rechazo=? WHERE id=?`,
      [req.usuario.id_usuario, nombre, motivo, req.params.id]);
    await pool.query('DELETE FROM notificaciones WHERE clave=? AND leida=0', [`dealerficha:${f.id}:rev`]).catch(() => {});

    await notificarEventoDealer('dealer_rechazada', { idsBase: [f.id_ejecutivo],
      titulo: '❌ Ficha de dealer rechazada',
      mensaje: `Tu ficha de ${f.nombre_razon || f.rut || ''} fue rechazada: ${motivo}. Corrígela y reenvíala.`,
      href: '/dealers-incorporacion/mantencion.html' });
    auditar({ req, accion: 'RECHAZAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: f.id,
      detalle: `Rechazó la ficha de ${f.nombre_razon || f.rut || ''}: "${motivo}"`, rut: f.rut });
    res.json({ success: true, data: { estado: 'RECHAZADA' }, error: null });
  } catch (e) { console.error('[fichas rechazar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Archivos adjuntos (informes comerciales empresa/socios, máx 3 c/u) ───── */
async function fichaDe(id) { const [[f]] = await pool.query('SELECT id, id_ejecutivo, estado FROM dealer_fichas WHERE id=?', [id]); return f; }

const listarArchivos = async (req, res) => {
  try {
    const f = await fichaDe(req.params.id);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (!(await puedeRevisar(req)) && f.id_ejecutivo !== req.usuario.id_usuario)
      return res.status(403).json({ success: false, data: null, error: 'Sin acceso' });
    const [rows] = await pool.query('SELECT id, categoria, nombre, mime, created_at FROM dealer_ficha_archivos WHERE id_ficha=? ORDER BY id', [req.params.id]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[fichas archivos listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const subirArchivo = async (req, res) => {
  try {
    const { categoria, archivo_nombre, mime_type, archivo_data } = req.body || {};
    const cat = String(categoria || '').toUpperCase();
    if (!CATEGORIAS.includes(cat)) return res.status(400).json({ success: false, data: null, error: 'Categoría inválida' });
    if (!archivo_data) return res.status(400).json({ success: false, data: null, error: 'Falta el archivo' });
    const f = await fichaDe(req.params.id);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Sin permiso' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'No se pueden cambiar archivos en este estado' });
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM dealer_ficha_archivos WHERE id_ficha=? AND categoria=?', [req.params.id, cat]);
    if (n >= 3) return res.status(400).json({ success: false, data: null, error: 'Máximo 3 archivos por categoría' });
    const buffer = Buffer.from(archivo_data, 'base64');
    const [r] = await pool.query('INSERT INTO dealer_ficha_archivos (id_ficha, categoria, nombre, mime, data) VALUES (?,?,?,?,?)',
      [req.params.id, cat, archivo_nombre || 'archivo', mime_type || 'application/octet-stream', buffer]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Subió informe comercial (${cat}) a ficha #${req.params.id}: ${archivo_nombre || ''}` });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[fichas archivos subir]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const verArchivo = async (req, res) => {
  try {
    const [[a]] = await pool.query(
      `SELECT a.nombre, a.mime, a.data, f.id_ejecutivo FROM dealer_ficha_archivos a
         JOIN dealer_fichas f ON f.id=a.id_ficha WHERE a.id=? AND a.id_ficha=?`, [req.params.archivoId, req.params.id]);
    if (!a || !a.data) return res.status(404).json({ success: false, data: null, error: 'Sin archivo' });
    if (!(await puedeRevisar(req)) && a.id_ejecutivo !== req.usuario.id_usuario)
      return res.status(403).json({ success: false, data: null, error: 'Sin acceso' });
    auditar({ req, accion: 'VER_DOCUMENTO', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Visualizó informe comercial de ficha #${req.params.id}` });
    res.set('Content-Type', a.mime || 'application/octet-stream');
    res.set('Content-Disposition', dispFilename(a.nombre || 'archivo'));
    res.send(a.data);
  } catch (e) { console.error('[fichas archivos ver]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const eliminarArchivo = async (req, res) => {
  try {
    const f = await fichaDe(req.params.id);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Sin permiso' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'No se pueden cambiar archivos en este estado' });
    await pool.query('DELETE FROM dealer_ficha_archivos WHERE id=? AND id_ficha=?', [req.params.archivoId, req.params.id]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[fichas archivos eliminar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── DELETE /fichas/:id — eliminar borrador propio ────────────────────────── */
const eliminar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT id_ejecutivo, estado, nombre_razon FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    const esAdmin = req.usuario.perfil_nombre === 'Administrador';
    if (f.id_ejecutivo !== req.usuario.id_usuario && !esAdmin)
      return res.status(403).json({ success: false, data: null, error: 'Sin permiso' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado) && !esAdmin)
      return res.status(400).json({ success: false, data: null, error: 'Solo se pueden eliminar borradores o rechazadas' });
    await pool.query('DELETE FROM dealer_fichas WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Eliminó la ficha de dealer #${req.params.id} (${f.nombre_razon || ''})` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[fichas eliminar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /com-default — comisiones pactadas por defecto (derivadas de la pizarra) ── */
const comisionesDefault = async (req, res) => {
  try { res.json({ success: true, data: await comDefaults(), error: null }); }
  catch (e) { console.error('[fichas comDefault]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* Mapea un registro de `dealers` a los campos de la ficha (para precargar). */
function dealerAFicha(d) {
  if (!d) return null;
  return {
    id_dealer: d.id_dealer, numero: d.numero,
    rut: d.rut, nombre_razon: d.nombre_razon, nombre_fantasia: d.nombre_indexa,
    direccion: d.direccion, comuna: d.comuna || '', provincia: d.provincia || '', region: d.region || '',
    tipo: (d.tipo_ficha === 'PARQUE' || d.tipo_ficha === 'GENERAL') ? d.tipo_ficha : null,
    cc_nombre: d.contacto || '', cc_telefono: d.telefono || '', cc_email: d.correo || '',
    cf_nombre: d.cf_nombre || '', cf_telefono: d.cf_telefono || '', cf_email: d.cf_email || '',
    rl_nombre: d.rl_nombre || '', rl_telefono: d.rl_telefono || '', rl_email: d.rl_email || '',
    com_6_12: d.com_6_12, com_13_24: d.com_13_24, com_25_36: d.com_25_36, com_37: d.com_37,
    tipo_documento: d.tiene_factura ? 'FACTURA' : 'BOLETA',
    cuenta_tipo: d.cuenta_tipo || '', tipo_cuenta: d.tipo_cuenta || '', nombre_cuenta: d.nombre_cuenta || '',
    banco: d.banco || '', rut_cuenta: d.rut_pago || '', num_cuenta: d.num_cuenta || '',
  };
}

/* ── GET /dealer-buscar — ¿el dealer ya existe? (RUT exacto y/o nombre) ────────
 * Permite que la ficha pase de "Creación" a "Modificación de Dealer" y precargue
 * los datos actuales (dealer importado INDEXA o creado por ficha). ─────────── */
const dealerBuscar = async (req, res) => {
  try {
    const rut = req.query.rut ? normRut(req.query.rut) : null;
    const q = norm(req.query.q);
    let exacto = null, resultados = [];
    if (rut && rut.length >= 7) {
      const [rows] = await pool.query('SELECT * FROM dealers');
      exacto = dealerAFicha(rows.find(r => normRut(r.rut) === rut));
    }
    if (q && q.length >= 2) {
      const like = '%' + q.toLowerCase() + '%';
      const [rows] = await pool.query(
        `SELECT id_dealer, numero, rut, nombre_razon, nombre_indexa, ccs_parque, comuna
           FROM dealers
          WHERE LOWER(nombre_razon) LIKE ? OR LOWER(nombre_indexa) LIKE ? OR LOWER(rut) LIKE ?
          ORDER BY numero LIMIT 12`, [like, like, like]);
      resultados = rows.map(r => ({ id_dealer: r.id_dealer, numero: r.numero, rut: r.rut,
        nombre: r.nombre_razon || r.nombre_indexa, parque: r.ccs_parque || '', comuna: r.comuna || '' }));
    }
    res.json({ success: true, data: { exacto, resultados }, error: null });
  } catch (e) { console.error('[dealerBuscar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Niveles de aprobación — mantenedor paramétrico (gated dealer_aprob_config) ── */
const CONDICIONES = ['SIEMPRE', 'COMISION_SOBRE_PIZARRA', 'DEPOSITO_MODIFICADO'];
const nivelesListar = async (req, res) => {
  try {
    const [niveles] = await pool.query('SELECT id, orden, nombre, condicion, permiso, activo FROM dealer_aprob_niveles ORDER BY orden, id');
    const [permisos] = await pool.query("SELECT codigo, nombre FROM funcionalidades WHERE id_modulo=370001 AND codigo<>'dealer_inc_ver' ORDER BY nombre");
    res.json({ success: true, data: { niveles, permisos, condiciones: CONDICIONES }, error: null });
  } catch (e) { console.error('[niveles listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const nivelGuardar = async (req, res) => {
  try {
    const { id } = req.params;
    const orden = parseInt(req.body.orden) || 1;
    const nombre = norm(req.body.nombre);
    const condicion = CONDICIONES.includes(req.body.condicion) ? req.body.condicion : 'SIEMPRE';
    const permiso = norm(req.body.permiso);
    const activo = req.body.activo ? 1 : 0;
    if (!nombre)  return res.status(400).json({ success: false, data: null, error: 'Nombre requerido' });
    if (!permiso) return res.status(400).json({ success: false, data: null, error: 'Permiso requerido' });
    if (id) await pool.query('UPDATE dealer_aprob_niveles SET orden=?, nombre=?, condicion=?, permiso=?, activo=? WHERE id=?', [orden, nombre, condicion, permiso, activo, id]);
    else     await pool.query('INSERT INTO dealer_aprob_niveles (orden, nombre, condicion, permiso, activo) VALUES (?,?,?,?,?)', [orden, nombre, condicion, permiso, activo]);
    auditar({ req, accion: id ? 'EDITAR' : 'CREAR', modulo: 'dealers', entidad: 'dealer_aprob_nivel', entidad_id: id || null, detalle: `${id ? 'Editó' : 'Creó'} el nivel de aprobación "${nombre}"`, meta: req.body });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[niveles guardar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const nivelEliminar = async (req, res) => {
  try {
    await pool.query('DELETE FROM dealer_aprob_niveles WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'dealers', entidad: 'dealer_aprob_nivel', entidad_id: req.params.id, detalle: `Eliminó el nivel de aprobación #${req.params.id}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[niveles eliminar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { ejecutivos, comisionesDefault, dealerBuscar, listar, obtener, crear, editar, subirFicha, verFicha, enviar, autorizar, enviarFirmada, tomar, cerrar, rechazar, eliminar,
  listarArchivos, subirArchivo, verArchivo, eliminarArchivo, nivelesListar, nivelGuardar, nivelEliminar, getAlertasConfig, setAlertasConfig };
