'use strict';
const pool = require('../../../../shared/config/database');
const XLSX = require('xlsx');
const { recalcularMeses, extraerMeses } = require('../utils/recalcular-mes');
const { isMesCerrado } = require('../../../../shared/utils/mes-cerrado');
const { esFechaFutura } = require('../../../../shared/utils/fecha-futura');
const historial = require('./carga-historial.controller');
const { auditar } = require('../../../../shared/audit');
const RUT = require('../../../../api-gateway/public/js/rut-core');  // enforcement: RUT canónico
const { parseMesTxt, finDeMes } = require('../../../../shared/utils/mes-excel'); // motor único parseo MES

/* ── Lee un Excel acotando el rango real de datos ────────────────────────
   Archivos que se han editado mucho arrastran formato "de sobra" (columnas/
   filas vacías con formato aplicado), lo que infla el rango declarado (!ref)
   de la hoja mucho más allá de los datos reales. sheet_to_json() sin acotar
   genera un objeto JS por CADA fila/columna de ese rango (aunque esté vacía),
   lo que puede multiplicar la memoria usada y tumbar el proceso por OOM en
   archivos grandes. Se detecta la última columna con encabezado real y la
   última fila con dato real en la columna OP/ID, y se acota antes de parsear. */
function leerFilasExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws['!ref']) return [];
  const full = XLSX.utils.decode_range(ws['!ref']);

  let lastCol = full.s.c;
  for (let c = full.s.c; c <= full.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: full.s.r, c })];
    if (cell && cell.v !== undefined && String(cell.v).trim() !== '') lastCol = c;
  }

  let colClave = -1;
  for (let c = full.s.c; c <= lastCol; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: full.s.r, c })];
    const h = cell && cell.v != null ? String(cell.v).trim().toUpperCase() : '';
    if (h === 'OP' || h === 'ID') { colClave = c; break; }
  }

  let lastRow = full.s.r;
  if (colClave >= 0) {
    for (let r = full.s.r + 1; r <= full.e.r; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: colClave })];
      if (cell && cell.v !== undefined && String(cell.v).trim() !== '') lastRow = r;
    }
  } else {
    lastRow = full.e.r; // no se encontró columna clave: no se puede acotar, usar rango completo
  }

  const range = { s: { r: full.s.r, c: full.s.c }, e: { r: lastRow, c: lastCol } };
  return XLSX.utils.sheet_to_json(ws, { defval: '', range });
}

/* ── Asegurar columnas extra en creditos ──────────────────── */
require('../../../../shared/migrate').enFila('carga-masiva', async () => {
  const extra = [
    `ALTER TABLE creditos ADD COLUMN com_rdh            DECIMAL(15,0) NULL`,
    `ALTER TABLE creditos ADD COLUMN com_cesantia       DECIMAL(15,0) NULL`,
    `ALTER TABLE creditos ADD COLUMN com_parque         DECIMAL(15,0) NULL`,
    `ALTER TABLE creditos ADD COLUMN resultado_negocio  DECIMAL(15,2) NULL`,
    `ALTER TABLE creditos ADD COLUMN id_financiera      VARCHAR(30)   NULL`,
    `ALTER TABLE creditos ADD COLUMN nombre_local       VARCHAR(200)  NULL`,
    `ALTER TABLE creditos ADD COLUMN valor_vehiculo     BIGINT        NULL`,
    `ALTER TABLE creditos ADD COLUMN pie                BIGINT        NULL`,
    `ALTER TABLE creditos ADD COLUMN ingreso_neto_total DECIMAL(15,2) NULL`,
    `ALTER TABLE creditos ADD COLUMN rentab_directo     DECIMAL(15,2) NULL`,
    `ALTER TABLE creditos ADD COLUMN bono_total         DECIMAL(15,2) NULL`,
    `ALTER TABLE creditos ADD COLUMN tasa_piso          DECIMAL(10,6) NULL`,
    `ALTER TABLE creditos ADD COLUMN tasfin_pizarra     DECIMAL(10,6) NULL`,
    `ALTER TABLE creditos ADD COLUMN com_reparaciones   DECIMAL(15,0) NULL`,
  ];
  for (const sql of extra) {
    try { await pool.query(sql); } catch (e) { if (e.errno !== 1060) console.error('[carga-masiva migration]', e.message); }
  }
  // Índice único en id_financiera para evitar duplicados futuros
  try {
    await pool.query(`ALTER TABLE creditos ADD UNIQUE INDEX uq_id_financiera (id_financiera)`);
  } catch (e) { /* ya existe o id_financiera es null en viejos registros — ignorar */ }
  // Índice único en num_op (clave de negocio real): dedup correcto en recargas —
  // el ON DUPLICATE KEY UPDATE actualiza la operación existente en vez de duplicarla.
  try {
    await pool.query(`ALTER TABLE creditos ADD UNIQUE INDEX uq_num_op (num_op)`);
  } catch (e) { /* ya existe o hay num_op duplicados legacy — ignorar */ }
});

/* ── Normaliza un valor del Excel ──────────────────────────────────────── */
function norm(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s.toUpperCase() === 'NO APLICA' || s === '0' && false) return null;
  return s;
}
function normRut(v) {
  const s = norm(v);
  if (!s) return null;
  return RUT.normalizar(s) || s.replace(/\./g, '').toUpperCase();
}
function normNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;   // celda numérica del Excel: usar tal cual
  let s = String(v).trim();
  if (!s || s.toUpperCase() === 'NO APLICA') return null;
  s = s.replace(/%/g, '').trim();
  // Formato chileno: coma = decimal, punto = miles. Con coma presente, ese es el
  // separador decimal ("100,00" → 100.00, no 10000). Sin coma pero varios puntos = miles.
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}
function normDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || s.toUpperCase() === 'NO APLICA') return null;
  // Excel serial numbers
  if (/^\d{5}$/.test(s)) {
    const d = XLSX.SSF.parse_date_code(parseInt(s));
    return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  // Already string date
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function normInt(v) {
  const n = normNum(v);
  return n !== null ? Math.round(n) : null;
}

/* ── Mapea fila del Excel a objeto DB ──────────────────────────────────── */
// Resuelve el nombre real de una columna (tolerante a espacios y case)
function resolveCol(row, ...candidates) {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const found = keys.find(k => k.trim().toUpperCase() === c.trim().toUpperCase());
    if (found !== undefined) return found;
  }
  return candidates[0]; // fallback
}
function getCol(row, ...candidates) { return row[resolveCol(row, ...candidates)]; }

