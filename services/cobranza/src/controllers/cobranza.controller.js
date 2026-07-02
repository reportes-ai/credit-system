'use strict';

const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { getUF } = require('../../../../shared/uf');

// ─── Migración automática ─────────────────────────────────────────────────────
(async () => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cobranza_gestiones (
        id_gestion       INT AUTO_INCREMENT PRIMARY KEY,
        id_credito       INT NOT NULL,
        numero_credito   VARCHAR(20),
        rut_cliente      VARCHAR(20),
        nombre_cliente   VARCHAR(300),
        tipo_gestion     ENUM('LLAMADA','VISITA','WHATSAPP','SMS','EMAIL','CARTA') NOT NULL,
        canal            ENUM('TELEFONICA','PRESENCIAL','REMOTA') NOT NULL,
        dias_mora        INT,
        cuotas_mora      INT,
        monto_mora       BIGINT,
        mensaje          TEXT,
        resultado        ENUM('CONTACTADO','NO_CONTESTA','PROMESA_PAGO','RECHAZA_PAGO','NUMERO_ERRADO','SIN_RESULTADO') DEFAULT 'SIN_RESULTADO',
        fecha_promesa    DATE NULL,
        monto_promesa    BIGINT NULL,
        confirmado       TINYINT(1) DEFAULT 0,
        id_usuario       INT NOT NULL,
        nombre_usuario   VARCHAR(200),
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_credito (id_credito),
        INDEX idx_usuario (id_usuario),
        INDEX idx_created (created_at)
      )
    `);
    console.log('✓ Cobranza: tabla cobranza_gestiones verificada');
  } catch (err) {
    console.error('✗ Cobranza migración:', err.message);
  } finally {
    if (conn) conn.release();
  }
})();

// ─── Parámetros de Cobranza (mantenedor) ───────────────────────────────────────
// Plantillas de mensaje (con variables {trato} {nombre} {numero} {dias} {cuotas}
// {monto} {datos}), gastos de cobranza y tramos UF. Todo editable por el Admin.
const COB_DEFAULTS = {
  datos_transferencia: 'Titular: AUTOFACIL SpA\nRUT: 76.545.638-K\nBanco: Banco de Chile\nCuenta Corriente: 8001829208\nMail: cobranza@autofacilchile.cl',
  texto_whatsapp: '{trato} {nombre}, le informamos que su crédito N° {numero} se encuentra en mora hace {dias} días, con {cuotas} cuota(s) impaga(s) por un total de ${monto} al día de hoy.\n\n{datos}',
  texto_sms: '{trato} {nombre}, su crédito N° {numero} tiene {cuotas} cuota(s) impaga(s) por ${monto} ({dias} días mora).\n{datos}',
  texto_email_asunto: '[AutoFácil] Aviso de mora — Crédito N° {numero}',
  texto_email: '{trato} {nombre},\n\nLe informamos que su crédito N° {numero} se encuentra en mora hace {dias} días, con {cuotas} cuota(s) impaga(s) por un total de ${monto} al día de hoy.\n\nPara regularizar su situación puede realizar una transferencia con los siguientes datos:\n\n{datos}\n\nAtentamente,\nEquipo de Cobranza AutoFácil',
  // Gastos de cobranza (Ley 19.496): solo después de 20 días corridos desde el
  // vencimiento → día 21. Tramos MARGINALES sobre la deuda en UF (límite superior + %):
  //   hasta 10 UF → 9% · entre 10 y 50 UF → 6% · sobre 50 UF → 3% (hasta_uf null = resto)
  gastos_dias: '21',
  tramos_uf: JSON.stringify([{ hasta_uf: 10, pct: 9 }, { hasta_uf: 50, pct: 6 }, { hasta_uf: null, pct: 3 }]),
};
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS cobranza_config (
      clave VARCHAR(50) PRIMARY KEY,
      valor TEXT,
      fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    for (const [clave, valor] of Object.entries(COB_DEFAULTS))
      await pool.query('INSERT IGNORE INTO cobranza_config (clave, valor) VALUES (?, ?)', [clave, valor]);
    // Parche: migrar el modelo viejo de tramos ({uf,pct}) al legal ({hasta_uf,pct})
    try {
      const [[tr]] = await pool.query("SELECT valor FROM cobranza_config WHERE clave='tramos_uf'");
      if (tr) { const a = JSON.parse(tr.valor); if (Array.isArray(a) && a.length && a[0].hasta_uf === undefined)
        await pool.query("UPDATE cobranza_config SET valor=? WHERE clave='tramos_uf'", [COB_DEFAULTS.tramos_uf]); }
      const [[gd]] = await pool.query("SELECT valor FROM cobranza_config WHERE clave='gastos_dias'");
      if (gd && gd.valor === '15') await pool.query("UPDATE cobranza_config SET valor='21' WHERE clave='gastos_dias'");
    } catch (_) {}
    console.log('✓ Cobranza: tabla cobranza_config verificada');
  } catch (err) { console.error('✗ Cobranza config migración:', err.message); }
})();

async function getCobranzaConfig() {
  const [rows] = await pool.query('SELECT clave, valor FROM cobranza_config');
  const obj = { ...COB_DEFAULTS };
  rows.forEach(r => { obj[r.clave] = r.valor; });
  return obj;
}
const rellenar = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : '{' + k + '}'));

// Gasto de cobranza: tramos MARGINALES sobre la deuda en UF (como tabla de tramos de impuesto).
// tramos = [{hasta_uf, pct}, ...]; el último con hasta_uf null/∞ es el resto de la deuda.
function calcularGastoCobranza(deudaPesos, ufValor, tramos) {
  const uf = Number(ufValor) || 0;
  const deudaUF = uf > 0 ? (Number(deudaPesos) || 0) / uf : 0;
  let prev = 0, gastoUF = 0;
  const detalle = [];
  for (const t of (tramos || [])) {
    const tope = (t.hasta_uf == null || t.hasta_uf === '') ? Infinity : Number(t.hasta_uf);
    const porcion = Math.max(0, Math.min(deudaUF, tope) - prev);
    const aporte = porcion * (Number(t.pct) || 0) / 100;
    if (porcion > 0) detalle.push({ desde_uf: prev, hasta_uf: tope === Infinity ? null : tope, porcion_uf: porcion, pct: Number(t.pct) || 0, gasto_uf: aporte });
    gastoUF += aporte;
    prev = tope;
    if (deudaUF <= tope) break;
  }
  return { deuda_uf: deudaUF, gasto_uf: gastoUF, gasto_pesos: Math.round(gastoUF * uf), detalle };
}

// Interés por mora: diario simple sobre la cuota original. Tasa diaria = TMC mensual / 30.
// Cada día usa la TMC vigente de SU mes (tabla tasas por rango de fechas) y el tramo del
// crédito (menor/mayor 200 UF). Se acumulan los días de atraso (venc+1 .. fecha_calculo).
//   tasas = filas {fecha_desde, fecha_hasta, tasa_mensual_menor, tasa_mensual_mayor}
function calcularInteresMora(cuota, fechaVenc, fechaCalc, tramo, tasas) {
  const c = Number(cuota) || 0;
  if (!c || !fechaVenc) return { dias: 0, interes: 0, detalle: [] };
  const ini = new Date(fechaVenc + 'T00:00:00Z'); ini.setUTCDate(ini.getUTCDate() + 1); // día 1 de mora
  const fin = new Date((fechaCalc || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  const campo = tramo === 'mayor' ? 'tasa_mensual_mayor' : 'tasa_mensual_menor';
  const tmcDe = (fechaStr) => {
    const row = (tasas || []).find(t => String(t.fecha_desde) <= fechaStr && fechaStr <= String(t.fecha_hasta));
    return row ? (parseFloat(row[campo]) || 0) : 0; // % mensual
  };
  let dias = 0, interes = 0; const porPeriodo = {};
  for (let d = new Date(ini); d <= fin; d.setUTCDate(d.getUTCDate() + 1)) {
    const fs = d.toISOString().slice(0, 10);
    const tmcMes = tmcDe(fs);
    const interesDia = c * (tmcMes / 100) / 30;
    interes += interesDia; dias++;
    const k = tmcMes.toFixed(4);
    porPeriodo[k] = porPeriodo[k] || { tmc_mensual: tmcMes, dias: 0, interes: 0 };
    porPeriodo[k].dias++; porPeriodo[k].interes += interesDia;
  }
  return { dias, interes: Math.round(interes), detalle: Object.values(porPeriodo).map(p => ({ ...p, interes: Math.round(p.interes) })) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data, error: null });
}
function fail(res, error, status = 400) {
  if (status === 500) {
    console.error('[cobranza]', error);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
  return res.status(status).json({ success: false, data: null, error });
}
const { hoyChile } = require('../../../../shared/utils/fecha-futura');   // MOTOR ÚNICO fecha/hora Chile

// ─── Query base de mora ────────────────────────────────────────────────────────
// ⚠ GEMELO SQL del MOTOR ÚNICO /js/mora-core.js (por rendimiento: filtra miles de
//   créditos en BD). Si cambias una regla de mora, cámbiala en mora-core Y aquí.
// pagos_credito solo almacena PAGOS REALIZADOS (no hay cuotas "pendientes").
// La mora se calcula comparando schedule teórico vs pagos registrados.
// Query PLANA (sin subqueries anidadas) compatible con TiDB.
// HAVING sobre alias es soportado por TiDB en modo MySQL.
//
// cuotas_vencidas: TIMESTAMPDIFF(MONTH) + ajuste día del mes:
//   primera_cuota=15-Abr, hoy=23-May → TDIFF=1 + día(23)≥día(15) → 2 vencidas ✓
//   primera_cuota=15-Abr, hoy=10-May → TDIFF=0 + día(10)<día(15)→ 1 vencida  ✓

// Expresión reutilizable para cuotas vencidas
const CV = `LEAST(c.plazo,
    TIMESTAMPDIFF(MONTH, c.fecha_primera_cuota, CURDATE()) +
    CASE WHEN DAY(CURDATE()) >= DAY(c.fecha_primera_cuota) THEN 1 ELSE 0 END
  )`;

// Saldo insoluto = capital adeudado (lo que falta amortizar). Sistema francés:
// B_p = P * ((1+i)^n - (1+i)^p) / ((1+i)^n - 1), con i = tasa mensual, n = plazo,
// p = cuotas PAGADAS (las efectivamente abonadas). i=0 → amortización lineal.
const SALDO = `ROUND(
    CASE
      WHEN COALESCE(c.tascli_real, 0) <= 0
        THEN COALESCE(c.monto_financiado, 0) * (c.plazo - LEAST(COALESCE(pp.cnt, 0), c.plazo)) / NULLIF(c.plazo, 0)
      ELSE COALESCE(c.monto_financiado, 0)
        * (POW(1 + c.tascli_real/100, c.plazo) - POW(1 + c.tascli_real/100, LEAST(COALESCE(pp.cnt, 0), c.plazo)))
        / NULLIF(POW(1 + c.tascli_real/100, c.plazo) - 1, 0)
    END
  )`;

// ── Créditos CON calendario congelado en cuotas_credito (migración INDEXA,
//    cartera cargada por Excel, etc.): la mora/saldo salen del calendario REAL
//    (incluye el historial PAGADA), NO de la fórmula francesa teórica. ──
const HAS_CAL = `EXISTS (SELECT 1 FROM cuotas_credito cx WHERE cx.id_credito = c.id)`;
//    venc. de la cuota impaga más antigua / cuotas vencidas impagas / su monto /
//    saldo insoluto = saldo de la última cuota PAGADA (cae a monto_financiado).
const CC_VENC_OLDEST = `(SELECT cc.fecha_vencimiento FROM cuotas_credito cc
    WHERE cc.id_credito = c.id AND cc.estado_cuota <> 'PAGADA' ORDER BY cc.numero_cuota LIMIT 1)`;
const CC_CUOTAS_MORA = `(SELECT COUNT(*) FROM cuotas_credito cc
    WHERE cc.id_credito = c.id AND cc.estado_cuota <> 'PAGADA' AND cc.fecha_vencimiento <= CURDATE())`;
const CC_MONTO_MORA = `(SELECT COALESCE(SUM(cc.valor_cuota),0) FROM cuotas_credito cc
    WHERE cc.id_credito = c.id AND cc.estado_cuota <> 'PAGADA' AND cc.fecha_vencimiento <= CURDATE())`;
const CC_SALDO = `COALESCE((SELECT cc.saldo_insoluto FROM cuotas_credito cc
    WHERE cc.id_credito = c.id AND cc.estado_cuota = 'PAGADA' ORDER BY cc.numero_cuota DESC LIMIT 1), c.monto_financiado, 0)`;

// Query base plana — whereExtra va dentro del WHERE, havingExtra dentro del HAVING
const MORA_SQL = (whereExtra = '', havingExtra = '') => `
  SELECT
    c.*,
    c.id                                      AS id_credito,
    COALESCE(cl_m.rut,             '')    AS rut_cliente,
    COALESCE(cl_m.nombre_completo, '') AS nombre_cliente,
    cl_m.email                                AS email_cliente,
    cl_m.sexo                                 AS sexo_cliente,
    COALESCE(pp.cnt, 0)                        AS cuotas_pagadas,
    CASE WHEN ${HAS_CAL} THEN ${CC_CUOTAS_MORA}
         ELSE GREATEST(0, ${CV} - COALESCE(pp.cnt, 0)) END AS cuotas_mora,
    CASE WHEN ${HAS_CAL} THEN ${CC_MONTO_MORA}
         ELSE GREATEST(0, ${CV} - COALESCE(pp.cnt, 0)) * COALESCE(c.cuota, 0) END AS monto_mora,
    CASE
      WHEN ${HAS_CAL} THEN GREATEST(0, DATEDIFF(CURDATE(), ${CC_VENC_OLDEST}))
      WHEN GREATEST(0, ${CV} - COALESCE(pp.cnt, 0)) > 0
        THEN DATEDIFF(CURDATE(),
               DATE_ADD(c.fecha_primera_cuota,
                 INTERVAL COALESCE(pp.cnt, 0) MONTH))
      ELSE 0
    END AS dias_mora,
    CASE WHEN ${HAS_CAL} THEN ${CC_SALDO} ELSE ${SALDO} END AS saldo_insoluto
  FROM creditos c
  LEFT JOIN clientes cl_m ON cl_m.id_cliente = c.id_cliente
  LEFT JOIN (
    SELECT id_credito, COUNT(DISTINCT numero_cuota) AS cnt
    FROM pagos_credito
    WHERE estado_pago = 'PAGADO'
    GROUP BY id_credito
  ) pp ON pp.id_credito = c.id
  WHERE c.estado IN ('VIGENTE','EN MORA','OTORGADO')
    AND (c.financiera = 'AUTOFACIL' OR c.financiera IS NULL)
    AND COALESCE(c.estado_cartera,'') <> 'PREPAGADO'
    AND c.plazo IS NOT NULL
    AND c.plazo > 0
    AND c.fecha_primera_cuota IS NOT NULL
    AND c.fecha_primera_cuota <= CURDATE()
    ${whereExtra}
  HAVING cuotas_mora > 0
    ${havingExtra}
`;

// Versión para un solo crédito (sin HAVING: devuelve aunque no tenga mora)
const MORA_CREDITO_SQL = `
  SELECT
    c.*,
    c.id                                      AS id_credito,
    COALESCE(pp.cnt, 0)                        AS cuotas_pagadas,
    CASE WHEN ${HAS_CAL} THEN ${CC_CUOTAS_MORA}
         ELSE GREATEST(0, ${CV} - COALESCE(pp.cnt, 0)) END AS cuotas_mora,
    CASE WHEN ${HAS_CAL} THEN ${CC_MONTO_MORA}
         ELSE GREATEST(0, ${CV} - COALESCE(pp.cnt, 0)) * COALESCE(c.cuota, 0) END AS monto_mora,
    CASE
      WHEN ${HAS_CAL} THEN GREATEST(0, DATEDIFF(CURDATE(), ${CC_VENC_OLDEST}))
      WHEN GREATEST(0, ${CV} - COALESCE(pp.cnt, 0)) > 0
        THEN DATEDIFF(CURDATE(),
               DATE_ADD(c.fecha_primera_cuota,
                 INTERVAL COALESCE(pp.cnt, 0) MONTH))
      ELSE 0
    END AS dias_mora,
    CASE WHEN ${HAS_CAL} THEN ${CC_SALDO} ELSE ${SALDO} END AS saldo_insoluto,
    COALESCE(cl.rut,             '') AS rut_cliente,
    COALESCE(cl.nombre_completo, '') AS nombre_cliente,
    cl.sexo           AS sexo_cliente,
    cl.telefono_movil AS telefono_movil,
    cl.email          AS email_cliente
  FROM creditos c
  LEFT JOIN (
    SELECT id_credito, COUNT(DISTINCT numero_cuota) AS cnt
    FROM pagos_credito
    WHERE id_credito = ? AND estado_pago = 'PAGADO'
    GROUP BY id_credito
  ) pp ON pp.id_credito = c.id
  LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
  WHERE c.id = ?
`;

// Formatea nombre en Title Case
function titleCase(str) {
  return String(str || '').toLowerCase().split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Determina tratamiento según sexo
function tratamiento(sexo) {
  const s = String(sexo || '').toUpperCase();
  if (s === 'FEMENINO' || s === 'F') return 'Estimada';
  if (s === 'MASCULINO' || s === 'M') return 'Estimado';
  return 'Estimado/a';
}

function tramoLabel(dias) {
  if (dias <= 15) return '1-15';
  if (dias <= 30) return '16-30';
  if (dias <= 60) return '31-60';
  if (dias <= 90) return '61-90';
  return '91+';
}

// ─── dashboard ────────────────────────────────────────────────────────────────
exports.dashboard = async (req, res) => {
  try {
    const [rows] = await pool.query(MORA_SQL());

    // Gestiones de esta semana por crédito
    const [gestSemana] = await pool.query(`
      SELECT id_credito, canal
      FROM cobranza_gestiones
      WHERE YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)
    `);

    const gMap = {};
    for (const g of gestSemana) {
      if (!gMap[g.id_credito]) gMap[g.id_credito] = { tels: 0, remotas: 0 };
      if (g.canal === 'TELEFONICA' || g.canal === 'PRESENCIAL') gMap[g.id_credito].tels++;
      else if (g.canal === 'REMOTA') gMap[g.id_credito].remotas++;
    }

    let prejudicial = { casos: 0, monto_mora: 0, requieren_accion: 0, alerta_15dias: 0 };
    let judicial    = { casos: 0, monto_mora: 0, requieren_accion: 0 };

    for (const c of rows) {
      const dias  = Number(c.dias_mora);
      const monto = Number(c.monto_mora);
      const g = gMap[c.id_credito] || { tels: 0, remotas: 0 };
      const puedeActuar = g.tels < 1 || g.remotas < 2;

      if (dias <= 90) {
        prejudicial.casos++;
        prejudicial.monto_mora += monto;
        if (puedeActuar) prejudicial.requieren_accion++;
        if (dias >= 1 && dias <= 15) prejudicial.alerta_15dias++;
      } else {
        judicial.casos++;
        judicial.monto_mora += monto;
        if (puedeActuar) judicial.requieren_accion++;
      }
    }

    const idUsuario = req.usuario.id_usuario;
    const misRows   = rows.filter(c => c.id_usuario === idUsuario);
    let misProximas = 0;
    for (const c of misRows) {
      const g = gMap[c.id_credito] || { tels: 0, remotas: 0 };
      if (g.tels < 1 || g.remotas < 2) misProximas++;
    }

    ok(res, {
      prejudicial: { ...prejudicial, monto_mora: Math.round(prejudicial.monto_mora) },
      judicial:    { ...judicial,    monto_mora: Math.round(judicial.monto_mora) },
      mis: {
        casos: misRows.length,
        monto_mora: Math.round(misRows.reduce((s, c) => s + Number(c.monto_mora), 0)),
        proximas_acciones: misProximas
      }
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── cartera ──────────────────────────────────────────────────────────────────
exports.cartera = async (req, res) => {
  try {
    const { tipo = 'prejudicial', tramo, q, page = 1, limit = 30 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    // Filtros adicionales a nivel del WHERE externo (sobre los campos calculados)
    const havingFilters = [];
    if (tipo === 'prejudicial') havingFilters.push('dias_mora BETWEEN 1 AND 90');
    else if (tipo === 'judicial') havingFilters.push('dias_mora > 90');

    if (tramo === '1-15')   havingFilters.push('dias_mora BETWEEN 1 AND 15');
    else if (tramo === '16-30') havingFilters.push('dias_mora BETWEEN 16 AND 30');
    else if (tramo === '31-60') havingFilters.push('dias_mora BETWEEN 31 AND 60');
    else if (tramo === '61-90') havingFilters.push('dias_mora BETWEEN 61 AND 90');
    else if (tramo === '91+')   havingFilters.push('dias_mora > 90');

    // Filtro por usuario (mis gestiones)
    let whereCreditos = '';
    if (tipo === 'mis') whereCreditos = `AND c.id_usuario = ${Number(req.usuario.id_usuario)}`;

    // Filtro por búsqueda de texto
    const qParams = [];
    let whereQ = '';
    if (q) {
      whereQ = 'AND (COALESCE(cl_m.nombre_completo, \'\') LIKE ? OR COALESCE(cl_m.rut, \'\') LIKE ? OR c.numero_credito LIKE ?)';
      qParams.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const havingExtra = havingFilters.length
      ? 'AND ' + havingFilters.join(' AND ')
      : '';

    // Query conteo — MORA_SQL ya lleva HAVING; pasamos havingExtra dentro de él
    const countSql = `SELECT COUNT(*) AS total FROM (${MORA_SQL(`${whereCreditos} ${whereQ}`, havingExtra)}) _cnt`;
    const [[{ total }]] = await pool.query(countSql, [...qParams]);

    // Query datos con última gestión
    const dataSql = `
      SELECT m.*,
        ug.tipo_gestion   AS ultima_tipo,
        ug.resultado      AS ultimo_resultado,
        ug.created_at     AS ultima_gestion_fecha,
        ug.nombre_usuario AS ultimo_gestor
      FROM (${MORA_SQL(`${whereCreditos} ${whereQ}`, havingExtra)}) m
      LEFT JOIN (
        SELECT g1.*
        FROM cobranza_gestiones g1
        INNER JOIN (
          SELECT id_credito, MAX(created_at) AS max_fecha
          FROM cobranza_gestiones GROUP BY id_credito
        ) g2 ON g1.id_credito = g2.id_credito AND g1.created_at = g2.max_fecha
      ) ug ON ug.id_credito = m.id_credito
      ORDER BY m.dias_mora DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await pool.query(dataSql, [...qParams, Number(limit), offset]);

    // Disponibilidad semanal
    const ids = rows.map(r => r.id_credito);
    let gestMap = {};
    if (ids.length) {
      const [gs] = await pool.query(`
        SELECT id_credito, canal, created_at
        FROM cobranza_gestiones
        WHERE id_credito IN (?)
          AND YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)
      `, [ids]);
      for (const g of gs) {
        if (!gestMap[g.id_credito]) gestMap[g.id_credito] = { tels: 0, remotas: [], ultimaRemota: null };
        if (g.canal === 'TELEFONICA' || g.canal === 'PRESENCIAL') {
          gestMap[g.id_credito].tels++;
        } else if (g.canal === 'REMOTA') {
          gestMap[g.id_credito].remotas.push(g.created_at);
          if (!gestMap[g.id_credito].ultimaRemota || g.created_at > gestMap[g.id_credito].ultimaRemota) {
            gestMap[g.id_credito].ultimaRemota = g.created_at;
          }
        }
      }
    }

    const enriched = rows.map(r => {
      const g = gestMap[r.id_credito] || { tels: 0, remotas: [] };
      return {
        ...r,
        monto_mora: Math.round(Number(r.monto_mora)),
        puede_llamar: g.tels < 1,
        puede_remota: g.remotas.length < 2,
        llamadas_semana: g.tels,
        remotas_semana: g.remotas.length
      };
    });

    ok(res, { rows: enriched, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── disponibilidad ───────────────────────────────────────────────────────────
exports.disponibilidad = async (req, res) => {
  try {
    const { id_credito } = req.params;

    const [gests] = await pool.query(`
      SELECT canal, created_at
      FROM cobranza_gestiones
      WHERE id_credito = ?
        AND YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)
      ORDER BY created_at ASC
    `, [id_credito]);

    const telGests = gests.filter(g => g.canal === 'TELEFONICA' || g.canal === 'PRESENCIAL');
    const remGests = gests.filter(g => g.canal === 'REMOTA');

    const puede_llamar = telGests.length < 1;

    const hoy = new Date(hoyChile());
    const diaSemana = hoy.getDay();
    const diasHastaLunes = diaSemana === 0 ? 1 : 8 - diaSemana;
    const proximoLunes = new Date(hoy);
    proximoLunes.setDate(hoy.getDate() + diasHastaLunes);

    const proxima_llamada_disponible = puede_llamar
      ? hoyChile()
      : proximoLunes.toISOString().slice(0, 10);

    let proxima_remota_disponible = hoyChile();
    let dias_para_proxima_remota = 0;

    if (remGests.length >= 2) {
      proxima_remota_disponible = proximoLunes.toISOString().slice(0, 10);
      dias_para_proxima_remota = diasHastaLunes;
    } else if (remGests.length === 1) {
      const ultimaRemota = new Date(remGests[0].created_at);
      const proxRemota = new Date(ultimaRemota);
      proxRemota.setDate(ultimaRemota.getDate() + 2);
      const proxRemotaStr = proxRemota.toISOString().slice(0, 10);
      if (proxRemotaStr > hoyChile()) {
        proxima_remota_disponible = proxRemotaStr;
        dias_para_proxima_remota = Math.ceil((proxRemota - hoy) / 86400000);
      }
    }

    ok(res, {
      puede_llamar,
      puede_remota: remGests.length < 2 && dias_para_proxima_remota === 0,
      remotas_esta_semana: remGests.length,
      llamadas_esta_semana: telGests.length,
      dias_para_proxima_remota,
      proxima_llamada_disponible,
      proxima_remota_disponible
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── mensajes ─────────────────────────────────────────────────────────────────
exports.mensajes = async (req, res) => {
  try {
    const { id_credito } = req.params;

    const [[credito]] = await pool.query(MORA_CREDITO_SQL, [id_credito, id_credito]);
    if (!credito) return fail(res, 'Crédito no encontrado', 404);

    const nombre   = titleCase(credito.nombre_cliente || 'Cliente');
    const trato    = tratamiento(credito.sexo_cliente);
    const numero   = credito.numero_credito || credito.id_credito;
    const cuotas   = Number(credito.cuotas_mora) || 0;
    const monto    = Math.round(Number(credito.monto_mora || 0)).toLocaleString('es-CL');
    const dias     = Number(credito.dias_mora) || 0;
    const telefono = credito.telefono_movil || null;
    const email    = credito.email_cliente  || null;

    // Plantillas configurables (mantenedor Parámetros Cobranza)
    const cfg = await getCobranzaConfig();
    const vars = { trato, nombre, numero, dias, cuotas, monto, datos: cfg.datos_transferencia };

    const whatsapp    = rellenar(cfg.texto_whatsapp, vars);
    const sms         = rellenar(cfg.texto_sms, vars);
    const emailAsunto = rellenar(cfg.texto_email_asunto, vars);
    const emailCuerpo = rellenar(cfg.texto_email, vars);

    ok(res, { whatsapp, sms, email: { asunto: emailAsunto, cuerpo: emailCuerpo }, telefono, emailCliente: email });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── guardarContacto ──────────────────────────────────────────────────────────
// Actualiza el teléfono móvil y/o el email registrados del cliente del crédito,
// desde el panel de cobranza (para gestionar WhatsApp/SMS/Email).
exports.guardarContacto = async (req, res) => {
  try {
    const { id_credito } = req.params;
    let telefono = (req.body.telefono || '').trim() || null;
    let email    = (req.body.email || '').trim() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 'Email inválido', 400);
    const [[cr]] = await pool.query('SELECT id_cliente FROM creditos WHERE id = ? LIMIT 1', [id_credito]);
    if (!cr || !cr.id_cliente) return fail(res, 'Crédito o cliente no encontrado', 404);
    await pool.query('UPDATE clientes SET telefono_movil = ?, email = ? WHERE id_cliente = ?', [telefono, email, cr.id_cliente]);
    ok(res, { telefono, email });
  } catch (err) { fail(res, err.message, 500); }
};

// ─── crearGestion ─────────────────────────────────────────────────────────────
exports.crearGestion = async (req, res) => {
  try {
    const { id_credito, tipo_gestion, canal, mensaje, resultado, fecha_promesa, monto_promesa } = req.body;

    if (!id_credito)   return fail(res, 'id_credito es requerido');
    if (!tipo_gestion) return fail(res, 'tipo_gestion es requerido');
    if (!canal)        return fail(res, 'canal es requerido');

    // Verificar límites legales ANTES de registrar
    const [gestsSemana] = await pool.query(`
      SELECT canal, created_at
      FROM cobranza_gestiones
      WHERE id_credito = ?
        AND YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)
      ORDER BY created_at ASC
    `, [id_credito]);

    const telGests = gestsSemana.filter(g => g.canal === 'TELEFONICA' || g.canal === 'PRESENCIAL');
    const remGests = gestsSemana.filter(g => g.canal === 'REMOTA');

    if ((canal === 'TELEFONICA' || canal === 'PRESENCIAL') && telGests.length >= 1) {
      return fail(res, 'Límite semanal alcanzado: solo se permite 1 gestión telefónica o presencial por semana (Ley del Consumidor)');
    }
    if (canal === 'REMOTA') {
      if (remGests.length >= 2) {
        return fail(res, 'Límite semanal alcanzado: solo se permiten 2 gestiones remotas por semana (Ley del Consumidor)');
      }
      if (remGests.length === 1) {
        const ultimaRemota = new Date(remGests[0].created_at);
        const hoy = new Date(hoyChile());
        const diffDias = Math.floor((hoy - ultimaRemota) / 86400000);
        if (diffDias < 2) {
          const proxFecha = new Date(ultimaRemota.getTime() + 2 * 86400000).toISOString().slice(0, 10);
          return fail(res, `Debe esperar al menos 2 días entre gestiones remotas. Próxima disponible: ${proxFecha}`);
        }
      }
    }

    // Obtener datos actuales del crédito y su mora
    const [[credito]] = await pool.query(MORA_CREDITO_SQL, [id_credito, id_credito]);
    if (!credito) return fail(res, 'Crédito no encontrado', 404);

    const u = req.usuario;
    const nombre_usuario = [u.nombre, u.apellido].filter(Boolean).join(' ');

    const [r] = await pool.query(`
      INSERT INTO cobranza_gestiones
        (id_credito, numero_credito, rut_cliente, nombre_cliente,
         tipo_gestion, canal, dias_mora, cuotas_mora, monto_mora,
         mensaje, resultado, fecha_promesa, monto_promesa,
         confirmado, id_usuario, nombre_usuario)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
    `, [
      id_credito,
      credito.numero_credito,
      credito.rut_cliente,
      credito.nombre_cliente,
      tipo_gestion, canal,
      Number(credito.dias_mora) || 0,
      Number(credito.cuotas_mora) || 0,
      Math.round(Number(credito.monto_mora || 0)),
      mensaje || null,
      resultado || 'SIN_RESULTADO',
      fecha_promesa || null,
      monto_promesa || null,
      u.id_usuario, nombre_usuario
    ]);

    const [[gestion]] = await pool.query(
      'SELECT * FROM cobranza_gestiones WHERE id_gestion = ?', [r.insertId]
    );
    ok(res, gestion, 201);
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── confirmarGestion ─────────────────────────────────────────────────────────
exports.confirmarGestion = async (req, res) => {
  try {
    const { id } = req.params;
    const [[g]] = await pool.query('SELECT * FROM cobranza_gestiones WHERE id_gestion = ?', [id]);
    if (!g) return fail(res, 'Gestión no encontrada', 404);
    await pool.query('UPDATE cobranza_gestiones SET confirmado = 1 WHERE id_gestion = ?', [id]);
    ok(res, { id_gestion: Number(id), confirmado: 1 });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── bitacora ─────────────────────────────────────────────────────────────────
exports.bitacora = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM cobranza_gestiones WHERE id_credito = ? ORDER BY created_at DESC',
      [req.params.id_credito]
    );
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── misGestiones ─────────────────────────────────────────────────────────────
exports.misGestiones = async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const offset   = (Number(page) - 1) * Number(limit);
    const idUsuario = req.usuario.id_usuario;

    // Créditos asignados al usuario en mora
    const [misCreditos] = await pool.query(
      `${MORA_SQL(`AND c.id_usuario = ${Number(idUsuario)}`)} ORDER BY dias_mora DESC`
    );

    // Gestiones recientes (30 días)
    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM cobranza_gestiones WHERE id_usuario = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)',
      [idUsuario]
    );
    const [gestiones] = await pool.query(`
      SELECT * FROM cobranza_gestiones
      WHERE id_usuario = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `, [idUsuario, Number(limit), offset]);

    // Promesas pendientes y vencidas
    const [promesas] = await pool.query(`
      SELECT g.*, c.numero_credito,
             COALESCE(cl.nombre_completo,'') AS nombre_cliente,
             COALESCE(cl.rut,'') AS rut_cliente
      FROM cobranza_gestiones g
      LEFT JOIN creditos c ON c.id = g.id_credito
      LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
      WHERE g.id_usuario = ? AND g.resultado = 'PROMESA_PAGO'
        AND g.fecha_promesa IS NOT NULL AND g.fecha_promesa >= CURDATE()
      ORDER BY g.fecha_promesa ASC
    `, [idUsuario]);

    const [promesasVencidas] = await pool.query(`
      SELECT g.*, c.numero_credito,
             COALESCE(cl.nombre_completo,'') AS nombre_cliente
      FROM cobranza_gestiones g
      LEFT JOIN creditos c ON c.id = g.id_credito
      LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
      WHERE g.id_usuario = ? AND g.resultado = 'PROMESA_PAGO'
        AND g.fecha_promesa IS NOT NULL AND g.fecha_promesa < CURDATE()
      ORDER BY g.fecha_promesa DESC LIMIT 20
    `, [idUsuario]);

    ok(res, {
      mis_creditos: misCreditos.map(c => ({ ...c, monto_mora: Math.round(Number(c.monto_mora)) })),
      gestiones,
      promesas,
      promesas_vencidas: promesasVencidas,
      total_gestiones: total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit))
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── diagnostico ──────────────────────────────────────────────────────────────
exports.diagnostico = async (req, res) => {
  try {
    // 1. Todos los créditos VIGENTE
    const [[{ total_vigente }]] = await pool.query(
      `SELECT COUNT(*) AS total_vigente FROM creditos WHERE estado = 'VIGENTE'`
    );

    // 2. VIGENTE solo AutoFácil con fecha_primera_cuota
    const [[{ autofacil_con_fecha }]] = await pool.query(
      `SELECT COUNT(*) AS autofacil_con_fecha
       FROM creditos
       WHERE estado = 'VIGENTE'
         AND (financiera = 'AUTOFACIL' OR financiera IS NULL)
         AND fecha_primera_cuota IS NOT NULL`
    );

    // 3. VIGENTE AutoFácil con fecha pasada y plazo
    const [[{ con_fecha_pasada }]] = await pool.query(
      `SELECT COUNT(*) AS con_fecha_pasada
       FROM creditos
       WHERE estado = 'VIGENTE'
         AND (financiera = 'AUTOFACIL' OR financiera IS NULL)
         AND plazo IS NOT NULL AND plazo > 0
         AND fecha_primera_cuota IS NOT NULL
         AND fecha_primera_cuota <= CURDATE()`
    );

    // 4. Con mora real calculada
    const [conMora] = await pool.query(MORA_SQL());

    // 5. Muestra por financiera
    const [porFinanciera] = await pool.query(
      `SELECT COALESCE(financiera,'(NULL)') AS financiera, estado, COUNT(*) AS cnt
       FROM creditos
       WHERE estado IN ('VIGENTE','EN MORA')
       GROUP BY financiera, estado
       ORDER BY cnt DESC`
    );

    // 6. Sample de créditos AutoFácil VIGENTE con sus campos de mora
    const [sample] = await pool.query(
      `SELECT id_credito, numero_credito, nombre_cliente, financiera,
              fecha_primera_cuota, plazo, cuota, estado
       FROM creditos
       WHERE estado = 'VIGENTE'
         AND (financiera = 'AUTOFACIL' OR financiera IS NULL)
       LIMIT 10`
    );

    ok(res, {
      total_vigente,
      autofacil_con_fecha,
      con_fecha_pasada,
      creditos_en_mora: conMora.length,
      por_financiera: porFinanciera,
      sample_autofacil: sample,
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── provisiones ──────────────────────────────────────────────────────────────
exports.provisiones = async (req, res) => {
  try {
    // Deuda total vigente (cartera AutoFácil)
    const [[{ deuda_total }]] = await pool.query(`
      SELECT COALESCE(SUM(monto_financiado), 0) AS deuda_total
      FROM creditos
      WHERE estado IN ('VIGENTE','EN MORA','OTORGADO')
        AND (financiera = 'AUTOFACIL' OR financiera IS NULL)
    `);

    // Mora por crédito usando el cálculo correcto
    const [moraRows] = await pool.query(MORA_SQL());

    const tramos = [
      { tramo: '1-15',  min: 1,  max: 15,  pct_provision: 1  },
      { tramo: '16-30', min: 16, max: 30,  pct_provision: 5  },
      { tramo: '31-60', min: 31, max: 60,  pct_provision: 20 },
      { tramo: '61-90', min: 61, max: 90,  pct_provision: 40 },
      { tramo: '91+',   min: 91, max: Infinity, pct_provision: 80 }
    ];

    // La provisión se calcula sobre el CAPITAL ADEUDADO (saldo insoluto), no sobre
    // las cuotas morosas. Se informan ambos (monto en mora y capital) por tramo.
    let deuda_mora_total = 0, capital_total = 0;
    const tramosResult = tramos.map(t => {
      const filtered = moraRows.filter(r => {
        const d = Number(r.dias_mora);
        return d >= t.min && d <= t.max;
      });
      const monto   = filtered.reduce((s, r) => s + Number(r.monto_mora), 0);
      const capital = filtered.reduce((s, r) => s + Number(r.saldo_insoluto || 0), 0);
      deuda_mora_total += monto;
      capital_total    += capital;
      return {
        tramo: t.tramo,
        casos: filtered.length,
        monto: Math.round(monto),
        saldo_insoluto: Math.round(capital),
        pct_provision: t.pct_provision,
        provision_estimada: Math.round(capital * t.pct_provision / 100)
      };
    });

    ok(res, {
      deuda_total: Math.round(Number(deuda_total)),
      deuda_mora: Math.round(deuda_mora_total),
      capital_insoluto: Math.round(capital_total),
      provision_total: tramosResult.reduce((s, t) => s + t.provision_estimada, 0),
      tramos: tramosResult
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── Parámetros de Cobranza: get/set (mantenedor) ──────────────────────────────
exports.getParametros = async (req, res) => {
  try {
    const cfg = await getCobranzaConfig();
    // tramos_uf se entrega ya parseado para el front
    let tramos = [];
    try { tramos = JSON.parse(cfg.tramos_uf); } catch (_) {}
    ok(res, { ...cfg, tramos_uf: tramos });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

exports.setParametros = async (req, res) => {
  try {
    const body = req.body || {};
    const permitidas = ['datos_transferencia', 'texto_whatsapp', 'texto_sms', 'texto_email_asunto', 'texto_email', 'gastos_dias', 'tramos_uf'];
    for (const clave of permitidas) {
      if (body[clave] === undefined) continue;
      let valor = body[clave];
      if (clave === 'tramos_uf' && typeof valor !== 'string') valor = JSON.stringify(valor);
      await pool.query(
        `INSERT INTO cobranza_config (clave, valor) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE valor = VALUES(valor)`, [clave, String(valor)]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'cobranza', entidad: 'cobranza_parametros', entidad_id: 'parametros', detalle: 'Actualizó parámetros de cobranza', meta: Object.keys(req.body || {}) });
    ok(res, { mensaje: 'Parámetros de cobranza actualizados' });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// UF vigente a una fecha dada (motor único shared/uf.js); con fallback a la más reciente
// (propio de cobranza: para cálculos del día sin fecha exacta). 0 si no hay UF cargada.
async function getUFporFecha(fecha) {
  const v = await getUF(fecha);
  if (v != null) return v;
  const [[u2]] = await pool.query('SELECT valor FROM uf ORDER BY fecha DESC LIMIT 1');
  return u2 ? parseFloat(u2.valor) : 0;
}
// Suma N días a una fecha YYYY-MM-DD
function addDias(fechaStr, n) {
  const d = new Date(fechaStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Reutilizable por otros módulos (ej. certificados: liquidación de prepago).
exports._calc = { calcularGastoCobranza, calcularInteresMora, getCobranzaConfig, getUFporFecha, addDias };
// Dependencias para el motor de automatización de mora (mora-motor.controller).
exports._motor = { MORA_SQL, getCobranzaConfig, rellenar, tratamiento, titleCase };

// ─── Calcular gasto de cobranza para un monto (Caja / consultas) ───────────────
// body: { monto, uf?, fecha?, fecha_vencimiento? }
//   - uf explícita tiene prioridad.
//   - si se pasa fecha_vencimiento, la UF se fija en el día 21 (venc + (gastos_dias-1)).
//   - si se pasa fecha, se usa la UF vigente a esa fecha.
exports.calcularGasto = async (req, res) => {
  try {
    const monto = Number(req.body?.monto) || 0;
    const cfg = await getCobranzaConfig();
    const gastosDias = Number(cfg.gastos_dias) || 21;
    let tramos = []; try { tramos = JSON.parse(cfg.tramos_uf); } catch (_) {}

    let uf = Number(req.body?.uf) || 0;
    let fecha_uf = null;
    if (!uf) {
      // UF fija del día en que se cumplen los días de cobro (venc + gastos_dias), si hay vencimiento
      if (req.body?.fecha_vencimiento) fecha_uf = addDias(req.body.fecha_vencimiento, gastosDias);
      else if (req.body?.fecha) fecha_uf = req.body.fecha;
      uf = await getUFporFecha(fecha_uf);
    }
    const r = calcularGastoCobranza(monto, uf, tramos);
    ok(res, { monto, uf, fecha_uf, gastos_dias: gastosDias, ...r });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── Calcular cobranza completa: gasto + interés por mora + total ──────────────
// body: { monto_cuota, fecha_vencimiento, fecha_calculo?, tramo? ('menor'|'mayor') }
exports.calcularCobranza = async (req, res) => {
  try {
    const cuota = Number(req.body?.monto_cuota) || 0;
    const fechaVenc = req.body?.fecha_vencimiento;
    if (!cuota || !fechaVenc)
      return fail(res, 'monto_cuota y fecha_vencimiento son requeridos');
    const fechaCalc = req.body?.fecha_calculo || hoyChile();
    const tramo = req.body?.tramo === 'mayor' ? 'mayor' : 'menor';

    const cfg = await getCobranzaConfig();
    const gastosDias = Number(cfg.gastos_dias) || 21;
    let tramos = []; try { tramos = JSON.parse(cfg.tramos_uf); } catch (_) {}

    // Días de mora (venc+1 .. fecha de cálculo)
    const diasMora = Math.max(0, Math.floor((new Date(fechaCalc + 'T00:00:00Z') - new Date(fechaVenc + 'T00:00:00Z')) / 86400000));

    // Gasto de cobranza: solo desde el día (gastos_dias); UF fija de ese día
    let gasto = { gasto_pesos: 0, gasto_uf: 0, deuda_uf: 0, detalle: [], aplica: false, uf: 0, fecha_uf: null };
    if (diasMora >= gastosDias) {
      const fechaUF = addDias(fechaVenc, gastosDias);
      const uf = await getUFporFecha(fechaUF);
      gasto = { ...calcularGastoCobranza(cuota, uf, tramos), aplica: true, uf, fecha_uf: fechaUF };
    }

    // Interés por mora: por día con la TMC mensual vigente del tramo del crédito
    const [tasas] = await pool.query("SELECT DATE_FORMAT(fecha_desde,'%Y-%m-%d') fecha_desde, DATE_FORMAT(fecha_hasta,'%Y-%m-%d') fecha_hasta, tasa_mensual_menor, tasa_mensual_mayor FROM tasas");
    const interes = calcularInteresMora(cuota, fechaVenc, fechaCalc, tramo, tasas);

    const total = cuota + (gasto.gasto_pesos || 0) + (interes.interes || 0);
    ok(res, {
      monto_cuota: cuota, fecha_vencimiento: fechaVenc, fecha_calculo: fechaCalc, tramo,
      dias_mora: diasMora, gastos_dias: gastosDias,
      gasto, interes, total,
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
};

// ─── Calcular cobranza por LOTE (todas las cuotas de un crédito) — para Caja ────
// body: { id_credito, cuotas:[{numero, monto, fecha}], fecha_calculo? }
// El tramo (menor/mayor 200 UF) se deriva del crédito original (saldo precio vs umbral×UF otorgamiento).
exports.calcularCobranzaLote = async (req, res) => {
  try {
    const { id_credito, cuotas } = req.body || {};
    if (!Array.isArray(cuotas) || !cuotas.length)
      return fail(res, 'cuotas requeridas');
    const fechaCalc = req.body?.fecha_calculo || hoyChile();

    const cfg = await getCobranzaConfig();
    const gastosDias = Number(cfg.gastos_dias) || 21;
    let tramos = []; try { tramos = JSON.parse(cfg.tramos_uf); } catch (_) {}
    const [tasas] = await pool.query("SELECT DATE_FORMAT(fecha_desde,'%Y-%m-%d') fecha_desde, DATE_FORMAT(fecha_hasta,'%Y-%m-%d') fecha_hasta, tasa_mensual_menor, tasa_mensual_mayor FROM tasas");

    // Tramo del crédito: saldo precio (o monto financiado) vs umbral × UF de la fecha de otorgamiento
    let tramo = 'menor';
    if (id_credito) {
      const [[cr]] = await pool.query(
        'SELECT saldo_precio, monto_financiado, DATE_FORMAT(fecha_otorgado,"%Y-%m-%d") AS fecha_otorgado FROM creditos WHERE id=?', [id_credito]);
      if (cr) {
        const [[um]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='umbral_uf_tramo'");
        const umbral = um ? parseFloat(um.valor) || 200 : 200;
        const ufOt = await getUFporFecha(cr.fecha_otorgado);
        const base = Number(cr.saldo_precio) || Number(cr.monto_financiado) || 0;
        if (ufOt > 0 && base > umbral * ufOt) tramo = 'mayor';
      }
    }

    // Cache de UF por fecha-día-21 para no repetir queries
    const ufCache = new Map();
    const ufDe = async (f) => { if (ufCache.has(f)) return ufCache.get(f); const v = await getUFporFecha(f); ufCache.set(f, v); return v; };

    const out = [];
    for (const q of cuotas) {
      const cuota = Number(q.monto) || 0;
      const fechaVenc = q.fecha;
      const diasMora = Math.max(0, Math.floor((new Date(fechaCalc + 'T00:00:00Z') - new Date(fechaVenc + 'T00:00:00Z')) / 86400000));
      let gasto = { gasto_pesos: 0, aplica: false };
      if (diasMora >= gastosDias) {
        const fechaUF = addDias(fechaVenc, gastosDias);
        const uf = await ufDe(fechaUF);
        gasto = { ...calcularGastoCobranza(cuota, uf, tramos), aplica: true, uf, fecha_uf: fechaUF };
      }
      const interes = calcularInteresMora(cuota, fechaVenc, fechaCalc, tramo, tasas);
      out.push({ numero: q.numero, dias_mora: diasMora, gasto, interes,
        total: cuota + (gasto.gasto_pesos || 0) + (interes.interes || 0) });
    }
    ok(res, { tramo, gastos_dias: gastosDias, fecha_calculo: fechaCalc, cuotas: out });
  } catch (err) {
    fail(res, err.message, 500);
  }
};
