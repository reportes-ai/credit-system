const pool  = require('../../../../shared/config/database');
const audit = require('../../../../shared/auditoria');
require('../migrations/fix-financieras');   // migración one-time de datos (financiera/estado/automotora) — guard propio
const { isMesCerrado, getMesDeOp } = require('../../../../shared/utils/mes-cerrado');
const { esFechaFutura, hoyChileDMY } = require('../../../../shared/utils/fecha-futura');
const { marcarForzadosCalculo, recalcularPorOps } = require('../utils/recalcular-mes');
require('../utils/desistir-aprobados');   // regla: APROBADO > N días sin cursar → DESISTIDO (paramétrico)
const AF_MORA = require('../../../../api-gateway/public/js/mora-core');   // MOTOR ÚNICO de mora
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

/* Pool de quienes analizan/aprueban un crédito: Analistas de Crédito + Supervisor
   de Crédito (+ Administrador), activos. Excluye al actor para no auto-notificar. */
async function idsAnalistasCredito(excluirId) {
  const [rows] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u
       JOIN perfiles p ON p.id_perfil = u.id_perfil
     WHERE u.estado = 'activo'
       AND p.nombre IN ('Analista de Crédito','Supervisor de Crédito','Administrador')
       AND u.id_usuario <> ?`,
    [excluirId || 0]
  );
  return rows.map(r => r.id_usuario);
}

// ── Migración: agregar campos de gestión a creditos ──────────────
require('../../../../shared/migrate').enFila('creditos', async () => {
  try {
    const addCol = async (sql) => pool.query(sql).catch(e => { if (e.errno !== 1060) throw e; });
    // Campos de vehículo
    await addCol(`ALTER TABLE creditos ADD COLUMN tipo_vehiculo      VARCHAR(100) NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN marca              VARCHAR(100) NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN modelo             VARCHAR(100) NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN anio               INT          NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN patente            VARCHAR(20)  NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN color              VARCHAR(50)  NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN motor              VARCHAR(100) NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN chasis             VARCHAR(100) NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN transmision        VARCHAR(50)  NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN combustible        VARCHAR(50)  NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN tasacion           BIGINT       NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN permiso_circulacion BIGINT      NULL`);
    // Campos de gestión
    await addCol(`ALTER TABLE creditos ADD COLUMN numero_credito     VARCHAR(20)  NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN estado             VARCHAR(30)  NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN cuota              BIGINT       NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN tipo_ubicacion     VARCHAR(50)  NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN nombre_parque_mgmt VARCHAR(100) NULL`);
    // Ampliar tipo_ubicacion si quedó como VARCHAR(10) — MODIFY una vez (migrarAuto)
    require('../../../../shared/migrate').migrarAuto('creditos_tipo_ubicacion_v50', async () => {
      await pool.query(`ALTER TABLE creditos MODIFY COLUMN tipo_ubicacion VARCHAR(50) NULL`).catch(() => {});
    });
    await addCol(`ALTER TABLE creditos ADD COLUMN id_dealer          INT          NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN id_cliente         INT          NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN id_usuario         INT          NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN id_cotizacion      INT          NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN datos_json         JSON         NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN observaciones      TEXT         NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN gastos             BIGINT       NULL`);
    await addCol(`ALTER TABLE creditos ADD COLUMN seguros            BIGINT       NULL`);
    // Campos desde cartas de aprobación
    // Homologación: rut_concesionario → rut_dealer (race-safe entre creditos/operaciones)
    try {
      const [[rd]] = await pool.query(
        `SELECT SUM(column_name='rut_concesionario') AS oldc, SUM(column_name='rut_dealer') AS newc
         FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='creditos'`);
      if (Number(rd.oldc) > 0 && Number(rd.newc) == 0)
        await pool.query(`ALTER TABLE creditos CHANGE COLUMN rut_concesionario rut_dealer VARCHAR(20) NULL`);
      else if (Number(rd.oldc) == 0 && Number(rd.newc) == 0)
        await pool.query(`ALTER TABLE creditos ADD COLUMN rut_dealer VARCHAR(20) NULL`);
    } catch(e) { console.error('[creditos rename rut_concesionario]', e.message); }
    await addCol(`ALTER TABLE creditos ADD COLUMN vendedor           VARCHAR(150) NULL`);
    // comdea_real ya existe en la tabla original (comisión/participación del dealer)
    // Poblar estado correcto según tipo de financiera:
    // - AUTOFACIL (cartera propia) → VIGENTE (se puede trackear pagos)
    // - AUTOFIN / UNIDAD DE CREDITO (brokerage) → OTORGADO (somos broker, no podemos saber si está vigente)
    await pool.query(`
      UPDATE creditos
      SET estado = 'OTORGADO'
      WHERE estado_eval = 'OTORGADO'
        AND (estado IS NULL OR estado = '' OR estado = 'VIGENTE')
        AND financiera IN ('AUTOFIN', 'UNIDAD DE CREDITO')
    `);
    await pool.query(`
      UPDATE creditos
      SET estado = 'VIGENTE'
      WHERE estado_eval = 'OTORGADO'
        AND (estado IS NULL OR estado = '')
        AND (financiera IS NULL OR financiera NOT IN ('AUTOFIN', 'UNIDAD DE CREDITO'))
    `);
    // Backfill num_op para créditos manuales (alta AutoFácil) que generaron
    // numero_credito pero quedaron sin num_op: la clave de negocio = ese número.
    await pool.query(`
      UPDATE creditos
      SET num_op = CAST(numero_credito AS UNSIGNED)
      WHERE num_op IS NULL
        AND numero_credito IS NOT NULL
        AND numero_credito REGEXP '^[0-9]+$'
    `).catch(e => console.error('[creditos backfill num_op]', e.message));

  } catch (e) {
    if (e.errno !== 1050) console.error('[creditos migration]', e.message);
  }
});

// ── Generar número de crédito (YYMMXXX) ──────────────────────────────────────
async function generarNumero() {
  const hoy = new Date();
  const yy   = String(hoy.getFullYear()).slice(-2);
  const mm   = String(hoy.getMonth() + 1).padStart(2, '0');
  const prefix = `${yy}${mm}`;
  const [rows] = await pool.query(
    `SELECT numero_credito FROM creditos
     WHERE numero_credito LIKE ? ORDER BY id DESC LIMIT 1`,
    [prefix + '%']
  );
  const seq = rows.length ? parseInt(rows[0].numero_credito.slice(4)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

// ── SELECT base para gestión ──────────────────────────────────────────────────
// Muestra OTORGADOS de AUTOFIN y UNIDAD + cualquier crédito digitado manualmente
const SELECT_GESTION = `
  SELECT
    ob.id                                                      AS id_credito,
    COALESCE(ob.numero_credito, CAST(ob.num_op AS CHAR))       AS numero_credito,
    COALESCE(cl.rut,             '')    AS rut_cliente,
    COALESCE(cl.nombre_completo, '')   AS nombre_cliente,
    COALESCE(ob.financiera, 'AUTOFACIL')                       AS financiera,
    -- ETAPA (originación). Para propios cursados la etapa se congela en OTORGADO;
    -- las palabras de cartera que históricamente se guardaron en ob.estado
    -- (VIGENTE/EN MORA/…) se reinterpretan como OTORGADO (su etapa real).
    CASE
      WHEN ob.estado IN ('VIGENTE','EN MORA','VENCIDO','PREPAGADO','CASTIGADO') THEN 'OTORGADO'
      WHEN ob.estado IS NOT NULL AND ob.estado <> '' THEN ob.estado
      WHEN ob.financiera IN ('AUTOFIN','UNIDAD DE CREDITO') AND ob.estado_eval = 'OTORGADO' THEN 'OTORGADO'
      WHEN ob.estado_credito = 'OTORGADO' OR ob.estado_eval = 'OTORGADO' THEN 'OTORGADO'
      WHEN ob.estado_eval = 'ANULADO' OR ob.estado_credito = 'ANULADO' THEN 'ANULADO'
      WHEN ob.estado_eval IN ('RECHAZADO','ANULADO') THEN 'CANCELADO'
      ELSE COALESCE(ob.estado_credito, ob.estado_eval)
    END                                                        AS estado,
    -- ESTADO de cartera (2da dimensión, solo propios). Del campo estado_cartera
    -- (motor); fallback derivado para los que aún no recalcula el motor.
    COALESCE(ob.estado_cartera,
      CASE
        WHEN ob.estado = 'EN MORA' THEN 'MORA'
        WHEN ob.estado IN ('VIGENTE','VENCIDO','PREPAGADO','CASTIGADO') THEN ob.estado
        WHEN (ob.financiera IS NULL OR ob.financiera NOT IN ('AUTOFIN','UNIDAD DE CREDITO'))
             AND ob.estado = 'OTORGADO' THEN 'VIGENTE'
        ELSE NULL
      END)                                                     AS estado_cartera,
    -- Días de atraso = hoy − venc. de la cuota impaga más antigua (calendario real
    -- cuotas_credito). NULL → 0 para los que no tienen calendario. Lo usa el chip.
    COALESCE(DATEDIFF(CURDATE(), (
      SELECT MIN(cc.fecha_vencimiento) FROM cuotas_credito cc
       WHERE cc.id_credito = ob.id AND cc.estado_cuota <> 'PAGADA'
         AND cc.fecha_vencimiento <= CURDATE())), 0)           AS dias_atraso,
    -- Fecha mostrada: otorgamiento; si no se cursó, el MES de la operación (no la fecha de inserción)
    -- Como STRING: COALESCE(DATE, TIMESTAMP) mezclado lo rompe el driver mysql2 (devuelve null);
    -- 'T12:00:00' sin Z para que el navegador lo parsee en hora local (sin off-by-one de timezone)
    CONCAT(DATE_FORMAT(COALESCE(ob.fecha_otorgado, ob.fecha_estado, ob.mes, ob.created_at),'%Y-%m-%d'),'T12:00:00') AS fecha_otorgamiento,
    ob.valor_vehiculo,
    ob.pie,
    ob.monto_financiado,
    ob.plazo,
    ob.tascli_real                                             AS tasa_mensual,
    ob.cuota,
    ob.fecha_primera_cuota,
    ob.tipo_vehiculo,
    ob.marca,
    ob.modelo,
    ob.anio,
    ob.patente,
    ob.automotora                                              AS dealer,
    ob.rut_dealer                                              AS rut_concesionario,
    ob.vendedor,
    ob.comdea_real                                             AS comision_dealer,
    ob.ejecutivo,
    ob.mes,
    ob.id_financiera,
    ob.created_at,
    -- cuotas_pagadas solo para créditos digitados manualmente (numero_credito propio)
    -- Los importados desde Excel (brokerage) no se trackean en pagos: NULL evita falsos EN MORA
    IF(ob.numero_credito IS NOT NULL, COALESCE(pp.cnt, 0), NULL) AS cuotas_pagadas
  FROM creditos ob
  LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
  LEFT JOIN (
    -- Pagadas = pagos registrados en la app ∪ calendario real (cartera migrada
    -- trae su historial en cuotas_credito.estado_cuota='PAGADA'). UNION dedup
    -- por numero_cuota: nunca doble conteo.
    SELECT id_credito, COUNT(DISTINCT numero_cuota) AS cnt FROM (
      SELECT id_credito, numero_cuota FROM pagos_credito  WHERE estado_pago  = 'PAGADO'
      UNION
      SELECT id_credito, numero_cuota FROM cuotas_credito WHERE estado_cuota = 'PAGADA'
    ) u GROUP BY id_credito
  ) pp ON pp.id_credito = ob.id
`;

const WHERE_GESTION = `
  WHERE (
    ob.financiera IN ('AUTOFIN','UNIDAD DE CREDITO')
    OR ob.numero_credito IS NOT NULL
  )
`;

/* ─── CREATE ─────────────────────────────────────────────────────────────── */
const create = async (req, res) => {
  try {
    const {
      rut_cliente, nombre_cliente, financiera, id_cotizacion, estado,
      fecha_otorgamiento, valor_vehiculo, pie, saldo_precio, monto_financiado,
      plazo, tasa_mensual, cuota, fecha_primera_cuota,
      gastos_operativos, seguros,
      tipo_vehiculo, marca, modelo, anio, patente, color, motor, chasis,
      transmision, combustible, tasacion, permiso_circulacion,
      dealer, id_dealer, tipo_ubicacion, nombre_parque,
      ejecutivo, observaciones, datos_json,
      id_financiera, rut_dealer, vendedor, comision_dealer,
    } = req.body;

    if (!rut_cliente)
      return res.status(400).json({ success: false, data: null, error: 'rut_cliente es requerido' });

    // Restricción: no se permiten créditos con fecha de otorgamiento futura
    if (esFechaFutura(fecha_otorgamiento))
      return res.status(400).json({ success: false, data: null, error: `No se permiten créditos con fecha de otorgamiento futura (posterior a ${hoyChileDMY()}).` });

    const numero_credito = await generarNumero();
    const id_usuario = req.usuario?.id_usuario || null;
    const fin = financiera || 'AUTOFACIL';

    // Numeración (ver regla de negocio): num_op = N° OP AutoFácil correlativo/único.
    // id_financiera = N° de la financiera; en AutoFácil (sin financiera externa) repite el N° OP.
    const numOpVal   = parseInt(numero_credito) || null;
    const esBrokerage = ['AUTOFIN', 'UNIDAD DE CREDITO'].includes(String(fin).toUpperCase());
    const idFinVal   = (id_financiera && String(id_financiera).trim())
      ? String(id_financiera).trim()
      : (esBrokerage ? null : (numOpVal != null ? String(numOpVal) : null));

    // Resolver id_cliente
    const rutNorm = rut_cliente.replace(/\./g, '').toUpperCase().trim();
    const [[cliRow]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut = ?', [rutNorm]);
    const id_cliente_resolved = cliRow?.id_cliente || null;

    // saldo_precio calculado si no viene
    const saldo = saldo_precio || (valor_vehiculo && pie ? (valor_vehiculo - pie) : null);
    const pct   = (valor_vehiculo && saldo) ? saldo / valor_vehiculo : null;

    const [r] = await pool.query(`
      INSERT INTO creditos
        (num_op, numero_credito, financiera,
         estado_eval, estado,
         id_cotizacion, id_usuario, id_cliente,
         fecha_otorgado, mes,
         valor_vehiculo, pie, saldo_precio, pct_financiado, monto_financiado,
         plazo, tascli_real, cuota, fecha_primera_cuota,
         gastos, seguros, tipo_vehiculo, marca, modelo, anio,
         patente, color, motor, chasis,
         transmision, combustible, tasacion, permiso_circulacion,
         automotora, id_dealer, tipo_ubicacion, nombre_parque_mgmt,
         ejecutivo, observaciones, datos_json, id_financiera,
         rut_dealer, vendedor, comdea_real,
         created_at, updated_at)
      VALUES (?,?,?,
              'OTORGADO',?,
              ?,?,?,
              ?,DATE_FORMAT(COALESCE(?, NOW()), '%Y-%m-01'),
              ?,?,?,?,?,
              ?,?,?,?,
              ?,?,?,?,?,?,
              ?,?,?,?,
              ?,?,?,?,
              ?,?,?,?,
              ?,?,?,?,
              ?,?,?,
              NOW(), NOW())
    `, [
      numOpVal, numero_credito, fin,
      estado || 'INGRESO',
      id_cotizacion || null, id_usuario, id_cliente_resolved,
      fecha_otorgamiento || null, fecha_otorgamiento || null,
      valor_vehiculo || null, pie || null, saldo || null, pct || null, monto_financiado || null,
      plazo || null, tasa_mensual || null, cuota || null, fecha_primera_cuota || null,
      gastos_operativos || null, seguros || null, tipo_vehiculo || null,
      marca || null, modelo || null, anio || null,
      patente ? patente.toUpperCase().trim() : null, color || null,
      motor || null, chasis || null,
      transmision || null, combustible || null, tasacion || null, permiso_circulacion || null,
      dealer || null, id_dealer || null, tipo_ubicacion || null, nombre_parque || null,
      ejecutivo || null, observaciones || null,
      datos_json ? JSON.stringify(datos_json) : null,
      idFinVal,
      rut_dealer || null,
      vendedor || null,
      comision_dealer != null ? Math.round(parseFloat(comision_dealer)) : null,
    ]);

    audit.registrar({
      id_credito: r.insertId, req,
      accion: 'CREDITO_CREADO',
      detalle: `Crédito N°${numero_credito} creado para ${nombre_cliente}`,
      meta: { numero_credito, cliente: nombre_cliente, rut: rut_cliente, financiera: fin, monto_financiado: monto_financiado || null },
    });

    // Si se digitó una Comisión Dealer distinta a la calculada → forzado (negociación puntual)
    if (comision_dealer != null && String(comision_dealer).trim() !== '') {
      try { await marcarForzadosCalculo(r.insertId, { campos: ['comdea_real'] }); }
      catch (e) { console.error('[forzados digitacion]', e.message); }
    }

    // Recalcular el mes del crédito nuevo (comisiones/ingresos) — automático. Fire-and-forget.
    recalcularPorOps(r.insertId).catch(e => console.error('[recalc credito nuevo]', e.message));

    res.status(201).json({ success: true, data: { id_credito: r.insertId, numero_credito }, error: null });
  } catch (e) {
    console.error('[creditos create]', e);
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

// ESTADO de cartera en VIVO para el listado (mismo cálculo de días que Cobranza):
// usa cuotas_pagadas + fecha_primera_cuota + plazo. Respeta cierres manuales del
// motor (CASTIGADO/PREPAGADO/TERMINADO). Devuelve el estado o el original si no aplica.
function carteraLiveRow(row, um) {
  if (!row.estado_cartera) return row.estado_cartera;          // brokerage / no-cartera → sin cambio
  const stored = String(row.estado_cartera).toUpperCase();
  if (['CASTIGADO', 'PREPAGADO', 'TERMINADO'].includes(stored)) return row.estado_cartera;
  const plazo = parseInt(row.plazo, 10) || 0;
  if (!plazo || !row.fecha_primera_cuota) return row.estado_cartera;
  const fp = row.fecha_primera_cuota instanceof Date
    ? row.fecha_primera_cuota
    : new Date(String(row.fecha_primera_cuota).slice(0, 10) + 'T00:00:00Z');
  const fpY = fp.getUTCFullYear(), fpM = fp.getUTCMonth(), fpD = fp.getUTCDate();
  const now = new Date();
  const nY = now.getUTCFullYear(), nM = now.getUTCMonth(), nD = now.getUTCDate();
  const meses = (nY - fpY) * 12 + (nM - fpM) + (nD >= fpD ? 1 : 0);
  const CV = Math.min(plazo, Math.max(0, meses));              // cuotas vencidas
  const pagadas = parseInt(row.cuotas_pagadas, 10) || 0;
  // Días de atraso para el chip: prefiere el calendario real (subconsulta a
  // cuotas_credito, exacta para INDEXA); si no hay (créditos nuevos AutoFácil sin
  // calendario congelado), usa el derivado de fecha_primera_cuota (igual que la ficha).
  const realDias = parseInt(row.dias_atraso, 10) || 0;
  if (CV - pagadas <= 0) { row.dias_atraso = realDias; return 'VIGENTE'; }  // al día
  const due = Date.UTC(fpY, fpM + pagadas, fpD);               // venc. cuota impaga más antigua
  const dias = Math.max(0, Math.floor((Date.UTC(nY, nM, nD) - due) / 86400000));
  row.dias_atraso = realDias > 0 ? realDias : dias;
  return AF_MORA.clasificarPorDias(realDias > 0 ? realDias : dias, um);   // umbrales: motor único
}

/* ─── GET ALL ────────────────────────────────────────────────────────────── */
const getAll = async (req, res) => {
  try {
    const { q, page, limit, estado, financiera, fecha_desde, fecha_hasta, sort, dir } = req.query;
    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit) || 100));
    const offset   = (pageNum - 1) * limitNum;

    // "Bucket de display" para chips y filtro: para PROPIOS cursados muestra el
    // ESTADO de cartera (VIGENTE/EN MORA/…) — así los chips Vigentes/En Mora siguen
    // andando; para BROKERAGE muestra la ETAPA. (La columna ETAPA de la fila usa la
    // expresión de SELECT_GESTION, que para propios da OTORGADO.)
    const estadoExpr = `
      CASE
        WHEN (ob.financiera IS NULL OR ob.financiera NOT IN ('AUTOFIN','UNIDAD DE CREDITO'))
             AND (ob.estado IN ('VIGENTE','EN MORA','VENCIDO','PREPAGADO','CASTIGADO')
                  OR ob.estado_cartera IS NOT NULL
                  OR ob.estado_credito = 'OTORGADO' OR ob.estado_eval = 'OTORGADO')
        THEN CASE
               WHEN ob.estado_cartera = 'MORA' THEN 'EN MORA'
               WHEN ob.estado_cartera IS NOT NULL AND ob.estado_cartera <> '' THEN ob.estado_cartera
               WHEN ob.estado IN ('VIGENTE','EN MORA','VENCIDO','PREPAGADO','CASTIGADO') THEN ob.estado
               ELSE 'VIGENTE'
             END
        WHEN ob.financiera IN ('AUTOFIN','UNIDAD DE CREDITO') AND ob.estado_eval = 'OTORGADO' THEN 'OTORGADO'
        WHEN ob.estado IS NOT NULL AND ob.estado <> '' THEN ob.estado
        WHEN ob.estado_eval = 'ANULADO' OR ob.estado_credito = 'ANULADO' THEN 'ANULADO'
      WHEN ob.estado_eval IN ('RECHAZADO','ANULADO') THEN 'CANCELADO'
        ELSE COALESCE(ob.estado_credito, ob.estado_eval)
      END`;

    // whereBase = q + financiera (sin estado) → para los chips de stats (siempre el desglose completo)
    let whereBase = WHERE_GESTION;
    const paramsBase = [];

    if (q && q.trim()) {
      const qNorm = q.trim().toUpperCase().replace(/\./g, '');
      const like  = `%${qNorm}%`;
      whereBase += ` AND (
        UPPER(REPLACE(COALESCE(cl.rut, ''),'.',''))                        LIKE ? OR
        UPPER(COALESCE(cl.nombre_completo, ''))                            LIKE ? OR
        UPPER(COALESCE(ob.numero_credito, CAST(ob.num_op AS CHAR)))        LIKE ?
      )`;
      paramsBase.push(like, like, like);
    }

    if (financiera && financiera !== 'TODAS') {
      // Acepta una o varias empresas separadas por coma (multi-select de cards)
      const conds = [];
      for (const f of financiera.toUpperCase().split(',').map(s => s.trim()).filter(Boolean)) {
        if (f === 'AUTOFACIL') {
          // AFA es cartera propia ANTIGUA con su propia card — no cuenta como AutoFácil
          conds.push(`(ob.financiera IS NULL OR ob.financiera NOT IN ('AUTOFIN','UNIDAD DE CREDITO','AFA'))`);
        } else if (f === 'UNIDAD') {
          conds.push(`ob.financiera = 'UNIDAD DE CREDITO'`);
        } else {
          conds.push(`ob.financiera = ?`);
          paramsBase.push(f);
        }
      }
      if (conds.length) whereBase += ` AND (${conds.join(' OR ')})`;
    }

    // Rango de fecha: manda el MES de cierre (ob.mes) — mismo universo que el
    // dashboard/penetración; fallback a fecha_otorgado/estado/created_at si no hay mes.
    const fd = /^\d{4}-\d{2}-\d{2}$/.test(fecha_desde || '') ? fecha_desde : null;
    const fh = /^\d{4}-\d{2}-\d{2}$/.test(fecha_hasta || '') ? fecha_hasta : null;
    if (fd) { whereBase += ` AND DATE(COALESCE(ob.mes, ob.fecha_otorgado, ob.fecha_estado, ob.created_at)) >= ?`; paramsBase.push(fd); }
    if (fh) { whereBase += ` AND DATE(COALESCE(ob.mes, ob.fecha_otorgado, ob.fecha_estado, ob.created_at)) <= ?`; paramsBase.push(fh); }

    // ── ESTADO de cartera EN VIVO (reusa carteraLiveRow; los propios son pocos) ──
    // Se calcula UNA vez y se usa para el filtro y los conteos de los chips de cartera,
    // así coinciden con la columna ESTADO del detalle (que también usa carteraLiveRow).
    let um = { mora: 1, vencido: 91 };
    try {
      const [ump] = await pool.query('SELECT clave, valor FROM cartera_parametros');
      const UM = {}; ump.forEach(u => { UM[u.clave] = parseInt(u.valor, 10); });
      um = { mora: Number.isFinite(UM.mora_desde) ? UM.mora_desde : 1, vencido: Number.isFinite(UM.vencido_desde) ? UM.vencido_desde : 91 };
    } catch (_) {}
    const CARTERA_ESTADOS = ['VIGENTE', 'EN MORA', 'VENCIDO', 'TERMINADO', 'PREPAGADO', 'CASTIGADO'];
    const carteraIds = {};    // estado vivo → [ids]
    const carteraCount = {};  // estado vivo → conteo
    try {
      const [props] = await pool.query(
        `SELECT ob.id,
                COALESCE(ob.estado_cartera, CASE
                  WHEN ob.estado = 'EN MORA' THEN 'MORA'
                  WHEN ob.estado IN ('VIGENTE','VENCIDO','PREPAGADO','CASTIGADO') THEN ob.estado
                  WHEN (ob.financiera IS NULL OR ob.financiera NOT IN ('AUTOFIN','UNIDAD DE CREDITO')) AND ob.estado = 'OTORGADO' THEN 'VIGENTE'
                  ELSE NULL END) AS estado_cartera,
                ob.plazo, ob.fecha_primera_cuota,
                IF(ob.numero_credito IS NOT NULL, COALESCE(pp.cnt,0), NULL) AS cuotas_pagadas
           FROM creditos ob
           LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
           LEFT JOIN (SELECT id_credito, COUNT(DISTINCT numero_cuota) AS cnt FROM (
               SELECT id_credito, numero_cuota FROM pagos_credito  WHERE estado_pago  = 'PAGADO'
               UNION
               SELECT id_credito, numero_cuota FROM cuotas_credito WHERE estado_cuota = 'PAGADA'
             ) u GROUP BY id_credito) pp ON pp.id_credito = ob.id
          ${whereBase}
            AND (ob.financiera IS NULL OR ob.financiera NOT IN ('AUTOFIN','UNIDAD DE CREDITO'))
            AND (ob.estado_cartera IS NOT NULL OR ob.estado = 'OTORGADO' OR ob.estado IN ('VIGENTE','EN MORA','VENCIDO','PREPAGADO','CASTIGADO'))`,
        paramsBase);
      for (const p of props) {
        let e = carteraLiveRow(p, um);
        if (!e) continue;
        e = String(e).toUpperCase() === 'MORA' ? 'EN MORA' : String(e).toUpperCase();
        (carteraIds[e] = carteraIds[e] || []).push(p.id);
        carteraCount[e] = (carteraCount[e] || 0) + 1;
      }
    } catch (e) { console.error('[creditos carteraLive]', e.message); }

    // Condición de "propio cursado" (misma del cálculo de cartera): su columna
    // ETAPA muestra OTORGADO, así que también cuentan en la etapa OTORGADO.
    const PROPIO_CURSADO = `((ob.financiera IS NULL OR ob.financiera NOT IN ('AUTOFIN','UNIDAD DE CREDITO'))
        AND (ob.estado_cartera IS NOT NULL OR ob.estado = 'OTORGADO' OR ob.estado IN ('VIGENTE','EN MORA','VENCIDO','PREPAGADO','CASTIGADO')))`;

    // whereData = whereBase + estado → para la lista paginada y su total
    let whereData = whereBase;
    const paramsData = [...paramsBase];
    if (estado === '__PROCESO__') {
      whereData += ` AND ${estadoExpr} NOT IN ('VIGENTE','CANCELADO','PREPAGADO','CASTIGADO','EN MORA','OTORGADO','CURSADO','DESISTIDO')`;
    } else if (estado === '__SIN_ESTADO__') {
      // Sin estado de cartera = créditos de Brokerage (hace cuadrar la fila Estados con el Total)
      whereData += ` AND ${estadoExpr} NOT IN ('VIGENTE','EN MORA','VENCIDO','TERMINADO','PREPAGADO','CASTIGADO')`;
    } else if (CARTERA_ESTADOS.includes(String(estado || '').toUpperCase())) {
      // Estado de cartera → filtrar por el estado VIVO (ids ya calculados con carteraLiveRow).
      const ids = carteraIds[String(estado).toUpperCase()] || [];
      whereData += ` AND ob.id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'})`;
      paramsData.push(...ids);
    } else if (String(estado || '').toUpperCase() === 'OTORGADO') {
      // etapa OTORGADO = brokerage otorgado + propios cursados (columna ETAPA = OTORGADO)
      whereData += ` AND (${estadoExpr} = 'OTORGADO' OR ${PROPIO_CURSADO})`;
    } else if (estado && estado !== 'todos') {
      whereData += ` AND ${estadoExpr} = ?`;
      paramsData.push(estado.toUpperCase());
    }

    const [[statsRows], [countRows]] = await Promise.all([
      pool.query(
        `SELECT ${estadoExpr} AS estado, COUNT(*) AS cnt
         FROM creditos ob
         LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
         LEFT JOIN (SELECT id_credito, COUNT(DISTINCT numero_cuota) AS cnt FROM pagos_credito WHERE estado_pago='PAGADO' GROUP BY id_credito) pp ON pp.id_credito = ob.id
         ${whereBase}
         GROUP BY ${estadoExpr}`,
        paramsBase
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM creditos ob
         LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente` + whereData,
        paramsData
      ),
    ]);

    const total = countRows[0].total;
    const stats = {};
    let statsTotal = 0;
    for (const r of statsRows) { stats[r.estado || 'SIN_ESTADO'] = r.cnt; statsTotal += r.cnt; }
    // Conteos de cartera = cálculo EN VIVO (coinciden con la columna ESTADO del detalle).
    for (const e of CARTERA_ESTADOS) stats[e] = carteraCount[e] || 0;
    // Etapa OTORGADO: sumar los propios cursados (su columna ETAPA muestra OTORGADO;
    // antes solo contaban en la fila Estados y el chip Otorgados quedaba en 0).
    stats['OTORGADO'] = (stats['OTORGADO'] || 0) + Object.values(carteraCount).reduce((a, b) => a + b, 0);

    // Orden por columna (whitelist) — default: mes/id desc
    const SORT_MAP = {
      numero_credito:     'CAST(COALESCE(ob.numero_credito, CAST(ob.num_op AS CHAR)) AS UNSIGNED)',
      rut_cliente:        'cl.rut',
      nombre_cliente:     'cl.nombre_completo',
      financiera:         'ob.financiera',
      id_financiera:      'ob.id_financiera',
      fecha_otorgamiento: 'ob.fecha_otorgado',
      monto_financiado:   'ob.monto_financiado',
      cuota:              'ob.cuota',
      plazo:              'ob.plazo',
      estado:             estadoExpr,
    };
    const sortExpr = SORT_MAP[sort] || null;
    const sortDir  = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderBy  = sortExpr ? `${sortExpr} ${sortDir}, ob.id DESC` : `ob.mes DESC, ob.id DESC`;

    const sql = SELECT_GESTION + whereData + ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    const [rows] = await pool.query(sql, [...paramsData, limitNum, offset]);

    // ESTADO de cartera EN VIVO en cada fila del listado (umbrales `um` ya cargados arriba).
    try { rows.forEach(r => { r.estado_cartera = carteraLiveRow(r, um); }); } catch (_) {}

    res.json({
      success: true,
      data: rows,
      stats,
      statsTotal,
      pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) },
      error: null
    });
  } catch (e) {
    console.error('[creditos getAll]', e);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── GET BY ID ──────────────────────────────────────────────────────────── */
const getById = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ob.*,
              ob.id                                                AS id_credito,
              COALESCE(ob.numero_credito, CAST(ob.num_op AS CHAR)) AS numero_credito_fmt,
              ob.automotora                                         AS dealer,
              ob.tascli_real                                        AS tasa_mensual,
              ob.fecha_otorgado                                     AS fecha_otorgamiento,
              -- ETAPA derivada (propios cursados → OTORGADO). ob.estado se conserva
              -- intacto (VIGENTE/…) para no alterar los flujos de pago de la ficha.
              CASE
                WHEN ob.estado IN ('VIGENTE','EN MORA','VENCIDO','PREPAGADO','CASTIGADO') THEN 'OTORGADO'
                WHEN ob.estado IS NOT NULL AND ob.estado <> '' THEN ob.estado
                WHEN ob.financiera IN ('AUTOFIN','UNIDAD DE CREDITO') AND ob.estado_eval = 'OTORGADO' THEN 'OTORGADO'
                WHEN ob.estado_credito = 'OTORGADO' OR ob.estado_eval = 'OTORGADO' THEN 'OTORGADO'
                WHEN ob.estado_eval = 'ANULADO' OR ob.estado_credito = 'ANULADO' THEN 'ANULADO'
      WHEN ob.estado_eval IN ('RECHAZADO','ANULADO') THEN 'CANCELADO'
                ELSE COALESCE(ob.estado_credito, ob.estado_eval)
              END                                                  AS estado_etapa,
              COALESCE(ob.estado_cartera,
                CASE
                  WHEN ob.estado = 'EN MORA' THEN 'MORA'
                  WHEN ob.estado IN ('VIGENTE','VENCIDO','PREPAGADO','CASTIGADO') THEN ob.estado
                  WHEN (ob.financiera IS NULL OR ob.financiera NOT IN ('AUTOFIN','UNIDAD DE CREDITO'))
                       AND ob.estado = 'OTORGADO' THEN 'VIGENTE'
                  ELSE NULL
                END)                                               AS estado_cartera_disp,
              COALESCE(cl.rut,             '') AS rut_cliente,
              COALESCE(cl.nombre_completo, '') AS nombre_cliente
       FROM creditos ob
       LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
       WHERE ob.id = ?`,
      [req.params.id]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, data: null, error: 'Crédito no encontrado' });
    const c = rows[0];
    // ESTADO de cartera en TIEMPO REAL para la ficha (no espera al motor): si es
    // cartera propia y no es un cierre manual, clasifica por días de atraso ahora.
    try {
      const finUp = String(c.financiera || '').toUpperCase();
      const esPropio = finUp !== 'AUTOFIN' && finUp !== 'UNIDAD DE CREDITO';
      const stored = String(c.estado_cartera || '').toUpperCase();
      const manualTerm = ['CASTIGADO', 'PREPAGADO', 'TERMINADO'].includes(stored);
      // La cartera (Estado) solo existe cuando la ETAPA ya es OTORGADO. Antes de eso
      // (Ingresado, En Análisis, Validación Firma, etc.) NO hay Estado de cartera ni pago.
      const etapaOtorgado = String(c.estado_etapa || '').toUpperCase() === 'OTORGADO';
      if (manualTerm) {
        c.estado_cartera_disp = c.estado_cartera;
      } else if (esPropio && etapaOtorgado && c.fecha_primera_cuota && Number(c.plazo) > 0) {
        // MOTOR ÚNICO (mora-core): calendario congelado si existe + pagos en app
        const [pg] = await pool.query(
          `SELECT numero_cuota FROM pagos_credito WHERE id_credito=? AND estado_pago='PAGADO'`, [c.id]);
        const [cal] = await pool.query(
          `SELECT numero_cuota, fecha_vencimiento, valor_cuota, estado_cuota, fecha_pago
             FROM cuotas_credito WHERE id_credito=? ORDER BY numero_cuota`, [c.id]);
        const [ump] = await pool.query('SELECT clave, valor FROM cartera_parametros');
        const UM = {}; ump.forEach(u => { UM[u.clave] = parseInt(u.valor, 10); });
        const um = { mora: Number.isFinite(UM.mora_desde) ? UM.mora_desde : 1, vencido: Number.isFinite(UM.vencido_desde) ? UM.vencido_desde : 91 };
        const cls = AF_MORA.estadoMora({
          plazo: c.plazo, fecha_primera_cuota: c.fecha_primera_cuota, cuota: c.cuota,
          calendario: cal, pagadas: pg.map(p => p.numero_cuota), umbrales: um,
        });
        if (cls) { c.estado_cartera_disp = cls.estado; c.dias_atraso = cls.dias; }
      }
    } catch (_) { /* deja el fallback del SELECT */ }
    res.json({ success: true, data: c, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── UPDATE ─────────────────────────────────────────────────────────────── */
const update = async (req, res) => {
  try {
    // Verificar mes cerrado
    const _mesCh = await getMesDeOp(req.params.id);
    if (_mesCh && await isMesCerrado(_mesCh))
      return res.status(403).json({ success: false, data: null, error: `🔒 Mes ${_mesCh} cerrado — no se permiten modificaciones` });

    const {
      estado, observaciones, ejecutivo, dealer, patente, color, motor, chasis,
      // Campos de edición completa
      rut_cliente, nombre_cliente, financiera,
      fecha_otorgamiento, fecha_primera_cuota,
      valor_vehiculo, pie, saldo_precio, monto_financiado,
      plazo, tasa_mensual, cuota,
      gastos_operativos, seguros,
      tipo_vehiculo, marca, modelo, anio,
      transmision, combustible, tasacion, permiso_circulacion,
      id_dealer, tipo_ubicacion, nombre_parque,
      datos_json,
      rut_dealer, vendedor, comision_dealer, id_financiera,
    } = req.body;

    // Restricción: no se permite editar un crédito con fecha de otorgamiento futura
    if (esFechaFutura(fecha_otorgamiento))
      return res.status(400).json({ success: false, data: null, error: `No se permiten créditos con fecha de otorgamiento futura (posterior a ${hoyChileDMY()}).` });

    const [prev] = await pool.query(
      `SELECT c.estado, c.numero_credito, c.id_usuario AS creador_id, c.financiera,
              COALESCE(cl.nombre_completo, '') AS nombre_cliente
       FROM creditos c
       LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
       WHERE c.id = ?`,
      [req.params.id]
    );
    if (!prev.length) return res.status(404).json({ success: false, data: null, error: 'Crédito no encontrado' });
    const estadoAntes = prev[0]?.estado || null;

    // Detectar si es una edición completa (vienen campos financieros)
    const esEdicionCompleta = monto_financiado !== undefined || valor_vehiculo !== undefined;

    if (esEdicionCompleta) {
      // ── Edición completa: actualiza todos los campos del formulario de ingreso
      const saldo = saldo_precio || (valor_vehiculo && pie ? (valor_vehiculo - pie) : null);
      const pct   = (valor_vehiculo && saldo) ? saldo / valor_vehiculo : null;

      await pool.query(`
        UPDATE creditos
        SET estado               = ?,
            observaciones        = ?,
            ejecutivo            = ?,
            automotora           = ?,
            patente              = ?,
            color                = ?,
            motor                = ?,
            chasis               = ?,
            financiera           = ?,
            fecha_otorgado       = ?,
            fecha_primera_cuota  = ?,
            valor_vehiculo       = ?,
            pie                  = ?,
            saldo_precio         = ?,
            pct_financiado       = ?,
            monto_financiado     = ?,
            plazo                = ?,
            tascli_real          = ?,
            cuota                = ?,
            gastos               = ?,
            seguros              = ?,
            tipo_vehiculo        = ?,
            marca                = ?,
            modelo               = ?,
            anio                 = ?,
            transmision          = ?,
            combustible          = ?,
            tasacion             = ?,
            permiso_circulacion  = ?,
            id_dealer            = ?,
            tipo_ubicacion       = ?,
            nombre_parque_mgmt   = ?,
            datos_json           = ?,
            rut_dealer    = ?,
            vendedor             = ?,
            comdea_real          = ?,
            id_financiera        = ?,
            updated_at           = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        estado || estadoAntes, observaciones || null,
        ejecutivo || null, dealer || null,
        patente ? patente.toUpperCase().trim() : null,
        color || null, motor || null, chasis || null,
        financiera || 'AUTOFACIL',
        fecha_otorgamiento || null,
        fecha_primera_cuota || null,
        valor_vehiculo || null, pie || null, saldo || null, pct || null, monto_financiado || null,
        plazo || null, tasa_mensual || null, cuota || null,
        gastos_operativos || null, seguros || null,
        tipo_vehiculo || null, marca || null, modelo || null, anio || null,
        transmision || null, combustible || null, tasacion || null, permiso_circulacion || null,
        id_dealer || null, tipo_ubicacion || null, nombre_parque || null,
        datos_json ? JSON.stringify(datos_json) : null,
        rut_dealer || null,
        vendedor || null,
        comision_dealer != null ? Math.round(parseFloat(comision_dealer)) : null,
        id_financiera || null,
        req.params.id,
      ]);

      audit.registrar({
        id_credito: req.params.id, req,
        accion: 'CREDITO_EDITADO',
        detalle: `Crédito N°${prev[0].numero_credito} editado por ${req.usuario?.nombre || 'usuario'}`,
        meta: { monto_financiado, plazo, tasa_mensual, valor_vehiculo },
      });
    } else {
      // ── Actualización parcial: solo estado/observaciones/campos de gestión
      await pool.query(`
        UPDATE creditos
        SET estado        = ?,
            observaciones = ?,
            ejecutivo     = ?,
            automotora    = ?,
            patente       = ?,
            color         = ?,
            motor         = ?,
            chasis        = ?,
            updated_at    = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        estado, observaciones || null, ejecutivo || null, dealer || null,
        patente ? patente.toUpperCase().trim() : null,
        color || null, motor || null, chasis || null, req.params.id
      ]);
    }

    if (estado && estadoAntes && estado !== estadoAntes) {
      audit.registrar({
        id_credito: req.params.id, req,
        accion: 'ESTADO_CAMBIADO',
        detalle: `Estado: ${estadoAntes} → ${estado}`,
        meta: { estado_antes: estadoAntes, estado_despues: estado },
      });

      // ── Alertas de análisis de crédito (mismo patrón que Cartas de Aprobación) ──
      try {
        const actorId   = req.usuario?.id_usuario || null;
        const actor     = (req.usuario?.nombre ? (req.usuario.nombre + ' ' + (req.usuario.apellido || '')).trim() : 'Un usuario');
        const nCred     = prev[0].numero_credito || ('#' + req.params.id);
        const nCli      = prev[0].nombre_cliente || '';
        const creadorId = prev[0].creador_id || null;
        const FORWARD_APROB = ['EMISION_DOCUMENTOS', 'CARGA_DOCUMENTOS_AF', 'VALIDACION_FIRMA', 'OTORGADO'];

        // 1) Entra a Análisis → alerta al POOL de analistas/supervisor de crédito
        if (estado === 'EN_ANALISIS') {
          const ids = await idsAnalistasCredito(actorId);
          if (ids.length) await notificar(ids, {
            tipo: 'CREDITO_ANALISIS',
            titulo: '🛎️ Nuevo crédito para análisis',
            mensaje: `${actor} envió a análisis el crédito N°${nCred}${nCli ? ' — ' + nCli : ''}`,
            href: '/creditos/respaldos?id=' + req.params.id,
            prioridad: 'alta', sonar: 1, son_tipo: 'dingdong',
          });
        }

        // 2) Resolución del análisis → avisa al que GENERÓ el crédito
        const aprobado  = estadoAntes === 'EN_ANALISIS' && FORWARD_APROB.includes(estado);
        const rechazado = estadoAntes === 'EN_ANALISIS' && estado === 'RECHAZADO';
        if ((aprobado || rechazado) && creadorId && creadorId !== actorId) {
          await notificar([creadorId], {
            tipo: aprobado ? 'CREDITO_APROBADO' : 'CREDITO_RECHAZADO',
            titulo: aprobado ? '✅ Crédito aprobado' : '❌ Crédito rechazado',
            mensaje: aprobado
              ? `Tu crédito N°${nCred}${nCli ? ' (' + nCli + ')' : ''} pasó el análisis${estado === 'EMISION_DOCUMENTOS' ? ' y avanza a Emisión de Documentos' : ''}.`
              : `Tu crédito N°${nCred}${nCli ? ' (' + nCli + ')' : ''} fue rechazado en análisis${observaciones ? ': ' + observaciones : ''}.`,
            href: '/creditos/revisar?id=' + req.params.id,
            prioridad: 'alta', sonar: 1, son_tipo: aprobado ? 'dingdong' : 'alarma',
          });
        }
      } catch (e) { console.error('[creditos notif análisis]', e.message); }

      // Crédito cursado → marcar carta como otorgada + agregar entrada a cartolas
      if (estado === 'OTORGADO') {
        try {
          // 1. Marcar carta como otorgada
          await pool.query(
            `UPDATE cartas_aprobacion
             SET otorgado = 1, fecha_otorgado = NOW()
             WHERE id_credito_creado = ? AND (otorgado = 0 OR otorgado IS NULL)`,
            [req.params.id]
          );

          // 2. Obtener la carta vinculada
          const [[carta]] = await pool.query(
            `SELECT * FROM cartas_aprobacion WHERE id_credito_creado = ? LIMIT 1`,
            [req.params.id]
          );

          if (carta) {
            // 3. Obtener mail del dealer
            const [[dealer]] = await pool.query(
              `SELECT correo FROM dealers WHERE rut = ? LIMIT 1`,
              [carta.rut_dealer || '']
            ).catch(() => [[null]]);

            // 4. Leer cartolas actuales del parámetro
            const [[paramRow]] = await pool.query(
              `SELECT \`value\` FROM cartas_parametros WHERE \`key\` = 'cartolas'`
            ).catch(() => [[null]]);

            let cartolas = [];
            try { cartolas = JSON.parse(paramRow?.value || '[]'); } catch {}
            if (!Array.isArray(cartolas)) cartolas = [];

            // 5. Solo agregar si no existe ya la operación
            const yaExiste = cartolas.find(r => String(r.nOp) === String(carta.id_financiera || carta.op_carta));
            if (!yaExiste) {
              const nextCorr = cartolas.length > 0
                ? Math.max(...cartolas.map(r => Number(r.correlativo) || 0)) + 1
                : 1;
              const now = new Date();
              const excelDate = Math.round((now - new Date(1899, 11, 30)) / 86400000);
              const mesDisplay = now.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });

              cartolas.push({
                correlativo:    nextCorr,
                mes:            excelDate,
                mesDisplay,
                nOp:            carta.id_financiera || carta.op_carta || '',
                movimiento:     'COMISION',
                rutConc:        carta.rut_dealer || '',
                concesionario:  carta.nombre_dealer || '',
                mail:           dealer?.correo   || '',
                ejecutivo:      carta.ejecutivo || '',
                nombreCliente:  carta.cliente    || '',
                rutCliente:     carta.rut_cliente || '',
                saldoPrecio:    carta.saldo       || 0,
                comisionBruta:  carta.part_bruto  || 0,
                estadoComision: 'PENDIENTE',
                nOperacion:     carta.op_carta    || '',
                vendedor:       carta.vendedor    || '',
                acreedor:       carta.acreedor    || '',
                pctComision:    carta.saldo > 0 ? (carta.part_bruto || 0) / carta.saldo : 0,
                observaciones:  '',
                cartaId:        carta.id,
              });

              // 6. Guardar cartolas actualizadas
              await pool.query(
                `INSERT INTO cartas_parametros (\`key\`, \`value\`, updated_by)
                 VALUES ('cartolas', ?, 'system')
                 ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = NOW()`,
                [JSON.stringify(cartolas)]
              );
              console.log(`✓ Cartola agregada para carta ${carta.op_carta} (crédito ${req.params.id})`);
            }
          }
        } catch (e2) {
          console.error('[update] Error marcando carta/cartola como otorgada:', e2.message);
        }
      }
    }
    res.json({ success: true, data: { id_credito: req.params.id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── GET /reporteria — todos los campos de créditos ─────────────────────── */
const getReporteria = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        COALESCE(ob.numero_credito, CAST(ob.num_op AS CHAR)) AS numero_credito,
        ob.num_op,
        COALESCE(cl.rut,             '')  AS rut_cliente,
        COALESCE(cl.nombre_completo, '')  AS nombre_cliente,
        ob.financiera,
        ob.estado_credito                 AS estado,
        ob.fecha_otorgado,
        ob.mes,
        ob.valor_vehiculo, ob.saldo_precio, ob.pie,
        ob.monto_financiado, ob.monto_capitalizado,
        ob.plazo,
        ob.tascli_real                    AS tasa_mensual,
        ob.cuota,
        ob.fecha_primera_cuota,
        ob.tipo_vehiculo, ob.marca, ob.modelo, ob.anio, ob.patente,
        ob.automotora                     AS dealer,
        ob.rut_dealer                     AS rut_concesionario,
        ob.vendedor,
        ob.parque,
        ob.ejecutivo,
        ob.comdea_real                    AS comision_dealer,
        ob.com_parque,
        ob.monto_comision_fin,
        ob.com_rdh, ob.com_cesantia, ob.com_reparaciones,
        ob.ingreso_neto_total,
        ob.seguro_rdh, ob.seguro_cesantia, ob.seguro_rep_menor,
        ob.pen_rdh, ob.pen_cesantia, ob.pen_reparaciones,
        ob.created_at
      FROM creditos ob
      LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
      ORDER BY ob.mes DESC, ob.id DESC
    `);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* PATCH /api/creditos/:id/datos-ingresos
   Actualiza solo los campos de ingresos/comisiones que vienen del body */
const getOtorgadosIncompletos = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, num_op, ejecutivo, automotora, monto_financiado, mes,
             financiera, id_financiera, parque,
             plazo, tascli_real,
             seguro_rdh, seguro_cesantia, seguro_rep_menor,
             monto_comision_fin, comdea_real, com_parque
      FROM creditos
      WHERE estado_eval = 'OTORGADO'
        AND estado_credito NOT IN ('RECHAZADO','ANULADO')
        AND (plazo IS NULL OR plazo = 0 OR tascli_real IS NULL OR tascli_real = 0)
      ORDER BY mes DESC, num_op DESC
    `);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const patchDatosIngresos = async (req, res) => {
  try {
    const { id } = req.params;
    // Verificar mes cerrado
    const _mesPatch = await getMesDeOp(id);
    if (_mesPatch && await isMesCerrado(_mesPatch))
      return res.status(403).json({ success: false, data: null, error: `🔒 Mes ${_mesPatch} cerrado — no se permiten modificaciones` });
    const CAMPOS_NUM  = ['plazo', 'tascli_real', 'seguro_rdh', 'seguro_cesantia', 'seguro_rep_menor', 'seguros', 'comdea_real', 'com_parque'];
    const CAMPOS_TEXT = ['parque'];
    const CAMPOS_PERMITIDOS = [...CAMPOS_NUM, ...CAMPOS_TEXT];
    const sets = [];
    const vals = [];
    for (const campo of CAMPOS_PERMITIDOS) {
      if (req.body[campo] !== undefined) {
        sets.push(`${campo} = ?`);
        const v = req.body[campo];
        if (CAMPOS_TEXT.includes(campo)) {
          vals.push(v === null ? null : String(v));
        } else {
          vals.push(v === '' || v === null ? null : parseFloat(v));
        }
      }
    }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Sin campos válidos' });
    vals.push(id);
    await pool.query(`UPDATE creditos SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, vals);
    const [[row]] = await pool.query('SELECT mes FROM creditos WHERE id = ?', [id]);
    res.json({ success: true, data: { id, mes: row?.mes }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { create, getAll, getById, update, getReporteria, getOtorgadosIncompletos, patchDatosIngresos };
