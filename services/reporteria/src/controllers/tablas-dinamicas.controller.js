'use strict';
const pool = require('../../../../shared/config/database');

/* ── Migración ─────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tablas_dinamicas_guardadas (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario  INT NOT NULL,
        nombre      VARCHAR(200) NOT NULL,
        descripcion TEXT,
        config      JSON NOT NULL,
        publica     TINYINT(1) DEFAULT 0,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_usuario (id_usuario),
        INDEX idx_publica (publica)
      )
    `);
    console.log('[tablas-dinamicas] tabla OK');
  } catch (e) {
    if (e.errno !== 1050) console.error('[tablas-dinamicas migration]', e.message);
  }
})();

/* ── Fuentes disponibles ─────────────────────────────────────────
   Whitelist de tablas y sus campos (nombre legible + campo real).
   Solo mostramos campos útiles para reportes.
─────────────────────────────────────────────────────────────────── */
const FUENTES = {
  creditos: {
    label: 'Créditos',
    tabla: 'creditos',
    campos: [
      { campo:'num_op',              label:'N° Operación',            tipo:'numero' },
      { campo:'ejecutivo',           label:'Ejecutivo',               tipo:'texto'  },
      { campo:'financiera',          label:'Financiera',              tipo:'texto'  },
      { campo:'producto',            label:'Producto',                tipo:'texto'  },
      { campo:'automotora',          label:'Automotora / Dealer',     tipo:'texto'  },
      { campo:'parque',              label:'Parque',                  tipo:'texto'  },
      { campo:'estado_credito',      label:'Estado Crédito',          tipo:'texto'  },
      { campo:'estado_eval',         label:'Estado Evaluación',       tipo:'texto'  },
      { campo:'mes',                 label:'Mes',                     tipo:'fecha'  },
      { campo:'fecha_otorgado',      label:'Fecha Otorgado',          tipo:'fecha'  },
      { campo:'monto_financiado',    label:'Monto Financiado',        tipo:'numero' },
      { campo:'monto_capitalizado',  label:'Monto Capitalizado',      tipo:'numero' },
      { campo:'saldo_precio',        label:'Saldo Precio',            tipo:'numero' },
      { campo:'plazo',               label:'Plazo',                   tipo:'numero' },
      { campo:'monto_comision_fin',  label:'Comisión Financiera',     tipo:'numero' },
      { campo:'comdea_real',         label:'Comisión Dealer',         tipo:'numero' },
      { campo:'com_parque',          label:'Comisión Parque',         tipo:'numero' },
      { campo:'arriendo_parque',     label:'Arriendo Parque',         tipo:'numero' },
      { campo:'com_rdh',             label:'Comisión RDH',            tipo:'numero' },
      { campo:'com_cesantia',        label:'Comisión Cesantía',       tipo:'numero' },
      { campo:'com_reparaciones',    label:'Comisión Reparaciones',   tipo:'numero' },
      { campo:'ingreso_neto_total',  label:'Ingreso Neto Total',      tipo:'numero' },
      { campo:'marca',               label:'Marca Vehículo',          tipo:'texto'  },
      { campo:'modelo',              label:'Modelo Vehículo',         tipo:'texto'  },
      { campo:'rut_cliente',         label:'RUT Cliente',             tipo:'texto'  },
      { campo:'nombre_cliente',      label:'Nombre Cliente',          tipo:'texto'  },
      { campo:'estado_fundantes',    label:'Estado Fundantes',        tipo:'texto'  },
    ]
  },
  clientes: {
    label: 'Clientes',
    tabla: 'clientes',
    campos: [
      { campo:'rut',           label:'RUT',                tipo:'texto'  },
      { campo:'nombre',        label:'Nombre',             tipo:'texto'  },
      { campo:'apellido_p',    label:'Apellido Paterno',   tipo:'texto'  },
      { campo:'apellido_m',    label:'Apellido Materno',   tipo:'texto'  },
      { campo:'email',         label:'Email',              tipo:'texto'  },
      { campo:'telefono',      label:'Teléfono',           tipo:'texto'  },
      { campo:'ciudad',        label:'Ciudad',             tipo:'texto'  },
      { campo:'actividad',     label:'Actividad',          tipo:'texto'  },
      { campo:'created_at',    label:'Fecha Creación',     tipo:'fecha'  },
    ]
  },
  comisiones: {
    label: 'Comisiones Variables',
    tabla: 'comisiones_variables',
    campos: [
      { campo:'clave',    label:'Clave',        tipo:'texto'  },
      { campo:'valor',    label:'Valor',        tipo:'numero' },
      { campo:'descripcion', label:'Descripción', tipo:'texto' },
    ]
  }
};

