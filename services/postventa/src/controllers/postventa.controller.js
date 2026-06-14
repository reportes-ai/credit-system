'use strict';
const pool = require('../../../../shared/config/database');

/* ── Migración ───────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_seguimiento (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        id_credito    INT NOT NULL,
        num_op        INT DEFAULT NULL,
        financiera    VARCHAR(60),
        rut_dealer    VARCHAR(20),
        nombre_dealer VARCHAR(200),
        ejecutivo     VARCHAR(150),
        fecha_otorgado DATE,
        saldo_precio  BIGINT,
        comision      BIGINT,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_credito (id_credito),
        INDEX idx_financiera (financiera)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_etapas (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_seguimiento INT NOT NULL,
        track          ENUM('SALDO','COMISION') NOT NULL,
        etapa          VARCHAR(60) NOT NULL,
        usuario        VARCHAR(150),
        fecha          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_etapa (id_seguimiento, track, etapa)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_config (
        clave VARCHAR(50) PRIMARY KEY,
        valor TEXT NOT NULL
      )`);
    // Mapeo etapa → estado por defecto (editable en Mantenedores Post Venta)
    const DEF_SALDO = [
      { etapa:'FUNDANTES PENDIENTES', estado:'PENDIENTE' },
      { etapa:'FUNDANTES RECIBIDOS',  estado:'PENDIENTE' },
      { etapa:'FUNDANTES ENVIADOS',   estado:'PENDIENTE' },
      { etapa:'LIBERADO A PAGO',      estado:'PARA PAGO' },
      { etapa:'FONDOS RECIBIDOS',     estado:'PARA PAGO' },
      { etapa:'ORDEN DE PAGO EMITIDA',estado:'PARA PAGO' },
      { etapa:'ENVIADO A PAGO',       estado:'PARA PAGO' },
      { etapa:'SALDO PRECIO PAGADO',  estado:'PAGADO' },
    ];
    const DEF_COM = [
      { etapa:'COMISION A PAGAR',     estado:'PENDIENTE' },
      { etapa:'CARTOLA EMITIDA',      estado:'PENDIENTE' },
      { etapa:'CARTOLA APROBADA',     estado:'PENDIENTE' },
      { etapa:'CARTOLA ENVIADA',      estado:'PENDIENTE' },
      { etapa:'FACTURA RECIBIDA',     estado:'PARA PAGO' },
      { etapa:'ORDEN DE PAGO EMITIDA',estado:'PARA PAGO' },
      { etapa:'ENVIADO A PAGO',       estado:'PARA PAGO' },
      { etapa:'COMISION PAGADA',      estado:'PAGADO' },
    ];
    await pool.query('INSERT IGNORE INTO postventa_config (clave, valor) VALUES (?,?),(?,?)',
      ['etapas_saldo', JSON.stringify(DEF_SALDO), 'etapas_comision', JSON.stringify(DEF_COM)]);
    // Parche: insertar ENVIADO A PAGO (antes de la etapa de pagado) en configs ya existentes.
    // claveProc = array posicional de perfiles por etapa: hay que insertar un slot vacío
    // en la misma posición para no desalinear los permisos de las etapas posteriores.
    const insertarEnviado = async (clave, antesDe, claveProc) => {
      const [[row]] = await pool.query("SELECT valor FROM postventa_config WHERE clave=?", [clave]);
      if (!row) return;
      const arr = JSON.parse(row.valor);
      if (arr.some(x => x.etapa === 'ENVIADO A PAGO')) return;
      const idx = arr.findIndex(x => x.etapa === antesDe);
      const at = idx >= 0 ? idx : arr.length;
      arr.splice(at, 0, { etapa:'ENVIADO A PAGO', estado:'PARA PAGO' });
      await pool.query("UPDATE postventa_config SET valor=? WHERE clave=?", [JSON.stringify(arr), clave]);
      const [[pr]] = await pool.query("SELECT valor FROM postventa_config WHERE clave=?", [claveProc]);
      if (pr) {
        const perms = JSON.parse(pr.valor);
        if (Array.isArray(perms)) {
          perms.splice(at, 0, []);
          await pool.query("UPDATE postventa_config SET valor=? WHERE clave=?", [JSON.stringify(perms), claveProc]);
        }
      }
      console.log('[postventa] etapa ENVIADO A PAGO agregada a ' + clave);
    };
    try {
      await insertarEnviado('etapas_saldo',    'SALDO PRECIO PAGADO', 'etapa_perfiles_saldo');
      await insertarEnviado('etapas_comision', 'COMISION PAGADA',     'etapa_perfiles_comision');
    } catch (e) { console.error('[postventa patch ENVIADO A PAGO]', e.message); }
    // Órdenes de pago de saldo precio: correlativo propio (una por operación)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_ordenes (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        num_orden      VARCHAR(30) UNIQUE,
        id_seguimiento INT NOT NULL,
        num_op         INT DEFAULT NULL,
        monto          BIGINT,
        usuario        VARCHAR(150),
        fecha          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_seg (id_seguimiento)
      )`);
    // Órdenes de pago de comisión: correlativo propio (una por operación)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_ordenes_comision (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        num_orden      VARCHAR(30) UNIQUE,
        id_seguimiento INT NOT NULL,
        num_op         INT DEFAULT NULL,
        monto          BIGINT,
        usuario        VARCHAR(150),
        fecha          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_seg (id_seguimiento)
      )`);
    // Homologación: num_op varchar->int (datos verificados 100% numéricos)
    for (const t of ['postventa_seguimiento','postventa_ordenes','postventa_ordenes_comision']) {
      try {
        const [[c]] = await pool.query(`SELECT data_type dt FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name='num_op'`, [t]);
        if (c && String(c.dt).toLowerCase() === 'varchar') await pool.query(`ALTER TABLE \`${t}\` MODIFY COLUMN num_op INT DEFAULT NULL`);
      } catch(e){ console.error('[num_op->int '+t+']', e.message); }
    }
    // Reversas de pago fuera del día (auditoría para Riesgo Operacional)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_reversas (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_seguimiento INT NOT NULL,
        etapa          VARCHAR(60) NOT NULL,
        usuario        VARCHAR(150),
        motivo         VARCHAR(400),
        fecha          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    // Datos de la factura/boleta de comisión (capturados al marcar FACTURA RECIBIDA)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS postventa_facturas_comision (
        id_seguimiento INT PRIMARY KEY,
        num_op         INT DEFAULT NULL,
        rut_dealer     VARCHAR(20) DEFAULT NULL,
        nombre_dealer  VARCHAR(200) DEFAULT NULL,
        fecha_factura  DATE DEFAULT NULL,
        numero_factura VARCHAR(60) DEFAULT NULL,
        monto_bruto    BIGINT DEFAULT NULL,
        es_terceros    TINYINT(1) NOT NULL DEFAULT 0,
        es_boleta      TINYINT(1) NOT NULL DEFAULT 0,
        usuario        VARCHAR(150),
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    console.log('[postventa] tablas OK');
  } catch (e) { console.error('[postventa migration]', e.message); }
})();

const loginDe = u => (u?.nombre ? (u.nombre + ' ' + (u.apellido || '')).trim() : u?.email) || 'Sistema';

/* ── Alertas de proceso Saldo Precio (paramétricas, event-driven) ──────────────
   Cada transición del workflow genera una alerta (campana) a destinatarios
   configurables por evento: perfiles + el ejecutivo de la operación + usuarios extra. */
