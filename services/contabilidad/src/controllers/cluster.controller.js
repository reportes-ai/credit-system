'use strict';
/**
 * CLUSTER BALANCE PG — réplica del informe "Clúster Originación de Cartera" que
 * finanzas reporta a la matriz: Balance General (saldos al cierre de cada mes,
 * DIC = apertura del año anterior) y Estado de Resultados (acumulado YTD por mes,
 * DIC = año anterior completo), con VALIDACIÓN A−P−Pat=0 y KPIs por empleado.
 *
 * El mapeo cuenta→línea es PARAMÉTRICO (tabla ctb_cluster_lineas, editable en BD):
 * cada cuenta se asigna a la línea cuyo prefijo MÁS LARGO calce (longest-prefix,
 * como una tabla de ruteo), así una línea específica (4002301) le gana al catch-all
 * (4002). Deriva de los libros del Suite: los subtotales cuadran por construcción.
 * Mapeo validado contra el Excel de finanzas (Cluster_Balance_PG_2026.xlsx):
 * Gastos de Personal, Obligaciones con Empleados, Otros Activos NC, Inversiones,
 * IVA y Derecho de Uso calzan al peso; las diferencias restantes son ajustes
 * manuales del archivo de finanzas (devengo intereses CFC) que no están en libros.
 */
const pool = require('../../../../shared/config/database');

const ok = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, error, code = 500) => res.status(code).json({ success: false, data: null, error });