/* ── GET /api/tablas-dinamicas/fuentes ───────────────────────────── */
const getFuentes = (req, res) => {
  const lista = Object.entries(FUENTES).map(([key, f]) => ({
    key, label: f.label, campos: f.campos
  }));
  res.json({ success: true, data: lista, error: null });
};

/* ── POST /api/tablas-dinamicas/ejecutar ─────────────────────────── */
const ejecutar = async (req, res) => {
  try {
    const { fuente, filas = [], valores = [], filtros = [], orden_campo, orden_dir, limite = 500 } = req.body;

    if (!FUENTES[fuente]) return res.status(400).json({ success: false, data: null, error: 'Fuente inválida' });
    const { tabla, campos: camposValidos } = FUENTES[fuente];
    const camposSet = new Set(camposValidos.map(c => c.campo));

    // Validar filas
    const filasValidas = filas.filter(f => camposSet.has(f));
    // Validar valores: [{ campo, funcion, alias }]
    const funcioValidas = ['SUM','COUNT','AVG','MAX','MIN','COUNT_DISTINCT'];
    const valoresValidos = valores.filter(v =>
      camposSet.has(v.campo) && funcioValidas.includes(v.funcion)
    );

    if (filasValidas.length === 0 && valoresValidos.length === 0) {
      return res.status(400).json({ success: false, data: null, error: 'Debes seleccionar al menos un campo de fila o valor' });
    }

    // Validar filtros
    const opValidos = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL'];
    const filtrosValidos = filtros.filter(f =>
      camposSet.has(f.campo) && opValidos.includes(f.operador)
    );

    // Construir SELECT
    const selectParts = [];
    filasValidas.forEach(f => {
      // Para mes: formatear como YYYY-MM
      if (f === 'mes' || f === 'fecha_otorgado' || f === 'fecha_primera_cuota') {
        selectParts.push(`DATE_FORMAT(\`${f}\`, '%Y-%m') AS \`${f}\``);
      } else {
        selectParts.push(`\`${f}\``);
      }
    });
    valoresValidos.forEach(v => {
      const alias = v.alias || `${v.funcion}(${v.campo})`;
      if (v.funcion === 'COUNT_DISTINCT') {
        selectParts.push(`COUNT(DISTINCT \`${v.campo}\`) AS \`${alias}\``);
      } else {
        selectParts.push(`${v.funcion}(\`${v.campo}\`) AS \`${alias}\``);
      }
    });

    // WHERE
    const whereParts = [];
    const whereVals  = [];
    filtrosValidos.forEach(f => {
      if (f.operador === 'IS NULL' || f.operador === 'IS NOT NULL') {
        whereParts.push(`\`${f.campo}\` ${f.operador}`);
      } else if (f.operador === 'LIKE' || f.operador === 'NOT LIKE') {
        whereParts.push(`\`${f.campo}\` ${f.operador} ?`);
        whereVals.push(`%${f.valor}%`);
      } else {
        whereParts.push(`\`${f.campo}\` ${f.operador} ?`);
        whereVals.push(f.valor);
      }
    });

    // GROUP BY
    const groupBy = filasValidas.length && valoresValidos.length
      ? `GROUP BY ${filasValidas.map(f => {
          if (f === 'mes' || f === 'fecha_otorgado') return `DATE_FORMAT(\`${f}\`, '%Y-%m')`;
          return `\`${f}\``;
        }).join(', ')}`
      : '';

    // ORDER BY
    let orderBy = '';
    if (orden_campo) {
      const dirSafe = orden_dir === 'ASC' ? 'ASC' : 'DESC';
      const campoOrdenOK = filasValidas.includes(orden_campo) ||
        valoresValidos.some(v => (v.alias || `${v.funcion}(${v.campo})`) === orden_campo);
      if (campoOrdenOK) {
        orderBy = `ORDER BY \`${orden_campo}\` ${dirSafe}`;
      }
    }

    const lim = Math.min(Math.max(1, parseInt(limite) || 500), 2000);
    const whereStr = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';
    const sql = `SELECT ${selectParts.join(', ')} FROM \`${tabla}\` ${whereStr} ${groupBy} ${orderBy} LIMIT ${lim}`;

    const [rows] = await pool.query(sql, whereVals);

    // Totales para columnas numéricas
    const totales = {};
    if (rows.length && valoresValidos.length) {
      valoresValidos.forEach(v => {
        const alias = v.alias || `${v.funcion}(${v.campo})`;
        totales[alias] = rows.reduce((acc, r) => acc + (parseFloat(r[alias]) || 0), 0);
      });
    }

    res.json({ success: true, data: { rows, totales, sql_info: `${rows.length} registros` }, error: null });
  } catch (e) {
    console.error('[tablas-dinamicas ejecutar]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── GET /api/tablas-dinamicas/guardadas ─────────────────────────── */
const getGuardadas = async (req, res) => {
  try {
    const id_usuario = req.usuario.id_usuario;
    // Propias + públicas de otros
    const [rows] = await pool.query(
      `SELECT id, id_usuario, nombre, descripcion, publica, created_at, updated_at,
              (id_usuario = ?) AS es_mia
       FROM tablas_dinamicas_guardadas
       WHERE id_usuario = ? OR publica = 1
       ORDER BY es_mia DESC, updated_at DESC`,
      [id_usuario, id_usuario]
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── GET /api/tablas-dinamicas/guardadas/:id ────────────────────── */
const getGuardadaById = async (req, res) => {
  try {
    const id_usuario = req.usuario.id_usuario;
    const [[row]] = await pool.query(
      'SELECT * FROM tablas_dinamicas_guardadas WHERE id = ? AND (id_usuario = ? OR publica = 1)',
      [req.params.id, id_usuario]
    );
    if (!row) return res.status(404).json({ success: false, data: null, error: 'No encontrado' });
    res.json({ success: true, data: row, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── POST /api/tablas-dinamicas/guardadas ────────────────────────── */
const MAX_POR_USUARIO = 10;

const guardar = async (req, res) => {
  try {
    const id_usuario = req.usuario.id_usuario;
    const { nombre, descripcion, config, publica } = req.body;

    if (!nombre || !config) return res.status(400).json({ success: false, data: null, error: 'nombre y config requeridos' });

    // Límite de 10 por usuario
    const [[{ cnt }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM tablas_dinamicas_guardadas WHERE id_usuario = ?',
      [id_usuario]
    );
    if (cnt >= MAX_POR_USUARIO) {
      return res.status(400).json({ success: false, data: null,
        error: `Límite de ${MAX_POR_USUARIO} tablas por usuario alcanzado. Elimina alguna antes de guardar.` });
    }

    const [r] = await pool.query(
      'INSERT INTO tablas_dinamicas_guardadas (id_usuario, nombre, descripcion, config, publica) VALUES (?,?,?,?,?)',
      [id_usuario, nombre.trim(), descripcion || null, JSON.stringify(config), publica ? 1 : 0]
    );
    const [[saved]] = await pool.query('SELECT * FROM tablas_dinamicas_guardadas WHERE id = ?', [r.insertId]);
    res.status(201).json({ success: true, data: saved, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── PUT /api/tablas-dinamicas/guardadas/:id ─────────────────────── */
const actualizar = async (req, res) => {
  try {
    const id_usuario = req.usuario.id_usuario;
    const { nombre, descripcion, config, publica } = req.body;

    const [[row]] = await pool.query(
      'SELECT id FROM tablas_dinamicas_guardadas WHERE id = ? AND id_usuario = ?',
      [req.params.id, id_usuario]
    );
    if (!row) return res.status(403).json({ success: false, data: null, error: 'Sin permisos o no encontrado' });

    await pool.query(
      'UPDATE tablas_dinamicas_guardadas SET nombre=?, descripcion=?, config=?, publica=?, updated_at=NOW() WHERE id=?',
      [nombre, descripcion || null, JSON.stringify(config), publica ? 1 : 0, req.params.id]
    );
    const [[updated]] = await pool.query('SELECT * FROM tablas_dinamicas_guardadas WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: updated, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── DELETE /api/tablas-dinamicas/guardadas/:id ──────────────────── */
const eliminar = async (req, res) => {
  try {
    const id_usuario = req.usuario.id_usuario;
    const [[row]] = await pool.query(
      'SELECT id FROM tablas_dinamicas_guardadas WHERE id = ? AND id_usuario = ?',
      [req.params.id, id_usuario]
    );
    if (!row) return res.status(403).json({ success: false, data: null, error: 'Sin permisos o no encontrado' });
    await pool.query('DELETE FROM tablas_dinamicas_guardadas WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: { deleted: req.params.id }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getFuentes, ejecutar, getGuardadas, getGuardadaById, guardar, actualizar, eliminar };
