'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Plan Liquidez — Hoja de Liquidación mensual + cadena de aprobación.
   Se genera con las comisiones del mes (cartolas enviadas = venta del mes de cada
   dealer), calcula con el motor único el descuento/aumento y el pago, y pasa por:
     Nivel 1  Jefe / Gerente Comercial  (aprobar o modificar)  — SLA 48h param
     Nivel 2  Gerente General           (aprobar)              — SLA 48h param
     Nivel 3  Gerente de Finanzas        (toma conocimiento, no bloquea)
   Vencido el SLA → se da por aprobada y avanza. Aprobada → habilita la ODP (paso 3).
   ──────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { liquidar } = require('../../../../shared/liquidez-core');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const { emitirCorrelativo } = require('../../../../shared/ordenes-pago');

const NIVELES_SEED = [
  { nivel: 1, nombre: 'Jefe / Gerente Comercial', tipo: 'APRUEBA',      func: 'liquidez_aprob_n1',        sla_horas: 48, alerta: 1 },
  { nivel: 2, nombre: 'Gerente General',           tipo: 'APRUEBA',      func: 'liquidez_aprob_n2',        sla_horas: 48, alerta: 1 },
  { nivel: 3, nombre: 'Gerente de Finanzas',       tipo: 'CONOCIMIENTO', func: 'liquidez_n3_conocimiento', sla_horas: 0,  alerta: 1 },
];

