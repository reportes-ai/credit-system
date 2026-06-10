const pool = require('../../../../shared/config/database');

/* ── Migraciones ─────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comisiones_variables (
        clave       VARCHAR(60) PRIMARY KEY,
        valor       DECIMAL(18,6) NOT NULL,
        etiqueta    VARCHAR(120),
        descripcion VARCHAR(255),
        tipo        ENUM('porcentaje','monto','factor','multiplicador') DEFAULT 'porcentaje'
      )
    `);
    const defaults = [
      ['pct_24',        0.0075, '% base ≤ 24 cuotas',             'Tasa aplicada al monto financiado con plazo hasta 24 meses',       'porcentaje'],
      ['pct_mas24',     0.0100, '% base > 24 cuotas',             'Tasa aplicada al monto financiado con plazo mayor a 24 meses',     'porcentaje'],
      ['minimo_monto',  30000000,'Mínimo monto mes (CLP)',          'Si el total financiado del mes es menor a este valor, no hay bono','monto'],
      ['factor_max',    0.66,   'Factor ajuste máximo',            'Cap máximo del factor de ajuste total (suma de los tres pesos)',   'factor'],
      ['peso_cesantia', 0.50,   'Peso cruce cesantía',             'Peso del indicador de cruce de seguro cesantía en el ajuste',     'factor'],
      ['peso_rep',      0.30,   'Peso cruce reparaciones',         'Peso del indicador de cruce de seguro reparaciones en el ajuste', 'factor'],
      ['peso_calidad',  0.20,   'Peso calidad',                    'Peso del indicador de calidad en el ajuste',                      'factor'],
      ['umbral_cesantia',0.65,  'Umbral mínimo cesantía',          'Si el cruce es ≤ este valor el aporte de cesantía es 0',          'porcentaje'],
      ['umbral_rep',    0.50,   'Umbral mínimo reparaciones',      'Si el cruce es ≤ este valor el aporte de reparaciones es 0',      'porcentaje'],
      ['semana_corrida',1.20,   'Multiplicador semana corrida',    'Factor aproximado para cálculo con semana corrida',               'multiplicador'],
    ];
    for (const [clave, valor, etiqueta, descripcion, tipo] of defaults) {
      await pool.query(
        `INSERT IGNORE INTO comisiones_variables (clave, valor, etiqueta, descripcion, tipo) VALUES (?,?,?,?,?)`,
        [clave, valor, etiqueta, descripcion, tipo]
      );
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS comisiones_aprobaciones (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        ejecutivo    VARCHAR(100) NOT NULL,
        mes          VARCHAR(7)   NOT NULL,
        estado       ENUM('pendiente','aprobado','rechazado') DEFAULT 'pendiente',
        incentivo_final  DECIMAL(15,2),
        con_semana_corrida DECIMAL(15,2),
        aprobado_por INT,
        aprobado_at  DATETIME,
        notas        TEXT,
        UNIQUE KEY uk_ej_mes (ejecutivo, mes)
      )
    `);
  } catch (e) {
    console.error('[comisiones migration]', e.message);
  }
})();

/* ── Helpers ─────────────────────────────────────────────────────────────── */
async function getVars() {
  const [rows] = await pool.query('SELECT clave, valor FROM comisiones_variables');
  const v = {};
  rows.forEach(r => { v[r.clave] = parseFloat(r.valor); });
  return v;
}

