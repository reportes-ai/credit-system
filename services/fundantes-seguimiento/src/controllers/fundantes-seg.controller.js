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
const almacen = require('../../../../shared/almacen-docs');

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
require('../../../../shared/migrate').enFila('fundantes-seg', async () => {
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
    /* Devolución de la FINANCIERA: distinta del rechazo interno de Operaciones.
       La operación ya estaba cerrada y enviada, pero la financiera la devuelve →
       vuelve a PENDIENTE para que el ejecutivo corrija, y queda marcada para la
       card "Fundantes Devueltos". El estado NO alcanza: al volver a PENDIENTE se
       confundiría con una operación que nunca se envió. */
    for (const ddl of [
      "ALTER TABLE fundantes_seg ADD COLUMN devuelto_fin TINYINT NOT NULL DEFAULT 0",
      "ALTER TABLE fundantes_seg ADD COLUMN devuelto_motivo VARCHAR(600) NULL",
      "ALTER TABLE fundantes_seg ADD COLUMN devuelto_at DATETIME NULL",
      "ALTER TABLE fundantes_seg ADD COLUMN devuelto_por VARCHAR(150) NULL",
      "ALTER TABLE fundantes_seg ADD COLUMN devoluciones INT NOT NULL DEFAULT 0",
      /* SIN LIMITACIÓN (20-08-2026): el ejecutivo puede declarar que la operación
         AUTOFIN se envía sin Solicitud de Limitación. Deja de exigirse ese
         documento para enviar, la revisión de Operaciones lo ve en grande, y la
         Orden de Pago del saldo precio EXCLUYE el monto de Limitación de Dominio. */
      "ALTER TABLE fundantes_seg ADD COLUMN sin_limitacion TINYINT NOT NULL DEFAULT 0",
      "ALTER TABLE fundantes_seg ADD COLUMN sin_limitacion_por VARCHAR(150) NULL",
      "ALTER TABLE fundantes_seg ADD COLUMN sin_limitacion_at DATETIME NULL",
    ]) { try { await pool.query(ddl); } catch (e) { if (e.errno !== 1060) console.error('[fundantes devolucion]', e.message); } }
    /* Bitácora de gestión: comentarios manuales sobre el estado de la operación
       (qué se conversó con la financiera, qué falta, con quién se está viendo).
       La traza automática de qué pasó ya vive en auditoria_movimientos — esta
       tabla guarda SOLO lo que la persona aporta, y la vista une ambas. */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fundantes_bitacora (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        id_credito INT NOT NULL,
        comentario TEXT NOT NULL,
        autor      VARCHAR(150), id_autor INT,
        created_at DATETIME DEFAULT NOW(),
        INDEX idx_cred (id_credito)
      )`);
    /* Log del pop-up semanal al ejecutivo: una fila por comentario grabado desde
       el pop-up (usuario × operación). Con esto se sabe qué operación ya rindió
       cuentas esta semana y cuándo fue el último pop-up (espera entre casos). */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fundantes_popup_log (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario INT NOT NULL,
        id_credito INT NOT NULL,
        created_at DATETIME DEFAULT NOW(),
        INDEX idx_usr (id_usuario, created_at),
        INDEX idx_cred (id_credito, created_at)
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
    /* Dónde vive el archivo (shared/almacen-docs.js). Esta es la tabla más pesada
       del sistema: 62 archivos ocupaban 63,9 MB, más que TODA la operación del
       negocio junta. Con `doc_ruta` el PDF se va al bucket y la fila queda de
       unos pocos bytes. `archivo_data` se conserva porque las filas viejas siguen
       ahí hasta que el barrido las mueve, y porque sin bucket configurado (local,
       staging, contingencia sin credenciales) se sigue guardando en la base. */
    for (const ddl of almacen.sqlColumnas('fundantes_seg_docs')) {
      try { await pool.query(ddl); } catch (e) { if (e.errno !== 1060) console.error('[fundantes docs almacen]', e.message); }
    }
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
      ['AUTOFIN', 'INFORME_GPS', 'Informe GPS', 0, null, 4],   // opcional desde 05-08-2026
      ['UNIDAD DE CREDITO', 'CONTRATO_CV', 'Contrato Compraventa', 1, null, 1],
      ['UNIDAD DE CREDITO', 'SOL_TRANSFERENCIA', 'Solicitud Transferencia', 1, null, 2],
    ];
    for (const s of seed)
      await pool.query(
        `INSERT IGNORE INTO fundantes_seg_tipos (financiera, codigo, nombre, obligatorio, requiere_contrato, orden) VALUES (?,?,?,?,?,?)`, s);
    // Corrección: en AUTOFIN la Solicitud de Limitación es SIEMPRE obligatoria (no condicional). Idempotente.
    await pool.query("UPDATE fundantes_seg_tipos SET obligatorio=1, requiere_contrato=NULL WHERE financiera='AUTOFIN' AND codigo='SOL_LIMITACION'");
    // El Informe GPS pasa a ser OPCIONAL (Pato, 05-08-2026): se sigue pudiendo
    // subir y queda a la vista, pero ya no traba el envío a validación. Antes
    // era obligatorio-si-contratado y dejaba operaciones frenadas por un
    // documento que no siempre llega a tiempo. Idempotente.
    await pool.query("UPDATE fundantes_seg_tipos SET obligatorio=0, requiere_contrato=NULL WHERE codigo='INFORME_GPS'");

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
      ['Historial de Fundantes', 'fundantes_historial', '/fundantes-seguimiento/historial', 'bi-clock-history'],
      ['Bitácora Fundantes Atrasados', 'fundantes_bitacora_atrasados', '/fundantes-seguimiento/bitacora-atrasados', 'bi-chat-left-text'],
      ['Documentos Fundantes (mantenedor)', 'fundantes_tipos', '/mantenedores/fundantes-tipos/', 'bi-sliders'],
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
    // El Historial y la Bitácora de Atrasados heredan el mismo acceso que
    // Operaciones (además del Admin ya sembrado): son vistas de supervisión.
    for (const cod of ['fundantes_historial', 'fundantes_bitacora_atrasados']) {
      if (idFunc[cod] && idFunc['fundantes_operaciones']) {
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
           SELECT id_perfil, ?, 1 FROM permisos_perfil WHERE id_funcionalidad=? AND habilitado=1`,
          [idFunc[cod], idFunc['fundantes_operaciones']]);
      }
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
});