const EVENTOS_SALDO = [
  { evento: 'fondos_recibidos', titulo: 'Fondos recibidos — emitir Orden de Pago',
    mensaje: 'La operación {op} tiene FONDOS RECIBIDOS. Emite la Orden de Pago.', href: '/postventa/orden-pago/' },
  { evento: 'orden_emitida', titulo: 'Orden de Pago emitida — cargar montos disponibles',
    mensaje: 'Se emitió la Orden de Pago de {op}. Carga los montos disponibles para pago.', href: '/postventa/saldos-a-pagar/' },
  { evento: 'fondos_cargados', titulo: 'Montos disponibles cargados',
    mensaje: 'Tesorería cargó los fondos disponibles para pago de saldos precio. Define qué pagar.', href: '/postventa/saldos-a-pagar/' },
  { evento: 'enviado_pago', titulo: 'Operaciones enviadas a pago — confirmar pago',
    mensaje: 'Se enviaron operaciones a pago. Confirma el pago en Saldos Precios a Pagar.', href: '/postventa/saldos-a-pagar/' },
  { evento: 'pago_realizado', titulo: 'Saldo precio pagado',
    mensaje: 'Se registró el pago del saldo precio de {op}.', href: '/postventa/seguimiento/' },
];
/* ── Alertas de proceso Comisión (paramétricas, event-driven) ──────────────
   Espejo del flujo de Saldo Precio: la comisión se alimenta de las cartolas,
   se recibe la factura del concesionario, se emite la orden de pago, se
   selecciona qué se paga (Enviar a Pago) y se paga. */
const EVENTOS_COMISION = [
  { evento: 'com_factura_recibida', titulo: 'Factura recibida — emitir Orden de Pago de Comisión',
    mensaje: 'La operación {op} tiene FACTURA RECIBIDA. Emite la Orden de Pago de comisión.', href: '/postventa/orden-pago-comision/' },
  { evento: 'com_orden_emitida', titulo: 'Orden de Pago de Comisión emitida — cargar montos disponibles',
    mensaje: 'Se emitió la Orden de Pago de comisión de {op}. Carga los montos disponibles para pago.', href: '/postventa/comisiones-a-pagar/' },
  { evento: 'com_fondos_cargados', titulo: 'Montos disponibles cargados (Comisión)',
    mensaje: 'Tesorería cargó los fondos disponibles para pago de comisiones. Define qué pagar.', href: '/postventa/comisiones-a-pagar/' },
  { evento: 'com_enviado_pago', titulo: 'Comisiones enviadas a pago — confirmar pago',
    mensaje: 'Se enviaron comisiones a pago. Confirma el pago en Comisiones a Pagar.', href: '/postventa/comisiones-a-pagar/' },
  { evento: 'com_pago_realizado', titulo: 'Comisión pagada',
    mensaje: 'Se registró el pago de la comisión de {op}.', href: '/postventa/seguimiento/' },
];
const SONIDOS_SALDO = ['campana', 'dingdong', 'alarma', 'aplausos'];
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS postventa_alertas_config (
      evento            VARCHAR(40) PRIMARY KEY,
      perfiles          TEXT,
      incluir_ejecutivo TINYINT(1) NOT NULL DEFAULT 0,
      usuarios_extra    TEXT,
      activo            TINYINT(1) NOT NULL DEFAULT 1,
      prioridad         VARCHAR(10) NOT NULL DEFAULT 'normal',
      sonido            TINYINT(1) NOT NULL DEFAULT 1,
      sonido_tipo       VARCHAR(20) NOT NULL DEFAULT 'campana',
      sonido_cada_seg   INT NOT NULL DEFAULT 30,
      sonido_max_min    INT NOT NULL DEFAULT 5
    )`);
    // Columnas para instalaciones que ya tenían la tabla (mismas variables que el resto de alertas)
    await pool.query(`ALTER TABLE postventa_alertas_config ADD COLUMN IF NOT EXISTS prioridad VARCHAR(10) NOT NULL DEFAULT 'normal'`).catch(()=>{});
    await pool.query(`ALTER TABLE postventa_alertas_config ADD COLUMN IF NOT EXISTS sonido TINYINT(1) NOT NULL DEFAULT 1`).catch(()=>{});
    await pool.query(`ALTER TABLE postventa_alertas_config ADD COLUMN IF NOT EXISTS sonido_tipo VARCHAR(20) NOT NULL DEFAULT 'campana'`).catch(()=>{});
    await pool.query(`ALTER TABLE postventa_alertas_config ADD COLUMN IF NOT EXISTS sonido_cada_seg INT NOT NULL DEFAULT 30`).catch(()=>{});
    await pool.query(`ALTER TABLE postventa_alertas_config ADD COLUMN IF NOT EXISTS sonido_max_min INT NOT NULL DEFAULT 5`).catch(()=>{});
    for (const e of [...EVENTOS_SALDO, ...EVENTOS_COMISION])
      await pool.query(
        `INSERT IGNORE INTO postventa_alertas_config (evento, perfiles, incluir_ejecutivo, usuarios_extra, activo)
         VALUES (?,?,?,?,1)`,
        [e.evento, 'Administrador', (e.evento === 'pago_realizado' || e.evento === 'com_pago_realizado') ? 1 : 0, '']);
    console.log('[postventa] alertas_config OK');
  } catch (e) { console.error('[postventa alertas migration]', e.message); }
})();

// Resuelve destinatarios y crea las notificaciones (campana) de un evento.
async function notificarEventoSaldo(evento, { op, id_seguimiento, ejecutivo, claveExtra } = {}) {
  try {
    const def = EVENTOS_SALDO.find(e => e.evento === evento) || EVENTOS_COMISION.find(e => e.evento === evento);
    if (!def) return;
    const [[cfg]] = await pool.query('SELECT * FROM postventa_alertas_config WHERE evento=?', [evento]);
    if (!cfg || !cfg.activo) return;

    const ids = new Set();
    // Perfiles
    const perfiles = String(cfg.perfiles || '').split(',').map(s => s.trim()).filter(Boolean);
    if (perfiles.length) {
      const [us] = await pool.query(
        `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
         WHERE p.nombre IN (?) AND (u.estado IS NULL OR u.estado <> 'inactivo')`, [perfiles]);
      us.forEach(u => ids.add(u.id_usuario));
    }
    // Ejecutivo de la operación (vía usuario_ejecutivos)
    if (cfg.incluir_ejecutivo && ejecutivo) {
      try {
        const [us] = await pool.query('SELECT id_usuario FROM usuario_ejecutivos WHERE ejecutivo = ?', [ejecutivo]);
        us.forEach(u => ids.add(u.id_usuario));
      } catch (_) {}
    }
    // Usuarios extra (CSV de id_usuario)
    String(cfg.usuarios_extra || '').split(',').map(s => parseInt(s.trim())).filter(Boolean).forEach(id => ids.add(id));

    if (!ids.size) return;
    const mensaje = def.mensaje.replace('{op}', op != null ? ('N° ' + op) : 'una operación');
    const clave = `pvalert:${evento}:${claveExtra || id_seguimiento || Date.now()}`;
    const prioridad = cfg.prioridad || 'normal';
    const sonar = cfg.sonido ? 1 : 0;
    const sonTipo = SONIDOS_SALDO.includes(cfg.sonido_tipo) ? cfg.sonido_tipo : 'campana';
    const sonCada = cfg.sonido_cada_seg || 30;
    const sonMax = cfg.sonido_max_min || 5;
    for (const uid of ids) {
      const [[ex]] = await pool.query(
        'SELECT 1 FROM notificaciones WHERE id_usuario=? AND clave=? AND leida=0 LIMIT 1', [uid, clave]);
      if (ex) continue;
      await pool.query(
        `INSERT INTO notificaciones (id_usuario, tipo, titulo, mensaje, href, clave, prioridad, sonar, son_cada, son_max, son_tipo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [uid, 'alerta', def.titulo, mensaje, def.href, clave, prioridad, sonar, sonCada, sonMax, sonTipo]);
    }
  } catch (e) { console.error('[notificarEventoSaldo]', evento, e.message); }
}

