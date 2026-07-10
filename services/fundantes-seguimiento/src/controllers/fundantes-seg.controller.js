'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Seguimiento Fundantes — carga y validación de documentos fundantes de las
   operaciones OTORGADAS de brokerage (AUTOFIN / UNIDAD).

   Flujo: el Ejecutivo Comercial sube los documentos de su operación; cuando
   están TODOS los obligatorios, los envía a Validación (ENVIADO). Operaciones
   los aprueba (→ CERRADO) o los rechaza (→ RECHAZADO, con comentario obligatorio),
   y el ejecutivo puede volver a subirlos y reenviarlos.

   Tipos de documento por financiera → tabla paramétrica fundantes_seg_tipos
   (AUTOFIN: contrato compraventa + transferencia + limitación(*) + GPS(*);
    UNIDAD: contrato compraventa + transferencia). (*) sólo obligatorio si viene
   contratado en el crédito (columnas creditos.limitacion / creditos.gps).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const { ejecutivosVisibles: _visEjec } = require('../../../../shared/visibilidad-ejecutivos');

const MODULO_ID = 420001;    // card "Seguimiento Fundantes" (ejecutivo) — 410001 era Certificados
const MODULO_OPS = 420002;   // card "Seguimiento Fundantes - Operaciones" (módulo propio → card en Home)
const FINANCIERAS = ['AUTOFIN', 'UNIDAD DE CREDITO'];          // brokerage (configurable vía seed de tipos)
const ESTADOS = ['PENDIENTE', 'ENVIADO', 'CERRADO', 'RECHAZADO'];
// Buckets de antigüedad (días pendientes) para la matriz resumen.
const BUCKETS = [
  { lbl: '<=7 días', max: 7 }, { lbl: '8-15 días', max: 15 }, { lbl: '16-30 días', max: 30 },
  { lbl: '31-60', max: 60 }, { lbl: '61-90', max: 90 }, { lbl: '91+', max: Infinity },
];
const bucketDe = d => BUCKETS.findIndex(b => d <= b.max);

