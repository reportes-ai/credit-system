'use strict';
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ── Migración ───────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('cartolas', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cartolas_movimientos (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        mes             VARCHAR(7)  NOT NULL,
        id_carta        INT         DEFAULT NULL,
        num_op          INT DEFAULT NULL,
        movimiento      ENUM('COMISION','PREPAGO','ANULACION') NOT NULL DEFAULT 'COMISION',
        rut_dealer      VARCHAR(20)  DEFAULT NULL,
        nombre_dealer   VARCHAR(200) DEFAULT NULL,
        mail            VARCHAR(200) DEFAULT NULL,
        ejecutivo       VARCHAR(150) DEFAULT NULL,
        nombre_cliente  VARCHAR(200) DEFAULT NULL,
        rut_cliente     VARCHAR(20)  DEFAULT NULL,
        saldo           BIGINT DEFAULT NULL,
        comision        BIGINT DEFAULT NULL,
        estado_comision VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
        num_carta       VARCHAR(40)  DEFAULT NULL,
        vendedor        VARCHAR(150) DEFAULT NULL,
        acreedor        VARCHAR(100) DEFAULT NULL,
        observaciones   TEXT,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mes (mes),
        INDEX idx_carta (id_carta),
        INDEX idx_conc (rut_dealer)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cartolas_enviadas (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        mes           VARCHAR(7)   NOT NULL,
        rut_dealer    VARCHAR(20)  DEFAULT NULL,
        nombre_dealer VARCHAR(200) NOT NULL,
        mail          VARCHAR(200) DEFAULT NULL,
        total_bruto   BIGINT DEFAULT NULL,
        enviado_por   VARCHAR(150) DEFAULT NULL,
        fecha_envio   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mes (mes)
      )
    `);
    // Auditoría de cambio de estado de comisión + a qué cartola (mes) salió pagada
    await pool.query(`ALTER TABLE cartolas_movimientos ADD COLUMN IF NOT EXISTS estado_usuario VARCHAR(150) DEFAULT NULL`).catch(()=>{});
    await pool.query(`ALTER TABLE cartolas_movimientos ADD COLUMN IF NOT EXISTS estado_fecha DATETIME DEFAULT NULL`).catch(()=>{});
    await pool.query(`ALTER TABLE cartolas_movimientos ADD COLUMN IF NOT EXISTS mes_cartola VARCHAR(7) DEFAULT NULL`).catch(()=>{});
    await pool.query(`ALTER TABLE cartolas_movimientos ADD COLUMN IF NOT EXISTS enviada_por VARCHAR(150) DEFAULT NULL`).catch(()=>{});
    await pool.query(`ALTER TABLE cartolas_movimientos ADD COLUMN IF NOT EXISTS enviada_fecha DATETIME DEFAULT NULL`).catch(()=>{});
    await pool.query(`ALTER TABLE cartolas_movimientos ADD INDEX idx_mes_cartola (mes_cartola)`).catch(()=>{});
    // Guarda los ids de movimientos incluidos en cada envío → reverso preciso (no por dealer)
    await pool.query(`ALTER TABLE cartolas_enviadas ADD COLUMN IF NOT EXISTS mov_ids TEXT`).catch(()=>{});
    // Homologación: rut_conc → rut_dealer en cartolas_movimientos y cartolas_enviadas
    for (const t of ['cartolas_movimientos','cartolas_enviadas']) {
      try {
        const [[rc]] = await pool.query(
          `SELECT COUNT(*) AS c FROM information_schema.columns
           WHERE table_schema=DATABASE() AND table_name=? AND column_name='rut_conc'`, [t]);
        if (rc.c > 0) await pool.query(`ALTER TABLE \`${t}\` CHANGE COLUMN rut_conc rut_dealer VARCHAR(20) DEFAULT NULL`);
      } catch(e){ console.error('[cartolas rename rut_conc '+t+']', e.message); }
    }
    // Homologación: concesionario → nombre_dealer
    for (const [t, def] of [['cartolas_movimientos','VARCHAR(200) DEFAULT NULL'],['cartolas_enviadas','VARCHAR(200) NOT NULL']]) {
      try {
        const [[cc]] = await pool.query(
          `SELECT COUNT(*) AS c FROM information_schema.columns
           WHERE table_schema=DATABASE() AND table_name=? AND column_name='concesionario'`, [t]);
        if (cc.c > 0) await pool.query(`ALTER TABLE \`${t}\` CHANGE COLUMN concesionario nombre_dealer ${def}`);
      } catch(e){ console.error('[cartolas rename concesionario '+t+']', e.message); }
    }
    // Homologación: num_op varchar->int (datos verificados 100% numéricos)
    try {
      const [[nc]] = await pool.query(`SELECT data_type dt FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='cartolas_movimientos' AND column_name='num_op'`);
      if (nc && String(nc.dt).toLowerCase() === 'varchar') await pool.query(`ALTER TABLE cartolas_movimientos MODIFY COLUMN num_op INT DEFAULT NULL`);
    } catch(e){ console.error('[num_op->int cartolas_movimientos]', e.message); }
    /* ── ADICIONALES y DESCUENTOS de cartola (Pato, 08-09-2026) ──────────────────
       Un movimiento manual sin operación: monto a favor (ADICIONAL) o en contra
       (DESCUENTO) del dealer, con GLOSA (sale en la cartola y en la orden de pago)
       y COMENTARIO interno (por qué). Lo aprueba el SUPERVISOR del digitador
       (usuarios.id_supervisor) o un Administrador; mientras tanto no suma. */
    await pool.query(`ALTER TABLE cartolas_movimientos MODIFY COLUMN movimiento ENUM('COMISION','PREPAGO','ANULACION','ADICIONAL','DESCUENTO') NOT NULL DEFAULT 'COMISION'`).catch(()=>{});
    for (const col of ['glosa VARCHAR(200) DEFAULT NULL', 'comentario VARCHAR(600) DEFAULT NULL',
      "aprobacion VARCHAR(12) DEFAULT NULL", 'creado_por VARCHAR(150) DEFAULT NULL', 'id_creado_por INT DEFAULT NULL',
      'id_aprobador INT DEFAULT NULL', 'aprobado_por VARCHAR(150) DEFAULT NULL', 'aprobado_at DATETIME DEFAULT NULL', 'aprob_comentario VARCHAR(600) DEFAULT NULL']) {
      await pool.query(`ALTER TABLE cartolas_movimientos ADD COLUMN IF NOT EXISTS ${col}`).catch(()=>{});
    }
    const [[modPV]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre LIKE 'Post Venta%' OR ruta LIKE '/postventa%' LIMIT 1");
    for (const [nombre, codigo, heredaDe] of [
      ['Cartolas — agregar adicional o descuento', 'cartola_ajuste_crear', 'aprob_cartolas'],
      ['Cartolas — aprobar adicional o descuento (supervisor)', 'cartola_ajuste_aprobar', 'aprob_cartolas'],
    ]) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (!ex && modPV) {
        await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,NULL,NULL)', [modPV.id_modulo, nombre, codigo]);
        await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
          SELECT pp.id_perfil, (SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?), 1
            FROM permisos_perfil pp JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
           WHERE f.codigo=? AND pp.habilitado=1`, [codigo, heredaDe]);
      }
    }
    console.log('[cartolas] tablas OK');
  } catch (e) { console.error('[cartolas migration]', e.message); }
});
const AVISOS = require('../../../../shared/avisos');
AVISOS.registrarAviso({
  evento: 'cartola_ajuste_pendiente', modulo: 'Cartolas',
  nombre: 'Adicional o descuento de cartola por aprobar',
  descripcion: 'Un digitador agregó un adicional o descuento a la cartola de un dealer. Avisa al SUPERVISOR del digitador (ficha de Usuarios) que debe aprobarlo o rechazarlo; sin supervisor, al pool que aprueba ajustes.',
  base_func: 'cartola_ajuste_aprobar', prioridad: 'alta', sonido_tipo: 'dingdong',
});
AVISOS.registrarAviso({
  evento: 'cartola_ajuste_resuelto', modulo: 'Cartolas',
  nombre: 'Adicional o descuento de cartola aprobado o rechazado',
  descripcion: 'El supervisor resolvió un adicional/descuento de cartola. Avisa a quien lo digitó.',
  base_func: 'cartola_ajuste_crear', prioridad: 'normal', sonido_tipo: 'campana',
});
const nombreUsuario = u => (u?.nombre ? (u.nombre + ' ' + (u.apellido || '')).trim() : u?.email) || 'Usuario';

/* Mes anterior en 'YYYY-MM' (hora Chile): la cartola de este mes lleva movimientos
   con mes < mes actual, así que el ajuste nace fechado en el mes anterior. */
function mesAnteriorChile() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  d.setDate(1); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ── POST /api/cartolas/ajuste { rut_dealer, nombre_dealer, tipo, monto, glosa, comentario } ── */
const crearAjuste = async (req, res) => {
  try {
    const b = req.body || {};
    const tipo = String(b.tipo || '').toUpperCase();
    const monto = Math.round(Number(String(b.monto ?? '').toString().replace(/[^\d]/g, '')) || 0);
    const glosa = String(b.glosa || '').trim().slice(0, 200);
    const comentario = String(b.comentario || '').trim().slice(0, 600);
    if (!['ADICIONAL', 'DESCUENTO'].includes(tipo)) return res.status(400).json({ success: false, data: null, error: 'Tipo inválido (ADICIONAL o DESCUENTO)' });
    if (!(monto > 0)) return res.status(400).json({ success: false, data: null, error: 'El monto debe ser mayor a 0' });
    if (!glosa) return res.status(400).json({ success: false, data: null, error: 'La glosa es obligatoria: es lo que verá el dealer en la cartola y la orden de pago' });
    if (!comentario) return res.status(400).json({ success: false, data: null, error: 'El comentario es obligatorio: explica a qué se debe el ajuste' });
    if (!b.rut_dealer && !b.nombre_dealer) return res.status(400).json({ success: false, data: null, error: 'Falta el dealer' });
    const quien = nombreUsuario(req.usuario);
    // Supervisor del digitador: aprueba él; sin supervisor, el pool del permiso.
    const [[u]] = await pool.query('SELECT id_supervisor FROM usuarios WHERE id_usuario=?', [req.usuario.id_usuario]).catch(() => [[null]]);
    const idSup = u && u.id_supervisor ? Number(u.id_supervisor) : null;
    const [r] = await pool.query(
      `INSERT INTO cartolas_movimientos (mes, movimiento, rut_dealer, nombre_dealer, comision, estado_comision, glosa, comentario,
         aprobacion, creado_por, id_creado_por, id_aprobador, observaciones)
       VALUES (?,?,?,?,?,'POR APROBAR',?,?,'PENDIENTE',?,?,?,?)`,
      [mesAnteriorChile(), tipo, b.rut_dealer || null, b.nombre_dealer || null, monto, glosa, comentario,
       quien, req.usuario.id_usuario, idSup, glosa]);
    auditar({ req, accion: 'CREAR', modulo: 'cartolas', entidad: 'cartola_ajuste', entidad_id: r.insertId,
      detalle: `${tipo} $${monto.toLocaleString('es-CL')} a ${b.nombre_dealer || b.rut_dealer}: "${glosa}" — ${comentario}` });
    AVISOS.avisar('cartola_ajuste_pendiente', {
      titulo: `⏰ ${tipo === 'ADICIONAL' ? 'Adicional' : 'Descuento'} de cartola por aprobar — ${b.nombre_dealer || b.rut_dealer}`,
      mensaje: `${quien} agregó un ${tipo.toLowerCase()} de $${monto.toLocaleString('es-CL')} a la cartola de ${b.nombre_dealer || b.rut_dealer}. Glosa: "${glosa}". Motivo: ${comentario}. Requiere tu aprobación.`,
      href: '/aprobaciones/?tab=cartolas', clave: 'cartola_ajuste:' + r.insertId,
    }, idSup ? { soloA: [idSup] } : { excluir: [req.usuario.id_usuario] }).catch(() => {});
    res.status(201).json({ success: true, data: { id: r.insertId, id_aprobador: idSup }, error: null });
  } catch (e) { console.error('[cartolas crearAjuste]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── PUT /api/cartolas/ajuste/:id { accion:'APROBAR'|'RECHAZAR', comentario } — supervisor ── */
const resolverAjuste = async (req, res) => {
  try {
    const [[m]] = await pool.query("SELECT * FROM cartolas_movimientos WHERE id=? AND movimiento IN ('ADICIONAL','DESCUENTO') AND aprobacion='PENDIENTE'", [req.params.id]);
    if (!m) return res.status(404).json({ success: false, data: null, error: 'Ajuste no encontrado o ya resuelto' });
    const yo = req.usuario;
    const esAdmin = yo.perfil_nombre === 'Administrador';
    if (Number(m.id_creado_por) === Number(yo.id_usuario))
      return res.status(403).json({ success: false, data: null, error: 'No puedes aprobar un ajuste que digitaste tú: lo resuelve tu supervisor.' });
    if (!esAdmin && m.id_aprobador && Number(m.id_aprobador) !== Number(yo.id_usuario))
      return res.status(403).json({ success: false, data: null, error: 'Este ajuste lo aprueba el supervisor de quien lo digitó (o un Administrador).' });
    const aprobar = String(req.body.accion || '').toUpperCase() === 'APROBAR';
    const comentario = String(req.body.comentario || '').trim().slice(0, 600);
    if (!aprobar && !comentario) return res.status(400).json({ success: false, data: null, error: 'Para rechazar, el comentario es obligatorio' });
    const quien = nombreUsuario(yo);
    const estadoCom = aprobar ? (m.movimiento === 'ADICIONAL' ? 'A PAGAR' : 'A DESCONTAR') : 'RECHAZADO';
    await pool.query(
      `UPDATE cartolas_movimientos SET aprobacion=?, estado_comision=?, estado_usuario=?, estado_fecha=NOW(),
         aprobado_por=?, aprobado_at=NOW(), aprob_comentario=? WHERE id=?`,
      [aprobar ? 'APROBADA' : 'RECHAZADA', estadoCom, quien, quien, comentario || null, m.id]);
    AVISOS.retirar('cartola_ajuste:' + m.id).catch(() => {});
    auditar({ req, accion: aprobar ? 'APROBAR' : 'RECHAZAR', modulo: 'cartolas', entidad: 'cartola_ajuste', entidad_id: m.id,
      detalle: `${m.movimiento} $${Number(m.comision).toLocaleString('es-CL')} a ${m.nombre_dealer || m.rut_dealer} ("${m.glosa}") ${aprobar ? 'APROBADO' : 'RECHAZADO'}${comentario ? ': ' + comentario : ''}` });
    AVISOS.avisar('cartola_ajuste_resuelto', {
      titulo: (aprobar ? '✅ Ajuste de cartola APROBADO' : '🔴 Ajuste de cartola RECHAZADO') + ' — ' + (m.nombre_dealer || m.rut_dealer),
      mensaje: `${quien} ${aprobar ? 'aprobó' : 'rechazó'} el ${m.movimiento.toLowerCase()} de $${Number(m.comision).toLocaleString('es-CL')} ("${m.glosa}").${comentario ? ' ' + comentario : ''}`,
      href: '/aprobaciones/?tab=cartolas',
    }, { soloA: m.id_creado_por ? [m.id_creado_por] : null }).catch(() => {});
    res.json({ success: true, data: { estado: aprobar ? 'APROBADA' : 'RECHAZADA', estado_comision: estadoCom }, error: null });
  } catch (e) { console.error('[cartolas resolverAjuste]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/cartolas/sync ─────────────────────────────────────────
   1) Marca otorgado=1 en cartas cuya id_financiera existe en creditos (cr.num_op).
   2) Crea el movimiento COMISION del mes para cada carta otorgada
      aprobada que aún no lo tenga.                                    */
const sync = async (req, res) => {
  try {
    /* Que EXISTA el crédito no significa que se haya otorgado: un crédito puede
       estar APROBADO, DIGITADO o incluso ANULADO. Sin exigir OTORGADO, el sync
       marcaba la carta como otorgada y le generaba comisión en la cartola a
       operaciones que nunca se cursaron (8 casos por $3,8 MM detectados el
       31-07-2026, ninguno alcanzó a facturarse). La fecha de otorgamiento del
       CRÉDITO manda: si no la tiene, no está otorgado. */
    const [r1] = await pool.query(`
      UPDATE cartas_aprobacion ca
      JOIN creditos cr ON cr.num_op = ca.id_financiera
      SET ca.otorgado = 1,
          ca.numero_credito_creado = cr.num_op,
          ca.id_credito_creado     = cr.id,
          ca.fecha_otorgado        = COALESCE(ca.fecha_otorgado, cr.fecha_otorgado, NOW())
      WHERE ca.otorgado = 0 AND ca.status = 'APROBADA'
        AND cr.fecha_otorgado IS NOT NULL
        AND 'OTORGADO' IN (UPPER(COALESCE(cr.estado,'')), UPPER(COALESCE(cr.estado_credito,'')), UPPER(COALESCE(cr.estado_eval,'')))
        AND UPPER(COALESCE(cr.estado,''))         NOT IN ('ANULADO','DESISTIDO','RECHAZADO','NO OTORGADO')
        AND UPPER(COALESCE(cr.estado_credito,'')) NOT IN ('ANULADO','DESISTIDO','RECHAZADO','NO OTORGADO')
        AND UPPER(COALESCE(cr.estado_eval,''))    NOT IN ('ANULADO','DESISTIDO','RECHAZADO','NO OTORGADO')
    `);

    const [r2] = await pool.query(`
      INSERT INTO cartolas_movimientos
        (mes, id_carta, num_op, movimiento, rut_dealer, nombre_dealer,
         ejecutivo, nombre_cliente, rut_cliente, saldo, comision,
         estado_comision, num_carta, vendedor, acreedor)
      SELECT DATE_FORMAT(COALESCE(ca.fecha_otorgado, NOW()), '%Y-%m'),
             ca.id, ca.id_financiera, 'COMISION', ca.rut_dealer, ca.nombre_dealer,
             ca.ejecutivo, ca.cliente, ca.rut_cliente, ca.saldo,
             /* La comisión vigente del CRÉDITO manda (08-09-2026): ya trae la precedencia del
                motor comisionDealerEfectiva (carta solo hacia abajo, comparando %); la
                carta solo si el crédito no tiene comisión. Antes la carta mandaba siempre. */
             COALESCE(NULLIF(crx.comdea_real,0), ca.part_bruto),
             'PENDIENTE', ca.op_carta, ca.vendedor, ca.acreedor
      FROM cartas_aprobacion ca
      LEFT JOIN creditos crx ON crx.id = ca.id_credito_creado
      WHERE ca.otorgado = 1 AND ca.status = 'APROBADA'
        -- Segunda barrera: aunque la carta esté marcada otorgada (marcas viejas o
        -- a mano), no se genera comisión si la operación no está OTORGADA.
        -- La etapa vive en TRES columnas y a veces discrepan: basta que UNA diga
        -- OTORGADO, pero NINGUNA puede decir anulado/desistido/rechazado.
        AND EXISTS (
          SELECT 1 FROM creditos cv
          WHERE cv.num_op = ca.id_financiera
            AND cv.fecha_otorgado IS NOT NULL
            AND 'OTORGADO' IN (UPPER(COALESCE(cv.estado,'')), UPPER(COALESCE(cv.estado_credito,'')), UPPER(COALESCE(cv.estado_eval,'')))
            AND UPPER(COALESCE(cv.estado,''))         NOT IN ('ANULADO','DESISTIDO','RECHAZADO','NO OTORGADO')
            AND UPPER(COALESCE(cv.estado_credito,'')) NOT IN ('ANULADO','DESISTIDO','RECHAZADO','NO OTORGADO')
            AND UPPER(COALESCE(cv.estado_eval,''))    NOT IN ('ANULADO','DESISTIDO','RECHAZADO','NO OTORGADO')
        )
        -- Tercera barrera: UNA COMISION POR OPERACION, no por carta. Deduplicar
        -- por id_carta dejaba que una operacion con varias cartas aprobadas
        -- generara una comision por cada una (9 operaciones duplicadas). Se
        -- compara contra AMBAS llaves porque el historico de num_op guarda a
        -- veces el ID Financiera y a veces el N de operacion.
        AND NOT EXISTS (
          SELECT 1 FROM cartolas_movimientos m
          WHERE m.movimiento = 'COMISION'
            AND (m.id_carta = ca.id
              OR m.num_op = ca.id_financiera
              OR m.num_op IN (SELECT cx.num_op FROM creditos cx WHERE cx.id_financiera = ca.id_financiera))
        )
    `);

    res.json({ success: true, data: { otorgados_marcados: r1.affectedRows, comisiones_creadas: r2.affectedRows }, error: null });
  } catch (e) {
    console.error('[cartolas sync]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/cartolas?mes=YYYY-MM ──────────────────────────────── */
const getMovimientos = async (req, res) => {
  try {
    const { mes } = req.query;
    const where = [], vals = [];
    if (mes) { where.push('m.mes = ?'); vals.push(mes); }
    // num_op guardado = id_financiera (N° de la financiera). JOIN al crédito enlazado
    // para exponer NUESTRO N° de operación real (creditos.num_op).
    const [rows] = await pool.query(
      `SELECT m.*, m.rut_dealer AS rut_conc, m.nombre_dealer AS concesionario, cr.num_op AS nuestro_num_op, ca.ejecutivo_mail AS ejecutivo_mail,
              /* Ubicación del movimiento (multi-local v218.6): el LOCAL donde cursó la op.
                 Fuente única = el crédito (parque histórico de ESA operación), con la carta
                 como fallback. Los placeholders viejos ('PARQUE'/'NO APLICA'/'S/I') no son
                 un nombre de local y se saltan. La cartola agrupa por esto sus secciones. */
              COALESCE(
                NULLIF(NULLIF(NULLIF(NULLIF(UPPER(TRIM(cr.parque)),''),'NO APLICA'),'S/I'),'PARQUE'),
                NULLIF(UPPER(TRIM(cr.nombre_parque_mgmt)),''),
                NULLIF(NULLIF(UPPER(TRIM(ca.parque)),''),'NO APLICA'),
                CASE WHEN UPPER(COALESCE(cr.tipo_ubicacion,''))='CALLE' OR UPPER(COALESCE(ca.tipo,'')) LIKE '%CALLE%' THEN 'CALLE' END
              ) AS ubicacion
       FROM cartolas_movimientos m
       LEFT JOIN cartas_aprobacion ca ON ca.id = m.id_carta
       LEFT JOIN creditos cr ON cr.id = ca.id_credito_creado
                             OR (m.id_carta IS NULL AND cr.id_financiera = m.num_op)
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY m.mes DESC, m.nombre_dealer, m.id`, vals
    );
    // Resolver mail del ejecutivo: directo de la carta, o por nombre contra catálogo
    // combinado (cartas_ejecutivos + usuarios), con match de tokens normalizados.
    if (rows.length) {
      const norm = s => String(s||'').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
      const [cat] = await pool.query(
        `SELECT nombre, mail FROM cartas_ejecutivos WHERE mail IS NOT NULL AND mail<>''
         UNION
         SELECT TRIM(CONCAT(nombre,' ',COALESCE(apellido,''))) AS nombre, email AS mail
         FROM usuarios WHERE estado='activo' AND email IS NOT NULL AND email<>''`);
      const idx = cat.map(c => ({ tk: norm(c.nombre), mail: c.mail })).filter(x => x.tk.length);
      const resolver = nombre => {
        const tk = norm(nombre); if (!tk.length) return null;
        const h = idx.find(e => e.tk.every(t => tk.includes(t)) || tk.every(t => e.tk.includes(t)));
        return h ? h.mail : null;
      };
      for (const r of rows) {
        if (!r.ejecutivo_mail || !String(r.ejecutivo_mail).trim()) r.ejecutivo_mail = resolver(r.ejecutivo);
      }
    }
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[cartolas get]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/cartolas — prepago o anulación manual ─────────────── */
const crearMovimiento = async (req, res) => {
  try {
    const m = req.body;
    if (!m.mes || !m.movimiento || !['PREPAGO','ANULACION'].includes(m.movimiento))
      return res.status(400).json({ success: false, data: null, error: 'mes y movimiento (PREPAGO|ANULACION) requeridos' });
    if (!m.num_op) return res.status(400).json({ success: false, data: null, error: 'num_op requerido' });

    // Si la op tiene cartola COMISION, copiar datos del concesionario
    let [[base]] = await pool.query(
      `SELECT * FROM cartolas_movimientos WHERE num_op = ? AND movimiento='COMISION' ORDER BY id DESC LIMIT 1`,
      [m.num_op]
    );
    // Sin movimiento previo (ops viejas/INDEXA): los datos salen del CRÉDITO
    // (fuente única) — antes el prepago quedaba sin dealer, ejecutivo ni saldo.
    if (!base) {
      const [[cr]] = await pool.query(
        `SELECT c.automotora AS nombre_dealer, c.rut_dealer, c.ejecutivo, c.saldo_precio AS saldo,
                COALESCE(NULLIF(cl.nombre_completo,''), NULLIF(TRIM(CONCAT(COALESCE(cl.nombres,''),' ',COALESCE(cl.apellido_paterno,''))),'')) AS nombre_cliente,
                cl.rut AS rut_cliente
           FROM creditos c
           LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
          WHERE CAST(c.id_financiera AS CHAR) = CAST(? AS CHAR) OR CAST(c.num_op AS CHAR) = CAST(? AS CHAR)
          LIMIT 1`, [m.num_op, m.num_op]).catch(() => [[null]]);
      base = cr || null;
    }
    const [r] = await pool.query(
      `INSERT INTO cartolas_movimientos
        (mes, id_carta, num_op, movimiento, rut_dealer, nombre_dealer, mail, ejecutivo,
         nombre_cliente, rut_cliente, saldo, comision, estado_comision, num_carta, vendedor, acreedor, observaciones)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [m.mes, base?.id_carta || null, m.num_op, m.movimiento,
       m.rut_conc || base?.rut_dealer || null, m.concesionario || base?.nombre_dealer || null,
       m.mail || base?.mail || null, m.ejecutivo || base?.ejecutivo || null,
       m.nombre_cliente || base?.nombre_cliente || null, m.rut_cliente || base?.rut_cliente || null,
       m.saldo ?? base?.saldo ?? null, m.comision ?? null,
       m.estado_comision || 'A DESCONTAR', m.num_carta || base?.num_carta || null,
       m.vendedor || base?.vendedor || null, m.acreedor || base?.acreedor || null,
       m.observaciones || null]
    );
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    console.error('[cartolas crear]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── PUT /api/cartolas/:id ───────────────────────────────────────── */
const updateMovimiento = async (req, res) => {
  try {
    const CAMPOS = ['estado_comision','observaciones','comision','movimiento','mail','mes'];
    const sets = [], vals = [];
    for (const c of CAMPOS) {
      if (req.body[c] !== undefined) { sets.push(`\`${c}\` = ?`); vals.push(req.body[c]); }
    }
    // Auditoría: al cambiar el estado de la comisión se graba quién y cuándo
    if (req.body.estado_comision !== undefined) {
      sets.push('estado_usuario = ?'); vals.push(nombreUsuario(req.usuario));
      sets.push('estado_fecha = NOW()');
    }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Sin campos' });
    vals.push(req.params.id);
    await pool.query(`UPDATE cartolas_movimientos SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ success: true, data: { id: Number(req.params.id) }, error: null });
  } catch (e) {
    console.error('[cartolas update]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── DELETE /api/cartolas/:id ────────────────────────────────────── */
const deleteMovimiento = async (req, res) => {
  try {
    await pool.query('DELETE FROM cartolas_movimientos WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: { deleted: Number(req.params.id) }, error: null });
  } catch (e) {
    console.error('[cartolas delete]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Enviadas ────────────────────────────────────────────────────── */
const getEnviadas = async (req, res) => {
  try {
    const { mes } = req.query;
    const where = mes ? 'WHERE mes = ?' : '';
    const [rows] = await pool.query(
      `SELECT *, rut_dealer AS rut_conc, nombre_dealer AS concesionario FROM cartolas_enviadas ${where} ORDER BY fecha_envio DESC LIMIT 500`,
      mes ? [mes] : []
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[cartolas enviadas]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* Seguimientos de Post Venta de un conjunto de movimientos de cartola.
   Con carta: vía ca.id_credito_creado. SIN carta (ops digitadas directas — el
   movimiento referencia el ID Financiera en num_op): vía creditos, primero por
   id_financiera y si no por num_op. Sin esta segunda rama las ops sin carta
   nunca recibían CARTOLA ENVIADA aunque la cartola se enviara (op 89013,
   detectado 25-08-2026). CON carta pero id_credito_creado HUÉRFANO (382 de 600
   cartas apuntan a ids de creditos anteriores a la re-migración de la tabla):
   se confiaba en ese id y no se caía al respaldo, así que la op tampoco recibía
   CARTOLA ENVIADA (ops 5381115/5714593/5738833, cartola 330003 del 18-08-2026,
   detectado 07-09-2026). Ahora el id de la carta solo vale si existe en creditos.
   filtroSql usa alias `m`. */
async function segsDeMovs(filtroSql, vals) {
  const [movs] = await pool.query(
    `SELECT m.id, m.num_op, ca.id_credito_creado, cc.id AS id_credito_ok
       FROM cartolas_movimientos m
       LEFT JOIN cartas_aprobacion ca ON ca.id = m.id_carta
       LEFT JOIN creditos cc ON cc.id = ca.id_credito_creado
      WHERE ${filtroSql}`, vals);
  const credIds = new Set();
  for (const m of movs) {
    if (m.id_credito_ok) { credIds.add(Number(m.id_credito_ok)); continue; }
    if (!m.num_op) continue;
    const [[cr]] = await pool.query(
      `SELECT id FROM creditos
        WHERE (id_financiera = ? AND financiera != 'NO APLICA') OR num_op = ?
        ORDER BY (id_financiera = ?) DESC LIMIT 1`,
      [String(m.num_op), m.num_op, String(m.num_op)]);
    if (cr) credIds.add(cr.id);
  }
  if (!credIds.size) return [];
  const [segs] = await pool.query(
    'SELECT id AS seg_id FROM postventa_seguimiento WHERE id_credito IN (?)', [[...credIds]]);
  return segs;
}

/* Adicionales/descuentos POR APROBAR de un dealer que aún no salieron en una cartola.
   Mientras exista uno, la cartola NO se envía (Pato 10-09-2026): el dealer no debe
   recibir un monto que el supervisor todavía no confirma. */
async function ajustesPendientes(rut, nombre) {
  if (!rut && !nombre) return 0;
  const [[r]] = await pool.query(
    `SELECT COUNT(*) n FROM cartolas_movimientos
      WHERE movimiento IN ('ADICIONAL','DESCUENTO') AND aprobacion='PENDIENTE' AND mes_cartola IS NULL
        AND ${rut ? 'rut_dealer = ?' : 'nombre_dealer = ?'}`, [rut || nombre]);
  return Number(r.n) || 0;
}
const msgPendientes = n => `La cartola tiene ${n} adicional(es)/descuento(s) por aprobar. El supervisor debe aprobarlos o rechazarlos antes de enviarla.`;

const registrarEnvio = async (req, res) => {
  try {
    const { mes, rut_conc, concesionario, mail, total_bruto, ids } = req.body;
    if (!mes || !concesionario)
      return res.status(400).json({ success: false, data: null, error: 'mes y concesionario requeridos' });
    const pend = await ajustesPendientes(rut_conc, concesionario);
    if (pend) return res.status(409).json({ success: false, data: null, error: msgPendientes(pend) });
    const enviadoPor = nombreUsuario(req.usuario);
    const movIds = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : [];
    const [r] = await pool.query(
      `INSERT INTO cartolas_enviadas (mes, rut_dealer, nombre_dealer, mail, total_bruto, enviado_por, mov_ids)
       VALUES (?,?,?,?,?,?,?)`,
      [mes, rut_conc || null, concesionario, mail || null, total_bruto || null, enviadoPor, movIds.length ? JSON.stringify(movIds) : null]
    );
    // Estampa el mes de la cartola en los movimientos incluidos (no re-estampa si ya salieron antes)
    let marcados = 0;
    if (movIds.length) {
      const ph = movIds.map(() => '?').join(',');
      const [u] = await pool.query(
        `UPDATE cartolas_movimientos SET mes_cartola=?, enviada_por=?, enviada_fecha=NOW()
         WHERE id IN (${ph}) AND mes_cartola IS NULL`, [mes, enviadoPor, ...movIds]);
      marcados = u.affectedRows;
      // Post Venta: marca la etapa CARTOLA ENVIADA (track COMISION) de cada operación
      try {
        const segs = await segsDeMovs(`m.id IN (${ph})`, movIds);
        if (segs.length) {
          // Rediseño 08-2026: CARTOLA APROBADA se eliminó y COMISION A PAGAR ya no
          // se fuerza acá (esa la marca FONDOS RECIBIDOS del saldo). El envío deja
          // la cartola emitida y enviada.
          const etapas = ['COMISION PENDIENTE','CARTOLA EMITIDA','CARTOLA ENVIADA'];
          const vals = [];
          for (const s of segs) for (const e of etapas) vals.push([s.seg_id, 'COMISION', e, enviadoPor]);
          await pool.query(
            `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
        }
      } catch (ePV) { console.error('[cartolas envio→postventa]', ePV.message); }
    }
    auditar({ req, accion: 'ENVIAR_CARTOLA', modulo: 'cartas', entidad: 'cartola_enviada', entidad_id: r.insertId,
      detalle: `Envió cartola — ${concesionario} (${mes})`, rut: rut_conc });
    res.status(201).json({ success: true, data: { id: r.insertId, marcados }, error: null });
  } catch (e) {
    console.error('[cartolas envio]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── DELETE /api/cartolas/enviadas/:id — reversar un envío de cartola ──────
   Deshace el envío: borra el registro, des-estampa Mes Cartola en los
   movimientos de ese dealer/mes y quita la etapa CARTOLA ENVIADA en Post
   Venta (deja la cartola lista para reenviar). Permiso: aprob_cartola_reversar. */
const reversarEnvio = async (req, res) => {
  try {
    const [[env]] = await pool.query('SELECT * FROM cartolas_enviadas WHERE id = ?', [req.params.id]);
    if (!env) return res.status(404).json({ success: false, data: null, error: 'Envío no encontrado' });

    // Identifica los movimientos del envío por sus ids exactos (preciso). Para envíos
    // antiguos sin mov_ids → fallback por mes_cartola + dealer (compatibilidad).
    let movIds = [];
    try { const p = env.mov_ids ? JSON.parse(env.mov_ids) : []; movIds = (Array.isArray(p) ? p : []).map(Number).filter(Boolean); } catch (_) {}
    let filtroJoin, filtroUpd, fVals;
    if (movIds.length) {
      const ph = movIds.map(() => '?').join(',');
      filtroJoin = `m.id IN (${ph}) AND m.mes_cartola <=> ?`;
      filtroUpd  = `id IN (${ph}) AND mes_cartola <=> ?`;
      fVals = [...movIds, env.mes];
    } else {
      filtroJoin = `m.mes_cartola = ? AND m.rut_dealer <=> ?`;
      filtroUpd  = `mes_cartola = ? AND rut_dealer <=> ?`;
      fVals = [env.mes, env.rut_dealer];
    }

    // Operaciones (seguimientos) a las que hay que quitar CARTOLA ENVIADA — calcular ANTES de des-estampar
    const segs = await segsDeMovs(filtroJoin, fVals);

    // Des-estampar los movimientos de esa cartola
    const [u] = await pool.query(
      `UPDATE cartolas_movimientos SET mes_cartola = NULL, enviada_por = NULL, enviada_fecha = NULL
        WHERE ${filtroUpd}`, fVals);

    // Quitar la etapa CARTOLA ENVIADA en Post Venta (las previas se conservan)
    if (segs.length) {
      const ids = segs.map(s => s.seg_id);
      const ph = ids.map(() => '?').join(',');
      await pool.query(
        `DELETE FROM postventa_etapas
          WHERE track='COMISION' AND etapa='CARTOLA ENVIADA' AND id_seguimiento IN (${ph})`, ids);
    }

    await pool.query('DELETE FROM cartolas_enviadas WHERE id = ?', [req.params.id]);
    auditar({ req, accion: 'REVERSAR', modulo: 'cartas', entidad: 'cartola_enviada', entidad_id: req.params.id,
      detalle: `Reversó envío de cartola — ${env.nombre_dealer || ''} (${env.mes})`, rut: env.rut_dealer });
    res.json({ success: true, data: { reversado: Number(req.params.id), movimientos: u.affectedRows, operaciones: segs.length }, error: null });
  } catch (e) {
    console.error('[cartolas reversar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/cartolas/correo — envía la cartola al dealer por correo (HTML +
   PDF adjunto) desde comisiones@, con copia a los ejecutivos de la cartola y a
   los Jefes Comerciales. Plantilla paramétrica correo_cartola_dealer
   (Mantenedores Post Venta); con el interruptor apagado no envía.
   El PDF lo genera el navegador (html2pdf) y llega en base64. ── */
const enviarCorreoCartola = async (req, res) => {
  try {
    const { mes_nombre, dealer, rut_conc, mail, total, pdf_base64, filename, ejec_cc } = req.body || {};
    if (!dealer || !mail) return res.status(400).json({ success: false, data: null, error: 'dealer y mail requeridos' });
    const pend = await ajustesPendientes(rut_conc, dealer);
    if (pend) return res.status(409).json({ success: false, data: null, error: msgPendientes(pend) });
    // La plantilla vive en el mantenedor único Correos del Sistema (antes en postventa_config)
    const tpl = await require('../../../../shared/plantillas-correo').comoTpl('dealer_cartola_envio', 'correo_cartola_dealer');
    if (tpl.activo === false)
      return res.json({ success: true, data: { enviado: false, motivo: 'Plantilla desactivada en Mantenedores → Correos del Sistema' }, error: null });
    const datos = { dealer, mes: mes_nombre || '', total: total || '' };
    const rell = t => String(t || '').replace(/\{(\w+)\}/g, (m, k) => datos[k] != null ? datos[k] : m);
    // CC: ejecutivos de las operaciones + Jefes Comerciales activos (por perfil, paramétrico)
    const [jefes] = await pool.query(
      `SELECT u.email FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
       WHERE p.nombre = 'Jefe Comercial' AND u.estado = 'activo' AND u.email IS NOT NULL`);
    const cc = [...new Set([...String(tpl.cc || '').split(','),   // copia fija del mantenedor
      ...(Array.isArray(ejec_cc) ? ejec_cc : []), ...jefes.map(j => j.email)]
      .map(x => String(x).trim().toLowerCase()).filter(Boolean))].join(',');
    const { enviarCorreo, remitentePorClave, envolverHTML } = require('../../../../shared/mailer');
    const escH = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cuerpo = rell(tpl.cuerpo) + (tpl.firma ? '\n\n' + rell(tpl.firma) : '');
    const attachments = pdf_base64
      ? [{ filename: filename || 'cartola.pdf', content: Buffer.from(pdf_base64, 'base64') }] : [];
    const r = await enviarCorreo({
      from: remitentePorClave(tpl.remitente || 'comisiones'), to: mail, cc: cc || undefined,
      subject: rell(tpl.asunto) || ('Cartola comisiones — ' + dealer),
      html: envolverHTML(escH(cuerpo).replace(/\n/g, '<br>')), text: cuerpo, attachments });
    auditar({ req, accion: 'CORREO_CARTOLA', modulo: 'cartas', entidad: 'cartola_enviada', entidad_id: null,
      detalle: `Correo de cartola a ${mail} (CC: ${cc || '—'}) — ${dealer} (${mes_nombre || ''})` });
    res.json({ success: r.ok, data: { enviado: r.ok, dev: !!r.dev, cc }, error: r.ok ? null : r.error });
  } catch (e) {
    console.error('[cartolas correo]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* Adicionales/descuentos APROBADOS que viajaron en la MISMA cartola enviada que la
   comisión de una operación. Los usa la Orden de Pago de comisión (la factura del
   dealer es por el total de la cartola, ajustes incluidos: sin esto la ODP no cuadra
   y el pagador no sabe por qué). Devuelve [{ id, movimiento, glosa, monto }]. */
async function ajustesDeCartolaPorOp(numOp) {
  if (!numOp) return [];
  try {
    const [movs] = await pool.query(
      `SELECT id, mes_cartola, rut_dealer FROM cartolas_movimientos
        WHERE movimiento='COMISION' AND mes_cartola IS NOT NULL
          AND (num_op = ? OR num_op IN (SELECT c.id_financiera FROM creditos c WHERE c.num_op = ?))
        ORDER BY id DESC LIMIT 1`, [numOp, numOp]);
    const m = movs[0]; if (!m) return [];
    const [envs] = await pool.query(
      `SELECT mov_ids FROM cartolas_enviadas WHERE mes = ? AND mov_ids LIKE ? ORDER BY id DESC LIMIT 5`,
      [m.mes_cartola, '%' + m.id + '%']);
    let ids = [];
    for (const e of envs) {
      try { const p = JSON.parse(e.mov_ids || '[]'); if (Array.isArray(p) && p.map(Number).includes(Number(m.id))) { ids = p.map(Number).filter(Boolean); break; } } catch (_) {}
    }
    if (!ids.length) return [];
    const [aj] = await pool.query(
      `SELECT id, movimiento, glosa, comision AS monto FROM cartolas_movimientos
        WHERE id IN (?) AND movimiento IN ('ADICIONAL','DESCUENTO') AND aprobacion='APROBADA' ORDER BY id`, [ids]);
    return aj.map(a => ({ id: a.id, movimiento: a.movimiento, glosa: a.glosa || a.movimiento, monto: Number(a.monto) || 0 }));
  } catch (e) { console.error('[ajustesDeCartolaPorOp]', e.message); return []; }
}

module.exports = { sync, getMovimientos, crearMovimiento, updateMovimiento, deleteMovimiento, getEnviadas, registrarEnvio, reversarEnvio, enviarCorreoCartola, crearAjuste, resolverAjuste, ajustesDeCartolaPorOp };
