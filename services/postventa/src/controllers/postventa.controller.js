'use strict';
const pool = require('../../../../shared/config/database');

/* ── Migración ───────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_seguimiento (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        id_credito    INT NOT NULL,
        num_op        VARCHAR(30),
        financiera    VARCHAR(60),
        rut_dealer    VARCHAR(20),
        nombre_dealer VARCHAR(200),
        ejecutivo     VARCHAR(150),
        fecha_otorgado DATE,
        saldo_precio  BIGINT,
        comision      BIGINT,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_credito (id_credito),
        INDEX idx_financiera (financiera)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_etapas (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_seguimiento INT NOT NULL,
        track          ENUM('SALDO','COMISION') NOT NULL,
        etapa          VARCHAR(60) NOT NULL,
        usuario        VARCHAR(150),
        fecha          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_etapa (id_seguimiento, track, etapa)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_config (
        clave VARCHAR(50) PRIMARY KEY,
        valor TEXT NOT NULL
      )`);
    // Mapeo etapa → estado por defecto (editable en Mantenedores Post Venta)
    const DEF_SALDO = [
      { etapa:'FUNDANTES PENDIENTES', estado:'PENDIENTE' },
      { etapa:'FUNDANTES RECIBIDOS',  estado:'PENDIENTE' },
      { etapa:'FUNDANTES ENVIADOS',   estado:'PENDIENTE' },
      { etapa:'LIBERADO A PAGO',      estado:'PARA PAGO' },
      { etapa:'FONDOS RECIBIDOS',     estado:'PARA PAGO' },
      { etapa:'ORDEN DE PAGO EMITIDA',estado:'PARA PAGO' },
      { etapa:'SALDO PRECIO PAGADO',  estado:'PAGADO' },
    ];
    const DEF_COM = [
      { etapa:'COMISION A PAGAR',     estado:'PENDIENTE' },
      { etapa:'CARTOLA EMITIDA',      estado:'PENDIENTE' },
      { etapa:'CARTOLA APROBADA',     estado:'PENDIENTE' },
      { etapa:'CARTOLA ENVIADA',      estado:'PENDIENTE' },
      { etapa:'FACTURA RECIBIDA',     estado:'PARA PAGO' },
      { etapa:'ORDEN DE PAGO EMITIDA',estado:'PARA PAGO' },
      { etapa:'COMISION PAGADA',      estado:'PAGADO' },
    ];
    await pool.query('INSERT IGNORE INTO postventa_config (clave, valor) VALUES (?,?),(?,?)',
      ['etapas_saldo', JSON.stringify(DEF_SALDO), 'etapas_comision', JSON.stringify(DEF_COM)]);
    console.log('[postventa] tablas OK');
  } catch (e) { console.error('[postventa migration]', e.message); }
})();

const loginDe = u => (u?.nombre ? (u.nombre + ' ' + (u.apellido || '')).trim() : u?.email) || 'Sistema';

/* ── POST /api/postventa/sync — incluye los otorgados nuevos ─────── */
const sync = async (req, res) => {
  try {
    const [r1] = await pool.query(`
      INSERT INTO postventa_seguimiento
        (id_credito, num_op, financiera, nombre_dealer, ejecutivo, fecha_otorgado, saldo_precio, comision)
      SELECT c.id, c.num_op, c.financiera, c.automotora, c.ejecutivo,
             DATE(c.fecha_otorgado), c.saldo_precio, c.comdea_real
      FROM creditos c
      WHERE c.fecha_otorgado IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM postventa_seguimiento s WHERE s.id_credito = c.id)
    `);
    // Etapas "Sistema" automáticas para los nuevos
    await pool.query(`
      INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
      SELECT s.id, 'SALDO', 'FUNDANTES PENDIENTES', 'Sistema', COALESCE(s.fecha_otorgado, NOW())
      FROM postventa_seguimiento s
      WHERE NOT EXISTS (SELECT 1 FROM postventa_etapas e
        WHERE e.id_seguimiento = s.id AND e.track='SALDO' AND e.etapa='FUNDANTES PENDIENTES')`);
    await pool.query(`
      INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
      SELECT s.id, 'COMISION', 'COMISION A PAGAR', 'Sistema', COALESCE(s.fecha_otorgado, NOW())
      FROM postventa_seguimiento s
      WHERE NOT EXISTS (SELECT 1 FROM postventa_etapas e
        WHERE e.id_seguimiento = s.id AND e.track='COMISION' AND e.etapa='COMISION A PAGAR')`);
    res.json({ success: true, data: { nuevos: r1.affectedRows }, error: null });
  } catch (e) {
    console.error('[postventa sync]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa — seguimientos + etapas marcadas ─────────── */
const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM postventa_seguimiento ORDER BY fecha_otorgado DESC, id DESC LIMIT 1000');
    const [etapas] = await pool.query(
      `SELECT id_seguimiento, track, etapa, usuario, fecha FROM postventa_etapas
       WHERE id_seguimiento IN (SELECT id FROM postventa_seguimiento)`);
    const map = {};
    etapas.forEach(e => (map[e.id_seguimiento] = map[e.id_seguimiento] || []).push(e));
    rows.forEach(r => r.etapas = map[r.id] || []);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[postventa getAll]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── PUT /api/postventa/:id/etapa { track, etapa, marcar } ───────── */
const ETAPAS_SISTEMA = ['FUNDANTES PENDIENTES', 'COMISION A PAGAR'];
const setEtapa = async (req, res) => {
  try {
    const { track, etapa, marcar } = req.body;
    if (!['SALDO','COMISION'].includes(track) || !etapa)
      return res.status(400).json({ success: false, data: null, error: 'track y etapa requeridos' });
    if (ETAPAS_SISTEMA.includes(etapa))
      return res.status(400).json({ success: false, data: null, error: 'Etapa de sistema — no editable' });
    if (marcar) {
      await pool.query(
        `INSERT INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE usuario = VALUES(usuario), fecha = NOW()`,
        [req.params.id, track, etapa, loginDe(req.usuario)]);
    } else {
      await pool.query(
        'DELETE FROM postventa_etapas WHERE id_seguimiento = ? AND track = ? AND etapa = ?',
        [req.params.id, track, etapa]);
    }
    res.json({ success: true, data: { id: Number(req.params.id), etapa, marcado: !!marcar, usuario: loginDe(req.usuario) }, error: null });
  } catch (e) {
    console.error('[postventa etapa]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Config (mantenedor etapa → estado) ──────────────────────────── */
const getConfig = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM postventa_config');
    const out = {};
    rows.forEach(r => { try { out[r.clave] = JSON.parse(r.valor); } catch (_) {} });
    res.json({ success: true, data: out, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
const setConfig = async (req, res) => {
  try {
    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ success: false, data: null, error: 'valor requerido' });
    await pool.query(
      `INSERT INTO postventa_config (clave, valor) VALUES (?,?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
      [req.params.clave, JSON.stringify(valor)]);
    res.json({ success: true, data: { clave: req.params.clave }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/marcar-historico — marca pre-2026 como totalmente pagado ── */
const marcarHistorico = async (req, res) => {
  try {
    const [segs] = await pool.query(
      `SELECT id FROM postventa_seguimiento WHERE fecha_otorgado < '2026-01-01'`
    );
    if (!segs.length) return res.json({ success: true, data: { marcados: 0 }, error: null });

    const etapasSaldo   = ['FUNDANTES PENDIENTES','FUNDANTES RECIBIDOS','FUNDANTES ENVIADOS','LIBERADO A PAGO','FONDOS RECIBIDOS','ORDEN DE PAGO EMITIDA','SALDO PRECIO PAGADO'];
    const etapasComision = ['COMISION A PAGAR','CARTOLA EMITIDA','CARTOLA APROBADA','CARTOLA ENVIADA','FACTURA RECIBIDA','ORDEN DE PAGO EMITIDA','COMISION PAGADA'];
    const fecha = '2025-12-31 23:59:59';
    const vals = [];
    for (const s of segs) {
      for (const e of etapasSaldo)    vals.push([s.id, 'SALDO',    e, 'Sistema', fecha]);
      for (const e of etapasComision) vals.push([s.id, 'COMISION', e, 'Sistema', fecha]);
    }
    await pool.query(
      `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha) VALUES ?`,
      [vals]
    );
    res.json({ success: true, data: { marcados: segs.length }, error: null });
  } catch (e) {
    console.error('[postventa marcarHistorico]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { sync, getAll, setEtapa, getConfig, setConfig, marcarHistorico };