/* ─── Migración + seed + registro de módulo ──────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fundantes_seg (
        id_credito         INT PRIMARY KEY,
        estado             VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
        comentario_rechazo TEXT,
        fecha_envio        DATETIME, enviado_por VARCHAR(150), id_enviado_por INT,
        fecha_validacion   DATETIME, validado_por VARCHAR(150), id_validado_por INT,
        updated_at         DATETIME DEFAULT NOW() ON UPDATE NOW(),
        INDEX idx_estado (estado)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fundantes_seg_docs (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_credito     INT NOT NULL,
        codigo         VARCHAR(40) NOT NULL,
        archivo_nombre VARCHAR(300), mime_type VARCHAR(120), archivo_data LONGBLOB,
        subido_por     VARCHAR(150), id_subido_por INT,
        created_at     DATETIME DEFAULT NOW(),
        UNIQUE KEY uk_doc (id_credito, codigo),
        INDEX idx_cred (id_credito)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fundantes_seg_tipos (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        financiera        VARCHAR(40) NOT NULL,
        codigo            VARCHAR(40) NOT NULL,
        nombre            VARCHAR(120) NOT NULL,
        obligatorio       TINYINT(1) NOT NULL DEFAULT 1,
        requiere_contrato VARCHAR(20) NULL,   -- 'gps' | 'limitacion' → sólo exigido si viene contratado
        orden             INT DEFAULT 0,
        UNIQUE KEY uk_tipo (financiera, codigo)
      )`);
    const seed = [
      ['AUTOFIN', 'CONTRATO_CV', 'Contrato Compraventa', 1, null, 1],
      ['AUTOFIN', 'SOL_TRANSFERENCIA', 'Solicitud Transferencia', 1, null, 2],
      ['AUTOFIN', 'SOL_LIMITACION', 'Solicitud Limitación', 1, null, 3],
      ['AUTOFIN', 'INFORME_GPS', 'Informe GPS', 1, 'gps', 4],
      ['UNIDAD DE CREDITO', 'CONTRATO_CV', 'Contrato Compraventa', 1, null, 1],
      ['UNIDAD DE CREDITO', 'SOL_TRANSFERENCIA', 'Solicitud Transferencia', 1, null, 2],
    ];
    for (const s of seed)
      await pool.query(
        `INSERT IGNORE INTO fundantes_seg_tipos (financiera, codigo, nombre, obligatorio, requiere_contrato, orden) VALUES (?,?,?,?,?,?)`, s);
    // Corrección: en AUTOFIN la Solicitud de Limitación es SIEMPRE obligatoria (no condicional). Idempotente.
    await pool.query("UPDATE fundantes_seg_tipos SET obligatorio=1, requiere_contrato=NULL WHERE financiera='AUTOFIN' AND codigo='SOL_LIMITACION'");

    // Card PADRE única en Home → landing /fundantes/ con 2 sub-cards (Ejecutivo Comercial / Operaciones).
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (?, 'Seguimiento Fundantes', 'Documentos fundantes de las operaciones otorgadas: carga del Ejecutivo Comercial y validación por Operaciones', 'bi-folder-check', '/fundantes/', 108, 'activo')`,
      [MODULO_ID]);
    // Converge al estado final (idempotente, tolera versiones previas):
    await pool.query("UPDATE modulos SET nombre='Seguimiento Fundantes', ruta='/fundantes/', estado='activo' WHERE id_modulo=?", [MODULO_ID]);
    await pool.query("UPDATE modulos SET estado='inactivo' WHERE id_modulo=?", [MODULO_OPS]);   // ya no es card propia: va dentro del landing
    // Todas las funcionalidades cuelgan del módulo padre.
    await pool.query("UPDATE funcionalidades SET id_modulo=? WHERE codigo IN ('fundantes_seguimiento','fundantes_operaciones','fundantes_validar')", [MODULO_ID]);
    const funcs = [
      ['Seguimiento Fundantes - Ejecutivo Comercial', 'fundantes_seguimiento', '/fundantes-seguimiento/', 'bi-folder-check'],
      ['Seguimiento Fundantes - Operaciones', 'fundantes_operaciones', '/fundantes-operaciones/', 'bi-inboxes'],
      ['Validar Fundantes', 'fundantes_validar', null, 'bi-check2-circle'],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) {
        idFunc[codigo] = ex.id_funcionalidad;     // converge nombre/href/icono/módulo de versiones previas
        await pool.query('UPDATE funcionalidades SET nombre=?, href=?, icono=?, id_modulo=? WHERE id_funcionalidad=?', [nombre, href, icono, MODULO_ID, ex.id_funcionalidad]);
        continue;
      }
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)`,
        [MODULO_ID, nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    for (const codigo of Object.keys(idFunc)) {
      const idf = idFunc[codigo];
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }
    console.log('[fundantes-seguimiento] módulo registrado');
  } catch (e) { console.error('[fundantes-seguimiento migration]', e.message); }

  // Backfill: créditos con fundantes ya CERRADO (aprobados antes de la automatización)
  // → marca la etapa "FUNDANTES RECIBIDOS" en su seguimiento Post Venta. Idempotente.
  try {
    await pool.query(
      `INSERT INTO postventa_etapas (id_seguimiento, track, etapa, usuario)
       SELECT ps.id, 'SALDO', 'FUNDANTES RECIBIDOS', 'Sistema'
         FROM fundantes_seg fs
         JOIN postventa_seguimiento ps ON ps.id_credito = fs.id_credito
        WHERE fs.estado = 'CERRADO'
          AND NOT EXISTS (SELECT 1 FROM postventa_etapas e
                            WHERE e.id_seguimiento = ps.id AND e.track='SALDO' AND e.etapa='FUNDANTES RECIBIDOS')
       ON DUPLICATE KEY UPDATE id_seguimiento = id_seguimiento`);
  } catch (e) { console.error('[fundantes RECIBIDOS backfill]', e.message); }
})();

/* ─── helpers ─────────────────────────────────────────────────────────────── */
const nombreUsuario = req => (req.usuario && `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim()) ||
  (req.usuario && req.usuario.email) || 'Sistema';
// ¿el campo contratado (gps/limitacion) viene "con el crédito"?  null/0/'' → no contratado.
const contratado = v => { const s = String(v == null ? '' : v).trim(); return s !== '' && s !== '0' && Number(s) !== 0; };

// Visibilidad por ejecutivo: regla central paramétrica (shared/visibilidad-ejecutivos),
// por ámbito del perfil ('todos' | 'asignados'). Soporta varios supervisores.
async function ejecutivosVisibles(req) { return _visEjec(req.usuario); }

// Pool de Operaciones: usuarios activos cuyo perfil puede validar fundantes (fundantes_validar /
// fundantes_operaciones) + Administradores. Para avisar cuando llegan fundantes a validación.
async function idsOperaciones(excluirId) {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT u.id_usuario
         FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
        WHERE u.estado='activo' AND u.id_usuario <> ?
          AND (p.nombre='Administrador'
               OR EXISTS (SELECT 1 FROM permisos_perfil pp JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
                          WHERE pp.id_perfil=p.id_perfil AND pp.habilitado=1 AND f.codigo IN ('fundantes_validar','fundantes_operaciones')))`,
      [excluirId || 0]);
    return rows.map(r => r.id_usuario);
  } catch (e) { console.error('[fundantes idsOperaciones]', e.message); return []; }
}

