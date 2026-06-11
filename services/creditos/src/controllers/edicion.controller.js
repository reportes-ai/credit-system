'use strict';
const pool = require('../../../../shared/config/database');
const { isMesCerrado } = require('../../../../shared/utils/mes-cerrado');

// Migración: tabla log de ediciones
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS creditos_edicion_log (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        id_credito  INT NOT NULL,
        num_op      VARCHAR(30) DEFAULT NULL,
        usuario     VARCHAR(150) NOT NULL,
        campo       VARCHAR(80) NOT NULL,
        valor_antes TEXT DEFAULT NULL,
        valor_despues TEXT DEFAULT NULL,
        fecha       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_credito (id_credito),
        INDEX idx_fecha (fecha)
      )
    `);
  } catch (e) { if (e.errno !== 1050) console.error('[edicion log migration]', e.message); }
})();

// Campos editables y sus etiquetas
const CAMPOS_EDIT = [
  { col:'num_op',             label:'N° Operación',        tipo:'text'   },
  { col:'numero_credito',     label:'N° Crédito',          tipo:'text'   },
  { col:'financiera',         label:'Financiera',          tipo:'select', ops:['AUTOFACIL','AUTOFIN','UNIDAD DE CREDITO'] },
  { col:'estado',             label:'Estado',              tipo:'select', ops:['INGRESO','CARTA_APROBACION','EMISION_DOCUMENTOS','CARGA_DOCUMENTOS_AF','VALIDACION_FIRMA','VIGENTE','EN MORA','CANCELADO','PREPAGADO','CASTIGADO','OTORGADO','CURSADO','DESISTIDO'] },
  { col:'fecha_otorgado',     label:'Fecha Otorgado',      tipo:'date'   },
  { col:'mes',                label:'Mes',                 tipo:'month'  },
  { col:'ejecutivo',          label:'Ejecutivo',           tipo:'text'   },
  { col:'automotora',         label:'Dealer/Automotora',   tipo:'text'   },
  { col:'rut_concesionario',  label:'RUT Concesionario',   tipo:'text'   },
  { col:'vendedor',           label:'Vendedor',            tipo:'text'   },
  { col:'parque',             label:'Parque',              tipo:'text'   },
  { col:'tipo_vehiculo',      label:'Tipo Vehículo',       tipo:'text'   },
  { col:'marca',              label:'Marca',               tipo:'text'   },
  { col:'modelo',             label:'Modelo',              tipo:'text'   },
  { col:'anio',               label:'Año',                 tipo:'number' },
  { col:'patente',            label:'Patente',             tipo:'text'   },
  { col:'color',              label:'Color',               tipo:'text'   },
  { col:'motor',              label:'N° Motor',            tipo:'text'   },
  { col:'chasis',             label:'N° Chasis/VIN',       tipo:'text'   },
  { col:'valor_vehiculo',     label:'Valor Vehículo',      tipo:'number' },
  { col:'pie',                label:'Pie',                 tipo:'number' },
  { col:'saldo_precio',       label:'Saldo Precio',        tipo:'number' },
  { col:'monto_financiado',   label:'Monto Financiado',    tipo:'number' },
  { col:'plazo',              label:'Plazo (meses)',        tipo:'number' },
  { col:'tascli_real',        label:'Tasa Mensual (%)',     tipo:'decimal'},
  { col:'cuota',              label:'Cuota',               tipo:'number' },
  { col:'fecha_primera_cuota',label:'Fecha 1ª Cuota',      tipo:'date'   },
  { col:'comdea_real',        label:'Comisión Dealer',     tipo:'number' },
  { col:'com_parque',         label:'Comisión Parque',     tipo:'number' },
  { col:'monto_comision_fin', label:'Comisión Financiera', tipo:'number' },
  { col:'gastos',             label:'Gastos Op.',          tipo:'number' },
  { col:'seguros',            label:'Seguros',             tipo:'number' },
  { col:'observaciones',      label:'Observaciones',       tipo:'text'   },
  { col:'id_financiera',      label:'ID Financiera',       tipo:'text'   },
  { col:'tipo_ubicacion',     label:'Tipo Ubicación',      tipo:'select', ops:['PARQUE','CALLE'] },
  { col:'nombre_parque_mgmt', label:'Nombre Parque',       tipo:'text'   },
];

const COLS_SELECT = CAMPOS_EDIT.map(c => `ob.${c.col}`).join(', ');

const estadoExpr = `COALESCE(ob.estado,
  CASE
    WHEN ob.financiera IN ('AUTOFIN','UNIDAD DE CREDITO') AND ob.estado_eval = 'OTORGADO' THEN 'OTORGADO'
    WHEN ob.estado_credito = 'OTORGADO' THEN 'VIGENTE'
    WHEN ob.estado_eval    = 'OTORGADO' THEN 'VIGENTE'
    WHEN ob.estado_eval IN ('RECHAZADO','ANULADO') THEN 'CANCELADO'
    ELSE COALESCE(ob.estado_credito, ob.estado_eval)
  END)`;

/* GET /api/edicion-creditos?tipo=otorgados|otros&q=&letra=&campo=&page= */
const getCreditos = async (req, res) => {
  try {
    const { tipo = 'otorgados', q, page = 1 } = req.query;
    const sortColReq = req.query.sort || 'id';
    const sortDirReq = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const colsOrden = new Set(['id','num_op','numero_credito','mes','fecha_otorgado','ejecutivo','automotora','estado','financiera','patente','marca','modelo']);
    const safeSort = colsOrden.has(sortColReq) ? sortColReq : 'id';
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limit = 100;
    const offset = (pageNum - 1) * limit;

    const esOtorgados = tipo === 'otorgados';

    // Meses no cerrados: solo operaciones cuyo mes no está cerrado
    let where = `
      WHERE ob.estado_eval != 'ANULADO'
        AND (ob.estado_credito IS NULL OR ob.estado_credito != 'ANULADO')
        AND NOT EXISTS (
          SELECT 1 FROM meses_cerrados mc
          WHERE mc.mes = DATE_FORMAT(ob.mes,'%Y-%m') AND mc.cerrado = 1
        )
    `;
    const params = [];

    if (esOtorgados) {
      where += ` AND ob.estado_eval = 'OTORGADO'`;
    } else {
      where += ` AND (ob.estado_eval IS NULL OR ob.estado_eval != 'OTORGADO')`;
    }

    if (q && q.trim()) {
      const like = `%${q.trim()}%`;
      where += ` AND (ob.num_op LIKE ? OR ob.numero_credito LIKE ? OR ob.automotora LIKE ? OR ob.ejecutivo LIKE ? OR ob.patente LIKE ?)`;
      params.push(like, like, like, like, like);
    }

    // Filtros por columna (igual que BD Dios)
    const colsValidas = new Set(['num_op','numero_credito','nombre_cliente','rut_cliente', ...CAMPOS_EDIT.map(c => c.col)]);
    if (req.query.filters) {
      try {
        const colFilters = JSON.parse(req.query.filters);
        for (const [col, val] of Object.entries(colFilters)) {
          if (!val || !colsValidas.has(col)) continue;
          if (col === 'nombre_cliente') {
            where += ` AND cl.nombre_completo LIKE ?`;
          } else if (col === 'rut_cliente') {
            where += ` AND cl.rut LIKE ?`;
          } else {
            where += ` AND ob.${col} LIKE ?`;
          }
          params.push(`%${val}%`);
        }
      } catch (e) { /* filtros inválidos, ignorar */ }
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM creditos ob LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente ${where}`, params
    );

    const [rows] = await pool.query(
      `SELECT ob.id, ob.num_op, ob.mes,
              COALESCE(ob.numero_credito, CONCAT('OP-',ob.num_op)) AS numero_credito_display,
              ${COLS_SELECT},
              ${estadoExpr} AS estado_calc,
              cl.nombre_completo AS nombre_cliente, cl.rut AS rut_cliente
       FROM creditos ob
       LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
       ${where}
       ORDER BY ob.${safeSort} ${sortDirReq}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: rows,
      campos: CAMPOS_EDIT,
      pagination: { total, page: pageNum, limit, pages: Math.ceil(total / limit) },
      error: null,
    });
  } catch (e) {
    console.error('[edicion getCreditos]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* PUT /api/edicion-creditos/:id  — actualizar campos, registrar log */
const updateCredito = async (req, res) => {
  try {
    const { id } = req.params;
    const cambios = req.body; // { campo: nuevoValor, ... }
    const usuario = req.usuario?.nombre
      ? `${req.usuario.nombre} ${req.usuario.apellido || ''}`.trim()
      : (req.usuario?.email || 'Sistema');

    // Verificar que el crédito existe y obtener mes + valores actuales
    const [[cred]] = await pool.query('SELECT id, num_op, mes FROM creditos WHERE id = ?', [id]);
    if (!cred) return res.status(404).json({ success: false, data: null, error: 'Crédito no encontrado' });

    const mes = cred.mes ? String(cred.mes).slice(0, 7) : null;
    if (mes && await isMesCerrado(mes))
      return res.status(403).json({ success: false, data: null, error: `Mes ${mes} cerrado — no se permiten modificaciones` });

    // Filtrar solo campos permitidos
    const colsValidas = new Set(CAMPOS_EDIT.map(c => c.col));
    const sets = [], vals = [], logEntries = [];

    // Obtener valores actuales para el log
    const colsSel = [...colsValidas].join(', ');
    const [[actual]] = await pool.query(`SELECT ${colsSel} FROM creditos WHERE id = ?`, [id]);

    for (const [campo, nuevoVal] of Object.entries(cambios)) {
      if (!colsValidas.has(campo)) continue;
      const valorAntes = actual?.[campo];
      const valorDespues = nuevoVal === '' ? null : nuevoVal;
      sets.push(`${campo} = ?`);
      vals.push(valorDespues);
      logEntries.push([id, cred.num_op, usuario, campo, valorAntes ?? null, valorDespues ?? null]);
    }

    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Sin campos para actualizar' });

    await pool.query(`UPDATE creditos SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, [...vals, id]);

    if (logEntries.length) {
      await pool.query(
        `INSERT INTO creditos_edicion_log (id_credito, num_op, usuario, campo, valor_antes, valor_despues) VALUES ?`,
        [logEntries]
      );
    }

    res.json({ success: true, data: { id, campos_actualizados: sets.length }, error: null });
  } catch (e) {
    console.error('[edicion updateCredito]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* GET /api/edicion-creditos/:id/log */
const getLog = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, campo, valor_antes, valor_despues, usuario, fecha
       FROM creditos_edicion_log WHERE id_credito = ? ORDER BY fecha DESC LIMIT 200`,
      [req.params.id]
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { getCreditos, updateCredito, getLog };
