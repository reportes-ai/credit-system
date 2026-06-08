'use strict';
const pool = require('../../../../shared/config/database');
const XLSX = require('xlsx');
const { calcularComisionFin } = require('../utils/calcular-comision-fin');
const historial = require('./carga-historial.controller');

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
  return s.replace(/\./g, '').toUpperCase();
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

  return {
    num_op:             i('OP'),
    // mes = mes de FECHA OTORGADO si existe; si no (APROBADO/RECHAZADO) usa el mes del archivo
    mes: (() => {
      const fOtorg = normDate(getCol(row, 'FECHA OTORGADO'));
      if (fOtorg && fOtorg !== 'NO APLICA') {
        // primer día del mes de la fecha de otorgamiento
        return fOtorg.slice(0, 7) + '-01';
      }
      return mesOverride || null;
    })(),
    rut_cliente:        normRut(getCol(row, 'RUT')),
    nombre_cliente:     s('NOMBRE'),
    comentarios:        s('COMENTARIOS'),
    ejecutivo:          s('EJ.COMERCIAL'),
    financiera:         norm(getCol(row, 'FINANCIERA')) || 'NO APLICA',
    automotora:         s('AUTOMOTORA'),
    nombre_local:       s('NOMBRE LOCAL'),
    estado_eval:        s('ESTADO EVAL. RIESGO', 'ESTADO EVAL RIESGO'),
    estado_credito:     s('ESTADO CREDITO', 'ESTADO CRÉDITO'),
    fecha_otorgado:     d('FECHA OTORGADO'),
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
    rut_concesionario:  s('RUT DEALER'),
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

    const { colOP, colIdFin, colEstado, colNombre, colProducto, colFin, colMonto } = detectarCols(data);

    // Llave: ID FINANCIERA
    const ids = data.map(r => String(r[colIdFin] || '').trim()).filter(v => v && v !== '' && v.toUpperCase() !== 'NO APLICA');
    if (!ids.length) return res.status(400).json({ success: false, data: null, error: `No se encontró la columna "ID FINANCIERA" en el archivo. Columnas detectadas: ${Object.keys(data[0]).slice(0,8).join(', ')}` });

    const setExistentes = await getExistentes(ids);

    const resumen = {
      total:      data.length,
      nuevos:     data.filter(r => !setExistentes.has(String(r[colIdFin]||'').trim())).length,
      existentes: setExistentes.size,
      otorgados:  data.filter(r => (r[colEstado]||'').toString().toUpperCase() === 'OTORGADO').length,
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

    // Llave de deduplicación: ID FINANCIERA
    const ids = data.map(r => String(r[colIdFin] || '').trim()).filter(v => v && v.toUpperCase() !== 'NO APLICA');
    const setExistentes = await getExistentes(ids);

    const nuevos = data.filter(r => !setExistentes.has(String(r[colIdFin]||'').trim()));

    // mes_override: fuerza el mes contable a un valor fijo (evita desfases por fecha de evaluación)
    const mesOverride = req.body.mes_override || null;

    let insertados = 0;
    let errores    = [];
    const sinComisionFin = [];
    const clienteCache   = {};
    const detallesLog    = [];   // para log historial

    for (const row of nuevos) {
      try {
        const obj = mapRow(row, mesOverride);
        if (!obj.num_op) continue;

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

        await pool.query(
          `INSERT INTO creditos (${cols.join(',')}) VALUES (${placeholders})`,
          vals
        );
        insertados++;
        detallesLog.push({ num_op: obj.num_op, datos: obj });

        if (obj.monto_comision_fin === null || obj.monto_comision_fin === undefined) {
          sinComisionFin.push({ num_op: obj.num_op, mes: obj.mes, financiera: obj.financiera });
        }
      } catch (e) {
        errores.push({ op: row['OP'], error: e.message });
      }
    }

    // ── Recálculo post-insert de monto_comision_fin ─────────────────────
    let recalculados = 0;
    if (sinComisionFin.length > 0) {
      try {
        recalculados = await calcularComisionFin(sinComisionFin);
      } catch (e) {
        console.error('[recalc comision fin]', e.message);
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

    res.json({
      success: true,
      data: {
        total_archivo:   data.length,
        ya_existentes:   setExistentes.size,
        nuevos_intentados: nuevos.length,
        insertados,
        recalculados_comision_fin: recalculados,
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
          const valorActual = existente[campo];
          const estaVacio = valorActual === null || valorActual === undefined || valorActual === '' || valorActual === 0;
          if (estaVacio) {
            setCols.push(`\`${campo}\` = ?`);
            setVals.push(valorNuevo);
          }
        }

        if (setCols.length === 0) { sinCambios++; continue; }

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