// Tasas mensuales van en escala porcentaje (2.8 = 2,8%) en toda la app. Si el Excel
// trae la celda con formato "%" (INDEXA), el valor crudo llega como fracción (0.028);
// se detecta (< 1, imposible como tasa mensual real) y se normaliza a porcentaje.
function normPct(v) {
  if (v === null || v === undefined) return null;
  return (v > 0 && v < 1) ? v * 100 : v;
}

function mapRow(row, mesOverride) {
  const n = (...cols) => normNum(getCol(row, ...cols));
  const pct = (...cols) => normPct(normNum(getCol(row, ...cols)));
  const s = (...cols) => { const v = norm(getCol(row, ...cols)); return (v && v.toUpperCase() !== 'NO APLICA') ? v : null; };
  const d = (...cols) => normDate(getCol(row, ...cols));
  const i = (...cols) => normInt(getCol(row, ...cols));

  // FECHA OTORGADO real del Excel (INDEXA no admite fechas pasadas: en migraciones
  // estampa "hoy" como placeholder, por lo que su mes NO es confiable — el período
  // contable REAL viene en la columna MES ("ene-25"). Regla de negocio: MES manda.
  const fOtorgRaw = normDate(getCol(row, 'FECHA OTORGADO'));
  const mesTxt = parseMesTxt(getCol(row, 'MES'));  // motor único shared/utils/mes-excel.js
  return {
    num_op:             i('OP'),
    // mes: prioridad 1) Mes contable elegido en la UI (archivo de UN mes),
    // 2) columna MES del Excel (período contable real — MANDA sobre la fecha),
    // 3) mes de FECHA OTORGADO como último recurso.
    mes: mesOverride
      ? (mesOverride.slice(0, 7) + '-01')
      : (mesTxt || ((fOtorgRaw && fOtorgRaw !== 'NO APLICA') ? fOtorgRaw.slice(0, 7) + '-01' : null)),
    rut_cliente:        normRut(getCol(row, 'RUT')),
    nombre_cliente:     s('NOMBRE'),
    comentarios:        s('COMENTARIOS'),
    ejecutivo:          s('EJ.COMERCIAL'),
    financiera:         s('FINANCIERA') || s('Institución','INSTITUCION','INSTITUCIÓN') || 'NO APLICA',
    automotora:         s('AUTOMOTORA'),
    nombre_local:       s('NOMBRE LOCAL'),
    // estado_eval (lo que clasifica el dashboard: OTORGADA/APROBADA/RECHAZADA) se
    // deriva de ESTADO CREDITO, NO de la columna de riesgo — igual que carga-trinidad.
    // ESTADO CREDITO es la fuente autoritativa del estado comercial de la operación.
    estado_eval:        (s('ESTADO CREDITO', 'ESTADO CRÉDITO') || '').toUpperCase() || null,
    estado_credito:     s('ESTADO CREDITO', 'ESTADO CRÉDITO'),
    // fecha_estado (FECHA ESTADO del Excel): el dashboard Historia deriva de aquí el
    // día del mes y día de la semana (INGRESADOS/OTORGADOS por día). Sin ella, esos
    // informes quedan vacíos y todo cae en "4ª Semana".
    fecha_estado:       d('FECHA ESTADO', 'FECHA EV'),
    // fecha_otorgado: si el día real cae en el mismo mes que "Mes contable", se respeta;
    // si no (placeholder de INDEXA en otro mes), se usa el último día del mes contable.
    fecha_otorgado: (() => {
      if (mesOverride && (!fOtorgRaw || fOtorgRaw.slice(0, 7) !== mesOverride.slice(0, 7))) {
        // Comodín = DÍA 01 del mes contable (misma convención de la columna `mes`).
        // Antes era el último día: con el mes EN CURSO el 31 aún era futuro y el
        // filtro anti-futuras botaba toda la carga.
        return mesOverride.slice(0, 7) + '-01';
      }
      return fOtorgRaw;
    })(),
    producto:           s('PRODUCTO'),
    valor_vehiculo:     i('VALOR VEHICULO', 'VALOR VEHÍCULO'),
    pie:                i('PIE'),
    saldo_precio:       i('SALDO PRECIO'),
    // % FINANCIADO: el archivo mezcla fracción (0,60) y texto porcentaje ("100,00%").
    // Se normaliza a fracción (0-1): si el valor > 1,5 es un porcentaje → /100.
    pct_financiado:     (() => { let v = n('% FINANCIADO'); if (v != null && v > 1.5) v = v / 100; return v; })(),
    impuesto:           i('IMPUESTO'),
    estado_impuesto:    s('ESTADO IMPTO', 'ESTADO IMPUESTO'),
    gastos:             i('GASTOS'),
    seguro_rdh:         i('SEGURO RDH+E', 'SEGURO RDH'),
    seguro_cesantia:    i('SEG.CESANTIA', 'SEG. CESANTIA', 'SEGURO CESANTIA'),
    seguro_rep_menor:   i('SEG. REP MENOR', 'SEG.REP MENOR', 'SEG. REP. MENOR'),
    monto_financiado:   i('MONTO FINANCIADO INDEXA'),
    tascli_real:        pct('TASCLI REAL'),
    tascli_pizarra:     pct('TASCLI PIZARRA'),
    tasfin_pizarra:     n('TASFIN PIZARRA'),
    comdea_real:        i('COMDEA $ REAL'),
    comej:              i('COMEJ $'),
    monto_comision_fin: i('RENTABILIDAD AUTOFACIL DIRECTO'),
    plazo:              i('PLAZO'),
    parque:             s('PARQUE') || 'NO APLICA',
    ingreso_neto_total: n('INGRESO NETO TOTAL AF'),
    resultado_negocio:  s('RESULTADO NEGOCIO'),  // texto GANANCIA/PÉRDIDA (varchar), no número
    comision_seguro:    i('COMISION SEGURO'),
    gps:                i('GPS'),
    // Seguimiento de comisión dealer (se llena en la app a futuro; aquí para el histórico)
    estado_com_dealer:  s('ESTADO DE COM DEALER'),
    estado_pago_com:    s('ESTADO PAGO COM'),
    nro_factura_com_dea:s('N° FACTURA COM DEA.', 'N FACTURA COM DEA', 'N° FACTURA COM DEA'),
    fecha_estim_pago_comaf: d('FECHA ESTIM. DE PAGO COMAF'),
    fecha_pago_com_dealer:  d('FECHA DE PAGO COMISION DEALER'),
    fecha_recep_doc:    d('FECHA RECEPCION DOCUMENTO'),
    mayor_menor:        s('MAYOR/MENOR'),
    monto_capitalizado: i('MONTO CAPITALIZADO'),
    fecha_primera_cuota:d('FECHA PRIMERA CUOTA'),
    // "0" = sin número de financiera (placeholder INDEXA); se guarda NULL para que
    // NO colisione en el índice único uq_id_financiera (si no, todas las "0" se pisan).
    id_financiera:      (() => { const v = s('ID FINANCIERA'); return (v && v !== '0') ? v : null; })(),
    rut_dealer:         RUT.normalizar(s('RUT DEALER')) || s('RUT DEALER'),
    com_rdh:            i('COM.RDH'),
    com_cesantia:       i('COM.CESANTIA'),
    com_reparaciones:   i('COM.REPARACIONES'),
    com_parque:         i('COM PARQUE'),
    // Post Venta (v150.3): estado del saldo precio y del pago de comisión — además de
    // guardarse en creditos, marcan las etapas del seguimiento Post Venta al importar.
    estado_sp:          s('ESTADO SP', 'ESTADO SALDO PRECIO'),
    fecha_pago_sp:      d('FECHA PAGO SALDO PRECIO', 'FECHA PAGO SP'),
    // columnas auxiliares (no van a creditos: se usan para las etapas y la factura)
    _fecha_fundante:    d('FECHA FUNDANTE', 'FECHA FUNDANTES'),
    _fecha_factura:     d('FECHA FACTURA', 'FECHA FACTURA COM', 'FECHA RECEPCION DOCUMENTO', 'FECHA RECEPCIÓN DOCUMENTO'),
    _fecha_pago_com:    d('FECHA PAGO COMISION', 'FECHA PAGO COMISIÓN', 'FECHA DE PAGO COMISION DEALER'),
    _nro_factura:       s('N° FACTURA O BOLETA', 'N FACTURA O BOLETA', 'N° FACTURA COM DEA.', 'N FACTURA COM DEA'),
  };
}

