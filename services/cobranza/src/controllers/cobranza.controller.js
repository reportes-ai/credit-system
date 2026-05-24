'use strict';

const pool = require('../../../../shared/config/database');

// ─── Migración automática ─────────────────────────────────────────────────────
(async () => {
  try {
    const conn = await pool.getConnection();
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
    conn.release();
    console.log('✓ Cobranza: tabla cobranza_gestiones verificada');
  } catch (err) {
    console.error('✗ Cobranza migración:', err.message);
  }
})();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data, error: null });
}
function fail(res, error, status = 400) {
  return res.status(status).json({ success: false, data: null, error });
}
function hoyChile() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
}

// ─── Query base de mora ────────────────────────────────────────────────────────
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

// Query base plana — whereExtra va dentro del WHERE, havingExtra dentro del HAVING
const MORA_SQL = (whereExtra = '', havingExtra = '') => `
  SELECT
    c.*,
    COALESCE(pp.cnt, 0)                        AS cuotas_pagadas,
    GREATEST(0, ${CV} - COALESCE(pp.cnt, 0))   AS cuotas_mora,
    GREATEST(0, ${CV} - COALESCE(pp.cnt, 0)) * COALESCE(c.cuota, 0) AS monto_mora,
    CASE
      WHEN GREATEST(0, ${CV} - COALESCE(pp.cnt, 0)) > 0
        THEN DATEDIFF(CURDATE(),
               DATE_ADD(c.fecha_primera_cuota,
                 INTERVAL COALESCE(pp.cnt, 0) MONTH))
      ELSE 0
    END AS dias_mora
  FROM creditos c
  LEFT JOIN (
    SELECT id_credito, COUNT(DISTINCT numero_cuota) AS cnt
    FROM pagos_credito
    GROUP BY id_credito
  ) pp ON pp.id_credito = c.id_credito
  WHERE c.estado = 'VIGENTE'
    AND (c.empresa IS NULL OR c.empresa != 'BROKERAGE')
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
    COALESCE(pp.cnt, 0)                        AS cuotas_pagadas,
    GREATEST(0, ${CV} - COALESCE(pp.cnt, 0))   AS cuotas_mora,
    GREATEST(0, ${CV} - COALESCE(pp.cnt, 0)) * COALESCE(c.cuota, 0) AS monto_mora,
    CASE
      WHEN GREATEST(0, ${CV} - COALESCE(pp.cnt, 0)) > 0
        THEN DATEDIFF(CURDATE(),
               DATE_ADD(c.fecha_primera_cuota,
                 INTERVAL COALESCE(pp.cnt, 0) MONTH))
      ELSE 0
    END AS dias_mora,
    cl.sexo           AS sexo_cliente,
    cl.telefono_movil AS telefono_movil
  FROM creditos c
  LEFT JOIN (
    SELECT id_credito, COUNT(DISTINCT numero_cuota) AS cnt
    FROM pagos_credito
    WHERE id_credito = ?
    GROUP BY id_credito
  ) pp ON pp.id_credito = c.id_credito
  LEFT JOIN clientes cl ON cl.rut = c.rut_cliente
  WHERE c.id_credito = ?
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
      whereQ = 'AND (c.nombre_cliente LIKE ? OR c.rut_cliente LIKE ? OR c.numero_credito LIKE ?)';
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

    const datosTransferencia = `Titular: AUTOFACIL SpA\nRUT: 76.545.638-K\nBanco: Banco de Chile\nCuenta Corriente: 8001829208\nMail: cobranza@autofacilchile.cl`;

    const whatsapp = `${trato} ${nombre}, le informamos que su crédito N° ${numero} se encuentra en mora hace ${dias} días, con ${cuotas} cuota${cuotas !== 1 ? 's' : ''} impaga${cuotas !== 1 ? 's' : ''} por un total de $${monto} al día de hoy.\n\n${datosTransferencia}`;

    const sms = `${trato} ${nombre}, su crédito N° ${numero} tiene ${cuotas} cuota${cuotas !== 1 ? 's' : ''} impaga${cuotas !== 1 ? 's' : ''} por $${monto} (${dias} días mora).\n${datosTransferencia}`;

    const emailAsunto = `[AutoFácil] Aviso de mora — Crédito N° ${numero}`;
    const emailCuerpo = `${trato} ${nombre},

Le informamos que su crédito N° ${numero} se encuentra en mora hace ${dias} días, con ${cuotas} cuota${cuotas !== 1 ? 's' : ''} impaga${cuotas !== 1 ? 's' : ''} por un total de $${monto} al día de hoy.

Para regularizar su situación puede realizar una transferencia con los siguientes datos:

${datosTransferencia}

Atentamente,
Equipo de Cobranza AutoFácil`;

    ok(res, { whatsapp, sms, email: { asunto: emailAsunto, cuerpo: emailCuerpo }, telefono });
  } catch (err) {
    fail(res, err.message, 500);
  }
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
      SELECT g.*, c.numero_credito, c.nombre_cliente, c.rut_cliente
      FROM cobranza_gestiones g
      LEFT JOIN creditos c ON c.id_credito = g.id_credito
      WHERE g.id_usuario = ? AND g.resultado = 'PROMESA_PAGO'
        AND g.fecha_promesa IS NOT NULL AND g.fecha_promesa >= CURDATE()
      ORDER BY g.fecha_promesa ASC
    `, [idUsuario]);

    const [promesasVencidas] = await pool.query(`
      SELECT g.*, c.numero_credito, c.nombre_cliente
      FROM cobranza_gestiones g
      LEFT JOIN creditos c ON c.id_credito = g.id_credito
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

// ─── provisiones ──────────────────────────────────────────────────────────────
exports.provisiones = async (req, res) => {
  try {
    // Deuda total vigente (cartera AutoFácil)
    const [[{ deuda_total }]] = await pool.query(`
      SELECT COALESCE(SUM(monto_financiado), 0) AS deuda_total
      FROM creditos
      WHERE estado = 'VIGENTE'
        AND (empresa IS NULL OR empresa != 'BROKERAGE')
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

    let deuda_mora_total = 0;
    const tramosResult = tramos.map(t => {
      const filtered = moraRows.filter(r => {
        const d = Number(r.dias_mora);
        return d >= t.min && d <= t.max;
      });
      const monto = filtered.reduce((s, r) => s + Number(r.monto_mora), 0);
      deuda_mora_total += monto;
      return {
        tramo: t.tramo,
        casos: filtered.length,
        monto: Math.round(monto),
        pct_provision: t.pct_provision,
        provision_estimada: Math.round(monto * t.pct_provision / 100)
      };
    });

    ok(res, {
      deuda_total: Math.round(Number(deuda_total)),
      deuda_mora: Math.round(deuda_mora_total),
      provision_total: tramosResult.reduce((s, t) => s + t.provision_estimada, 0),
      tramos: tramosResult
    });
  } catch (err) {
    fail(res, err.message, 500);
  }
};
