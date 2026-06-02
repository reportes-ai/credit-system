'use strict';
const pool = require('../../../../shared/config/database');
const XLSX = require('xlsx');

/* ── Asegurar columnas extra en operaciones_brokerage ──────────────────── */
(async () => {
  const extra = [
    `ALTER TABLE operaciones_brokerage ADD COLUMN com_rdh       DECIMAL(15,0) NULL`,
    `ALTER TABLE operaciones_brokerage ADD COLUMN com_cesantia  DECIMAL(15,0) NULL`,
    `ALTER TABLE operaciones_brokerage ADD COLUMN com_parque    DECIMAL(15,0) NULL`,
    `ALTER TABLE operaciones_brokerage ADD COLUMN resultado_negocio DECIMAL(15,2) NULL`,
  ];
  for (const sql of extra) {
    try { await pool.query(sql); } catch (e) { if (e.errno !== 1060) console.error('[carga-masiva migration]', e.message); }
  }
})();

/* ── Normaliza un valor del Excel ──────────────────────────────────────── */
function norm(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s.toUpperCase() === 'NO APLICA' || s === '0' && false) return null;
  return s;
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
function mapRow(row) {
  const n = (col) => normNum(row[col]);
  const s = (col) => { const v = norm(row[col]); return (v && v.toUpperCase() !== 'NO APLICA') ? v : null; };
  const d = (col) => normDate(row[col]);
  const i = (col) => normInt(row[col]);

  return {
    num_op:             i('OP'),
    mes:                d('MES'),
    rut_cliente:        s('RUT'),
    nombre_cliente:     s('NOMBRE'),
    comentarios:        s('COMENTARIOS'),
    ejecutivo:          s('EJ.COMERCIAL'),
    financiera:         s('FINANCIERA'),
    automotora:         s('AUTOMOTORA'),
    nombre_local:       s('NOMBRE LOCAL'),
    estado_eval:        s('ESTADO EVAL. RIESGO'),
    estado_credito:     s('ESTADO CREDITO'),
    fecha_otorgado:     d('FECHA OTORGADO'),
    producto:           s('PRODUCTO'),
    valor_vehiculo:     i('VALOR VEHICULO'),
    pie:                i('PIE'),
    saldo_precio:       i('SALDO PRECIO'),
    pct_financiado:     n('% FINANCIADO'),
    impuesto:           i('IMPUESTO'),
    estado_impuesto:    s('ESTADO IMPTO'),
    gastos:             i('GASTOS'),
    seguro_rdh:         i('SEGURO RDH+E'),
    seguro_cesantia:    i('SEG.CESANTIA'),
    seguro_rep_menor:   i('SEG. REP MENOR'),
    monto_financiado:   i('MONTO FINANCIADO INDEXA'),
    tascli_real:        n('TASCLI REAL'),
    tascli_pizarra:     n('TASCLI PIZARRA'),
    tasfin_pizarra:     n('TASFIN PIZARRA'),
    comdea_real:        i('COMDEA $ REAL'),
    comej:              i('COMEJ $'),
    monto_comision_fin: i('RENTABILIDAD AUTOFACIL DIRECTO'),
    plazo:              i('PLAZO'),
    parque:             norm(row['PARQUE']) || 'NO APLICA',
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

/* ── POST /api/carga-masiva/preview ─────────────────────────────────────── */
const preview = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, data: null, error: 'No se recibió archivo' });

    const wb   = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!data.length) return res.status(400).json({ success: false, data: null, error: 'Archivo vacío' });

    const ops = data.map(r => parseInt(r['OP'])).filter(Boolean);
    const [existentes] = await pool.query(
      `SELECT num_op FROM operaciones_brokerage WHERE num_op IN (${ops.map(()=>'?').join(',')})`,
      ops
    );
    const setExistentes = new Set(existentes.map(r => r.num_op));

    const resumen = {
      total:     data.length,
      nuevos:    ops.filter(o => !setExistentes.has(o)).length,
      existentes: setExistentes.size,
      otorgados: data.filter(r => (r['ESTADO CREDITO']||'').toUpperCase() === 'OTORGADO').length,
    };

    // Vista previa: primeras 10 nuevas
    const preview = data
      .filter(r => !setExistentes.has(parseInt(r['OP'])))
      .slice(0, 10)
      .map(r => ({
        op:       r['OP'],
        nombre:   r['NOMBRE'],
        estado:   r['ESTADO CREDITO'],
        producto: r['PRODUCTO'],
        financiera: r['FINANCIERA'],
        monto:    r['MONTO FINANCIADO INDEXA'],
      }));

    res.json({ success: true, data: { resumen, preview }, error: null });
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

    const ops = data.map(r => parseInt(r['OP'])).filter(Boolean);
    const [existentes] = await pool.query(
      `SELECT num_op FROM operaciones_brokerage WHERE num_op IN (${ops.map(()=>'?').join(',')})`,
      ops
    );
    const setExistentes = new Set(existentes.map(r => r.num_op));

    const nuevos = data.filter(r => !setExistentes.has(parseInt(r['OP'])));

    let insertados = 0;
    let errores    = [];

    for (const row of nuevos) {
      try {
        const obj = mapRow(row);
        if (!obj.num_op) continue;

        const cols   = Object.keys(obj).filter(k => obj[k] !== undefined && obj[k] !== null);
        const vals   = cols.map(k => obj[k]);
        const placeholders = cols.map(() => '?').join(',');

        await pool.query(
          `INSERT INTO operaciones_brokerage (${cols.join(',')}) VALUES (${placeholders})`,
          vals
        );
        insertados++;
      } catch (e) {
        errores.push({ op: row['OP'], error: e.message });
      }
    }

    res.json({
      success: true,
      data: {
        total_archivo:   data.length,
        ya_existentes:   setExistentes.size,
        nuevos_intentados: nuevos.length,
        insertados,
        errores,
      },
      error: null,
    });
  } catch (e) {
    console.error('[importar]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { preview, importar };
