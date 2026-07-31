'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   VENDEDORES CON VENTAS — quién vendió, cuánto y qué operaciones

   Para qué: saber mes a mes qué vendedor de cada concesionario nos trajo negocio,
   con cuántas operaciones otorgadas y por qué monto, y poder abrir el detalle
   operación por operación sin salir a cruzar planillas.

   De dónde sale cada dato (una sola fuente, Máxima 2):
     · Operaciones otorgadas, monto y dealer → `creditos`, con etapa OTORGADO.
       OJO: `fecha_otorgado` viene poblada también en rechazadas, desistidas y
       aprobadas sin cursar, así que filtrar solo por esa fecha inflaba el conteo
       (julio 2026: 949 filas vs. 85 otorgadas de verdad). La etapa manda.
     · Nombre del VENDEDOR → `cartas_aprobacion` (es el vendedor DEL DEALER).
       `creditos.vendedor` NO sirve: la carga masiva escribe ahí nuestro propio
       ejecutivo ("VENDEDOR (AFA) …"). Solo se usa como respaldo si no hay carta.
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

    // Etapa OTORGADO: la fecha por sí sola no basta (ver cabecera del archivo).
    const where = ['c.fecha_otorgado IS NOT NULL', "UPPER(COALESCE(c.estado_credito,'')) = 'OTORGADO'"], params = [];
    if (mes) { where.push("DATE_FORMAT(c.fecha_otorgado,'%Y-%m') = ?"); params.push(mes); }
    else       where.push('c.fecha_otorgado >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)');

    const [rows] = await pool.query(`
      SELECT DATE_FORMAT(c.fecha_otorgado,'%Y-%m') AS mes,
             c.id, c.num_op, c.id_financiera, c.financiera, c.fecha_otorgado,
             c.ejecutivo, c.monto_financiado, c.saldo_precio,
             COALESCE(NULLIF(c.vendedor,''), '') AS vendedor_credito,
             COALESCE(c.automotora,'') AS dealer, c.rut_dealer,
             COALESCE(NULLIF(cl.nombre_completo,''),
                      NULLIF(TRIM(CONCAT(COALESCE(cl.nombres,''),' ',COALESCE(cl.apellido_paterno,''))),'')) AS cliente,
             cl.rut AS rut_cliente
        FROM creditos c
        LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
       WHERE ${where.join(' AND ')}
       ORDER BY c.fecha_otorgado DESC, c.id DESC
       LIMIT 20000`, params);

    /* Vendedor del DEALER: sale de la carta. Se resuelve en código y no con un
       JOIN porque una misma operación puede tener varias cartas (correcciones), y
       el JOIN duplicaba la operación tantas veces como cartas tuviera. Se toma la
       más reciente (id mayor). */
    const idsFin = [...new Set(rows.map(r => r.id_financiera).filter(Boolean))];
    const cartaDe = new Map();
    for (let i = 0; i < idsFin.length; i += 500) {
      const [cs] = await pool.query(
        'SELECT id, id_financiera, vendedor FROM cartas_aprobacion WHERE id_financiera IN (?) ORDER BY id ASC',
        [idsFin.slice(i, i + 500)]);
      cs.forEach(c => { if (String(c.vendedor || '').trim()) cartaDe.set(String(c.id_financiera), c.vendedor); });
    }
    /* "VENDEDOR (AFA) …" / "VENDEDORA PARQUE …" es NUESTRO ejecutivo, no el del dealer.
       "S/I", "-" o vacío son AUSENCIA de dato: no significan venta directa. Confundir
       las dos cosas hacía aparecer dealers reales (Verdugo, Fénix) como ventas nuestras. */
    const esPlaceholderAFA = v => /^VENDEDOR(A)?\s*\(?AFA\)?|^VENDEDOR(A)?\s+PARQUE/i.test(String(v || '').trim());
    const SIN_DATO = new Set(['', 'S/I', 'SI', 'S/D', 'N/A', '-', '--', 'SIN INFORMACION', 'SIN INFORMACIÓN']);
    rows.forEach(r => {
      const deCarta = cartaDe.get(String(r.id_financiera));
      const deCred  = String(r.vendedor_credito || '').trim();
      const credVacio = SIN_DATO.has(deCred.toUpperCase());
      if (deCarta)                          { r.vendedor_nombre = deCarta; r.origen_vendedor = 'carta'; }
      else if (!credVacio && !esPlaceholderAFA(deCred))
                                            { r.vendedor_nombre = deCred; r.origen_vendedor = 'crédito'; }
      else if (!credVacio)                  { r.vendedor_nombre = '';     r.origen_vendedor = 'venta directa AutoFácil'; }
      else                                  { r.vendedor_nombre = '';     r.origen_vendedor = 'sin dato'; }
    });

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