/* ── Post Venta desde la carga (v150.3): con las columnas de estado SP / fundantes /
   comisión del Excel, crea el seguimiento si falta (solo OTORGADOS, igual que el sync)
   y marca las etapas: FUNDANTES RECIBIDOS, SALDO PRECIO PAGADO, FACTURA RECIBIDA
   (+ registro en postventa_facturas_comision) y COMISION PAGADA. Idempotente. ── */
async function marcarPostventaDesdeCarga(objs) {
  const conDatos = objs.filter(o => o.num_op && (o._fecha_fundante || o.estado_sp || o._fecha_factura || o._nro_factura || o._fecha_pago_com || o.estado_pago_com));
  if (!conDatos.length) return 0;
  const ops = [...new Set(conDatos.map(o => o.num_op))];
  // Seguimiento + etapas base para estos créditos (mismas queries del sync de Post Venta)
  await pool.query(`
    INSERT INTO postventa_seguimiento (id_credito, num_op, financiera, nombre_dealer, ejecutivo, fecha_otorgado, saldo_precio, comision)
    SELECT c.id, c.num_op, c.financiera, c.automotora, c.ejecutivo, DATE(c.fecha_otorgado), c.saldo_precio, c.comdea_real
    FROM creditos c
    WHERE c.num_op IN (?) AND c.fecha_otorgado IS NOT NULL AND c.estado_credito='OTORGADO'
      AND NOT EXISTS (SELECT 1 FROM postventa_seguimiento s WHERE s.id_credito = c.id)`, [ops]).catch(() => {});
  for (const [track, etapa] of [['SALDO', 'FUNDANTES PENDIENTES'], ['COMISION', 'COMISION A PAGAR']]) {
    await pool.query(`
      INSERT INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
      SELECT s.id, ?, ?, 'Sistema', COALESCE(s.fecha_otorgado, NOW())
      FROM postventa_seguimiento s WHERE s.num_op IN (?)
        AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track=? AND e.etapa=?)`,
      [track, etapa, ops, track, etapa]).catch(() => {});
  }
  const [segs] = await pool.query('SELECT id, num_op, rut_dealer, nombre_dealer FROM postventa_seguimiento WHERE num_op IN (?)', [ops]);
  const porOp = new Map(segs.map(s => [Number(s.num_op), s]));
  let marcados = 0;
  const marcar = (idSeg, track, etapa, fecha) => pool.query(
    `INSERT INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
     SELECT ?,?,?,?,COALESCE(?, NOW()) FROM DUAL WHERE NOT EXISTS
       (SELECT 1 FROM postventa_etapas WHERE id_seguimiento=? AND track=? AND etapa=?)`,
    [idSeg, track, etapa, 'Carga Masiva', fecha, idSeg, track, etapa]).catch(() => {});
  for (const o of conDatos) {
    const seg = porOp.get(Number(o.num_op)); if (!seg) continue;
    if (o._fecha_fundante) await marcar(seg.id, 'SALDO', 'FUNDANTES RECIBIDOS', o._fecha_fundante);
    if (String(o.estado_sp || '').toUpperCase() === 'PAGADO')
      await marcar(seg.id, 'SALDO', 'SALDO PRECIO PAGADO', o.fecha_pago_sp || o._fecha_fundante);
    if (o._fecha_factura || o._nro_factura) {
      await marcar(seg.id, 'COMISION', 'FACTURA RECIBIDA', o._fecha_factura);
      if (o._nro_factura) await pool.query(
        `INSERT INTO postventa_facturas_comision (id_seguimiento, num_op, rut_dealer, nombre_dealer, fecha_factura, numero_factura, monto_bruto, usuario)
         SELECT ?,?,?,?,?,?,?, 'Carga Masiva' FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM postventa_facturas_comision WHERE id_seguimiento=?)`,
        [seg.id, o.num_op, seg.rut_dealer || o.rut_dealer || null, seg.nombre_dealer || o.automotora || null,
         o._fecha_factura || null, o._nro_factura, o.comdea_real || null, seg.id]).catch(() => {});
    }
    if (String(o.estado_pago_com || '').toUpperCase() === 'PAGADO' || o._fecha_pago_com)
      await marcar(seg.id, 'COMISION', 'COMISION PAGADA', o._fecha_pago_com || o._fecha_factura);
    marcados++;
  }
  return marcados;
}

