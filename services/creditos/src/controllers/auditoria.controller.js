const pool = require('../../../../shared/config/database');
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
// Reconstruye el historial desde datos históricos existentes.
// Idempotente: usa INSERT IGNORE + ref_origen único → se puede correr varias veces sin duplicar.
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
    /* ── 1. Créditos creados ─────────────────────────────────────────────── */
    const [creditos] = await pool.query(
      `SELECT c.id_credito, c.numero_credito, c.nombre_cliente, c.rut_cliente,
              c.financiera, c.monto_financiado, c.estado, c.created_at,
              c.id_usuario,
              TRIM(CONCAT(COALESCE(u.nombre,''), ' ', COALESCE(u.apellido,''))) AS usr_nombre,
              p.nombre AS usr_perfil
       FROM creditos c
       LEFT JOIN usuarios u ON c.id_usuario = u.id_usuario
       LEFT JOIN perfiles p ON u.id_perfil  = p.id_perfil`
    );
    for (const c of creditos) {
      await ins({
        id_credito: c.id_credito,
        fecha:      c.created_at || new Date(),
        usuario:    c.usr_nombre?.trim() || 'Sistema',
        id_usuario: c.id_usuario,
        perfil:     c.usr_perfil || null,
        accion:     'CREDITO_CREADO',
        detalle:    `Crédito N°${c.numero_credito||c.id_credito} creado para ${c.nombre_cliente}`,
        meta:       { numero_credito: c.numero_credito, cliente: c.nombre_cliente, rut: c.rut_cliente, financiera: c.financiera, monto_financiado: c.monto_financiado },
        ref_origen: `bc_cred_${c.id_credito}`,
      });
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
       LEFT JOIN tipos_documento td ON cd.id_tipo = td.id_tipo`
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
       FROM documentos_af`
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
       FROM pagos_credito`
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
        mensaje:   `Backfill completado: ${insertados} eventos históricos insertados.`,
      },
      error: null,
    });
  } catch(e) {
    res.status(500).json({ success: false, data: { insertados }, error: e.message });
  }
};

module.exports = { getByCredito, backfill };
