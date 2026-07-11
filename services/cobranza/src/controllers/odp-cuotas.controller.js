'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ODP de Cuotas — Orden de Pago de cuotas de crédito (cobranza).
   Distinto del módulo "Órdenes de Pago a proveedores" (400001).

   Flujo (pedido por Pato):
   - Alguien selecciona cuotas y EMITE una ODP (solicitud a Tesorería) con el
     origen de fondos. Con caja puede pagar directo (en /tesoreria/caja) o emitir
     ODP; sin caja sólo emite ODP.
   - La ODP entra a una COLA en Tesorería. Tesorería APRUEBA → se registran los
     pagos (pagos_credito, con correlativo TRX) → se envía el comprobante por
     correo al CLIENTE, con copia oculta (BCC) a quien la solicitó, desde
     cobranza@autofacilchile.cl.
   ───────────────────────────────────────────────────────────────────────────── */
const pool    = require('../../../../shared/config/database');
const audit   = require('../../../../shared/auditoria');
const { auditar } = require('../../../../shared/audit');
const { enviarCorreo, envolverHTML, remitenteCobranza } = require('../../../../shared/mailer');

/* ─── Migración + auto-registro de módulo/funcionalidades ───────────────────── */
require('../../../../shared/migrate').enFila('odp-cuotas', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ordenes_pago_cuotas (
        id_odp                INT AUTO_INCREMENT PRIMARY KEY,
        id_credito            INT            NOT NULL,
        numero_credito        VARCHAR(50)    NULL,
        rut_cliente           VARCHAR(20)    NULL,
        nombre_cliente        VARCHAR(300)   NULL,
        email_cliente         VARCHAR(200)   NULL,
        cuotas_json           JSON           NULL,
        n_cuotas              INT            DEFAULT 0,
        monto_total           DECIMAL(14,2)  DEFAULT 0,
        origen_fondos         VARCHAR(100)   NULL,
        id_cuenta_bancaria    INT            NULL,
        fecha_pago            DATE           NULL,
        observacion           TEXT           NULL,
        estado                VARCHAR(20)    NOT NULL DEFAULT 'PENDIENTE',
        id_solicitante        INT            NULL,
        solicitante_nombre    VARCHAR(200)   NULL,
        solicitante_email     VARCHAR(200)   NULL,
        id_caja               INT            NULL,
        id_resolutor          INT            NULL,
        resolutor_nombre      VARCHAR(200)   NULL,
        fecha_resolucion      DATETIME       NULL,
        comentario_resolucion TEXT           NULL,
        numero_transaccion    INT            NULL,
        correo_enviado        TINYINT(1)     DEFAULT 0,
        created_at            DATETIME       DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_estado   (estado),
        INDEX idx_credito  (id_credito),
        INDEX idx_solicita (id_solicitante)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (e) { if (e.errno !== 1050) console.error('[odp_cuotas migration]', e.message); }

  // Auto-registro de funcionalidades (paramétrico, sin tocar código para permisos)
  try {
    const [[modCob]]  = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta LIKE '%cobranza%'  LIMIT 1`);
    const [[modTeso]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta LIKE '%tesoreria%' LIMIT 1`);

    // Acción: emitir ODP (href NULL). Vive bajo Cobranza para la matriz de perfiles.
    const idModEmitir = modCob?.id_modulo || modTeso?.id_modulo || null;
    if (idModEmitir) {
      let [[fEmitir]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='odp_cuotas_emitir' LIMIT 1`);
      if (!fEmitir) {
        const [ins] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
           VALUES (?, 'Emitir Orden de Pago de Cuotas', 'odp_cuotas_emitir', NULL, 'bi-cash-stack')`,
          [idModEmitir]
        );
        fEmitir = { id_funcionalidad: ins.insertId };
      }
      const [perf] = await pool.query(
        `SELECT id_perfil FROM perfiles
          WHERE nombre IN ('Administrador','Gerente','Tesorero','Supervisor','Cobranza','Ejecutivo','Ejecutivo Comercial')`
      );
      for (const p of perf)
        await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)`,
          [p.id_perfil, fEmitir.id_funcionalidad]);
    }

    // Página/cola en Tesorería: ver y resolver ODP.
    const idModCola = modTeso?.id_modulo || modCob?.id_modulo || null;
    if (idModCola) {
      let [[fCola]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='odp_cuotas_cola' LIMIT 1`);
      if (!fCola) {
        const [ins] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
           VALUES (?, 'Órdenes de Pago de Cuotas (Cola)', 'odp_cuotas_cola', '/tesoreria/odp-cuotas', 'bi-inbox')`,
          [idModCola]
        );
        fCola = { id_funcionalidad: ins.insertId };
      }
      const [perf] = await pool.query(
        `SELECT id_perfil FROM perfiles WHERE nombre IN ('Administrador','Gerente','Tesorero')`
      );
      for (const p of perf)
        await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)`,
          [p.id_perfil, fCola.id_funcionalidad]);
    }
  } catch (e) { console.error('[odp_cuotas funcionalidades]', e.message); }
});

