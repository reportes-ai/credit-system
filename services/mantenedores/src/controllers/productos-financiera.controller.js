const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ── Migración ───────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('productos-financiera', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS productos_financiera (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        financiera VARCHAR(60)  NOT NULL,
        producto   VARCHAR(200) NOT NULL,
        activo     TINYINT(1)   NOT NULL DEFAULT 1,
        orden      INT          NOT NULL DEFAULT 0,
        UNIQUE KEY uk_fin_prod (financiera, producto)
      )
    `);

    const defaults = [
      /* AUTOFIN */
      ['AUTOFIN', 'CREDITO CC NUEVO AUTOFIN APROB 10',           1, 1],
      ['AUTOFIN', 'CREDITO CC AUTOMALL AUTOFIN',                 1, 2],
      ['AUTOFIN', 'CREDITO CC AUTOFIN PARQUE CARMOONS',          1, 3],
      ['AUTOFIN', 'CREDITO CC AUTOFIN PARQUE PANAMERICANA',      1, 4],
      ['AUTOFIN', 'CREDITO CC AUTOFIN PARQUE AUTOMOTRIZ OESTE',  1, 5],
      ['AUTOFIN', 'CREDITO CC AUTOFIN PARQUE AUTOCENTER QUILICURA', 1, 6],
      ['AUTOFIN', 'CREDITO AUTOFIN PARQUE MAIPU',                1, 7],
      ['AUTOFIN', 'CREDITO AUTOFIN AUTOPARQUE LONQUEN',          1, 8],
      ['AUTOFIN', 'AUTOFIN - CREDITO CONVENCIONAL',              1, 9],
      ['AUTOFIN', 'AUTOFIN - CREDITO CORFO',                     1, 10],
      ['AUTOFIN', 'AUTOFIN - PARQUE - CREDITO CONVENCIONAL',     1, 11],
      ['AUTOFIN', 'PRODUCTO CORFO AUTOFIN MAYOR - MENOR 200 UF', 1, 12],
      /* UNIDAD DE CREDITO */
      ['UNIDAD DE CREDITO', 'CREDITO CC UNIDAD APROB 11',        1, 1],
      ['UNIDAD DE CREDITO', 'UNIDAD - CREDITO CONVENCIONAL',     1, 2],
      ['UNIDAD DE CREDITO', 'UNIDAD - PARQUE - CREDITO CONVENCIONAL', 1, 3],
    ];

    for (const [financiera, producto, activo, orden] of defaults) {
      await pool.query(
        `INSERT IGNORE INTO productos_financiera (financiera, producto, activo, orden) VALUES (?,?,?,?)`,
        [financiera, producto, activo, orden]
      );
    }
    /* Productos con REGLAS PROPIAS (Pato, 11-09-2026): un producto que se comporta "como otra
       financiera" — tasa al cliente, comisión dealer por tramo de plazo, comisión parque y comisión
       ejecutivo propias. Nace con AUTOFIN PREFERENTE. Lo lee el Simulador de Rentabilidad. */
    for (const col of [
      'reglas_propias TINYINT(1) NOT NULL DEFAULT 0',
      'tasa_menor_pct DECIMAL(6,3) NULL',      // % mensual cliente, créditos ≤ 200 UF
      'tasa_mayor_pct DECIMAL(6,3) NULL',      // % mensual cliente, créditos > 200 UF
      'spread_menor_pct DECIMAL(6,3) NULL',    // spread mensual ≤ 200 UF: costo de fondo = tasa − spread (como AutoFin)
      'spread_mayor_pct DECIMAL(6,3) NULL',    // spread mensual > 200 UF
      'dealer_tramos TEXT NULL',               // JSON [{hasta:35,pct:0},{hasta:47,pct:2.5},{hasta:999,pct:5}] sobre saldo precio
      'parque_pct DECIMAL(6,3) NULL',          // % del saldo precio (solo dealer de parque)
      'ejecutivo_pct DECIMAL(6,3) NULL',       // % del monto financiado
      'descripcion VARCHAR(300) NULL',
    ]) await pool.query(`ALTER TABLE productos_financiera ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    await pool.query(
      `INSERT IGNORE INTO productos_financiera (financiera, producto, activo, orden, reglas_propias, tasa_menor_pct, tasa_mayor_pct, spread_menor_pct, spread_mayor_pct, dealer_tramos, parque_pct, ejecutivo_pct, descripcion)
       VALUES ('AUTOFIN', 'AUTOFIN PREFERENTE', 1, 13, 1, 2.39, 2.09, 0.55, 0.45, ?, 2.5, 1.0, 'Producto AutoFin con tasa preferente: comisión dealer 0% hasta 35 meses, 2,5% de 36 a 47 y 5% desde 48; parque 2,5%; ejecutivo 1% del monto financiado')`,
      [JSON.stringify([{ hasta: 35, pct: 0 }, { hasta: 47, pct: 2.5 }, { hasta: 999, pct: 5 }])]);
    // Spreads de PREFERENTE (Pato, 11-09-2026): 0,55% ≤ 200 UF y 0,45% > 200 UF — solo si la fila aún no los tiene
    await pool.query("UPDATE productos_financiera SET spread_menor_pct=0.55, spread_mayor_pct=0.45 WHERE producto='AUTOFIN PREFERENTE' AND spread_menor_pct IS NULL").catch(() => {});
  } catch (e) {
    console.error('[productos-financiera migration]', e.message);
  }
});

