'use strict';
/* ════════════════════════════════════════════════════════════════════════
   BONO JEFE COMERCIAL — réplica del BSC (Balanced Scorecard) Excel de RRHH.
   El bono del Jefe Comercial se calcula sobre el PROMEDIO del equipo de
   Ejecutivos Comerciales en 3 pilares del mes:
     · CRÉDITOS otorgados    (pond. 45%)  — tramo mínimo/esperado
     · MONTOS otorgados      (pond. 40%)  — umbrales = ops × monto por op
     · NUEVOS DEALERS con negocios (pond. 15%)
   El score del equipo (0–100+) entra a una curva exponencial sobre el
   sueldo fijo: premio = fijo × %variable × (e^(k·x)−1)/(e^k−1), con
   x = (score−mínimo)/(máximo−mínimo); bajo el mínimo el premio es 0.
   Variables paramétricas en bono_jefe_config (pestaña restringida).
   ════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const SC = require('../../../../shared/semana-corrida');
const { mesChile } = require('../../../../shared/utils/fecha-futura');   // MOTOR ÚNICO fecha/hora Chile
const { auditar } = require('../../../../shared/audit');

/* ── Migración: tabla de config + funcionalidades (card Soporte) ── */
require('../../../../shared/migrate').enFila('bono-jefe', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bono_jefe_config (
        clave      VARCHAR(40) PRIMARY KEY,
        valor      VARCHAR(40) NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    const defaults = [
      ['creditos_min', '5'], ['creditos_esperado', '12'], ['pond_creditos', '45'],
      ['monto_por_op', '6800000'], ['pond_montos', '40'],
      ['dealers_min', '1'], ['dealers_esperado', '2'], ['pond_dealers', '15'],
      ['score_min', '80'], ['score_max', '100'], ['pct_variable', '55'], ['k', '0.7'],
      ['sueldo_fijo', '1500000'], ['factor_semana', '0.1667'], ['semana_calc', '1'],
      ['informe_para', ''], ['informe_cc', ''],   // destinatarios del informe mensual por correo
    ];
    for (const [k, v] of defaults)
      await pool.query('INSERT IGNORE INTO bono_jefe_config (clave, valor) VALUES (?,?)', [k, v]);

    // Card en Soporte + permiso de acción para la pestaña Variables
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/soporte/' LIMIT 1");
    if (mod) {
      await pool.query(`INSERT INTO funcionalidades (id_modulo, codigo, nombre, href, icono)
        SELECT ?, 'bono_jefe', 'Bono Jefe Comercial', '/comisiones/bono-jefe/', 'bi-trophy'
        WHERE NOT EXISTS (SELECT 1 FROM funcionalidades WHERE codigo='bono_jefe')`, [mod.id_modulo]);
      await pool.query(`INSERT INTO funcionalidades (id_modulo, codigo, nombre, href, icono)
        SELECT ?, 'bono_jefe_variables', 'Variables Bono Jefe Comercial', NULL, NULL
        WHERE NOT EXISTS (SELECT 1 FROM funcionalidades WHERE codigo='bono_jefe_variables')`, [mod.id_modulo]);
    }
    // BITÁCORA DE CAMBIOS = las VERSIONES de variables. Append-only: no hay endpoint
    // que la edite ni la borre; el rango de vigencia se resuelve al leer.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bono_jefe_versiones (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        vigente_desde  CHAR(7) NOT NULL,
        vigente_hasta  CHAR(7) NULL,
        valores        JSON NOT NULL,
        anterior       JSON NULL,
        n_cambios      INT DEFAULT 0,
        bono_antes     BIGINT NULL,
        bono_despues   BIGINT NULL,
        mes_simulado   CHAR(7) NULL,
        id_usuario     INT NULL,
        usuario_nombre VARCHAR(160),
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_vig (vigente_desde, vigente_hasta)
      )`);
    // Permiso propio para ver la bitácora (se abre por la matriz de Perfiles)
    const [[modS]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/soporte/' LIMIT 1");
    if (modS) await pool.query(`INSERT INTO funcionalidades (id_modulo, codigo, nombre, href, icono)
        SELECT ?, 'bono_jefe_bitacora', 'Bitácora de Cambios Bono Jefe Comercial', NULL, NULL
        WHERE NOT EXISTS (SELECT 1 FROM funcionalidades WHERE codigo='bono_jefe_bitacora')`, [modS.id_modulo]);
    console.log('✓ bono_jefe_config lista');
  } catch (e) { console.error('[bono-jefe schema]', e.message); }
});

/* Claves numéricas que forman una VERSIÓN de variables (las de correo no versionan:
   son operativas, no cambian el cálculo del bono). */
const CLAVES_MODELO = ['creditos_min','creditos_esperado','pond_creditos','monto_por_op','pond_montos',
  'dealers_min','dealers_esperado','pond_dealers','score_min','score_max','pct_variable','k',
  'sueldo_fijo','factor_semana','semana_calc'];

async function rawConfig() {
  const [rows] = await pool.query('SELECT clave, valor FROM bono_jefe_config');
  const c = {}; rows.forEach(r => { c[r.clave] = r.valor; });
  return c;
}
/* Versión vigente para un mes: la de mayor vigente_desde que lo contenga.
   Nunca se edita una fila de versión (la bitácora es inmutable): el rango se
   resuelve al leer, así una versión nueva "tapa" a la anterior sin tocarla. */
async function rawVersion(mes) {
  if (!/^\d{4}-\d{2}$/.test(mes || '')) return null;
  const [[v]] = await pool.query(
    `SELECT valores FROM bono_jefe_versiones
      WHERE vigente_desde <= ? AND (vigente_hasta IS NULL OR vigente_hasta >= ?)
      ORDER BY vigente_desde DESC, id DESC LIMIT 1`, [mes, mes]).catch(() => [[null]]);
  if (v) { try { return typeof v.valores === 'string' ? JSON.parse(v.valores) : v.valores; } catch { return null; } }
  // Mes ANTERIOR a la primera versión: rigen las variables que había antes de ese
  // cambio (el snapshot "anterior"), no las de hoy — un mes pasado no se altera
  // porque después se ajusten las variables.
  const [[p]] = await pool.query(
    `SELECT anterior FROM bono_jefe_versiones WHERE vigente_desde > ?
      ORDER BY vigente_desde ASC, id ASC LIMIT 1`, [mes]).catch(() => [[null]]);
  if (!p || !p.anterior) return null;
  try { return typeof p.anterior === 'string' ? JSON.parse(p.anterior) : p.anterior; } catch { return null; }
}

function cfgDe(raw) {
  const c = {}; Object.entries(raw || {}).forEach(([k, v]) => { c[k] = parseFloat(v); });
  return {
    creditos_min: c.creditos_min ?? 5, creditos_esperado: c.creditos_esperado ?? 12, pond_creditos: (c.pond_creditos ?? 45) / 100,
    monto_por_op: c.monto_por_op ?? 6800000, pond_montos: (c.pond_montos ?? 40) / 100,
    dealers_min: c.dealers_min ?? 1, dealers_esperado: c.dealers_esperado ?? 2, pond_dealers: (c.pond_dealers ?? 15) / 100,
    score_min: c.score_min ?? 80, score_max: c.score_max ?? 100, pct_variable: (c.pct_variable ?? 55) / 100, k: c.k ?? 0.7,
    sueldo_fijo: c.sueldo_fijo ?? 1500000, factor_semana: c.factor_semana ?? 0.1667,
    semana_calc: c.semana_calc ?? 1,
  };
}
/* Config aplicable: la versión vigente del mes; si no hay ninguna, los valores actuales. */
async function getCfg(mes) {
  return cfgDe((mes && await rawVersion(mes)) || await rawConfig());
}

/* ── Puntajes por pilar (fórmulas idénticas al Excel) ── */
const ptjTramo = (v, min, esp, pond) => v < min ? 0 : (v > esp ? pond * 100 : (v / esp) * pond * 100);
const ptjDealers = (v, min, esp, pond) => Math.min(pond * 100, (v < min ? 0 : v / esp) * pond * 100);   // CON tope en la ponderación (definición Pato 2026-07-06)

/* Curva del premio (hoja "variable"): % adicional sobre el fijo.
   VLOOKUP aproximado del Excel = se busca el puntaje ENTERO (piso). */
function curvaPct(score, cfg) {
  const s = Math.floor(Math.max(0, score));
  if (s <= cfg.score_min) return 0;
  const x = (s - cfg.score_min) / (cfg.score_max - cfg.score_min);
  return cfg.pct_variable * ((Math.exp(cfg.k * x) - 1) / (Math.exp(cfg.k) - 1));
}
/* Semana corrida: motor único shared/semana-corrida.js (art. 45 CT, jornada L-S).
   El incremento depende de los domingos y festivos de CADA mes, no es fijo.
   Con semana_calc = 0 se vuelve al factor_semana configurado. */
function incSemana(mes, cfg) {
  if (!(cfg.semana_calc > 0)) return cfg.factor_semana;
  const inc = SC.incrementoMes(mes, 6);
  return inc == null ? cfg.factor_semana : inc;
}
function premioDe(score, cfg, mes) {
  const pct = curvaPct(score, cfg);
  const variable = Math.round(cfg.sueldo_fijo * pct);
  const factor = incSemana(mes, cfg);
  const semana = Math.round(variable * factor);
  return { score_lookup: Math.floor(Math.max(0, score)), pct_adicional: pct, variable,
           factor_semana_aplicado: factor, semana_corrida: semana,
           total_variable: variable + semana, renta_total: cfg.sueldo_fijo + variable + semana };
}

/* ── Vigencia de la jefatura (v218.12): usuarios.jefatura_desde (YYYY-MM) marca
   desde qué mes alguien es Jefe Comercial medible. En un mes ANTERIOR a esa fecha
   no aparece como jefe y su gente cuenta para el jefe TITULAR (el de jefatura más
   antigua o sin fecha). Caso real: Damaris asume en ago-2026 — la producción de
   julio-2026 es completa de Álvaro y queda cerrada así (Pato 26-08-2026). */
require('../../../../shared/migrate').enFila('bono-jefe-jefatura', async () => {
  await pool.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS jefatura_desde CHAR(7) NULL");
});
require('../../../../shared/migrate').migrar('bono-jefe-jefatura-damaris-v1', async () => {
  const [r] = await pool.query(
    "UPDATE usuarios SET jefatura_desde='2026-08' WHERE nombre LIKE 'Damaris%' AND apellido LIKE 'Sanhueza%'");
  if (!r.affectedRows) console.warn('[bono-jefe] ⚠ seed jefatura Damaris no matcheó ninguna fila — fijar jefatura_desde desde la ficha de Usuarios');
  else console.log(`[bono-jefe] jefatura_desde de Damaris sellada 2026-08 (${r.affectedRows} fila)`);
});

/* ── Jefes Comerciales medibles: quien SUPERVISA (usuarios.id_supervisor) a al
   menos un Ejecutivo Comercial. Cada jefe se mide por SU gente a cargo; la
   línea la define la ficha de Usuarios, no una lista escrita acá. Con `mes`,
   excluye a quien aún no asumía la jefatura ese mes (jefatura_desde). ── */
async function jefesComerciales(mes) {
  const m = /^\d{4}-\d{2}$/.test(mes || '') ? mes : null;
  try {
    const [js] = await pool.query(
      `SELECT j.id_usuario, j.jefatura_desde,
              TRIM(CONCAT(SUBSTRING_INDEX(TRIM(j.nombre),' ',1),' ',SUBSTRING_INDEX(TRIM(j.apellido),' ',1))) AS nombre
         FROM usuarios j
        WHERE j.estado='activo'
          AND EXISTS (SELECT 1 FROM usuarios e JOIN perfiles p ON p.id_perfil=e.id_perfil
                       WHERE e.id_supervisor = j.id_usuario AND p.nombre='Ejecutivo Comercial')
          AND (? IS NULL OR j.jefatura_desde IS NULL OR j.jefatura_desde <= ?)
        ORDER BY nombre`, [m, m]);
    return js;
  } catch (e) {
    if (!e || e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    // Columna jefatura_desde aún no creada (host nuevo, cola de migraciones atrasada)
    // → conducta anterior en vez de tumbar la página.
    const [js] = await pool.query(
      `SELECT j.id_usuario, NULL AS jefatura_desde,
              TRIM(CONCAT(SUBSTRING_INDEX(TRIM(j.nombre),' ',1),' ',SUBSTRING_INDEX(TRIM(j.apellido),' ',1))) AS nombre
         FROM usuarios j
        WHERE j.estado='activo'
          AND EXISTS (SELECT 1 FROM usuarios e JOIN perfiles p ON p.id_perfil=e.id_perfil
                       WHERE e.id_supervisor = j.id_usuario AND p.nombre='Ejecutivo Comercial')
        ORDER BY nombre`);
    return js;
  }
}

/* Titular del mes entre jefes vigentes: jefatura más antigua (sin fecha = más
   antigua que cualquiera); desempate determinista por id_usuario. Es la MISMA
   elección en calcularBSC y en el fallback de getBSC. */
const jefeTitular = js => js.slice().sort((a, b) =>
  String(a.jefatura_desde || '').localeCompare(String(b.jefatura_desde || '')) ||
  (a.id_usuario - b.id_usuario))[0];

/* ── Cálculo central del BSC (lo usan la vista y el informe por correo) ──
   `idJefe`: acota el equipo a los ejecutivos que reportan a ese jefe (ficha de
   Usuarios). Sin idJefe se evalúa el equipo completo (compatibilidad). ── */
async function calcularBSC(mesQ, cfgOverride, idJefe) {
    await SC.asegurarFeriados();
    const mes = /^\d{4}-\d{2}$/.test(mesQ || '') ? mesQ
      : mesChile();
    // La config sale de la VERSIÓN vigente del mes evaluado (no de los valores de hoy):
    // un mes ya calculado no cambia porque después se ajusten las variables.
    const cfg = cfgOverride || await getCfg(mes);

    // Equipo: Ejecutivos Comerciales VIGENTES en el mes evaluado (convención: primer
    // nombre + apellido paterno). Vigencia por la ficha de Usuarios: ingresó a más
    // tardar el último día del mes y no estaba de baja antes de que el mes empezara
    // — así un mes histórico no se diluye con quienes aún no entraban (Pato 2026-08-11).
    /* Jefatura con vigencia: la gente de un jefe que AÚN no asumía en el mes
       evaluado (jefatura_desde posterior) cuenta para el jefe TITULAR de ese mes
       (el de jefatura más antigua o sin fecha). Así julio-2026 queda completo en
       Álvaro aunque hoy la ficha reparta el equipo con Damaris (asume ago-2026). */
    let supervisores = idJefe ? [idJefe] : null;
    if (idJefe) {
      try {
        const [todos] = await pool.query(
          `SELECT j.id_usuario, j.jefatura_desde, j.estado FROM usuarios j
            WHERE EXISTS (SELECT 1 FROM usuarios e JOIN perfiles p ON p.id_perfil=e.id_perfil
                           WHERE e.id_supervisor = j.id_usuario AND p.nombre='Ejecutivo Comercial')`);
        // noVigentes SIN filtro de estado: si el jefe se inactiva después (renuncia),
        // su gente igual rueda al titular en los meses históricos ya cerrados.
        const noVigentes = todos.filter(j => j.jefatura_desde && j.jefatura_desde > mes);
        const vigentes   = todos.filter(j => !j.jefatura_desde || j.jefatura_desde <= mes);
        // Titular entre los vigentes ACTIVOS (un ex-jefe con id_supervisor obsoleto no
        // puede ganar); si no queda ninguno activo (el titular se inactivó después),
        // cae al vigente más antiguo aunque esté inactivo — el mes cerrado no cambia.
        const activos = vigentes.filter(j => j.estado === 'activo');
        const titular = jefeTitular(activos.length ? activos : vigentes);
        if (noVigentes.length && titular && titular.id_usuario === idJefe)
          supervisores = [idJefe, ...noVigentes.map(j => j.id_usuario)];
      } catch (e) {
        if (!e || e.code !== 'ER_BAD_FIELD_ERROR') // sin columna aún → conducta anterior
          console.warn('[bono-jefe] titular del mes no resuelto (queda solo el jefe pedido):', e && e.message);
      }
    }
    const supSql = supervisores ? `u.id_supervisor IN (${supervisores.map(() => '?').join(',')})` : '1=1';
    const [ejs] = await pool.query(
      `SELECT TRIM(CONCAT(SUBSTRING_INDEX(TRIM(u.nombre),' ',1),' ',SUBSTRING_INDEX(TRIM(u.apellido),' ',1))) AS ejecutivo
         FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
        WHERE p.nombre='Ejecutivo Comercial'
          AND (u.estado='activo' OR u.fecha_baja IS NOT NULL)
          AND u.fecha_ingreso IS NOT NULL
          AND u.fecha_ingreso <= LAST_DAY(CONCAT(?,'-01'))
          AND (u.fecha_baja IS NULL OR u.fecha_baja >= CONCAT(?,'-01'))
          AND ${supSql}
        ORDER BY ejecutivo`, [mes, mes, ...(supervisores || [])]);

    /* Mes de atribución (motor único shared/mes-atribucion.js): desde el corte
       manda la fecha de curse; antes, el mes contable ajustado. */
    const ATRIB = require('../../../../shared/mes-atribucion');
    const mesSqlC = ATRIB.MES_SQL(mes, await ATRIB.mesCorte(), '');

    // Pilar 1: créditos OTORGADOS del mes
    const [ing] = await pool.query(
      `SELECT ejecutivo, COUNT(*) n FROM creditos
        WHERE ${mesSqlC}=? AND estado_credito='OTORGADO'
          AND ejecutivo IS NOT NULL AND ejecutivo<>'' GROUP BY ejecutivo`, [mes]);
    // Pilar 2: MONTOS OTORGADOS del mes (solo operaciones cursadas — definición Pato 2026-08-11;
    // antes sumaba también las APROBADAS, lo que no calzaba con el nombre del pilar)
    const [apr] = await pool.query(
      `SELECT ejecutivo, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE ${mesSqlC}=? AND estado_credito='OTORGADO'
          AND ejecutivo IS NOT NULL AND ejecutivo<>'' GROUP BY ejecutivo`, [mes]);
    // Pilar 3: NUEVOS DEALERS CON NEGOCIOS — dealers que CURSARON su PRIMERA operación
    // otorgada de la historia en el mes evaluado (definición Pato 2026-08-11; antes se
    // contaban fichas de incorporación aprobadas, que no prueban que el dealer cursara).
    // Se atribuye al ejecutivo de esa primera operación.
    const [nvd] = await pool.query(
      `SELECT c.ejecutivo, COUNT(DISTINCT t.d) n
         FROM (SELECT COALESCE(NULLIF(TRIM(rut_dealer),''), TRIM(automotora)) d, MIN(mes) pri
                 FROM creditos
                WHERE estado_credito='OTORGADO'
                  AND COALESCE(NULLIF(TRIM(rut_dealer),''), TRIM(automotora)) IS NOT NULL
                  AND COALESCE(NULLIF(TRIM(rut_dealer),''), TRIM(automotora))<>''
                GROUP BY d) t
         JOIN creditos c
           ON COALESCE(NULLIF(TRIM(c.rut_dealer),''), TRIM(c.automotora)) = t.d
          AND c.mes = t.pri AND c.estado_credito='OTORGADO'
        WHERE DATE_FORMAT(t.pri,'%Y-%m')=? AND c.ejecutivo IS NOT NULL AND c.ejecutivo<>''
        GROUP BY c.ejecutivo`, [mes]);   // pilar 3 sigue por `mes`: la "primera op" se ancla al mes contable histórico

    const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
    const keyEj = s => norm(s).split(' ').filter(Boolean).sort().join(' ');
    const mIng = new Map(ing.map(r => [keyEj(r.ejecutivo), Number(r.n)]));
    const mApr = new Map(apr.map(r => [keyEj(r.ejecutivo), Number(r.monto)]));
    const mNvd = new Map(nvd.map(r => [keyEj(r.ejecutivo), Number(r.n)]));

    const minM = cfg.creditos_min * cfg.monto_por_op, espM = cfg.creditos_esperado * cfg.monto_por_op;
    const filas = ejs.map(e => {
      const k = keyEj(e.ejecutivo);
      const E = mIng.get(k) || 0, H = mApr.get(k) || 0, J = mNvd.get(k) || 0;
      return {
        ejecutivo: e.ejecutivo, otorgados: E,
        ptj_creditos: ptjTramo(E, cfg.creditos_min, cfg.creditos_esperado, cfg.pond_creditos),
        monto_aprobado: H,
        ptj_montos: ptjTramo(H, minM, espM, cfg.pond_montos),
        dealers_nuevos: J,
        ptj_dealers: ptjDealers(J, cfg.dealers_min, cfg.dealers_esperado, cfg.pond_dealers),
      };
    }).map(f => ({ ...f, score: f.ptj_creditos + f.ptj_montos + f.ptj_dealers }));

    // Fila PROMEDIO del equipo (como la fila 25 del Excel): promedio de las MÉTRICAS,
    // y sobre ese promedio se recalculan los puntajes
    const n = filas.length || 1;
    const avg = {
      otorgados: filas.reduce((a, f) => a + f.otorgados, 0) / n,
      monto_aprobado: filas.reduce((a, f) => a + f.monto_aprobado, 0) / n,
      dealers_nuevos: filas.reduce((a, f) => a + f.dealers_nuevos, 0) / n,
    };
    avg.ptj_creditos = ptjTramo(avg.otorgados, cfg.creditos_min, cfg.creditos_esperado, cfg.pond_creditos);
    avg.ptj_montos = ptjTramo(avg.monto_aprobado, minM, espM, cfg.pond_montos);
    avg.ptj_dealers = ptjDealers(avg.dealers_nuevos, cfg.dealers_min, cfg.dealers_esperado, cfg.pond_dealers);
    avg.score = avg.ptj_creditos + avg.ptj_montos + avg.ptj_dealers;
    const premio = premioDe(avg.score, cfg, mes);

    // Informe paso a paso (mismo espíritu que el informe de comisiones de ejecutivos)
    const clp = v => '$' + Math.round(v).toLocaleString('es-CL');
    const n2 = v => Number(v).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let nombreJefe = null;
    if (idJefe) {
      const [[jj]] = await pool.query(
        `SELECT TRIM(CONCAT(SUBSTRING_INDEX(TRIM(nombre),' ',1),' ',SUBSTRING_INDEX(TRIM(apellido),' ',1))) AS n
           FROM usuarios WHERE id_usuario=?`, [idJefe]);
      nombreJefe = jj ? jj.n : null;
    }
    const pasos = [
      { titulo: 'Equipo evaluado', detalle: `${filas.length} Ejecutivos Comerciales activos en ${mes}${nombreJefe ? ` que reportan a ${nombreJefe} (según la ficha de Usuarios)` : ''}. El bono del Jefe Comercial se calcula sobre el PROMEDIO de SU equipo, no sobre un ejecutivo individual.` },
      { titulo: `Pilar 1 — Créditos otorgados (pondera ${Math.round(cfg.pond_creditos * 100)}%)`, detalle: `Promedio del equipo: ${n2(avg.otorgados)} créditos otorgados en el mes. Regla: bajo el mínimo (${cfg.creditos_min}) el puntaje es 0; sobre lo esperado (${cfg.creditos_esperado}) se alcanza el máximo del pilar (${n2(cfg.pond_creditos * 100)} pts); entre medio es proporcional → (${n2(avg.otorgados)} ÷ ${cfg.creditos_esperado}) × ${Math.round(cfg.pond_creditos * 100)} = ${n2(avg.ptj_creditos)} pts.` },
      { titulo: `Pilar 2 — Montos Otorgados (pondera ${Math.round(cfg.pond_montos * 100)}%)`, detalle: `Promedio del equipo: ${clp(avg.monto_aprobado)} otorgados en el mes. Umbrales: mínimo ${clp(minM)} (${cfg.creditos_min} ops × ${clp(cfg.monto_por_op)}), esperado ${clp(espM)} (${cfg.creditos_esperado} ops × ${clp(cfg.monto_por_op)}). Puntaje: ${n2(avg.ptj_montos)} pts.` },
      { titulo: `Pilar 3 — Nuevos Dealers con Negocios (pondera ${Math.round(cfg.pond_dealers * 100)}%)`, detalle: `Promedio del equipo: ${n2(avg.dealers_nuevos)} dealers nuevos (dealers que cursaron su PRIMERA operación otorgada de la historia durante ${mes}, atribuidos al ejecutivo de esa operación). Regla: bajo el mínimo (${cfg.dealers_min}) es 0; si no, (valor ÷ ${cfg.dealers_esperado}) × ${Math.round(cfg.pond_dealers * 100)} = ${n2(avg.ptj_dealers)} pts, con tope en ${Math.round(cfg.pond_dealers * 100)} pts.` },
      { titulo: 'Score final del equipo', detalle: `${n2(avg.ptj_creditos)} + ${n2(avg.ptj_montos)} + ${n2(avg.ptj_dealers)} = ${n2(avg.score)} puntos.` },
      { titulo: 'Curva del premio', detalle: premio.pct_adicional === 0
          ? `El score (${n2(avg.score)}, se busca el entero ${premio.score_lookup}) no supera el mínimo de ${cfg.score_min} puntos → el premio del mes es $0. La curva parte a pagar sobre ${cfg.score_min} pts.`
          : `Con score entero ${premio.score_lookup} (mínimo ${cfg.score_min}, máximo ${cfg.score_max}): % adicional = ${Math.round(cfg.pct_variable * 100)}% × (e^(${cfg.k}·x)−1)/(e^${cfg.k}−1) con x=(${premio.score_lookup}−${cfg.score_min})/(${cfg.score_max}−${cfg.score_min}) → ${n2(premio.pct_adicional * 100)}% del sueldo fijo.` },
      { titulo: 'Premio del mes', detalle: `${clp(cfg.sueldo_fijo)} (fijo) × ${n2(premio.pct_adicional * 100)}% = ${clp(premio.variable)} de premio variable. Semana corrida: ${clp(premio.variable)} × ${n2(premio.factor_semana_aplicado * 100)}% = ${clp(premio.semana_corrida)} (art. 45 CT, factor del mes). Total variable: ${clp(premio.total_variable)} → Renta total del mes: ${clp(premio.renta_total)}.` },
    ];

    return { mes, jefe: idJefe || null, jefe_nombre: nombreJefe, params: { ...cfg, min_montos: minM, esperado_montos: espM }, ejecutivos: filas, promedio: avg, premio, pasos };
}

/* ── GET /api/bono-jefe/bsc?mes=YYYY-MM&jefe=<id_usuario> ──
   Sin `jefe` se toma el PRIMER jefe con equipo (hay más de uno desde ago-2026:
   cada jefe se mide por su gente a cargo). `jefe=todos` evalúa el equipo completo. ── */
const getBSC = async (req, res) => {
  try {
    // Mes resuelto UNA vez con el mismo default que calcularBSC: así la lista de
    // jefes y el cálculo nunca miran meses distintos para la misma request.
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? req.query.mes : mesChile();
    const jefes = await jefesComerciales(mes);
    let idJefe = null;
    const q = String(req.query.jefe || '').trim();
    if (q && q !== 'todos') idJefe = parseInt(q, 10) || null;
    else if (!q && jefes.length) idJefe = jefeTitular(jefes).id_usuario;
    // Jefe pedido que NO era jefe ese mes (jefatura_desde posterior, ej. Damaris en
    // julio-2026) → cae al titular del mes en vez de mostrar un equipo fantasma.
    if (idJefe && jefes.length && !jefes.some(j => j.id_usuario === idJefe)) idJefe = jefeTitular(jefes).id_usuario;
    const data = await calcularBSC(mes, null, idJefe);
    data.jefes = jefes;
    res.json({ success: true, data, error: null });
  } catch (e) { console.error('[bono-jefe bsc]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/bono-jefe/enviar-informe {mes} — correo firmado por el Business Suite ── */
const enviarInforme = async (req, res) => {
  try {
    const { enviarCorreo, mailConfigurado } = require('../../../../shared/mailer');
    if (!mailConfigurado()) return res.status(400).json({ success: false, data: null, error: 'El correo del sistema no está configurado (MAIL_*)' });
    const [rows] = await pool.query("SELECT clave, valor FROM bono_jefe_config WHERE clave IN ('informe_para','informe_cc')");
    const cfgMail = {}; rows.forEach(r => { cfgMail[r.clave] = r.valor; });
    const para = String(cfgMail.informe_para || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const cc   = String(cfgMail.informe_cc   || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
    if (!para.length) return res.status(400).json({ success: false, data: null, error: 'Configura los destinatarios (Para) en la pestaña Variables' });

    /* Un BLOQUE por Jefe Comercial: cada uno se mide por SU gente a cargo
       (ficha de Usuarios). Un solo correo con todos los jefes. */
    const mesInf = /^\d{4}-\d{2}$/.test(String(req.body && req.body.mes || '')) ? req.body.mes : mesChile();
    const jefes = await jefesComerciales(mesInf);
    if (!jefes.length) return res.status(400).json({ success: false, data: null, error: 'No hay Jefes Comerciales con equipo asignado en Usuarios' });
    const informes = [];
    for (const jf of jefes) informes.push(await calcularBSC(mesInf, null, jf.id_usuario));
    const d = informes[0];
    const clp = v => '$' + Math.round(v).toLocaleString('es-CL');
    const n2v = v => Number(v).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const [yy, mm] = d.mes.split('-');
    const mesLargo = `${MESES[parseInt(mm,10)-1]} ${yy}`;

    const bloqueDe = dd => { const filasHtml = dd.ejecutivos.map((f, i) => `
      <tr style="background:${i % 2 ? '#f8fafc' : '#fff'}">
        <td style="padding:7px 12px;border-bottom:1px solid #e5e7eb">${f.ejecutivo}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${f.otorgados}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${clp(f.monto_aprobado)}</td>
      </tr>`).join('');
      const a = dd.promedio, pr = dd.premio;
      return `
        <div style="font-size:1rem;font-weight:800;color:#012d70;margin:22px 0 8px;border-bottom:2px solid #dbeafe;padding-bottom:5px">
          ${dd.jefe_nombre || 'Equipo comercial'} — su equipo (${dd.ejecutivos.length})</div>
        <table style="width:100%;border-collapse:collapse;font-size:.9rem;margin-bottom:16px">
          <thead><tr style="background:#eff6ff">
            <th style="padding:8px 12px;text-align:left;color:#0141A2">Ejecutivo Comercial</th>
            <th style="padding:8px 12px;text-align:right;color:#0141A2">Créditos colocados</th>
            <th style="padding:8px 12px;text-align:right;color:#0141A2">Monto otorgado</th>
          </tr></thead>
          <tbody>${filasHtml}
            <tr style="background:#fffbeb;font-weight:800;border-top:2px solid #f59e0b">
              <td style="padding:8px 12px">PROMEDIO DEL EQUIPO</td>
              <td style="padding:8px 12px;text-align:right">${n2v(a.otorgados)}</td>
              <td style="padding:8px 12px;text-align:right">${clp(a.monto_aprobado)}</td>
            </tr>
          </tbody>
        </table>
        <div style="background:#0f2d6b;color:#fff;border-radius:12px;padding:18px 22px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;margin-bottom:18px">
          <div><div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;opacity:.75">Score del equipo</div>
            <div style="font-size:1.5rem;font-weight:900">${n2v(a.score)} pts</div></div>
          <div style="text-align:right"><div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;opacity:.75">Bono bruto del mes (sin semana corrida)</div>
            <div style="font-size:1.5rem;font-weight:900;color:#7dd3fc">${clp(pr.variable)}</div></div>
        </div>`;
    };

    const html = `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:640px;margin:0 auto;color:#1e293b">
        <div style="background:linear-gradient(135deg,#012d70,#0141A2 50%,#009AFE);border-radius:14px;color:#fff;padding:22px 26px;margin-bottom:6px">
          <div style="font-size:1.15rem;font-weight:800">🏆 Bono Jefe Comercial — ${mesLargo}</div>
          <div style="font-size:.85rem;opacity:.85">Balanced Scorecard por Jefe Comercial (cada uno sobre su equipo) · Auto Fácil Crédito Automotriz</div>
        </div>
        ${informes.map(bloqueDe).join('')}
        <div style="font-size:.78rem;color:#64748b;line-height:1.5;margin-top:14px">
          Detalle del cálculo disponible en la app: Soporte → Bono Jefe Comercial (informe paso a paso).<br>
          Pilares: créditos otorgados ${Math.round(d.params.pond_creditos*100)}% · montos aprobados ${Math.round(d.params.pond_montos*100)}% · nuevos dealers ${Math.round(d.params.pond_dealers*100)}%.
        </div>
        <div style="margin-top:18px;padding-top:12px;border-top:1px dashed #cbd5e1;font-size:.78rem;color:#64748b">
          Emitido automáticamente por <b>Auto Fácil Business Suite</b>.
        </div>
      </div>`;
    const resumen = informes.map(x => `${x.jefe_nombre}: score ${n2v(x.promedio.score)} · bono ${clp(x.premio.variable)}`).join(' | ');
    await enviarCorreo({ to: para.join(','), cc: cc.length ? cc.join(',') : undefined,
      subject: `Bono Jefe Comercial — ${mesLargo} (${resumen})`, html });
    auditar({ req, accion: 'ENVIAR', modulo: 'bono-jefe', entidad: 'informe', entidad_id: d.mes,
      detalle: `Informe Bono Jefe Comercial ${d.mes} enviado a ${para.join(', ')}${cc.length ? ' (CC: ' + cc.join(', ') + ')' : ''} — ${resumen}` });
    res.json({ success: true, data: { enviado_a: para, cc, mes: d.mes }, error: null });
  } catch (e) { console.error('[bono-jefe informe]', e); res.status(500).json({ success: false, data: null, error: 'Error enviando el informe' }); }
};

/* ── GET/PUT /api/bono-jefe/variables (restringido) ── */
const getVariables = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT clave, valor, updated_at FROM bono_jefe_config ORDER BY clave');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const setVariables = async (req, res) => {
  try {
    const vars = req.body && req.body.variables;
    if (!vars || typeof vars !== 'object') return res.status(400).json({ success: false, data: null, error: 'variables requeridas' });
    const PERMITIDAS = new Set(CLAVES_MODELO);
    const TEXTO = new Set(['informe_para', 'informe_cc']);   // correos separados por coma

    // ── Vigencia del cambio (obligatoria "desde"; "hasta" vacío = indefinido) ──
    const desde = String(req.body.vigente_desde || '').trim();
    const hasta = String(req.body.vigente_hasta || '').trim();
    if (!/^\d{4}-\d{2}$/.test(desde))
      return res.status(400).json({ success: false, data: null, error: 'Indica el mes DESDE cuándo rige este cambio' });
    if (hasta && !/^\d{4}-\d{2}$/.test(hasta))
      return res.status(400).json({ success: false, data: null, error: 'Mes HASTA inválido' });
    if (hasta && hasta < desde)
      return res.status(400).json({ success: false, data: null, error: 'El mes HASTA no puede ser anterior al DESDE' });
    // Un mes cerrado ya está pagado y contabilizado: sus variables no se tocan.
    const { isMesCerrado } = require('../../../../shared/utils/mes-cerrado');
    if (await isMesCerrado(desde))
      return res.status(400).json({ success: false, data: null, error: `El mes ${desde} está CERRADO: no se permiten cambios de variables sobre meses cerrados` });

    const rawAntes = await rawConfig();
    const cambios = [];
    for (const [k, v] of Object.entries(vars)) {
      if (TEXTO.has(k)) {
        const val = String(v || '').trim().slice(0, 500);
        await pool.query('INSERT INTO bono_jefe_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [k, val]);
        cambios.push(`${k}=${val || '(vacío)'}`);
        continue;
      }
      if (!PERMITIDAS.has(k)) continue;
      const num = parseFloat(v);
      if (!Number.isFinite(num) || num < 0) return res.status(400).json({ success: false, data: null, error: `Valor inválido para ${k}` });
      await pool.query('UPDATE bono_jefe_config SET valor=? WHERE clave=?', [String(num), k]);
      cambios.push(`${k}=${num}`);
    }
    // ── Versión + bitácora (append-only) ──
    const rawDespues = await rawConfig();
    const antes = {}, despues = {}, difs = [];
    for (const k of CLAVES_MODELO) {
      antes[k] = rawAntes[k]; despues[k] = rawDespues[k];
      if (String(rawAntes[k] ?? '') !== String(rawDespues[k] ?? '')) difs.push(k);
    }
    // Efecto en el bono: mismo mes y mismas métricas, config vieja vs nueva.
    let bonoAntes = null, bonoDespues = null, mesSim = desde;
    try {
      const a = await calcularBSC(mesSim, cfgDe(rawAntes));
      const d = await calcularBSC(mesSim, cfgDe(rawDespues));
      bonoAntes = Math.round(a.premio.total_variable);
      bonoDespues = Math.round(d.premio.total_variable);
    } catch (e) { console.error('[bono-jefe simulación]', e.message); }

    const nom = [req.usuario?.nombre, req.usuario?.apellido].filter(Boolean).join(' ') || req.usuario?.email || 'Sistema';
    await pool.query(
      `INSERT INTO bono_jefe_versiones (vigente_desde, vigente_hasta, valores, anterior, n_cambios,
         bono_antes, bono_despues, mes_simulado, id_usuario, usuario_nombre)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [desde, hasta || null, JSON.stringify(despues), JSON.stringify(antes), difs.length,
       bonoAntes, bonoDespues, mesSim, req.usuario?.id_usuario || null, nom]);

    auditar({ req, accion: 'EDITAR', modulo: 'bono-jefe', entidad: 'variables', entidad_id: 1,
      detalle: `Variables BSC Jefe Comercial (vigencia ${desde} → ${hasta || 'indefinido'}): ${cambios.join(', ')}` });
    res.json({ success: true, data: { cambios, vigente_desde: desde, vigente_hasta: hasta || null, n_cambios: difs.length }, error: null });
  } catch (e) { console.error('[bono-jefe vars]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/bono-jefe/curva — tabla score→premio para la vista Variables ── */
const getCurva = async (req, res) => {
  try {
    await SC.asegurarFeriados();
    const cfg = await getCfg();
    const filas = [];
    const mesTabla = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    for (let s = cfg.score_min - 5; s <= cfg.score_max + 10; s++) filas.push({ score: s, ...premioDe(s, cfg, mesTabla) });
    res.json({ success: true, data: { cfg, filas }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── BITÁCORA DE CAMBIOS (solo lectura; no existe endpoint que edite o borre) ── */
const ETIQUETAS = {
  creditos_min: 'Créditos — mínimo', creditos_esperado: 'Créditos — esperado', pond_creditos: 'Ponderación Créditos',
  monto_por_op: 'Monto por operación', pond_montos: 'Ponderación Montos',
  dealers_min: 'Dealers — mínimo', dealers_esperado: 'Dealers — esperado', pond_dealers: 'Ponderación Dealers',
  score_min: 'Score mínimo', score_max: 'Score máximo', pct_variable: '% variable máximo', k: 'k (curvatura)',
  sueldo_fijo: 'Sueldo fijo', factor_semana: 'Semana corrida', semana_calc: 'Semana corrida calculada',
};
const PESOS = new Set(['monto_por_op', 'sueldo_fijo']);
const PCTS  = new Set(['pond_creditos', 'pond_montos', 'pond_dealers', 'pct_variable']);

const getBitacora = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, created_at, usuario_nombre, n_cambios, vigente_desde, vigente_hasta,
              bono_antes, bono_despues, mes_simulado
         FROM bono_jefe_versiones ORDER BY id DESC LIMIT 500`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[bono-jefe bitacora]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const getBitacoraDetalle = async (req, res) => {
  try {
    const [[v]] = await pool.query('SELECT * FROM bono_jefe_versiones WHERE id=? LIMIT 1', [req.params.id]);
    if (!v) return res.status(404).json({ success: false, data: null, error: 'Registro no encontrado' });
    const par = x => { try { return typeof x === 'string' ? JSON.parse(x) : (x || {}); } catch { return {}; } };
    const antes = par(v.anterior), despues = par(v.valores);
    const detalle = CLAVES_MODELO.map(k => ({
      clave: k, etiqueta: ETIQUETAS[k] || k, formato: PESOS.has(k) ? 'peso' : (PCTS.has(k) ? 'pct' : 'num'),
      antes: antes[k] ?? null, despues: despues[k] ?? null,
      cambio: String(antes[k] ?? '') !== String(despues[k] ?? ''),
    }));
    res.json({ success: true, data: {
      id: v.id, created_at: v.created_at, usuario_nombre: v.usuario_nombre, n_cambios: v.n_cambios,
      vigente_desde: v.vigente_desde, vigente_hasta: v.vigente_hasta, mes_simulado: v.mes_simulado,
      bono_antes: v.bono_antes, bono_despues: v.bono_despues,
      bono_diferencia: (v.bono_despues == null || v.bono_antes == null) ? null : v.bono_despues - v.bono_antes,
      detalle,
    }, error: null });
  } catch (e) { console.error('[bono-jefe bitacora det]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getBSC, getVariables, setVariables, getCurva, enviarInforme, getBitacora, getBitacoraDetalle };
