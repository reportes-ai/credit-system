const pool = require('../../../../shared/config/database');

const ok  = (res, data) => res.json({ success: true, data, error: null });
const err = (res, e, code = 500) => res.status(code).json({ success: false, data: null, error: e.message || e });

/*
 * GET /api/cierre-caja?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&id_usuario=&id_caja=
 * Retorna:
 *   - movimientos (pagos_credito con numero_transaccion y origen_fondos)
 *   - transitorias (cuentas_transitorias creadas en el período)
 *   - resumen por usuario (contando transacciones distintas)
 *   - totales generales (total_pagos + total_transitorias = total_recaudado)
 */
const getCierre = async (req, res) => {
  try {
    const hoy  = new Date().toISOString().slice(0, 10);
    const desde = req.query.desde || hoy;
    const hasta = req.query.hasta || hoy;
    const id_usuario = req.query.id_usuario || null;
    const id_caja    = req.query.id_caja    || null;

    /* ── filtro por usuario de caja ──────────────────────────────────────── */
    let usuariosEnCaja = null;
    if (id_caja) {
      const [urows] = await pool.query(
        `SELECT id_usuario FROM caja_usuarios WHERE id_caja = ? AND activo = 1`,
        [id_caja]
      );
      usuariosEnCaja = urows.map(r => r.id_usuario);
      if (usuariosEnCaja.length === 0) {
        return ok(res, {
          movimientos: [], transitorias: [], resumen: [],
          totales: { transacciones: 0, monto_cuotas: 0, intereses_mora: 0, gastos_cobranza: 0, total_pagos: 0, total_transitorias: 0, total_recaudado: 0 },
          desde, hasta
        });
      }
    }

    /* ── query movimientos ───────────────────────────────────────────────── */
    let where  = `DATE(pc.created_at) BETWEEN ? AND ?`;
    const params = [desde, hasta];

    if (id_usuario) {
      const [[urow]] = await pool.query(
        `SELECT TRIM(CONCAT(COALESCE(nombre,''),' ',COALESCE(apellido,''))) AS nombre_completo FROM usuarios WHERE id_usuario=?`,
        [id_usuario]
      ).catch(() => [[null]]);
      where += ` AND (pc.id_registrado_por = ? OR (pc.id_registrado_por IS NULL AND pc.registrado_por = ?))`;
      params.push(id_usuario, urow?.nombre_completo?.trim() || '');
    } else if (usuariosEnCaja) {
      where += ` AND pc.id_registrado_por IN (${usuariosEnCaja.map(() => '?').join(',')})`;
      params.push(...usuariosEnCaja);
    }

    const [movimientos] = await pool.query(
      `SELECT
          pc.id_pago,
          pc.id_credito,
          pc.numero_cuota,
          pc.monto_cuota,
          pc.interes_mora,
          pc.gastos_cobranza,
          pc.total_pagado,
          pc.fecha_pago,
          pc.created_at,
          pc.registrado_por,
          pc.id_registrado_por,
          pc.numero_transaccion,
          pc.origen_fondos,
          c.numero_credito,
          c.nombre_cliente,
          c.rut_cliente,
          TRIM(CONCAT(COALESCE(u.nombre,''),' ',COALESCE(u.apellido,''))) AS nombre_cajero,
          p.nombre AS perfil_cajero,
          cu.id_caja,
          cj.nombre AS nombre_caja
       FROM pagos_credito pc
       LEFT JOIN creditos c ON pc.id_credito = c.id_credito
       LEFT JOIN usuarios u ON pc.id_registrado_por = u.id_usuario
       LEFT JOIN perfiles p ON u.id_perfil = p.id_perfil
       LEFT JOIN caja_usuarios cu ON cu.id_usuario = pc.id_registrado_por AND cu.activo = 1
       LEFT JOIN cajas cj ON cu.id_caja = cj.id_caja
       WHERE ${where}
       ORDER BY pc.numero_transaccion DESC, pc.numero_cuota ASC`,
      params
    );

    /* ── cuentas transitorias del período ───────────────────────────────── */
    const [transitorias] = await pool.query(
      `SELECT
          ct.id_transitoria,
          ct.id_credito,
          ct.numero_transaccion,
          ct.fecha,
          ct.monto_original,
          ct.monto_utilizado,
          ROUND(ct.monto_original - ct.monto_utilizado, 2) AS saldo,
          ct.glosa,
          ct.estado,
          ct.created_at,
          c.numero_credito,
          c.nombre_cliente,
          c.rut_cliente
       FROM cuentas_transitorias ct
       LEFT JOIN creditos c ON ct.id_credito = c.id_credito
       WHERE DATE(ct.created_at) BETWEEN ? AND ?
       ORDER BY ct.created_at DESC`,
      [desde, hasta]
    ).catch(() => [[]]);

    /* ── resumen por usuario (transacciones distintas) ──────────────────── */
    const resumenMap = new Map();
    for (const m of movimientos) {
      const key = m.id_registrado_por != null ? `uid_${m.id_registrado_por}` : (m.registrado_por || 'Sin usuario');
      if (!resumenMap.has(key)) {
        resumenMap.set(key, {
          id_usuario:      m.id_registrado_por,
          nombre:          m.nombre_cajero?.trim() || m.registrado_por || 'Sin usuario',
          perfil:          m.perfil_cajero || null,
          nombre_caja:     m.nombre_caja || '—',
          _trxSet:         new Set(),
          monto_cuotas:    0,
          intereses_mora:  0,
          gastos_cobranza: 0,
          total_recaudado: 0,
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

    /* ── totales generales ───────────────────────────────────────────────── */
    // Contar transacciones únicas globales
    const globalTrxSet = new Set();
    for (const m of movimientos) {
      globalTrxSet.add(m.numero_transaccion != null ? `t${m.numero_transaccion}` : `p${m.id_pago}`);
    }

    const totalPagos         = resumen.reduce((s, r) => s + r.total_recaudado, 0);
    const totalTransitorias  = (transitorias || []).reduce((s, t) => s + (Number(t.monto_original) || 0), 0);
    const totales = {
      transacciones:     globalTrxSet.size,
      monto_cuotas:      resumen.reduce((s, r) => s + r.monto_cuotas, 0),
      intereses_mora:    resumen.reduce((s, r) => s + r.intereses_mora, 0),
      gastos_cobranza:   resumen.reduce((s, r) => s + r.gastos_cobranza, 0),
      total_pagos:       totalPagos,
      total_transitorias: totalTransitorias,
      total_recaudado:   totalPagos + totalTransitorias,
    };

    ok(res, { movimientos, transitorias: transitorias || [], resumen, totales, desde, hasta });
  } catch(e) { err(res, e); }
};

/* GET /api/cierre-caja/cajeros  — lista cajeros activos con caja asignada */
const getCajeros = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT
          u.id_usuario,
          TRIM(CONCAT(COALESCE(u.nombre,''),' ',COALESCE(u.apellido,''))) AS nombre,
          p.nombre AS perfil,
          cj.id_caja,
          cj.nombre AS nombre_caja
       FROM usuarios u
       LEFT JOIN perfiles p ON u.id_perfil = p.id_perfil
       LEFT JOIN caja_usuarios cu ON cu.id_usuario = u.id_usuario AND cu.activo = 1
       LEFT JOIN cajas cj ON cu.id_caja = cj.id_caja
       WHERE u.activo = 1
       ORDER BY nombre`
    );
    ok(res, rows);
  } catch(e) { err(res, e); }
};

module.exports = { getCierre, getCajeros };
