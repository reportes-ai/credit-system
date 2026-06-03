const pool = require('../../../../shared/config/database');

const ok  = (res, data) => res.json({ success: true, data, error: null });
const err = (res, e, code = 500) => res.status(code).json({ success: false, data: null, error: e.message || e });

/*
 * GET /api/cierre-caja?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&id_usuario=&id_caja=
 * Retorna:
 *   - movimientos: PAGOS (ABONO) + REVERSIONES (CARGO) del período
 *   - transitorias: cuentas_transitorias + cartola del período
 *   - resumen por usuario
 *   - totales netos
 */
const getCierre = async (req, res) => {
  try {
    const hoy     = new Date().toISOString().slice(0, 10);
    const desde   = req.query.desde || hoy;
    const hasta   = req.query.hasta || hoy;
    const id_usuario = req.query.id_usuario || null;
    const id_caja    = req.query.id_caja    || null;

    /* ── usuarios de la caja ─────────────────────────────────────────────── */
    let usuariosEnCaja = null;
    if (id_caja) {
      const [urows] = await pool.query(
        `SELECT id_usuario FROM caja_usuarios WHERE id_caja = ? AND activo = 1`,
        [id_caja]
      );
      usuariosEnCaja = urows.map(r => r.id_usuario);
      if (!usuariosEnCaja.length) {
        return ok(res, {
          movimientos: [], transitorias: [], cartola: [], resumen: [],
          totales: { transacciones: 0, monto_cuotas: 0, intereses_mora: 0, gastos_cobranza: 0,
                     total_pagos: 0, total_reversiones: 0, total_neto: 0, total_transitorias: 0, total_recaudado: 0 },
          desde, hasta
        });
      }
    }

    /* ── nombre completo del usuario filtrado ────────────────────────────── */
    let nombreFiltrado = '';
    if (id_usuario) {
      const [[urow]] = await pool.query(
        `SELECT TRIM(CONCAT(COALESCE(nombre,''),' ',COALESCE(apellido,''))) AS nc FROM usuarios WHERE id_usuario=?`,
        [id_usuario]
      ).catch(() => [[null]]);
      nombreFiltrado = urow?.nc?.trim() || '';
    }

    /* ── columnas comunes ────────────────────────────────────────────────── */
    const CAMPOS_PAGO = `
      pc.id_pago, pc.id_credito, pc.numero_cuota,
      pc.monto_cuota, pc.interes_mora, pc.gastos_cobranza, pc.total_pagado,
      pc.fecha_pago, pc.created_at, pc.numero_transaccion, pc.origen_fondos,
      pc.id_cuenta_bancaria, pc.comentario_reverso,
      pc.registrado_por, pc.id_registrado_por,
      c.numero_credito,
      COALESCE(cl.nombre_completo, '') AS nombre_cliente,
      COALESCE(cl.rut,             '') AS rut_cliente,
      TRIM(CONCAT(COALESCE(u.nombre,''),' ',COALESCE(u.apellido,''))) AS nombre_cajero,
      pr.nombre AS perfil_cajero,
      COALESCE(pc.id_caja, cu.id_caja) AS id_caja,
      cj.nombre AS nombre_caja,
      cb.numero_cuenta, cb.banco AS banco_nombre`;

    const JOIN_BASE = `
      FROM pagos_credito pc
      LEFT JOIN creditos         c  ON pc.id_credito = c.id
      LEFT JOIN clientes         cl ON cl.id_cliente = c.id_cliente
      LEFT JOIN usuarios         u  ON pc.id_registrado_por = u.id_usuario
      LEFT JOIN perfiles         pr ON u.id_perfil = pr.id_perfil
      LEFT JOIN caja_usuarios    cu ON cu.id_usuario = pc.id_registrado_por AND cu.activo = 1
      LEFT JOIN cajas            cj ON cj.id_caja = COALESCE(pc.id_caja, cu.id_caja)
      LEFT JOIN cuentas_bancarias cb ON pc.id_cuenta_bancaria = cb.id_cuenta`;

    /* ── 1. PAGOS del período (ABONO) ─────────────────────────────────────── */
    let whereP  = `pc.estado_pago = 'PAGADO' AND DATE(pc.created_at) BETWEEN ? AND ?`;
    const parP  = [desde, hasta];
    if (id_usuario) {
      whereP += ` AND (pc.id_registrado_por = ? OR (pc.id_registrado_por IS NULL AND pc.registrado_por = ?))`;
      parP.push(id_usuario, nombreFiltrado);
    } else if (usuariosEnCaja) {
      whereP += ` AND pc.id_registrado_por IN (${usuariosEnCaja.map(() => '?').join(',')})`;
      parP.push(...usuariosEnCaja);
    }

    const [pagos] = await pool.query(
      `SELECT ${CAMPOS_PAGO},
              'ABONO'          AS tipo_mov,
              pc.created_at    AS fecha_mov
       ${JOIN_BASE}
       WHERE ${whereP}
       ORDER BY pc.numero_transaccion DESC, pc.numero_cuota ASC`,
      parP
    );

    /* ── 2. REVERSIONES del período (CARGO) ───────────────────────────────── */
    let whereR  = `pc.estado_pago = 'REVERSADO' AND DATE(pc.fecha_reverso) BETWEEN ? AND ?`;
    const parR  = [desde, hasta];
    if (id_usuario) {
      whereR += ` AND pc.id_reversado_por = ?`;
      parR.push(id_usuario);
    } else if (usuariosEnCaja) {
      // La reversión cuenta para la caja donde se registró el pago original
      whereR += ` AND pc.id_registrado_por IN (${usuariosEnCaja.map(() => '?').join(',')})`;
      parR.push(...usuariosEnCaja);
    }

    const [reversiones] = await pool.query(
      `SELECT
          pc.id_pago, pc.id_credito, pc.numero_cuota,
          pc.monto_cuota, pc.interes_mora, pc.gastos_cobranza, pc.total_pagado,
          pc.fecha_pago, pc.created_at, pc.numero_transaccion,
          NULL AS origen_fondos, pc.id_cuenta_bancaria, pc.comentario_reverso,
          pc.reversado_por    AS registrado_por,
          pc.id_reversado_por AS id_registrado_por,
          c.numero_credito,
          COALESCE(cl2.nombre_completo, '') AS nombre_cliente,
          COALESCE(cl2.rut,             '') AS rut_cliente,
          TRIM(CONCAT(COALESCE(ur.nombre,''),' ',COALESCE(ur.apellido,''))) AS nombre_cajero,
          prr.nombre AS perfil_cajero,
          COALESCE(pc.id_caja, cu2.id_caja) AS id_caja,
          cj2.nombre AS nombre_caja,
          NULL AS numero_cuenta, NULL AS banco_nombre,
          'CARGO'          AS tipo_mov,
          pc.fecha_reverso AS fecha_mov
       FROM pagos_credito pc
       LEFT JOIN creditos         c   ON pc.id_credito = c.id
       LEFT JOIN clientes         cl2 ON cl2.id_cliente = c.id_cliente
       LEFT JOIN usuarios         ur  ON pc.id_reversado_por = ur.id_usuario
       LEFT JOIN perfiles         prr ON ur.id_perfil = prr.id_perfil
       LEFT JOIN caja_usuarios    cu2 ON cu2.id_usuario = pc.id_registrado_por AND cu2.activo = 1
       LEFT JOIN cajas            cj2 ON cj2.id_caja = COALESCE(pc.id_caja, cu2.id_caja)
       WHERE ${whereR}
       ORDER BY pc.fecha_reverso DESC`,
      parR
    );

    /* ── Merge y ordenar por fecha_mov DESC ──────────────────────────────── */
    const movimientos = [...pagos, ...reversiones].sort(
      (a, b) => new Date(b.fecha_mov || b.created_at) - new Date(a.fecha_mov || a.created_at)
    );

    /* ── 3. Cuentas transitorias + cartola del período ──────────────────── */
    const [transitorias] = await pool.query(
      `SELECT
          ct.id_transitoria, ct.id_credito, ct.numero_transaccion,
          ct.fecha, ct.monto_original, ct.monto_utilizado,
          ROUND(ct.monto_original - ct.monto_utilizado, 2) AS saldo,
          ct.glosa, ct.estado, ct.created_at,
          c.numero_credito,
          COALESCE(cl3.nombre_completo, '') AS nombre_cliente,
          COALESCE(cl3.rut,             '') AS rut_cliente
       FROM cuentas_transitorias ct
       LEFT JOIN creditos  c   ON ct.id_credito = c.id
       LEFT JOIN clientes  cl3 ON cl3.id_cliente = c.id_cliente
       WHERE DATE(ct.created_at) BETWEEN ? AND ?
       ORDER BY ct.created_at DESC`,
      [desde, hasta]
    ).catch(() => [[]]);

    // Cartola de movimientos de las transitorias encontradas
    let cartola = [];
    const idsTransitorias = (transitorias || []).map(t => t.id_transitoria);
    if (idsTransitorias.length) {
      const [cart] = await pool.query(
        `SELECT tc.*, ct.glosa AS glosa_transitoria,
                c.numero_credito, COALESCE(cl_tc.nombre_completo,'') AS nombre_cliente
         FROM transitorias_cartola tc
         LEFT JOIN cuentas_transitorias ct ON tc.id_transitoria = ct.id_transitoria
         LEFT JOIN creditos c ON tc.id_credito = c.id_credito
         LEFT JOIN clientes cl_tc ON cl_tc.id_cliente = c.id_cliente
         WHERE tc.id_transitoria IN (${idsTransitorias.map(() => '?').join(',')})
         ORDER BY tc.created_at ASC`,
        idsTransitorias
      ).catch(() => [[]]);
      cartola = cart || [];
    }

    /* ── 4. Resumen por cajero (solo ABONOs) ─────────────────────────────── */
    const resumenMap = new Map();
    for (const m of pagos) {   // solo pagos, no reversiones
      const key = m.id_registrado_por != null ? `uid_${m.id_registrado_por}` : (m.registrado_por || 'Sin usuario');
      if (!resumenMap.has(key)) {
        resumenMap.set(key, {
          id_usuario: m.id_registrado_por, nombre: m.nombre_cajero?.trim() || m.registrado_por || 'Sin usuario',
          perfil: m.perfil_cajero || null, nombre_caja: m.nombre_caja || '—',
          _trxSet: new Set(), monto_cuotas: 0, intereses_mora: 0, gastos_cobranza: 0, total_recaudado: 0,
        });
      }
      const r = resumenMap.get(key);
      r._trxSet.add(m.numero_transaccion != null ? `t${m.numero_transaccion}` : `p${m.id_pago}`);
      r.monto_cuotas    += Number(m.monto_cuota)     || 0;
      r.intereses_mora  += Number(m.interes_mora)    || 0;
      r.gastos_cobranza += Number(m.gastos_cobranza) || 0;
      r.total_recaudado += Number(m.total_pagado)    || 0;
    }
    const resumen = [...resumenMap.values()].map(r => {
      const { _trxSet, ...rest } = r;
      return { ...rest, transacciones: _trxSet.size };
    });

    /* ── 5. Totales ──────────────────────────────────────────────────────── */
    const globalTrxSet = new Set();
    for (const m of pagos) {
      globalTrxSet.add(m.numero_transaccion != null ? `t${m.numero_transaccion}` : `p${m.id_pago}`);
    }

    const totalPagos      = pagos.reduce((s, m) => s + (Number(m.total_pagado) || 0), 0);
    const totalReversiones= reversiones.reduce((s, m) => s + (Number(m.total_pagado) || 0), 0);
    const totalNeto       = totalPagos - totalReversiones;
    const totalTransit    = (transitorias || []).reduce((s, t) => s + (Number(t.monto_original) || 0), 0);

    const totales = {
      transacciones:      globalTrxSet.size,
      reversiones:        reversiones.length,
      monto_cuotas:       resumen.reduce((s, r) => s + r.monto_cuotas, 0),
      intereses_mora:     resumen.reduce((s, r) => s + r.intereses_mora, 0),
      gastos_cobranza:    resumen.reduce((s, r) => s + r.gastos_cobranza, 0),
      total_pagos:        totalPagos,
      total_reversiones:  totalReversiones,
      total_neto:         totalNeto,
      total_transitorias: totalTransit,
      total_recaudado:    totalNeto,  // neto = bruto - reversiones
    };

    ok(res, { movimientos, transitorias: transitorias || [], cartola, resumen, totales, desde, hasta });
  } catch(e) { err(res, e); }
};

/* GET /api/cierre-caja/cajeros */
const getCajeros = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT u.id_usuario,
          TRIM(CONCAT(COALESCE(u.nombre,''),' ',COALESCE(u.apellido,''))) AS nombre,
          p.nombre AS perfil, cj.id_caja, cj.nombre AS nombre_caja
       FROM usuarios u
       LEFT JOIN perfiles p ON u.id_perfil = p.id_perfil
       LEFT JOIN caja_usuarios cu ON cu.id_usuario = u.id_usuario AND cu.activo = 1
       LEFT JOIN cajas cj ON cu.id_caja = cj.id_caja
       WHERE u.activo = 1 ORDER BY nombre`
    );
    ok(res, rows);
  } catch(e) { err(res, e); }
};

module.exports = { getCierre, getCajeros };
