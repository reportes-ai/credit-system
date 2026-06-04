const pool = require('../../../../shared/config/database');

const CONFIG_KEY = 'dashboard_tab_permisos';

// ── Inicializar tabla config si no existe ─────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_config (
        config_key   VARCHAR(80)  NOT NULL PRIMARY KEY,
        config_value MEDIUMTEXT   NOT NULL,
        updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.error('[dashboard] CREATE TABLE dashboard_config:', e.message);
  }
})();

// ── Labels de meses ──────────────────────────────────────────────────────────
const MESES_LABELS = {
  '2024-01':'Ene 24','2024-02':'Feb 24','2024-03':'Mar 24','2024-04':'Abr 24',
  '2024-05':'May 24','2024-06':'Jun 24','2024-07':'Jul 24','2024-08':'Ago 24',
  '2024-09':'Sep 24','2024-10':'Oct 24','2024-11':'Nov 24','2024-12':'Dic 24',
  '2025-01':'Ene 25','2025-02':'Feb 25','2025-03':'Mar 25','2025-04':'Abr 25',
  '2025-05':'May 25','2025-06':'Jun 25','2025-07':'Jul 25','2025-08':'Ago 25',
  '2025-09':'Sep 25','2025-10':'Oct 25','2025-11':'Nov 25','2025-12':'Dic 25',
  '2026-01':'Ene 26','2026-02':'Feb 26','2026-03':'Mar 26','2026-04':'Abr 26',
  '2026-05':'May 26','2026-06':'Jun 26','2026-07':'Jul 26','2026-08':'Ago 26',
  '2026-09':'Sep 26','2026-10':'Oct 26','2026-11':'Nov 26','2026-12':'Dic 26',
};

function n(v) { return parseFloat(v) || 0; }
function s(v) { return v ? String(v).trim() : ''; }

function derInstitucion(financiera, producto) {
  const f = (financiera || '').toUpperCase().trim();
  const p = (producto   || '').toUpperCase().trim();
  // UNIDAD tiene prioridad
  if (f.includes('UNIDAD') || p.startsWith('UNIDAD')) return 'UNIDAD DE CREDITO';
  // AUTOFIN por campo financiera o producto
  if (f.includes('AUTOFIN') || f.includes('AUTOFACIL') ||
      p.startsWith('AUTOFIN') || p.startsWith('AUTOFACIL')) return 'AUTOFIN';
  // Si tiene financiera válida (banco externo) pero tiene producto AutoFácil
  if (p && p !== 'NO APLICA' && p !== '') return 'AUTOFIN';
  // Default: cualquier op cargada es AUTOFIN
  if (f && f !== 'NO APLICA') return 'AUTOFIN';
  return 'AUTOFIN'; // todas las ops son del negocio AutoFácil
}