/* ── GET /api/productos-financiera?financiera=XXX&activo=1 ───────────────── */
const getAll = async (req, res) => {
  try {
    const { financiera, activo } = req.query;
    const conds = [], params = [];
    if (financiera) { conds.push('financiera = ?'); params.push(financiera); }
    if (activo !== undefined) { conds.push('activo = ?'); params.push(parseInt(activo)); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const [rows] = await pool.query(
      `SELECT * FROM productos_financiera ${where} ORDER BY financiera, orden, producto`,
      params
    );
    for (const r of rows) { try { r.dealer_tramos = r.dealer_tramos ? JSON.parse(r.dealer_tramos) : null; } catch (_) { r.dealer_tramos = null; } }
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── POST /api/productos-financiera ─────────────────────────────────────── */
/* Reglas propias del producto: valida y normaliza (tramos ordenados por plazo, % numéricos) */
function reglasDe(b) {
  const num = v => (v === '' || v == null || isNaN(v)) ? null : Number(v);
  let tramos = null;
  if (Array.isArray(b.dealer_tramos)) {
    tramos = b.dealer_tramos.map(t => ({ hasta: parseInt(t.hasta, 10), pct: Number(t.pct) || 0 }))
      .filter(t => t.hasta > 0).sort((a, c) => a.hasta - c.hasta);
    if (!tramos.length) tramos = null;
  }
  return { reglas_propias: b.reglas_propias ? 1 : 0, tasa_menor_pct: num(b.tasa_menor_pct), tasa_mayor_pct: num(b.tasa_mayor_pct),
    spread_menor_pct: num(b.spread_menor_pct), spread_mayor_pct: num(b.spread_mayor_pct),
    dealer_tramos: tramos ? JSON.stringify(tramos) : null, parque_pct: num(b.parque_pct), ejecutivo_pct: num(b.ejecutivo_pct),
    descripcion: b.descripcion ? String(b.descripcion).trim().slice(0, 300) : null };
}

const create = async (req, res) => {
  try {
    const { financiera, producto, activo = 1, orden = 0 } = req.body;
    if (!financiera || !producto) return res.status(400).json({ success: false, data: null, error: 'financiera y producto son requeridos' });
    const R = reglasDe(req.body);
    const [r] = await pool.query(
      'INSERT INTO productos_financiera (financiera, producto, activo, orden, reglas_propias, tasa_menor_pct, tasa_mayor_pct, spread_menor_pct, spread_mayor_pct, dealer_tramos, parque_pct, ejecutivo_pct, descripcion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [financiera.trim(), producto.trim(), activo ? 1 : 0, parseInt(orden) || 0, R.reglas_propias, R.tasa_menor_pct, R.tasa_mayor_pct, R.spread_menor_pct, R.spread_mayor_pct, R.dealer_tramos, R.parque_pct, R.ejecutivo_pct, R.descripcion]
    );
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'producto_financiera', entidad_id: r.insertId, detalle: `Creó producto "${producto.trim()}" (${financiera.trim()})`, meta: req.body });
    res.json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, data: null, error: 'Ya existe ese producto para esa financiera' });
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── PUT /api/productos-financiera/:id ───────────────────────────────────── */
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const { financiera, producto, activo, orden } = req.body;
    const sets = [], params = [];
    if (financiera !== undefined) { sets.push('financiera=?'); params.push(financiera.trim()); }
    if (producto  !== undefined) { sets.push('producto=?');   params.push(producto.trim()); }
    if (activo    !== undefined) { sets.push('activo=?');     params.push(activo ? 1 : 0); }
    if (orden     !== undefined) { sets.push('orden=?');      params.push(parseInt(orden) || 0); }
    if (req.body.reglas_propias !== undefined || req.body.dealer_tramos !== undefined || req.body.tasa_menor_pct !== undefined) {
      const R = reglasDe(req.body);
      for (const k of ['reglas_propias', 'tasa_menor_pct', 'tasa_mayor_pct', 'spread_menor_pct', 'spread_mayor_pct', 'dealer_tramos', 'parque_pct', 'ejecutivo_pct', 'descripcion']) { sets.push(k + '=?'); params.push(R[k]); }
    }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Nada que actualizar' });
    params.push(id);
    await pool.query(`UPDATE productos_financiera SET ${sets.join(',')} WHERE id=?`, params);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'producto_financiera', entidad_id: id, detalle: `Editó producto de financiera #${id}`, meta: req.body });
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── DELETE /api/productos-financiera/:id ────────────────────────────────── */
const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM productos_financiera WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'producto_financiera', entidad_id: req.params.id, detalle: `Eliminó producto de financiera #${req.params.id}` });
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, create, update, remove };
