'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   INCORPORAR A CARTOLA LAS OTORGADAS SIN CARTA

   Problema que resuelve: la cartola se construye desde `cartas_aprobacion`, así que
   una operación que entró por CARGA MASIVA (sin carta) nunca genera su movimiento y
   el dealer no ve —ni factura— esa comisión. En julio 2026 eran 29 ops por $13,5 MM.

   Flujo (definido con Pato, 30-07-2026):
     1. El operador ve las otorgadas del mes sin carta y sin cartola, con los datos
        precargados y editables: dealer, parque/calle, saldo precio, plazo y comisión.
     2. El sistema calcula la comisión que CORRESPONDE con el motor único
        (AF_COM_DEALER: tabla del dealer si la tiene, si no la pizarra).
     3. Si lo confirmado CALZA con el motor → se incorpora de inmediato.
        Si DIFIERE → queda PENDIENTE y debe aprobarla un analista de crédito,
        mismo espíritu que las excepciones de la carta de aprobación.
     4. Al aplicar: los valores confirmados se guardan EN EL CRÉDITO (fuente única)
        y recién ahí se crea el movimiento de cartola.

   La comisión NUNCA se toma de un archivo externo: la calcula nuestro motor.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const AVISOS = require('../../../../shared/avisos');
const COM = require('../../../../api-gateway/public/js/comision-dealer');

const MOV = 'COMISION';

/* Avisos (campanita). Destinatarios finales configurables en Mantenedores → Avisos;
   nacen apuntando a quienes tienen la funcionalidad respectiva. */
AVISOS.registrarAviso({
  evento: 'cartola_incorp_pendiente', modulo: 'Cartolas',
  nombre: 'Incorporación a cartola pendiente de aprobación',
  descripcion: 'Una operación otorgada sin carta se confirmó con una comisión distinta a la que corresponde. Avisa al ANALISTA DE CRÉDITO que debe aprobarla o rechazarla.',
  base_func: 'cartola_incorp_aprobar', prioridad: 'alta', sonido_tipo: 'dingdong',
});
AVISOS.registrarAviso({
  evento: 'cartola_incorp_resuelta', modulo: 'Cartolas',
  nombre: 'Incorporación a cartola aprobada o rechazada',
  descripcion: 'El analista de crédito resolvió una incorporación. Avisa a quien la solicitó (analista de operaciones) y al pool de ambas funcionalidades.',
  base_func: 'cartola_incorporar', prioridad: 'normal', sonido_tipo: 'campana',
});

