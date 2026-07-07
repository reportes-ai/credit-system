'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   APLICACIÓN DE FONDOS (Tesorería) — formulario de aplicación de fondos por
   avenimiento judicial / renegociación / prepago negociado (lógica del Excel
   de cobranza): por cada ítem de la deuda (capital, interés corriente, costo
   prepago, interés mora, gastos de cobranza, honorarios, gastos procesales)
   se digita el DESCUENTO (% o $, bidireccional) y se calcula el A PAGAR.
   - La deuda por ítem sale del MOTOR ÚNICO de prepago
     (certificados.calcularPrepago) — máxima #1, no se duplica el cálculo.
   - Flujo de firmas del formulario: HECHO → REVISADO → APROBADO → PROCESADO
     (cada etapa estampa usuario + fecha). PROCESADO no registra pagos:
     el pago/prepago real se hace en Caja (motor de prepago compartido).
   ───────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const safeJSON = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return null; } };
const nombreUsuario = u => [u?.nombre, u?.apellido].filter(Boolean).join(' ') || u?.email || 'Usuario';

/* Ítems canónicos del formulario (los 5 primeros vienen del motor de prepago;
   honorarios y gastos procesales se digitan a mano; honorarios lleva IVA). */
const ITEMS = [
  { key: 'capital',           label: 'DEUDA CAPITAL' },
  { key: 'int_corriente',     label: 'INT. CORRIENTE' },
  { key: 'costo_prepago',     label: 'COSTO PREPAGO' },
  { key: 'int_mora',          label: 'INT. MORA' },
  { key: 'gastos_cobranza',   label: 'GASTOS DE COBRANZA' },
  { key: 'honorarios',        label: 'HONORARIOS', iva: true, manual: true },
  { key: 'gastos_procesales', label: 'GASTOS PROCESALES', manual: true },
];
const MOTIVOS = ['AVENIMIENTO JUDICIAL', 'RENEGOCIACIÓN', 'PREPAGO NEGOCIADO', 'CONDONACIÓN COMERCIAL', 'OTRO'];
const FLUJO = ['HECHO', 'REVISADO', 'APROBADO', 'PROCESADO'];

/* ── Migración ──────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS aplicaciones_fondos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        correlativo VARCHAR(20) NOT NULL UNIQUE,
        num_op VARCHAR(20) NOT NULL,
        rut VARCHAR(15) NULL,
        nombre VARCHAR(200) NULL,
        motivo VARCHAR(60) NOT NULL,
        abogado VARCHAR(150) NULL,
        dias_mora INT NULL,
        fecha DATE NOT NULL,
        items JSON NOT NULL,                        -- [{key,label,monto,dcto_pct,dcto_monto,iva_monto,a_pagar}]
        total_deuda DECIMAL(15,2) NOT NULL,         -- monto total prepago (suma de ítems)
        total_recibido DECIMAL(15,2) NOT NULL,      -- suma A PAGAR
        total_descuento DECIMAL(15,2) NOT NULL,
        devolucion_cliente DECIMAL(15,2) NOT NULL DEFAULT 0,
        glosa VARCHAR(600) NULL,
        estado VARCHAR(12) NOT NULL DEFAULT 'HECHO', -- HECHO|REVISADO|APROBADO|PROCESADO|ANULADA
        firmas JSON NULL,                            -- {HECHO:{usuario,fecha},...}
        created_by INT NULL, created_nombre VARCHAR(150) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_op (num_op), INDEX idx_estado (estado)
      )`);
    // Card en la landing de Tesorería + permisos (anti-hardcode)
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (mod) {
      for (const f of [
        { codigo: 'aplic_fondos',         nombre: 'Aplicación de Fondos', href: '/tesoreria/aplicacion-fondos', icono: 'bi-cash-coin' },
        { codigo: 'aplic_fondos_aprobar', nombre: 'Aplicación de Fondos — revisar/aprobar/procesar', href: null, icono: null },
      ]) {
        const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
        let idF = ex && ex.id_funcionalidad;
        if (!idF) {
          const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
            [mod.id_modulo, f.nombre, f.codigo, f.href, f.icono]);
          idF = r.insertId;
        }
        await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
      }
    }
    console.log('[aplicacion-fondos] módulo listo');
  } catch (e) { console.error('[aplicacion-fondos migration]', e.message); }
})();

/* ── GET /api/aplicacion-fondos/catalogo ────────────────────────────────── */
exports.catalogo = (req, res) => ok(res, { items: ITEMS, motivos: MOTIVOS, flujo: FLUJO });

