const pool = require('../../../../shared/config/database');

// Migración: tabla operaciones_brokerage
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS operaciones_brokerage (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        num_op           INT,
        mes              DATE,
        financiera       VARCHAR(30) NOT NULL,
        rut_cliente      VARCHAR(20),
        nombre_cliente   VARCHAR(200),
        comentarios      TEXT,
        ejecutivo        VARCHAR(100),
        id_ejecutivo     INT,
        automotora       VARCHAR(200),
        nombre_local     VARCHAR(200),
        estado_eval      VARCHAR(50),
        estado_credito   VARCHAR(50) DEFAULT 'PENDIENTE',
        fecha_otorgado   DATE,
        producto         VARCHAR(200),
        valor_vehiculo   DECIMAL(15,0),
        pie              DECIMAL(15,0),
        saldo_precio     DECIMAL(15,0),
        pct_financiado   DECIMAL(8,6),
        impuesto         DECIMAL(15,0),
        estado_impuesto  VARCHAR(50),
        limitacion       TINYINT(1) DEFAULT 0,
        gastos           DECIMAL(15,0) DEFAULT 0,
        gps              DECIMAL(15,0) DEFAULT 0,
        seguro_rdh       DECIMAL(15,0) DEFAULT 0,
        seguro_cesantia  DECIMAL(15,0) DEFAULT 0,
        seguro_rep_menor DECIMAL(15,0) DEFAULT 0,
        monto_financiado DECIMAL(15,0),
        plazo            INT,
        tascli_real      DECIMAL(8,6),
        tascli_pizarra   DECIMAL(8,6),
        tasfin_pizarra   DECIMAL(8,6),
        comdea_real      DECIMAL(15,0),
        monto_comision_fin DECIMAL(15,0),
        id_financiera    VARCHAR(50),
        fecha_primera_cuota DATE,
        parque           VARCHAR(100) DEFAULT 'NO APLICA',
        mayor_menor      VARCHAR(10),
        monto_capitalizado DECIMAL(15,0) DEFAULT 0,
        boleta_factura   VARCHAR(100),
        cantidad_docs    INT DEFAULT 0,
        docs_autorizados INT DEFAULT 0,
        fecha_recep_doc  DATE,
        created_at       DATETIME DEFAULT NOW(),
        updated_at       DATETIME DEFAULT NOW() ON UPDATE NOW(),
        created_by       INT
      )
    `);
    console.log('✓ operaciones_brokerage: tabla lista');
  } catch (e) {
    console.error('[operaciones migration]', e.message);
  }
})();

/* ─── helpers ─────────────────────────────────────────────────────────── */
function calcular(body) {
  const p = parseFloat(body.valor_vehiculo) || 0;
  const q = parseFloat(body.pie) || 0;
  const saldo = p - q;
  const pct   = p > 0 ? saldo / p : 0;
  return { saldo_precio: Math.round(saldo), pct_financiado: parseFloat(pct.toFixed(6)) };
}

/* ─── GET /api/operaciones/next-op?mes=YYYY-MM ───────────────────────── */
// Retorna el siguiente num_op con formato YYYYMM + secuencial 3 dígitos
const nextOp = async (req, res) => {
  try {
    const { mes } = req.query; // ej: "2026-05"
    if (!mes || !/^\d{4}-\d{2}$/.test(mes))
      return res.status(400).json({ success: false, data: null, error: 'Parámetro mes requerido (YYYY-MM)' });

    const prefix = parseInt(mes.replace('-', ''), 10); // 202605
    const prefixStr = String(prefix);                  // "202605"

    // Buscar el mayor num_op cuyo prefijo coincida con YYYYMM
    const [[row]] = await pool.query(
      `SELECT MAX(num_op) AS max_op
       FROM operaciones_brokerage
       WHERE DATE_FORMAT(mes, '%Y-%m') = ?`,
      [mes]
    );

    const maxOp = row?.max_op ? parseInt(row.max_op) : 0;
    let nextNum;

    if (maxOp > 0 && String(maxOp).startsWith(prefixStr)) {
      // El último num_op tiene el mismo prefijo → incrementar
      nextNum = maxOp + 1;
    } else {
      // No hay ops este mes o el máximo es de otro mes → arrancar en YYYYMM001
      nextNum = parseInt(prefixStr + '001', 10);
    }

    res.json({ success: true, data: { nextOp: nextNum }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── GET /api/operaciones?financiera=AUTOFIN&mes=2025-01 ─────────────── */
const getAll = async (req, res) => {
  try {
    const { financiera, mes, estado, limit = 200, offset = 0 } = req.query;
    let where = [];
    const params = [];
    if (financiera) { where.push('financiera = ?'); params.push(financiera); }
    if (mes)        { where.push('DATE_FORMAT(mes, \'%Y-%m\') = ?'); params.push(mes); }
    if (estado)     { where.push('estado_credito = ?'); params.push(estado); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await pool.query(
      `SELECT * FROM operaciones_brokerage ${w} ORDER BY mes DESC, num_op DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── GET /api/operaciones/:id ────────────────────────────────────────── */
