'use strict';
/* ── Cuadro de Mando (TV de la oficina) ───────────────────────────────────
   Un solo endpoint agregado que alimenta /mando/ — todo son lecturas
   (COUNT/SUM) sobre las fuentes únicas: creditos, cartas_aprobacion, uf,
   tasas, presupuesto del dashboard, pagos y gestiones del día. */
const pool = require('../../../../shared/config/database');
const { conectadosIds } = require('../../../../shared/presencia');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg) => res.status(500).json({ success: false, data: null, error: msg });

exports.mando = async (req, res) => {
  try {
    const [
      [[uf]], [[tasa]], ejecutivos,
      [[cartasHoy]], cartasHora, [[otHoy]],
      [[mtd]], [[prevMismo]], [[prevTotal]], [[anioMismo]], [[anioTotal]],
      [[pagosHoy]], [[gestHoy]], [[wspHoy]], pptoRow,
    ] = await Promise.all([
      pool.query('SELECT valor, DATE_FORMAT(fecha,"%Y-%m-%d") fecha FROM uf WHERE fecha <= CURDATE() ORDER BY fecha DESC LIMIT 1'),
      pool.query('SELECT tasa_mensual_menor, tasa_mensual_mayor FROM tasas WHERE fecha_desde <= CURDATE() ORDER BY fecha_desde DESC LIMIT 1'),
      pool.query(`
        SELECT u.id_usuario, CONCAT(u.nombre,' ',COALESCE(u.apellido,'')) nombre
        FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
        WHERE COALESCE(u.estado,'') <> 'SUSPENDIDO'
          AND (LOWER(p.nombre) LIKE '%ejecutivo%' OR LOWER(p.nombre) LIKE '%comercial%')
        ORDER BY u.nombre`).then(r => r[0]),
      pool.query("SELECT COUNT(*) n FROM cartas_aprobacion WHERE DATE(fecha_creacion)=CURDATE() AND COALESCE(status,'') NOT IN ('ELIMINADA')"),
      pool.query("SELECT HOUR(fecha_creacion) h, COUNT(*) n FROM cartas_aprobacion WHERE DATE(fecha_creacion)=CURDATE() GROUP BY 1 ORDER BY 1").then(r => r[0]),
      pool.query("SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos WHERE estado_credito='OTORGADO' AND fecha_otorgado=CURDATE()"),
      // Mes actual a la fecha
      pool.query(`SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO' AND fecha_otorgado BETWEEN DATE_FORMAT(CURDATE(),'%Y-%m-01') AND CURDATE()`),
      // Mes anterior, mismos días (1..D)
      pool.query(`SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO'
          AND fecha_otorgado BETWEEN DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH),'%Y-%m-01')
          AND DATE_SUB(CURDATE(), INTERVAL 1 MONTH)`),
      pool.query(`SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO'
          AND fecha_otorgado BETWEEN DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH),'%Y-%m-01')
          AND LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))`),
      // Mismo mes año anterior, mismos días y total
      pool.query(`SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO'
          AND fecha_otorgado BETWEEN DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR),'%Y-%m-01')
          AND DATE_SUB(CURDATE(), INTERVAL 1 YEAR)`),
      pool.query(`SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO'
          AND fecha_otorgado BETWEEN DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR),'%Y-%m-01')
          AND LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 YEAR))`),
      // Ticker del día
      pool.query("SELECT COUNT(*) n, COALESCE(SUM(total_pagado),0) monto FROM pagos_credito WHERE DATE(COALESCE(fecha_pago, created_at))=CURDATE() AND fecha_reverso IS NULL"),
      pool.query('SELECT COUNT(*) n FROM cobranza_gestiones WHERE DATE(created_at)=CURDATE()'),
      pool.query('SELECT COUNT(*) n FROM wsp_mensajes WHERE DATE(created_at)=CURDATE()').catch(() => [[{ n: null }]]),
      pool.query("SELECT config_value FROM dashboard_config WHERE config_key='presupuesto'").then(r => r[0][0] || null),
    ]);

    const vivos = conectadosIds();
    const lista = ejecutivos.map(e => ({ nombre: e.nombre.trim(), conectado: vivos.has(Number(e.id_usuario)) }));

    // Presupuesto del mes en curso ({mes:'YYYY-MM', ops, monto} — monto en MM$)
    let ppto = null;
    try {
      const arr = JSON.parse(pptoRow?.config_value || '[]');
      const mesActual = new Date().toISOString().slice(0, 7);
      ppto = arr.find(x => x.mes === mesActual) || null;
    } catch (e) { ppto = null; }

    ok(res, {
      ahora: new Date().toISOString(),
      indicadores: {
        uf: uf ? Number(uf.valor) : null, uf_fecha: uf?.fecha || null,
        tmc_menor: tasa ? Number(tasa.tasa_mensual_menor) : null,
        tmc_mayor: tasa ? Number(tasa.tasa_mensual_mayor) : null,
      },
      ejecutivos: { total: lista.length, conectados: lista.filter(e => e.conectado).length, lista },
      hoy: {
        cartas: Number(cartasHoy.n) || 0,
        cartasPorHora: cartasHora.map(r => ({ h: Number(r.h), n: Number(r.n) })),
        otorgados: Number(otHoy.n) || 0,
        monto_otorgado: Math.round(Number(otHoy.monto) || 0),
        pagos: Number(pagosHoy.n) || 0, monto_pagos: Math.round(Number(pagosHoy.monto) || 0),
        gestiones_cobranza: Number(gestHoy.n) || 0,
        mensajes_wsp: wspHoy.n == null ? null : Number(wspHoy.n),
      },
      mes: {
        mtd_n: Number(mtd.n) || 0, mtd_monto: Math.round(Number(mtd.monto) || 0),
        prev_mismo_n: Number(prevMismo.n) || 0, prev_mismo_monto: Math.round(Number(prevMismo.monto) || 0),
        prev_total_n: Number(prevTotal.n) || 0,
        anio_mismo_n: Number(anioMismo.n) || 0, anio_mismo_monto: Math.round(Number(anioMismo.monto) || 0),
        anio_total_n: Number(anioTotal.n) || 0,
        presupuesto: ppto,   // { mes, ops, monto (MM$) } o null
      },
    });
  } catch (e) { console.error('[mando]', e.message); fail(res, e.message); }
};