/* ── GET /api/aplicacion-fondos/op/:num_op — deuda por ítem (motor único) ── */
exports.deudaOp = async (req, res) => {
  try {
    const { calcularPrepago } = require('../../../certificados/src/controllers/certificados.controller');
    const pp = await calcularPrepago(req.params.num_op);
    const d = pp.datos;
    // días de mora = de la cuota impaga más antigua
    let diasMora = 0;
    const hoy = new Date();
    for (const q of d.detalle || []) {
      if (q.en_mora && q.fecha_vencimiento) {
        diasMora = Math.max(diasMora, Math.floor((hoy - new Date(q.fecha_vencimiento + 'T00:00:00')) / 86400000));
      }
    }
    ok(res, {
      num_op: pp.num_op, rut: pp.rut, nombre: pp.nombre, dias_mora: diasMora,
      items: {
        capital: Math.round((d.capital_vigente || 0) + (d.mora_cuotas || 0)),
        int_corriente: d.interes_corriente || 0,
        costo_prepago: d.comision_prepago || 0,
        int_mora: d.interes_mora || 0,
        gastos_cobranza: d.gastos_cobranza || 0,
        honorarios: 0, gastos_procesales: 0,
      },
      total_prepago: d.saldo_insoluto || 0,
    });
  } catch (e) {
    if (e && e.code) return fail(res, e.msg, e.code);
    console.error('[aplic-fondos deudaOp]', e); fail(res, 'Error interno del servidor');
  }
};

/* ── POST /api/aplicacion-fondos — crear formulario ─────────────────────── */
const R = v => Math.round(Number(v) || 0);
exports.crear = async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.num_op) return fail(res, 'Falta la operación.', 400);
    if (!MOTIVOS.includes(b.motivo)) return fail(res, 'Motivo inválido.', 400);
    const itemsIn = b.items || {};
    let totalDeuda = 0, totalRecibido = 0, totalDcto = 0;
    const items = ITEMS.map(def => {
      const it = itemsIn[def.key] || {};
      const monto = R(it.monto);
      let dcto = R(it.dcto_monto);
      if (dcto > monto) dcto = monto;
      if (dcto < 0) dcto = 0;
      const ivaMonto = def.iva ? R(it.iva_monto) : 0;
      const aPagar = Math.max(0, monto - dcto + ivaMonto);
      totalDeuda += monto; totalRecibido += aPagar; totalDcto += dcto;
      return { key: def.key, label: def.label, monto, dcto_monto: dcto,
        dcto_pct: monto > 0 ? +(dcto / monto).toFixed(6) : 0, iva_monto: ivaMonto, a_pagar: aPagar };
    });
    if (!totalDeuda) return fail(res, 'El formulario no tiene montos.', 400);
    const devolucion = Math.max(0, R(b.devolucion_cliente));

    const [[m]] = await pool.query("SELECT IFNULL(MAX(CAST(SUBSTRING(correlativo,5) AS UNSIGNED)),0) n FROM aplicaciones_fondos");
    const correlativo = 'APF-' + String(m.n + 1).padStart(4, '0');
    const firmas = { HECHO: { usuario: nombreUsuario(req.usuario || req.user), fecha: new Date().toISOString().slice(0, 19).replace('T', ' ') } };
    const u = req.usuario || req.user || {};
    const [r] = await pool.query(
      `INSERT INTO aplicaciones_fondos (correlativo, num_op, rut, nombre, motivo, abogado, dias_mora, fecha,
        items, total_deuda, total_recibido, total_descuento, devolucion_cliente, glosa, estado, firmas, created_by, created_nombre)
       VALUES (?,?,?,?,?,?,?,CURDATE(),?,?,?,?,?,?,'HECHO',?,?,?)`,
      [correlativo, String(b.num_op).slice(0, 20), (b.rut || '').slice(0, 15) || null, (b.nombre || '').slice(0, 200) || null,
       b.motivo, (b.abogado || '').slice(0, 150) || null, parseInt(b.dias_mora, 10) || 0,
       JSON.stringify(items), totalDeuda, totalRecibido, totalDcto, devolucion,
       (b.glosa || '').slice(0, 600) || null, JSON.stringify(firmas), u.id_usuario || null, nombreUsuario(u)]);
    auditar({ req, accion: 'CREAR', modulo: 'tesoreria', entidad: 'aplicacion_fondos', entidad_id: r.insertId,
      detalle: `Aplicación de fondos ${correlativo} OP ${b.num_op} (${b.motivo}): recibe $${totalRecibido.toLocaleString('es-CL')}, condona $${totalDcto.toLocaleString('es-CL')}`, rut: b.rut });
    ok(res, { id: r.insertId, correlativo });
  } catch (e) { console.error('[aplic-fondos crear]', e); fail(res, 'Error interno del servidor'); }
};

