'use strict';
const pool = require('../../../../shared/config/database');

/* ── Migración ───────────────────────────────────────────────────── */
(async () => {
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
    console.log('[cartolas] tablas OK');
  } catch (e) { console.error('[cartolas migration]', e.message); }
})();
const nombreUsuario = u => (u?.nombre ? (u.nombre + ' ' + (u.apellido || '')).trim() : u?.email) || 'Usuario';

/* ── POST /api/cartolas/sync ─────────────────────────────────────────
   1) Marca otorgado=1 en cartas cuya id_financiera existe en creditos (cr.num_op).
   2) Crea el movimiento COMISION del mes para cada carta otorgada
      aprobada que aún no lo tenga.                                    */
const sync = async (req, res) => {
  try {
    const [r1] = await pool.query(`
      UPDATE cartas_aprobacion ca
      JOIN creditos cr ON cr.num_op = ca.id_financiera
      SET ca.otorgado = 1,
          ca.numero_credito_creado = cr.num_op,
          ca.id_credito_creado     = cr.id,
          ca.fecha_otorgado        = COALESCE(ca.fecha_otorgado, cr.fecha_otorgado, NOW())
      WHERE ca.otorgado = 0 AND ca.status = 'APROBADA'
    `);

    const [r2] = await pool.query(`
      INSERT INTO cartolas_movimientos
        (mes, id_carta, num_op, movimiento, rut_dealer, nombre_dealer,
         ejecutivo, nombre_cliente, rut_cliente, saldo, comision,
         estado_comision, num_carta, vendedor, acreedor)
      SELECT DATE_FORMAT(COALESCE(ca.fecha_otorgado, NOW()), '%Y-%m'),
             ca.id, ca.id_financiera, 'COMISION', ca.rut_dealer, ca.nombre_dealer,
             ca.ejecutivo, ca.cliente, ca.rut_cliente, ca.saldo,
             COALESCE(NULLIF(ca.part_bruto,0), crx.comdea_real),
             'PENDIENTE', ca.op_carta, ca.vendedor, ca.acreedor
      FROM cartas_aprobacion ca
      LEFT JOIN creditos crx ON crx.id = ca.id_credito_creado
      WHERE ca.otorgado = 1 AND ca.status = 'APROBADA'
        AND NOT EXISTS (
          SELECT 1 FROM cartolas_movimientos m
          WHERE m.id_carta = ca.id AND m.movimiento = 'COMISION'
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
      `SELECT m.*, m.rut_dealer AS rut_conc, m.nombre_dealer AS concesionario, cr.num_op AS nuestro_num_op, ca.ejecutivo_mail AS ejecutivo_mail
       FROM cartolas_movimientos m
       LEFT JOIN cartas_aprobacion ca ON ca.id = m.id_carta
       LEFT JOIN creditos cr ON cr.id = ca.id_credito_creado
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
    const [[base]] = await pool.query(
      `SELECT * FROM cartolas_movimientos WHERE num_op = ? AND movimiento='COMISION' ORDER BY id DESC LIMIT 1`,
      [m.num_op]
    );
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

const registrarEnvio = async (req, res) => {
  try {
    const { mes, rut_conc, concesionario, mail, total_bruto, ids } = req.body;
    if (!mes || !concesionario)
      return res.status(400).json({ success: false, data: null, error: 'mes y concesionario requeridos' });
    const enviadoPor = nombreUsuario(req.usuario);
    const [r] = await pool.query(
      `INSERT INTO cartolas_enviadas (mes, rut_dealer, nombre_dealer, mail, total_bruto, enviado_por)
       VALUES (?,?,?,?,?,?)`,
      [mes, rut_conc || null, concesionario, mail || null, total_bruto || null, enviadoPor]
    );
    // Estampa el mes de la cartola en los movimientos incluidos (no re-estampa si ya salieron antes)
    let marcados = 0;
    const movIds = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : [];
    if (movIds.length) {
      const ph = movIds.map(() => '?').join(',');
      const [u] = await pool.query(
        `UPDATE cartolas_movimientos SET mes_cartola=?, enviada_por=?, enviada_fecha=NOW()
         WHERE id IN (${ph}) AND mes_cartola IS NULL`, [mes, enviadoPor, ...movIds]);
      marcados = u.affectedRows;
      // Post Venta: marca la etapa CARTOLA ENVIADA (track COMISION) de cada operación
      try {
        const [segs] = await pool.query(
          `SELECT DISTINCT ps.id AS seg_id
           FROM cartolas_movimientos m
           JOIN cartas_aprobacion ca ON ca.id = m.id_carta
           JOIN postventa_seguimiento ps ON ps.id_credito = ca.id_credito_creado
           WHERE m.id IN (${ph})`, movIds);
        if (segs.length) {
          const etapas = ['COMISION A PAGAR','CARTOLA EMITIDA','CARTOLA APROBADA','CARTOLA ENVIADA'];
          const vals = [];
          for (const s of segs) for (const e of etapas) vals.push([s.seg_id, 'COMISION', e, enviadoPor]);
          await pool.query(
            `INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
        }
      } catch (ePV) { console.error('[cartolas envio→postventa]', ePV.message); }
    }
    res.status(201).json({ success: true, data: { id: r.insertId, marcados }, error: null });
  } catch (e) {
    console.error('[cartolas envio]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { sync, getMovimientos, crearMovimiento, updateMovimiento, deleteMovimiento, getEnviadas, registrarEnvio };