// Lee num_op y ejecutivo de un seguimiento (para el contexto de la alerta)
async function ctxSeguimiento(id) {
  try {
    const [[r]] = await pool.query('SELECT num_op, ejecutivo FROM postventa_seguimiento WHERE id=?', [id]);
    return r || {};
  } catch (_) { return {}; }
}

/* ── POST /api/postventa/sync — incluye los otorgados nuevos ─────── */
const sync = async (req, res) => {
  try {
    const [r1] = await pool.query(`
      INSERT INTO postventa_seguimiento
        (id_credito, num_op, financiera, nombre_dealer, ejecutivo, fecha_otorgado, saldo_precio, comision)
      SELECT c.id, c.num_op, c.financiera, c.automotora, c.ejecutivo,
             DATE(c.fecha_otorgado), c.saldo_precio, c.comdea_real
      FROM creditos c
      WHERE c.fecha_otorgado IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM postventa_seguimiento s WHERE s.id_credito = c.id)
    `);
    // Etapas "Sistema" automáticas para los nuevos
    await pool.query(`
      INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
      SELECT s.id, 'SALDO', 'FUNDANTES PENDIENTES', 'Sistema', COALESCE(s.fecha_otorgado, NOW())
      FROM postventa_seguimiento s
      WHERE NOT EXISTS (SELECT 1 FROM postventa_etapas e
        WHERE e.id_seguimiento = s.id AND e.track='SALDO' AND e.etapa='FUNDANTES PENDIENTES')`);
    await pool.query(`
      INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha)
      SELECT s.id, 'COMISION', 'COMISION A PAGAR', 'Sistema', COALESCE(s.fecha_otorgado, NOW())
      FROM postventa_seguimiento s
      WHERE NOT EXISTS (SELECT 1 FROM postventa_etapas e
        WHERE e.id_seguimiento = s.id AND e.track='COMISION' AND e.etapa='COMISION A PAGAR')`);
    res.json({ success: true, data: { nuevos: r1.affectedRows }, error: null });
  } catch (e) {
    console.error('[postventa sync]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa — seguimientos + etapas marcadas ─────────── */
const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.id_credito, s.num_op, s.financiera, s.ejecutivo,
             s.fecha_otorgado, s.saldo_precio, s.comision,
             COALESCE(c.nombre_local, d.nombre_razon, s.nombre_dealer)  AS nombre_dealer,
             COALESCE(c.rut_dealer, d.rut, s.rut_dealer)         AS rut_dealer,
             fc.fecha_factura AS fac_fecha, fc.numero_factura AS fac_numero, fc.monto_bruto AS fac_monto,
             fc.es_terceros AS fac_terceros, fc.es_boleta AS fac_boleta
      FROM postventa_seguimiento s
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  d ON d.nombre_indexa = c.automotora
      LEFT JOIN postventa_facturas_comision fc ON fc.id_seguimiento = s.id
      ORDER BY s.fecha_otorgado DESC, s.id DESC LIMIT 1000`);
    const [etapas] = await pool.query(
      `SELECT id_seguimiento, track, etapa, usuario, fecha FROM postventa_etapas
       WHERE id_seguimiento IN (SELECT id FROM postventa_seguimiento)`);
    const map = {};
    etapas.forEach(e => (map[e.id_seguimiento] = map[e.id_seguimiento] || []).push(e));
    rows.forEach(r => r.etapas = map[r.id] || []);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[postventa getAll]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── PUT /api/postventa/:id/etapa { track, etapa, marcar } ───────── */
const ETAPAS_SISTEMA = ['FUNDANTES PENDIENTES', 'COMISION A PAGAR'];
const setEtapa = async (req, res) => {
  try {
    const { track, etapa, marcar } = req.body;
    if (!['SALDO','COMISION'].includes(track) || !etapa)
      return res.status(400).json({ success: false, data: null, error: 'track y etapa requeridos' });
    if (ETAPAS_SISTEMA.includes(etapa))
      return res.status(400).json({ success: false, data: null, error: 'Etapa de sistema — no editable' });
    // Etapas automáticas: solo se marcan desde sus módulos dedicados
    if (track === 'SALDO' && ['ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','SALDO PRECIO PAGADO'].includes(etapa))
      return res.status(400).json({ success: false, data: null, error: `"${etapa}" se marca automáticamente desde su módulo (Emisión Orden de Pago / Saldos Precios a Pagar)` });
    if (track === 'COMISION' && ['ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','COMISION PAGADA'].includes(etapa))
      return res.status(400).json({ success: false, data: null, error: `"${etapa}" se marca automáticamente desde su módulo (Emisión Orden de Pago Comisión / Comisiones a Pagar)` });

    const esAdmin = req.usuario?.perfil_nombre === 'Administrador';
    const usuario = loginDe(req.usuario);

    // Cargar config para orden y permisos
    const [[cfgRow]] = await pool.query(`SELECT valor FROM postventa_config WHERE clave = ?`,
      [track === 'SALDO' ? 'etapas_saldo' : 'etapas_comision']);
    const listaEtapas = cfgRow ? JSON.parse(cfgRow.valor) : [];
    const idxEtapa = listaEtapas.findIndex(x => x.etapa === etapa);
    if (idxEtapa < 0) return res.status(400).json({ success: false, data: null, error: 'Etapa no reconocida' });

    // Validar permisos de perfil para esta etapa
    if (!esAdmin) {
      const cfgKey = track === 'SALDO' ? 'etapa_perfiles_saldo' : 'etapa_perfiles_comision';
      const [[permRow]] = await pool.query(`SELECT valor FROM postventa_config WHERE clave = ?`, [cfgKey]);
      if (permRow) {
        const permisos = JSON.parse(permRow.valor); // array de arrays, índice = posición etapa
        const permitidos = permisos[idxEtapa] || [];
        if (permitidos.length && !permitidos.includes(req.usuario?.perfil_nombre))
          return res.status(403).json({ success: false, data: null, error: `Tu perfil no tiene permiso para marcar "${etapa}"` });
      }
    }

    // Etapas actualmente marcadas para este seguimiento
    const [marcadas] = await pool.query(
      `SELECT etapa, fecha FROM postventa_etapas WHERE id_seguimiento = ? AND track = ?`,
      [req.params.id, track]);
    const marcadasSet = new Set(marcadas.map(m => m.etapa));

    if (marcar) {
      // Validación secuencial: la etapa anterior debe estar marcada
      if (idxEtapa > 0) {
        const etapaAnterior = listaEtapas[idxEtapa - 1].etapa;
        if (!marcadasSet.has(etapaAnterior))
          return res.status(400).json({ success: false, data: null, error: `Debes marcar primero "${etapaAnterior}"` });
      }
      await pool.query(
        `INSERT INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE usuario = VALUES(usuario), fecha = NOW()`,
        [req.params.id, track, etapa, usuario]);
      // FACTURA RECIBIDA de comisión: guardar datos de la factura/boleta (incl. excepciones)
      if (track === 'COMISION' && etapa === 'FACTURA RECIBIDA' && req.body.factura) {
        const f = req.body.factura;
        await pool.query(
          `INSERT INTO postventa_facturas_comision
             (id_seguimiento, num_op, rut_dealer, nombre_dealer, fecha_factura, numero_factura, monto_bruto, es_terceros, es_boleta, usuario)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             num_op=VALUES(num_op), rut_dealer=VALUES(rut_dealer), nombre_dealer=VALUES(nombre_dealer),
             fecha_factura=VALUES(fecha_factura), numero_factura=VALUES(numero_factura), monto_bruto=VALUES(monto_bruto),
             es_terceros=VALUES(es_terceros), es_boleta=VALUES(es_boleta), usuario=VALUES(usuario), created_at=NOW()`,
          [req.params.id, f.num_op || null, f.rut_dealer || null, f.nombre_dealer || null,
           f.fecha_factura || null, f.numero_factura || null,
           (f.monto_bruto != null && f.monto_bruto !== '') ? Math.round(Number(f.monto_bruto)) : null,
           f.es_terceros ? 1 : 0, f.es_boleta ? 1 : 0, usuario]);
      }
    } else {
      // Validación desmarcar: debe ser la última marcada
      let lastIdx = -1;
      listaEtapas.forEach((x, i) => { if (marcadasSet.has(x.etapa)) lastIdx = i; });
      if (idxEtapa !== lastIdx)
        return res.status(400).json({ success: false, data: null, error: 'Solo puedes desmarcar la última etapa marcada' });

      // Validación mismo día (solo no-admin)
      if (!esAdmin) {
        const fechaMarca = marcadas.find(m => m.etapa === etapa)?.fecha;
        if (fechaMarca) {
          const hoy = new Date().toISOString().slice(0, 10);
          const diaM = new Date(fechaMarca).toISOString().slice(0, 10);
          if (diaM !== hoy)
            return res.status(403).json({ success: false, data: null, error: 'Solo puedes desmarcar etapas marcadas hoy' });
        }
      }
      await pool.query(
        'DELETE FROM postventa_etapas WHERE id_seguimiento = ? AND track = ? AND etapa = ?',
        [req.params.id, track, etapa]);
      // Al desmarcar FACTURA RECIBIDA de comisión, borrar los datos de la factura
      if (track === 'COMISION' && etapa === 'FACTURA RECIBIDA')
        await pool.query('DELETE FROM postventa_facturas_comision WHERE id_seguimiento = ?', [req.params.id]);
    }
    // Alerta event-driven: al marcar FONDOS RECIBIDOS avisar para emitir Orden de Pago
    if (marcar && track === 'SALDO' && etapa === 'FONDOS RECIBIDOS') {
      const c = await ctxSeguimiento(req.params.id);
      await notificarEventoSaldo('fondos_recibidos', { op: c.num_op, id_seguimiento: Number(req.params.id) });
    }
    // Alerta event-driven: al marcar FACTURA RECIBIDA avisar para emitir Orden de Pago de comisión
    if (marcar && track === 'COMISION' && etapa === 'FACTURA RECIBIDA') {
      const c = await ctxSeguimiento(req.params.id);
      await notificarEventoSaldo('com_factura_recibida', { op: c.num_op, id_seguimiento: Number(req.params.id) });
    }
    res.json({ success: true, data: { id: Number(req.params.id), etapa, marcado: !!marcar, usuario }, error: null });
  } catch (e) {
    console.error('[postventa etapa]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/perfiles-lista ─── */
const getPerfiles = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT nombre FROM perfiles ORDER BY nombre');
    res.json({ success: true, data: rows.map(r => r.nombre), error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── Atribuciones del flujo Saldos Precio: qué perfiles pueden cada acción ──
   Alimenta las notas "Solo pueden modificar: …" en el front. Administrador
   siempre puede (no se lista por separado: ya aparece habilitado en la matriz). */
const CODIGOS_ATRIB = ['pv_fondos_definir','pv_saldos_seleccionar','postventa_saldos_pagar','pv_nomina_generar','pv_orden_emitir','pv_saldos_revertir'];
const getAtribuciones = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT f.codigo, p.nombre AS perfil
       FROM funcionalidades f
       JOIN permisos_perfil pp ON pp.id_funcionalidad = f.id_funcionalidad AND pp.habilitado = 1
       JOIN perfiles p ON p.id_perfil = pp.id_perfil
       WHERE f.codigo IN (?)
       ORDER BY p.nombre`, [CODIGOS_ATRIB]);
    const out = {};
    CODIGOS_ATRIB.forEach(c => out[c] = []);
    rows.forEach(r => { (out[r.codigo] = out[r.codigo] || []).push(r.perfil); });
    res.json({ success: true, data: out, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Atribuciones del flujo Comisión: espejo de Saldo Precio, permisos propios ── */
const CODIGOS_ATRIB_COM = ['pv_com_fondos_definir','pv_com_seleccionar','pv_com_pagar','pv_com_nomina_generar','pv_com_orden_emitir','pv_com_revertir'];
const getAtribucionesComision = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT f.codigo, p.nombre AS perfil
       FROM funcionalidades f
       JOIN permisos_perfil pp ON pp.id_funcionalidad = f.id_funcionalidad AND pp.habilitado = 1
       JOIN perfiles p ON p.id_perfil = pp.id_perfil
       WHERE f.codigo IN (?)
       ORDER BY p.nombre`, [CODIGOS_ATRIB_COM]);
    const out = {};
    CODIGOS_ATRIB_COM.forEach(c => out[c] = []);
    rows.forEach(r => { (out[r.codigo] = out[r.codigo] || []).push(r.perfil); });
    res.json({ success: true, data: out, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Fondos disponibles del día (compartido): Finanzas/Tesorería digita,
   Comercial decide qué pagar. Se guarda en postventa_config; el front valida
   que fecha_dia sea hoy (se "borra" al cambiar de día sin tocar BD). ── */
// ── Config de alertas del proceso Saldo Precio (mantenedor) ──
const getAlertasConfig = async (req, res) => {
  try {
    const lista = req.query.track === 'comision' ? EVENTOS_COMISION : EVENTOS_SALDO;
    const [rows] = await pool.query('SELECT * FROM postventa_alertas_config');
    const map = {}; rows.forEach(r => { map[r.evento] = r; });
    // Devuelve en el orden del workflow, con título/descripción del evento
    const data = lista.map(e => {
      const c = map[e.evento] || {};
      return { evento: e.evento, titulo: e.titulo,
        perfiles: c.perfiles || '', incluir_ejecutivo: !!c.incluir_ejecutivo,
        usuarios_extra: c.usuarios_extra || '', activo: c.activo === undefined ? 1 : c.activo,
        prioridad: c.prioridad || 'normal', sonido: c.sonido === undefined ? 1 : c.sonido,
        sonido_tipo: c.sonido_tipo || 'campana', sonido_cada_seg: c.sonido_cada_seg || 30,
        sonido_max_min: c.sonido_max_min || 5 };
    });
    res.json({ success: true, data, sonidos: SONIDOS_SALDO, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
const setAlertasConfig = async (req, res) => {
  try {
    const lista = Array.isArray(req.body?.config) ? req.body.config : [];
    const EVENTOS_TODOS = [...EVENTOS_SALDO, ...EVENTOS_COMISION];
    for (const c of lista) {
      if (!EVENTOS_TODOS.find(e => e.evento === c.evento)) continue;
      const sonTipo = SONIDOS_SALDO.includes(c.sonido_tipo) ? c.sonido_tipo : 'campana';
      await pool.query(
        `INSERT INTO postventa_alertas_config (evento, perfiles, incluir_ejecutivo, usuarios_extra, activo, prioridad, sonido, sonido_tipo, sonido_cada_seg, sonido_max_min)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE perfiles=VALUES(perfiles), incluir_ejecutivo=VALUES(incluir_ejecutivo),
           usuarios_extra=VALUES(usuarios_extra), activo=VALUES(activo), prioridad=VALUES(prioridad),
           sonido=VALUES(sonido), sonido_tipo=VALUES(sonido_tipo), sonido_cada_seg=VALUES(sonido_cada_seg), sonido_max_min=VALUES(sonido_max_min)`,
        [c.evento, String(c.perfiles || ''), c.incluir_ejecutivo ? 1 : 0,
         String(c.usuarios_extra || ''), c.activo ? 1 : 0,
         c.prioridad === 'alta' ? 'alta' : 'normal', c.sonido ? 1 : 0, sonTipo,
         Math.max(5, parseInt(c.sonido_cada_seg) || 30), Math.max(1, parseInt(c.sonido_max_min) || 5)]);
    }
    res.json({ success: true, data: { actualizados: lista.length }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const getFondos = async (req, res) => {
  try {
    const [[row]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='fondos_disp'");
    let d = null; if (row) { try { d = JSON.parse(row.valor); } catch (_) {} }
    res.json({ success: true, data: d, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
const setFondos = async (req, res) => {
  try {
    const { monto, fecha_iso, fecha_dia } = req.body || {};
    const usuario = ((req.usuario?.nombre || '') + ' ' + (req.usuario?.apellido || '')).trim() || 'Usuario';
    const valor = { monto: Number(monto) || 0, fecha_iso: fecha_iso || new Date().toISOString(), fecha_dia, usuario };
    await pool.query(
      `INSERT INTO postventa_config (clave, valor) VALUES ('fondos_disp', ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`, [JSON.stringify(valor)]);
    // Alerta: montos cargados → Gerente Comercial decide qué pagar (una vez al día)
    if (valor.monto > 0)
      await notificarEventoSaldo('fondos_cargados', { claveExtra: valor.fecha_dia || new Date().toISOString().slice(0, 10) });
    res.json({ success: true, data: valor, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Fondos disponibles para pago de COMISIONES (compartido, válido solo hoy) ── */
const getFondosComision = async (req, res) => {
  try {
    const [[row]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='fondos_disp_comision'");
    let d = null; if (row) { try { d = JSON.parse(row.valor); } catch (_) {} }
    res.json({ success: true, data: d, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
const setFondosComision = async (req, res) => {
  try {
    const { monto, fecha_iso, fecha_dia } = req.body || {};
    const usuario = ((req.usuario?.nombre || '') + ' ' + (req.usuario?.apellido || '')).trim() || 'Usuario';
    const valor = { monto: Number(monto) || 0, fecha_iso: fecha_iso || new Date().toISOString(), fecha_dia, usuario };
    await pool.query(
      `INSERT INTO postventa_config (clave, valor) VALUES ('fondos_disp_comision', ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`, [JSON.stringify(valor)]);
    if (valor.monto > 0)
      await notificarEventoSaldo('com_fondos_cargados', { claveExtra: valor.fecha_dia || new Date().toISOString().slice(0, 10) });
    res.json({ success: true, data: valor, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Config (mantenedor etapa → estado) ──────────────────────────── */
const getConfig = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM postventa_config');
    const out = {};
    rows.forEach(r => { try { out[r.clave] = JSON.parse(r.valor); } catch (_) {} });
    res.json({ success: true, data: out, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
const setConfig = async (req, res) => {
  try {
    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ success: false, data: null, error: 'valor requerido' });
    await pool.query(
      `INSERT INTO postventa_config (clave, valor) VALUES (?,?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
      [req.params.clave, JSON.stringify(valor)]);
    res.json({ success: true, data: { clave: req.params.clave }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/saldos-a-pagar — ops liberadas a pago, no pagadas ── */
const getSaldosAPagar = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.saldo_precio, s.financiera,
             COALESCE(c.nombre_local, d.nombre_razon, s.nombre_dealer) AS nombre_dealer,
             c.id_financiera,
             COALESCE(c.rut_dealer, d.rut) AS rut_dealer,
             d.num_cuenta, d.banco,
             efr.fecha AS fecha_fondos,
             DATEDIFF(CURDATE(), efr.fecha) AS dias,
             (esp.id IS NOT NULL) AS pagado_hoy,
             (eev.id IS NOT NULL) AS enviado,
             eev.usuario AS enviado_por
      FROM postventa_seguimiento s
      JOIN postventa_etapas eop
        ON eop.id_seguimiento = s.id AND eop.track='SALDO' AND eop.etapa='ORDEN DE PAGO EMITIDA'
      LEFT JOIN postventa_etapas eev
        ON eev.id_seguimiento = s.id AND eev.track='SALDO' AND eev.etapa='ENVIADO A PAGO'
      LEFT JOIN postventa_etapas efr
        ON efr.id_seguimiento = s.id AND efr.track='SALDO' AND efr.etapa='FONDOS RECIBIDOS'
      LEFT JOIN postventa_etapas esp
        ON esp.id_seguimiento = s.id AND esp.track='SALDO' AND esp.etapa='SALDO PRECIO PAGADO'
           AND DATE(esp.fecha) = CURDATE()
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  d ON d.nombre_indexa = c.automotora
      WHERE NOT EXISTS (
        SELECT 1 FROM postventa_etapas ep
        WHERE ep.id_seguimiento = s.id AND ep.track='SALDO' AND ep.etapa='SALDO PRECIO PAGADO'
              AND DATE(ep.fecha) < CURDATE())
      ORDER BY efr.fecha ASC, s.num_op ASC
    `);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[postventa saldosAPagar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/orden-pago — casos en FONDOS RECIBIDOS sin ORDEN DE PAGO EMITIDA ── */
const getOrdenPago = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.saldo_precio, s.financiera, s.fecha_otorgado,
             COALESCE(c.nombre_local, d.nombre_razon, s.nombre_dealer) AS nombre_dealer,
             COALESCE(c.rut_dealer, d.rut) AS rut_dealer,
             d.num_cuenta, d.banco, d.rut_pago,
             efr.fecha AS fecha_fondos,
             DATEDIFF(CURDATE(), efr.fecha) AS dias
      FROM postventa_seguimiento s
      JOIN postventa_etapas efr
        ON efr.id_seguimiento = s.id AND efr.track='SALDO' AND efr.etapa='FONDOS RECIBIDOS'
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  d ON d.nombre_indexa = c.automotora
      WHERE NOT EXISTS (
        SELECT 1 FROM postventa_etapas ep
        WHERE ep.id_seguimiento = s.id AND ep.track='SALDO' AND ep.etapa='ORDEN DE PAGO EMITIDA')
      ORDER BY efr.fecha ASC, s.num_op ASC
    `);
    // Montos fijos AutoFin (inscripción + limitación) desde el mantenedor de parámetros
    const [params] = await pool.query(
      "SELECT clave, valor FROM parametros_credito WHERE clave IN ('autofin_inscripcion','autofin_limitacion')");
    const fijos = {};
    params.forEach(p => fijos[p.clave] = parseFloat(p.valor) || 0);
    res.json({ success: true, data: { rows, fijos }, error: null });
  } catch (e) {
    console.error('[postventa getOrdenPago]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/orden-pago/:id/correlativo — crea o devuelve el N° de orden ── */
const correlativoOrden = async (req, res) => {
  const id = Number(req.params.id);
  try {
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id inválido' });
    const [[ya]] = await pool.query('SELECT num_orden FROM postventa_ordenes WHERE id_seguimiento=?', [id]);
    if (ya) return res.json({ success: true, data: { num_orden: ya.num_orden }, error: null });
    const [[seg]] = await pool.query('SELECT num_op, saldo_precio FROM postventa_seguimiento WHERE id=?', [id]);
    if (!seg) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    const [ins] = await pool.query(
      'INSERT INTO postventa_ordenes (id_seguimiento, num_op, monto, usuario) VALUES (?,?,?,?)',
      [id, seg.num_op, seg.saldo_precio, loginDe(req.usuario)]);
    const num = 'OP-' + new Date().getFullYear() + '-' + String(ins.insertId).padStart(5, '0');
    await pool.query('UPDATE postventa_ordenes SET num_orden=? WHERE id=?', [num, ins.insertId]);
    res.json({ success: true, data: { num_orden: num }, error: null });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      const [[row]] = await pool.query('SELECT num_orden FROM postventa_ordenes WHERE id_seguimiento=?', [id]);
      if (row) return res.json({ success: true, data: { num_orden: row.num_orden }, error: null });
    }
    console.error('[postventa correlativoOrden]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/orden-pago/emitir { ids:[] } — marca ORDEN DE PAGO EMITIDA ── */
const emitirOrdenPago = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    // Marca ORDEN DE PAGO EMITIDA (y FONDOS RECIBIDOS por si faltara, para mantener secuencia)
    const vals = [];
    for (const id of ids) {
      vals.push([id, 'SALDO', 'FONDOS RECIBIDOS', usuario]);
      vals.push([id, 'SALDO', 'ORDEN DE PAGO EMITIDA', usuario]);
    }
    await pool.query(
      `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    // Alerta: orden emitida → Tesorería carga montos disponibles
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('orden_emitida', { op: c.num_op, id_seguimiento: id });
    }
    res.json({ success: true, data: { emitidas: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa emitirOrdenPago]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/saldos-a-pagar/enviar-a-pago { ids:[] } — marca ENVIADO A PAGO ──
   El Gerente Comercial (u otro con pv_saldos_seleccionar) fija la selección a pagar.
   A partir de aquí queda en cola firme para que Tesorería confirme el pago. ── */
const enviarAPago = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    const vals = [];
    for (const id of ids) {
      vals.push([id, 'SALDO', 'FONDOS RECIBIDOS', usuario]);
      vals.push([id, 'SALDO', 'ORDEN DE PAGO EMITIDA', usuario]);
      vals.push([id, 'SALDO', 'ENVIADO A PAGO', usuario]);
    }
    await pool.query(
      `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    // Alerta: enviado a pago → Tesorería confirma el pago
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('enviado_pago', { op: c.num_op, id_seguimiento: id });
    }
    res.json({ success: true, data: { enviadas: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa enviarAPago]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/saldos-a-pagar/pagar { ids:[] } — marca SALDO PRECIO PAGADO ── */
const pagarSaldos = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    const [[cfgRow]] = await pool.query(`SELECT valor FROM postventa_config WHERE clave='etapas_saldo'`);
    const etapas = (cfgRow ? JSON.parse(cfgRow.valor) : []).map(x => x.etapa);
    if (!etapas.length)
      return res.status(500).json({ success: false, data: null, error: 'Config de etapas no disponible' });
    const vals = [];
    for (const id of ids)
      for (const e of etapas) vals.push([id, 'SALDO', e, usuario]);
    await pool.query(
      `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    // Alerta: pago realizado → Gerente/Jefe Comercial, ejecutivo de la operación y extra
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('pago_realizado', { op: c.num_op, id_seguimiento: id, ejecutivo: c.ejecutivo });
    }
    res.json({ success: true, data: { pagados: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa pagarSaldos]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/saldos-a-pagar/desmarcar { ids:[], motivo } — revierte SALDO PRECIO PAGADO ──
   Mismo día: cualquiera con permiso. Fuera del día: solo Administrador, con motivo (auditoría). */
const desmarcarSaldos = async (req, res) => {
  try {
    const { ids, motivo } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    // Etapa a revertir: pago (default) o el envío a pago (deshacer "Enviar a Pago")
    const etapa = req.body.etapa === 'ENVIADO A PAGO' ? 'ENVIADO A PAGO' : 'SALDO PRECIO PAGADO';
    const esAdmin = req.usuario?.perfil_nombre === 'Administrador';
    const usuario = loginDe(req.usuario);
    const ph = ids.map(() => '?').join(',');

    // No se puede deshacer el envío de algo que ya fue pagado
    if (etapa === 'ENVIADO A PAGO') {
      const [[{ pagadas }]] = await pool.query(
        `SELECT COUNT(*) AS pagadas FROM postventa_etapas
         WHERE track='SALDO' AND etapa='SALDO PRECIO PAGADO' AND id_seguimiento IN (${ph})`, ids);
      if (pagadas > 0)
        return res.status(400).json({ success: false, data: null, error: 'No se puede deshacer el envío: la operación ya fue pagada.' });
    }

    // ¿Alguna marca NO es de hoy? → es reversa fuera del día
    const [[{ fuera }]] = await pool.query(
      `SELECT COUNT(*) AS fuera FROM postventa_etapas
       WHERE track='SALDO' AND etapa=? AND DATE(fecha) < CURDATE()
         AND id_seguimiento IN (${ph})`, [etapa, ...ids]);

    if (fuera > 0) {
      if (!esAdmin)
        return res.status(403).json({ success: false, data: null, error: 'Solo un Administrador puede revertir una marca de un día anterior.' });
      if (!motivo || !String(motivo).trim())
        return res.status(400).json({ success: false, data: null, error: 'Debes indicar un motivo para revertir una marca de un día anterior.' });
      // Auditoría de la reversa
      const logs = ids.map(id => [id, etapa, usuario, String(motivo).trim().slice(0, 400)]);
      await pool.query('INSERT INTO postventa_reversas (id_seguimiento, etapa, usuario, motivo) VALUES ?', [logs]);
      const [r] = await pool.query(
        `DELETE FROM postventa_etapas
         WHERE track='SALDO' AND etapa=? AND id_seguimiento IN (${ph})`, [etapa, ...ids]);
      return res.json({ success: true, data: { desmarcados: r.affectedRows, reversa: true }, error: null });
    }

    // Mismo día: cualquiera con permiso
    const [r] = await pool.query(
      `DELETE FROM postventa_etapas
       WHERE track='SALDO' AND etapa=?
         AND DATE(fecha) = CURDATE()
         AND id_seguimiento IN (${ph})`, [etapa, ...ids]);
    res.json({ success: true, data: { desmarcados: r.affectedRows, reversa: false }, error: null });
  } catch (e) {
    console.error('[postventa desmarcarSaldos]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   FLUJO COMISIÓN (espejo de Saldo Precio) — track='COMISION'
   Cartolas → FACTURA RECIBIDA → ORDEN DE PAGO EMITIDA → ENVIADO A PAGO → COMISION PAGADA
   ═══════════════════════════════════════════════════════════════════════ */

/* ── GET /api/postventa/:id/factura-comision — datos de la factura recibida ── */
const getFacturaComision = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT * FROM postventa_facturas_comision WHERE id_seguimiento = ?', [req.params.id]);
    res.json({ success: true, data: f || null, error: null });
  } catch (e) {
    console.error('[postventa getFacturaComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── PUT /api/postventa/:id/factura-comision — actualizar datos de la factura (sin tocar la etapa) ── */
const updateFacturaComision = async (req, res) => {
  try {
    const f = req.body || {};
    const usuario = loginDe(req.usuario);
    const [[ex]] = await pool.query(
      `SELECT 1 ok FROM postventa_etapas WHERE id_seguimiento=? AND track='COMISION' AND etapa='FACTURA RECIBIDA' LIMIT 1`,
      [req.params.id]);
    if (!ex) return res.status(400).json({ success: false, data: null, error: 'La etapa FACTURA RECIBIDA no está marcada' });
    await pool.query(
      `INSERT INTO postventa_facturas_comision
         (id_seguimiento, num_op, rut_dealer, nombre_dealer, fecha_factura, numero_factura, monto_bruto, es_terceros, es_boleta, usuario)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         num_op=VALUES(num_op), rut_dealer=VALUES(rut_dealer), nombre_dealer=VALUES(nombre_dealer),
         fecha_factura=VALUES(fecha_factura), numero_factura=VALUES(numero_factura), monto_bruto=VALUES(monto_bruto),
         es_terceros=VALUES(es_terceros), es_boleta=VALUES(es_boleta), usuario=VALUES(usuario), created_at=NOW()`,
      [req.params.id, f.num_op || null, f.rut_dealer || null, f.nombre_dealer || null,
       f.fecha_factura || null, f.numero_factura || null,
       (f.monto_bruto != null && f.monto_bruto !== '') ? Math.round(Number(f.monto_bruto)) : null,
       f.es_terceros ? 1 : 0, f.es_boleta ? 1 : 0, usuario]);
    res.json({ success: true, data: { id: Number(req.params.id) }, error: null });
  } catch (e) {
    console.error('[postventa updateFacturaComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/comisiones-a-pagar — ops con orden de pago de comisión emitida, no pagadas ── */
const getComisionesAPagar = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.comision, s.financiera, s.ejecutivo,
             COALESCE(c.nombre_local, d.nombre_razon, s.nombre_dealer) AS nombre_dealer,
             c.id_financiera,
             COALESCE(c.rut_dealer, d.rut) AS rut_dealer,
             d.num_cuenta, d.banco,
             COALESCE(fc.fecha_factura, efa.fecha) AS fecha_factura,
             fc.numero_factura AS numero_factura, fc.monto_bruto AS monto_factura,
             fc.es_terceros AS es_terceros, fc.es_boleta AS es_boleta,
             DATEDIFF(CURDATE(), efa.fecha) AS dias,
             (epg.id IS NOT NULL) AS pagado_hoy,
             (eev.id IS NOT NULL) AS enviado,
             eev.usuario AS enviado_por
      FROM postventa_seguimiento s
      JOIN postventa_etapas eop
        ON eop.id_seguimiento = s.id AND eop.track='COMISION' AND eop.etapa='ORDEN DE PAGO EMITIDA'
      LEFT JOIN postventa_etapas eev
        ON eev.id_seguimiento = s.id AND eev.track='COMISION' AND eev.etapa='ENVIADO A PAGO'
      LEFT JOIN postventa_etapas efa
        ON efa.id_seguimiento = s.id AND efa.track='COMISION' AND efa.etapa='FACTURA RECIBIDA'
      LEFT JOIN postventa_facturas_comision fc ON fc.id_seguimiento = s.id
      LEFT JOIN postventa_etapas epg
        ON epg.id_seguimiento = s.id AND epg.track='COMISION' AND epg.etapa='COMISION PAGADA'
           AND DATE(epg.fecha) = CURDATE()
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  d ON d.nombre_indexa = c.automotora
      WHERE NOT EXISTS (
        SELECT 1 FROM postventa_etapas ep
        WHERE ep.id_seguimiento = s.id AND ep.track='COMISION' AND ep.etapa='COMISION PAGADA'
              AND DATE(ep.fecha) < CURDATE())
      ORDER BY efa.fecha ASC, s.num_op ASC
    `);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[postventa comisionesAPagar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/orden-pago-comision — ops en FACTURA RECIBIDA sin ORDEN DE PAGO EMITIDA ── */
const getOrdenPagoComision = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.num_op, s.comision, s.financiera, s.fecha_otorgado,
             COALESCE(c.nombre_local, d.nombre_razon, s.nombre_dealer) AS nombre_dealer,
             COALESCE(c.rut_dealer, d.rut) AS rut_dealer,
             d.num_cuenta, d.banco, d.rut_pago,
             COALESCE(fc.fecha_factura, efa.fecha) AS fecha_factura,
             fc.numero_factura AS numero_factura, fc.monto_bruto AS monto_factura,
             fc.es_terceros AS es_terceros, fc.es_boleta AS es_boleta,
             DATEDIFF(CURDATE(), efa.fecha) AS dias
      FROM postventa_seguimiento s
      JOIN postventa_etapas efa
        ON efa.id_seguimiento = s.id AND efa.track='COMISION' AND efa.etapa='FACTURA RECIBIDA'
      LEFT JOIN postventa_facturas_comision fc ON fc.id_seguimiento = s.id
      LEFT JOIN creditos c ON c.id = s.id_credito
      LEFT JOIN dealers  d ON d.nombre_indexa = c.automotora
      WHERE NOT EXISTS (
        SELECT 1 FROM postventa_etapas ep
        WHERE ep.id_seguimiento = s.id AND ep.track='COMISION' AND ep.etapa='ORDEN DE PAGO EMITIDA')
      ORDER BY efa.fecha ASC, s.num_op ASC
    `);
    res.json({ success: true, data: { rows }, error: null });
  } catch (e) {
    console.error('[postventa getOrdenPagoComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/postventa/orden-pago-comision/:id/correlativo ── */
const correlativoOrdenComision = async (req, res) => {
  const id = Number(req.params.id);
  try {
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id inválido' });
    const [[ya]] = await pool.query('SELECT num_orden FROM postventa_ordenes_comision WHERE id_seguimiento=?', [id]);
    if (ya) return res.json({ success: true, data: { num_orden: ya.num_orden }, error: null });
    const [[seg]] = await pool.query('SELECT num_op, comision FROM postventa_seguimiento WHERE id=?', [id]);
    if (!seg) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    const [ins] = await pool.query(
      'INSERT INTO postventa_ordenes_comision (id_seguimiento, num_op, monto, usuario) VALUES (?,?,?,?)',
      [id, seg.num_op, seg.comision, loginDe(req.usuario)]);
    const num = 'OC-' + new Date().getFullYear() + '-' + String(ins.insertId).padStart(5, '0');
    await pool.query('UPDATE postventa_ordenes_comision SET num_orden=? WHERE id=?', [num, ins.insertId]);
    res.json({ success: true, data: { num_orden: num }, error: null });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      const [[row]] = await pool.query('SELECT num_orden FROM postventa_ordenes_comision WHERE id_seguimiento=?', [id]);
      if (row) return res.json({ success: true, data: { num_orden: row.num_orden }, error: null });
    }
    console.error('[postventa correlativoOrdenComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/orden-pago-comision/emitir { ids:[] } — marca ORDEN DE PAGO EMITIDA (COMISION) ── */
const emitirOrdenPagoComision = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    const vals = [];
    for (const id of ids) {
      vals.push([id, 'COMISION', 'FACTURA RECIBIDA', usuario]);
      vals.push([id, 'COMISION', 'ORDEN DE PAGO EMITIDA', usuario]);
    }
    await pool.query(`INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('com_orden_emitida', { op: c.num_op, id_seguimiento: id });
    }
    res.json({ success: true, data: { emitidas: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa emitirOrdenPagoComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/comisiones-a-pagar/enviar-a-pago { ids:[] } — marca ENVIADO A PAGO (COMISION) ── */
const enviarAPagoComision = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    const vals = [];
    for (const id of ids) {
      vals.push([id, 'COMISION', 'FACTURA RECIBIDA', usuario]);
      vals.push([id, 'COMISION', 'ORDEN DE PAGO EMITIDA', usuario]);
      vals.push([id, 'COMISION', 'ENVIADO A PAGO', usuario]);
    }
    await pool.query(`INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('com_enviado_pago', { op: c.num_op, id_seguimiento: id });
    }
    res.json({ success: true, data: { enviadas: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa enviarAPagoComision]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/comisiones-a-pagar/pagar { ids:[] } — marca COMISION PAGADA ── */
const pagarComisiones = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const usuario = loginDe(req.usuario);
    const [[cfgRow]] = await pool.query(`SELECT valor FROM postventa_config WHERE clave='etapas_comision'`);
    const etapas = (cfgRow ? JSON.parse(cfgRow.valor) : []).map(x => x.etapa);
    if (!etapas.length)
      return res.status(500).json({ success: false, data: null, error: 'Config de etapas no disponible' });
    const vals = [];
    for (const id of ids)
      for (const e of etapas) vals.push([id, 'COMISION', e, usuario]);
    await pool.query(`INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
    for (const id of ids) {
      const c = await ctxSeguimiento(id);
      await notificarEventoSaldo('com_pago_realizado', { op: c.num_op, id_seguimiento: id, ejecutivo: c.ejecutivo });
    }
    res.json({ success: true, data: { pagados: ids.length }, error: null });
  } catch (e) {
    console.error('[postventa pagarComisiones]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/comisiones-a-pagar/desmarcar { ids:[], motivo, etapa } — revierte pago/envío (COMISION) ── */
const desmarcarComisiones = async (req, res) => {
  try {
    const { ids, motivo } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin operaciones seleccionadas' });
    const etapa = req.body.etapa === 'ENVIADO A PAGO' ? 'ENVIADO A PAGO' : 'COMISION PAGADA';
    const esAdmin = req.usuario?.perfil_nombre === 'Administrador';
    const usuario = loginDe(req.usuario);
    const ph = ids.map(() => '?').join(',');

    if (etapa === 'ENVIADO A PAGO') {
      const [[{ pagadas }]] = await pool.query(
        `SELECT COUNT(*) AS pagadas FROM postventa_etapas
         WHERE track='COMISION' AND etapa='COMISION PAGADA' AND id_seguimiento IN (${ph})`, ids);
      if (pagadas > 0)
        return res.status(400).json({ success: false, data: null, error: 'No se puede deshacer el envío: la comisión ya fue pagada.' });
    }

    const [[{ fuera }]] = await pool.query(
      `SELECT COUNT(*) AS fuera FROM postventa_etapas
       WHERE track='COMISION' AND etapa=? AND DATE(fecha) < CURDATE()
         AND id_seguimiento IN (${ph})`, [etapa, ...ids]);

    if (fuera > 0) {
      if (!esAdmin)
        return res.status(403).json({ success: false, data: null, error: 'Solo un Administrador puede revertir una marca de un día anterior.' });
      if (!motivo || !String(motivo).trim())
        return res.status(400).json({ success: false, data: null, error: 'Debes indicar un motivo para revertir una marca de un día anterior.' });
      const logs = ids.map(id => [id, etapa, usuario, String(motivo).trim().slice(0, 400)]);
      await pool.query('INSERT INTO postventa_reversas (id_seguimiento, etapa, usuario, motivo) VALUES ?', [logs]);
      const [r] = await pool.query(
        `DELETE FROM postventa_etapas WHERE track='COMISION' AND etapa=? AND id_seguimiento IN (${ph})`, [etapa, ...ids]);
      return res.json({ success: true, data: { desmarcados: r.affectedRows, reversa: true }, error: null });
    }

    const [r] = await pool.query(
      `DELETE FROM postventa_etapas WHERE track='COMISION' AND etapa=?
         AND DATE(fecha) = CURDATE() AND id_seguimiento IN (${ph})`, [etapa, ...ids]);
    res.json({ success: true, data: { desmarcados: r.affectedRows, reversa: false }, error: null });
  } catch (e) {
    console.error('[postventa desmarcarComisiones]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/postventa/marcar-historico — marca pre-2026 como totalmente pagado ── */
const marcarHistorico = async (req, res) => {
  try {
    const [segs] = await pool.query(
      `SELECT id FROM postventa_seguimiento WHERE fecha_otorgado < '2026-01-01'`
    );
    if (!segs.length) return res.json({ success: true, data: { marcados: 0 }, error: null });

    const etapasSaldo   = ['FUNDANTES PENDIENTES','FUNDANTES RECIBIDOS','FUNDANTES ENVIADOS','LIBERADO A PAGO','FONDOS RECIBIDOS','ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','SALDO PRECIO PAGADO'];
    const etapasComision = ['COMISION A PAGAR','CARTOLA EMITIDA','CARTOLA APROBADA','CARTOLA ENVIADA','FACTURA RECIBIDA','ORDEN DE PAGO EMITIDA','COMISION PAGADA'];
    const fecha = '2025-12-31 23:59:59';
    const vals = [];
    for (const s of segs) {
      for (const e of etapasSaldo)    vals.push([s.id, 'SALDO',    e, 'Sistema', fecha]);
      for (const e of etapasComision) vals.push([s.id, 'COMISION', e, 'Sistema', fecha]);
    }
    await pool.query(
      `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha) VALUES ?`,
      [vals]
    );
    res.json({ success: true, data: { marcados: segs.length }, error: null });
  } catch (e) {
    console.error('[postventa marcarHistorico]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { sync, getAll, setEtapa, getConfig, setConfig, marcarHistorico, getPerfiles, getSaldosAPagar, enviarAPago, pagarSaldos, getOrdenPago, correlativoOrden, emitirOrdenPago, desmarcarSaldos, getAtribuciones, getFondos, setFondos, getAlertasConfig, setAlertasConfig,
  getComisionesAPagar, getOrdenPagoComision, correlativoOrdenComision, emitirOrdenPagoComision, enviarAPagoComision, pagarComisiones, desmarcarComisiones, getAtribucionesComision, getFondosComision, setFondosComision,
  getFacturaComision, updateFacturaComision };