/* ── Helpers de búsqueda de columnas en el Excel ─────────────────────────── */
function detectarCols(data) {
  const keys = Object.keys(data[0]);
  const find  = (...names) => keys.find(k => names.some(n => k.trim().toUpperCase() === n.toUpperCase())) || names[0];
  return {
    colOP:      find('OP'),
    colIdFin:   find('ID FINANCIERA'),
    colEstado:  find('ESTADO CREDITO', 'ESTADO CRÉDITO'),
    colNombre:  find('NOMBRE'),
    colProducto:find('PRODUCTO'),
    colFin:     find('FINANCIERA'),
    colMonto:   find('MONTO FINANCIADO INDEXA', 'MONTO FINANCIADO'),
    colFechaOtorg: find('FECHA OTORGADO'),
  };
}

/* Retorna Set de id_financiera existentes en BD para los valores del Excel */
async function getExistentes(ids) {
  const set = new Set();
  if (!ids.length) return set;
  const chunkSize = 500;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const [rows] = await pool.query(
      `SELECT id_financiera FROM creditos WHERE id_financiera IN (${chunk.map(()=>'?').join(',')})`,
      chunk
    );
    rows.forEach(r => set.add(String(r.id_financiera)));
  }
  return set;
}

/* Map id_financiera → num_op del crédito que ya lo tiene (para detectar que la
   operación YA fue digitada por otra vía — carta de aprobación o digitación manual). */
async function getDuenosIdFin(ids) {
  const map = new Map();
  if (!ids.length) return map;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const [rows] = await pool.query(
      `SELECT id_financiera, num_op, numero_credito FROM creditos WHERE id_financiera IN (${chunk.map(()=>'?').join(',')})`,
      chunk);
    rows.forEach(r => map.set(String(r.id_financiera), r.num_op ?? r.numero_credito));
  }
  return map;
}