/* ── Migración: tabla de solicitudes + permisos ──────────────────────────── */
require('../../../../shared/migrate').enFila('cartola-incorporaciones', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS cartola_incorporaciones (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      id_credito     INT NOT NULL,
      num_op         INT NULL,
      mes            CHAR(7) NOT NULL,
      nombre_dealer  VARCHAR(200) NULL,
      rut_dealer     VARCHAR(20)  NULL,
      es_parque      TINYINT NOT NULL DEFAULT 0,
      saldo_precio   BIGINT NULL,
      plazo          INT NULL,
      comision       BIGINT NULL,
      comision_motor BIGINT NULL,
      excepciones    JSON NULL,
      estado         VARCHAR(12) NOT NULL DEFAULT 'PENDIENTE',   -- PENDIENTE | APROBADA | RECHAZADA
      comentario     VARCHAR(600) NULL,
      solicitado_por INT NULL, solicitado_nombre VARCHAR(160) NULL,
      solicitado_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      resuelto_por   INT NULL, resuelto_nombre VARCHAR(160) NULL, resuelto_at DATETIME NULL,
      INDEX ix_estado (estado), INDEX ix_mes (mes), INDEX ix_credito (id_credito))`);

    // Permisos: incorporar (operador de cartolas) y aprobar (analista de crédito).
    // El de aprobar se siembra a quienes hoy revisan cartas (pool de analistas).
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre LIKE 'Post Venta%' OR ruta LIKE '/postventa%' LIMIT 1");
    const idMod = mod ? mod.id_modulo : null;
    for (const [nombre, codigo] of [
      ['Cartolas — incorporar otorgadas sin carta', 'cartola_incorporar'],
      ['Cartolas — aprobar incorporación con excepción', 'cartola_incorp_aprobar'],
    ]) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (!ex && idMod) await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,NULL,NULL)', [idMod, nombre, codigo]);
    }
    // aprobar → a los perfiles que ya revisan cartas de aprobación (analistas de crédito)
    await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
      SELECT pp.id_perfil, (SELECT id_funcionalidad FROM funcionalidades WHERE codigo='cartola_incorp_aprobar'), 1
        FROM permisos_perfil pp JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
       WHERE f.codigo='aprob_revisar' AND pp.habilitado=1`);
    // incorporar → a quienes ya operan cartolas
    await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
      SELECT pp.id_perfil, (SELECT id_funcionalidad FROM funcionalidades WHERE codigo='cartola_incorporar'), 1
        FROM permisos_perfil pp JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
       WHERE f.codigo='aprob_cartolas' AND pp.habilitado=1`);
  } catch (e) { console.error('[cartola-incorporaciones migration]', e.message); }
});

/* ── Comisión que CORRESPONDE, por el motor único ─────────────────────────── */
async function comisionMotor({ rut_dealer, es_parque, saldo_precio, plazo, nombre_dealer }) {
  try {
    // parametros_credito es CLAVE/VALOR (no columnas): se arma el mapa igual que
    // calcular-operacion.js, si no la pizarra llega vacía y el % queda en 0.
    const [prm] = await pool.query('SELECT clave, valor FROM parametros_credito').catch(() => [[]]);
    const pizarra = {};
    (prm || []).forEach(r => { pizarra[r.clave] = parseFloat(r.valor); });
    // Tabla pactada del dealer: mismas columnas y misma normalización de RUT que el motor
    const rutNorm = String(rut_dealer || '').replace(/[.\-\s]/g, '').toUpperCase();
    let dealerTabla = null;
    if (rutNorm) {
      const [dr] = await pool.query(
        `SELECT com_6_12, com_13_24, com_25_36, com_37, com_parque_6_12, com_parque_13_24, com_parque_25_36, com_parque_37
           FROM dealers WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ? LIMIT 1`, [rutNorm])
        .catch(() => [[]]);
      dealerTabla = (dr && dr[0]) || null;
    }
    let parqData = null;
    if (es_parque && nombre_dealer) {
      const [pr] = await pool.query(
        'SELECT arriendo, comision_pct FROM parques_comisiones WHERE activo=1 AND UPPER(TRIM(nombre)) = UPPER(TRIM(?)) LIMIT 1',
        [nombre_dealer]).catch(() => [[]]);
      parqData = pr[0] || null;
    }
    const cd = COM.comisionDealer(
      { saldo: saldo_precio, plazo, esParque: !!es_parque },
      { dealerTabla, parqData, pizarra });
    return cd ? cd.comdea_real : null;
  } catch (e) { console.error('[comisionMotor]', e.message); return null; }
}

/* ── Excepciones (mismo espíritu que la carta de aprobación) ──────────────── */
function detectarExcepciones(f, motor) {
  const ex = [];
  const com = Number(f.comision) || 0;
  if (motor != null && com !== motor) {
    const dif = com - motor;
    ex.push({ tipo: 'COMISIÓN', mensaje: `La comisión confirmada ($${com.toLocaleString('es-CL')}) difiere de la que corresponde según el motor ($${motor.toLocaleString('es-CL')}): ${dif > 0 ? '+' : ''}$${dif.toLocaleString('es-CL')}. Requiere aprobación de un analista de crédito.` });
  }
  if (!(Number(f.saldo_precio) > 0)) ex.push({ tipo: 'SALDO PRECIO', mensaje: 'El saldo precio es cero o está vacío.' });
  if (!(Number(f.plazo) > 0))        ex.push({ tipo: 'PLAZO', mensaje: 'El plazo es cero o está vacío.' });
  if (!String(f.nombre_dealer || '').trim()) ex.push({ tipo: 'DEALER', mensaje: 'Falta el nombre del dealer.' });
  return ex;
}

/* GET /api/cartolas/sin-carta?mes=YYYY-MM → otorgadas del mes sin carta ni cartola */
const sinCarta = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
    if (!mes) return res.status(400).json({ success: false, data: null, error: 'Indica el mes (YYYY-MM).' });
    const [rows] = await pool.query(`
      SELECT c.id AS id_credito, c.num_op, c.id_financiera, c.automotora AS nombre_dealer, c.rut_dealer,
             c.tipo_ubicacion, c.saldo_precio, c.plazo, c.comdea_real AS comision, c.ejecutivo, c.financiera,
             (SELECT COUNT(*) FROM cartola_incorporaciones i WHERE i.id_credito = c.id AND i.estado <> 'RECHAZADA') AS ya_solicitada
        FROM creditos c
       WHERE c.estado_credito = 'OTORGADO'
         AND DATE_FORMAT(c.fecha_otorgado, '%Y-%m') = ?
         AND c.financiera IN ('AUTOFIN','UNIDAD DE CREDITO')
         AND NOT EXISTS (SELECT 1 FROM cartas_aprobacion ca WHERE ca.id_financiera = c.num_op)
         AND NOT EXISTS (SELECT 1 FROM cartolas_movimientos m WHERE m.num_op = c.id_financiera)
       ORDER BY c.num_op`, [mes]);
    /* Parque o calle: la carga masiva NO trae ese dato confiable, así que el default
       sale de la FICHA DEL DEALER (dealers.ccs_parque), que es un registro mantenido.
       El crédito solo sirve de respaldo. Si ambos discrepan se marca para que el
       operador lo confirme a ojo — igual siempre es editable en pantalla. */
    for (const r of rows) {
      const credParque = /parque/i.test(String(r.tipo_ubicacion || '')) ? 1 : 0;
      let fichaParque = null;
      const rn = String(r.rut_dealer || '').replace(/[.\-\s]/g, '').toUpperCase();
      if (rn) {
        const [d] = await pool.query(
          "SELECT ccs_parque FROM dealers WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ? LIMIT 1", [rn]).catch(() => [[]]);
        if (d && d[0] && String(d[0].ccs_parque || '').trim())
          fichaParque = /parque/i.test(String(d[0].ccs_parque)) ? 1 : 0;
      }
      r.es_parque   = fichaParque != null ? fichaParque : credParque;
      r.origen_ubic = fichaParque != null ? 'ficha del dealer' : (r.tipo_ubicacion ? 'carga masiva' : 'sin dato');
      r.ubic_discrepa = (fichaParque != null && fichaParque !== credParque) ? 1 : 0;
      r.comision_motor = await comisionMotor(r);
    }
    res.json({ success: true, data: { mes, items: rows }, error: null });
  } catch (e) { console.error('[cartolas sinCarta]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /api/cartolas/comision-motor?... → cuánto DEBERÍA ser con los valores editados.
   Lo calcula el servidor con el motor único: el navegador nunca replica la fórmula. */
const comisionQueCorresponde = async (req, res) => {
  try {
    const q = req.query;
    const monto = await comisionMotor({
      rut_dealer: q.rut_dealer, nombre_dealer: q.nombre_dealer,
      es_parque: q.es_parque === '1' || q.es_parque === 'true',
      saldo_precio: Number(q.saldo_precio) || 0, plazo: Number(q.plazo) || 0,
    });
    res.json({ success: true, data: { comision_motor: monto }, error: null });
  } catch (e) { console.error('[cartolas comisionMotor]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* Aplica una incorporación: guarda los valores EN EL CRÉDITO y crea el movimiento */
async function aplicar(f, usuario) {
  const [[c]] = await pool.query('SELECT id, num_op, id_financiera, ejecutivo, id_cliente FROM creditos WHERE id = ?', [f.id_credito]);
  if (!c) throw new Error('Crédito no encontrado');
  // 1) Fuente única: lo confirmado queda en la operación
  await pool.query(`UPDATE creditos SET automotora = ?, rut_dealer = ?, tipo_ubicacion = ?, saldo_precio = ?,
                    plazo = ?, comdea_real = ?, updated_at = NOW() WHERE id = ?`,
    [f.nombre_dealer || null, f.rut_dealer || null, f.es_parque ? 'PARQUE' : 'CALLE',
     Number(f.saldo_precio) || 0, Number(f.plazo) || 0, Number(f.comision) || 0, c.id]);
  // 2) Movimiento de cartola (id_carta NULL = incorporada sin carta)
  // nombre_completo es la columna poblada en `clientes`; los campos separados
  // (nombres/apellido_paterno) están vacíos en buena parte de la base.
  const [[cli]] = await pool.query(
    `SELECT rut, COALESCE(NULLIF(nombre_completo,''),
              NULLIF(TRIM(CONCAT(COALESCE(nombres,''),' ',COALESCE(apellido_paterno,''))),'')) AS nom
       FROM clientes WHERE id_cliente = ?`, [c.id_cliente]).catch(() => [[{}]]);
  await pool.query(
    `INSERT INTO cartolas_movimientos (mes, id_carta, num_op, movimiento, rut_dealer, nombre_dealer,
       ejecutivo, nombre_cliente, rut_cliente, saldo, comision, estado_comision, observaciones)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?)`,
    [f.mes, c.id_financiera, MOV, f.rut_dealer || null, f.nombre_dealer || null, c.ejecutivo || null,
     (cli && cli.nom) || null, (cli && cli.rut) || null, Number(f.saldo_precio) || 0, Number(f.comision) || 0,
     'Incorporada sin carta de aprobación por ' + (usuario || '—')]);
}

/* POST /api/cartolas/incorporar → filas confirmadas. Sin excepción entra directo;
   con excepción queda PENDIENTE de un analista de crédito. */
const incorporar = async (req, res) => {
  try {
    const filas = Array.isArray(req.body.filas) ? req.body.filas : [];
    if (!filas.length) return res.status(400).json({ success: false, data: null, error: 'No hay operaciones que incorporar.' });
    const quien = req.usuario.nombre || req.usuario.email || '—';
    let directas = 0, pendientes = 0;
    for (const f of filas) {
      if (!f.id_credito || !/^\d{4}-\d{2}$/.test(f.mes || '')) continue;
      const motor = await comisionMotor(f);
      const ex = detectarExcepciones(f, motor);
      const estado = ex.length ? 'PENDIENTE' : 'APROBADA';
      const [r] = await pool.query(
        `INSERT INTO cartola_incorporaciones (id_credito, num_op, mes, nombre_dealer, rut_dealer, es_parque,
           saldo_precio, plazo, comision, comision_motor, excepciones, estado, solicitado_por, solicitado_nombre,
           resuelto_por, resuelto_nombre, resuelto_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [f.id_credito, f.num_op || null, f.mes, f.nombre_dealer || null, f.rut_dealer || null, f.es_parque ? 1 : 0,
         Number(f.saldo_precio) || 0, Number(f.plazo) || 0, Number(f.comision) || 0, motor,
         ex.length ? JSON.stringify(ex) : null, estado, req.usuario.id_usuario, quien,
         ex.length ? null : req.usuario.id_usuario, ex.length ? null : quien, ex.length ? null : new Date()]);
      if (!ex.length) { await aplicar(f, quien); directas++; }
      else {
        pendientes++;
        // Campanita al ANALISTA DE CRÉDITO: tiene algo que aprobar
        AVISOS.avisar('cartola_incorp_pendiente', {
          titulo: '⏰ Incorporación a cartola por aprobar — OP ' + (f.num_op || ''),
          mensaje: `${quien} confirmó la OP ${f.num_op} (${f.nombre_dealer || 's/dealer'}) con comisión $${Number(f.comision || 0).toLocaleString('es-CL')}, cuando corresponde $${Number(motor || 0).toLocaleString('es-CL')}. Requiere tu aprobación.`,
          href: '/aprobaciones/?tab=cartolas',
          // clave del hecho: al resolverse se retira de la campanita de todo el pool.
          clave: 'cartola_incorp:' + r.insertId,
        }, { excluir: [req.usuario.id_usuario] }).catch(() => {});
      }
      auditar({ req, accion: 'CREAR', modulo: 'cartolas', entidad: 'cartola_incorporacion', entidad_id: r.insertId,
        detalle: `OP ${f.num_op}: ${estado === 'APROBADA' ? 'incorporada a cartola' : 'PENDIENTE de analista (' + ex.map(x => x.tipo).join(', ') + ')'}` });
    }
    res.json({ success: true, data: { directas, pendientes }, error: null });
  } catch (e) { console.error('[cartolas incorporar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* GET /api/cartolas/incorporaciones?estado=PENDIENTE */
const listarIncorporaciones = async (req, res) => {
  try {
    const estado = ['PENDIENTE', 'APROBADA', 'RECHAZADA'].includes(req.query.estado) ? req.query.estado : 'PENDIENTE';
    const [rows] = await pool.query('SELECT * FROM cartola_incorporaciones WHERE estado = ? ORDER BY solicitado_at DESC LIMIT 300', [estado]);
    rows.forEach(r => { try { r.excepciones = r.excepciones ? (typeof r.excepciones === 'string' ? JSON.parse(r.excepciones) : r.excepciones) : []; } catch (_) { r.excepciones = []; } });
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[cartolas listarIncorp]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/cartolas/incorporaciones/:id { accion:'APROBAR'|'RECHAZAR', comentario } — analista */
const resolver = async (req, res) => {
  try {
    const [[i]] = await pool.query("SELECT * FROM cartola_incorporaciones WHERE id = ? AND estado = 'PENDIENTE'", [req.params.id]);
    if (!i) return res.status(404).json({ success: false, data: null, error: 'Solicitud no encontrada o ya resuelta.' });
    // Segregación de funciones: quien pidió la excepción NO puede aprobársela.
    // (Analista de Operaciones tiene ambos permisos por herencia de aprob_revisar).
    if (Number(i.solicitado_por) === Number(req.usuario.id_usuario))
      return res.status(403).json({ success: false, data: null, error: 'No puedes aprobar una incorporación que solicitaste tú. Debe resolverla otro analista.' });
    const aprobar = String(req.body.accion || '').toUpperCase() === 'APROBAR';
    const comentario = String(req.body.comentario || '').trim();
    if (!comentario) return res.status(400).json({ success: false, data: null, error: 'El comentario es obligatorio: la comisión difiere de la que corresponde.' });
    const quien = req.usuario.nombre || req.usuario.email || '—';
    if (aprobar) await aplicar(i, quien);
    await pool.query("UPDATE cartola_incorporaciones SET estado = ?, comentario = ?, resuelto_por = ?, resuelto_nombre = ?, resuelto_at = NOW() WHERE id = ?",
      [aprobar ? 'APROBADA' : 'RECHAZADA', comentario, req.usuario.id_usuario, quien, i.id]);
    AVISOS.retirar('cartola_incorp:' + i.id).catch(() => {});   // ya no está pendiente para nadie
    auditar({ req, accion: 'EDITAR', modulo: 'cartolas', entidad: 'cartola_incorporacion', entidad_id: i.id,
      detalle: `OP ${i.num_op} ${aprobar ? 'APROBADA' : 'RECHAZADA'} por analista: ${comentario}` });
    // Campanita: a quien la solicitó (analista de operaciones) + ambos pools.
    // `extra` asegura al solicitante aunque el mantenedor de Avisos lo excluya.
    AVISOS.avisar('cartola_incorp_resuelta', {
      titulo: (aprobar ? '✅ Incorporación APROBADA' : '🔴 Incorporación RECHAZADA') + ' — OP ' + (i.num_op || ''),
      mensaje: `${quien} ${aprobar ? 'aprobó' : 'rechazó'} la incorporación de la OP ${i.num_op} (${i.nombre_dealer || 's/dealer'}), comisión $${Number(i.comision || 0).toLocaleString('es-CL')}.`
        + ` Motivo: ${comentario}` + (aprobar ? ' La operación ya está en la cartola.' : ' NO entró a la cartola.'),
      href: '/aprobaciones/?tab=cartolas',
    }, { excluir: [req.usuario.id_usuario], extra: i.solicitado_por ? [i.solicitado_por] : [] }).catch(() => {});
    res.json({ success: true, data: { estado: aprobar ? 'APROBADA' : 'RECHAZADA' }, error: null });
  } catch (e) { console.error('[cartolas resolver]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { sinCarta, incorporar, listarIncorporaciones, resolver, comisionQueCorresponde };