/* ─── helpers ───────────────────────────────────────────────────────────────── */
const ok  = (res, data)            => res.json({ success: true, data, error: null });
const bad = (res, msg, code = 400)  => res.status(code).json({ success: false, data: null, error: msg });
const clp = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtFecha = f => { if (!f) return '—'; try { return new Date(f).toLocaleDateString('es-CL',{timeZone:'UTC',day:'2-digit',month:'2-digit',year:'numeric'}); } catch { return '—'; } };

function nombreUsuario(u) {
  return [u?.nombre, u?.apellido].filter(Boolean).join(' ') || u?.email || null;
}

// Normaliza las cuotas que vienen del frontend a la forma de pagos_credito.
function normalizarCuotas(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(c => {
    const monto  = Math.round(parseFloat(c.monto_cuota)     || 0);
    const mora   = Math.round(parseFloat(c.interes_mora)    || 0);
    const gastos = Math.round(parseFloat(c.gastos_cobranza) || 0);
    const total  = Math.round(parseFloat(c.total_pagado)    || (monto + mora + gastos));
    return {
      numero_cuota:      parseInt(c.numero_cuota) || 0,
      fecha_vencimiento: c.fecha_vencimiento || null,
      monto_cuota:       monto,
      interes_mora:      mora,
      gastos_cobranza:   gastos,
      total_pagado:      total,
    };
  }).filter(c => c.numero_cuota > 0);
}