function calcularComision(creditos, vars) {
  const {
    pct_24, pct_mas24, minimo_monto, factor_max,
    peso_cesantia, peso_rep, peso_calidad,
    umbral_cesantia, umbral_rep, semana_corrida,
  } = vars;

  const otorgados = creditos.filter(c => (c.estado_credito || '').toUpperCase() === 'OTORGADO');

  // Total financiado (todos los OTORGADOS)
  const total_financiado = otorgados.reduce((s, c) => s + (parseFloat(c.monto_financiado) || 0), 0);

  if (total_financiado < minimo_monto) {
    return { cumple_minimo: false, total_creditos: otorgados.length, total_financiado };
  }

  // Split por plazo
  const ot24    = otorgados.filter(c => parseInt(c.plazo) <= 24);
  const otMas24 = otorgados.filter(c => parseInt(c.plazo) > 24);
  const monto24    = ot24.reduce((s, c) => s + (parseFloat(c.monto_financiado) || 0), 0);
  const montoMas24 = otMas24.reduce((s, c) => s + (parseFloat(c.monto_financiado) || 0), 0);

  const base24    = monto24    * pct_24;
  const baseMas24 = montoMas24 * pct_mas24;
  const incentivo_base = base24 + baseMas24;

  // NCNU: AUTOFIN, no CORFO (base de medición de seguros)
  const ncnu = otorgados.filter(c =>
    (c.financiera || '').toUpperCase() === 'AUTOFIN' &&
    !(c.producto || '').toUpperCase().includes('CORFO')
  );
  const ncnu_total    = ncnu.length;
  const ncnu_cesantia = ncnu.filter(c => (parseFloat(c.seguro_cesantia)  || 0) > 0).length;
  const ncnu_rep      = ncnu.filter(c => (parseFloat(c.seguro_rep_menor) || 0) > 0).length;

  const cruce_cesantia     = ncnu_total > 0 ? ncnu_cesantia / ncnu_total : 0;
  const cruce_reparaciones = ncnu_total > 0 ? ncnu_rep      / ncnu_total : 0;

  // Calidad: meta = 3 créditos UNIDAD DE CRÉDITO en el mes
  const META_UNIDAD = 3;
  const unidad_logrado = otorgados.filter(c =>
    (c.financiera || '').toUpperCase().includes('UNIDAD') ||
    (c.producto   || '').toUpperCase().includes('UNIDAD')
  ).length;
  const calidad        = Math.min(unidad_logrado / META_UNIDAD, 1);

  const cumple_ces = cruce_cesantia    > umbral_cesantia;
  const cumple_rep = cruce_reparaciones > umbral_rep;

  const ajuste_ces     = (cumple_ces ? cruce_cesantia    : 0) * peso_cesantia * factor_max;
  const ajuste_rep     = (cumple_rep ? cruce_reparaciones : 0) * peso_rep      * factor_max;
  const ajuste_calidad = calidad * peso_calidad * factor_max;
  const factor_ajuste  = ajuste_ces + ajuste_rep + ajuste_calidad;

  // Bonos cesantía, rep y calidad: todos aplican el ajuste sobre incentivo_base total
  const bono_ces     = incentivo_base * ajuste_ces;
  const bono_rep     = incentivo_base * ajuste_rep;
  const bono_calidad = incentivo_base * ajuste_calidad;

  const incentivo_final = incentivo_base + bono_ces + bono_rep + bono_calidad;

  return {
    cumple_minimo: true,
    total_creditos: otorgados.length,
    total_financiado,
    monto_24: monto24, monto_mas24: montoMas24,
    base_24: base24, base_mas24: baseMas24,
    incentivo_base,
    ncnu_total, ncnu_cesantia, ncnu_rep,
    cruce_cesantia, cruce_reparaciones,
    calidad, calidad_logrado: unidad_logrado, calidad_meta: META_UNIDAD,
    umbral_cesantia, umbral_rep,
    cumple_cesantia: cumple_ces, cumple_reparaciones: cumple_rep,
    ajuste_cesantia: ajuste_ces, ajuste_reparaciones: ajuste_rep,
    ajuste_calidad, factor_ajuste,
    bono_cesantia: bono_ces, bono_reparaciones: bono_rep, bono_calidad,
    incentivo_final,
    con_semana_corrida: incentivo_final * semana_corrida,
  };
}

