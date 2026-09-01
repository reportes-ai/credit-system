const { programar } = require('../../../../shared/scheduler.js');
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ── Migraciones ─────────────────────────────────────────────────────────── */
// Marca manual "cliente independiente" por operación: el seguro de cesantía no
// cubre independientes → la op sale de la BASE del cruce de cesantía (motor
// shared/comision-ejecutivo.js). Se marca desde Revisión de Comisiones.
require('../../../../shared/migrate').enFila('creditos-cliente-independiente', async () => {
  await pool.query("ALTER TABLE creditos ADD COLUMN IF NOT EXISTS cliente_independiente TINYINT(1) NOT NULL DEFAULT 0").catch(() => {});
});
require('../../../../shared/migrate').enFila('comisiones', async () => {
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
      ['pct_24',        0.0075, '% base < 24 cuotas',             'Tasa aplicada al monto financiado con plazo MENOR a 24 meses',     'porcentaje'],
      ['pct_mas24',     0.0100, '% base ≥ 24 cuotas',             'Tasa aplicada al monto financiado con plazo IGUAL O MAYOR a 24 meses', 'porcentaje'],
      ['minimo_monto',  35000000,'Mínimo monto mes (CLP)',          'Si el total financiado del mes es menor a este valor, no hay bono','monto'],
      ['factor_max',    0.66,   'Factor ajuste máximo',            'Cap máximo del factor de ajuste total (suma de los tres pesos)',   'factor'],
      ['peso_rdh',      0.33,   'Peso cruce RDH',                  'Peso del indicador de cruce de seguro RDH (incluye desgravamen) en el ajuste', 'factor'],
      ['peso_cesantia', 0.34,   'Peso cruce cesantía',             'Peso del indicador de cruce de seguro cesantía en el ajuste',     'factor'],
      ['peso_rep',      0.33,   'Peso cruce reparaciones',         'Peso del indicador de cruce de seguro reparaciones en el ajuste', 'factor'],
      ['peso_calidad',  0.00,   'Peso calidad',                    'Peso del indicador de calidad en el ajuste (0 = fuera del modelo, anexo 08-2026)', 'factor'],
      ['meta_unidad',   3,      'Meta créditos UNIDAD (calidad)',  'TODO O NADA: con esta cantidad de créditos UNIDAD DE CRÉDITO en el mes el indicador de calidad vale 100%; con menos vale 0%', 'factor'],
      ['umbral_rdh',    0.99,   'Umbral mínimo RDH',               'Si el cruce es ≤ este valor el aporte de RDH es 0',               'porcentaje'],
      ['umbral_cesantia',0.65,  'Umbral mínimo cesantía',          'Si el cruce es ≤ este valor el aporte de cesantía es 0',          'porcentaje'],
      ['umbral_rep',    0.55,   'Umbral mínimo reparaciones',      'Si el cruce es ≤ este valor el aporte de reparaciones es 0',      'porcentaje'],
      ['semana_corrida_calc', 1, 'Semana corrida calculada (1=sí, 0=no)', 'Con 1 se calcula por mes según art. 45 CT: 1 + (domingos+festivos)/(días lunes a sábado hábiles). Con 0 se usa el multiplicador fijo de abajo', 'factor'],
      ['semana_corrida',1.1667, 'Multiplicador semana corrida (modo fijo)',    'Incentivo final × 1,1667 = +16,67% por semana corrida (mismo % que el Bono Jefe Comercial)', 'multiplicador'],
      // Cláusula novena del anexo: descuentos por prepago y anulación
      ['dctos_activo',   1,     'Descontar prepagos y anulaciones (1=sí, 0=no)', 'Con 1 se descuenta la comisión ya pagada de las operaciones que se prepagan o anulan (cláusula novena del anexo)', 'factor'],
      ['dcto_meses_t1',  3,     'Prepago — meses tramo 1',         'Prepagos hasta este mes, contado desde el vencimiento de la primera cuota, descuentan el % del tramo 1', 'factor'],
      ['dcto_pct_t1',    1.00,  'Prepago — % descuento tramo 1',   'Porcentaje de la comisión pagada que se descuenta en el tramo 1 (1,00 = 100%)', 'porcentaje'],
      ['dcto_meses_t2',  6,     'Prepago — meses tramo 2',         'Prepagos hasta este mes descuentan el % del tramo 2. Después de este mes no hay descuento', 'factor'],
      ['dcto_pct_t2',    0.50,  'Prepago — % descuento tramo 2',   'Porcentaje de la comisión pagada que se descuenta en el tramo 2 (0,50 = 50%)', 'porcentaje'],
      ['dcto_pct_anul',  1.00,  'Anulación — % descuento',         'Porcentaje que se descuenta cuando la operación se anula, sin importar cuándo (1,00 = 100%)', 'porcentaje'],
    ];
    for (const [clave, valor, etiqueta, descripcion, tipo] of defaults) {
      await pool.query(
        `INSERT IGNORE INTO comisiones_variables (clave, valor, etiqueta, descripcion, tipo) VALUES (?,?,?,?,?)`,
        [clave, valor, etiqueta, descripcion, tipo]
      );
    }

    // BITÁCORA DE CAMBIOS = versiones de las variables. Append-only: no existe
    // endpoint que la edite ni la borre; el rango de vigencia se resuelve al leer.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comisiones_variables_versiones (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        vigente_desde  CHAR(7) NOT NULL,
        vigente_hasta  CHAR(7) NULL,
        valores        JSON NOT NULL,
        anterior       JSON NULL,
        n_cambios      INT DEFAULT 0,
        total_antes    BIGINT NULL,
        total_despues  BIGINT NULL,
        mes_simulado   CHAR(7) NULL,
        id_usuario     INT NULL,
        usuario_nombre VARCHAR(160),
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cvv_vig (vigente_desde, vigente_hasta)
      )`);
    // Permiso propio para ver la bitácora (se designa desde la matriz de Perfiles)
    const [[modC]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/comisiones/' LIMIT 1");
    if (modC) await pool.query(`INSERT INTO funcionalidades (id_modulo, codigo, nombre, href, icono)
        SELECT ?, 'comisiones_variables_bitacora', 'Bitácora de Cambios Variables Comisiones', NULL, NULL
        WHERE NOT EXISTS (SELECT 1 FROM funcionalidades WHERE codigo='comisiones_variables_bitacora')`, [modC.id_modulo]);

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
    // Segunda etapa: respuesta del ejecutivo (acepta / envía a revisión con comentario)
    for (const col of ["ejec_estado VARCHAR(20) DEFAULT 'pendiente'", 'ejec_comentario TEXT', 'ejec_por INT DEFAULT NULL', 'ejec_at DATETIME DEFAULT NULL']) {
      try { await pool.query(`ALTER TABLE comisiones_aprobaciones ADD COLUMN IF NOT EXISTS ${col}`); } catch (e) {}
    }
  } catch (e) {
    console.error('[comisiones migration]', e.message);
  }
});

/* Anexo de remuneración variable (vigencia 08-2026): el mínimo mensual habilitante sube
   de $30.000.000 a $35.000.000. El seed de arriba es INSERT IGNORE y no toca la fila ya
   existente, por eso se actualiza acá una sola vez. Va FUERA del enFila anterior porque
   migrar() encola en la misma cadena: llamarlo (y esperarlo) dentro sería un deadlock. */
require('../../../../shared/migrate').migrarAuto('comisiones_anexo_2026_08', async () => {
  await pool.query(
    "UPDATE comisiones_variables SET valor = 35000000 WHERE clave = 'minimo_monto' AND valor = 30000000"
  );
  // El tramo de 24 meses exactos pasa a pagar la tasa mayor: se corrigen las etiquetas
  // que decían "≤ 24" / "> 24" (el seed es INSERT IGNORE y no toca filas existentes).
  await pool.query(
    "UPDATE comisiones_variables SET etiqueta = '% base < 24 cuotas', descripcion = 'Tasa aplicada al monto financiado con plazo MENOR a 24 meses' WHERE clave = 'pct_24'"
  );
  await pool.query(
    "UPDATE comisiones_variables SET etiqueta = '% base ≥ 24 cuotas', descripcion = 'Tasa aplicada al monto financiado con plazo IGUAL O MAYOR a 24 meses' WHERE clave = 'pct_mas24'"
  );
  // Calidad pasa a TODO O NADA: la meta es exigencia, no divisor (antes 1 de 3 ops pagaba 33%).
  await pool.query(
    "UPDATE comisiones_variables SET descripcion = 'TODO O NADA: con esta cantidad de créditos UNIDAD DE CRÉDITO en el mes el indicador de calidad vale 100%; con menos vale 0%' WHERE clave = 'meta_unidad'"
  );
});

/* Modelo de 3 seguros (anexo 08-2026): entra RDH como tercer indicador y sale Calidad.
   Pesos RDH 33% · Cesantía 34% · Reparaciones 33% (suman 100%), umbrales 99/65/55.
   Calidad queda con peso 0: sigue calculándose y visible, pero no aporta al factor;
   para reactivarla basta darle peso en el mantenedor. */
require('../../../../shared/migrate').migrarAuto('comisiones_3seguros_rdh', async () => {
  const nuevos = {
    peso_rdh: 0.33, peso_cesantia: 0.34, peso_rep: 0.33, peso_calidad: 0,
    umbral_rdh: 0.99, umbral_rep: 0.55,
  };
  for (const [clave, valor] of Object.entries(nuevos)) {
    await pool.query('UPDATE comisiones_variables SET valor = ? WHERE clave = ?', [valor, clave]);
  }
});

/* ═══ Alertas del flujo de aprobación de comisiones (paramétricas) ═══════════
   - com_rev_aprobada_ops : Operaciones aprobó → avisa al ejecutivo (espera su OK)
   - com_rev_devuelta     : Ejecutivo NO está de acuerdo → avisa a Operaciones
   - com_rev_auto         : Sin respuesta en N días hábiles → aprobada por el Sistema */
const COM_PLAZO_DIAS_HABILES = 2;
const EVENTOS_REV = [
  { evento:'com_rev_aprobada_ops', titulo:'Comisiones aprobadas por Operaciones — esperan tu aprobación',
    mensaje:'Tus comisiones para pago en {mesPago} están aprobadas por Operaciones y esperan tu aprobación. Si no respondes en 2 días hábiles, quedarán aprobadas por el Sistema.', href:'/comisiones/revision/' },
  { evento:'com_rev_devuelta', titulo:'Comisiones devueltas para revisión',
    mensaje:'Las comisiones de {ejecutivo} ({mesProd}) han sido devueltas para revisión.', href:'/comisiones/revision/' },
  { evento:'com_rev_auto', titulo:'Comisiones aprobadas por el Sistema',
    mensaje:'Tus comisiones de {mesProd} quedaron aprobadas por el Sistema (sin respuesta en 2 días hábiles).', href:'/comisiones/revision/' },
];
const SONIDOS = ['campana','dingdong','alarma','aplausos'];
require('../../../../shared/migrate').enFila('comisiones', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS comisiones_alertas_config (
      evento VARCHAR(40) PRIMARY KEY, perfiles TEXT, incluir_ejecutivo TINYINT(1) NOT NULL DEFAULT 0,
      usuarios_extra TEXT, activo TINYINT(1) NOT NULL DEFAULT 1, prioridad VARCHAR(10) NOT NULL DEFAULT 'normal',
      sonido TINYINT(1) NOT NULL DEFAULT 1, sonido_tipo VARCHAR(20) NOT NULL DEFAULT 'campana',
      sonido_cada_seg INT NOT NULL DEFAULT 30, sonido_max_min INT NOT NULL DEFAULT 5 )`);
    const seed = {
      com_rev_aprobada_ops: { perfiles:'', incluir:1, prioridad:'alta' },
      com_rev_devuelta:     { perfiles:'Administrador,Analista de Operaciones', incluir:0, prioridad:'alta' },
      com_rev_auto:         { perfiles:'Administrador', incluir:1, prioridad:'normal' },
    };
    for (const e of EVENTOS_REV) {
      const s = seed[e.evento];
      await pool.query(
        `INSERT IGNORE INTO comisiones_alertas_config (evento, perfiles, incluir_ejecutivo, usuarios_extra, activo, prioridad)
         VALUES (?,?,?,?,1,?)`, [e.evento, s.perfiles, s.incluir, '', s.prioridad]);
    }
    // Migración de default (una vez): la devolución también avisa a Analista de
    // Operaciones. Solo toca la fila si sigue en el default viejo (respeta cambios del Admin).
    await pool.query(
      `UPDATE comisiones_alertas_config SET perfiles='Administrador,Analista de Operaciones'
       WHERE evento='com_rev_devuelta' AND perfiles='Administrador'`).catch(()=>{});
    console.log('[comisiones] alertas_config OK');
  } catch (e) { console.error('[comisiones alertas migration]', e.message); }
});