require('../../../../shared/migrate').enFila('contabilidad-cluster-pg', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ctb_cluster_lineas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        informe  CHAR(3) NOT NULL,           -- BAL | PG
        seccion  VARCHAR(30) NOT NULL,       -- BAL: ACT_C/ACT_NC/PAS_C/PAS_NC/PAT · PG: cuerpo
        etiqueta VARCHAR(120) NOT NULL,
        orden    INT NOT NULL,
        clase    VARCHAR(12) NOT NULL DEFAULT 'LINEA',  -- LINEA | MARGEN | HEADER | RESULTADO
        prefijos TEXT NULL                   -- CSV de prefijos de cuenta (longest-prefix-match)
      )`);
    const [[n]] = await pool.query('SELECT COUNT(*) c FROM ctb_cluster_lineas');
    if (!n.c) {
      const L = [
        // ── BALANCE ──
        ['BAL', 'ACT_C', '1. Efectivo y Equivalentes de Efectivo', 10, 'LINEA', '1101,1102011,1103010'],
        ['BAL', 'ACT_C', '2. Inversiones Financieras Corto Plazo', 20, 'LINEA', '1102,1103'],
        ['BAL', 'ACT_C', '3. Cuentas por cobrar comerciales', 30, 'LINEA', '1104,1106,1105'],
        ['BAL', 'ACT_C', '4. Activos por Impuestos Corrientes', 40, 'LINEA', '1108'],
        ['BAL', 'ACT_NC', '1. Otros Activos Financieros No Corrientes', 50, 'LINEA', '1107'],
        ['BAL', 'ACT_NC', '2. Propiedad Planta y Equipo', 60, 'LINEA', '12,13'],
        ['BAL', 'ACT_NC', '3. Activos por Derecho de Uso', 70, 'LINEA', '18'],
        ['BAL', 'ACT_NC', '4. Otros Activos No Corrientes', 80, 'LINEA', '1105071,1105072,14,15,16,17,19,1'],
        ['BAL', 'PAS_C', '1. Préstamos y Obl. Financieras', 90, 'LINEA', '2101'],
        ['BAL', 'PAS_C', '2. Cuentas por pagar comerciales', 100, 'LINEA', '2102,2103011,2103012,2103013,2103050,2103051,2103'],
        ['BAL', 'PAS_C', '3. Obligaciones con Empleados', 110, 'LINEA', '2104,2105,2106,2107,2210904'],
        ['BAL', 'PAS_NC', '1. Cuentas por pagar LP', 120, 'LINEA', '22,21,2'],
        ['BAL', 'PAS_NC', '2. Pasivos por Impuestos Diferidos', 130, 'LINEA', '2109'],
        ['BAL', 'PAT', '1. Capital Pagado', 140, 'LINEA', '2701'],
        ['BAL', 'PAT', '2. Resultados Acumulados', 150, 'ACUMULADO', '2702,2703'],
        ['BAL', 'PAT', '3. Resultado del Ejercicio', 160, 'RESULTADO', null],
        // ── P&G ──
        ['PG', 'PG', 'Ingresos Financieros', 10, 'LINEA', '3001010,3001040,3001150'],
        ['PG', 'PG', 'Egresos Financieros', 20, 'LINEA', '4001020,4001030,4001040,4201010,4201030,4301050'],
        ['PG', 'PG', 'Provisiones', 30, 'LINEA', '4001190'],
        ['PG', 'PG', 'Margen Ordinario', 40, 'MARGEN', null],
        ['PG', 'PG', 'Ingresos Operativos', 50, 'LINEA', '3001020,3001072,3001073,3001075,3001087,3001090,3001120,3001170,3'],
        ['PG', 'PG', 'Egresos Operativos', 60, 'LINEA', '4001050,4001110,4001127,4001128,4001150,4001152,4001162,4001171,4001172,4001180,4001'],
        ['PG', 'PG', 'Margen Operativo Bruto', 70, 'MARGEN', null],
        ['PG', 'PG', 'Gastos Generales', 80, 'HEADER', null],
        ['PG', 'PG', 'Gastos de Personal', 90, 'LINEA', '400106,400107,400108,400109,4001100,4002030,4002050,4002060,4002081,4002120,4002150,4002270,4002302'],
        ['PG', 'PG', 'Gastos de Operación', 100, 'LINEA', '4002,4201032,4'],
        ['PG', 'PG', 'Margen Operativo Neto', 110, 'MARGEN', null],
        ['PG', 'PG', 'Gastos No Operacionales', 120, 'HEADER', null],
        ['PG', 'PG', 'Gastos No Operativos', 130, 'LINEA', '4002301,4002305,4201033,4201050,4201070'],
        ['PG', 'PG', 'Depreciaciones y Amortizaciones', 140, 'LINEA', '4003'],
        ['PG', 'PG', 'Ingresos No Operacionales', 150, 'HEADER', null],
        ['PG', 'PG', 'Diferencia Tipo de Cambio', 160, 'LINEA', '4401,3001151,3001200'],
        ['PG', 'PG', 'Utilidad Antes de Impuestos', 170, 'MARGEN', null],
        ['PG', 'PG', 'EBITDA', 180, 'MARGEN', null],
      ];
      for (const x of L)
        await pool.query('INSERT INTO ctb_cluster_lineas (informe, seccion, etiqueta, orden, clase, prefijos) VALUES (?,?,?,?,?,?)', x);
    }
    // Card en Contabilidad
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ctb_cluster' LIMIT 1");
    let idf = ex && ex.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500003,'Cluster Balance PG','ctb_cluster','/contabilidad/cluster-pg/','bi-columns-gap')");
      idf = r.insertId;
    }
    for (const idp of [1, 90003, 90007, 90009])
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    console.log('[contabilidad] cluster balance pg listo');
  } catch (e) { console.error('[contabilidad-cluster-pg migration]', e.message); }
});

// Asigna una cuenta a la línea cuyo prefijo más largo calce (longest-prefix-match)
function asignador(lineas) {
  const mapa = [];   // [prefijo, id_linea]
  for (const l of lineas) if (l.prefijos)
    for (const p of String(l.prefijos).split(',').map(s => s.trim()).filter(Boolean)) mapa.push([p, l.id]);
  return (codigo) => {
    let mejor = null, len = -1;
    for (const [p, id] of mapa) if (codigo.startsWith(p) && p.length > len) { mejor = id; len = p.length; }
    return mejor;
  };
}

const MESES_TXT = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

// GET /api/contabilidad/cluster-pg?anio=2026&hasta=6
exports.getClusterPG = async (req, res) => {
  try {
    const hoy = new Date();
    const anio = Number(req.query.anio) || hoy.getFullYear();
    let hasta = Number(req.query.hasta) || (anio === hoy.getFullYear() ? hoy.getMonth() + 1 : 12);
    hasta = Math.max(1, Math.min(12, hasta));

    const [lineas] = await pool.query('SELECT * FROM ctb_cluster_lineas ORDER BY informe, orden');
    const linBal = lineas.filter(l => l.informe === 'BAL');
    const linPG = lineas.filter(l => l.informe === 'PG');
    const asigBal = asignador(linBal);
    const asigPG = asignador(linPG);

    // Cortes: DIC año anterior + fin de cada mes 1..hasta
    const finMes = (a, m) => `${a}-${String(m).padStart(2, '0')}-${new Date(a, m, 0).getDate()}`;
    const cortes = [{ etiqueta: 'DICIEMBRE', corte: `${anio - 1}-12-31`, desde: `${anio - 1}-01-01` }];
    for (let m = 1; m <= hasta; m++)
      cortes.push({ etiqueta: MESES_TXT[m - 1], corte: finMes(anio, m), desde: `${anio}-01-01` });

    // Saldos de balance por cuenta a cada corte (sin asientos de cierre) — una sola query
    const [salRows] = await pool.query(`
      SELECT k.codigo, k.tipo, DATE_FORMAT(c.fecha,'%Y-%m-%d') f, SUM(m.debe-m.haber) mov
      FROM ctb_movimientos m JOIN ctb_comprobantes c ON c.id=m.id_comprobante
      JOIN ctb_cuentas k ON k.codigo=m.cuenta
      WHERE c.estado='CONTABILIZADO' AND c.origen<>'CIERRE_EJERCICIO' AND c.fecha<=?
      GROUP BY 1,2,3`, [cortes[cortes.length - 1].corte]);

    // Acumular por cuenta hasta cada corte
    const porCuenta = {};   // codigo -> {tipo, movs:[{f,mov}]}
    for (const r of salRows) {
      (porCuenta[r.codigo] = porCuenta[r.codigo] || { tipo: r.tipo, movs: [] }).movs.push({ f: r.f, mov: Number(r.mov) });
    }
    const saldoHasta = (c, corte) => c.movs.reduce((s, x) => s + (x.f <= corte ? x.mov : 0), 0);
    const resultadoRango = (desde, hastaF) => {
      let t = 0;
      for (const [cod, c] of Object.entries(porCuenta)) {
        if (c.tipo !== 'INGRESO' && c.tipo !== 'GASTO') continue;
        for (const x of c.movs) if (x.f >= desde && x.f <= hastaF) t += -x.mov;  // ingresos(+haber) − gastos(+debe)
      }
      return Math.round(t);
    };

    /* ── BALANCE ── */
    const balFilas = [];
    const porLineaBal = {};   // id_linea -> [valor por corte]
    for (const [cod, c] of Object.entries(porCuenta)) {
      if (c.tipo === 'INGRESO' || c.tipo === 'GASTO') continue;
      const id = asigBal(cod); if (!id) continue;
      const arr = porLineaBal[id] = porLineaBal[id] || cortes.map(() => 0);
      cortes.forEach((ct, i) => {
        const s = saldoHasta(c, ct.corte);
        arr[i] += (c.tipo === 'ACTIVO' ? s : -s);   // pasivo/patrimonio se muestran positivos
      });
    }
    const resultadoEj = cortes.map(ct => resultadoRango(ct.desde, ct.corte));
    // Resultados de años ANTERIORES al año de cada corte (los cierres están excluidos,
    // así que las pérdidas/utilidades pasadas se suman aquí a Resultados Acumulados)
    const resultadoPrevio = cortes.map(ct => resultadoRango('1900-01-01', (Number(ct.corte.slice(0, 4)) - 1) + '-12-31'));
    const SEC = { ACT_C: '1. Corriente', ACT_NC: '2. No corriente', PAS_C: '1. Corriente', PAS_NC: '2. No corriente', PAT: null };
    const secciones = [
      { grupo: '1. Activos', secs: ['ACT_C', 'ACT_NC'], totales: ['Total Activos Corrientes', 'Total Activos No Corrientes'], granTotal: 'TOTAL ACTIVOS' },
      { grupo: '2. Pasivos', secs: ['PAS_C', 'PAS_NC'], totales: ['Total Pasivos Corrientes', 'Total Pasivos No Corrientes'], granTotal: 'TOTAL PASIVOS' },
      { grupo: '3. Patrimonio', secs: ['PAT'], totales: [], granTotal: 'TOTAL PATRIMONIO' },
    ];
    const granTotales = {};
    for (const g of secciones) {
      balFilas.push({ etiqueta: g.grupo, clase: 'GRUPO', valores: null });
      const acumG = cortes.map(() => 0);
      g.secs.forEach((sec, si) => {
        if (SEC[sec]) balFilas.push({ etiqueta: SEC[sec], clase: 'HEADER', valores: null });
        const acumS = cortes.map(() => 0);
        for (const l of linBal.filter(x => x.seccion === sec)) {
          let vals = l.clase === 'RESULTADO' ? resultadoEj : (porLineaBal[l.id] || cortes.map(() => 0)).map(Math.round);
          if (l.clase === 'ACUMULADO') vals = vals.map((v, i) => v + resultadoPrevio[i]);
          balFilas.push({ etiqueta: l.etiqueta, clase: 'LINEA', valores: vals });
          vals.forEach((v, i) => { acumS[i] += v; acumG[i] += v; });
        }
        if (g.totales[si]) balFilas.push({ etiqueta: g.totales[si], clase: 'SUBTOTAL', valores: acumS.slice() });
      });
      balFilas.push({ etiqueta: g.granTotal, clase: 'TOTAL', valores: acumG.slice() });
      granTotales[g.granTotal] = acumG.slice();
    }
    balFilas.push({ etiqueta: 'VALIDACIÓN', clase: 'VALID', valores: cortes.map((_, i) =>
      Math.round((granTotales['TOTAL ACTIVOS'][i] || 0) - (granTotales['TOTAL PASIVOS'][i] || 0) - (granTotales['TOTAL PATRIMONIO'][i] || 0))) });

    /* ── P&G (acumulado YTD por corte; DIC = año anterior completo) ── */
    const porLineaPG = {};
    for (const [cod, c] of Object.entries(porCuenta)) {
      if (c.tipo !== 'INGRESO' && c.tipo !== 'GASTO') continue;
      const id = asigPG(cod); if (!id) continue;
      const arr = porLineaPG[id] = porLineaPG[id] || cortes.map(() => 0);
      cortes.forEach((ct, i) => {
        for (const x of c.movs) if (x.f >= ct.desde && x.f <= ct.corte) arr[i] += -x.mov;  // ingreso +, gasto −
      });
    }
    const pgFilas = [];
    const acum = cortes.map(() => 0);
    let vUAI = null, vDep = null, vDif = null;
    for (const l of linPG) {
      if (l.clase === 'HEADER') { pgFilas.push({ etiqueta: l.etiqueta, clase: 'HEADER', valores: null }); continue; }
      if (l.clase === 'MARGEN') {
        if (l.etiqueta === 'EBITDA') {
          // EBITDA = UAI agregando de vuelta depreciaciones y diferencia de cambio (no caja)
          const v = cortes.map((_, i) => (vUAI ? vUAI[i] : acum[i]) - (vDep ? vDep[i] : 0) - (vDif ? vDif[i] : 0));
          pgFilas.push({ etiqueta: 'EBITDA', clase: 'MARGEN', valores: v.map(Math.round) });
        } else {
          const v = acum.map(Math.round);
          pgFilas.push({ etiqueta: l.etiqueta, clase: 'MARGEN', valores: v });
          if (l.etiqueta === 'Utilidad Antes de Impuestos') vUAI = v;
        }
        continue;
      }
      const vals = (porLineaPG[l.id] || cortes.map(() => 0)).map(Math.round);
      pgFilas.push({ etiqueta: l.etiqueta, clase: 'LINEA', valores: vals });
      vals.forEach((v, i) => acum[i] += v);
      if (l.etiqueta === 'Depreciaciones y Amortizaciones') vDep = vals;
      if (l.etiqueta === 'Diferencia Tipo de Cambio') vDif = vals;
    }

    /* ── KPIs por empleado (dotación = personas pagadas en el último mes de cada corte) ── */
    const [dot] = await pool.query('SELECT mes, COUNT(DISTINCT rut) n FROM ctb_remun_aux GROUP BY mes');
    const dotDe = {}; dot.forEach(r => dotDe[r.mes] = Number(r.n));
    const empleados = cortes.map(ct => dotDe[ct.corte.slice(0, 7)] || null);
    const linea = et => (pgFilas.find(f => f.etiqueta === et) || {}).valores || cortes.map(() => 0);
    const mob = linea('Margen Operativo Bruto'), gp = linea('Gastos de Personal'), go = linea('Gastos de Operación'), mon = linea('Margen Operativo Neto');
    const porEmp = v => cortes.map((_, i) => empleados[i] ? Math.round(v[i] / empleados[i]) : null);
    const kpis = [
      { etiqueta: 'NÚMERO DE COLABORADORES', valores: empleados, formato: 'n' },
      { etiqueta: 'M. OPERATIVO BRUTO POR EMPLEADO', valores: porEmp(mob), formato: '$' },
      { etiqueta: 'GASTOS DE PERSONAL POR EMPLEADO', valores: porEmp(gp), formato: '$' },
      { etiqueta: 'GASTO DE OPERACIÓN POR EMPLEADO', valores: porEmp(go), formato: '$' },
      { etiqueta: 'GRADO DE ABSORCIÓN', valores: cortes.map((_, i) => (gp[i] + go[i]) !== 0 ? Math.round(mob[i] / Math.abs(gp[i] + go[i]) * 1000) / 10 : null), formato: '%' },
      { etiqueta: 'M. OPERATIVO NETO POR EMPLEADO', valores: porEmp(mon), formato: '$' },
    ];

    ok(res, {
      anio, hasta,
      columnas: cortes.map(c => c.etiqueta),
      balance: balFilas,
      pyg: pgFilas,
      kpis,
      titulo: 'CLÚSTER ORIGINACIÓN DE CARTERA',
    });
  } catch (e) { console.error('[cluster pg]', e.message); fail(res, 'Error interno del servidor'); }
};