// HTML del comprobante para el correo al cliente.
function comprobanteEmailHTML({ credito, cuotas, trxNum, fechaPago, total, origen }) {
  const filas = cuotas.map(c => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:center">${c.numero_cuota}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7">${fmtFecha(c.fecha_vencimiento)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right">${clp(c.monto_cuota)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right">${clp(c.interes_mora)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right">${clp(c.gastos_cobranza)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right;font-weight:700">${clp(c.total_pagado)}</td>
    </tr>`).join('');
  const cuerpo = `
    <p style="margin:0 0 14px">Estimado(a) <strong>${esc(credito.nombre_cliente || 'cliente')}</strong>,</p>
    <p style="margin:0 0 16px">Confirmamos el pago registrado para su crédito
       <strong>N° ${esc(credito.numero_credito || credito.id_credito)}</strong>.
       Comprobante <strong>TRX-${String(trxNum).padStart(6,'0')}</strong> · ${fmtFecha(fechaPago)}.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 14px">
      <thead>
        <tr style="background:#f1f5f9;color:#334155">
          <th style="padding:7px 8px;text-align:center">N°</th>
          <th style="padding:7px 8px;text-align:left">Vencimiento</th>
          <th style="padding:7px 8px;text-align:right">Cuota</th>
          <th style="padding:7px 8px;text-align:right">Int. Mora</th>
          <th style="padding:7px 8px;text-align:right">Gtos. Cobr.</th>
          <th style="padding:7px 8px;text-align:right">Total</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>
    <div style="background:#0141A2;color:#fff;border-radius:10px;padding:12px 18px;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:13px;opacity:.85">TOTAL PAGADO${origen ? ' · ' + esc(origen) : ''}</span>
      <span style="font-size:20px;font-weight:800">${clp(total)}</span>
    </div>`;
  return envolverHTML(cuerpo);
}

/* ─── Carga datos de cabecera del crédito (cliente, número, email) ──────────── */
async function ctxCredito(idCredito) {
  const [[row]] = await pool.query(
    `SELECT c.id AS id_credito, c.numero_credito,
            cl.rut             AS rut_cliente,
            cl.nombre_completo AS nombre_cliente,
            cl.email           AS email_cliente
       FROM creditos c
       LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
      WHERE c.id = ?`,
    [idCredito]
  );
  return row || null;
}

/* ═══════════════════════ EMITIR (solicitud) ════════════════════════════════ */
const emitir = async (req, res) => {
  try {
    const {
      id_credito, cuotas, origen_fondos, id_cuenta_bancaria,
      fecha_pago, observacion,
    } = req.body || {};

    if (!id_credito) return bad(res, 'id_credito es requerido');
    const cuotasN = normalizarCuotas(cuotas);
    if (!cuotasN.length) return bad(res, 'Debes seleccionar al menos una cuota.');
    if (!origen_fondos)  return bad(res, 'Selecciona el origen de fondos.');

    const ctx = await ctxCredito(id_credito);
    if (!ctx) return bad(res, 'Crédito no encontrado.', 404);

    // No permitir cuotas ya pagadas (validación blanda al emitir).
    const nums = cuotasN.map(c => c.numero_cuota);
    const [yaPagadas] = await pool.query(
      `SELECT numero_cuota FROM pagos_credito
        WHERE id_credito = ? AND estado_pago = 'PAGADO' AND numero_cuota IN (?)
        UNION
       SELECT numero_cuota FROM cuotas_credito
        WHERE id_credito = ? AND estado_cuota = 'PAGADA' AND numero_cuota IN (?)`,
      [id_credito, nums, id_credito, nums]
    );
    if (yaPagadas.length)
      return bad(res, `Las cuotas ${yaPagadas.map(r => r.numero_cuota).join(', ')} ya están pagadas.`);

    const u = req.usuario || {};
    // Caja del solicitante (si tiene), para trazar el origen del pago.
    let idCaja = null;
    try {
      const [[cu]] = await pool.query(
        `SELECT id_caja FROM caja_usuarios WHERE id_usuario = ? AND activo = 1 LIMIT 1`, [u.id_usuario]);
      idCaja = cu?.id_caja || null;
    } catch (_) {}

    const montoTotal = cuotasN.reduce((s, c) => s + c.total_pagado, 0);

    const [r] = await pool.query(
      `INSERT INTO ordenes_pago_cuotas
         (id_credito, numero_credito, rut_cliente, nombre_cliente, email_cliente,
          cuotas_json, n_cuotas, monto_total, origen_fondos, id_cuenta_bancaria,
          fecha_pago, observacion, estado,
          id_solicitante, solicitante_nombre, solicitante_email, id_caja)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'PENDIENTE',?,?,?,?)`,
      [
        id_credito, ctx.numero_credito || null, ctx.rut_cliente || null,
        ctx.nombre_cliente || null, ctx.email_cliente || null,
        JSON.stringify(cuotasN), cuotasN.length, montoTotal,
        origen_fondos, id_cuenta_bancaria ? parseInt(id_cuenta_bancaria) : null,
        fecha_pago || null, observacion || null,
        u.id_usuario || null, nombreUsuario(u), u.email || null, idCaja,
      ]
    );

    auditar({ req, accion: 'CREAR', modulo: 'cobranza', entidad: 'odp_cuotas', entidad_id: r.insertId,
      detalle: `Emitió ODP de cuotas #${r.insertId} — crédito ${id_credito}, ${cuotasN.length} cuota(s), ${clp(montoTotal)}`,
      meta: { id_credito, n_cuotas: cuotasN.length, monto_total: montoTotal, origen_fondos } });

    ok(res, { id_odp: r.insertId, n_cuotas: cuotasN.length, monto_total: montoTotal });
  } catch (e) { console.error('[odp emitir]', e.message); bad(res, 'Error interno del servidor', 500); }
};