const { sumarDiasHabiles } = require('../../../../shared/feriados');
/* Comisión del ejecutivo: motor único en shared/comision-ejecutivo.js. Vivía acá;
   se movió para poder probarlo sin levantar la BD (auditoría 03-08-2026, B-3). */
const { calcularComision, factorSemanaCorrida } = require('../../../../shared/comision-ejecutivo');
const SC = require('../../../../shared/semana-corrida');  // días hábiles = sin fines de semana ni feriados chilenos
const MESES_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const mesNombre     = ym => { const [y,m]=String(ym).split('-'); return `${MESES_ES[parseInt(m)-1]} de ${y}`; };
const mesPagoNombre = ym => { let [y,m]=String(ym).split('-').map(Number); m++; if(m>12){m=1;y++;} return `${MESES_ES[m-1]} de ${y}`; };

// Crea las notificaciones (campana) de un evento del flujo de revisión.
async function notificarComisionRev(evento, { ejecutivo, mes } = {}) {
  try {
    const def = EVENTOS_REV.find(e => e.evento === evento);
    if (!def) return;
    const [[cfg]] = await pool.query('SELECT * FROM comisiones_alertas_config WHERE evento=?', [evento]);
    if (!cfg || !cfg.activo) return;
    const ids = new Set();
    const perfiles = String(cfg.perfiles||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (perfiles.length) {
      const [us] = await pool.query(
        `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
         WHERE p.nombre IN (?) AND (u.estado IS NULL OR u.estado<>'inactivo')`, [perfiles]);
      us.forEach(u=>ids.add(u.id_usuario));
    }
    if (cfg.incluir_ejecutivo && ejecutivo) {
      try { const [us] = await pool.query('SELECT id_usuario FROM usuario_ejecutivos WHERE ejecutivo=?', [ejecutivo]); us.forEach(u=>ids.add(u.id_usuario)); } catch(_){}
    }
    String(cfg.usuarios_extra||'').split(',').map(s=>parseInt(s.trim())).filter(Boolean).forEach(id=>ids.add(id));
    if (!ids.size) return;
    let dest = [...ids];
    try { dest = await require('../../../../shared/backups').expandirAlerta(dest); } catch(_){}
    const mensaje = def.mensaje.replace('{mesPago}', mesPagoNombre(mes)).replace('{mesProd}', mesNombre(mes)).replace('{ejecutivo}', ejecutivo||'');
    const clave = `comrev:${evento}:${ejecutivo||''}:${mes}`;
    const sonTipo = SONIDOS.includes(cfg.sonido_tipo) ? cfg.sonido_tipo : 'campana';
    for (const uid of dest) {
      const [[ex]] = await pool.query('SELECT 1 FROM notificaciones WHERE id_usuario=? AND clave=? AND leida=0 LIMIT 1', [uid, clave]);
      if (ex) continue;
      await pool.query(
        `INSERT INTO notificaciones (id_usuario, tipo, titulo, mensaje, href, clave, prioridad, sonar, son_cada, son_max, son_tipo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [uid,'alerta',def.titulo,mensaje,def.href,clave,cfg.prioridad||'normal',cfg.sonido?1:0,cfg.sonido_cada_seg||30,cfg.sonido_max_min||5,sonTipo]);
    }
  } catch (e) { console.error('[notificarComisionRev]', evento, e.message); }
}

// Auto-aprobación: comisión aprobada por Operaciones sin respuesta del ejecutivo
// tras N días hábiles → queda 'aceptado' por el Sistema (ejec_por NULL). Corre periódicamente.
async function autoAprobarComisiones() {
  try {
    const [rows] = await pool.query(
      `SELECT ejecutivo, mes, aprobado_at FROM comisiones_aprobaciones
       WHERE estado='aprobado' AND (ejec_estado IS NULL OR ejec_estado='pendiente') AND aprobado_at IS NOT NULL`);
    const ahora = new Date();
    for (const r of rows) {
      if (ahora >= sumarDiasHabiles(r.aprobado_at, COM_PLAZO_DIAS_HABILES)) {
        await pool.query(
          `UPDATE comisiones_aprobaciones SET ejec_estado='aceptado', ejec_comentario=NULL, ejec_por=NULL, ejec_at=NOW()
           WHERE ejecutivo=? AND mes=? AND estado='aprobado' AND (ejec_estado IS NULL OR ejec_estado='pendiente')`,
          [r.ejecutivo, r.mes]);
        await notificarComisionRev('com_rev_auto', { ejecutivo: r.ejecutivo, mes: r.mes });
        auditar({ accion: 'APROBAR', modulo: 'comisiones', entidad: 'comision', entidad_id: `${r.ejecutivo}|${r.mes}`,
          detalle: `Comisión de ${r.ejecutivo} (${r.mes}) aprobada automáticamente por el Sistema (sin respuesta del ejecutivo en ${COM_PLAZO_DIAS_HABILES} días hábiles)` });
      }
    }
  } catch (e) { console.error('[autoAprobarComisiones]', e.message); }
}
programar('comisiones-auto-aprobar', autoAprobarComisiones, 30 * 60 * 1000, { arranqueMs: 20000 });

/* ── Helpers ─────────────────────────────────────────────────────────────── */
async function getVars(mes) {
  const ver = mes ? await varsVersion(mes) : null;
  if (ver) { const v = {}; Object.entries(ver).forEach(([k, x]) => { v[k] = parseFloat(x); }); return v; }
  const [rows] = await pool.query('SELECT clave, valor FROM comisiones_variables');
  const v = {};
  rows.forEach(r => { v[r.clave] = parseFloat(r.valor); });
  return v;
}
/* Versión de variables vigente para un mes. Igual que en el Bono Jefe Comercial:
   las versiones NO se editan (la bitácora es inmutable), el rango se resuelve al
   leer, y un mes anterior a la primera versión conserva las variables que tenía. */
async function varsVersion(mes) {
  if (!/^\d{4}-\d{2}$/.test(mes || '')) return null;
  const par = x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };
  const [[v]] = await pool.query(
    `SELECT valores FROM comisiones_variables_versiones
      WHERE vigente_desde <= ? AND (vigente_hasta IS NULL OR vigente_hasta >= ?)
      ORDER BY vigente_desde DESC, id DESC LIMIT 1`, [mes, mes]).catch(() => [[null]]);
  if (v) return par(v.valores);
  const [[p]] = await pool.query(
    `SELECT anterior FROM comisiones_variables_versiones WHERE vigente_desde > ?
      ORDER BY vigente_desde ASC, id ASC LIMIT 1`, [mes]).catch(() => [[null]]);
  return p && p.anterior ? par(p.anterior) : null;
}

/* ═══ DESCUENTOS POR PREPAGO Y ANULACIÓN (cláusula novena del anexo) ═══════════
   La comisión se paga al otorgar, pero si la operación muere temprano la Empresa
   nunca alcanza a ganar lo que la originó. El anexo lo devuelve así:

     · prepagada íntegramente hasta el 3er mes contado desde el VENCIMIENTO DE LA
       PRIMERA CUOTA  → se descuenta el 100% de la comisión pagada por esa operación
     · prepagada hasta el 6º mes                            → se descuenta el 50%
     · anulada, cualquiera sea la fecha                     → se descuenta el 100%

   El descuento se imputa al mes SIGUIENTE al del hecho: cuando la operación se
   prepaga o anula, la comisión del mes en curso ya está calculada y camino a
   pago, así que la reversa entra en la liquidación siguiente. No se reabre
   ningún mes cerrado. Por eso el cálculo es determinista e idempotente —
   recalcular cualquier mes da siempre lo mismo, sin tabla de control ni riesgo
   de descontar dos veces.

   Solo se revierten operaciones que efectivamente fueron OTORGADAS: si nunca
   llegó a otorgarse, nunca hubo comisión que devolver.

   Fecha del hecho: anulación → creditos.fecha_estado · prepago → última
   cuotas_credito.fecha_pago (la misma fuente que usa el certificado de prepago).
   Todos los tramos y porcentajes son paramétricos (mantenedor de Variables).  */

/* Fecha a medianoche LOCAL. new Date('2026-02-05') se parsea como UTC y en Chile
   (-04) retrocede al día 4: con eso los cortes de tramo salían un día antes. */
function fechaLocal(f) {
  if (f instanceof Date) return new Date(f.getFullYear(), f.getMonth(), f.getDate());
  const [y, m, d] = String(f).slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/* Mes calendario anterior a un 'YYYY-MM'. */
function mesAnterior(ym) {
  let [y, m] = String(ym).split('-').map(Number);
  m--; if (m < 1) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/* Meses COMPLETOS transcurridos entre dos fechas (25-ene → 25-abr = 3). Informativo. */
function mesesEntre(desde, hasta) {
  const a = fechaLocal(desde), b = fechaLocal(hasta);
  if (isNaN(a) || isNaN(b)) return null;
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m--;
  return m;
}

/* Suma meses a una fecha. El tramo del contrato es una FECHA de corte, no un
   conteo redondeado: "hasta el tercer mes contado desde el vencimiento de la
   primera cuota" con 1ª cuota el 05-02 vence el 05-05, no el 31-05. Si el día
   no existe en el mes destino (31-ene + 1 mes) se toma el último día del mes. */
function sumarMeses(fecha, meses) {
  const d = fechaLocal(fecha), dia = d.getDate();
  const r = new Date(d.getFullYear(), d.getMonth() + meses, 1);
  r.setDate(Math.min(dia, new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate()));
  return r;
}

/* Factor de ajuste que tenía el ejecutivo en el mes en que se devengó la comisión.
   Se recalcula con los datos vigentes de ese mes; memo por mes para no repetir la
   query cuando varias operaciones del mismo origen caen en el mismo descuento. */
function fabricaFactorOrigen(vars) {
  const cache = new Map();
  return async function factorOrigen(mesOrigen, ejecutivo) {
    if (!cache.has(mesOrigen)) {
      const [rows] = await pool.query(
        `SELECT ejecutivo, estado_credito, financiera, producto, monto_financiado, plazo,
                seguro_cesantia, seguro_rep_menor, seguro_rdh
         FROM creditos
         WHERE DATE_FORMAT(COALESCE(fecha_otorgado, mes), '%Y-%m') = ?
           AND ejecutivo IS NOT NULL AND ejecutivo != ''`, [mesOrigen]);
      const porEj = {};
      rows.forEach(r => { (porEj[r.ejecutivo] = porEj[r.ejecutivo] || []).push(r); });
      const factores = {};
      for (const [ej, creds] of Object.entries(porEj)) {
        const c = calcularComision(creds, vars, mesOrigen);
        factores[ej] = { factor_ajuste: c.factor_ajuste || 0, factor_sc: c.factor_semana_corrida || factorSemanaCorrida(mesOrigen, vars) };
      }
      cache.set(mesOrigen, factores);
    }
    return cache.get(mesOrigen)[ejecutivo] || { factor_ajuste: 0, factor_sc: factorSemanaCorrida(mesOrigen, vars) };
  };
}

/* Descuentos que corresponde imputar al mes `mes`, agrupados por ejecutivo. */
async function descuentosDelMes(mes, vars) {
  const porEjecutivo = {};
  if (!(vars.dctos_activo > 0)) return porEjecutivo;

  // El hecho ocurre un mes y se revierte al siguiente: para el mes que se está
  // calculando, se buscan los prepagos y anulaciones del mes anterior.
  const mesHecho = mesAnterior(mes);

  // Operaciones OTORGADAS que murieron en el mes del hecho y que ya devengaron
  // comisión en un mes anterior. Las anuladas dentro de su propio mes de
  // otorgamiento no entran: salen del cálculo de ese mes, nunca se pagaron.
  //   · prepagadas → siguen siendo OTORGADO, con la cartera en PREPAGADO
  //   · anuladas   → el estado pasó a ANULADO y pisó el OTORGADO, así que la
  //     prueba de que se otorgó (y se comisionó) es tener fecha_otorgado
  const [ops] = await pool.query(
    `SELECT c.num_op, c.ejecutivo, c.monto_financiado, c.plazo,
            c.fecha_otorgado, c.fecha_primera_cuota, c.fecha_estado,
            UPPER(COALESCE(c.estado_credito,'')) AS estado_credito,
            UPPER(COALESCE(c.estado_cartera,''))  AS estado_cartera,
            (SELECT MAX(q.fecha_pago) FROM cuotas_credito q WHERE q.id_credito = c.id) AS fecha_ult_pago
     FROM creditos c
     WHERE c.ejecutivo IS NOT NULL AND c.ejecutivo != ''
       AND c.fecha_otorgado IS NOT NULL
       AND DATE_FORMAT(c.fecha_otorgado, '%Y-%m') <= ?
       AND (UPPER(COALESCE(c.estado_credito,'')) = 'ANULADO'
         OR (UPPER(COALESCE(c.estado_cartera,'')) = 'PREPAGADO'
             AND UPPER(COALESCE(c.estado_credito,'')) = 'OTORGADO'))`, [mesHecho]);

  const factorOrigen = fabricaFactorOrigen(vars);
  const MES_T1 = vars.dcto_meses_t1 > 0 ? vars.dcto_meses_t1 : 3;
  const MES_T2 = vars.dcto_meses_t2 > 0 ? vars.dcto_meses_t2 : 6;
  const ymd = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

  for (const o of ops) {
    const anulada = o.estado_credito === 'ANULADO';
    const fechaHecho = anulada ? o.fecha_estado : (o.fecha_ult_pago || o.fecha_estado);
    if (!fechaHecho || ymd(fechaHecho).slice(0, 7) !== mesHecho) continue;
    const mesOrigen = ymd(o.fecha_otorgado).slice(0, 7);
    // Anulada dentro de su propio mes de otorgamiento: nunca se comisionó.
    if (anulada && mesOrigen >= mesHecho) continue;

    let pct = 0, meses = null, revisar = null;
    if (anulada) {
      pct = vars.dcto_pct_anul != null ? vars.dcto_pct_anul : 1;
    } else if (!o.fecha_primera_cuota) {
      // Sin la fecha de referencia que exige el contrato no hay tramo posible.
      // Se informa para revisión manual en vez de arriesgar un cobro indebido.
      revisar = 'Sin fecha de vencimiento de la primera cuota: no se puede determinar el tramo';
    } else {
      meses = mesesEntre(o.fecha_primera_cuota, fechaHecho);
      const hecho = fechaLocal(ymd(fechaHecho));
      if      (hecho <= sumarMeses(o.fecha_primera_cuota, MES_T1)) pct = vars.dcto_pct_t1 != null ? vars.dcto_pct_t1 : 1;
      else if (hecho <= sumarMeses(o.fecha_primera_cuota, MES_T2)) pct = vars.dcto_pct_t2 != null ? vars.dcto_pct_t2 : 0.5;
      else                                                         pct = 0;   // fuera de plazo: no se descuenta
    }

    const { factor_ajuste, factor_sc } = await factorOrigen(mesOrigen, o.ejecutivo);
    const monto = parseFloat(o.monto_financiado) || 0;
    const base  = monto * (parseInt(o.plazo) < 24 ? vars.pct_24 : vars.pct_mas24);
    // Lo efectivamente pagado por esa operación: base + su ajuste, con la semana
    // corrida del mes de origen (así se devuelve lo mismo que se pagó, no menos).
    const comision_original = base * (1 + factor_ajuste) * factor_sc;
    const descuento = revisar ? 0 : comision_original * pct;

    (porEjecutivo[o.ejecutivo] = porEjecutivo[o.ejecutivo] || []).push({
      num_op: o.num_op, tipo: anulada ? 'ANULADA' : 'PREPAGADA',
      // Glosa con la que la reversa aparece en la liquidación de sueldo
      glosa: `Reversa comisión pagada OP${o.num_op} ${anulada ? 'Anulación' : 'Prepago'}`,
      fecha_hecho: ymd(fechaHecho), mes_origen: mesOrigen,
      fecha_primera_cuota: ymd(o.fecha_primera_cuota),
      meses_transcurridos: meses, monto_financiado: monto, plazo: parseInt(o.plazo) || null,
      pct_descuento: pct, comision_original, descuento, revisar,
    });
  }
  return porEjecutivo;
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
    const { vigente_desde: desdeRaw, vigente_hasta: hastaRaw, variables, ...resto } = req.body || {};
    const updates = (variables && typeof variables === 'object') ? variables : resto;   // { clave: valor, ... }

    // ── Vigencia del cambio (obligatoria "desde"; "hasta" vacío = indefinido) ──
    const desde = String(desdeRaw || '').trim();
    const hasta = String(hastaRaw || '').trim();
    if (!/^\d{4}-\d{2}$/.test(desde))
      return res.status(400).json({ success: false, data: null, error: 'Indica el mes DESDE cuándo rige este cambio' });
    if (hasta && !/^\d{4}-\d{2}$/.test(hasta))
      return res.status(400).json({ success: false, data: null, error: 'Mes HASTA inválido' });
    if (hasta && hasta < desde)
      return res.status(400).json({ success: false, data: null, error: 'El mes HASTA no puede ser anterior al DESDE' });
    // Un mes cerrado ya está liquidado y pagado: sus variables no se tocan.
    const { isMesCerrado } = require('../../../../shared/utils/mes-cerrado');
    if (await isMesCerrado(desde))
      return res.status(400).json({ success: false, data: null, error: `El mes ${desde} está CERRADO: no se permiten cambios de variables sobre meses cerrados` });

    const antes = await getVars();
    for (const [clave, valor] of Object.entries(updates)) {
      const num = parseFloat(valor);
      if (!Number.isFinite(num)) return res.status(400).json({ success: false, data: null, error: `Valor inválido para ${clave}` });
      await pool.query('UPDATE comisiones_variables SET valor = ? WHERE clave = ?', [num, clave]);
    }
    const despues = await getVars();
    const difs = Object.keys(despues).filter(k => Number(antes[k]) !== Number(despues[k]));

    // Efecto: total de comisiones del equipo en el mes de inicio de vigencia,
    // con las variables antiguas y con las nuevas (mismas operaciones).
    let totAntes = null, totDespues = null;
    try {
      const suma = filas => Math.round(filas.reduce((s, f) => s + (Number(f.con_semana_corrida) || Number(f.incentivo_final) || 0), 0));
      totAntes = suma(await calcularMes(desde, antes));
      totDespues = suma(await calcularMes(desde, despues));
    } catch (e) { console.error('[comisiones simulación]', e.message); }

    const nom = [req.usuario?.nombre, req.usuario?.apellido].filter(Boolean).join(' ') || req.usuario?.email || 'Sistema';
    await pool.query(
      `INSERT INTO comisiones_variables_versiones (vigente_desde, vigente_hasta, valores, anterior, n_cambios,
         total_antes, total_despues, mes_simulado, id_usuario, usuario_nombre)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [desde, hasta || null, JSON.stringify(despues), JSON.stringify(antes), difs.length,
       totAntes, totDespues, desde, req.usuario?.id_usuario || null, nom]);

    auditar({ req, accion: 'EDITAR', modulo: 'comisiones', entidad: 'comision_variable', entidad_id: 'variables',
      detalle: `Actualizó variables de comisiones (${difs.length} variable/s, vigencia ${desde} → ${hasta || 'indefinido'})`, meta: updates });
    res.json({ success: true, data: { n_cambios: difs.length, vigente_desde: desde, vigente_hasta: hasta || null }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── BITÁCORA DE CAMBIOS de variables (solo lectura; sin endpoints de edición) ── */
const getVariablesBitacora = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, created_at, usuario_nombre, n_cambios, vigente_desde, vigente_hasta,
              total_antes, total_despues, mes_simulado
         FROM comisiones_variables_versiones ORDER BY id DESC LIMIT 500`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};
const getVariablesBitacoraDetalle = async (req, res) => {
  try {
    const [[v]] = await pool.query('SELECT * FROM comisiones_variables_versiones WHERE id=? LIMIT 1', [req.params.id]);
    if (!v) return res.status(404).json({ success: false, data: null, error: 'Registro no encontrado' });
    const par = x => { try { return typeof x === 'string' ? JSON.parse(x) : (x || {}); } catch { return {}; } };
    const antes = par(v.anterior), despues = par(v.valores);
    const [meta] = await pool.query('SELECT clave, etiqueta, tipo FROM comisiones_variables');
    const mMeta = new Map(meta.map(m => [m.clave, m]));
    const claves = [...new Set([...Object.keys(antes), ...Object.keys(despues)])].sort();
    const detalle = claves.map(k => ({
      clave: k, etiqueta: (mMeta.get(k) || {}).etiqueta || k, tipo: (mMeta.get(k) || {}).tipo || 'factor',
      antes: antes[k] ?? null, despues: despues[k] ?? null,
      cambio: Number(antes[k]) !== Number(despues[k]),
    }));
    res.json({ success: true, data: {
      id: v.id, created_at: v.created_at, usuario_nombre: v.usuario_nombre, n_cambios: v.n_cambios,
      vigente_desde: v.vigente_desde, vigente_hasta: v.vigente_hasta, mes_simulado: v.mes_simulado,
      total_antes: v.total_antes, total_despues: v.total_despues,
      total_diferencia: (v.total_antes == null || v.total_despues == null) ? null : v.total_despues - v.total_antes,
      detalle,
    }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ── Cálculo del mes por ejecutivo (compartido por la vista y el resumen por correo) ── */
async function calcularMes(mes, varsOverride) {
    // Las variables salen de la VERSIÓN vigente del mes calculado: un mes ya
    // liquidado no cambia porque después se ajusten los parámetros.
    const vars = varsOverride || await getVars(mes);
    // La semana corrida legal necesita los feriados del mes. cargarFeriados() es
    // idempotente y barata (una query): así el cálculo nunca depende de que el
    // seed de boot haya alcanzado a correr.
    await SC.asegurarFeriados();

    /* MES DE ATRIBUCIÓN (motor único shared/mes-atribucion.js, definición
       21-08-2026): desde el corte (ago-2026) manda la FECHA DE CURSE; los meses
       anteriores mantienen el mes contable AJUSTADO (INDEXA no dejaba digitar
       con fechas distintas y esos ajustes deben seguir cuadrando tal cual). */
    const ATRIB = require('../../../../shared/mes-atribucion');
    const mesAtribSql = ATRIB.MES_SQL(mes, await ATRIB.mesCorte(), 'ob');

    // Trae todos los créditos del mes agrupados por ejecutivo
    const [creditos] = await pool.query(
      `SELECT ob.ejecutivo, ob.estado_credito, ob.financiera, ob.producto, ob.cliente_independiente,
              ob.monto_financiado, ob.plazo, ob.seguro_cesantia, ob.seguro_rep_menor,
              ob.seguro_rdh, ob.valor_vehiculo, ob.pie, ob.saldo_precio,
              ob.fecha_otorgado, ob.num_op, ob.id_financiera,
              COALESCE(cl.nombre_completo, '') AS nombre_cliente,
              COALESCE(cl.rut, '')             AS rut_cliente
       FROM creditos ob
       LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
       WHERE ${mesAtribSql} = ?
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
      'SELECT ejecutivo, estado, notas, aprobado_at, ejec_estado, ejec_comentario, ejec_at, ejec_por FROM comisiones_aprobaciones WHERE mes = ?',
      [mes]
    );
    const aprobMap = {};
    aprobs.forEach(a => { aprobMap[a.ejecutivo] = a; });

    // Descuentos por prepago/anulación imputables a este mes (cláusula novena).
    // Un ejecutivo puede tener descuentos aunque no haya colocado nada en el mes,
    // por eso se agregan al mapa: si no, su descuento se perdería.
    const dctos = await descuentosDelMes(mes, vars);
    Object.keys(dctos).forEach(ej => { if (!map[ej]) map[ej] = []; });

    // Ajustes de comisión por operación APROBADOS (Modificar Comisión Ejecutivo):
    // se aplican como línea de ajuste sobre el total a pagar, con su traza.
    const [ajRows] = await pool.query(
      "SELECT num_op, ejecutivo, comision_normal, comision_modificada, comentario, aprobado_por FROM comisiones_ajustes_op WHERE mes = ? AND estado = 'APROBADA'",
      [mes]).catch(() => [[]]);
    const ajustesPorEj = {};
    for (const a of ajRows) (ajustesPorEj[a.ejecutivo] = ajustesPorEj[a.ejecutivo] || []).push(a);

    const resultado = Object.entries(map).map(([ejecutivo, creds]) => {
      const calc = calcularComision(creds, vars, mes);
      const aprob = aprobMap[ejecutivo] || { estado: 'pendiente' };

      // Anotar cada crédito con su incentivo individual
      if (calc.cumple_minimo) {
        creds.forEach(c => {
          if ((c.estado_credito || '').toUpperCase() !== 'OTORGADO') return;
          const pct    = parseInt(c.plazo) < 24 ? vars.pct_24 : vars.pct_mas24;
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

      // Descuentos: se restan del total con semana corrida, que es lo que se paga.
      // Si superan la comisión del mes NO se deja en negativo: el saldo queda
      // informado (saldo_descuento) para que Operaciones decida cómo recuperarlo.
      const lista_dctos = dctos[ejecutivo] || [];
      const total_descuentos = lista_dctos.reduce((s, d) => s + (d.descuento || 0), 0);
      const bruto = calc.con_semana_corrida || 0;
      const aplicado = Math.min(total_descuentos, bruto);
      calc.descuentos = lista_dctos;
      calc.total_descuentos = total_descuentos;
      calc.descuento_aplicado = aplicado;
      calc.saldo_descuento = total_descuentos - aplicado;
      calc.con_semana_corrida_bruto = bruto;
      calc.con_semana_corrida = bruto - aplicado;

      // Ajustes por operación aprobados: la comisión modificada REEMPLAZA a la
      // normal de esa op; la diferencia se suma/resta al total a pagar y cada
      // crédito ajustado queda marcado para la vista de Revisión.
      const ajs = ajustesPorEj[ejecutivo] || [];
      if (ajs.length) {
        let difTotal = 0;
        for (const a of ajs) {
          const dif = Number(a.comision_modificada) - Number(a.comision_normal);
          difTotal += dif;
          const cr = creds.find(c => String(c.num_op) === String(a.num_op));
          if (cr) cr.ajuste_comision = { normal: Number(a.comision_normal), modificada: Number(a.comision_modificada), dif, comentario: a.comentario, aprobado_por: a.aprobado_por };
        }
        calc.ajustes_op = ajs;
        calc.total_ajustes_op = difTotal;
        calc.con_semana_corrida += difTotal;
      }

      return { ejecutivo, mes, ...calc, estado: aprob.estado, notas: aprob.notas, aprobado_at: aprob.aprobado_at,
        ejec_estado: aprob.ejec_estado || 'pendiente', ejec_comentario: aprob.ejec_comentario || null, ejec_at: aprob.ejec_at || null, ejec_por: aprob.ejec_por || null, creditos: creds };
    });

    resultado.sort((a, b) => a.ejecutivo.localeCompare(b.ejecutivo));
    return resultado;
}

/* ── GET /api/comisiones/calculo?mes=YYYY-MM ─────────────────────────────── */
const getCalculo = async (req, res) => {
  try {
    const { mes } = req.query;
    if (!mes) return res.status(400).json({ success: false, data: null, error: 'Parámetro mes requerido (YYYY-MM)' });
    res.json({ success: true, data: await calcularMes(mes), error: null });
  } catch (e) {
    console.error('[getCalculo]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── Config de destinatarios del resumen por correo ──────────────────────── */
async function initResumenConfig() {
  await pool.query(`CREATE TABLE IF NOT EXISTS comisiones_resumen_config (
    clave VARCHAR(40) PRIMARY KEY, valor VARCHAR(500) NOT NULL DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  for (const k of ['resumen_para', 'resumen_cc'])
    await pool.query('INSERT IGNORE INTO comisiones_resumen_config (clave, valor) VALUES (?, \'\')', [k]);
}
initResumenConfig().catch(e => console.error('[comisiones resumen cfg]', e.message));

const getResumenConfig = async (req, res) => {
  try {
    await initResumenConfig();
    const [rows] = await pool.query("SELECT clave, valor FROM comisiones_resumen_config");
    const cfg = {}; rows.forEach(r => { cfg[r.clave] = r.valor; });
    res.json({ success: true, data: { para: cfg.resumen_para || '', cc: cfg.resumen_cc || '' }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/comisiones/enviar-resumen {mes, para, cc} ─────────────────────
   Resumen por ejecutivo: créditos colocados, monto y bono BRUTO (sin semana
   corrida = incentivo_final). Guarda los destinatarios y firma el Business Suite. */
const enviarResumen = async (req, res) => {
  try {
    const { enviarCorreo, mailConfigurado } = require('../../../../shared/mailer');
    if (!mailConfigurado()) return res.status(400).json({ success: false, data: null, error: 'El correo del sistema no está configurado (MAIL_*)' });
    const mes = /^\d{4}-\d{2}$/.test((req.body && req.body.mes) || '') ? req.body.mes : null;
    if (!mes) return res.status(400).json({ success: false, data: null, error: 'Mes inválido (YYYY-MM)' });

    // Persistir destinatarios si vienen en el request (edición desde el modal)
    await initResumenConfig();
    if (typeof req.body.para === 'string') await pool.query("UPDATE comisiones_resumen_config SET valor=? WHERE clave='resumen_para'", [req.body.para.trim().slice(0, 500)]);
    if (typeof req.body.cc === 'string')   await pool.query("UPDATE comisiones_resumen_config SET valor=? WHERE clave='resumen_cc'", [req.body.cc.trim().slice(0, 500)]);
    const [cfgRows] = await pool.query("SELECT clave, valor FROM comisiones_resumen_config");
    const cfg = {}; cfgRows.forEach(r => { cfg[r.clave] = r.valor; });
    const split = s => String(s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
    const para = split(cfg.resumen_para), cc = split(cfg.resumen_cc);
    if (!para.length) return res.status(400).json({ success: false, data: null, error: 'Configura al menos un destinatario (Para).' });

    const datos = (await calcularMes(mes)).sort((a, b) => (b.incentivo_final || 0) - (a.incentivo_final || 0));
    const clp = v => '$' + Math.round(v || 0).toLocaleString('es-CL');
    const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const [yy, mm] = mes.split('-');
    const mesLargo = `${MESES[parseInt(mm, 10) - 1]} ${yy}`;

    let totCred = 0, totMonto = 0, totBono = 0;
    const filas = datos.map((d, i) => {
      const cred = d.total_creditos || 0, monto = d.total_financiado || 0, bono = d.cumple_minimo ? (d.incentivo_final || 0) : 0;
      totCred += cred; totMonto += monto; totBono += bono;
      return `<tr style="background:${i % 2 ? '#f8fafc' : '#fff'}">
        <td style="padding:7px 12px;border-bottom:1px solid #e5e7eb">${d.ejecutivo}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${cred}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${clp(monto)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;color:${bono > 0 ? '#0141A2' : '#9ca3af'}">${bono > 0 ? clp(bono) : '—'}</td>
      </tr>`;
    }).join('');

    const html = `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:660px;margin:0 auto;color:#1e293b">
        <div style="background:linear-gradient(135deg,#012d70,#0141A2 50%,#009AFE);border-radius:14px;color:#fff;padding:22px 26px;margin-bottom:18px">
          <div style="font-size:1.15rem;font-weight:800">Resumen de Comisiones — ${mesLargo}</div>
          <div style="font-size:.85rem;opacity:.85">Comisiones de ejecutivos comerciales · Auto Fácil Crédito Automotriz</div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:.9rem;margin-bottom:14px">
          <thead><tr style="background:#eff6ff">
            <th style="padding:8px 12px;text-align:left;color:#0141A2">Ejecutivo</th>
            <th style="padding:8px 12px;text-align:right;color:#0141A2">Créditos colocados</th>
            <th style="padding:8px 12px;text-align:right;color:#0141A2">Monto de los créditos</th>
            <th style="padding:8px 12px;text-align:right;color:#0141A2">Bono bruto</th>
          </tr></thead>
          <tbody>${filas}
            <tr style="background:#0f2d6b;color:#fff;font-weight:800">
              <td style="padding:9px 12px">TOTAL (${datos.length} ejecutivos)</td>
              <td style="padding:9px 12px;text-align:right">${totCred}</td>
              <td style="padding:9px 12px;text-align:right">${clp(totMonto)}</td>
              <td style="padding:9px 12px;text-align:right">${clp(totBono)}</td>
            </tr>
          </tbody>
        </table>
        <div style="font-size:.76rem;color:#64748b;line-height:1.5">
          El <b>bono bruto</b> corresponde al incentivo del mes <b>sin semana corrida</b>. Los ejecutivos que no alcanzan el mínimo del mes figuran con bono “—”.
        </div>
        <div style="margin-top:18px;padding-top:12px;border-top:1px dashed #cbd5e1;font-size:.78rem;color:#64748b">
          Emitido automáticamente por <b>Auto Fácil Business Suite</b>.
        </div>
      </div>`;

    await enviarCorreo({ to: para.join(','), cc: cc.length ? cc.join(',') : undefined,
      subject: `Resumen de Comisiones — ${mesLargo} (bono bruto total ${clp(totBono)})`, html });
    auditar({ req, accion: 'ENVIAR', modulo: 'comisiones', entidad: 'resumen', entidad_id: mes,
      detalle: `Resumen de comisiones ${mes} enviado a ${para.join(', ')}${cc.length ? ' (CC: ' + cc.join(', ') + ')' : ''} — bono bruto total ${clp(totBono)}` });
    res.json({ success: true, data: { enviado_a: para, cc, mes }, error: null });
  } catch (e) { console.error('[comisiones enviarResumen]', e); res.status(500).json({ success: false, data: null, error: 'Error enviando el resumen' }); }
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
    // Al aprobar Operaciones: reinicia la respuesta del ejecutivo (limpia comentario previo,
    // reinicia el reloj de 2 días hábiles) y le avisa que espera su aprobación.
    if (estado === 'aprobado') {
      await pool.query(
        `UPDATE comisiones_aprobaciones SET ejec_estado='pendiente', ejec_comentario=NULL, ejec_por=NULL, ejec_at=NULL
         WHERE ejecutivo=? AND mes=?`, [ejecutivo, mes]);
      await notificarComisionRev('com_rev_aprobada_ops', { ejecutivo, mes });
    }
    auditar({ req, accion: estado === 'aprobado' ? 'APROBAR' : (estado === 'rechazado' ? 'RECHAZAR' : 'EDITAR'),
      modulo: 'comisiones', entidad: 'comision', entidad_id: `${ejecutivo}|${mes}`,
      detalle: `Comisión de ${ejecutivo} (${mes}) → ${estado}`
        + (incentivo_final ? ` · $${Math.round(incentivo_final).toLocaleString('es-CL')}` : '')
        + (notas ? ` · "${notas}"` : ''),
      meta: { incentivo_final: incentivo_final || 0, con_semana_corrida: con_semana_corrida || 0 } });
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── POST /api/comisiones/ejecutivo-responder ────────────────────────────────
   Respuesta del ejecutivo a SU comisión, solo después de aprobada por Operaciones:
   accion 'aceptar' (declara conformidad) o 'revision' (comentario obligatorio). */
const ejecutivoResponder = async (req, res) => {
  try {
    const { ejecutivo, mes, accion, comentario } = req.body;
    if (!ejecutivo || !mes || !['aceptar', 'revision'].includes(accion))
      return res.status(400).json({ success: false, data: null, error: 'Faltan campos requeridos' });
    if (accion === 'revision' && !(comentario && comentario.trim()))
      return res.status(400).json({ success: false, data: null, error: 'El comentario es obligatorio' });
    const [[row]] = await pool.query(
      'SELECT estado FROM comisiones_aprobaciones WHERE ejecutivo=? AND mes=?', [ejecutivo, mes]);
    if (!row || row.estado !== 'aprobado')
      return res.status(400).json({ success: false, data: null, error: 'La comisión aún no ha sido aprobada por Operaciones' });
    // La declaración de conformidad es personal: solo el ejecutivo dueño (vía
    // usuario_ejecutivos) o un Administrador puede responder esta comisión.
    if (req.usuario.perfil_nombre !== 'Administrador') {
      const [[lnk]] = await pool.query(
        'SELECT 1 FROM usuario_ejecutivos WHERE id_usuario=? AND ejecutivo=? LIMIT 1',
        [req.usuario.id_usuario, ejecutivo]);
      if (!lnk) return res.status(403).json({ success: false, data: null, error: 'Solo el ejecutivo puede responder su propia comisión' });
    }
    const ejec_estado = accion === 'aceptar' ? 'aceptado' : 'en_revision';
    await pool.query(
      `UPDATE comisiones_aprobaciones SET ejec_estado=?, ejec_comentario=?, ejec_por=?, ejec_at=NOW()
       WHERE ejecutivo=? AND mes=?`,
      [ejec_estado, accion === 'revision' ? comentario.trim() : null, req.usuario.id_usuario, ejecutivo, mes]);
    if (accion === 'revision') await notificarComisionRev('com_rev_devuelta', { ejecutivo, mes });
    auditar({ req, accion: accion === 'aceptar' ? 'APROBAR' : 'DEVOLVER', modulo: 'comisiones', entidad: 'comision', entidad_id: `${ejecutivo}|${mes}`,
      detalle: accion === 'aceptar' ? `Ejecutivo declaró conformidad de sus comisiones (${mes})` : `Ejecutivo devolvió comisiones a revisión (${mes}): ${comentario.trim()}` });
    res.json({ success: true, data: { ejec_estado }, error: null });
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
    const [opsRows] = await pool.query(
      `SELECT DISTINCT ejecutivo FROM creditos
       WHERE ejecutivo IS NOT NULL AND ejecutivo != '' ${where}`,
      params
    );
    const [usrRows] = await pool.query(
      `SELECT TRIM(CONCAT(SUBSTRING_INDEX(TRIM(u.nombre),' ',1), ' ', SUBSTRING_INDEX(TRIM(u.apellido),' ',1))) AS ejecutivo
       FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
       WHERE p.nombre = 'Ejecutivo Comercial' AND u.estado = 'activo'`
    );
    // Dedupe sin mayúsculas/tildes — gana la versión de las operaciones,
    // que es el string contra el que cruza el cálculo de comisiones
    const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
    const mapa = new Map();
    opsRows.forEach(r => mapa.set(norm(r.ejecutivo), r.ejecutivo));
    usrRows.forEach(r => { const k = norm(r.ejecutivo); if (!mapa.has(k)) mapa.set(k, r.ejecutivo); });
    const lista = [...mapa.values()].sort((a, b) => a.localeCompare(b));
    res.json({ success: true, data: lista, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── GET /api/comisiones/alertas-config — config paramétrica de las 3 alertas ── */
const getAlertasConfig = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM comisiones_alertas_config');
    const map = {}; rows.forEach(r => { map[r.evento] = r; });
    const data = EVENTOS_REV.map(e => {
      const c = map[e.evento] || {};
      return { evento: e.evento, titulo: e.titulo,
        perfiles: c.perfiles || '', incluir_ejecutivo: !!c.incluir_ejecutivo,
        usuarios_extra: c.usuarios_extra || '', activo: c.activo === undefined ? 1 : c.activo,
        prioridad: c.prioridad || 'normal', sonido: c.sonido === undefined ? 1 : c.sonido,
        sonido_tipo: c.sonido_tipo || 'campana', sonido_cada_seg: c.sonido_cada_seg || 30,
        sonido_max_min: c.sonido_max_min || 5 };
    });
    res.json({ success: true, data, sonidos: SONIDOS, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const setAlertasConfig = async (req, res) => {
  try {
    const lista = Array.isArray(req.body?.config) ? req.body.config : [];
    for (const c of lista) {
      if (!EVENTOS_REV.find(e => e.evento === c.evento)) continue;
      const sonTipo = SONIDOS.includes(c.sonido_tipo) ? c.sonido_tipo : 'campana';
      await pool.query(
        `INSERT INTO comisiones_alertas_config (evento, perfiles, incluir_ejecutivo, usuarios_extra, activo, prioridad, sonido, sonido_tipo, sonido_cada_seg, sonido_max_min)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE perfiles=VALUES(perfiles), incluir_ejecutivo=VALUES(incluir_ejecutivo),
           usuarios_extra=VALUES(usuarios_extra), activo=VALUES(activo), prioridad=VALUES(prioridad),
           sonido=VALUES(sonido), sonido_tipo=VALUES(sonido_tipo), sonido_cada_seg=VALUES(sonido_cada_seg), sonido_max_min=VALUES(sonido_max_min)`,
        [c.evento, String(c.perfiles || ''), c.incluir_ejecutivo ? 1 : 0, String(c.usuarios_extra || ''), c.activo ? 1 : 0,
         c.prioridad === 'alta' ? 'alta' : 'normal', c.sonido ? 1 : 0, sonTipo,
         Math.max(5, parseInt(c.sonido_cada_seg) || 30), Math.max(1, parseInt(c.sonido_max_min) || 5)]);
    }
    res.json({ success: true, data: { actualizados: lista.length }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/comisiones/op-independiente {num_op, independiente} — marca/desmarca
   al cliente de la operación como INDEPENDIENTE: sale de la base del cruce de
   cesantía (el seguro no lo cubre). Manual, auditado, desde Revisión. */
const marcarIndependiente = async (req, res) => {
  try {
    const numOp = String(req.body?.num_op || '').trim();
    const val = req.body?.independiente ? 1 : 0;
    if (!numOp) return res.status(400).json({ success: false, data: null, error: 'num_op requerido' });
    const [r] = await pool.query('UPDATE creditos SET cliente_independiente=? WHERE num_op=?', [val, numOp]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    auditar({ req, accion: 'EDITAR', modulo: 'comisiones', entidad: 'credito', detalle: `${val ? 'Marcó' : 'Desmarcó'} cliente INDEPENDIENTE en la OP ${numOp} (cruce de cesantía)` });
    res.json({ success: true, data: { num_op: numOp, independiente: val }, error: null });
  } catch (e) { console.error('[comisiones independiente]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getVariables, putVariables, getVariablesBitacora, getVariablesBitacoraDetalle, getCalculo, aprobar, ejecutivoResponder, getAlertasConfig, setAlertasConfig, getEjecutivos, getResumenConfig, enviarResumen, marcarIndependiente,
  calcularMes };  // motor único: lo reusa Remuneraciones (RRHH) para las comisiones imponibles
