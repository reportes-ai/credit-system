'use strict';
/**
 * Órdenes de Pago (módulo general de cuentas por pagar a proveedores).
 * Distinto del flujo Post Venta (saldo precio / comisión): aquí las órdenes
 * se llenan a mano. Incluye base de proveedores, historial y estadísticas.
 *
 * Tablas: proveedores, ordenes_pago.
 * Numeración: correlativo global único ODP-AAAA-NNNNNN (libro central shared/ordenes-pago.js).
 */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { emitirCorrelativo, anularCorrelativo } = require('../../../../shared/ordenes-pago');

/* ── Migración: tablas + módulo/funcionalidades/permisos (idempotente) ──────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS proveedores (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        rut            VARCHAR(20)  NULL,
        nombre         VARCHAR(200) NOT NULL,
        giro           VARCHAR(200) NULL,
        email          VARCHAR(150) NULL,
        telefono       VARCHAR(40)  NULL,
        direccion      VARCHAR(300) NULL,
        contacto       VARCHAR(150) NULL,
        banco          VARCHAR(80)  NULL,
        tipo_cuenta    VARCHAR(40)  NULL,
        numero_cuenta  VARCHAR(60)  NULL,
        activo         TINYINT(1)   NOT NULL DEFAULT 1,
        created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_rut (rut), INDEX idx_nombre (nombre), INDEX idx_activo (activo)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[proveedores migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ordenes_pago (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        numero           VARCHAR(30)  NULL,
        id_proveedor     INT          NULL,
        proveedor_nombre VARCHAR(200) NULL,
        proveedor_rut    VARCHAR(20)  NULL,
        concepto         VARCHAR(300) NOT NULL,
        categoria        VARCHAR(80)  NULL,
        tipo_documento   VARCHAR(20)  NULL,
        numero_documento VARCHAR(40)  NULL,
        fecha_documento  DATE         NULL,
        monto            DECIMAL(14,2) NOT NULL DEFAULT 0,
        fecha_emision    DATE         NULL,
        fecha_pago       DATE         NULL,
        metodo_pago      VARCHAR(40)  NULL,
        estado           VARCHAR(20)  NOT NULL DEFAULT 'EMITIDA',
        observaciones    TEXT         NULL,
        id_usuario       INT          NULL,
        usuario_nombre   VARCHAR(200) NULL,
        created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_estado (estado), INDEX idx_prov (id_proveedor),
        INDEX idx_fecha (fecha_emision), INDEX idx_numero (numero)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[ordenes_pago migration]', e.message); }

  // Auditoría de anulación (quién anuló y cuándo) — incremental.
  try {
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS anulada_por INT NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS anulada_nombre VARCHAR(200) NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS fecha_anulada DATETIME NULL`);
  } catch (e) { console.error('[ordenes_pago alter cols]', e.message); }

  // Registro del módulo/card en el Home (idempotente).
  try {
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (400001, 'Órdenes de Pago', 'Emisión manual de órdenes de pago a proveedores, historial, base de proveedores y estadísticas de compra', 'bi-cash-stack', '/ordenes-pago/', 107, 'activo')`);
    const funcs = [
      ['Emitir Orden de Pago',          'ordenes_pago_emitir',       '/ordenes-pago/emision/',      'bi-pencil-square'],
      ['Historial de Órdenes de Pago',  'ordenes_pago_historial',    '/ordenes-pago/historial/',    'bi-clock-history'],
      ['Base de Proveedores',           'ordenes_pago_proveedores',  '/ordenes-pago/proveedores/',  'bi-shop'],
      ['Estadísticas de Compra',        'ordenes_pago_estadisticas', '/ordenes-pago/estadisticas/', 'bi-bar-chart'],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (400001,?,?,?,?)`,
        [nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    // Permiso por defecto: solo Administrador (id 1). El resto se habilita en la matriz de Perfiles.
    for (const codigo of Object.keys(idFunc)) {
      const idf = idFunc[codigo];
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }
    console.log('[ordenes-pago] módulo registrado');
  } catch (e) { console.error('[ordenes-pago migration]', e.message); }
})();

/* ── Helpers ────────────────────────────────────────────────────────────────── */
const norm = s => String(s ?? '').trim();
const normRut = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();
const num = v => { const n = Number(String(v ?? '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '')); return isNaN(n) ? null : n; };
const ESTADOS = ['EMITIDA', 'PAGADA', 'ANULADA'];
const fdate = v => { const s = norm(v); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const nombreUsuario = req => norm(`${(req.usuario || {}).nombre || ''} ${(req.usuario || {}).apellido || ''}`) || (req.usuario || {}).email || '—';

/* ════════════════ PROVEEDORES ════════════════ */

/* GET /api/ordenes-pago/proveedores?q=&incluir_inactivos=1 */
const listarProveedores = async (req, res) => {
  try {
    const q = norm(req.query.q);
    const incluirInactivos = req.query.incluir_inactivos === '1';
    const where = [];
    const args = [];
    if (!incluirInactivos) where.push('activo = 1');
    if (q) { where.push('(nombre LIKE ? OR rut LIKE ? OR giro LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const [rows] = await pool.query(
      `SELECT * FROM proveedores ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY nombre LIMIT 500`, args);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* POST /api/ordenes-pago/proveedores */
const crearProveedor = async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = norm(b.nombre);
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'El nombre del proveedor es obligatorio' });
    const rut = b.rut ? normRut(b.rut) : null;
    if (rut) {
      const [[dup]] = await pool.query('SELECT id FROM proveedores WHERE rut=? LIMIT 1', [rut]);
      if (dup) return res.status(409).json({ success: false, data: null, error: 'Ya existe un proveedor con ese RUT' });
    }
    const [r] = await pool.query(
      `INSERT INTO proveedores (rut, nombre, giro, email, telefono, direccion, contacto, banco, tipo_cuenta, numero_cuenta)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [rut, nombre, norm(b.giro) || null, norm(b.email) || null, norm(b.telefono) || null, norm(b.direccion) || null,
       norm(b.contacto) || null, norm(b.banco) || null, norm(b.tipo_cuenta) || null, norm(b.numero_cuenta) || null]);
    auditar({ req, accion: 'CREAR', modulo: 'ordenes-pago', entidad: 'proveedor', entidad_id: r.insertId, detalle: `Creó proveedor ${nombre}` });
    res.json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* PUT /api/ordenes-pago/proveedores/:id */
const actualizarProveedor = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const nombre = norm(b.nombre);
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'El nombre del proveedor es obligatorio' });
    const rut = b.rut ? normRut(b.rut) : null;
    if (rut) {
      const [[dup]] = await pool.query('SELECT id FROM proveedores WHERE rut=? AND id<>? LIMIT 1', [rut, id]);
      if (dup) return res.status(409).json({ success: false, data: null, error: 'Ya existe otro proveedor con ese RUT' });
    }
    const [r] = await pool.query(
      `UPDATE proveedores SET rut=?, nombre=?, giro=?, email=?, telefono=?, direccion=?, contacto=?, banco=?, tipo_cuenta=?, numero_cuenta=? WHERE id=?`,
      [rut, nombre, norm(b.giro) || null, norm(b.email) || null, norm(b.telefono) || null, norm(b.direccion) || null,
       norm(b.contacto) || null, norm(b.banco) || null, norm(b.tipo_cuenta) || null, norm(b.numero_cuenta) || null, id]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Proveedor no encontrado' });
    auditar({ req, accion: 'EDITAR', modulo: 'ordenes-pago', entidad: 'proveedor', entidad_id: id, detalle: `Editó proveedor ${nombre}` });
    res.json({ success: true, data: { id }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* DELETE /api/ordenes-pago/proveedores/:id — baja lógica (activo=0) */
const eliminarProveedor = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[p]] = await pool.query('SELECT nombre, activo FROM proveedores WHERE id=?', [id]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Proveedor no encontrado' });
    const nuevo = p.activo ? 0 : 1;   // toggle: desactivar / reactivar
    await pool.query('UPDATE proveedores SET activo=? WHERE id=?', [nuevo, id]);
    auditar({ req, accion: nuevo ? 'REACTIVAR' : 'DESACTIVAR', modulo: 'ordenes-pago', entidad: 'proveedor', entidad_id: id, detalle: `${nuevo ? 'Reactivó' : 'Desactivó'} proveedor ${p.nombre}` });
    res.json({ success: true, data: { id, activo: nuevo }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ════════════════ ÓRDENES DE PAGO ════════════════ */

/* GET /api/ordenes-pago/ordenes?estado=&q=&desde=&hasta=&id_proveedor= */
const listarOrdenes = async (req, res) => {
  try {
    const where = [];
    const args = [];
    const estado = norm(req.query.estado).toUpperCase();
    if (ESTADOS.includes(estado)) { where.push('estado = ?'); args.push(estado); }
    const idProv = parseInt(req.query.id_proveedor);
    if (idProv) { where.push('id_proveedor = ?'); args.push(idProv); }
    const desde = fdate(req.query.desde), hasta = fdate(req.query.hasta);
    if (desde) { where.push('fecha_emision >= ?'); args.push(desde); }
    if (hasta) { where.push('fecha_emision <= ?'); args.push(hasta); }
    const q = norm(req.query.q);
    if (q) { where.push('(numero LIKE ? OR proveedor_nombre LIKE ? OR proveedor_rut LIKE ? OR concepto LIKE ? OR numero_documento LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    const [rows] = await pool.query(
      `SELECT * FROM ordenes_pago ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY fecha_emision DESC, id DESC LIMIT 1000`, args);
    // Resumen rápido (sobre el filtro aplicado).
    const resumen = { emitidas: 0, pagadas: 0, monto_emitido: 0, monto_pagado: 0 };
    rows.forEach(o => {
      if (o.estado === 'EMITIDA') { resumen.emitidas++; resumen.monto_emitido += Number(o.monto || 0); }
      if (o.estado === 'PAGADA')  { resumen.pagadas++;  resumen.monto_pagado  += Number(o.monto || 0); }
    });
    res.json({ success: true, data: rows, resumen, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* GET /api/ordenes-pago/ordenes/:id */
const getOrden = async (req, res) => {
  try {
    const [[o]] = await pool.query('SELECT * FROM ordenes_pago WHERE id=?', [parseInt(req.params.id)]);
    if (!o) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });
    res.json({ success: true, data: o, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* POST /api/ordenes-pago/ordenes — emisión manual */
const crearOrden = async (req, res) => {
  try {
    const b = req.body || {};
    const concepto = norm(b.concepto);
    const monto = num(b.monto);
    if (!concepto) return res.status(400).json({ success: false, data: null, error: 'El concepto es obligatorio' });
    if (monto == null || monto <= 0) return res.status(400).json({ success: false, data: null, error: 'El monto debe ser mayor a 0' });

    // Proveedor: por id (de la base) o nombre libre.
    let idProv = parseInt(b.id_proveedor) || null;
    let provNombre = norm(b.proveedor_nombre);
    let provRut = b.proveedor_rut ? normRut(b.proveedor_rut) : null;
    if (idProv) {
      const [[p]] = await pool.query('SELECT nombre, rut FROM proveedores WHERE id=?', [idProv]);
      if (!p) return res.status(400).json({ success: false, data: null, error: 'Proveedor no encontrado' });
      provNombre = p.nombre; provRut = p.rut;
    }
    if (!provNombre) return res.status(400).json({ success: false, data: null, error: 'Debe indicar el proveedor' });

    const fechaEmision = fdate(b.fecha_emision) || new Date().toISOString().slice(0, 10);
    const [r] = await pool.query(
      `INSERT INTO ordenes_pago
        (id_proveedor, proveedor_nombre, proveedor_rut, concepto, categoria, tipo_documento, numero_documento, fecha_documento, monto, fecha_emision, metodo_pago, estado, observaciones, id_usuario, usuario_nombre)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'EMITIDA', ?,?,?)`,
      [idProv, provNombre, provRut, concepto, norm(b.categoria) || null, norm(b.tipo_documento) || null,
       norm(b.numero_documento) || null, fdate(b.fecha_documento), monto, fechaEmision, norm(b.metodo_pago) || null,
       norm(b.observaciones) || null, (req.usuario || {}).id_usuario || null, nombreUsuario(req)]);

    // Correlativo global único ODP- (libro central op_correlativos)
    const { numero } = await emitirCorrelativo({
      origen: 'GENERAL', origen_id: r.insertId, concepto: `${concepto} — ${provNombre}`,
      monto, id_usuario: (req.usuario || {}).id_usuario || null, usuario_nombre: nombreUsuario(req) });
    await pool.query('UPDATE ordenes_pago SET numero=? WHERE id=?', [numero, r.insertId]);

    auditar({ req, accion: 'CREAR', modulo: 'ordenes-pago', entidad: 'orden_pago', entidad_id: r.insertId, detalle: `Emitió ${numero} a ${provNombre} por $${monto.toLocaleString('es-CL')}` });
    res.json({ success: true, data: { id: r.insertId, numero }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* PUT /api/ordenes-pago/ordenes/:id/estado — marcar PAGADA / ANULADA / volver a EMITIDA */
const cambiarEstadoOrden = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const estado = norm((req.body || {}).estado).toUpperCase();
    if (!ESTADOS.includes(estado)) return res.status(400).json({ success: false, data: null, error: 'Estado inválido' });
    const [[o]] = await pool.query('SELECT numero, estado FROM ordenes_pago WHERE id=?', [id]);
    if (!o) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });

    const fechaPago = estado === 'PAGADA' ? (fdate((req.body || {}).fecha_pago) || new Date().toISOString().slice(0, 10)) : null;
    const metodo = estado === 'PAGADA' ? (norm((req.body || {}).metodo_pago) || null) : null;

    if (estado === 'ANULADA') {
      // El correlativo NO se libera: queda reservado y marcado como anulado, con quién y cuándo.
      const quien = nombreUsuario(req), idU = (req.usuario || {}).id_usuario || null;
      await pool.query(
        `UPDATE ordenes_pago SET estado='ANULADA', anulada_por=?, anulada_nombre=?, fecha_anulada=NOW() WHERE id=?`,
        [idU, quien, id]);
      await anularCorrelativo({ numero: o.numero, origen: 'GENERAL', origen_id: id, id_usuario: idU, usuario_nombre: quien });
    } else {
      await pool.query(
        `UPDATE ordenes_pago SET estado=?, fecha_pago=?, metodo_pago=COALESCE(?, metodo_pago) WHERE id=?`,
        [estado, fechaPago, metodo, id]);
    }
    auditar({ req, accion: estado === 'PAGADA' ? 'PAGAR' : (estado === 'ANULADA' ? 'ANULAR' : 'EDITAR'), modulo: 'ordenes-pago', entidad: 'orden_pago', entidad_id: id, detalle: `${o.numero || id}: ${o.estado} → ${estado}` });
    res.json({ success: true, data: { id, estado, fecha_pago: fechaPago }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ════════════════ ESTADÍSTICAS ════════════════ */

/* GET /api/ordenes-pago/estadisticas?anio= — compras mensuales por proveedor (excluye ANULADA) */
const estadisticas = async (req, res) => {
  try {
    // Años disponibles.
    const [aniosRows] = await pool.query(
      `SELECT DISTINCT YEAR(fecha_emision) anio FROM ordenes_pago WHERE estado<>'ANULADA' AND fecha_emision IS NOT NULL ORDER BY anio DESC`);
    const anios = aniosRows.map(r => r.anio);
    const anio = parseInt(req.query.anio) || anios[0] || new Date().getFullYear();

    const [rows] = await pool.query(
      `SELECT COALESCE(proveedor_nombre,'(sin proveedor)') proveedor, MONTH(fecha_emision) mes,
              SUM(monto) total, COUNT(*) n
         FROM ordenes_pago
        WHERE estado<>'ANULADA' AND YEAR(fecha_emision)=?
        GROUP BY proveedor, mes
        ORDER BY proveedor`, [anio]);

    res.json({ success: true, data: { anio, anios, filas: rows }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = {
  listarProveedores, crearProveedor, actualizarProveedor, eliminarProveedor,
  listarOrdenes, getOrden, crearOrden, cambiarEstadoOrden, estadisticas,
};