/* ── POST /api/carga-masiva/preview ─────────────────────────────────────── */
const preview = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, data: null, error: 'No se recibió archivo' });

    const data = leerFilasExcel(req.file.buffer);

    if (!data.length) return res.status(400).json({ success: false, data: null, error: 'Archivo vacío' });

    const { colOP, colIdFin, colEstado, colNombre, colProducto, colFin, colMonto, colFechaOtorg } = detectarCols(data);

    // Llave: ID FINANCIERA
    const ids = data.map(r => String(r[colIdFin] || '').trim()).filter(v => v && v !== '' && v.toUpperCase() !== 'NO APLICA');
    if (!ids.length) return res.status(400).json({ success: false, data: null, error: `No se encontró la columna "ID FINANCIERA" en el archivo. Columnas detectadas: ${Object.keys(data[0]).slice(0,8).join(', ')}` });

    const setExistentes = await getExistentes(ids);

    const resumen = {
      total:      data.length,
      nuevos:     data.filter(r => !setExistentes.has(String(r[colIdFin]||'').trim())).length,
      existentes: setExistentes.size,
      otorgados:  data.filter(r => (r[colEstado]||'').toString().toUpperCase() === 'OTORGADO').length,
      // Filas con fecha de otorgamiento futura → serán OMITIDAS al importar
      futuros:    data.filter(r => esFechaFutura(normDate(r[colFechaOtorg]))).length,
    };

    // Vista previa: primeras 10 nuevas
    const previw = data
      .filter(r => !setExistentes.has(String(r[colIdFin]||'').trim()))
      .slice(0, 10)
      .map(r => ({
        op:          r[colOP],
        id_financiera: r[colIdFin],
        nombre:      r[colNombre],
        estado:      r[colEstado],
        producto:    r[colProducto],
        financiera:  r[colFin],
        monto:       r[colMonto],
      }));

    res.json({ success: true, data: { resumen, preview: previw }, error: null });
  } catch (e) {
    console.error('[preview]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── POST /api/carga-masiva/importar ───────────────────────────────────── */
const importar = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, data: null, error: 'No se recibió archivo' });

    const data = leerFilasExcel(req.file.buffer);

    const { colOP, colIdFin } = detectarCols(data);

    // Llave de deduplicación: ID FINANCIERA (solo para el conteo en el resumen)
    const ids = data.map(r => String(r[colIdFin] || '').trim()).filter(v => v && v.toUpperCase() !== 'NO APLICA');
    const setExistentes = await getExistentes(ids);

    // Todos los registros se procesan — el upsert decide insert o update
    const mesOverride = req.body.mes_override || null;

    const duenosIdFin = await getDuenosIdFin(ids);   // ID financiera → num_op ya digitado

    let insertados = 0;
    let omitidosFuturo = 0;   // filas saltadas por fecha futura
    let omitidosYaDigitados = 0;   // ID financiera ya ingresado en otra operación
    const auxPostventa = [];  // columnas de saldo precio / fundantes / comisión → etapas Post Venta
    let errores    = [];
    const clienteCache   = {};
    const detallesLog    = [];   // para log historial
    const objsInsertados = [];   // objetos YA mapeados (mes/fecha_otorgado normalizados) para el recálculo

    for (const row of data) {
      try {
        const obj = mapRow(row, mesOverride);
        if (!obj.num_op) continue;

        // Restricción: no cargar créditos con fecha (otorgamiento/mes) futura
        if (esFechaFutura(obj.fecha_otorgado) || esFechaFutura(obj.mes)) {
          omitidosFuturo++;
          errores.push({ op: obj.num_op, error: `Omitido: fecha futura (${obj.fecha_otorgado || obj.mes})` });
          continue;
        }

        // Regla (2026-07-23): ID de la financiera ÚNICO — si ya está digitado en OTRA
        // operación (carta de aprobación o digitación manual), la fila queda fuera.
        // Misma operación (mismo num_op) sí se actualiza (re-cargas de estados).
        if (obj.id_financiera && duenosIdFin.has(String(obj.id_financiera))
            && String(duenosIdFin.get(String(obj.id_financiera))) !== String(obj.num_op)) {
          let dueno = duenosIdFin.get(String(obj.id_financiera));
          omitidosYaDigitados++;
          // Regla (2026-07-23): el N° INDEXA manda. Si el crédito dueño tiene número
          // NUESTRO (generado por carta: formato YYMM###) y el Excel trae el N° oficial,
          // se renumera al de INDEXA (crédito + Post Venta + carta enlazada).
          try {
            if (/^\d{2}(0[1-9]|1[0-2])\d{3}$/.test(String(dueno)) && obj.num_op &&
                !/^\d{2}(0[1-9]|1[0-2])\d{3}$/.test(String(obj.num_op))) {
              const [[ya]] = await pool.query('SELECT id FROM creditos WHERE num_op=? LIMIT 1', [obj.num_op]);
              if (!ya) {
                await pool.query('UPDATE creditos SET num_op=? WHERE num_op=? AND id_financiera=?', [obj.num_op, dueno, obj.id_financiera]);
                await pool.query('UPDATE postventa_seguimiento s JOIN creditos c ON c.id=s.id_credito SET s.num_op=? WHERE c.num_op=?', [obj.num_op, obj.num_op]).catch(() => {});
                await pool.query('UPDATE cartas_aprobacion ca JOIN creditos c ON c.id=ca.id_credito_creado SET ca.numero_credito_creado=? WHERE c.num_op=?', [String(obj.num_op), obj.num_op]).catch(() => {});
                errores.push({ op: obj.num_op, error: `Renumerado: crédito ${dueno} → N° INDEXA ${obj.num_op} (mismo ID financiera ${obj.id_financiera})` });
                dueno = obj.num_op;
              }
            }
          } catch (e) { console.error('[carga-masiva renumerar]', e.message); }
          // La fila NO se inserta, pero sí COMPLETA los campos vacíos del crédito ya
          // digitado (COALESCE: nunca pisa lo existente) — primas, gastos, fechas, etc.
          // que la carta de aprobación no trae pero el Excel sí.
          try {
            const ENRIQUECIBLES = ['seguro_rdh','seguro_cesantia','seguro_rep_menor','gastos','gps','comision_seguro',
              'valor_vehiculo','pie','saldo_precio','pct_financiado','monto_financiado','plazo','tascli_real',
              'comdea_real','comej','monto_comision_fin','com_rdh','com_cesantia','com_reparaciones','com_parque',
              'fecha_primera_cuota','fecha_estado','estado_sp','fecha_pago_sp','fecha_recep_doc','vendedor','producto'];
            const setCols = ENRIQUECIBLES.filter(c => obj[c] !== undefined && obj[c] !== null);
            if (setCols.length) {
              await pool.query(
                `UPDATE creditos SET ${setCols.map(c => `\`${c}\` = COALESCE(\`${c}\`, ?)`).join(', ')} WHERE num_op = ?`,
                [...setCols.map(c => obj[c]), dueno]);
            }
            // Post Venta del crédito dueño (etapas por estado SP / fundantes / comisión)
            auxPostventa.push({ num_op: dueno, estado_sp: obj.estado_sp, fecha_pago_sp: obj.fecha_pago_sp,
              estado_pago_com: obj.estado_pago_com, comdea_real: obj.comdea_real, rut_dealer: obj.rut_dealer,
              automotora: obj.automotora, _fecha_fundante: obj._fecha_fundante, _fecha_factura: obj._fecha_factura,
              _fecha_pago_com: obj._fecha_pago_com, _nro_factura: obj._nro_factura });
          } catch (e) { console.error('[carga-masiva completar dueño]', e.message); }
          errores.push({ op: obj.num_op, error: `Omitido: ID financiera ${obj.id_financiera} ya digitado (crédito ${dueno}) — se completaron sus campos vacíos` });
          continue;
        }

        // ── Resolver id_cliente ──────────────────────────────────────────
        if (obj.rut_cliente) {
          if (clienteCache[obj.rut_cliente] === undefined) {
            const [[cl]] = await pool.query(
              'SELECT id_cliente FROM clientes WHERE rut = ?',
              [obj.rut_cliente]
            );
            if (cl) {
              clienteCache[obj.rut_cliente] = cl.id_cliente;
            } else {
              // Crear cliente nuevo en la tabla clientes
              const nombreCompleto = obj.nombre_cliente || null;
              const [ins] = await pool.query(
                `INSERT INTO clientes (rut, nombre_completo) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE id_cliente = LAST_INSERT_ID(id_cliente)`,
                [obj.rut_cliente, nombreCompleto]
              );
              clienteCache[obj.rut_cliente] = ins.insertId;
            }
          }
          obj.id_cliente = clienteCache[obj.rut_cliente] || null;
        }

        // rut_cliente y nombre_cliente pertenecen a la tabla clientes, no a creditos.
        // Se usaron para resolver id_cliente — eliminarlos para evitar error de columna inexistente.
        delete obj.rut_cliente;
        delete obj.nombre_cliente;
        // Auxiliares Post Venta (no son columnas de creditos): apartar para marcar etapas al final
        auxPostventa.push({ num_op: obj.num_op, estado_sp: obj.estado_sp, fecha_pago_sp: obj.fecha_pago_sp,
          estado_pago_com: obj.estado_pago_com, comdea_real: obj.comdea_real, rut_dealer: obj.rut_dealer,
          automotora: obj.automotora, _fecha_fundante: obj._fecha_fundante, _fecha_factura: obj._fecha_factura,
          _fecha_pago_com: obj._fecha_pago_com, _nro_factura: obj._nro_factura });
        delete obj._fecha_fundante; delete obj._fecha_factura; delete obj._fecha_pago_com; delete obj._nro_factura;

        const cols   = Object.keys(obj).filter(k => obj[k] !== undefined && obj[k] !== null);
        const vals   = cols.map(k => obj[k]);
        const placeholders = cols.map(() => '?').join(',');
        // ON DUPLICATE KEY UPDATE — si ya existe (num_op+mes+financiera), actualiza en vez de fallar.
        // ANTI-DEGRADACIÓN (2026-07-23): un crédito OTORGADO en el sistema NO retrocede a un
        // estado anterior por una base atrasada (la carta se otorgó aquí antes de que INDEXA
        // exporte el estado nuevo). Solo ANULADO/PREPAGADO pueden pisar un OTORGADO.
        const updateCols = cols.filter(k => !['num_op','mes','financiera'].includes(k));
        const updateSet  = updateCols.map(k => {
          if (k === 'estado_credito' || k === 'estado_eval' || k === 'estado')
            return `\`${k}\` = CASE WHEN creditos.estado_credito='OTORGADO'
                      AND UPPER(COALESCE(VALUES(estado_credito),'')) NOT IN ('OTORGADO','ANULADO','PREPAGADO')
                      THEN \`${k}\` ELSE VALUES(\`${k}\`) END`;
          return `\`${k}\` = VALUES(\`${k}\`)`;
        }).join(', ');

        await pool.query(
          `INSERT INTO creditos (${cols.map(k=>`\`${k}\``).join(',')}) VALUES (${placeholders})
           ON DUPLICATE KEY UPDATE ${updateSet}`,
          vals
        );
        insertados++;
        detallesLog.push({ num_op: obj.num_op, datos: obj });
        objsInsertados.push(obj);
      } catch (e) {
        errores.push({ op: row['OP'], error: e.message });
      }
    }

    // ── Completar rut_dealer faltante por nombre (migración: el Excel de INDEXA
    //    no trae RUT dealer, solo el nombre en `automotora`, a veces con prefijo
    //    "PARQUE X " concatenado). Match SOLO si es único e inequívoco contra
    //    dealers.nombre_indexa — si hay 0 o >1 candidato, se deja intacto para
    //    que quede en la cola de Digitación Datos Faltantes. ──
    if (insertados > 0) {
      try {
        // Caso especial: ventas directas de AutoFácil
        await pool.query(
          `UPDATE creditos c JOIN dealers d ON d.nombre_indexa = 'AFA'
              SET c.rut_dealer = d.rut
            WHERE (c.rut_dealer IS NULL OR c.rut_dealer = '')
              AND UPPER(TRIM(c.automotora)) = 'AUTOFACIL DIRECTO'`);
        // Match único por substring (automotora contiene el nombre_indexa del dealer)
        await pool.query(
          `UPDATE creditos c
              SET c.rut_dealer = (
                SELECT d.rut FROM dealers d
                 WHERE d.nombre_indexa IS NOT NULL AND d.nombre_indexa <> ''
                   AND UPPER(TRIM(c.automotora)) LIKE CONCAT('%', UPPER(TRIM(d.nombre_indexa)), '%')
              )
            WHERE (c.rut_dealer IS NULL OR c.rut_dealer = '' OR UPPER(c.rut_dealer) = 'S/I')
              AND c.automotora IS NOT NULL AND c.automotora <> ''
              AND (SELECT COUNT(*) FROM dealers d
                    WHERE d.nombre_indexa IS NOT NULL AND d.nombre_indexa <> ''
                      AND UPPER(TRIM(c.automotora)) LIKE CONCAT('%', UPPER(TRIM(d.nombre_indexa)), '%')) = 1`);
        // Homologar el NOMBRE al del mantenedor de dealers (una sola fuente): el Excel
        // de INDEXA concatena "PARQUE X " antes del nombre — si el crédito quedó ligado
        // al dealer y su automotora contiene el nombre oficial, se reemplaza por este.
        await pool.query(
          `UPDATE creditos c JOIN dealers d ON d.rut = c.rut_dealer
              SET c.automotora = d.nombre_indexa
            WHERE d.nombre_indexa IS NOT NULL AND d.nombre_indexa <> ''
              AND UPPER(TRIM(c.automotora)) <> UPPER(TRIM(d.nombre_indexa))
              AND UPPER(TRIM(c.automotora)) LIKE CONCAT('%', UPPER(TRIM(d.nombre_indexa)), '%')`);
        // Parque/Calle: si la columna parque trae un nombre real de parque → PARQUE
        await pool.query(
          `UPDATE creditos SET tipo_ubicacion='PARQUE'
            WHERE (tipo_ubicacion IS NULL OR tipo_ubicacion='') AND parque IS NOT NULL
              AND UPPER(TRIM(parque)) NOT IN ('','NO APLICA','S/I','CALLE')`);
      } catch (e) { console.error('[carga-masiva match dealer por nombre]', e.message); }
    }

    // ── Enganchar id_dealer al maestro por RUT (los créditos nacen ligados a la tabla
    //    `dealers`, no por el nombre). El match dealer↔crédito de postventa/órdenes usa
    //    id_dealer. Idempotente: solo rellena los que están sin enganche. ──
    if (insertados > 0) {
      try {
        await pool.query(
          `UPDATE creditos c JOIN dealers d ON d.rut = c.rut_dealer
              SET c.id_dealer = d.id_dealer
            WHERE (c.id_dealer IS NULL OR c.id_dealer = 0)
              AND c.rut_dealer IS NOT NULL AND c.rut_dealer <> ''`);
      } catch (e) { console.error('[carga-masiva id_dealer]', e.message); }
    }

    // ── Post Venta: estado saldo precio / fundantes / comisión del Excel → etapas ──
    let postventaMarcados = 0;
    if (insertados > 0 || auxPostventa.length) {
      try { postventaMarcados = await marcarPostventaDesdeCarga(auxPostventa); }
      catch (e) { console.error('[carga-masiva postventa]', e.message); }
    }

    // ── Recálculo completo de comisiones para todos los meses afectados ──
    // Incluye: monto_comision_fin, comdea_real, com_parque, arriendo_parque,
    //          com_rdh/cesantia/reparaciones, ingreso_neto_total
    // Para UNIDAD recalcula TODAS las ops del mes si cambia el tier.
    let recalculados = 0;
    let recalcLog    = [];
    if (insertados > 0) {
      try {
        const mesesAfectados = extraerMeses(objsInsertados);
        const resultado = await recalcularMeses(mesesAfectados);
        recalculados = resultado.actualizados;
        recalcLog    = resultado.log;
        console.log('[recalcular-mes]', recalcLog.join(' | '));
      } catch (e) {
        console.error('[recalcular-mes]', e.message);
      }
    }

    // ── Guardar en historial (sin bloquear la respuesta) ───────────
    if (insertados > 0) {
      historial.crearSesion({
        fuente:     'autofacil',
        usuario:    req.user?.nombre || req.user?.email || null,
        archivo:    req.file?.originalname || null,
        insertados, actualizados: 0, errores: errores.length,
        total:      data.length,
      }).then(sesionId => {
        for (const d of detallesLog) {
          historial.logDetalle(sesionId, d.num_op, 'insert', d.datos).catch(() => {});
        }
      }).catch(() => {});
    }

    auditar({ req, accion: 'CARGA_MASIVA', modulo: 'creditos', entidad: 'carga', entidad_id: req.file?.originalname || null,
      detalle: `Carga masiva AutoFácil: ${insertados} operación(es) insertada(s) de ${data.length} del archivo${omitidosFuturo ? ` · ${omitidosFuturo} omitida(s) por fecha futura` : ''}${omitidosYaDigitados ? ` · ${omitidosYaDigitados} omitida(s) por ID financiera ya digitado` : ''}${errores.length ? ` · ${errores.length} con error` : ''}`,
      meta: { insertados, total: data.length, errores: errores.length, omitidos_futuro: omitidosFuturo, omitidos_ya_digitados: omitidosYaDigitados, recalculados } });
    res.json({
      success: true,
      data: {
        total_archivo:     data.length,
        ya_existentes:     setExistentes.size,
        nuevos_intentados: data.length,
        insertados,
        omitidos_futuro:   omitidosFuturo,
        omitidos_ya_digitados: omitidosYaDigitados,
        postventa_marcados: postventaMarcados,
        recalculados_comisiones: recalculados,
        errores,
      },
      error: null,
    });
  } catch (e) {
    console.error('[importar]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── POST /api/carga-masiva/eliminar-por-ops ──────────────────────────────
   Elimina registros por lista de num_op. Solo Administrador.
   Body: { ops: [88169, 88170, ...] }
   ─────────────────────────────────────────────────────────────────────── */
const eliminarPorOps = async (req, res) => {
  try {
    const { ops } = req.body || {};
    if (!Array.isArray(ops) || !ops.length) {
      return res.status(400).json({ success: false, data: null, error: 'Se requiere array ops[]' });
    }
    const nums = ops.map(o => parseInt(o)).filter(n => !isNaN(n) && n > 0);
    if (!nums.length) return res.status(400).json({ success: false, data: null, error: 'No hay OPs válidas' });

    const chunkSize = 500;
    let eliminados = 0;
    for (let i = 0; i < nums.length; i += chunkSize) {
      const chunk = nums.slice(i, i + chunkSize);
      const [result] = await pool.query(
        `DELETE FROM creditos WHERE num_op IN (${chunk.map(() => '?').join(',')})`,
        chunk
      );
      eliminados += result.affectedRows;
    }
    auditar({ req, accion: 'ELIMINAR', modulo: 'creditos', entidad: 'credito', entidad_id: nums.length === 1 ? nums[0] : `${nums.length} ops`,
      detalle: `Eliminación masiva: ${eliminados} crédito(s) borrado(s) por N° de operación` + (nums.length <= 20 ? ` (${nums.join(', ')})` : ` (${nums.length} ops)`),
      meta: { ops: nums, eliminados } });
    res.json({ success: true, data: { eliminados }, error: null });
  } catch (e) {
    console.error('[eliminarPorOps]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── POST /api/carga-masiva/corregir-mes ───────────────────────────────── */
// Corrige registros cuyo mes quedó en un mes diferente al esperado
// Body: { mes_incorrecto: '2026-06-01', mes_correcto: '2026-05-01' }
const corregirMes = async (req, res) => {
  try {
    const { mes_incorrecto, mes_correcto } = req.body;
    if (!mes_incorrecto || !mes_correcto) {
      return res.status(400).json({ success: false, data: null, error: 'Faltan parámetros mes_incorrecto y mes_correcto' });
    }
    const mesInc = mes_incorrecto.slice(0, 7); // YYYY-MM
    const mesCor = mes_correcto.slice(0, 7);
    const [result] = await pool.query(
      `UPDATE creditos SET mes = ? WHERE DATE_FORMAT(mes, '%Y-%m') = ?`,
      [mesCor + '-01', mesInc]
    );
    auditar({ req, accion: 'EDITAR', modulo: 'creditos', entidad: 'credito', entidad_id: `mes ${mesInc}`,
      detalle: `Corrigió el mes de ${result.affectedRows} crédito(s): ${mesInc} → ${mesCor}`,
      meta: { mes_incorrecto: mesInc, mes_correcto: mesCor, afectados: result.affectedRows } });
    res.json({ success: true, data: { afectados: result.affectedRows }, error: null });
  } catch (e) {
    console.error('[corregirMes]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── POST /api/carga-masiva/actualizar ─────────────────────────────────────
   Actualiza registros EXISTENTES con los campos del Excel que estén vacíos en la BD.
   Llave de búsqueda: num_op (OP del Excel).
   NUNCA sobreescribe el campo "ejecutivo".
   Solo escribe campos que estén vacíos/nulos en la BD Y tengan valor en el Excel.
   ─────────────────────────────────────────────────────────────────────────── */
const actualizar = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, data: null, error: 'No se recibió archivo' });

    const data = leerFilasExcel(req.file.buffer);

    if (!data.length) return res.status(400).json({ success: false, data: null, error: 'Archivo vacío' });

    const { colOP, colIdFin } = detectarCols(data);
    const mesOverride = req.body.mes_override || null;

    // Campos que NUNCA se deben sobreescribir (datos gestionados por operaciones)
    const CAMPOS_PROTEGIDOS = new Set([
      'ejecutivo', 'num_op', 'id_credito', 'id_cliente',
      'rut_cliente', 'nombre_cliente',
    ]);

    let actualizados = 0;
    let sinCambios   = 0;
    let noEncontrados = 0;
    const errores    = [];
    const detallesLog = [];

    for (const row of data) {
      const idFin  = String(row[colIdFin] || '').trim();
      const numOp  = parseInt(row[colOP]);

      try {
        // Buscar por id_financiera (llave principal) → fallback a num_op
        let existente;
        if (idFin && idFin.toUpperCase() !== 'NO APLICA') {
          [[existente]] = await pool.query(
            'SELECT * FROM creditos WHERE id_financiera = ?', [idFin]
          );
        }
        if (!existente && !isNaN(numOp) && numOp > 0) {
          [[existente]] = await pool.query(
            'SELECT * FROM creditos WHERE num_op = ?', [numOp]
          );
        }
        if (!existente) { noEncontrados++; continue; }

        // Obtener campos nuevos del Excel
        const obj = mapRow(row, mesOverride);
        delete obj.rut_cliente;
        delete obj.nombre_cliente;

        // Construir SET solo con campos:
        //   1. No protegidos
        //   2. Que tienen valor en el Excel (no null)
        //   3. Que están vacíos/nulos en la BD
        const setCols = [];
        const setVals = [];

        for (const [campo, valorNuevo] of Object.entries(obj)) {
          if (CAMPOS_PROTEGIDOS.has(campo)) continue;
          if (valorNuevo === null || valorNuevo === undefined) continue;
          // Restricción: nunca rellenar fecha de otorgamiento/mes con una fecha futura
          if ((campo === 'fecha_otorgado' || campo === 'mes') && esFechaFutura(valorNuevo)) continue;
          const valorActual = existente[campo];
          const estaVacio = valorActual === null || valorActual === undefined || valorActual === '' || valorActual === 0;
          if (estaVacio) {
            setCols.push(`\`${campo}\` = ?`);
            setVals.push(valorNuevo);
          }
        }

        if (setCols.length === 0) { sinCambios++; continue; }

        // Verificar si el mes de la operación está cerrado
        if (existente.mes) {
          const mesOp = String(existente.mes).slice(0, 7);
          if (await isMesCerrado(mesOp)) {
            errores.push({ num_op: numOp, error: `🔒 Mes ${mesOp} cerrado — omitido` });
            continue;
          }
        }

        setVals.push(numOp);
        await pool.query(
          `UPDATE creditos SET ${setCols.join(', ')} WHERE num_op = ?`,
          setVals
        );
        actualizados++;
        detallesLog.push({ num_op: numOp, campos_actualizados: setCols.length });

      } catch (e) {
        errores.push({ op: numOp, error: e.message });
      }
    }

    // Guardar en historial
    if (actualizados > 0) {
      historial.crearSesion({
        fuente:     'autofacil-update',
        usuario:    req.user?.nombre || req.user?.email || null,
        archivo:    req.file?.originalname || null,
        insertados: 0, actualizados, errores: errores.length,
        total:      data.length,
      }).catch(() => {});
    }

    auditar({ req, accion: 'CARGA_MASIVA', modulo: 'creditos', entidad: 'carga', entidad_id: req.file?.originalname || null,
      detalle: `Actualización masiva: ${actualizados} crédito(s) modificado(s) de ${data.length} del archivo${errores.length ? ` · ${errores.length} con error` : ''}`,
      meta: { actualizados, total: data.length, errores: errores.length } });
    res.json({
      success: true,
      data: {
        total_archivo:  data.length,
        actualizados,
        sin_cambios:    sinCambios,
        no_encontrados: noEncontrados,
        errores,
      },
      error: null,
    });
  } catch (e) {
    console.error('[actualizar]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { preview, importar, corregirMes, actualizar, eliminarPorOps };