const getOne = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM operaciones_brokerage WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    res.json({ success: true, data: row, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── POST /api/operaciones ───────────────────────────────────────────── */
const create = async (req, res) => {
  try {
    const b = req.body;
    if (!b.financiera) return res.status(400).json({ success: false, data: null, error: 'financiera requerida' });
    if (!b.rut_cliente) return res.status(400).json({ success: false, data: null, error: 'RUT cliente requerido' });

    const { saldo_precio, pct_financiado } = calcular(b);

    const fields = [
      'num_op','mes','financiera','rut_cliente','nombre_cliente','comentarios',
      'ejecutivo','id_ejecutivo','automotora','nombre_local','estado_eval','estado_credito',
      'fecha_otorgado','producto','valor_vehiculo','pie','saldo_precio','pct_financiado',
      'impuesto','estado_impuesto','limitacion','gastos','gps',
      'seguro_rdh','seguro_cesantia','seguro_rep_menor',
      'monto_financiado','plazo','tascli_real','tascli_pizarra','tasfin_pizarra',
      'comdea_real','monto_comision_fin','id_financiera','fecha_primera_cuota',
      'parque','mayor_menor','monto_capitalizado',
      'boleta_factura','cantidad_docs','docs_autorizados','fecha_recep_doc',
      'rut_concesionario','vendedor',   // col CB "RUT DEALER" y vendedor del concesionario
      'created_by'
    ];

    const values = fields.map(f => {
      if (f === 'saldo_precio') return saldo_precio;
      if (f === 'pct_financiado') return pct_financiado;
      if (f === 'created_by') return req.usuario?.id_usuario || null;
      if (f === 'limitacion') return b[f] ? 1 : 0;
      const v = b[f];
      if (v === '' || v === undefined) return null;
      return v;
    });

    const [r] = await pool.query(
      `INSERT INTO operaciones_brokerage (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
      values
    );
    const [[row]] = await pool.query('SELECT * FROM operaciones_brokerage WHERE id = ?', [r.insertId]);
    res.status(201).json({ success: true, data: row, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── PUT /api/operaciones/:id ───────────────────────────────────────── */
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body;
    const [[exists]] = await pool.query('SELECT id FROM operaciones_brokerage WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ success: false, data: null, error: 'No encontrada' });

    const { saldo_precio, pct_financiado } = calcular(b);

    const sets = [
      'num_op=?','mes=?','financiera=?','rut_cliente=?','nombre_cliente=?','comentarios=?',
      'ejecutivo=?','automotora=?','nombre_local=?','estado_eval=?','estado_credito=?',
      'fecha_otorgado=?','producto=?','valor_vehiculo=?','pie=?',
      'saldo_precio=?','pct_financiado=?','impuesto=?','estado_impuesto=?',
      'limitacion=?','gastos=?','gps=?','seguro_rdh=?','seguro_cesantia=?','seguro_rep_menor=?',
      'monto_financiado=?','plazo=?','tascli_real=?','tascli_pizarra=?','tasfin_pizarra=?',
      'comdea_real=?','monto_comision_fin=?','id_financiera=?','fecha_primera_cuota=?',
      'parque=?','mayor_menor=?','monto_capitalizado=?',
      'boleta_factura=?','cantidad_docs=?','docs_autorizados=?','fecha_recep_doc=?',
      'rut_concesionario=?','vendedor=?',
      'updated_at=NOW()'
    ];
    const vals = [
      b.num_op||null, b.mes||null, b.financiera, b.rut_cliente, b.nombre_cliente||null, b.comentarios||null,
      b.ejecutivo||null, b.automotora||null, b.nombre_local||null, b.estado_eval||null, b.estado_credito||null,
      b.fecha_otorgado||null, b.producto||null, b.valor_vehiculo||null, b.pie||null,
      saldo_precio, pct_financiado, b.impuesto||null, b.estado_impuesto||null,
      b.limitacion ? 1 : 0, b.gastos||0, b.gps||0,
      b.seguro_rdh||0, b.seguro_cesantia||0, b.seguro_rep_menor||0,
      b.monto_financiado||null, b.plazo||null,
      b.tascli_real||null, b.tascli_pizarra||null, b.tasfin_pizarra||null,
      b.comdea_real||null, b.monto_comision_fin||null, b.id_financiera||null, b.fecha_primera_cuota||null,
      b.parque||'NO APLICA', b.mayor_menor||null, b.monto_capitalizado||0,
      b.boleta_factura||null, b.cantidad_docs||0, b.docs_autorizados||0, b.fecha_recep_doc||null,
      b.rut_concesionario||null, b.vendedor||null,
      id
    ];

    await pool.query(`UPDATE operaciones_brokerage SET ${sets.join(',')} WHERE id=?`, vals);
    const [[row]] = await pool.query('SELECT * FROM operaciones_brokerage WHERE id = ?', [id]);
    res.json({ success: true, data: row, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── DELETE /api/operaciones/:id ────────────────────────────────────── */
const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM operaciones_brokerage WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: { eliminado: req.params.id }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, getOne, create, update, remove, nextOp };
