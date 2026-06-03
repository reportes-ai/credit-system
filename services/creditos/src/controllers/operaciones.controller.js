const pool = require('../../../../shared/config/database');
const { calcularOperacion } = require('../utils/calcular-operacion');

// Migración: tabla creditos
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS creditos (
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
    console.log('✓ creditos: tabla lista');
  } catch (e) {
    console.error('[operaciones migration]', e.message);
  }
})();

// Migración v2: nuevas columnas workflow completo
(async () => {
  const alteraciones = [
    `ALTER TABLE creditos ADD COLUMN numero_credito VARCHAR(20) NULL AFTER id`,
    `ALTER TABLE creditos ADD COLUMN rut_concesionario VARCHAR(20) NULL`,
    `ALTER TABLE creditos ADD COLUMN vendedor VARCHAR(150) NULL`,
    `ALTER TABLE creditos ADD COLUMN estado_fundantes VARCHAR(30) NOT NULL DEFAULT 'PENDIENTE'`,
    `ALTER TABLE creditos ADD COLUMN liberado_pago TINYINT(1) NOT NULL DEFAULT 0`,
    `ALTER TABLE creditos ADD COLUMN fecha_liberado_pago DATE NULL`,
    `ALTER TABLE creditos ADD COLUMN liberado_por VARCHAR(150) NULL`,
    `ALTER TABLE creditos ADD COLUMN estado_pago VARCHAR(30) NULL`,
    `ALTER TABLE creditos ADD COLUMN fecha_pago DATE NULL`,
    `ALTER TABLE creditos ADD COLUMN num_transaccion VARCHAR(100) NULL`,
  ];
  for (const sql of alteraciones) {
    try { await pool.query(sql); } catch (e) { if (e.errno !== 1060) console.error('[operaciones v2]', e.message); }
  }
})();

// Migración v3: datos de vehículo
(async () => {
  const cols = [
    `ALTER TABLE creditos ADD COLUMN marca VARCHAR(100) NULL`,
    `ALTER TABLE creditos ADD COLUMN modelo VARCHAR(100) NULL`,
    `ALTER TABLE creditos ADD COLUMN anio_vehiculo SMALLINT NULL`,
    `ALTER TABLE creditos ADD COLUMN tasacion BIGINT NULL`,
    `ALTER TABLE creditos ADD COLUMN permiso_circulacion BIGINT NULL`,
  ];
  for (const sql of cols) {
    try { await pool.query(sql); } catch (e) { if (e.errno !== 1060) console.error('[operaciones v3]', e.message); }
  }
})();

// Migración v4: índices para mejorar performance de búsquedas
(async () => {
  const indices = [
    `ALTER TABLE creditos ADD INDEX idx_mes (mes)`,
    `ALTER TABLE creditos ADD INDEX idx_estado_credito (estado_credito)`,
    `ALTER TABLE creditos ADD INDEX idx_rut_cliente (rut_cliente)`,
    `ALTER TABLE creditos ADD INDEX idx_financiera (financiera)`,
    `ALTER TABLE creditos ADD INDEX idx_mes_numop (mes, num_op)`,
  ];
  for (const sql of indices) {
    try { await pool.query(sql); } catch (e) { if (e.errno !== 1061) console.error('[operaciones v4]', e.message); }
  }
})();

