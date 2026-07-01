'use strict';
const pool = require('../../../../shared/config/database');
const XLSX = require('xlsx');
const { recalcularMeses, extraerMeses } = require('../utils/recalcular-mes');
const { isMesCerrado } = require('../../../../shared/utils/mes-cerrado');
const { esFechaFutura } = require('../../../../shared/utils/fecha-futura');
const historial = require('./carga-historial.controller');
const { auditar } = require('../../../../shared/audit');
const RUT = require('../../../../api-gateway/public/js/rut-core');  // enforcement: RUT canónico

/* ── Asegurar columnas extra en creditos ──────────────────── */
(async () => {
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
})();

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
  const s = norm(v);
  if (!s || s.toUpperCase() === 'NO APLICA') return null;
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
/* Último día de un mes 'YYYY-MM' o 'YYYY-MM-DD' → 'YYYY-MM-DD' */
function finDeMes(mesStr) {
  if (!mesStr) return null;
  const [y, m] = mesStr.slice(0, 7).split('-').map(Number);
  const d = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
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

function mapRow(row, mesOverride) {
  const n = (...cols) => normNum(getCol(row, ...cols));
  const s = (...cols) => { const v = norm(getCol(row, ...cols)); return (v && v.toUpperCase() !== 'NO APLICA') ? v : null; };
  const d = (...cols) => normDate(getCol(row, ...cols));
  const i = (...cols) => normInt(getCol(row, ...cols));

  // FECHA OTORGADO real del Excel (INDEXA no admite fechas pasadas: en migraciones
  // estampa "hoy" como placeholder, por lo que su mes NO es confiable si viene
  // "Mes contable" y ese día cae en un mes distinto — ahí manda el mes contable).
  const fOtorgRaw = normDate(getCol(row, 'FECHA OTORGADO'));
  return {
    num_op:             i('OP'),
    // mes: si viene Mes contable, ese manda siempre. Si no, usa el mes de FECHA OTORGADO
    // (o el mes del archivo para APROBADO/RECHAZADO sin fecha real).
    mes: mesOverride
      ? (mesOverride.slice(0, 7) + '-01')
      : ((fOtorgRaw && fOtorgRaw !== 'NO APLICA') ? fOtorgRaw.slice(0, 7) + '-01' : null),
    rut_cliente:        normRut(getCol(row, 'RUT')),
    nombre_cliente:     s('NOMBRE'),
    comentarios:        s('COMENTARIOS'),
    ejecutivo:          s('EJ.COMERCIAL'),
    financiera:         s('FINANCIERA') || s('Institución','INSTITUCION','INSTITUCIÓN') || 'NO APLICA',
    automotora:         s('AUTOMOTORA'),
    nombre_local:       s('NOMBRE LOCAL'),
    estado_eval:        s('ESTADO EVAL. RIESGO', 'ESTADO EVAL RIESGO'),
    estado_credito:     s('ESTADO CREDITO', 'ESTADO CRÉDITO'),
    // fecha_otorgado: si el día real cae en el mismo mes que "Mes contable", se respeta;
    // si no (placeholder de INDEXA en otro mes), se usa el último día del mes contable.
    fecha_otorgado: (() => {
      if (mesOverride && (!fOtorgRaw || fOtorgRaw.slice(0, 7) !== mesOverride.slice(0, 7))) {
        return finDeMes(mesOverride);
      }
      return fOtorgRaw;
    })(),
    producto:           s('PRODUCTO'),
    valor_vehiculo:     i('VALOR VEHICULO', 'VALOR VEHÍCULO'),
    pie:                i('PIE'),
    saldo_precio:       i('SALDO PRECIO'),
    pct_financiado:     n('% FINANCIADO'),
    impuesto:           i('IMPUESTO'),
    estado_impuesto:    s('ESTADO IMPTO', 'ESTADO IMPUESTO'),
    gastos:             i('GASTOS'),
    seguro_rdh:         i('SEGURO RDH+E', 'SEGURO RDH'),
    seguro_cesantia:    i('SEG.CESANTIA', 'SEG. CESANTIA', 'SEGURO CESANTIA'),
    seguro_rep_menor:   i('SEG. REP MENOR', 'SEG.REP MENOR', 'SEG. REP. MENOR'),
    monto_financiado:   i('MONTO FINANCIADO INDEXA'),
    tascli_real:        n('TASCLI REAL'),
    tascli_pizarra:     n('TASCLI PIZARRA'),
    tasfin_pizarra:     n('TASFIN PIZARRA'),
    comdea_real:        i('COMDEA $ REAL'),
    comej:              i('COMEJ $'),
    monto_comision_fin: i('RENTABILIDAD AUTOFACIL DIRECTO'),
    plazo:              i('PLAZO'),
    parque:             s('PARQUE') || 'NO APLICA',
    ingreso_neto_total: n('INGRESO NETO TOTAL AF'),
    resultado_negocio:  n('RESULTADO NEGOCIO'),
    mayor_menor:        s('MAYOR/MENOR'),
    monto_capitalizado: i('MONTO CAPITALIZADO'),
    fecha_primera_cuota:d('FECHA PRIMERA CUOTA'),
    id_financiera:      s('ID FINANCIERA'),
    rut_dealer:         RUT.normalizar(s('RUT DEALER')) || s('RUT DEALER'),
    com_rdh:            i('COM.RDH'),
    com_cesantia:       i('COM.CESANTIA'),
    com_reparaciones:   i('COM.REPARACIONES'),
    com_parque:         i('COM PARQUE'),
  };
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

/* ── POST /api/carga-masiva/preview ─────────────────────────────────────── */
const preview = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, data: null, error: 'No se recibió archivo' });

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

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

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const { colOP, colIdFin } = detectarCols(data);

    // Llave de deduplicación: ID FINANCIERA (solo para el conteo en el resumen)
    const ids = data.map(r => String(r[colIdFin] || '').trim()).filter(v => v && v.toUpperCase() !== 'NO APLICA');
    const setExistentes = await getExistentes(ids);

    // Todos los registros se procesan — el upsert decide insert o update
    const mesOverride = req.body.mes_override || null;

    let insertados = 0;
    let omitidosFuturo = 0;   // filas saltadas por fecha futura
    let errores    = [];
    const clienteCache   = {};
    const detallesLog    = [];   // para log historial

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

        const cols   = Object.keys(obj).filter(k => obj[k] !== undefined && obj[k] !== null);
        const vals   = cols.map(k => obj[k]);
        const placeholders = cols.map(() => '?').join(',');
        // ON DUPLICATE KEY UPDATE — si ya existe (num_op+mes+financiera), actualiza en vez de fallar
        const updateCols = cols.filter(k => !['num_op','mes','financiera'].includes(k));
        const updateSet  = updateCols.map(k => `\`${k}\` = VALUES(\`${k}\`)`).join(', ');

        await pool.query(
          `INSERT INTO creditos (${cols.map(k=>`\`${k}\``).join(',')}) VALUES (${placeholders})
           ON DUPLICATE KEY UPDATE ${updateSet}`,
          vals
        );
        insertados++;
        detallesLog.push({ num_op: obj.num_op, datos: obj });
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
            WHERE (c.rut_dealer IS NULL OR c.rut_dealer = '')
              AND c.automotora IS NOT NULL AND c.automotora <> ''
              AND (SELECT COUNT(*) FROM dealers d
                    WHERE d.nombre_indexa IS NOT NULL AND d.nombre_indexa <> ''
                      AND UPPER(TRIM(c.automotora)) LIKE CONCAT('%', UPPER(TRIM(d.nombre_indexa)), '%')) = 1`);
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

    // ── Recálculo completo de comisiones para todos los meses afectados ──
    // Incluye: monto_comision_fin, comdea_real, com_parque, arriendo_parque,
    //          com_rdh/cesantia/reparaciones, ingreso_neto_total
    // Para UNIDAD recalcula TODAS las ops del mes si cambia el tier.
    let recalculados = 0;
    let recalcLog    = [];
    if (insertados > 0) {
      try {
        const mesesAfectados = extraerMeses(data.map(r => ({ mes: r.mes || r.fecha_otorgado })));
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
      detalle: `Carga masiva AutoFácil: ${insertados} operación(es) insertada(s) de ${data.length} del archivo${omitidosFuturo ? ` · ${omitidosFuturo} omitida(s) por fecha futura` : ''}${errores.length ? ` · ${errores.length} con error` : ''}`,
      meta: { insertados, total: data.length, errores: errores.length, omitidos_futuro: omitidosFuturo, recalculados } });
    res.json({
      success: true,
      data: {
        total_archivo:     data.length,
        ya_existentes:     setExistentes.size,
        nuevos_intentados: data.length,
        insertados,
        omitidos_futuro:   omitidosFuturo,
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

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

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
