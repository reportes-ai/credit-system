'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Plan Liquidez — anticipo de comisiones a dealers Super Partner.
   Cabecera del plan por dealer + documentos (contrato/pagaré) + cuenta corriente.
   El cálculo vive en el motor único shared/liquidez-core.js (máxima #1).
   ──────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { liquidar } = require('../../../../shared/liquidez-core');

/* ── Migración (idempotente, en fila) ──────────────────────────────────────── */
require('../../../../shared/migrate').enFila('liquidez', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_liquidez_planes (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        id_dealer         INT            NOT NULL,
        rut_dealer        VARCHAR(20)    NULL,
        nombre_dealer     VARCHAR(200)   NULL,
        tope              DECIMAL(14,2)  NOT NULL DEFAULT 5000000,
        anticipo_inicial  DECIMAL(14,2)  NOT NULL DEFAULT 0,
        deuda_actual      DECIMAL(14,2)  NOT NULL DEFAULT 0,
        condiciones       TEXT           NULL,
        socios            JSON           NULL,
        estado            VARCHAR(20)    NOT NULL DEFAULT 'ACTIVO',
        fecha_inicio      DATE           NULL,
        observaciones     TEXT           NULL,
        creado_por        INT            NULL,
        creado_por_nombre VARCHAR(200)   NULL,
        created_at        DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_dealer (id_dealer),
        INDEX idx_estado (estado)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[dealer_liquidez_planes migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_liquidez_documentos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        id_plan     INT          NOT NULL,
        categoria   VARCHAR(20)  NOT NULL,
        nombre      VARCHAR(200) NULL,
        mime        VARCHAR(100) NULL,
        data        LONGBLOB     NULL,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_plan (id_plan)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[dealer_liquidez_documentos migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_liquidez_movimientos (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        id_plan         INT            NOT NULL,
        id_dealer       INT            NOT NULL,
        fecha           DATE           NOT NULL,
        periodo         VARCHAR(7)     NULL,
        tipo            VARCHAR(30)    NOT NULL,
        comision        DECIMAL(14,2)  NULL,
        adelanto_obj    DECIMAL(14,2)  NULL,
        descuento       DECIMAL(14,2)  NULL,
        pago_neto       DECIMAL(14,2)  NULL,
        saldo_anterior  DECIMAL(14,2)  NOT NULL DEFAULT 0,
        saldo_nuevo     DECIMAL(14,2)  NOT NULL DEFAULT 0,
        glosa           VARCHAR(300)   NULL,
        id_odp          INT            NULL,
        estado          VARCHAR(20)    NOT NULL DEFAULT 'CONFIRMADO',
        creado_por      INT            NULL,
        created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_plan (id_plan),
        INDEX idx_dealer (id_dealer)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[dealer_liquidez_movimientos migration]', e.message); }
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */
const num = v => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return isNaN(n) ? 0 : n; };
const norm = s => String(s || '').trim();
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
const esAdmin = req => req.usuario?.perfil_nombre === 'Administrador';
function parseSocios(raw) {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 5).map(s => ({
    rut: norm(s.rut), nombre: norm(s.nombre),
    apellido_paterno: norm(s.apellido_paterno), apellido_materno: norm(s.apellido_materno),
    pct_participacion: s.pct_participacion != null ? num(s.pct_participacion) : null,
    es_aval: s.es_aval !== false,
  })).filter(s => s.rut || s.nombre);
}

/* ── Dealers disponibles para el selector (activos) ────────────────────────── */
const dealersDisponibles = async (req, res) => {
  try {
    const q = norm(req.query.q);
    const ql = q.toLowerCase();
    const qd = q.replace(/\D/g, '');           // solo dígitos del RUT buscado
    const params = [];
    // No se filtra por `activo`: muchos dealers vigentes están con activo=0 en la base;
    // se muestran todos y se marca el inactivo para que el usuario distinga.
    let where = '';
    if (q.length >= 2) {
      const cond = ['LOWER(nombre_razon) LIKE ?', 'LOWER(nombre_indexa) LIKE ?'];
      const l = '%' + ql + '%'; params.push(l, l);
      if (qd.length >= 3) {                     // RUT sin puntos ni guion (compara dígito a dígito)
        cond.push("REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','') LIKE ?");
        params.push('%' + qd + '%');
      }
      where = 'WHERE (' + cond.join(' OR ') + ')';
    }
    const [rows] = await pool.query(
      `SELECT id_dealer, numero, rut, nombre_razon, nombre_indexa, ccs_parque, comuna, activo
         FROM dealers ${where} ORDER BY activo DESC, numero LIMIT 30`, params);
    res.json({ success: true, data: rows.map(r => ({
      id_dealer: r.id_dealer, numero: r.numero, rut: r.rut, activo: r.activo,
      nombre: r.nombre_razon || r.nombre_indexa || '', parque: r.ccs_parque || '', comuna: r.comuna || '',
    })), error: null });
  } catch (e) { console.error('[liquidez dealersDisponibles]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Listar planes ─────────────────────────────────────────────────────────── */
const listar = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, id_dealer, rut_dealer, nombre_dealer, tope, anticipo_inicial, deuda_actual,
              estado, fecha_inicio, created_at, updated_at
         FROM dealer_liquidez_planes ORDER BY estado='ACTIVO' DESC, nombre_dealer ASC`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[liquidez listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Obtener un plan (cabecera + documentos meta + movimientos) ────────────── */
const obtener = async (req, res) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM dealer_liquidez_planes WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Plan no encontrado' });
    if (p.socios && typeof p.socios === 'string') { try { p.socios = JSON.parse(p.socios); } catch { p.socios = []; } }
    const [docs] = await pool.query('SELECT id, categoria, nombre, mime, created_at FROM dealer_liquidez_documentos WHERE id_plan=? ORDER BY created_at', [req.params.id]);
    const [movs] = await pool.query('SELECT id, fecha, periodo, tipo, comision, adelanto_obj, descuento, pago_neto, saldo_anterior, saldo_nuevo, glosa, id_odp, estado, created_at FROM dealer_liquidez_movimientos WHERE id_plan=? ORDER BY fecha DESC, id DESC', [req.params.id]);
    res.json({ success: true, data: { ...p, documentos: docs, movimientos: movs }, error: null });
  } catch (e) { console.error('[liquidez obtener]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Crear plan ────────────────────────────────────────────────────────────── */
const crear = async (req, res) => {
  try {
    const b = req.body || {};
    const id_dealer = num(b.id_dealer);
    if (!id_dealer) return res.status(400).json({ success: false, data: null, error: 'Falta el dealer' });
    const [[d]] = await pool.query('SELECT id_dealer, rut, nombre_razon, nombre_indexa FROM dealers WHERE id_dealer=?', [id_dealer]);
    if (!d) return res.status(400).json({ success: false, data: null, error: 'Dealer inexistente' });
    const [[dup]] = await pool.query('SELECT id FROM dealer_liquidez_planes WHERE id_dealer=?', [id_dealer]);
    if (dup) return res.status(409).json({ success: false, data: null, error: 'El dealer ya tiene un plan; edítalo en vez de crear otro' });

    const tope = num(b.tope) || 5000000;
    const anticipo = num(b.anticipo_inicial);
    if (anticipo > tope) return res.status(400).json({ success: false, data: null, error: 'El anticipo inicial no puede superar el tope' });
    const socios = parseSocios(b.socios);
    const fecha = b.fecha_inicio || null;

    const [r] = await pool.query(
      `INSERT INTO dealer_liquidez_planes
         (id_dealer, rut_dealer, nombre_dealer, tope, anticipo_inicial, deuda_actual, condiciones, socios, estado, fecha_inicio, observaciones, creado_por, creado_por_nombre)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id_dealer, d.rut, d.nombre_razon || d.nombre_indexa, tope, anticipo, anticipo,
       norm(b.condiciones) || null, JSON.stringify(socios), norm(b.estado) || 'ACTIVO',
       fecha, norm(b.observaciones) || null, req.usuario?.id_usuario || null, nombreDe(req.usuario)]);
    const idPlan = r.insertId;

    if (anticipo > 0) {
      await pool.query(
        `INSERT INTO dealer_liquidez_movimientos
           (id_plan, id_dealer, fecha, tipo, descuento, pago_neto, saldo_anterior, saldo_nuevo, glosa, creado_por)
         VALUES (?,?,COALESCE(?,CURDATE()),'ANTICIPO_INICIAL',?,?,?,?,?,?)`,
        [idPlan, id_dealer, fecha, -anticipo, anticipo, 0, anticipo, 'Entrega del anticipo inicial', req.usuario?.id_usuario || null]);
    }

    auditar({ req, accion: 'CREAR', modulo: 'dealers', entidad: 'dealer_liquidez_plan', entidad_id: idPlan,
      detalle: `Creó Plan Liquidez dealer #${id_dealer} (tope $${tope}, anticipo $${anticipo})` });
    res.status(201).json({ success: true, data: { id: idPlan }, error: null });
  } catch (e) { console.error('[liquidez crear]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Editar cabecera (NO la deuda — eso solo por movimientos) ──────────────── */
const editar = async (req, res) => {
  try {
    const b = req.body || {};
    const [[p]] = await pool.query('SELECT * FROM dealer_liquidez_planes WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Plan no encontrado' });
    const tope = b.tope != null ? num(b.tope) : Number(p.tope);
    const socios = b.socios != null ? parseSocios(b.socios) : null;
    await pool.query(
      `UPDATE dealer_liquidez_planes SET tope=?, condiciones=?, estado=?, fecha_inicio=?, observaciones=?${socios ? ', socios=?' : ''} WHERE id=?`,
      socios
        ? [tope, norm(b.condiciones) || null, norm(b.estado) || p.estado, b.fecha_inicio || p.fecha_inicio, norm(b.observaciones) || null, JSON.stringify(socios), req.params.id]
        : [tope, norm(b.condiciones) || null, norm(b.estado) || p.estado, b.fecha_inicio || p.fecha_inicio, norm(b.observaciones) || null, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_liquidez_plan', entidad_id: req.params.id,
      detalle: `Editó Plan Liquidez #${req.params.id}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[liquidez editar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Documentos (contrato / pagaré) — base64 → LONGBLOB ────────────────────── */
const DOC_CATS = ['CONTRATO', 'PAGARE', 'OTRO'];
const subirDocumento = async (req, res) => {
  try {
    const { categoria, archivo_nombre, mime_type, archivo_data } = req.body || {};
    const cat = String(categoria || '').toUpperCase();
    if (!DOC_CATS.includes(cat)) return res.status(400).json({ success: false, data: null, error: 'Categoría inválida' });
    if (!archivo_data) return res.status(400).json({ success: false, data: null, error: 'Falta el archivo' });
    const [[p]] = await pool.query('SELECT id FROM dealer_liquidez_planes WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Plan no encontrado' });
    const buffer = Buffer.from(archivo_data, 'base64');
    const [r] = await pool.query(
      'INSERT INTO dealer_liquidez_documentos (id_plan, categoria, nombre, mime, data) VALUES (?,?,?,?,?)',
      [req.params.id, cat, archivo_nombre || (cat.toLowerCase() + '.pdf'), mime_type || 'application/octet-stream', buffer]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_liquidez_plan', entidad_id: req.params.id,
      detalle: `Subió documento ${cat} al Plan Liquidez #${req.params.id}` });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[liquidez subirDocumento]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const verDocumento = async (req, res) => {
  try {
    const [[doc]] = await pool.query('SELECT nombre, mime, data FROM dealer_liquidez_documentos WHERE id=? AND id_plan=?', [req.params.docId, req.params.id]);
    if (!doc || !doc.data) return res.status(404).send('No encontrado');
    res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${doc.nombre || 'documento'}"`);
    res.send(doc.data);
  } catch (e) { console.error('[liquidez verDocumento]', e.message); res.status(500).send('Error'); }
};
const eliminarDocumento = async (req, res) => {
  try {
    await pool.query('DELETE FROM dealer_liquidez_documentos WHERE id=? AND id_plan=?', [req.params.docId, req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'dealers', entidad: 'dealer_liquidez_plan', entidad_id: req.params.id,
      detalle: `Eliminó documento #${req.params.docId} del Plan Liquidez #${req.params.id}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[liquidez eliminarDocumento]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Preview de la liquidación del mes (usa el motor único) ────────────────── */
const previewLiquidacion = async (req, res) => {
  try {
    const comision = num(req.query.comision ?? (req.body || {}).comision);
    const [[p]] = await pool.query('SELECT tope, deuda_actual FROM dealer_liquidez_planes WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Plan no encontrado' });
    res.json({ success: true, data: liquidar(comision, p.deuda_actual, p.tope), error: null });
  } catch (e) { console.error('[liquidez previewLiquidacion]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = {
  dealersDisponibles, listar, obtener, crear, editar,
  subirDocumento, verDocumento, eliminarDocumento, previewLiquidacion,
};