// ── Procesamiento igual al original Vercel ────────────────────────────────────
function procesarDatos(rows) {
  const mesesKeys = [...new Set(rows.map(r => r.mes))].sort();
  const last12    = mesesKeys.slice(-12);
  const last6     = mesesKeys.slice(-6);
  const last3     = mesesKeys.slice(-3);

  // Tendencia mensual
  const tendencia = mesesKeys.map(m => {
    const mrs   = rows.filter(r => r.mes === m);
    const conFin = mrs.filter(r => r.institucion === 'AUTOFIN' || r.institucion === 'UNIDAD DE CREDITO');
    const ot    = conFin.filter(r => r.estado_eval === 'OTORGADO');
    return {
      mes:            MESES_LABELS[m] || m,
      mes_key:        m,
      total_ops:      mrs.length,
      otorgados:      ot.length,
      rechazados:     mrs.filter(r => r.estado_eval === 'RECHAZADO').length,
      saldo_ot:       ot.reduce((a, r) => a + n(r.saldo_precio), 0),
      com_dealer:     ot.reduce((a, r) => a + n(r.com_dealer), 0),
      rentab_afa:     ot.reduce((a, r) => a + n(r.rentab_afa), 0),
      com_seguros:    ot.reduce((a, r) => a + n(r.com_seguros), 0),
      tasa_conversion: mrs.length ? +(ot.length / mrs.length * 100).toFixed(1) : 0,
    };
  });

  // Desempeño por ejecutivo
  const ejMap = {};
  rows.forEach(r => {
    if (!r.ejecutivo) return;
    if (!ejMap[r.ejecutivo]) ejMap[r.ejecutivo] = {};
    if (!ejMap[r.ejecutivo][r.mes]) ejMap[r.ejecutivo][r.mes] = { ing:0,apro:0,ot:0,rec:0,monto_ot:0 };
    const d = ejMap[r.ejecutivo][r.mes];
    d.ing++;
    if (!['RECHAZADO','ANULADO'].includes(r.estado_eval)) d.apro++;
    if (r.estado_eval === 'OTORGADO') { d.ot++; d.monto_ot += n(r.saldo_precio); }
    if (r.estado_eval === 'RECHAZADO') d.rec++;
  });

  const ejecutivos = Object.keys(ejMap).sort((a, b) =>
    mesesKeys.reduce((s, m) => s + (ejMap[b][m]?.ot || 0), 0) -
    mesesKeys.reduce((s, m) => s + (ejMap[a][m]?.ot || 0), 0)
  );

  const ejPerf = ejecutivos.map(ej => {
    const row = { nombre: ej, meses: {} };
    mesesKeys.forEach(m => {
      const d = ejMap[ej][m] || {};
      row.meses[m] = {
        ing: d.ing||0, apro: d.apro||0, ot: d.ot||0, rec: d.rec||0,
        tc:  d.apro ? +((d.ot||0) / d.apro * 100).toFixed(1) : 0,
        ta:  d.ing  ? +((d.apro||0) / d.ing  * 100).toFixed(1) : 0,
        prom: d.ot  ? +((d.monto_ot||0) / d.ot / 1e6).toFixed(2) : 0,
      };
    });
    [['p12', last12], ['p6', last6], ['p3', last3]].forEach(([tag, win]) => {
      const ti = win.reduce((s, m) => s + (ejMap[ej][m]?.ing  || 0), 0);
      const ta = win.reduce((s, m) => s + (ejMap[ej][m]?.apro || 0), 0);
      const to = win.reduce((s, m) => s + (ejMap[ej][m]?.ot   || 0), 0);
      const tr = win.reduce((s, m) => s + (ejMap[ej][m]?.rec  || 0), 0);
      const tm = win.reduce((s, m) => s + (ejMap[ej][m]?.monto_ot || 0), 0);
      row[tag] = {
        ing:  +(ti / win.length).toFixed(1),
        apro: +(ta / win.length).toFixed(1),
        ot:   +(to / win.length).toFixed(1),
        rec:  +(tr / win.length).toFixed(1),
        tc:   ta ? +(to / ta * 100).toFixed(1) : 0,
        ta:   ti ? +(ta / ti * 100).toFixed(1) : 0,
        prom: to ? +(tm / to / 1e6).toFixed(2) : 0,
      };
    });
    return row;
  });

  return { tendencia, ej_perf: { meses: mesesKeys, meses_labels: MESES_LABELS, ejecutivos: ejPerf } };
}

