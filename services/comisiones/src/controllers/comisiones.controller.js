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
    // Segunda etapa: respuesta del ejecutivo (acepta / envía a revisión con comentario)
    for (const col of ["ejec_estado VARCHAR(20) DEFAULT 'pendiente'", 'ejec_comentario TEXT', 'ejec_por INT DEFAULT NULL', 'ejec_at DATETIME DEFAULT NULL']) {
      try { await pool.query(`ALTER TABLE comisiones_aprobaciones ADD COLUMN IF NOT EXISTS ${col}`); } catch (e) {}
    }
  } catch (e) {
    console.error('[comisiones migration]', e.message);
  }
})();

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
(async () => {
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
})();

const { sumarDiasHabiles } = require('../../../../shared/feriados');  // días hábiles = sin fines de semana ni feriados chilenos
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
    const mensaje = def.mensaje.replace('{mesPago}', mesPagoNombre(mes)).replace('{mesProd}', mesNombre(mes)).replace('{ejecutivo}', ejecutivo||'');
    const clave = `comrev:${evento}:${ejecutivo||''}:${mes}`;
    const sonTipo = SONIDOS.includes(cfg.sonido_tipo) ? cfg.sonido_tipo : 'campana';
    for (const uid of ids) {
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
      }
    }
  } catch (e) { console.error('[autoAprobarComisiones]', e.message); }
}
setTimeout(autoAprobarComisiones, 20000);
setInterval(autoAprobarComisiones, 30 * 60 * 1000);

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
      'SELECT ejecutivo, estado, notas, aprobado_at, ejec_estado, ejec_comentario, ejec_at, ejec_por FROM comisiones_aprobaciones WHERE mes = ?',
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

      return { ejecutivo, mes, ...calc, estado: aprob.estado, notas: aprob.notas, aprobado_at: aprob.aprobado_at,
        ejec_estado: aprob.ejec_estado || 'pendiente', ejec_comentario: aprob.ejec_comentario || null, ejec_at: aprob.ejec_at || null, ejec_por: aprob.ejec_por || null, creditos: creds };
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
    // Al aprobar Operaciones: reinicia la respuesta del ejecutivo (limpia comentario previo,
    // reinicia el reloj de 2 días hábiles) y le avisa que espera su aprobación.
    if (estado === 'aprobado') {
      await pool.query(
        `UPDATE comisiones_aprobaciones SET ejec_estado='pendiente', ejec_comentario=NULL, ejec_por=NULL, ejec_at=NULL
         WHERE ejecutivo=? AND mes=?`, [ejecutivo, mes]);
      await notificarComisionRev('com_rev_aprobada_ops', { ejecutivo, mes });
    }
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
      `SELECT CONCAT(u.nombre, ' ', u.apellido) AS ejecutivo
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

module.exports = { getVariables, putVariables, getCalculo, aprobar, ejecutivoResponder, getAlertasConfig, setAlertasConfig, getEjecutivos };