// Migración v5: columnas para cálculo automático de ingresos y comisiones
(async () => {
  const cols = [
    `ALTER TABLE creditos ADD COLUMN com_reparaciones DECIMAL(15,0) NULL`,
    `ALTER TABLE creditos ADD COLUMN comej DECIMAL(15,0) NULL`,
    `ALTER TABLE creditos ADD COLUMN ingreso_neto_total DECIMAL(15,2) NULL`,
  ];
  for (const sql of cols) {
    try { await pool.query(sql); } catch (e) { if (e.errno !== 1060) console.error('[operaciones v5]', e.message); }
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
// Misma fórmula que generarNumero() en creditos.controller: YYMM + seq 3 dígitos
// ej: mes=2026-05 → prefix="2605", resultado "2605006"
const nextOp = async (req, res) => {
  try {
    const { mes } = req.query; // ej: "2026-05"
    if (!mes || !/^\d{4}-\d{2}$/.test(mes))
      return res.status(400).json({ success: false, data: null, error: 'Parámetro mes requerido (YYYY-MM)' });

    // Replicar la lógica de generarNumero(): YYMM (2 dígitos de año)
    const [anio, mStr] = mes.split('-');
    const yy     = String(anio).slice(-2);          // "26"
    const mm     = String(mStr).padStart(2, '0');   // "05"
    const prefix = yy + mm;                          // "2605"

    const [rows] = await pool.query(
      `SELECT numero_credito FROM creditos
       WHERE numero_credito LIKE ? ORDER BY id DESC LIMIT 1`,
      [prefix + '%']
    );

    const seq = rows.length
      ? parseInt(rows[0].numero_credito.slice(4), 10) + 1
      : 1;

    const nextNum = prefix + String(seq).padStart(3, '0'); // "2605006"

    res.json({ success: true, data: { nextOp: nextNum }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
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
      `SELECT ob.*,
              COALESCE(cl.rut,             '') AS rut_cliente,
              COALESCE(cl.nombre_completo, '') AS nombre_cliente
       FROM creditos ob
       LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
       ${w} ORDER BY ob.mes DESC, ob.num_op DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── GET /api/operaciones/:id ────────────────────────────────────────── */
const getOne = async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT ob.*, COALESCE(cl.rut, '') AS rut_cliente,
              COALESCE(cl.nombre_completo, '') AS nombre_cliente
       FROM creditos ob
       LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
       WHERE ob.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    res.json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── POST /api/operaciones ───────────────────────────────────────────── */
// Genera numero_credito (YYMMXXX) — misma lógica que creditos.controller
async function generarNumeroCred(mesISO) {
  const base = mesISO ? new Date(mesISO) : new Date();
  const yy     = String(base.getFullYear()).slice(-2);
  const mm     = String(base.getMonth() + 1).padStart(2, '0');
  const prefix = `${yy}${mm}`;
  const [rows] = await pool.query(
    `SELECT numero_credito FROM creditos
     WHERE numero_credito LIKE ? ORDER BY id DESC LIMIT 1`,
    [prefix + '%']
  );
  const seq = rows.length ? parseInt(rows[0].numero_credito.slice(4), 10) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

const create = async (req, res) => {
  try {
    const b = req.body;
    if (!b.financiera) return res.status(400).json({ success: false, data: null, error: 'financiera requerida' });
    if (!b.rut_cliente) return res.status(400).json({ success: false, data: null, error: 'RUT cliente requerido' });
    b.rut_cliente = b.rut_cliente.replace(/\./g, '').toUpperCase().trim();

    // Resolver id_cliente desde tabla clientes
    const [[cliRow]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut = ?', [b.rut_cliente]);
    b.id_cliente = cliRow?.id_cliente || null;

    // Auto-asignar numero_credito si no viene del formulario
    if (!b.numero_credito) {
      b.numero_credito = await generarNumeroCred(b.mes || null);
    }

    const { saldo_precio, pct_financiado } = calcular(b);

    const fields = [
      'numero_credito',
      'num_op','mes','financiera','rut_cliente','nombre_cliente','comentarios',
      'ejecutivo','id_ejecutivo','automotora','nombre_local','estado_eval','estado_credito',
      'fecha_otorgado','producto','marca','modelo','anio_vehiculo','tasacion','permiso_circulacion',
      'valor_vehiculo','pie','saldo_precio','pct_financiado',
      'impuesto','estado_impuesto','limitacion','gastos','gps',
      'seguro_rdh','seguro_cesantia','seguro_rep_menor',
      'monto_financiado','plazo','tascli_real','tascli_pizarra','tasfin_pizarra',
      'comdea_real','monto_comision_fin','id_financiera','fecha_primera_cuota',
      'parque','mayor_menor','monto_capitalizado',
      'boleta_factura','cantidad_docs','docs_autorizados','fecha_recep_doc',
      'rut_concesionario','vendedor',
      'id_cliente',
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
      `INSERT INTO creditos (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
      values
    );

    // Auto-calcular ingresos y comisiones (solo si es crédito otorgado/aprobado)
    if (['OTORGADO','APROBADO'].includes((b.estado_credito||'').toUpperCase())) {
      try {
        const calc = await calcularOperacion({ ...b, saldo_precio, id: r.insertId });
        await pool.query(`
          UPDATE creditos SET
            monto_comision_fin = ?, com_rdh = ?, com_cesantia = ?,
            com_reparaciones = ?, comdea_real = ?, com_parque = ?,
            comej = ?, ingreso_neto_total = ?
          WHERE id = ?`,
          [calc.monto_comision_fin, calc.com_rdh, calc.com_cesantia,
           calc.com_reparaciones, calc.comdea_real, calc.com_parque,
           calc.comej, calc.ingreso_neto_total, r.insertId]
        );
      } catch(calcErr) { console.error('[calcular-operacion create]', calcErr.message); }
    }

    const [[row]] = await pool.query('SELECT * FROM creditos WHERE id = ?', [r.insertId]);
    res.status(201).json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── PUT /api/operaciones/:id ───────────────────────────────────────── */
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body;
    const [[exists]] = await pool.query('SELECT id FROM creditos WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ success: false, data: null, error: 'No encontrada' });

    if (b.rut_cliente) b.rut_cliente = b.rut_cliente.replace(/\./g, '').toUpperCase().trim();
    const { saldo_precio, pct_financiado } = calcular(b);

    // Resolver id_cliente si viene rut_cliente
    if (b.rut_cliente) {
      const [[cliRow]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut = ?', [b.rut_cliente]);
      b.id_cliente = cliRow?.id_cliente || null;
    }

    const sets = [
      'num_op=?','mes=?','financiera=?','rut_cliente=?','nombre_cliente=?','comentarios=?',
      'ejecutivo=?','automotora=?','nombre_local=?','estado_eval=?','estado_credito=?',
      'fecha_otorgado=?','producto=?',
      'marca=?','modelo=?','anio_vehiculo=?','tasacion=?','permiso_circulacion=?',
      'valor_vehiculo=?','pie=?',
      'saldo_precio=?','pct_financiado=?','impuesto=?','estado_impuesto=?',
      'limitacion=?','gastos=?','gps=?','seguro_rdh=?','seguro_cesantia=?','seguro_rep_menor=?',
      'monto_financiado=?','plazo=?','tascli_real=?','tascli_pizarra=?','tasfin_pizarra=?',
      'comdea_real=?','monto_comision_fin=?','id_financiera=?','fecha_primera_cuota=?',
      'parque=?','mayor_menor=?','monto_capitalizado=?',
      'boleta_factura=?','cantidad_docs=?','docs_autorizados=?','fecha_recep_doc=?',
      'rut_concesionario=?','vendedor=?',
      'id_cliente=?',
      'updated_at=NOW()'
    ];
    const vals = [
      b.num_op||null, b.mes||null, b.financiera, b.rut_cliente, b.nombre_cliente||null, b.comentarios||null,
      b.ejecutivo||null, b.automotora||null, b.nombre_local||null, b.estado_eval||null, b.estado_credito||null,
      b.fecha_otorgado||null, b.producto||null,
      b.marca||null, b.modelo||null, b.anio_vehiculo||null, b.tasacion||null, b.permiso_circulacion||null,
      b.valor_vehiculo||null, b.pie||null,
      saldo_precio, pct_financiado, b.impuesto||null, b.estado_impuesto||null,
      b.limitacion ? 1 : 0, b.gastos||0, b.gps||0,
      b.seguro_rdh||0, b.seguro_cesantia||0, b.seguro_rep_menor||0,
      b.monto_financiado||null, b.plazo||null,
      b.tascli_real||null, b.tascli_pizarra||null, b.tasfin_pizarra||null,
      b.comdea_real||null, b.monto_comision_fin||null, b.id_financiera||null, b.fecha_primera_cuota||null,
      b.parque||'NO APLICA', b.mayor_menor||null, b.monto_capitalizado||0,
      b.boleta_factura||null, b.cantidad_docs||0, b.docs_autorizados||0, b.fecha_recep_doc||null,
      b.rut_concesionario||null, b.vendedor||null,
      b.id_cliente||null,
      id
    ];

    await pool.query(`UPDATE creditos SET ${sets.join(',')} WHERE id=?`, vals);

    // Auto-calcular ingresos y comisiones al actualizar
    if (['OTORGADO','APROBADO'].includes((b.estado_credito||'').toUpperCase())) {
      try {
        const calc = await calcularOperacion({ ...b, saldo_precio, id });
        await pool.query(`
          UPDATE creditos SET
            monto_comision_fin = ?, com_rdh = ?, com_cesantia = ?,
            com_reparaciones = ?, comdea_real = ?, com_parque = ?,
            comej = ?, ingreso_neto_total = ?
          WHERE id = ?`,
          [calc.monto_comision_fin, calc.com_rdh, calc.com_cesantia,
           calc.com_reparaciones, calc.comdea_real, calc.com_parque,
           calc.comej, calc.ingreso_neto_total, id]
        );
      } catch(calcErr) { console.error('[calcular-operacion update]', calcErr.message); }
    }

    const [[row]] = await pool.query('SELECT * FROM creditos WHERE id = ?', [id]);
    res.json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── DELETE /api/operaciones/:id ────────────────────────────────────── */
const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM creditos WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: { eliminado: req.params.id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── PUT /api/operaciones/:id/liberar-pago ──────────────────────── */
// Solo analistas/supervisores/gerentes pueden liberar a pago
const PUEDE_LIBERAR = ['Administrador', 'Gerente', 'Supervisor', 'Analista de Crédito'];

const liberarPago = async (req, res) => {
  try {
    const perfil = req.usuario?.perfil_nombre || '';
    if (!PUEDE_LIBERAR.includes(perfil)) {
      return res.status(403).json({ success: false, data: null, error: 'Sin permisos para liberar a pago' });
    }
    const { id } = req.params;
    const [[exists]] = await pool.query('SELECT id, estado_fundantes FROM creditos WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });

    const liberadoPor = req.usuario ? `${req.usuario.nombre} ${req.usuario.apellido || ''}`.trim() : null;
    await pool.query(
      `UPDATE creditos SET liberado_pago=1, fecha_liberado_pago=CURDATE(), liberado_por=? WHERE id=?`,
      [liberadoPor, id]
    );
    const [[row]] = await pool.query('SELECT * FROM creditos WHERE id = ?', [id]);
    res.json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── PUT /api/operaciones/:id/no-otorgado ───────────────────────── */
const marcarNoOtorgado = async (req, res) => {
  try {
    const { id } = req.params;
    const { comentario } = req.body;
    const [[exists]] = await pool.query('SELECT id FROM creditos WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    await pool.query(
      `UPDATE creditos SET estado_credito='NO OTORGADO',
       comentarios=CONCAT(COALESCE(comentarios,''),' | NO OTORGADO: ', COALESCE(?,'')) WHERE id=?`,
      [comentario || '', id]
    );
    const [[row]] = await pool.query('SELECT * FROM creditos WHERE id = ?', [id]);
    res.json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── POST /api/operaciones/recalcular-comisiones ──────────────────── */
// Recalcula comdea_real, com_parque e ingreso_neto_total en batch.
// Pre-carga params y UF una sola vez. UPDATEs en chunks de 500.
const recalcularComisiones = async (req, res) => {
  try {
    const perfil = req.usuario?.perfil_nombre || '';
    if (perfil !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Solo Administrador puede ejecutar el recálculo' });

    // 1. Pre-cargar parámetros una sola vez
    const [paramRows] = await pool.query('SELECT clave, valor FROM parametros_credito');
    const p = {};
    paramRows.forEach(r => { p[r.clave] = parseFloat(r.valor); });

    // 1b. Pre-cargar factores de comisión de seguros
    const [segRows] = await pool.query(
      'SELECT plazo_min, plazo_max, pct_desgravamen, pct_cesantia FROM comisiones_seguro_plazo WHERE estado="activo" ORDER BY plazo_min'
    );

    // 2. Pre-cargar todas las UF necesarias en un Map fecha→valor
    const [ufRows] = await pool.query('SELECT fecha, valor FROM uf');
    const ufMap = {};
    ufRows.forEach(r => { ufMap[r.fecha.toString().slice(0,10)] = parseFloat(r.valor); });

    // 3. Traer todos los registros a recalcular
    const [rows] = await pool.query(
      `SELECT id, saldo_precio, plazo, financiera, parque, com_parque,
              seguro_rdh, seguro_cesantia, seguro_rep_menor,
              monto_financiado, monto_capitalizado, fecha_otorgado, mes
       FROM creditos WHERE saldo_precio > 0 AND plazo > 0`
    );

    // 4. Helpers inline (sin DB)
    const getDealerPct = (plazo) => {
      if (plazo <= 6)  return p.dealer_pct_6  / 100;
      if (plazo <= 12) return p.dealer_pct_12 / 100;
      if (plazo <= 24) return p.dealer_pct_24 / 100;
      if (plazo <= 36) return p.dealer_pct_36 / 100;
      return p.dealer_pct_99 / 100;
    };
    const getSegCom = (plazo) => {
      const row = segRows.find(r => plazo >= r.plazo_min && plazo <= r.plazo_max);
      if (!row) return { desg: 0, cesa: 0 };
      return { desg: parseFloat(row.pct_desgravamen) / 100, cesa: parseFloat(row.pct_cesantia) / 100 };
    };

    // 5. Calcular todo en memoria
    const updates = rows.map(row => {
      const saldo    = parseFloat(row.saldo_precio)      || 0;
      const montoFin = parseFloat(row.monto_financiado)  || 0;
      const montoCap = parseFloat(row.monto_capitalizado) || montoFin;
      const plazo    = parseInt(row.plazo)                || 0;
      const fin      = (row.financiera || '').toUpperCase();
      const parqueVal = (row.parque || '').toUpperCase().trim();
      const esParque  = parqueVal.includes('PARQUE');
      const uf       = ufMap[row.fecha_otorgado?.toString().slice(0,10)] || null;

      // Comisión financiera (monto_comision_fin)
      let monto_comision_fin = 0;
      if (plazo > 0 && montoFin > 0) {
        if (fin.includes('AUTOFIN') || fin.includes('AUTOF')) {
          const tmc_menor  = (p.autofin_tmc_menor_200 / 100) / 12;
          const tmc_mayor  = (p.autofin_tmc_mayor_200 / 100) / 12;
          const spread     = p.autofin_spread_fondo / 100;
          const costo_fondo = tmc_mayor - spread;
          const limite_200  = uf ? 200 * uf : null;
          const tasa_cli    = (limite_200 && montoCap > limite_200) ? tmc_mayor : tmc_menor;
          if (tasa_cli > 0 && costo_fondo > 0) {
            const cuota = montoCap * tasa_cli * Math.pow(1+tasa_cli,plazo) / (Math.pow(1+tasa_cli,plazo)-1);
            const pv    = cuota * (1 - Math.pow(1+costo_fondo,-plazo)) / costo_fondo;
            monto_comision_fin = Math.round(pv - montoCap);
          }
        } else if (fin.includes('UNIDAD') || fin.includes('UAC')) {
          monto_comision_fin = Math.round(saldo * (p.uac_pct_tier1 / 100));
        }
      }

      // Comisión seguros
      let com_rdh = 0, com_cesantia = 0;
      const primaDesg = parseFloat(row.seguro_rdh) || 0;
      if (plazo > 0 && primaDesg > 0 && !fin.includes('UNIDAD') && !fin.includes('UAC')) {
        const { desg, cesa } = getSegCom(plazo);
        com_rdh      = Math.round(desg * primaDesg);
        com_cesantia = Math.round(cesa * primaDesg);
      }

      // Comisión dealer
      let comdea_real = 0, com_parque_calc = 0;
      if (saldo > 0 && plazo > 0) {
        const dealer_pct = getDealerPct(plazo);
        const patio_pct  = p.patio_pct / 100;
        comdea_real     = esParque
          ? Math.round(saldo * dealer_pct)
          : Math.round(saldo * (dealer_pct + patio_pct));
        com_parque_calc = esParque ? Math.round(saldo * patio_pct) : 0;
      }

      const ingreso_neto_total = monto_comision_fin + com_rdh + com_cesantia - comdea_real - com_parque_calc;

      return [comdea_real, com_parque_calc, monto_comision_fin, com_rdh, com_cesantia, ingreso_neto_total, row.id];
    });

    // 6. UPDATE en chunks de 500 con CASE WHEN
    const CHUNK = 500;
    let actualizados = 0;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      const ids   = chunk.map(u => u[6]);
      const mkCase = (idx) => 'CASE id ' + chunk.map(u => `WHEN ${u[6]} THEN ?`).join(' ') + ' END';
      const vals  = [
        ...chunk.map(u => u[0]), // comdea_real
        ...chunk.map(u => u[1]), // com_parque
        ...chunk.map(u => u[2]), // monto_comision_fin
        ...chunk.map(u => u[3]), // com_rdh
        ...chunk.map(u => u[4]), // com_cesantia
        ...chunk.map(u => u[5]), // ingreso_neto_total
        ...ids,
      ];
      const sql = `UPDATE creditos SET
        comdea_real        = CASE id ${chunk.map(u=>`WHEN ${u[6]} THEN ?`).join(' ')} END,
        com_parque         = CASE id ${chunk.map(u=>`WHEN ${u[6]} THEN ?`).join(' ')} END,
        monto_comision_fin = CASE id ${chunk.map(u=>`WHEN ${u[6]} THEN ?`).join(' ')} END,
        com_rdh            = CASE id ${chunk.map(u=>`WHEN ${u[6]} THEN ?`).join(' ')} END,
        com_cesantia       = CASE id ${chunk.map(u=>`WHEN ${u[6]} THEN ?`).join(' ')} END,
        ingreso_neto_total = CASE id ${chunk.map(u=>`WHEN ${u[6]} THEN ?`).join(' ')} END
        WHERE id IN (${ids.map(()=>'?').join(',')})`;
      await pool.query(sql, vals);
      actualizados += chunk.length;
    }

    res.json({ success: true, data: { total: rows.length, actualizados }, error: null });
  } catch (e) {
    console.error('[recalc]', e);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, getOne, create, update, remove, nextOp, liberarPago, marcarNoOtorgado, recalcularComisiones };