/* ── Migración ─────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('hojas', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_liquidez_hojas (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        periodo       VARCHAR(7)   NOT NULL,
        estado        VARCHAR(20)  NOT NULL DEFAULT 'BORRADOR',
        nivel_actual  TINYINT      NOT NULL DEFAULT 0,
        n1_estado     VARCHAR(12)  NULL, n1_por INT NULL, n1_nombre VARCHAR(200) NULL, n1_at DATETIME NULL, n1_vence DATETIME NULL,
        n2_estado     VARCHAR(12)  NULL, n2_por INT NULL, n2_nombre VARCHAR(200) NULL, n2_at DATETIME NULL, n2_vence DATETIME NULL,
        n3_estado     VARCHAR(12)  NULL, n3_por INT NULL, n3_nombre VARCHAR(200) NULL, n3_at DATETIME NULL,
        generada_por  INT          NULL, generada_por_nombre VARCHAR(200) NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_periodo (periodo)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[dlz_hojas migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_liquidez_hoja_lineas (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        id_hoja         INT            NOT NULL,
        id_plan         INT            NOT NULL,
        id_dealer       INT            NOT NULL,
        rut_dealer      VARCHAR(20)    NULL,
        nombre_dealer   VARCHAR(200)   NULL,
        comision        DECIMAL(14,2)  NOT NULL DEFAULT 0,
        deuda_anterior  DECIMAL(14,2)  NOT NULL DEFAULT 0,
        tope            DECIMAL(14,2)  NOT NULL DEFAULT 0,
        adelanto_obj    DECIMAL(14,2)  NOT NULL DEFAULT 0,
        descuento       DECIMAL(14,2)  NOT NULL DEFAULT 0,
        pago_neto       DECIMAL(14,2)  NOT NULL DEFAULT 0,
        modificada      TINYINT(1)     NOT NULL DEFAULT 0,
        comision_mod    DECIMAL(14,2)  NULL,
        adelanto_mod    DECIMAL(14,2)  NULL,
        descuento_mod   DECIMAL(14,2)  NULL,
        pago_mod        DECIMAL(14,2)  NULL,
        motivo          VARCHAR(400)   NULL,
        motivo_modificacion VARCHAR(400) NULL,
        estado_odp      VARCHAR(20)    NOT NULL DEFAULT 'PENDIENTE',
        id_odp_descuento INT           NULL,
        id_odp_aumento   INT           NULL,
        created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_hoja (id_hoja)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[dlz_hoja_lineas migration]', e.message); }

  // Columnas de enlace con la ODP (números formateados para mostrar).
  try {
    await pool.query(`ALTER TABLE dealer_liquidez_hoja_lineas ADD COLUMN IF NOT EXISTS odp_num_desc VARCHAR(30) NULL`);
    await pool.query(`ALTER TABLE dealer_liquidez_hoja_lineas ADD COLUMN IF NOT EXISTS odp_num_aum VARCHAR(30) NULL`);
  } catch (e) { console.error('[dlz_hoja_lineas alter odp]', e.message); }
  // Enlace inverso en la ODP general → línea de la hoja (para el hook al pagar).
  try {
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS liquidez_linea_id INT NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS liquidez_tipo VARCHAR(8) NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS liquidez_a DECIMAL(14,2) NULL`);
  } catch (e) { console.error('[ordenes_pago alter liquidez]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_liquidez_niveles (
        nivel      TINYINT      PRIMARY KEY,
        nombre     VARCHAR(120) NOT NULL,
        tipo       VARCHAR(15)  NOT NULL DEFAULT 'APRUEBA',
        func       VARCHAR(60)  NOT NULL,
        sla_horas  INT          NOT NULL DEFAULT 48,
        alerta     TINYINT(1)   NOT NULL DEFAULT 1
      )`);
    for (const n of NIVELES_SEED) {
      await pool.query(
        `INSERT IGNORE INTO dealer_liquidez_niveles (nivel, nombre, tipo, func, sla_horas, alerta) VALUES (?,?,?,?,?,?)`,
        [n.nivel, n.nombre, n.tipo, n.func, n.sla_horas, n.alerta]);
    }
  } catch (e) { console.error('[dlz_niveles migration]', e.message); }

  // Permisos de la cadena (acciones, href null) bajo el módulo Dealers 370001.
  try {
    const funcs = [
      ['Plan Liquidez — generar/gestionar hoja', 'liquidez_hoja_gestionar'],
      ['Plan Liquidez — aprobar Nivel 1 (Jefe/Gerente Comercial)', 'liquidez_aprob_n1'],
      ['Plan Liquidez — aprobar Nivel 2 (Gerente General)', 'liquidez_aprob_n2'],
      ['Plan Liquidez — conocimiento Nivel 3 (Gerente de Finanzas)', 'liquidez_n3_conocimiento'],
    ];
    const idFunc = {};
    for (const [nombre, codigo] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (370001,?,?,NULL,NULL)', [nombre, codigo]);
      idFunc[codigo] = r.insertId;
    }
    // Seed por NOMBRE de perfil (paramétrico: editable luego en Perfiles).
    const porPerfil = {
      liquidez_hoja_gestionar:  ['Administrador', 'Jefe Comercial', 'Gerente Comercial'],
      liquidez_aprob_n1:        ['Administrador', 'Jefe Comercial', 'Gerente Comercial'],
      liquidez_aprob_n2:        ['Administrador', 'Gerente General'],
      liquidez_n3_conocimiento: ['Administrador', 'Gerente de Finanzas'],
    };
    for (const [codigo, perfiles] of Object.entries(porPerfil)) {
      const idf = idFunc[codigo]; if (!idf) continue;
      for (const nombrePerfil of perfiles) {
        const [[p]] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre=? LIMIT 1', [nombrePerfil]);
        if (!p) continue;
        const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [p.id_perfil, idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [p.id_perfil, idf]);
      }
    }
    console.log('[dealers-liquidez] hojas: permisos cadena registrados');
  } catch (e) { console.error('[dlz hojas permisos]', e.message); }
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */
const num = v => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return isNaN(n) ? 0 : n; };
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
const periodoOk = p => /^\d{4}-\d{2}$/.test(String(p || ''));