// Tipos requeridos para una operación según financiera + lo contratado. Devuelve [{codigo,nombre,obligatorio,orden}].
function tiposDeOperacion(op, tiposPorFin) {
  const arr = tiposPorFin[String(op.financiera || '').toUpperCase()] || [];
  return arr.map(t => ({
    codigo: t.codigo, nombre: t.nombre, orden: t.orden,
    obligatorio: t.requiere_contrato ? contratado(op[t.requiere_contrato]) : !!t.obligatorio,
  }));
}

/* ─── GET /api/fundantes-seguimiento ──────────────────────────────────────────
   Lista las operaciones otorgadas brokerage con sus documentos + estado + matriz. */
const listar = async (req, res) => {
  try {
    const fEjec = String(req.query.ejecutivo || '').trim();
    const fFin = String(req.query.financiera || '').trim().toUpperCase();
    const fEstado = String(req.query.estado || '').trim().toUpperCase();   // ej. ENVIADO (cola Operaciones)
    const incluirCerrados = req.query.cerrados === '1' || req.query.cerrados === 'true';

    const vis = await ejecutivosVisibles(req);
    const filt = ['c.fecha_otorgado IS NOT NULL', 'UPPER(c.financiera) IN (?)'];
    const fp = [FINANCIERAS];
    if (!vis.all) {
      if (!vis.lista.length)
        return res.json({ success: true, data: [], resumen: matrizVacia(), ejecutivos: [], puede_validar: false, es_ejecutivo: true, nombre: nombreUsuario(req), error: null });
      // Comparación case-insensitive: los nombres asignados van en MAYÚSCULAS pero el crédito
      // puede guardar el ejecutivo con otra caja (ej. "Katherin Trillo" desde la carta).
      filt.push('UPPER(c.ejecutivo) IN (?)'); fp.push(vis.lista.map(x => String(x).toUpperCase()));
    } else if (fEjec) { filt.push('UPPER(c.ejecutivo) = ?'); fp.push(String(fEjec).toUpperCase()); }
    if (fFin && FINANCIERAS.includes(fFin)) { filt.push('UPPER(c.financiera) = ?'); fp.push(fFin); }
    const where = 'WHERE ' + filt.join(' AND ');

    // Tipos por financiera (paramétrico)
    const [tipos] = await pool.query('SELECT financiera, codigo, nombre, obligatorio, requiere_contrato, orden FROM fundantes_seg_tipos ORDER BY orden');
    const tiposPorFin = {};
    tipos.forEach(t => (tiposPorFin[t.financiera.toUpperCase()] = tiposPorFin[t.financiera.toUpperCase()] || []).push(t));

    // Matriz resumen (sobre TODO el conjunto filtrado, sin límite, excluye CERRADO).
    const [agg] = await pool.query(`
      SELECT CASE WHEN COALESCE(fs.estado,'PENDIENTE')='ENVIADO' THEN 'ENV' ELSE 'PEND' END AS grp,
             DATEDIFF(CURDATE(), c.fecha_otorgado) AS dias, COUNT(*) AS n
      FROM creditos c LEFT JOIN fundantes_seg fs ON fs.id_credito = c.id
      ${where} AND COALESCE(fs.estado,'PENDIENTE') <> 'CERRADO'
      GROUP BY grp, dias`, fp);
    const resumen = matrizVacia();
    agg.forEach(r => { const b = bucketDe(Number(r.dias) || 0); if (b < 0) return; const k = r.grp === 'ENV' ? 'enviados' : 'pendientes'; resumen[k][b] += Number(r.n) || 0; });
    for (let i = 0; i < BUCKETS.length; i++) resumen.total[i] = resumen.pendientes[i] + resumen.enviados[i];

    // Lista de operaciones (limitada). Filtro por estado (cola Operaciones); por defecto oculta CERRADO.
    const fpData = [...fp];
    let whereData = where;
    // Filtro por estado de PAGO (operación): liberado a pago / fondos liberados / etc.
    const fEstadoOp = String(req.query.estado_op || '').trim().toUpperCase();
    const OP_MAP = {
      POR_VALIDAR:         "COALESCE(fs.estado,'PENDIENTE')='ENVIADO'",
      RECHAZADO:           "COALESCE(fs.estado,'PENDIENTE')='RECHAZADO'",
      FUNDANTES_RECIBIDOS: "fs.estado='CERRADO' AND COALESCE(c.liberado_pago,0)<>1 AND (c.estado_pago IS NULL OR c.estado_pago<>'PAGADO')",
      LIBERADO_PAGO:       "COALESCE(c.liberado_pago,0)=1 AND (c.estado_pago IS NULL OR c.estado_pago<>'PAGADO')",
      FONDOS_LIBERADOS:    "c.estado_pago='PAGADO'",
    };
    if (fEstado && ESTADOS.includes(fEstado)) { whereData += " AND COALESCE(fs.estado,'PENDIENTE') = ?"; fpData.push(fEstado); }
    else if (fEstadoOp && OP_MAP[fEstadoOp]) { whereData += ' AND ' + OP_MAP[fEstadoOp]; }
    else if (!incluirCerrados) whereData += " AND COALESCE(fs.estado,'PENDIENTE') <> 'CERRADO'";
    // Búsqueda por N° OP o ID Financiera (server-side: encuentra aunque esté fuera de las primeras 500).
    const q = String(req.query.q || '').trim();
    if (q) {
      whereData += " AND (REPLACE(c.num_op,'.','') LIKE ? OR c.id_financiera LIKE ?)";
      fpData.push('%' + q.replace(/\./g, '') + '%', '%' + q + '%');
    }
    const [ops] = await pool.query(`
      SELECT c.id AS id_credito, c.num_op, c.financiera, c.id_financiera, c.ejecutivo,
             c.fecha_otorgado, c.gps, c.limitacion, c.saldo_precio,
             c.liberado_pago, DATE_FORMAT(c.fecha_liberado_pago,'%Y-%m-%d') fecha_liberado_pago,
             c.estado_pago, DATE_FORMAT(c.fecha_pago,'%Y-%m-%d') fecha_pago,
             DATEDIFF(CURDATE(), c.fecha_otorgado) AS dias,
             COALESCE(fs.estado,'PENDIENTE') AS estado, fs.comentario_rechazo,
             fs.fecha_envio, fs.fecha_validacion, fs.validado_por
      FROM creditos c LEFT JOIN fundantes_seg fs ON fs.id_credito = c.id
      ${whereData}
      ORDER BY dias DESC, c.num_op DESC
      LIMIT 500`, fpData);

    // Documentos subidos de esas operaciones
    const ids = ops.map(o => o.id_credito);
    let docsPorOp = {};
    if (ids.length) {
      const [docs] = await pool.query(
        `SELECT id, id_credito, codigo, archivo_nombre, created_at FROM fundantes_seg_docs WHERE id_credito IN (?)`, [ids]);
      docs.forEach(d => (docsPorOp[d.id_credito] = docsPorOp[d.id_credito] || {})[d.codigo] = d);
    }

    const data = ops.map(o => {
      const reqs = tiposDeOperacion(o, tiposPorFin);
      const subidos = docsPorOp[o.id_credito] || {};
      const docs = reqs.map(t => {
        const d = subidos[t.codigo];
        return { codigo: t.codigo, nombre: t.nombre, obligatorio: t.obligatorio,
          subido: !!d, doc_id: d ? d.id : null, archivo_nombre: d ? d.archivo_nombre : null };
      });
      const faltan = docs.filter(d => d.obligatorio && !d.subido).length;
      const puede_enviar = (o.estado === 'PENDIENTE' || o.estado === 'RECHAZADO') && faltan === 0;
      return {
        id_credito: o.id_credito, num_op: o.num_op, financiera: o.financiera,
        id_financiera: o.id_financiera, ejecutivo: o.ejecutivo,
        fecha_otorgado: o.fecha_otorgado, dias: Number(o.dias) || 0,
        estado: o.estado, comentario_rechazo: o.comentario_rechazo,
        fecha_envio: o.fecha_envio, fecha_validacion: o.fecha_validacion, validado_por: o.validado_por,
        saldo_precio: Number(o.saldo_precio) || 0,
        liberado_pago: Number(o.liberado_pago) || 0, fecha_liberado_pago: o.fecha_liberado_pago, fecha_pago: o.fecha_pago,
        estado_op: o.estado_pago === 'PAGADO' ? 'FONDOS_LIBERADOS' : (Number(o.liberado_pago) === 1 ? 'LIBERADO_PAGO' : (o.estado === 'CERRADO' ? 'FUNDANTES_RECIBIDOS' : (o.estado === 'ENVIADO' ? 'POR_VALIDAR' : o.estado))),
        docs, faltan, puede_enviar,
      };
    });

    const [ejRows] = await pool.query(
      `SELECT DISTINCT ejecutivo FROM creditos WHERE fecha_otorgado IS NOT NULL AND UPPER(financiera) IN (?) AND ejecutivo IS NOT NULL AND ejecutivo<>'' ORDER BY ejecutivo`, [FINANCIERAS]);
    const ejecutivos = vis.all ? ejRows.map(r => r.ejecutivo) : (vis.lista || []);
    const puede_validar = await tieneFunc(req.usuario.id_usuario, 'fundantes_validar', 'fundantes_operaciones');

    res.json({ success: true, data, resumen, ejecutivos, puede_validar,
      es_ejecutivo: !vis.all, nombre: vis.all ? (fEjec || 'Todos los ejecutivos') : nombreUsuario(req), error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento listar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const matrizVacia = () => ({ pendientes: [0, 0, 0, 0, 0, 0], enviados: [0, 0, 0, 0, 0, 0], total: [0, 0, 0, 0, 0, 0], buckets: BUCKETS.map(b => b.lbl) });

/* ─── helper de propiedad: ¿el usuario puede tocar esta operación? ──────────── */
async function puedeOperar(req, id_credito) {
  if (await tieneFunc(req.usuario.id_usuario, 'fundantes_validar', 'fundantes_operaciones')) return true;   // Operaciones / Admin
  const vis = await ejecutivosVisibles(req);
  if (vis.all) return true;                                                         // ámbito 'todos'
  const [[c]] = await pool.query('SELECT ejecutivo FROM creditos WHERE id=?', [id_credito]);
  // Comparación case-insensitive (el ejecutivo del crédito puede venir en otra caja que el nombre del usuario).
  return !!c && vis.lista.some(x => String(x).toUpperCase() === String(c.ejecutivo || '').toUpperCase());
}

/* ─── POST /api/fundantes-seguimiento/:id/doc — sube (o reemplaza) un documento ── */
const subirDoc = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { codigo, archivo_nombre, mime_type, archivo_data } = req.body || {};
    if (!id || !codigo) return res.status(400).json({ success: false, data: null, error: 'id y codigo requeridos' });
    if (!archivo_data) return res.status(400).json({ success: false, data: null, error: 'Falta el archivo' });
    const [[op]] = await pool.query('SELECT id, financiera FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    if (!(await puedeOperar(req, id))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso sobre esta operación' });
    // El código debe ser un tipo válido de la financiera
    const [[tipo]] = await pool.query('SELECT codigo FROM fundantes_seg_tipos WHERE UPPER(financiera)=? AND codigo=?', [String(op.financiera || '').toUpperCase(), codigo]);
    if (!tipo) return res.status(400).json({ success: false, data: null, error: 'Tipo de documento no válido para esta financiera' });

    const buffer = Buffer.from(archivo_data, 'base64');
    await pool.query(
      `INSERT INTO fundantes_seg_docs (id_credito, codigo, archivo_nombre, mime_type, archivo_data, subido_por, id_subido_por)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE archivo_nombre=VALUES(archivo_nombre), mime_type=VALUES(mime_type),
         archivo_data=VALUES(archivo_data), subido_por=VALUES(subido_por), id_subido_por=VALUES(id_subido_por), created_at=NOW()`,
      [id, codigo, archivo_nombre || null, mime_type || null, buffer, nombreUsuario(req), req.usuario.id_usuario || null]);
    res.json({ success: true, data: { id_credito: id, codigo }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento subirDoc]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── DELETE /api/fundantes-seguimiento/:id/doc/:codigo — quita un documento ── */
const eliminarDoc = async (req, res) => {
  try {
    const id = Number(req.params.id), codigo = String(req.params.codigo || '');
    if (!id || !codigo) return res.status(400).json({ success: false, data: null, error: 'id y codigo requeridos' });
    if (!(await puedeOperar(req, id))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso sobre esta operación' });
    await pool.query('DELETE FROM fundantes_seg_docs WHERE id_credito=? AND codigo=?', [id, codigo]);
    res.json({ success: true, data: { id_credito: id, codigo }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento eliminarDoc]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── GET /api/fundantes-seguimiento/doc/:docId/download ──────────────────── */
const descargar = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT archivo_nombre, mime_type, archivo_data FROM fundantes_seg_docs WHERE id=?', [req.params.docId]);
    if (!row || !row.archivo_data) return res.status(404).json({ success: false, data: null, error: 'Archivo no encontrado' });
    res.set('Content-Type', row.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${String(row.archivo_nombre || 'fundante').replace(/"/g, '').replace(/[^\x20-\x7E]/g, '_')}"`);
    res.send(row.archivo_data);
  } catch (e) {
    console.error('[fundantes-seguimiento descargar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── POST /api/fundantes-seguimiento/:id/enviar — envía a Validación ──────── */
const enviar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id requerido' });
    const [[op]] = await pool.query('SELECT id, num_op, financiera, gps, limitacion FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    if (!(await puedeOperar(req, id))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso sobre esta operación' });
    const [[fs]] = await pool.query('SELECT estado FROM fundantes_seg WHERE id_credito=?', [id]);
    const estado = (fs && fs.estado) || 'PENDIENTE';
    if (estado === 'ENVIADO' || estado === 'CERRADO')
      return res.status(409).json({ success: false, data: null, error: 'La operación ya fue enviada' });

    // Verifica que estén todos los obligatorios (server-side)
    const [tipos] = await pool.query('SELECT codigo, nombre, obligatorio, requiere_contrato FROM fundantes_seg_tipos WHERE UPPER(financiera)=?', [String(op.financiera || '').toUpperCase()]);
    const oblig = tipos.filter(t => t.requiere_contrato ? contratado(op[t.requiere_contrato]) : !!t.obligatorio).map(t => t.codigo);
    const [subidos] = await pool.query('SELECT codigo FROM fundantes_seg_docs WHERE id_credito=?', [id]);
    const set = new Set(subidos.map(s => s.codigo));
    const faltan = oblig.filter(c => !set.has(c));
    if (faltan.length) return res.status(400).json({ success: false, data: null, error: 'Faltan documentos obligatorios por subir' });

    await pool.query(
      `INSERT INTO fundantes_seg (id_credito, estado, comentario_rechazo, fecha_envio, enviado_por, id_enviado_por)
       VALUES (?, 'ENVIADO', NULL, NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE estado='ENVIADO', comentario_rechazo=NULL, fecha_envio=NOW(), enviado_por=VALUES(enviado_por), id_enviado_por=VALUES(id_enviado_por)`,
      [id, nombreUsuario(req), req.usuario.id_usuario || null]);
    auditar({ req, accion: 'ENVIAR_FUNDANTES', modulo: 'fundantes-seguimiento', entidad: 'credito', entidad_id: id,
      detalle: `Envió a validación los fundantes de la OP ${op.num_op}` });
    // Alerta al pool de Operaciones: llegaron fundantes para validar.
    try {
      const pooln = await idsOperaciones(req.usuario.id_usuario);
      if (pooln.length) await notificar(pooln, {
        tipo: 'fundantes', titulo: 'Fundantes por validar',
        mensaje: `${nombreUsuario(req)} envió los fundantes de la OP ${op.num_op} (${op.financiera || ''}).`,
        href: '/fundantes-operaciones/', prioridad: 'normal', sonar: true, clave: 'fund_env_' + id });
    } catch (_) {}
    res.json({ success: true, data: { id_credito: id, estado: 'ENVIADO' }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento enviar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── POST /api/fundantes-seguimiento/:id/validar — Operaciones aprueba/rechaza ──
   { accion:'aprobar'|'rechazar', comentario }. Rechazo exige comentario. (route: requireFunc fundantes_validar) */
const validar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const accion = String((req.body || {}).accion || '').toLowerCase();
    const comentario = String((req.body || {}).comentario || '').trim();
    if (!id || !['aprobar', 'rechazar'].includes(accion))
      return res.status(400).json({ success: false, data: null, error: 'accion debe ser aprobar o rechazar' });
    if (accion === 'rechazar' && !comentario)
      return res.status(400).json({ success: false, data: null, error: 'El rechazo requiere un comentario' });
    const [[op]] = await pool.query('SELECT id, num_op, financiera FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    const [[fs]] = await pool.query('SELECT estado, id_enviado_por FROM fundantes_seg WHERE id_credito=?', [id]);
    if (!fs || fs.estado !== 'ENVIADO')
      return res.status(409).json({ success: false, data: null, error: 'Sólo se pueden validar operaciones ENVIADAS' });

    const estado = accion === 'aprobar' ? 'CERRADO' : 'RECHAZADO';
    await pool.query(
      `UPDATE fundantes_seg SET estado=?, comentario_rechazo=?, fecha_validacion=NOW(), validado_por=?, id_validado_por=? WHERE id_credito=?`,
      [estado, accion === 'rechazar' ? comentario : null, nombreUsuario(req), req.usuario.id_usuario || null, id]);
    auditar({ req, accion: accion === 'aprobar' ? 'APROBAR_FUNDANTES' : 'RECHAZAR_FUNDANTES', modulo: 'fundantes-seguimiento', entidad: 'credito', entidad_id: id,
      detalle: `${accion === 'aprobar' ? 'Aprobó (CERRADO)' : 'Rechazó'} los fundantes de la OP ${op.num_op}${comentario ? ' — ' + comentario : ''}`, meta: { estado, comentario: comentario || null } });
    // Al APROBAR fundantes: marca automáticamente la etapa "FUNDANTES RECIBIDOS" del Post Venta
    // (Seguimiento Saldo Precio), para no tener que marcarla a mano. Idempotente.
    if (accion === 'aprobar') {
      try {
        const [[seg]] = await pool.query('SELECT id FROM postventa_seguimiento WHERE id_credito=? LIMIT 1', [id]);
        if (seg) await pool.query(
          `INSERT INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES (?, 'SALDO', 'FUNDANTES RECIBIDOS', ?)
           ON DUPLICATE KEY UPDATE id_seguimiento = id_seguimiento`,
          [seg.id, nombreUsuario(req)]);
      } catch (e) { console.error('[fundantes→postventa FUNDANTES RECIBIDOS]', e.message); }
    }
    // Alerta al ejecutivo que envió: rechazo (con el motivo) → debe corregir y reenviar.
    if (accion === 'rechazar' && fs.id_enviado_por) {
      try { await notificar([fs.id_enviado_por], {
        tipo: 'fundantes', titulo: 'Fundantes rechazados',
        mensaje: `Operaciones rechazó los fundantes de la OP ${op.num_op}: ${comentario}`,
        href: '/fundantes-seguimiento/', prioridad: 'alta', sonar: true, clave: 'fund_rec_' + id }); } catch (_) {}
    }
    res.json({ success: true, data: { id_credito: id, estado }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento validar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── ZIP "store" mínimo (sin dependencias) para "Descargar Todos" ──────────── */
const _crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files) {                       // files: [{ name, buf }]  (método 0 = sin compresión)
  const parts = [], central = []; let offset = 0;
  const T = 0, D = 0x21;                          // hora/fecha DOS fijas (1980-01-01)
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = f.buf, crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(T, 10); lh.writeUInt16LE(D, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(T, 12); ch.writeUInt16LE(D, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cBuf, end]);
}
const DOC_LABEL = { CONTRATO_CV: 'COMPRAVENTA', SOL_TRANSFERENCIA: 'TRANSFERENCIA', SOL_LIMITACION: 'LIMITACION', INFORME_GPS: 'GPS' };
const extDe = (nombre, mime) => {
  const m = String(nombre || '').match(/\.([a-z0-9]{1,5})$/i); if (m) return '.' + m[1].toLowerCase();
  const mm = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png' };
  return mm[String(mime || '').toLowerCase()] || '.bin';
};
const sanitizeFn = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();

/* ─── GET /api/fundantes-seguimiento/:id/zip — "Descargar Todos" (carpeta + archivos renombrados) ── */
const descargarZip = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[op]] = await pool.query('SELECT num_op, financiera, id_financiera FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    const [docs] = await pool.query('SELECT codigo, archivo_nombre, mime_type, archivo_data FROM fundantes_seg_docs WHERE id_credito=? AND archivo_data IS NOT NULL', [id]);
    if (!docs.length) return res.status(404).json({ success: false, data: null, error: 'No hay documentos para descargar' });
    const idf = op.id_financiera || op.num_op || id;
    const carpeta = sanitizeFn(`Fundantes ${op.financiera || ''} ID${idf}`);
    const files = docs.map(d => ({
      name: `${carpeta}/${sanitizeFn((DOC_LABEL[d.codigo] || d.codigo) + ' ID' + idf)}${extDe(d.archivo_nombre, d.mime_type)}`,
      buf: d.archivo_data,
    }));
    const zip = zipStore(files);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${carpeta}.zip"`);
    res.send(zip);
  } catch (e) {
    console.error('[fundantes-seguimiento descargarZip]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Resumen diario: operaciones LIBERADAS A PAGO o FONDOS LIBERADOS por fecha ──
   tipo=liberado → liberado_pago=1 (fecha_liberado_pago); tipo=pagado → estado_pago='PAGADO' (fecha_pago).
   Devuelve, por día: detalle (num_op, ejecutivo, financiera, id_financiera, saldo_precio) + N° ops + suma de saldo precio. */
const resumen = async (req, res) => {
  try {
    const tipo = String(req.query.tipo || 'liberado').toLowerCase() === 'pagado' ? 'pagado' : 'liberado';
    const fechaCol = tipo === 'pagado' ? 'c.fecha_pago' : 'c.fecha_liberado_pago';
    const cond = tipo === 'pagado' ? "c.estado_pago='PAGADO'" : 'COALESCE(c.liberado_pago,0)=1';

    const vis = await ejecutivosVisibles(req);
    const filt = ['UPPER(c.financiera) IN (?)', cond, `${fechaCol} IS NOT NULL`];
    const fp = [FINANCIERAS];
    if (!vis.all) {
      if (!vis.lista.length) return res.json({ success: true, data: { tipo, dias: [], total_ops: 0, total_monto: 0 }, error: null });
      filt.push('c.ejecutivo IN (?)'); fp.push(vis.lista);
    } else if (req.query.ejecutivo) { filt.push('c.ejecutivo = ?'); fp.push(req.query.ejecutivo); }
    const fFin = String(req.query.financiera || '').trim().toUpperCase();
    if (fFin && FINANCIERAS.includes(fFin)) { filt.push('UPPER(c.financiera) = ?'); fp.push(fFin); }
    if (req.query.desde) { filt.push(`${fechaCol} >= ?`); fp.push(req.query.desde); }
    if (req.query.hasta) { filt.push(`${fechaCol} <= ?`); fp.push(req.query.hasta); }

    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(${fechaCol},'%Y-%m-%d') fecha, c.num_op, c.financiera, c.id_financiera, c.ejecutivo, c.saldo_precio
         FROM creditos c WHERE ${filt.join(' AND ')}
        ORDER BY ${fechaCol} DESC, c.num_op DESC LIMIT 3000`, fp);

    const map = new Map(); let totOps = 0, totMonto = 0;
    rows.forEach(r => {
      if (!map.has(r.fecha)) map.set(r.fecha, { fecha: r.fecha, ops: [], n: 0, monto: 0 });
      const g = map.get(r.fecha); const sp = Number(r.saldo_precio) || 0;
      g.ops.push({ num_op: r.num_op, financiera: r.financiera, id_financiera: r.id_financiera, ejecutivo: r.ejecutivo, saldo_precio: sp });
      g.n++; g.monto += sp; totOps++; totMonto += sp;
    });
    res.json({ success: true, data: { tipo, dias: [...map.values()], total_ops: totOps, total_monto: totMonto }, error: null });
  } catch (e) { console.error('[fundantes-seguimiento resumen]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { listar, resumen, subirDoc, eliminarDoc, descargar, descargarZip, enviar, validar };