/* ═══════════════════════ LISTAR (cola Tesorería) ═══════════════════════════ */
const listar = async (req, res) => {
  try {
    const estado = (req.query.estado || 'PENDIENTE').toUpperCase();
    const where  = estado === 'TODAS' ? '1=1' : 'estado = ?';
    const params = estado === 'TODAS' ? [] : [estado];
    const [rows] = await pool.query(
      `SELECT id_odp, id_credito, numero_credito, rut_cliente, nombre_cliente,
              n_cuotas, monto_total, origen_fondos, id_cuenta_bancaria, fecha_pago,
              observacion, estado, solicitante_nombre, solicitante_email,
              resolutor_nombre, fecha_resolucion, comentario_resolucion,
              numero_transaccion, created_at
         FROM ordenes_pago_cuotas
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT 500`, params);
    ok(res, rows);
  } catch (e) { console.error('[odp listar]', e.message); bad(res, 'Error interno del servidor', 500); }
};

/* ─── ODP propias del solicitante ──────────────────────────────────────────── */
const mias = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_odp, id_credito, numero_credito, nombre_cliente, n_cuotas, monto_total,
              origen_fondos, estado, fecha_resolucion, comentario_resolucion, created_at
         FROM ordenes_pago_cuotas
        WHERE id_solicitante = ?
        ORDER BY created_at DESC LIMIT 200`, [req.usuario?.id_usuario || 0]);
    ok(res, rows);
  } catch (e) { console.error('[odp mias]', e.message); bad(res, 'Error interno del servidor', 500); }
};

/* ─── Detalle ──────────────────────────────────────────────────────────────── */
const getById = async (req, res) => {
  try {
    const [[row]] = await pool.query(`SELECT * FROM ordenes_pago_cuotas WHERE id_odp = ?`, [req.params.id]);
    if (!row) return bad(res, 'ODP no encontrada.', 404);
    if (row.cuotas_json && typeof row.cuotas_json === 'string') {
      try { row.cuotas = JSON.parse(row.cuotas_json); } catch { row.cuotas = []; }
    } else { row.cuotas = row.cuotas_json || []; }
    delete row.cuotas_json;
    ok(res, row);
  } catch (e) { console.error('[odp getById]', e.message); bad(res, 'Error interno del servidor', 500); }
};

/* ═══════════════════════ APROBAR (registra pagos + correo) ═════════════════ */
const aprobar = async (req, res) => {
  const { comentario } = req.body || {};
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[odp]] = await conn.query(`SELECT * FROM ordenes_pago_cuotas WHERE id_odp = ? FOR UPDATE`, [req.params.id]);
    if (!odp)                       { await conn.rollback(); return bad(res, 'ODP no encontrada.', 404); }
    if (odp.estado !== 'PENDIENTE') { await conn.rollback(); return bad(res, `La ODP ya está ${odp.estado}.`); }

    let cuotas = [];
    try { cuotas = typeof odp.cuotas_json === 'string' ? JSON.parse(odp.cuotas_json) : (odp.cuotas_json || []); } catch { cuotas = []; }
    if (!cuotas.length) { await conn.rollback(); return bad(res, 'La ODP no tiene cuotas.'); }

    // Re-validar que no estén pagadas
    const nums = cuotas.map(c => c.numero_cuota);
    const [yaPagadas] = await conn.query(
      `SELECT numero_cuota FROM pagos_credito
        WHERE id_credito = ? AND estado_pago = 'PAGADO' AND numero_cuota IN (?)
        UNION
       SELECT numero_cuota FROM cuotas_credito
        WHERE id_credito = ? AND estado_cuota = 'PAGADA' AND numero_cuota IN (?)`,
      [odp.id_credito, nums, odp.id_credito, nums]
    );
    if (yaPagadas.length) {
      await conn.rollback();
      return bad(res, `No se puede aprobar: las cuotas ${yaPagadas.map(r => r.numero_cuota).join(', ')} ya fueron pagadas.`);
    }

    // Correlativo global (mismo libro que el pago en lote de caja)
    const [corr] = await conn.query(`INSERT INTO correlativo_transacciones (created_at) VALUES (NOW())`);
    const numero_transaccion = corr.insertId;

    const u = req.usuario || {};
    const resolutor = nombreUsuario(u);
    const fechaPago = odp.fecha_pago || new Date().toISOString().slice(0, 10);
    const obsPago   = `ODP #${odp.id_odp} aprobada por ${resolutor || 'Tesorería'}`;

    for (const c of cuotas) {
      const monto  = Math.round(parseFloat(c.monto_cuota)     || 0);
      const mora   = Math.round(parseFloat(c.interes_mora)    || 0);
      const gastos = Math.round(parseFloat(c.gastos_cobranza) || 0);
      const total  = Math.round(parseFloat(c.total_pagado)    || (monto + mora + gastos));
      await conn.query(
        `INSERT INTO pagos_credito
           (id_credito, numero_cuota, fecha_vencimiento, monto_cuota, interes_mora,
            gastos_cobranza, total_pagado, fecha_pago, estado_pago, observacion,
            registrado_por, id_registrado_por, id_caja, origen_fondos,
            id_cuenta_bancaria, numero_transaccion)
         VALUES (?,?,?,?,?,?,?,?,'PAGADO',?,?,?,?,?,?,?)`,
        [
          odp.id_credito, c.numero_cuota, c.fecha_vencimiento || null,
          monto, mora, gastos, total, fechaPago, obsPago,
          resolutor, u.id_usuario || null, odp.id_caja || null,
          odp.origen_fondos || null, odp.id_cuenta_bancaria || null, numero_transaccion,
        ]
      );
    }

    await conn.query(
      `UPDATE ordenes_pago_cuotas
          SET estado='APROBADA', id_resolutor=?, resolutor_nombre=?, fecha_resolucion=NOW(),
              comentario_resolucion=?, numero_transaccion=?
        WHERE id_odp=?`,
      [u.id_usuario || null, resolutor, comentario || null, numero_transaccion, odp.id_odp]
    );

    await conn.commit();

    // ── Correo del comprobante (no crítico: fuera de la transacción) ──────────
    let correoMsg = null;
    const totalPagado = cuotas.reduce((s, c) => s + Math.round(parseFloat(c.total_pagado) || 0), 0);
    if (odp.email_cliente) {
      const html = comprobanteEmailHTML({
        credito: { id_credito: odp.id_credito, numero_credito: odp.numero_credito, nombre_cliente: odp.nombre_cliente },
        cuotas, trxNum: numero_transaccion, fechaPago, total: totalPagado, origen: odp.origen_fondos,
      });
      const r = await enviarCorreo({
        to:      odp.email_cliente,
        bcc:     odp.solicitante_email || undefined,
        from:    remitenteCobranza(),
        subject: `Comprobante de pago — Crédito N° ${odp.numero_credito || odp.id_credito} (TRX-${String(numero_transaccion).padStart(6,'0')})`,
        html,
      });
      correoMsg = r.ok ? 'enviado' : ('no enviado: ' + r.error);
      if (r.ok) { try { await pool.query(`UPDATE ordenes_pago_cuotas SET correo_enviado=1 WHERE id_odp=?`, [odp.id_odp]); } catch (_) {} }
    } else {
      correoMsg = 'sin email del cliente';
    }

    try {
      audit.registrar({ id_credito: odp.id_credito, req, accion: 'PAGO_ODP_APROBADA',
        detalle: `ODP #${odp.id_odp} aprobada — ${cuotas.length} cuota(s), ${clp(totalPagado)} — TRX #${numero_transaccion}`,
        meta: { id_odp: odp.id_odp, numero_transaccion, cuotas: nums, total: totalPagado } });
    } catch (_) {}
    auditar({ req, accion: 'APROBAR', modulo: 'cobranza', entidad: 'odp_cuotas', entidad_id: odp.id_odp,
      detalle: `Aprobó ODP de cuotas #${odp.id_odp} (crédito ${odp.id_credito}) — ${clp(totalPagado)}, TRX #${numero_transaccion}, correo ${correoMsg}`,
      meta: { id_credito: odp.id_credito, numero_transaccion, total: totalPagado, correo: correoMsg } });

    ok(res, { id_odp: odp.id_odp, estado: 'APROBADA', numero_transaccion, total: totalPagado, correo: correoMsg });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[odp aprobar]', e.message);
    bad(res, 'Error interno del servidor', 500);
  } finally { conn.release(); }
};