/* ── GET /api/comisiones/variables ───────────────────────────────────────── */
const getVariables = async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM comisiones_variables ORDER BY clave');
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── PUT /api/comisiones/variables ───────────────────────────────────────── */
const putVariables = async (req, res) => {
  try {
    const updates = req.body; // { clave: valor, ... }
    for (const [clave, valor] of Object.entries(updates)) {
      await pool.query(
        'UPDATE comisiones_variables SET valor = ? WHERE clave = ?',
        [parseFloat(valor), clave]
      );
    }
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── GET /api/comisiones/calculo?mes=YYYY-MM ─────────────────────────────── */
const getCalculo = async (req, res) => {
  try {
    const { mes } = req.query;
    if (!mes) return res.status(400).json({ success: false, data: null, error: 'Parámetro mes requerido (YYYY-MM)' });

    const vars = await getVars();

    // Trae todos los créditos del mes agrupados por ejecutivo
    const [creditos] = await pool.query(
      `SELECT ob.ejecutivo, ob.estado_credito, ob.financiera, ob.producto,
              ob.monto_financiado, ob.plazo, ob.seguro_cesantia, ob.seguro_rep_menor,
              ob.seguro_rdh, ob.valor_vehiculo, ob.pie, ob.saldo_precio,
              ob.fecha_otorgado, ob.num_op,
              COALESCE(cl.nombre_completo, '') AS nombre_cliente,
              COALESCE(cl.rut, '')             AS rut_cliente
       FROM creditos ob
       LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
       WHERE DATE_FORMAT(COALESCE(ob.fecha_otorgado, ob.mes), '%Y-%m') = ?
         AND ob.ejecutivo IS NOT NULL AND ob.ejecutivo != ''`,
      [mes]
    );

    // Agrupar por ejecutivo
    const map = {};
    creditos.forEach(c => {
      if (!map[c.ejecutivo]) map[c.ejecutivo] = [];
      map[c.ejecutivo].push(c);
    });

    // Obtener aprobaciones existentes
    const [aprobs] = await pool.query(
      'SELECT ejecutivo, estado, notas, aprobado_at FROM comisiones_aprobaciones WHERE mes = ?',
      [mes]
    );
    const aprobMap = {};
    aprobs.forEach(a => { aprobMap[a.ejecutivo] = a; });

    const resultado = Object.entries(map).map(([ejecutivo, creds]) => {
      const calc = calcularComision(creds, vars);
      const aprob = aprobMap[ejecutivo] || { estado: 'pendiente' };

      // Anotar cada crédito con su incentivo individual
      if (calc.cumple_minimo) {
        creds.forEach(c => {
          if ((c.estado_credito || '').toUpperCase() !== 'OTORGADO') return;
          const pct    = parseInt(c.plazo) <= 24 ? vars.pct_24 : vars.pct_mas24;
          const monto  = parseFloat(c.monto_financiado) || 0;
          const base   = monto * pct;
          const isNcnu = (c.financiera || '').toUpperCase() === 'AUTOFIN' &&
                         !(c.producto  || '').toUpperCase().includes('CORFO');
          const hasCes = (parseFloat(c.seguro_cesantia)  || 0) > 0;
          const hasRep = (parseFloat(c.seguro_rep_menor) || 0) > 0;
          c.incentivo_base_credito      = base;
          c.bono_cesantia_credito       = (isNcnu && hasCes) ? base * calc.ajuste_cesantia    : 0;
          c.bono_rep_credito            = (isNcnu && hasRep) ? base * calc.ajuste_reparaciones : 0;
          c.bono_calidad_credito        = base * calc.ajuste_calidad;
          c.incentivo_adicional_credito = c.bono_cesantia_credito + c.bono_rep_credito + c.bono_calidad_credito;
        });
      }

      return { ejecutivo, mes, ...calc, estado: aprob.estado, notas: aprob.notas, aprobado_at: aprob.aprobado_at, creditos: creds };
    });

    resultado.sort((a, b) => a.ejecutivo.localeCompare(b.ejecutivo));
    res.json({ success: true, data: resultado, error: null });
  } catch (e) {
    console.error('[getCalculo]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── POST /api/comisiones/aprobar ────────────────────────────────────────── */
const aprobar = async (req, res) => {
  try {
    const { ejecutivo, mes, estado, notas, incentivo_final, con_semana_corrida } = req.body;
    if (!ejecutivo || !mes || !estado) return res.status(400).json({ success: false, data: null, error: 'Faltan campos requeridos' });
    await pool.query(
      `INSERT INTO comisiones_aprobaciones (ejecutivo, mes, estado, incentivo_final, con_semana_corrida, aprobado_por, aprobado_at, notas)
       VALUES (?,?,?,?,?,?,NOW(),?)
       ON DUPLICATE KEY UPDATE estado=VALUES(estado), incentivo_final=VALUES(incentivo_final),
         con_semana_corrida=VALUES(con_semana_corrida), aprobado_por=VALUES(aprobado_por),
         aprobado_at=NOW(), notas=VALUES(notas)`,
      [ejecutivo, mes, estado, incentivo_final || 0, con_semana_corrida || 0, req.usuario.id_usuario, notas || null]
    );
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── GET /api/comisiones/ejecutivos?mes=YYYY-MM ──────────────────────────── */
const getEjecutivos = async (req, res) => {
  try {
    const { mes } = req.query;
    const where = mes ? `AND DATE_FORMAT(COALESCE(fecha_otorgado, mes), '%Y-%m') = ?` : '';
    const params = mes ? [mes] : [];
    // Ejecutivos con operaciones + usuarios activos con perfil Ejecutivo Comercial
    // (los recién creados aún no tienen créditos digitados y deben aparecer igual)
    const [rows] = await pool.query(
      `SELECT DISTINCT ejecutivo FROM creditos
       WHERE ejecutivo IS NOT NULL AND ejecutivo != '' ${where}
       UNION
       SELECT CONCAT(u.nombre, ' ', u.apellido) AS ejecutivo
       FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
       WHERE p.nombre = 'Ejecutivo Comercial' AND u.estado = 'activo'
       ORDER BY ejecutivo`,
      params
    );
    res.json({ success: true, data: rows.map(r => r.ejecutivo), error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getVariables, putVariables, getCalculo, aprobar, getEjecutivos };