/* ── GET /api/aplicacion-fondos — historial ─────────────────────────────── */
exports.listar = async (req, res) => {
  try {
    const where = [], pars = [];
    if (req.query.estado) { where.push('estado=?'); pars.push(req.query.estado); }
    if (req.query.q) { where.push('(num_op LIKE ? OR rut LIKE ? OR nombre LIKE ? OR correlativo LIKE ?)');
      pars.push(...Array(4).fill(`%${req.query.q}%`)); }
    const [rows] = await pool.query(
      `SELECT id, correlativo, num_op, rut, nombre, motivo, fecha, total_deuda, total_recibido,
              total_descuento, estado, created_nombre, created_at
         FROM aplicaciones_fondos ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC LIMIT 300`, pars);
    ok(res, rows);
  } catch (e) { console.error('[aplic-fondos listar]', e); fail(res, 'Error interno del servidor'); }
};

exports.obtener = async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT * FROM aplicaciones_fondos WHERE id=?', [req.params.id]);
    if (!a) return fail(res, 'Formulario no existe', 404);
    a.items = safeJSON(a.items) || [];
    a.firmas = safeJSON(a.firmas) || {};
    ok(res, a);
  } catch (e) { console.error('[aplic-fondos obtener]', e); fail(res, 'Error interno del servidor'); }
};

/* ── PUT /:id/avanzar — siguiente firma del flujo (aprobadores) ─────────── */
exports.avanzar = async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT * FROM aplicaciones_fondos WHERE id=?', [req.params.id]);
    if (!a) return fail(res, 'Formulario no existe', 404);
    if (a.estado === 'ANULADA') return fail(res, 'El formulario está anulado.', 400);
    const idx = FLUJO.indexOf(a.estado);
    if (idx < 0 || idx >= FLUJO.length - 1) return fail(res, 'El formulario ya está PROCESADO.', 400);
    const siguiente = FLUJO[idx + 1];
    const firmas = safeJSON(a.firmas) || {};
    firmas[siguiente] = { usuario: nombreUsuario(req.usuario || req.user), fecha: new Date().toISOString().slice(0, 19).replace('T', ' ') };
    await pool.query('UPDATE aplicaciones_fondos SET estado=?, firmas=? WHERE id=?', [siguiente, JSON.stringify(firmas), a.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'aplicacion_fondos', entidad_id: a.id,
      detalle: `Aplicación ${a.correlativo} → ${siguiente}`, rut: a.rut });
    ok(res, { estado: siguiente });
  } catch (e) { console.error('[aplic-fondos avanzar]', e); fail(res, 'Error interno del servidor'); }
};

/* ── PUT /:id/anular (aprobadores; no si ya está PROCESADO) ─────────────── */
exports.anular = async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT * FROM aplicaciones_fondos WHERE id=?', [req.params.id]);
    if (!a) return fail(res, 'Formulario no existe', 404);
    if (a.estado === 'PROCESADO') return fail(res, 'Un formulario PROCESADO no se puede anular.', 400);
    if (a.estado === 'ANULADA') return fail(res, 'Ya está anulado.', 400);
    await pool.query("UPDATE aplicaciones_fondos SET estado='ANULADA' WHERE id=?", [a.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'tesoreria', entidad: 'aplicacion_fondos', entidad_id: a.id,
      detalle: `Aplicación ${a.correlativo} ANULADA`, rut: a.rut });
    ok(res, { anulada: true });
  } catch (e) { console.error('[aplic-fondos anular]', e); fail(res, 'Error interno del servidor'); }
};