async function nivelesCfg() {
  const [rows] = await pool.query('SELECT * FROM dealer_liquidez_niveles ORDER BY nivel');
  const map = {}; rows.forEach(r => map[r.nivel] = r);
  return map;
}
function motivoDe(C, D, A, desc) {
  const f = n => '$' + new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Math.round(n));
  if (desc > 0) return `Baja de adelanto: la comisión del mes (${f(C)}) es menor que el adelanto vigente (${f(D)}); se descuenta ${f(desc)} y la deuda baja a ${f(A)}.`;
  if (desc < 0) return `Aumento de adelanto: la comisión subió; se entrega ${f(-desc)} adicional para llevar el adelanto a ${f(A)}.`;
  return `Sin cambio en el adelanto: la comisión (${f(C)}) mantiene la deuda en ${f(A)}.`;
}
// Pool de usuarios a avisar para un nivel: Administradores + quien tenga su permiso, activos.
async function idsPorFunc(func) {
  const [rows] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE p.nombre='Administrador' AND u.estado='activo'
     UNION
     SELECT u.id_usuario FROM usuarios u
       JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil
       JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
      WHERE f.codigo=? AND pp.habilitado=1 AND u.estado='activo'`, [func]);
  return rows.map(r => r.id_usuario);
}
// Alerta (campana) al nivel indicado, respetando su flag `alerta`.
async function alertarNivel(nivel, hoja) {
  try {
    const niv = await nivelesCfg();
    const cfg = niv[nivel]; if (!cfg || !cfg.alerta) return;
    const ids = await idsPorFunc(cfg.func); if (!ids.length) return;
    const textos = {
      1: { t: '🛎️ Hoja de Liquidación para revisar', m: `La Hoja de Liquidación ${hoja.periodo} está lista para tu revisión (Nivel 1 — Comercial).` },
      2: { t: '🛎️ Hoja de Liquidación — aprobación', m: `La Hoja ${hoja.periodo} fue aprobada en Nivel 1; requiere tu aprobación (Gerencia General). Tienes 48h.` },
      3: { t: 'ℹ️ Hoja de Liquidación aprobada', m: `La Hoja ${hoja.periodo} quedó aprobada; toma conocimiento (Finanzas). Habilitada para Orden de Pago.` },
    }[nivel];
    await notificar(ids, {
      tipo: 'LIQUIDEZ_HOJA', titulo: textos.t, mensaje: textos.m,
      href: '/dealers-liquidez/hojas/?id=' + hoja.id,
      prioridad: nivel === 3 ? 'normal' : 'alta', sonar: nivel === 3 ? 0 : 1, son_tipo: 'dingdong',
      clave: 'liquidez_hoja_' + hoja.id + '_n' + nivel,
    });
  } catch (e) { console.error('[liquidez alertarNivel]', e.message); }
}

// Valores efectivos de una línea (los modificados mandan).
function efectivo(l) {
  return l.modificada
    ? { comision: +l.comision_mod, adelanto: +l.adelanto_mod, descuento: +l.descuento_mod, pago: +l.pago_mod }
    : { comision: +l.comision, adelanto: +l.adelanto_obj, descuento: +l.descuento, pago: +l.pago_neto };
}

/* ── Listar / obtener ──────────────────────────────────────────────────────── */
const listarHojas = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT h.*, (SELECT COUNT(*) FROM dealer_liquidez_hoja_lineas WHERE id_hoja=h.id) AS n_lineas
         FROM dealer_liquidez_hojas h ORDER BY periodo DESC`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[hojas listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const obtenerHoja = async (req, res) => {
  try {
    const [[h]] = await pool.query('SELECT * FROM dealer_liquidez_hojas WHERE id=?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, data: null, error: 'Hoja no encontrada' });
    const [lineas] = await pool.query('SELECT * FROM dealer_liquidez_hoja_lineas WHERE id_hoja=? ORDER BY nombre_dealer', [req.params.id]);
    const niveles = await nivelesCfg();
    res.json({ success: true, data: { ...h, lineas, niveles: Object.values(niveles) }, error: null });
  } catch (e) { console.error('[hojas obtener]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Generar hoja del periodo ──────────────────────────────────────────────── */
const generarHoja = async (req, res) => {
  try {
    const periodo = String((req.body || {}).periodo || '').trim();
    if (!periodoOk(periodo)) return res.status(400).json({ success: false, data: null, error: 'Periodo inválido (YYYY-MM)' });
    const [[ex]] = await pool.query('SELECT id, estado FROM dealer_liquidez_hojas WHERE periodo=?', [periodo]);
    if (ex && ex.estado !== 'BORRADOR') return res.status(409).json({ success: false, data: null, error: 'Ya existe una hoja en proceso para ese periodo' });

    let idHoja = ex?.id;
    if (idHoja) { await pool.query('DELETE FROM dealer_liquidez_hoja_lineas WHERE id_hoja=?', [idHoja]); }
    else {
      const [r] = await pool.query(
        `INSERT INTO dealer_liquidez_hojas (periodo, estado, generada_por, generada_por_nombre) VALUES (?,'BORRADOR',?,?)`,
        [periodo, req.usuario?.id_usuario || null, nombreDe(req.usuario)]);
      idHoja = r.insertId;
    }

    const [planes] = await pool.query(`SELECT id, id_dealer, rut_dealer, nombre_dealer, tope, deuda_actual FROM dealer_liquidez_planes WHERE estado='ACTIVO'`);
    let n = 0;
    for (const p of planes) {
      const [[cm]] = await pool.query('SELECT COALESCE(SUM(total_bruto),0) c FROM cartolas_enviadas WHERE mes=? AND rut_dealer=?', [periodo, p.rut_dealer]);
      const C = num(cm.c), D = num(p.deuda_actual), T = num(p.tope);
      const r = liquidar(C, D, T);
      await pool.query(
        `INSERT INTO dealer_liquidez_hoja_lineas
           (id_hoja, id_plan, id_dealer, rut_dealer, nombre_dealer, comision, deuda_anterior, tope, adelanto_obj, descuento, pago_neto, motivo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [idHoja, p.id, p.id_dealer, p.rut_dealer, p.nombre_dealer, C, D, T, r.adelantoObjetivo, r.descuento, r.pagoNeto, motivoDe(C, D, r.adelantoObjetivo, r.descuento)]);
      n++;
    }
    auditar({ req, accion: 'CREAR', modulo: 'dealers', entidad: 'dealer_liquidez_hoja', entidad_id: idHoja,
      detalle: `Generó Hoja de Liquidación ${periodo} (${n} dealers)` });
    res.status(201).json({ success: true, data: { id: idHoja, lineas: n }, error: null });
  } catch (e) { console.error('[hojas generar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Enviar a la cadena (BORRADOR → Nivel 1) ───────────────────────────────── */
const enviarHoja = async (req, res) => {
  try {
    const [[h]] = await pool.query('SELECT * FROM dealer_liquidez_hojas WHERE id=?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, data: null, error: 'Hoja no encontrada' });
    if (h.estado !== 'BORRADOR') return res.status(400).json({ success: false, data: null, error: 'La hoja ya fue enviada' });
    const [[n]] = await pool.query('SELECT COUNT(*) c FROM dealer_liquidez_hoja_lineas WHERE id_hoja=?', [req.params.id]);
    if (!n.c) return res.status(400).json({ success: false, data: null, error: 'La hoja no tiene líneas' });
    const niv = await nivelesCfg();
    await pool.query(
      `UPDATE dealer_liquidez_hojas SET estado='PENDIENTE_N1', nivel_actual=1, n1_estado='PENDIENTE',
         n1_vence=DATE_ADD(NOW(), INTERVAL ? HOUR) WHERE id=?`, [niv[1]?.sla_horas || 48, req.params.id]);
    await alertarNivel(1, { id: Number(req.params.id), periodo: h.periodo });
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_liquidez_hoja', entidad_id: req.params.id,
      detalle: `Envió la Hoja ${h.periodo} a aprobación (Nivel 1)` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[hojas enviar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Modificar una línea (solo Nivel 1, hoja en PENDIENTE_N1) ───────────────── */
const modificarLinea = async (req, res) => {
  try {
    const [[h]] = await pool.query('SELECT estado FROM dealer_liquidez_hojas WHERE id=?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, data: null, error: 'Hoja no encontrada' });
    if (h.estado !== 'PENDIENTE_N1') return res.status(400).json({ success: false, data: null, error: 'Solo se puede modificar en Nivel 1' });
    if (!(await tieneFunc(req.usuario.id_usuario, 'liquidez_aprob_n1'))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso de Nivel 1' });
    const [[l]] = await pool.query('SELECT * FROM dealer_liquidez_hoja_lineas WHERE id=? AND id_hoja=?', [req.params.lid, req.params.id]);
    if (!l) return res.status(404).json({ success: false, data: null, error: 'Línea no encontrada' });

    const b = req.body || {};
    const C = b.comision_mod != null ? num(b.comision_mod) : num(l.comision);
    const r = liquidar(C, num(l.deuda_anterior), num(l.tope)); // motor único: recalcula con la comisión modificada
    await pool.query(
      `UPDATE dealer_liquidez_hoja_lineas SET modificada=1, comision_mod=?, adelanto_mod=?, descuento_mod=?, pago_mod=?, motivo_modificacion=? WHERE id=?`,
      [C, r.adelantoObjetivo, r.descuento, r.pagoNeto, String(b.motivo_modificacion || '').slice(0, 400) || null, l.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_liquidez_hoja', entidad_id: req.params.id,
      detalle: `Modificó línea dealer ${l.nombre_dealer} en Hoja #${req.params.id}: comisión → ${C}` });
    res.json({ success: true, data: { ok: true, calculo: r }, error: null });
  } catch (e) { console.error('[hojas modificar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Aprobar el nivel actual ───────────────────────────────────────────────── */
async function avanzar(idHoja, nivelAprobado, idUsuario, nombre, modo /* 'APROBADO' | 'AUTO' */, periodo) {
  const niv = await nivelesCfg();
  if (nivelAprobado === 1) {
    await pool.query(
      `UPDATE dealer_liquidez_hojas SET n1_estado=?, n1_por=?, n1_nombre=?, n1_at=NOW(),
         estado='PENDIENTE_N2', nivel_actual=2, n2_estado='PENDIENTE', n2_vence=DATE_ADD(NOW(), INTERVAL ? HOUR) WHERE id=?`,
      [modo, idUsuario, nombre, niv[2]?.sla_horas || 48, idHoja]);
    await alertarNivel(2, { id: idHoja, periodo });
  } else if (nivelAprobado === 2) {
    // N2 aprobado → APROBADA (habilita ODP) y pasa a Finanzas para conocimiento.
    await pool.query(
      `UPDATE dealer_liquidez_hojas SET n2_estado=?, n2_por=?, n2_nombre=?, n2_at=NOW(),
         estado='APROBADA', nivel_actual=3, n3_estado='PENDIENTE' WHERE id=?`,
      [modo, idUsuario, nombre, idHoja]);
    await alertarNivel(3, { id: idHoja, periodo });
  }
}
const aprobarHoja = async (req, res) => {
  try {
    const [[h]] = await pool.query('SELECT * FROM dealer_liquidez_hojas WHERE id=?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, data: null, error: 'Hoja no encontrada' });
    const niv = await nivelesCfg();
    if (h.estado === 'PENDIENTE_N1') {
      if (!(await tieneFunc(req.usuario.id_usuario, niv[1].func))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso de Nivel 1' });
      await avanzar(h.id, 1, req.usuario.id_usuario, nombreDe(req.usuario), 'APROBADO', h.periodo);
    } else if (h.estado === 'PENDIENTE_N2') {
      if (!(await tieneFunc(req.usuario.id_usuario, niv[2].func))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso de Nivel 2' });
      await avanzar(h.id, 2, req.usuario.id_usuario, nombreDe(req.usuario), 'APROBADO', h.periodo);
    } else {
      return res.status(400).json({ success: false, data: null, error: 'La hoja no está pendiente de aprobación' });
    }
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_liquidez_hoja', entidad_id: h.id,
      detalle: `Aprobó la Hoja ${h.periodo} (estado previo ${h.estado})` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[hojas aprobar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Nivel 3: toma conocimiento (no bloquea) ───────────────────────────────── */
const conocimientoHoja = async (req, res) => {
  try {
    const [[h]] = await pool.query('SELECT * FROM dealer_liquidez_hojas WHERE id=?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, data: null, error: 'Hoja no encontrada' });
    const niv = await nivelesCfg();
    if (!(await tieneFunc(req.usuario.id_usuario, niv[3].func))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso de Nivel 3' });
    await pool.query(`UPDATE dealer_liquidez_hojas SET n3_estado='VISTO', n3_por=?, n3_nombre=?, n3_at=NOW() WHERE id=?`,
      [req.usuario.id_usuario, nombreDe(req.usuario), h.id]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[hojas conocimiento]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Tick de SLA: auto-aprueba niveles vencidos (cada 30 min) ──────────────── */
let _slaCorriendo = false;
async function tickSLA() {
  if (_slaCorriendo) return; _slaCorriendo = true;
  try {
    const [n1] = await pool.query(`SELECT id, periodo FROM dealer_liquidez_hojas WHERE estado='PENDIENTE_N1' AND n1_vence IS NOT NULL AND n1_vence < NOW()`);
    for (const h of n1) { await avanzar(h.id, 1, null, 'Automático (SLA 48h)', 'AUTO', h.periodo); console.log(`[liquidez SLA] Hoja ${h.periodo} auto-aprobada Nivel 1`); }
    const [n2] = await pool.query(`SELECT id, periodo FROM dealer_liquidez_hojas WHERE estado='PENDIENTE_N2' AND n2_vence IS NOT NULL AND n2_vence < NOW()`);
    for (const h of n2) { await avanzar(h.id, 2, null, 'Automático (SLA 48h)', 'AUTO', h.periodo); console.log(`[liquidez SLA] Hoja ${h.periodo} auto-aprobada Nivel 2`); }
  } catch (e) { console.error('[liquidez tickSLA]', e.message); }
  finally { _slaCorriendo = false; }
}
setInterval(tickSLA, 30 * 60 * 1000);
setTimeout(tickSLA, 20 * 1000); // un primer chequeo al arrancar

/* ── Paso 3: emisión de Órdenes de Pago y abono al pagarse ─────────────────── */
const fmtPesos = n => '$' + new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));

// Crea una ODP GENERAL (aparece y se paga en el módulo de Órdenes de Pago) ligada a la línea.
// tipo: 'LIQ' = mueve la deuda al pagarse; 'COM' = solo paga la comisión (sin tocar deuda).
async function crearOdpLiquidez({ linea, monto, tipo, A, concepto, req }) {
  monto = Math.round(Number(monto) || 0);
  const [r] = await pool.query(
    `INSERT INTO ordenes_pago
       (id_proveedor, proveedor_nombre, proveedor_rut, concepto, tipo_documento, monto, monto_neto,
        tratamiento, fecha_emision, estado, id_usuario, usuario_nombre, liquidez_linea_id, liquidez_tipo, liquidez_a)
     VALUES (NULL,?,?,?,'Factura',?,?,'EXENTO',CURDATE(),'EMITIDA',?,?,?,?,?)`,
    [linea.nombre_dealer, linea.rut_dealer, concepto, monto, monto,
     req.usuario?.id_usuario || null, nombreDe(req.usuario), linea.id, tipo, A]);
  const op = r.insertId;
  const { numero } = await emitirCorrelativo({
    origen: 'GENERAL', origen_id: op, concepto, monto,
    id_usuario: req.usuario?.id_usuario || null, usuario_nombre: nombreDe(req.usuario) });
  await pool.query('UPDATE ordenes_pago SET numero=? WHERE id=?', [numero, op]);
  return { id: op, numero };
}

// Postea el movimiento de liquidación y deja la deuda del plan en A. Idempotente por línea.
async function aplicarMovimiento(lineaId, idOdp) {
  const [[l]] = await pool.query('SELECT * FROM dealer_liquidez_hoja_lineas WHERE id=?', [lineaId]);
  if (!l || l.estado_odp === 'PAGADA') return;
  const [[h]] = await pool.query('SELECT periodo FROM dealer_liquidez_hojas WHERE id=?', [l.id_hoja]);
  const [[p]] = await pool.query('SELECT deuda_actual FROM dealer_liquidez_planes WHERE id=?', [l.id_plan]);
  if (!p) return;
  const e = efectivo(l);
  const D = Number(p.deuda_actual), A = e.adelanto;
  await pool.query(
    `INSERT INTO dealer_liquidez_movimientos
       (id_plan, id_dealer, fecha, periodo, tipo, comision, adelanto_obj, descuento, pago_neto, saldo_anterior, saldo_nuevo, glosa, id_odp)
     VALUES (?,?,CURDATE(),?,'LIQUIDACION',?,?,?,?,?,?,?,?)`,
    [l.id_plan, l.id_dealer, h?.periodo || null, e.comision, A, e.descuento, e.pago, D, A,
     `Liquidación ${h?.periodo || ''}`, idOdp || null]);
  await pool.query('UPDATE dealer_liquidez_planes SET deuda_actual=? WHERE id=?', [A, l.id_plan]);
  await pool.query("UPDATE dealer_liquidez_hoja_lineas SET estado_odp='PAGADA' WHERE id=?", [lineaId]);
}

// POST /hojas/:id/emitir-odp — emite las ODP de una hoja APROBADA.
const emitirOdp = async (req, res) => {
  try {
    const [[h]] = await pool.query('SELECT * FROM dealer_liquidez_hojas WHERE id=?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, data: null, error: 'Hoja no encontrada' });
    if (h.estado !== 'APROBADA') return res.status(400).json({ success: false, data: null, error: 'La hoja debe estar aprobada para emitir las ODP' });
    const [lineas] = await pool.query('SELECT * FROM dealer_liquidez_hoja_lineas WHERE id_hoja=?', [req.params.id]);
    let creadas = 0, aplicadas = 0;
    for (const l of lineas) {
      if (l.id_odp_descuento || l.estado_odp === 'PAGADA') continue; // ya emitida/aplicada
      const e = efectivo(l);
      if (e.descuento >= 0) {
        if (e.pago > 0) {
          const o = await crearOdpLiquidez({ linea: l, monto: e.pago, tipo: 'LIQ', A: e.adelanto, req,
            concepto: `Comisión ${h.periodo} Plan Liquidez — ${l.nombre_dealer}` + (e.descuento > 0 ? ` (descuento adelanto ${fmtPesos(e.descuento)})` : '') });
          await pool.query("UPDATE dealer_liquidez_hoja_lineas SET id_odp_descuento=?, odp_num_desc=?, estado_odp='ODP_EMITIDA' WHERE id=?", [o.id, o.numero, l.id]);
          creadas++;
        } else {
          // Pago $0: no hay ODP; la comisión completa abona la deuda → se aplica de inmediato.
          await aplicarMovimiento(l.id, null); aplicadas++;
        }
      } else {
        // Aumento: ODP de comisión (no mueve deuda) + 2ª ODP por el adelanto extra (mueve deuda).
        const oc = await crearOdpLiquidez({ linea: l, monto: e.comision, tipo: 'COM', A: e.adelanto, req,
          concepto: `Comisión ${h.periodo} — ${l.nombre_dealer}` });
        const oa = await crearOdpLiquidez({ linea: l, monto: -e.descuento, tipo: 'LIQ', A: e.adelanto, req,
          concepto: `Aumento de adelanto Plan Liquidez ${h.periodo} — ${l.nombre_dealer}` });
        await pool.query("UPDATE dealer_liquidez_hoja_lineas SET id_odp_descuento=?, odp_num_desc=?, id_odp_aumento=?, odp_num_aum=?, estado_odp='ODP_EMITIDA' WHERE id=?",
          [oc.id, oc.numero, oa.id, oa.numero, l.id]);
        creadas += 2;
      }
    }
    auditar({ req, accion: 'CREAR', modulo: 'ordenes-pago', entidad: 'dealer_liquidez_hoja', entidad_id: h.id,
      detalle: `Emitió ODP de la Hoja ${h.periodo} (${creadas} órdenes, ${aplicadas} sin pago)` });
    res.json({ success: true, data: { creadas, aplicadas }, error: null });
  } catch (e) { console.error('[hojas emitirOdp]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// Hook llamado por ordenes-pago al pagarse una ODP GENERAL. idOrdenPago = ordenes_pago.id.
async function onOdpPagada(idOrdenPago) {
  try {
    const [[op]] = await pool.query('SELECT liquidez_linea_id, liquidez_tipo FROM ordenes_pago WHERE id=?', [idOrdenPago]);
    if (!op || !op.liquidez_linea_id) return;          // no es una ODP de Plan Liquidez
    if (op.liquidez_tipo !== 'LIQ') return;            // la ODP de comisión (COM) no mueve la deuda
    await aplicarMovimiento(op.liquidez_linea_id, idOrdenPago);
  } catch (e) { console.error('[liquidez onOdpPagada]', e.message); }
}

module.exports = {
  listarHojas, obtenerHoja, generarHoja, enviarHoja, modificarLinea, aprobarHoja, conocimientoHoja,
  emitirOdp, onOdpPagada, tickSLA,
};