/* ─── helpers ─────────────────────────────────────────────────────────────── */
const nombreUsuario = req => (req.usuario && `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim()) ||
  (req.usuario && req.usuario.email) || 'Sistema';
// ¿el campo contratado (gps/limitacion) viene "con el crédito"?  null/0/'' → no contratado.
const contratado = v => { const s = String(v == null ? '' : v).trim(); return s !== '' && s !== '0' && Number(s) !== 0; };

// Visibilidad por ejecutivo: regla central paramétrica (shared/visibilidad-ejecutivos),
// por ámbito del perfil ('todos' | 'asignados'). Soporta varios supervisores.
async function ejecutivosVisibles(req) { return _visEjec(req.usuario); }

// Quién se entera de que llegaron fundantes a validar: mantenedor Avisos.
const AVISOS = require('../../../../shared/avisos');
AVISOS.registrarAviso({
  evento: 'fundantes_validar', nombre: 'Fundantes por validar', modulo: 'Fundantes',
  descripcion: 'Un ejecutivo envía los documentos fundantes de una operación a validación. Avisa al pool de Operaciones.',
  base_func: 'fundantes_validar,fundantes_operaciones', prioridad: 'normal', sonido_tipo: 'campana',
});

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
    /* Solo operaciones con etapa OTORGADO. `fecha_otorgado` NO alcanza: viene
       poblada también en aprobadas sin cursar, rechazadas y desistidas (hoy 3.161
       APROBADAS la tienen), que se colaban a la cola pidiendo fundantes de un
       negocio que nunca existió. La etapa manda. (31-07-2026) */
    const filt = ['c.fecha_otorgado IS NOT NULL', "UPPER(COALESCE(c.estado_credito,'')) = 'OTORGADO'",
                  'UPPER(c.financiera) IN (?)'];
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
             fs.fecha_envio, fs.fecha_validacion, fs.validado_por,
             COALESCE(fs.sin_limitacion,0) AS sin_limitacion
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
      const sinLim = Number(o.sin_limitacion) === 1;
      const docs = reqs.map(t => {
        const d = subidos[t.codigo];
        // Declarada SIN LIMITACIÓN: la Solicitud de Limitación deja de exigirse.
        const oblig = (sinLim && t.codigo === 'SOL_LIMITACION') ? false : t.obligatorio;
        return { codigo: t.codigo, nombre: t.nombre, obligatorio: oblig,
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
        docs, faltan, puede_enviar, sin_limitacion: sinLim ? 1 : 0,
      };
    });

    const [ejRows] = await pool.query(
      `SELECT DISTINCT ejecutivo FROM creditos WHERE fecha_otorgado IS NOT NULL
         AND UPPER(COALESCE(estado_credito,'')) = 'OTORGADO'
         AND UPPER(financiera) IN (?) AND ejecutivo IS NOT NULL AND ejecutivo<>'' ORDER BY ejecutivo`, [FINANCIERAS]);
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
    /* Reemplazo: hay que quedarse con la ruta ANTERIOR antes de pisarla, o el
       objeto viejo queda huérfano en el bucket para siempre. */
    const [[previo]] = await pool.query('SELECT doc_ruta FROM fundantes_seg_docs WHERE id_credito=? AND codigo=?', [id, codigo]);
    const d = await almacen.colocar({ ambito: 'fundantes', clave: id, buffer, mime: mime_type, nombre: archivo_nombre || codigo });
    await pool.query(
      `INSERT INTO fundantes_seg_docs (id_credito, codigo, archivo_nombre, mime_type, archivo_data, doc_storage, doc_ruta, doc_bytes, subido_por, id_subido_por)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE archivo_nombre=VALUES(archivo_nombre), mime_type=VALUES(mime_type),
         archivo_data=VALUES(archivo_data), doc_storage=VALUES(doc_storage), doc_ruta=VALUES(doc_ruta), doc_bytes=VALUES(doc_bytes),
         subido_por=VALUES(subido_por), id_subido_por=VALUES(id_subido_por), created_at=NOW()`,
      [id, codigo, archivo_nombre || null, mime_type || null, d.blob, d.storage, d.ruta, d.bytes, nombreUsuario(req), req.usuario.id_usuario || null]);
    /* Recién ahora, con la fila ya apuntando al archivo nuevo: si esto falla lo
       peor que queda es un objeto de más, nunca un documento inaccesible. */
    if (previo && previo.doc_ruta && previo.doc_ruta !== d.ruta) await almacen.borrar(previo.doc_ruta);
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
    const [[doc]] = await pool.query('SELECT doc_ruta FROM fundantes_seg_docs WHERE id_credito=? AND codigo=?', [id, codigo]);
    await pool.query('DELETE FROM fundantes_seg_docs WHERE id_credito=? AND codigo=?', [id, codigo]);
    /* La fila manda: borrada la fila el documento ya no existe para el sistema.
       El objeto se limpia después y sin bloquear —y el bucket tiene versionado,
       así que un borrado por error todavía se puede revertir. */
    if (doc && doc.doc_ruta) await almacen.borrar(doc.doc_ruta);
    res.json({ success: true, data: { id_credito: id, codigo }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento eliminarDoc]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── GET /api/fundantes-seguimiento/doc/:docId/download ──────────────────── */
const descargar = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT archivo_nombre, mime_type, archivo_data, doc_ruta FROM fundantes_seg_docs WHERE id=?', [req.params.docId]);
    if (!row) return res.status(404).json({ success: false, data: null, error: 'Archivo no encontrado' });
    await almacen.servir(res, { ruta: row.doc_ruta, blob: row.archivo_data, nombre: row.archivo_nombre || 'fundante', mime: row.mime_type });
  } catch (e) {
    console.error('[fundantes-seguimiento descargar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── POST /api/fundantes-seguimiento/:id/sin-limitacion ─────────────────────
   El ejecutivo declara que la operación AUTOFIN va SIN Solicitud de Limitación
   (o lo deshace con valor:0). Solo mientras la operación sea editable; queda en
   bitácora y auditoría, y aguas abajo la ODP excluye el monto de Limitación. */
const marcarSinLimitacion = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const valor = Number((req.body || {}).valor) ? 1 : 0;
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id requerido' });
    const [[op]] = await pool.query('SELECT id, num_op, financiera FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    if (String(op.financiera || '').toUpperCase() !== 'AUTOFIN')
      return res.status(400).json({ success: false, data: null, error: 'Solo aplica a operaciones AUTOFIN' });
    if (!(await puedeOperar(req, id))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso sobre esta operación' });
    const [[fs]] = await pool.query('SELECT estado FROM fundantes_seg WHERE id_credito=?', [id]);
    const estado = (fs && fs.estado) || 'PENDIENTE';
    if (estado === 'ENVIADO' || estado === 'CERRADO')
      return res.status(409).json({ success: false, data: null, error: 'La operación ya fue enviada — no se puede cambiar' });
    await pool.query(
      `INSERT INTO fundantes_seg (id_credito, estado, sin_limitacion, sin_limitacion_por, sin_limitacion_at)
       VALUES (?, 'PENDIENTE', ?, ?, NOW())
       ON DUPLICATE KEY UPDATE sin_limitacion=VALUES(sin_limitacion),
         sin_limitacion_por=VALUES(sin_limitacion_por), sin_limitacion_at=NOW()`,
      [id, valor, nombreUsuario(req)]);
    await pool.query('INSERT INTO fundantes_bitacora (id_credito, comentario, autor, id_autor) VALUES (?,?,?,?)',
      [id, valor ? 'Declaró el envío SIN LIMITACIÓN (no se exigirá la Solicitud de Limitación y la ODP excluirá su monto).'
                 : 'Deshizo el SIN LIMITACIÓN: la Solicitud de Limitación vuelve a exigirse.',
       nombreUsuario(req), req.usuario.id_usuario || null]).catch(() => {});
    auditar({ req, accion: valor ? 'SIN_LIMITACION' : 'SIN_LIMITACION_DESHECHO', modulo: 'fundantes-seguimiento',
      entidad: 'credito', entidad_id: id, detalle: `OP ${op.num_op} — ${valor ? 'declarada SIN LIMITACIÓN' : 'SIN LIMITACIÓN deshecho'}` });
    res.json({ success: true, data: { id_credito: id, sin_limitacion: valor }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento sin-limitacion]', e.message);
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
    const [[fs]] = await pool.query('SELECT estado, sin_limitacion FROM fundantes_seg WHERE id_credito=?', [id]);
    const estado = (fs && fs.estado) || 'PENDIENTE';
    if (estado === 'ENVIADO' || estado === 'CERRADO')
      return res.status(409).json({ success: false, data: null, error: 'La operación ya fue enviada' });
    const sinLim = Number(fs && fs.sin_limitacion) === 1;

    // Verifica que estén todos los obligatorios (server-side)
    const [tipos] = await pool.query('SELECT codigo, nombre, obligatorio, requiere_contrato FROM fundantes_seg_tipos WHERE UPPER(financiera)=?', [String(op.financiera || '').toUpperCase()]);
    const oblig = tipos.filter(t => t.requiere_contrato ? contratado(op[t.requiere_contrato]) : !!t.obligatorio)
      .map(t => t.codigo)
      // Declarada SIN LIMITACIÓN: la Solicitud de Limitación no traba el envío.
      .filter(c => !(sinLim && c === 'SOL_LIMITACION'));
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
      detalle: `Envió a validación los fundantes de la OP ${op.num_op}${sinLim ? ' — SIN LIMITACIÓN' : ''}` });
    // Si venía DEVUELTA por la financiera, el pendiente de corregir ya se cumplió.
    AVISOS.retirar('fund_dev_' + id).catch(() => {});
    // Alerta al pool de Operaciones: llegaron fundantes para validar.
    try {
      await AVISOS.avisar('fundantes_validar', {
        tipo: 'fundantes', titulo: 'Fundantes por validar',
        mensaje: `${nombreUsuario(req)} envió los fundantes de la OP ${op.num_op} (${op.financiera || ''})${sinLim ? ' — SIN LIMITACIÓN' : ''}.`,
        href: '/fundantes-operaciones/', clave: 'fund_env_' + id },
        { excluir: [req.usuario.id_usuario] });
    } catch (_) {}
    res.json({ success: true, data: { id_credito: id, estado: 'ENVIADO' }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento enviar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── POST /api/fundantes-seguimiento/:id/validar — Operaciones aprueba/rechaza ──
   { accion:'aprobar'|'rechazar', comentario }. Rechazo exige comentario. (route: requireFunc fundantes_validar) */
AVISOS.registrarAviso({
  evento: 'fundantes_devuelto', nombre: 'Fundantes DEVUELTOS por la financiera', modulo: 'Fundantes',
  descripcion: 'La financiera devolvió los fundantes de una operación ya enviada. Vuelve a PENDIENTE y el ejecutivo debe corregir y reenviar.',
  dirigido_a: 'el ejecutivo dueño de la operación (más su suplente, si tiene Alertas activas)',
  base_func: 'fundantes_seguimiento,fundantes_validar,fundantes_operaciones', prioridad: 'alta', sonido_tipo: 'dingdong',
});

/* ─── POST /api/fundantes-seguimiento/:id/devolver ────────────────────────────
   La FINANCIERA devuelve los fundantes de una operación que ya habíamos cerrado
   y enviado. Distinto del rechazo interno de Operaciones (que ocurre ANTES de
   salir). Vuelve a PENDIENTE —para que el ejecutivo corrija y reenvíe— y queda
   marcada como devuelta, que es lo que alimenta la card "Fundantes Devueltos".  */
const devolver = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const motivo = String((req.body || {}).motivo || '').trim();
    if (!id) return res.status(400).json({ success: false, data: null, error: 'Operación inválida' });
    if (!motivo) return res.status(400).json({ success: false, data: null, error: 'Indica el motivo por el que la financiera devolvió los fundantes.' });
    const [[op]] = await pool.query('SELECT id, num_op, financiera, ejecutivo FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    const [[fs]] = await pool.query('SELECT estado, id_enviado_por FROM fundantes_seg WHERE id_credito=?', [id]);
    const estadoActual = (fs && fs.estado) || 'PENDIENTE';
    if (estadoActual === 'PENDIENTE')
      return res.status(409).json({ success: false, data: null, error: 'La operación ya está en Fundantes Pendientes.' });

    await pool.query(
      `INSERT INTO fundantes_seg (id_credito, estado, devuelto_fin, devuelto_motivo, devuelto_at, devuelto_por, devoluciones)
       VALUES (?, 'PENDIENTE', 1, ?, NOW(), ?, 1)
       ON DUPLICATE KEY UPDATE estado='PENDIENTE', devuelto_fin=1, devuelto_motivo=VALUES(devuelto_motivo),
         devuelto_at=NOW(), devuelto_por=VALUES(devuelto_por), devoluciones=devoluciones+1,
         fecha_validacion=NULL, validado_por=NULL, id_validado_por=NULL`,
      [id, motivo, nombreUsuario(req)]);

    AVISOS.retirar('fund_env_' + id).catch(() => {});
    /* Reflejo en Post Venta → Seguimiento: se desmarcan FUNDANTES RECIBIDOS y
       ENVIADOS del track SALDO y las celdas quedan con "DEVUELTOS" + fecha. */
    require('../../../postventa/src/controllers/postventa.controller')
      .marcarFundantesDevueltos(id, nombreUsuario(req), motivo)
      .catch(e => console.error('[fundantes devolver→postventa]', e.message));
    auditar({ req, accion: 'DEVOLVER_FUNDANTES', modulo: 'fundantes-seguimiento', entidad: 'credito', entidad_id: id,
      detalle: `La financiera devolvió los fundantes de la OP ${op.num_op} (estaba en ${estadoActual}) — ${motivo}`,
      meta: { estado_anterior: estadoActual, motivo } });

    /* AVISO DIRIGIDO al ejecutivo DUEÑO de la operación (decisión de Pato,
       03-08-2026). Antes iba a todo el que tuviera la funcionalidad: 17 personas
       por una operación de una sola — 12 ejecutivos que no tenían nada que ver.
       Si el ejecutivo está ausente, lo cubre su suplente: notificar() expande por
       `usuario_backups` cuando la categoría Alertas está activa.
       Si el nombre NO resuelve a un usuario (placeholder tipo "AUTOFACIL DIRECTO",
       ex-empleado, u homónimos), NO se pierde el aviso: cae al pool de siempre. */
    (async () => {
      let soloA = null;
      try {
        const uid = await require('../../../../shared/ejecutivo-usuario').idUsuarioDeEjecutivo(op.ejecutivo);
        if (uid) soloA = [uid];
        else console.warn(`[fundantes devolver] OP ${op.num_op}: no se pudo identificar al ejecutivo "${op.ejecutivo || ''}" — el aviso va al pool`);
      } catch (e) { console.error('[fundantes devolver ejecutivo]', e.message); }

      await AVISOS.avisar('fundantes_devuelto', {
        titulo: '↩️ Fundantes devueltos por la financiera — OP ' + op.num_op,
        mensaje: `${op.financiera || 'La financiera'} devolvió los fundantes de la OP ${op.num_op}`
          + (op.ejecutivo ? ` (ejecutivo: ${op.ejecutivo})` : '')
          + `. Motivo: ${motivo}. La operación volvió a Fundantes Pendientes para corregir y reenviar.`,
        href: '/fundantes-seguimiento/',
        // clave del hecho: se retira cuando el ejecutivo corrige y reenvía.
        clave: 'fund_dev_' + id,
      }, {
        excluir: [req.usuario.id_usuario],
        extra: fs && fs.id_enviado_por ? [fs.id_enviado_por] : [],
        soloA,
      });
    })().catch(() => {});

    res.json({ success: true, data: { estado: 'PENDIENTE', estado_anterior: estadoActual }, error: null });
  } catch (e) { console.error('[fundantes devolver]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ─── GET /api/fundantes-seguimiento/devueltos ────────────────────────────────
   Listado de TODAS las operaciones que la financiera devolvió alguna vez, con su
   estado ACTUAL en el flujo de fundantes (el mismo de Fundantes Pendientes).
   No se sacan de la lista al corregirse: la marca queda como historia para saber
   por qué se demoró cada operación (la bitácora guarda el detalle). */
const devueltos = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id AS id_credito, c.num_op, c.id_financiera, c.financiera, c.ejecutivo,
             cl.rut AS rut_cliente,
             -- nombre_completo es la columna poblada (18.604 de 18.619); los campos
             -- separados solo existen en 13.139. Se concatena únicamente si falta.
             COALESCE(NULLIF(cl.nombre_completo,''),
                      NULLIF(TRIM(CONCAT(COALESCE(cl.nombres,''),' ',COALESCE(cl.apellido_paterno,''),' ',COALESCE(cl.apellido_materno,''))),'')) AS cliente,
             COALESCE(c.automotora,'') AS dealer, COALESCE(c.parque,'') AS parque,
             c.monto_financiado, c.saldo_precio, c.fecha_otorgado,
             fs.devuelto_motivo, fs.devuelto_at, fs.devuelto_por, fs.devoluciones,
             COALESCE(fs.estado,'PENDIENTE') AS estado
        FROM fundantes_seg fs
        JOIN creditos c   ON c.id = fs.id_credito
        LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
       WHERE fs.devuelto_fin = 1
       ORDER BY fs.devuelto_at DESC`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[fundantes devueltos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ─── Pop-up semanal de rendición al ejecutivo ────────────────────────────────
   Una vez a la semana (paramétrico en Mantenedores → Correos Programados, fila
   "Pop-up Fundantes Pendientes") a cada EJECUTIVO con fundantes pendientes se le
   muestra un pop-up bloqueante que lo obliga a comentar el estado de UNA de sus
   operaciones (mínimo N palabras). El comentario va a la bitácora de la OP.
   Si tiene más casos, el siguiente pop-up espera X horas. Solo aplica a usuarios
   con visibilidad acotada (ejecutivos); Admin/Gerencia nunca lo ven.            */
async function popupConfig() {
  try {
    const [[r]] = await pool.query(
      "SELECT activo, dias, params FROM correos_programados WHERE codigo='popup_fundantes_pendientes'");
    if (!r || !r.activo) return null;
    const p = typeof r.params === 'string' ? JSON.parse(r.params || '{}') : (r.params || {});
    const v = (k, d) => Number((p[k] && p[k].valor) != null ? p[k].valor : d) || d;
    return { dias: String(r.dias || '1,2,3,4,5').split(',').map(s => s.trim()),
             frecuencia_dias: v('frecuencia_dias', 7), espera_horas: v('espera_horas', 2), min_palabras: v('min_palabras', 3) };
  } catch (_) { return null; }
}
const dowChile = () => {
  const d = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', weekday: 'short' }).format(new Date());
  return String({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[d] || 0);
};

/* GET /popup → el caso que el ejecutivo debe comentar ahora, o null. */
const popup = async (req, res) => {
  const nada = () => res.json({ success: true, data: null, error: null });
  try {
    const cfg = await popupConfig();
    if (!cfg || !cfg.dias.includes(dowChile())) return nada();
    const vis = await ejecutivosVisibles(req);
    if (vis.all || !vis.lista || !vis.lista.length) return nada();      // solo ejecutivos acotados
    // Espera entre casos: desde el último comentario grabado vía pop-up.
    const [[ult]] = await pool.query(
      'SELECT MAX(created_at) t FROM fundantes_popup_log WHERE id_usuario=?', [req.usuario.id_usuario]);
    if (ult && ult.t && (Date.now() - new Date(ult.t).getTime()) < cfg.espera_horas * 3600e3) return nada();
    // La operación pendiente más antigua que no ha rendido cuentas esta semana.
    const [[op]] = await pool.query(`
      SELECT c.id, c.num_op, c.id_financiera, c.financiera, c.fecha_otorgado,
             DATEDIFF(CURDATE(), c.fecha_otorgado) AS dias_pendiente,
             COALESCE(c.automotora,'') AS dealer, fs.devuelto_motivo
        FROM creditos c LEFT JOIN fundantes_seg fs ON fs.id_credito = c.id
       WHERE c.fecha_otorgado IS NOT NULL
         AND UPPER(COALESCE(c.estado_credito,'')) = 'OTORGADO'
         AND UPPER(c.financiera) IN (?)
         AND COALESCE(fs.estado,'PENDIENTE') = 'PENDIENTE'
         AND UPPER(c.ejecutivo) IN (?)
         AND NOT EXISTS (SELECT 1 FROM fundantes_popup_log l
                          WHERE l.id_credito = c.id AND l.id_usuario = ?
                            AND l.created_at > DATE_SUB(NOW(), INTERVAL ? DAY))
       ORDER BY c.fecha_otorgado ASC LIMIT 1`,
      [FINANCIERAS, vis.lista.map(x => String(x).toUpperCase()), req.usuario.id_usuario, cfg.frecuencia_dias]);
    if (!op) return nada();
    res.json({ success: true, data: { ...op, min_palabras: cfg.min_palabras }, error: null });
  } catch (e) { console.error('[fundantes popup]', e.message); nada(); }
};

/* POST /popup/:id/comentar → graba el comentario obligatorio en la bitácora. */
const popupComentar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const comentario = String((req.body || {}).comentario || '').trim();
    const cfg = await popupConfig();
    const min = (cfg && cfg.min_palabras) || 3;
    if (!id) return res.status(400).json({ success: false, data: null, error: 'Operación inválida' });
    if (comentario.split(/\s+/).filter(Boolean).length < min)
      return res.status(400).json({ success: false, data: null, error: `El comentario debe tener al menos ${min} palabras.` });
    const [[op]] = await pool.query('SELECT num_op FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    await pool.query('INSERT INTO fundantes_bitacora (id_credito, comentario, autor, id_autor) VALUES (?,?,?,?)',
      [id, comentario, nombreUsuario(req), req.usuario.id_usuario || null]);
    await pool.query('INSERT INTO fundantes_popup_log (id_usuario, id_credito) VALUES (?,?)',
      [req.usuario.id_usuario, id]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[fundantes popupComentar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ─── GET /bitacora-atrasados ─────────────────────────────────────────────────
   Bitácora de los créditos con fundantes ATRASADOS (pendientes/rechazados hace
   más de 7 días — el mismo umbral verde de la matriz de antigüedad; ajustable
   con ?dias=N): cada operación con TODOS sus comentarios de gestión (los del
   pop-up semanal y los manuales), con autor y fecha. Para supervisar qué
   explicación dio cada ejecutivo. */
const bitacoraAtrasados = async (req, res) => {
  try {
    const minDias = Math.max(parseInt(req.query.dias) || 8, 1);
    const [ops] = await pool.query(`
      SELECT c.id AS id_credito, c.num_op, c.financiera, c.id_financiera, c.ejecutivo,
             DATE_FORMAT(c.fecha_otorgado,'%Y-%m-%d') AS fecha_otorgado,
             DATEDIFF(CURDATE(), c.fecha_otorgado) AS dias,
             COALESCE(fs.estado,'PENDIENTE') AS estado, fs.comentario_rechazo
      FROM creditos c LEFT JOIN fundantes_seg fs ON fs.id_credito = c.id
      WHERE c.fecha_otorgado IS NOT NULL
        AND UPPER(COALESCE(c.estado_credito,'')) = 'OTORGADO'
        AND UPPER(c.financiera) IN (?)
        AND COALESCE(fs.estado,'PENDIENTE') IN ('PENDIENTE','RECHAZADO')
        AND DATEDIFF(CURDATE(), c.fecha_otorgado) >= ?
      ORDER BY dias DESC, c.num_op DESC
      LIMIT 500`, [FINANCIERAS, minDias]);
    const ids = ops.map(o => o.id_credito);
    const comPorOp = {};
    if (ids.length) {
      const [coms] = await pool.query(
        `SELECT id_credito, comentario, autor, created_at
           FROM fundantes_bitacora WHERE id_credito IN (?) ORDER BY created_at DESC`, [ids]);
      coms.forEach(cm => (comPorOp[cm.id_credito] = comPorOp[cm.id_credito] || []).push(
        { comentario: cm.comentario, autor: cm.autor, fecha: cm.created_at }));
    }
    res.json({ success: true, data: ops.map(o => ({
      ...o, dias: Number(o.dias) || 0, comentarios: comPorOp[o.id_credito] || [],
    })), error: null });
  } catch (e) { console.error('[fundantes bitacoraAtrasados]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ─── Bitácora de la operación ────────────────────────────────────────────────
   GET  /:id/bitacora  → línea de tiempo: lo que el sistema registró solo
        (auditoría del módulo, una sola fuente) + los comentarios de gestión.
   POST /:id/bitacora  → agrega un comentario con el estado a la fecha.        */
const bitacora = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, data: null, error: 'Operación inválida' });
    const [[op]] = await pool.query('SELECT num_op, id_financiera FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    const [aud] = await pool.query(
      `SELECT fecha, usuario, accion, detalle FROM auditoria_movimientos
        WHERE modulo='fundantes-seguimiento' AND entidad='credito' AND entidad_id=?
        ORDER BY fecha DESC LIMIT 200`, [String(id)]);
    const [com] = await pool.query(
      'SELECT created_at AS fecha, autor AS usuario, comentario FROM fundantes_bitacora WHERE id_credito=? ORDER BY created_at DESC', [id]);
    const eventos = [
      ...aud.map(a => ({ tipo: 'evento', fecha: a.fecha, usuario: a.usuario, accion: a.accion, texto: a.detalle })),
      ...com.map(c => ({ tipo: 'comentario', fecha: c.fecha, usuario: c.usuario, accion: 'COMENTARIO', texto: c.comentario })),
    ].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    res.json({ success: true, data: { num_op: op.num_op, id_financiera: op.id_financiera, eventos }, error: null });
  } catch (e) { console.error('[fundantes bitacora]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const comentar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const comentario = String((req.body || {}).comentario || '').trim();
    if (!id) return res.status(400).json({ success: false, data: null, error: 'Operación inválida' });
    if (!comentario) return res.status(400).json({ success: false, data: null, error: 'El comentario no puede ir vacío.' });
    if (comentario.length > 2000) return res.status(400).json({ success: false, data: null, error: 'El comentario no puede superar los 2.000 caracteres.' });
    const [[op]] = await pool.query('SELECT num_op FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    await pool.query('INSERT INTO fundantes_bitacora (id_credito, comentario, autor, id_autor) VALUES (?,?,?,?)',
      [id, comentario, nombreUsuario(req), req.usuario.id_usuario || null]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[fundantes comentar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

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
    // El pool ya no tiene nada que validar en esta OP: se retira de la campanita.
    AVISOS.retirar('fund_env_' + id).catch(() => {});
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
    const [docs] = await pool.query('SELECT codigo, archivo_nombre, mime_type, archivo_data, doc_ruta FROM fundantes_seg_docs WHERE id_credito=? AND (archivo_data IS NOT NULL OR doc_ruta IS NOT NULL)', [id]);
    if (!docs.length) return res.status(404).json({ success: false, data: null, error: 'No hay documentos para descargar' });
    const idf = op.id_financiera || op.num_op || id;
    const carpeta = sanitizeFn(`Fundantes ${op.financiera || ''} ID${idf}`);
    /* En paralelo: una carpeta típica trae media docena de archivos y traerlos
       del bucket de a uno sumaría una vuelta de red por documento. */
    const files = await Promise.all(docs.map(async d => ({
      name: `${carpeta}/${sanitizeFn((DOC_LABEL[d.codigo] || d.codigo) + ' ID' + idf)}${extDe(d.archivo_nombre, d.mime_type)}`,
      buf: await almacen.obtener({ ruta: d.doc_ruta, blob: d.archivo_data }),
    })));
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

/* ─── GET /:id/docs — lista (metadata) de documentos cargados de una operación ──── */
const listarDocs = async (req, res) => {
  try {
    const [docs] = await pool.query(
      'SELECT id, codigo, archivo_nombre, mime_type, DATE_FORMAT(created_at,"%Y-%m-%d %H:%i") subido, subido_por FROM fundantes_seg_docs WHERE id_credito=? AND (archivo_data IS NOT NULL OR doc_ruta IS NOT NULL) ORDER BY codigo',
      [Number(req.params.id)]);
    res.json({ success: true, data: docs, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno' }); }
};

/* ─── GET /historial — bitácora de envíos/validaciones por operación ──────────────
   Se reconstruye desde la auditoría (ENVIAR/APROBAR/RECHAZAR_FUNDANTES): primer envío,
   primer resultado, reenvío (si se corrigió) y resultado final — siempre con fecha y persona. */
const historial = async (req, res) => {
  try {
    const [ev] = await pool.query(
      `SELECT entidad_id, accion, usuario, fecha, detalle
         FROM auditoria_movimientos
        WHERE modulo='fundantes-seguimiento'
          AND accion IN ('ENVIAR_FUNDANTES','APROBAR_FUNDANTES','RECHAZAR_FUNDANTES','DEVOLVER_FUNDANTES')
        ORDER BY entidad_id, fecha ASC`);
    // Se agrupa por N° OP (extraído del detalle) y no por entidad_id: los créditos pueden
    // recrearse con otro id en re-importaciones, pero el num_op es estable.
    const opDe = d => { const m = String(d || '').match(/OP\s+(\d+)/); return m ? m[1] : null; };
    const porCred = new Map();
    for (const e of ev) { const k = opDe(e.detalle); if (!k) continue; (porCred.get(k) || porCred.set(k, []).get(k)).push(e); }
    if (!porCred.size) return res.json({ success: true, data: [], error: null });

    const [creds] = await pool.query(
      `SELECT c.id AS id_credito, c.num_op, c.id_financiera, c.ejecutivo, COALESCE(c.automotora,'') dealer,
              COALESCE(cl.rut,'') rut, COALESCE(cl.nombre_completo,'') cliente
         FROM creditos c LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
        WHERE c.num_op IN (?)`, [[...porCred.keys()]]);
    const cmap = new Map(creds.map(c => [String(c.num_op), c]));
    const vis = await ejecutivosVisibles(req);
    const visible = ej => vis.all || (vis.lista || []).some(x => String(x).toUpperCase() === String(ej || '').toUpperCase());
    const motivoDe = d => { const i = String(d || '').indexOf('—'); return i >= 0 ? String(d).slice(i + 1).trim() : ''; };
    const P = e => e ? { fecha: e.fecha, persona: e.usuario } : null;

    const rows = [];
    for (const [id, evs] of porCred) {
      const c = cmap.get(id); if (!c || !visible(c.ejecutivo)) continue;
      const envios = evs.filter(e => e.accion === 'ENVIAR_FUNDANTES');
      const valids = evs.filter(e => e.accion === 'APROBAR_FUNDANTES' || e.accion === 'RECHAZAR_FUNDANTES');
      const primerRechazo = evs.find(e => e.accion === 'RECHAZAR_FUNDANTES');
      const reenvio = primerRechazo ? envios.find(e => e.fecha > primerRechazo.fecha) : null;
      const primerRes = valids[0] || null;
      const ultimo = evs[evs.length - 1];
      // DEVUELTO = la financiera devolvió los fundantes DESPUÉS de aprobarlos.
      // El resultado histórico (aprobado/rechazado) se conserva en '1er resultado';
      // el 'resultado final' pasa a DEVUELTO porque es el estado real de hoy.
      const estadoDe = e => e.accion === 'APROBAR_FUNDANTES' ? 'APROBADO'
        : e.accion === 'RECHAZAR_FUNDANTES' ? 'RECHAZADO'
        : e.accion === 'DEVOLVER_FUNDANTES' ? 'DEVUELTO' : 'ENVIADO';
      rows.push({
        id_credito: c.id_credito,
        num_op: c.num_op, id_financiera: c.id_financiera, rut: c.rut, cliente: c.cliente,
        ejecutivo: c.ejecutivo, dealer: c.dealer,
        envio1: P(envios[0]),
        resultado1: primerRes ? { estado: estadoDe(primerRes), ...P(primerRes), motivo: primerRes.accion === 'RECHAZAR_FUNDANTES' ? motivoDe(primerRes.detalle) : '' } : null,
        reenvio: P(reenvio), reenvios_n: Math.max(0, envios.length - 1),
        final: { estado: estadoDe(ultimo), ...P(ultimo), motivo: (ultimo.accion === 'RECHAZAR_FUNDANTES' || ultimo.accion === 'DEVOLVER_FUNDANTES') ? motivoDe(ultimo.detalle) : '' },
        _orden: (envios[0] || ultimo).fecha,
      });
    }
    rows.sort((a, b) => new Date(b._orden) - new Date(a._orden));
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[fundantes historial]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno' }); }
};

/* ─── MANTENEDOR DE TIPOS DE DOCUMENTO ────────────────────────────────────────
   Qué documentos pide cada financiera, y cuáles son obligatorios, es un dato de
   negocio: cambia cuando la financiera cambia de exigencia, no cuando cambia el
   código. Antes vivía solo en el seed de este archivo y hacía falta un
   programador para volver opcional un documento (fue el caso del Informe GPS el
   05-08-2026). Ahora lo administra el Administrador.

   `requiere_contrato` es el tercer estado, y por eso no es un simple sí/no:
   'gps' o 'limitacion' significan "obligatorio SOLO si la operación lo lleva
   contratado". Se conserva porque hay documentos que dependen de lo vendido. */
const TIPOS_CONTRATO = ['gps', 'limitacion'];

const tiposListar = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, financiera, codigo, nombre, obligatorio, requiere_contrato, orden
         FROM fundantes_seg_tipos ORDER BY financiera, orden, id`);
    const [[{ fin } = {}]] = await pool.query(
      `SELECT GROUP_CONCAT(DISTINCT UPPER(financiera) ORDER BY financiera) fin FROM fundantes_seg_tipos`);
    res.json({ success: true, data: { tipos: rows, financieras: String(fin || '').split(',').filter(Boolean) }, error: null });
  } catch (e) { console.error('[fundantes tipos listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno' }); }
};

function validarTipo(b) {
  const financiera = String(b.financiera || '').trim().toUpperCase();
  const codigo = String(b.codigo || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const nombre = String(b.nombre || '').trim();
  if (!financiera) return { error: 'La financiera es obligatoria' };
  if (!codigo) return { error: 'El código es obligatorio' };
  if (!nombre) return { error: 'El nombre es obligatorio' };
  const rc = String(b.requiere_contrato || '').trim().toLowerCase();
  if (rc && !TIPOS_CONTRATO.includes(rc)) return { error: `"Solo si viene contratado" admite: ${TIPOS_CONTRATO.join(', ')}` };
  return {
    financiera, codigo, nombre,
    // Si es condicional, el sí/no no manda: el campo que decide es requiere_contrato.
    obligatorio: rc ? 1 : (b.obligatorio ? 1 : 0),
    requiere_contrato: rc || null,
    orden: Number(b.orden) || 0,
  };
}

const tiposCrear = async (req, res) => {
  try {
    const t = validarTipo(req.body || {});
    if (t.error) return res.status(400).json({ success: false, data: null, error: t.error });
    const [r] = await pool.query(
      `INSERT INTO fundantes_seg_tipos (financiera, codigo, nombre, obligatorio, requiere_contrato, orden)
       VALUES (?,?,?,?,?,?)`,
      [t.financiera, t.codigo, t.nombre, t.obligatorio, t.requiere_contrato, t.orden]);
    auditar({ req, accion: 'CREAR', modulo: 'fundantes-seguimiento', entidad: 'tipo_documento', entidad_id: String(r.insertId),
      detalle: `Agregó el documento "${t.nombre}" (${t.codigo}) a ${t.financiera}${t.obligatorio ? ' como obligatorio' : ' como opcional'}` });
    res.json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    if (e.errno === 1062) return res.status(409).json({ success: false, data: null, error: 'Esa financiera ya tiene un documento con ese código' });
    console.error('[fundantes tipos crear]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno' });
  }
};

const tiposActualizar = async (req, res) => {
  try {
    const t = validarTipo(req.body || {});
    if (t.error) return res.status(400).json({ success: false, data: null, error: t.error });
    const [[prev]] = await pool.query('SELECT nombre, obligatorio, requiere_contrato FROM fundantes_seg_tipos WHERE id=?', [req.params.id]);
    if (!prev) return res.status(404).json({ success: false, data: null, error: 'No existe ese documento' });
    await pool.query(
      `UPDATE fundantes_seg_tipos SET financiera=?, codigo=?, nombre=?, obligatorio=?, requiere_contrato=?, orden=? WHERE id=?`,
      [t.financiera, t.codigo, t.nombre, t.obligatorio, t.requiere_contrato, t.orden, req.params.id]);
    const antes = prev.requiere_contrato ? `solo si trae ${prev.requiere_contrato}` : (prev.obligatorio ? 'obligatorio' : 'opcional');
    const ahora = t.requiere_contrato ? `solo si trae ${t.requiere_contrato}` : (t.obligatorio ? 'obligatorio' : 'opcional');
    auditar({ req, accion: 'EDITAR', modulo: 'fundantes-seguimiento', entidad: 'tipo_documento', entidad_id: String(req.params.id),
      detalle: `Editó "${t.nombre}" (${t.financiera}): ${antes} → ${ahora}` });
    res.json({ success: true, data: { id: Number(req.params.id) }, error: null });
  } catch (e) {
    if (e.errno === 1062) return res.status(409).json({ success: false, data: null, error: 'Esa financiera ya tiene un documento con ese código' });
    console.error('[fundantes tipos actualizar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno' });
  }
};

/* No se borra un tipo que ya tiene documentos cargados: dejaría archivos
   colgando de un código que ya no existe, invisibles en la pantalla y sin
   forma de llegar a ellos. Se vuelve opcional, que es lo que se quiere el 99%
   de las veces. */
const tiposEliminar = async (req, res) => {
  try {
    const [[t]] = await pool.query('SELECT id, financiera, codigo, nombre FROM fundantes_seg_tipos WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ success: false, data: null, error: 'No existe ese documento' });
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM fundantes_seg_docs WHERE codigo=?', [t.codigo]);
    if (n) return res.status(409).json({
      success: false, data: null,
      error: `No se puede eliminar: ya hay ${n} archivo(s) cargado(s) con este documento. Si dejó de pedirse, márcalo como opcional.`
    });
    await pool.query('DELETE FROM fundantes_seg_tipos WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'fundantes-seguimiento', entidad: 'tipo_documento', entidad_id: String(req.params.id),
      detalle: `Eliminó el documento "${t.nombre}" (${t.codigo}) de ${t.financiera}` });
    res.json({ success: true, data: { eliminado: true }, error: null });
  } catch (e) { console.error('[fundantes tipos eliminar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno' }); }
};

module.exports = { listar, resumen, subirDoc, eliminarDoc, descargar, descargarZip, enviar, marcarSinLimitacion, validar, historial, listarDocs, devolver, devueltos, bitacora, bitacoraAtrasados, comentar, popup, popupComentar,
  tiposListar, tiposCrear, tiposActualizar, tiposEliminar };
