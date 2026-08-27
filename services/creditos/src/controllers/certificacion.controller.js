'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CERTIFICACIÓN DE OPERACIONES OTORGADAS (pedido de Pato, 27-08-2026)

   Qué hace: revisión MANUAL, una a una, de los valores de cada operación
   otorgada del mes contra su carta de aprobación (y, en AUTOFIN, contra
   Trinidad — validación visual: Trinidad no se consulta por API).
   Campos que se certifican: valor del vehículo, pie, saldo precio, monto del
   crédito, primas de seguros (RDH / cesantía / rep. menores), plazo y tasa.

   El certificador puede CORREGIR un valor al certificar: el cambio se aplica
   al crédito, queda en la bitácora de la certificación (antes → después) y en
   la auditoría transversal. El reporte mensual lista qué se certificó, quién
   y qué valores se modificaron.

   Asignación PARAMÉTRICA por usuario (tabla certificacion_asignados, pestaña
   Asignación — solo admin del módulo). A los asignados un pop-up les recuerda
   2 veces al día cuántas operaciones tienen por certificar (frontend global
   en app-version.js → GET /mias).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { ETAPA_SQL } = require('../../../../shared/etapa-credito');
const { auditar } = require('../../../../shared/audit');

/* Catálogo ÚNICO de campos certificables: columna en creditos ↔ columna en la
   carta. Todo (detalle, certificar, reporte) sale de acá — nada hardcodeado
   en el frontend. */
const CAMPOS = [
  { campo: 'valor_vehiculo',   label: 'Valor del vehículo', carta: 'precio_venta' },
  { campo: 'pie',              label: 'Pie',                carta: 'pie' },
  { campo: 'saldo_precio',     label: 'Saldo precio',       carta: 'saldo' },
  { campo: 'monto_financiado', label: 'Monto del crédito',  carta: 'monto_credito_clp' },
  { campo: 'seguro_rdh',       label: 'Prima seguro RDH',   carta: 'seg_rdh' },
  { campo: 'seguro_cesantia',  label: 'Prima seguro cesantía', carta: 'seg_cesantia' },
  { campo: 'seguro_rep_menor', label: 'Prima seguro rep. menores', carta: 'seg_rep' },
  { campo: 'plazo',            label: 'Plazo (meses)',      carta: 'plazo' },
  { campo: 'tascli_real',      label: 'Tasa del crédito',   carta: 'tasa_credito' },
];
const CAMPOS_SET = new Set(CAMPOS.map(c => c.campo));