// ── Permisos de pestañas ──────────────────────────────────────────────────────
exports.getPermisos = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT config_value FROM dashboard_config WHERE config_key = ?', [CONFIG_KEY]
    );
    const permisos = rows.length ? JSON.parse(rows[0].config_value) : {};
    return res.json({ success: true, permisos });
  } catch (err) {
    console.error('[dashboard] getPermisos:', err);
    return (console.error('[error]', err), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

exports.savePermisos = async (req, res) => {
  try {
    const { permisos } = req.body;
    if (!permisos || typeof permisos !== 'object') {
      return res.status(400).json({ success: false, error: 'Permisos inválidos' });
    }
    const json = JSON.stringify(permisos);
    await pool.query(`
      INSERT INTO dashboard_config (config_key, config_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = NOW()
    `, [CONFIG_KEY, json]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[dashboard] savePermisos:', err);
    return (console.error('[error]', err), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

// ── Controller ────────────────────────────────────────────────────────────────
exports.getDatos = async (req, res) => {
  try {
    // UF vigente para calcular MAYOR/MENOR 200UF dinámicamente
    const [ufRows] = await pool.query(
      'SELECT valor FROM uf WHERE fecha <= CURDATE() ORDER BY fecha DESC LIMIT 1'
    );
    const uf_vigente = parseFloat(ufRows[0]?.valor) || 38000;

    // Deduplicar: si hay num_op repetido, quedarse con el registro de mayor id
    const [rows] = await pool.query(`
      SELECT
        num_op                                                  AS op,
        DATE_FORMAT(mes, '%Y-%m')                              AS mes,
        COALESCE(ejecutivo, '')                                 AS ejecutivo,
        COALESCE(financiera, '')                               AS financiera,
        COALESCE(automotora, '')                               AS automotora,
        COALESCE(nombre_local, '')                             AS nombre_local,
        COALESCE(estado_eval, '')                              AS estado_eval,
        COALESCE(estado_credito, '')                           AS estado_credito,
        COALESCE(producto, '')                                 AS producto,
        COALESCE(saldo_precio, 0)                             AS saldo_precio,
        COALESCE(monto_financiado, 0)                         AS monto_financiado,
        COALESCE(tascli_real, 0)                              AS tasa_cli,
        COALESCE(comdea_real, 0)                              AS com_dealer,
        COALESCE(monto_comision_fin, 0)                       AS rentab_afa,
        COALESCE(com_rdh, 0) + COALESCE(com_cesantia, 0)
          + COALESCE(com_reparaciones, 0)                     AS com_seguros,
        COALESCE(com_parque, 0)                               AS com_parque,
        COALESCE(arriendo_parque, 0)                          AS arriendo_parque,
        COALESCE(ingreso_neto_total, 0)                       AS ingreso_neto_total,
        COALESCE(plazo, 0)                                    AS plazo,
        COALESCE(mayor_menor, '')                             AS mayor_menor,
        COALESCE(mayor_mm30, 0)                               AS mayor_mm30,
        DATE_FORMAT(fecha_estado, '%Y-%m-%d')                  AS fecha_estado,
        DATE_FORMAT(fecha_otorgado, '%Y-%m-%d')               AS fecha_otorgado,
        COALESCE(parque, '')                                   AS parque,
        COALESCE(estado_sp, '')                               AS estado_sp,
        COALESCE(status_comaf, '')                            AS status_comaf,
        COALESCE(resultado_negocio, '')                       AS resultado_negocio,
        COALESCE(cl.rut, '')                                  AS rut_cliente,
        COALESCE(cl.nombre_completo, '')                      AS nombre_cliente,
        COALESCE(ob.rut_concesionario, '')                    AS rut_dealer,
        COALESCE(ob.id_financiera, '')                         AS id_financiera
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY num_op ORDER BY id DESC) AS _rn
        FROM creditos WHERE mes IS NOT NULL
      ) ob
      LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
      WHERE ob._rn = 1
      ORDER BY ob.mes ASC, ob.num_op ASC
    `);

    // Agregar institucion derivada + castear decimales a número
    // (MySQL2/TiDB devuelve columnas DECIMAL como strings)
    const raw = rows.map(r => {
      const saldo = +(r.saldo_precio) || 0;
      return {
        ...r,
        institucion:        derInstitucion(r.financiera, r.producto),
        saldo_precio:       saldo,
        monto_financiado:   +(r.monto_financiado)   || 0,
        tasa_cli:           +(r.tasa_cli)            || 0,
        com_dealer:         +(r.com_dealer)          || 0,
        rentab_afa:         +(r.rentab_afa)          || 0,
        com_seguros:        +(r.com_seguros)         || 0,
        com_parque:         +(r.com_parque)          || 0,
        arriendo_parque:    +(r.arriendo_parque)     || 0,
        ingreso_neto_total: +(r.ingreso_neto_total)  || 0,
        plazo:              +(r.plazo)               || 0,
        mayor_mm30:         +(r.mayor_mm30)          || 0,
        // Recalcular MAYOR/MENOR 200UF dinámicamente con UF vigente
        mayor_menor:        saldo > 200 * uf_vigente ? 'MAYOR 200UF' : 'MENOR 200UF',
      };
    });

    const { tendencia, ej_perf } = procesarDatos(raw);

    return res.json({
      success:         true,
      generado_en:     new Date().toISOString(),
      total_registros: raw.length,
      uf_vigente,
      raw,
      tendencia,
      ej_perf,
    });
  } catch (err) {
    console.error('[dashboard] getDatos error:', err);
    return (console.error('[error]', err), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};
