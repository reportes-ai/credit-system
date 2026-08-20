const pool = require('../../../../shared/config/database');
const { ES_ETAPA } = require('../../../../shared/etapa-credito');
// La tabla la crea shared/auditoria.js al arrancar

/* ─── GET /api/auditoria-credito/:id_credito ─────────────────────────────── */
const getByCredito = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_auditoria, id_credito, fecha, usuario, id_usuario,
              perfil, accion, detalle, meta, ip
       FROM auditoria_credito
       WHERE id_credito = ?
       ORDER BY fecha ASC`,
      [req.params.id_credito]
    );
    res.json({ success: true, data: rows, error: null });
  } catch(e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── POST /api/auditoria-credito/backfill ───────────────────────────────── */
/* Reconstruye el historial desde los datos que ya existen.
   Idempotente: INSERT IGNORE + `ref_origen` único → se puede correr las veces
   que sea sin duplicar, y comparte las claves con el registro en vivo
   (`shared/auditoria.registrarUnico`), así que ninguno pisa al otro.

   UNIVERSO: solo las operaciones OTORGADAS del año en curso. Barrer las 17.900
   filas históricas cuesta caro en TiDB (cobra por consulta) y llena la tabla de
   eventos de solicitudes que nunca se cursaron. La etapa se lee por el motor
   único (ETAPA_SQL), no por una columna suelta. */
const backfill = async (req, res) => {
  let insertados = 0;
  const ins = async (row) => {
    try {
      const [r] = await pool.query(
        `INSERT IGNORE INTO auditoria_credito
           (id_credito, fecha, usuario, id_usuario, perfil, accion, detalle, meta, ref_origen)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [row.id_credito, row.fecha, row.usuario, row.id_usuario || null,
         row.perfil || null, row.accion, row.detalle || null,
         row.meta ? JSON.stringify(row.meta) : null, row.ref_origen]
      );
      if (r.affectedRows) insertados++;
    } catch(e) { console.error('[backfill ins]', e.message, row.ref_origen); }
  };

  try {
    /* ── 1. Nacimiento y otorgamiento de las operaciones del año ─────────── */
    /* PK real de `creditos` es `id` — `id_credito` es solo alias en algunos
       SELECT. La versión anterior consultaba `c.id_credito` y el backfill moría
       con "Unknown column" cada vez que alguien apretaba el botón. */
    const [creditos] = await pool.query(
      `SELECT c.id, c.num_op, c.numero_credito, c.ejecutivo,
              COALESCE(c.nombre_cliente, cl.nombre_completo, '') AS nombre_cliente,
              COALESCE(c.rut_cliente,    cl.rut,             '') AS rut_cliente,
              c.financiera, c.monto_financiado, c.created_at, c.fecha_otorgado,
              COALESCE(c.id_usuario, c.created_by) AS uid,
              TRIM(CONCAT(COALESCE(u.nombre,''), ' ', COALESCE(u.apellido,''))) AS usr_nombre,
              p.nombre AS usr_perfil
       FROM creditos c
       LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
       LEFT JOIN usuarios u  ON u.id_usuario  = COALESCE(c.id_usuario, c.created_by)
       LEFT JOIN perfiles p  ON u.id_perfil   = p.id_perfil
       WHERE ${ES_ETAPA('OTORGADO', 'c')}
         AND c.fecha_otorgado >= MAKEDATE(YEAR(CURDATE()), 1)`
    );
    const ids = creditos.map(c => c.id);
    for (const c of creditos) {
      const nOp = c.num_op || c.numero_credito || c.id;
      await ins({
        id_credito: c.id,
        fecha:      c.created_at || new Date(),
        usuario:    c.usr_nombre?.trim() || 'Sistema',
        id_usuario: c.uid,
        perfil:     c.usr_perfil || null,
        accion:     'CREDITO_CREADO',
        detalle:    `Operación N°${nOp} ingresada para ${c.nombre_cliente}`,
        meta:       { num_op: c.num_op, numero_credito: c.numero_credito, cliente: c.nombre_cliente, rut: c.rut_cliente, financiera: c.financiera, monto_financiado: c.monto_financiado },
        ref_origen: `bc_cred_${c.id}`,
      });
      await ins({
        id_credito: c.id,
        fecha:      c.fecha_otorgado,
        usuario:    'Sistema',
        id_usuario: null,
        perfil:     null,
        accion:     'CREDITO_OTORGADO',
        detalle:    `Operación N°${nOp} otorgada${c.ejecutivo ? ' — ejecutivo ' + c.ejecutivo : ''}`,
        meta:       { num_op: c.num_op, ejecutivo: c.ejecutivo, financiera: c.financiera, monto_financiado: c.monto_financiado, fecha_otorgado: c.fecha_otorgado },
        ref_origen: `otg_${c.id}`,
      });
    }

    // Sin operaciones en el universo no hay nada que reconstruir (y evita un
    // `IN ()` vacío, que en MySQL es un error de sintaxis).
    if (!ids.length) {
      return res.json({ success: true, error: null, data: {
        insertados: 0, creditos: 0, documentos: 0, docs_af: 0, pagos: 0,
        mensaje: 'No hay operaciones otorgadas este año para reconstruir.' } });
    }

    /* ── 2. Documentos de respaldo cargados (credito_documentos) ─────────── */
    const [cdocs] = await pool.query(
      `SELECT cd.id_doc, cd.id_credito, cd.id_tipo, cd.archivo_nombre,
              cd.archivo_size, cd.subido_at,
              TRIM(CONCAT(COALESCE(u.nombre,''), ' ', COALESCE(u.apellido,''))) AS usr_nombre,
              p.nombre AS usr_perfil, u.id_usuario AS uid,
              td.nombre AS tipo_nombre
       FROM credito_documentos cd
       LEFT JOIN usuarios u  ON cd.subido_por = u.id_usuario
       LEFT JOIN perfiles p  ON u.id_perfil   = p.id_perfil
       LEFT JOIN tipos_documento td ON cd.id_tipo = td.id_tipo
       WHERE cd.id_credito IN (?)`, [ids]
    );
    for (const d of cdocs) {
      await ins({
        id_credito: d.id_credito,
        fecha:      d.subido_at || new Date(),
        usuario:    d.usr_nombre?.trim() || 'Sistema',
        id_usuario: d.uid,
        perfil:     d.usr_perfil || null,
        accion:     'DOCUMENTO_CARGADO',
        detalle:    `Documento cargado: ${d.archivo_nombre||'—'} (${d.tipo_nombre||'Tipo '+d.id_tipo})`,
        meta:       { id_tipo: d.id_tipo, tipo: d.tipo_nombre, archivo_nombre: d.archivo_nombre, archivo_size: d.archivo_size },
        ref_origen: `bc_cdoc_${d.id_doc}`,
      });
    }

    /* ── 3. Documentos AF cargados ───────────────────────────────────────── */
    const [afdocs] = await pool.query(
      `SELECT id_doc_af, id_credito, codigo, nombre, created_at,
              validado, validado_por, validado_at,
              rechazado, comentario_rechazo, rechazado_por, rechazado_at
       FROM documentos_af
       WHERE id_credito IN (?)`, [ids]
    );
    for (const d of afdocs) {
      // Carga inicial
      await ins({
        id_credito: d.id_credito,
        fecha:      d.created_at || new Date(),
        usuario:    'Sistema',
        id_usuario: null,
        perfil:     null,
        accion:     'DOC_AF_CARGADO',
        detalle:    `Doc. AF cargado: ${d.nombre || d.codigo}`,
        meta:       { codigo: d.codigo, nombre: d.nombre },
        ref_origen: `bc_af_${d.id_doc_af}`,
      });
      // Aprobación
      if (d.validado && d.validado_at) {
        await ins({
          id_credito: d.id_credito,
          fecha:      d.validado_at,
          usuario:    d.validado_por || 'Sistema',
          id_usuario: null,
          perfil:     null,
          accion:     'DOC_AF_APROBADO',
          detalle:    `Doc. AF aprobado: ${d.nombre || d.codigo}`,
          meta:       { codigo: d.codigo, nombre: d.nombre, aprobado_por: d.validado_por },
          ref_origen: `bc_afv_${d.id_doc_af}`,
        });
      }
      // Rechazo
      if (d.rechazado && d.rechazado_at) {
        await ins({
          id_credito: d.id_credito,
          fecha:      d.rechazado_at,
          usuario:    d.rechazado_por || 'Sistema',
          id_usuario: null,
          perfil:     null,
          accion:     'DOC_AF_RECHAZADO',
          detalle:    `Doc. AF rechazado: ${d.nombre || d.codigo} — ${d.comentario_rechazo||''}`,
          meta:       { codigo: d.codigo, nombre: d.nombre, motivo: d.comentario_rechazo, rechazado_por: d.rechazado_por },
          ref_origen: `bc_afr_${d.id_doc_af}`,
        });
      }
    }

    /* ── 4. Pagos de cuotas ──────────────────────────────────────────────── */
    const [pagos] = await pool.query(
      `SELECT id_pago, id_credito, numero_cuota, total_pagado,
              monto_cuota, interes_mora, gastos_cobranza,
              fecha_pago, registrado_por, created_at
       FROM pagos_credito
       WHERE id_credito IN (?)`, [ids]
    );
    for (const p of pagos) {
      await ins({
        id_credito: p.id_credito,
        fecha:      p.created_at || p.fecha_pago || new Date(),
        usuario:    p.registrado_por || 'Sistema',
        id_usuario: null,
        perfil:     null,
        accion:     'PAGO_REGISTRADO',
        detalle:    `Cuota N°${p.numero_cuota} pagada — Total: $${Math.round(p.total_pagado||0).toLocaleString('es-CL')}`,
        meta:       { numero_cuota: p.numero_cuota, monto_cuota: p.monto_cuota, interes_mora: p.interes_mora, gastos_cobranza: p.gastos_cobranza, total_pagado: p.total_pagado, fecha_pago: p.fecha_pago },
        ref_origen: `bc_pago_${p.id_pago}`,
      });
    }

    res.json({
      success: true,
      data: {
        insertados,
        creditos:  creditos.length,
        documentos: cdocs.length,
        docs_af:   afdocs.length,
        pagos:     pagos.length,
        mensaje:   `Backfill completado: ${insertados} eventos históricos insertados sobre ${creditos.length} operaciones otorgadas este año.`,
      },
      error: null,
    });
  } catch(e) {
    res.status(500).json({ success: false, data: { insertados }, error: e.message });
  }
};

module.exports = { getByCredito, backfill };