/* ═══════════════════════ RECHAZAR ══════════════════════════════════════════ */
const rechazar = async (req, res) => {
  try {
    const { comentario } = req.body || {};
    if (!comentario?.trim()) return bad(res, 'El comentario es obligatorio para rechazar.');
    const [[odp]] = await pool.query(`SELECT id_odp, estado, id_credito FROM ordenes_pago_cuotas WHERE id_odp = ?`, [req.params.id]);
    if (!odp)                       return bad(res, 'ODP no encontrada.', 404);
    if (odp.estado !== 'PENDIENTE') return bad(res, `La ODP ya está ${odp.estado}.`);
    const u = req.usuario || {};
    await pool.query(
      `UPDATE ordenes_pago_cuotas
          SET estado='RECHAZADA', id_resolutor=?, resolutor_nombre=?, fecha_resolucion=NOW(), comentario_resolucion=?
        WHERE id_odp=?`,
      [u.id_usuario || null, nombreUsuario(u), comentario.trim(), odp.id_odp]
    );
    auditar({ req, accion: 'RECHAZAR', modulo: 'cobranza', entidad: 'odp_cuotas', entidad_id: odp.id_odp,
      detalle: `Rechazó ODP de cuotas #${odp.id_odp} (crédito ${odp.id_credito}) — ${comentario.trim()}` });
    ok(res, { id_odp: odp.id_odp, estado: 'RECHAZADA' });
  } catch (e) { console.error('[odp rechazar]', e.message); bad(res, 'Error interno del servidor', 500); }
};

