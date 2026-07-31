'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   VENDEDORES CON VENTAS — quién vendió, cuánto y qué operaciones

   Para qué: saber mes a mes qué vendedor de cada concesionario nos trajo negocio,
   con cuántas operaciones otorgadas y por qué monto, y poder abrir el detalle
   operación por operación sin salir a cruzar planillas.

   De dónde sale cada dato (una sola fuente, Máxima 2):
     · Operaciones otorgadas, monto, dealer y nombre del vendedor → `creditos`.
     · RUT y correo del vendedor → `vendedores_dealer` (el crédito solo guarda el
       NOMBRE). El cruce se resuelve en código —~335 filas— porque TiDB no admite
       subconsultas en el ON y un JOIN doble multiplicaría operaciones.
       Preferencia: <nombre + RUT del dealer>; respaldo: <nombre> solo.

   El agrupado por vendedor lo arma el frontend con las mismas filas del detalle:
   así el total de la cabecera y el detalle que se abre al pinchar NUNCA pueden
   discrepar — son la misma lista sumada.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

const norm  = s => String(s || '').replace(/[.\-\s]/g, '').toUpperCase();
const clave = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

/* GET /api/postventa/vendedores-ventas?mes=YYYY-MM&q=…
   Sin `mes` devuelve los últimos 12 meses de otorgamiento. */
exports.listar = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
    const q   = String(req.query.q || '').trim();

    const where = ['c.fecha_otorgado IS NOT NULL'], params = [];
    if (mes) { where.push("DATE_FORMAT(c.fecha_otorgado,'%Y-%m') = ?"); params.push(mes); }
    else       where.push('c.fecha_otorgado >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)');

    const [rows] = await pool.query(`
      SELECT DATE_FORMAT(c.fecha_otorgado,'%Y-%m') AS mes,
             c.id, c.num_op, c.id_financiera, c.financiera, c.fecha_otorgado,
             c.ejecutivo, c.monto_financiado, c.saldo_precio,
             COALESCE(NULLIF(c.vendedor,''), '') AS vendedor_nombre,
             COALESCE(c.automotora,'') AS dealer, c.rut_dealer,
             COALESCE(NULLIF(cl.nombre_completo,''),
                      NULLIF(TRIM(CONCAT(COALESCE(cl.nombres,''),' ',COALESCE(cl.apellido_paterno,''))),'')) AS cliente,
             cl.rut AS rut_cliente
        FROM creditos c
        LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
       WHERE ${where.join(' AND ')}
       ORDER BY c.fecha_otorgado DESC, c.id DESC
       LIMIT 20000`, params);

    // Índice de vendedores: por <nombre|rut_dealer> y por <nombre> como respaldo.
    const [vend] = await pool.query('SELECT rut_dealer, nombre, rut, mail FROM vendedores_dealer');
    const porNombreDealer = new Map(), porNombre = new Map();
    vend.forEach(v => {
      const n = clave(v.nombre);
      if (!n) return;
      porNombreDealer.set(n + '|' + norm(v.rut_dealer), v);
      if (!porNombre.has(n)) porNombre.set(n, v);
    });
    rows.forEach(r => {
      const n = clave(r.vendedor_nombre);
      const v = n ? (porNombreDealer.get(n + '|' + norm(r.rut_dealer)) || porNombre.get(n)) : null;
      r.vendedor_rut  = v ? v.rut  : null;
      r.vendedor_mail = v ? v.mail : null;
    });

    // Buscador multi-variable: un cuadro que barre todos los campos de la fila.
    let data = rows;
    if (q) {
      const t = q.toUpperCase(), tr = norm(q);
      data = rows.filter(r =>
        [r.num_op, r.id_financiera, r.financiera, r.ejecutivo, r.cliente,
         r.dealer, r.vendedor_nombre, r.vendedor_mail]
          .some(v => String(v == null ? '' : v).toUpperCase().includes(t))
        || (tr && [r.rut_cliente, r.rut_dealer, r.vendedor_rut].some(v => norm(v).includes(tr))));
    }

    // Meses disponibles (del universo, no del filtro de texto) para el selector.
    const meses = [...new Set(rows.map(r => r.mes).filter(Boolean))].sort().reverse();

    res.json({ success: true, data, meses, error: null });
  } catch (e) {
    console.error('[vendedores-ventas]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