require('../../../../shared/migrate').enFila('certificacion-ops', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS certificacion_ops (
        id            BIGINT AUTO_INCREMENT PRIMARY KEY,
        id_credito    INT          NOT NULL,
        num_op        VARCHAR(40)  NOT NULL,
        mes           CHAR(7)      NOT NULL,
        certificado_por INT        NOT NULL,
        certificado_nombre VARCHAR(200) NULL,
        cambios       JSON         NULL,
        observaciones TEXT         NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_credito (id_credito),
        INDEX idx_mes (mes)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS certificacion_asignados (
        id_usuario INT PRIMARY KEY,
        asignado_por INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    // Card + permisos (módulo Carga Masiva = 180001, ahí vive la revisión de lo cargado)
    await pool.query(`INSERT IGNORE INTO funcionalidades (id_funcionalidad, id_modulo, nombre, codigo, href, icono) VALUES
      (7940001, 180001, 'Certificación de Operaciones', 'certificacion_ops', '/creditos/certificacion/', 'bi-patch-check'),
      (7940002, 180001, 'Certificación — certificar operaciones', 'certificacion_certificar', NULL, NULL),
      (7940003, 180001, 'Certificación — administrar asignación', 'certificacion_admin', NULL, NULL)`);
    await pool.query("UPDATE funcionalidades SET id_modulo = 180001 WHERE id_funcionalidad IN (7940001,7940002,7940003)");
    for (const like of ['ADMINISTRADOR%']) {
      const [[p]] = await pool.query('SELECT id_perfil FROM perfiles WHERE UPPER(nombre) LIKE ? ORDER BY id_perfil LIMIT 1', [like]);
      if (!p) continue;
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
        SELECT ?, id_funcionalidad, 1 FROM funcionalidades WHERE codigo IN ('certificacion_ops','certificacion_certificar','certificacion_admin')`, [p.id_perfil]);
    }
  } catch (e) { console.error('[certificacion migrate]', e.message); }
});

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const mesChile = () => new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 7); // aprox TZ Chile
const resolverMes = q => (MES_RE.test(q || '') ? q : mesChile());

/* SELECT base: otorgadas del mes (por fecha_otorgado) con su carta (si existe)
   y su estado de certificación. La carta se vincula por id_credito_creado. */
const baseOtorgadasSQL = `
  FROM creditos c
  LEFT JOIN cartas_aprobacion ca ON ca.id_credito_creado = c.id
  LEFT JOIN certificacion_ops ce ON ce.id_credito = c.id
  LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
  WHERE ${ETAPA_SQL('c')} = 'OTORGADO'
    AND DATE_FORMAT(c.fecha_otorgado, '%Y-%m') = ?`;

// GET /api/certificacion/pendientes?mes=YYYY-MM&estado=PENDIENTE|CERTIFICADA|TODAS
exports.pendientes = async (req, res) => {
  try {
    const mes = resolverMes(req.query.mes);
    const estado = String(req.query.estado || 'PENDIENTE').toUpperCase();
    let filtro = '';
    if (estado === 'PENDIENTE') filtro = ' AND ce.id IS NULL';
    else if (estado === 'CERTIFICADA') filtro = ' AND ce.id IS NOT NULL';
    const [rows] = await pool.query(`
      SELECT c.id, c.num_op, c.fecha_otorgado, c.financiera, c.producto, c.automotora,
             COALESCE(cl.nombre_completo, cl.nombre, cl.nombres, '') AS cliente,
             ca.op_carta, ce.id AS id_cert, ce.certificado_nombre, ce.created_at AS fecha_cert,
             ce.cambios IS NOT NULL AND JSON_LENGTH(COALESCE(ce.cambios,'[]')) > 0 AS con_cambios
        ${baseOtorgadasSQL} ${filtro}
       ORDER BY c.fecha_otorgado, c.num_op LIMIT 1000`, [mes]);
    const [[tot]] = await pool.query(`
      SELECT COUNT(*) AS total, SUM(ce.id IS NULL) AS pendientes ${baseOtorgadasSQL}`, [mes]);
    return res.json({ success: true, data: { mes, ops: rows, total: tot.total, pendientes: Number(tot.pendientes || 0) }, error: null });
  } catch (e) {
    console.error('[certificacion pendientes]', e.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// GET /api/certificacion/detalle/:id — valores del crédito lado a lado con la carta
exports.detalle = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id inválido' });
    const cartaCols = CAMPOS.map(c => `ca.${c.carta} AS carta_${c.campo}`).join(', ');
    const credCols = CAMPOS.map(c => `c.${c.campo}`).join(', ');
    const [[row]] = await pool.query(`
      SELECT c.id, c.num_op, c.fecha_otorgado, c.financiera, c.producto, c.automotora,
             COALESCE(cl.nombre_completo, cl.nombre, cl.nombres, '') AS cliente, cl.rut,
             ${credCols}, ca.op_carta, ${cartaCols},
             ce.id AS id_cert, ce.certificado_nombre, ce.created_at AS fecha_cert,
             ce.cambios, ce.observaciones
        FROM creditos c
        LEFT JOIN cartas_aprobacion ca ON ca.id_credito_creado = c.id
        LEFT JOIN certificacion_ops ce ON ce.id_credito = c.id
        LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
       WHERE c.id = ? LIMIT 1`, [id]);
    if (!row) return res.status(404).json({ success: false, data: null, error: 'Crédito no encontrado' });
    const campos = CAMPOS.map(c => ({
      campo: c.campo, label: c.label,
      sistema: row[c.campo], carta: row['carta_' + c.campo],
    }));
    // Diferencias que la carga masiva dejó pendientes para esta op (contexto Trinidad)
    const [difs] = await pool.query(
      "SELECT campo, valor_sistema, valor_archivo, estado FROM carga_diferencias WHERE id_credito = ? AND estado = 'PENDIENTE' LIMIT 20", [id]);
    return res.json({ success: true, data: {
      id: row.id, num_op: row.num_op, fecha_otorgado: row.fecha_otorgado,
      financiera: row.financiera, producto: row.producto, automotora: row.automotora,
      cliente: row.cliente, rut: row.rut, op_carta: row.op_carta,
      es_autofin: /AUTOFIN/i.test(row.financiera || ''),
      campos, diferencias_carga: difs,
      certificacion: row.id_cert ? { por: row.certificado_nombre, fecha: row.fecha_cert, cambios: row.cambios, observaciones: row.observaciones } : null,
    }, error: null });
  } catch (e) {
    console.error('[certificacion detalle]', e.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// POST /api/certificacion/:id/certificar  {cambios:[{campo, valor}], observaciones}
exports.certificar = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id inválido' });
    const [[cr]] = await pool.query(`
      SELECT c.*, DATE_FORMAT(c.fecha_otorgado, '%Y-%m') AS mes_otorgado,
             ${ETAPA_SQL('c')} AS etapa
        FROM creditos c WHERE c.id = ? LIMIT 1`, [id]);
    if (!cr) return res.status(404).json({ success: false, data: null, error: 'Crédito no encontrado' });
    if (cr.etapa !== 'OTORGADO') return res.status(409).json({ success: false, data: null, error: 'Solo se certifican operaciones OTORGADAS' });
    const [[ya]] = await pool.query('SELECT id, certificado_nombre FROM certificacion_ops WHERE id_credito = ? LIMIT 1', [id]);
    if (ya) return res.status(409).json({ success: false, data: null, error: `Ya certificada por ${ya.certificado_nombre || 'otro usuario'}` });

    // Cambios: solo campos del catálogo, se registra antes→después y se aplica
    const pedidos = Array.isArray(req.body.cambios) ? req.body.cambios : [];
    const cambios = [];
    for (const p of pedidos) {
      if (!CAMPOS_SET.has(p.campo)) return res.status(400).json({ success: false, data: null, error: `Campo no certificable: ${p.campo}` });
      const nuevo = p.valor === '' || p.valor == null ? null : Number(p.valor);
      if (nuevo == null || !isFinite(nuevo)) return res.status(400).json({ success: false, data: null, error: `Valor inválido para ${p.campo}` });
      const antes = cr[p.campo];
      if (Number(antes) === nuevo) continue;  // sin cambio real, no se anota
      cambios.push({ campo: p.campo, label: (CAMPOS.find(c => c.campo === p.campo) || {}).label, antes, despues: nuevo });
    }
    if (cambios.length) {
      const sets = cambios.map(c => `${c.campo} = ?`).join(', ');
      const [up] = await pool.query(`UPDATE creditos SET ${sets} WHERE id = ?`, [...cambios.map(c => c.despues), id]);
      if (!up.affectedRows) return res.status(500).json({ success: false, data: null, error: 'No se pudo actualizar el crédito' });
    }
    const obs = String(req.body.observaciones || '').slice(0, 1000) || null;
    await pool.query(`INSERT INTO certificacion_ops (id_credito, num_op, mes, certificado_por, certificado_nombre, cambios, observaciones)
                      VALUES (?,?,?,?,?,?,?)`,
      [id, cr.num_op, cr.mes_otorgado, req.user.id_usuario, req.user.nombre || req.user.email || null,
       cambios.length ? JSON.stringify(cambios) : null, obs]);
    auditar({ req, modulo: 'creditos', accion: 'CERTIFICAR', entidad: 'credito', entidad_id: cr.num_op,
      detalle: `Certificó OP ${cr.num_op} (${cr.mes_otorgado})${cambios.length ? ' con ' + cambios.length + ' corrección(es): ' + cambios.map(c => `${c.label} ${c.antes}→${c.despues}`).join('; ') : ' sin cambios'}` });
    return res.json({ success: true, data: { certificada: true, cambios }, error: null });
  } catch (e) {
    console.error('[certificacion certificar]', e.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// GET /api/certificacion/reporte?mes= — certificadas del mes: quién y qué se modificó
exports.reporte = async (req, res) => {
  try {
    const mes = resolverMes(req.query.mes);
    const [rows] = await pool.query(`
      SELECT ce.num_op, ce.created_at AS fecha_cert, ce.certificado_nombre, ce.cambios, ce.observaciones,
             c.financiera, c.automotora, COALESCE(cl.nombre_completo, cl.nombre, cl.nombres, '') AS cliente
        FROM certificacion_ops ce
        JOIN creditos c ON c.id = ce.id_credito
        LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
       WHERE ce.mes = ? ORDER BY ce.created_at LIMIT 2000`, [mes]);
    const [[tot]] = await pool.query(`SELECT COUNT(*) AS total, SUM(ce.id IS NULL) AS pendientes ${baseOtorgadasSQL}`, [mes]);
    return res.json({ success: true, data: { mes, certificadas: rows, total_otorgadas: tot.total, pendientes: Number(tot.pendientes || 0) }, error: null });
  } catch (e) {
    console.error('[certificacion reporte]', e.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// ── Asignación paramétrica ──────────────────────────────────────────────────
// GET /api/certificacion/asignados — usuarios activos + flag asignado
exports.asignados = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id_usuario, CONCAT(u.nombre, ' ', COALESCE(u.apellido,'')) AS nombre, u.email,
             p.nombre AS perfil, (ca.id_usuario IS NOT NULL) AS asignado
        FROM usuarios u
        LEFT JOIN perfiles p ON p.id_perfil = u.id_perfil
        LEFT JOIN certificacion_asignados ca ON ca.id_usuario = u.id_usuario
       WHERE u.estado = 'activo' ORDER BY nombre`);
    return res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[certificacion asignados]', e.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// PUT /api/certificacion/asignados/:idUsuario  {asignado: true|false}
exports.setAsignado = async (req, res) => {
  try {
    const idU = parseInt(req.params.idUsuario, 10);
    if (!idU) return res.status(400).json({ success: false, data: null, error: 'id inválido' });
    if (req.body.asignado) {
      await pool.query('INSERT IGNORE INTO certificacion_asignados (id_usuario, asignado_por) VALUES (?,?)', [idU, req.user.id_usuario]);
    } else {
      await pool.query('DELETE FROM certificacion_asignados WHERE id_usuario = ?', [idU]);
    }
    auditar({ req, modulo: 'creditos', accion: 'ASIGNAR_CERTIFICADOR', entidad: 'usuario', entidad_id: String(idU),
      detalle: `${req.body.asignado ? 'Asignó' : 'Retiró'} certificador de operaciones (usuario ${idU})` });
    return res.json({ success: true, data: { asignado: !!req.body.asignado }, error: null });
  } catch (e) {
    console.error('[certificacion setAsignado]', e.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// GET /api/certificacion/mias — para el pop-up global: ¿estoy asignado y cuántas me esperan?
exports.mias = async (req, res) => {
  try {
    const [[asig]] = await pool.query('SELECT 1 AS ok FROM certificacion_asignados WHERE id_usuario = ? LIMIT 1', [req.user.id_usuario]);
    if (!asig) return res.json({ success: true, data: { asignado: false, pendientes: 0 }, error: null });
    const mes = mesChile();
    const [[tot]] = await pool.query(`SELECT SUM(ce.id IS NULL) AS pendientes ${baseOtorgadasSQL}`, [mes]);
    return res.json({ success: true, data: { asignado: true, mes, pendientes: Number(tot.pendientes || 0) }, error: null });
  } catch (e) {
    console.error('[certificacion mias]', e.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