/* ═══════════════════════ ANULAR (el propio solicitante) ════════════════════ */
const anular = async (req, res) => {
  try {
    const [[odp]] = await pool.query(`SELECT id_odp, estado, id_solicitante FROM ordenes_pago_cuotas WHERE id_odp = ?`, [req.params.id]);
    if (!odp)                       return bad(res, 'ODP no encontrada.', 404);
    if (odp.estado !== 'PENDIENTE') return bad(res, `Sólo se pueden anular ODP pendientes (esta está ${odp.estado}).`);
    const u = req.usuario || {};
    const esAdmin = (u.perfil_nombre === 'Administrador');
    if (!esAdmin && odp.id_solicitante !== u.id_usuario)
      return bad(res, 'Sólo el solicitante (o un administrador) puede anular esta ODP.', 403);
    await pool.query(`UPDATE ordenes_pago_cuotas SET estado='ANULADA' WHERE id_odp=?`, [odp.id_odp]);
    auditar({ req, accion: 'ANULAR', modulo: 'cobranza', entidad: 'odp_cuotas', entidad_id: odp.id_odp,
      detalle: `Anuló ODP de cuotas #${odp.id_odp}` });
    ok(res, { id_odp: odp.id_odp, estado: 'ANULADA' });
  } catch (e) { console.error('[odp anular]', e.message); bad(res, 'Error interno del servidor', 500); }
};

module.exports = { emitir, listar, mias, getById, aprobar, rechazar, anular };
