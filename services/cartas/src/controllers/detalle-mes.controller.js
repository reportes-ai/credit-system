'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   DETALLE MENSUAL DE CARTAS — operación, ejecutivo, cliente y vendedor

   Para qué: tener en una sola vista, mes a mes, quién vendió cada operación —
   con el RUT y el correo del vendedor— sin salir a cruzar planillas. Lo usa
   Comercial para contactar vendedores y para auditar quién trae el negocio.

   De dónde sale cada dato (una sola fuente, Máxima 2):
     · Carta, ID Financiera, ejecutivo, cliente, RUT cliente y dealer → `cartas_aprobacion`.
     · N° de operación del sistema → `creditos` por ID Financiera (la carta no lo guarda).
     · RUT y correo del vendedor  → `vendedores_dealer` (la carta solo guarda el NOMBRE).

   El cruce del vendedor se resuelve EN CÓDIGO y no con un JOIN: TiDB no admite
   subconsultas en el ON, y un JOIN doble multiplicaría filas cuando un mismo
   nombre existe en varios concesionarios. Son ~335 vendedores: cabe en memoria.
   Preferencia: <nombre + RUT del dealer>; si no calza, <nombre> solo, porque el
   mismo vendedor puede haber cambiado de concesionario.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

const norm  = s => String(s || '').replace(/[.\-\s]/g, '').toUpperCase();
const clave = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

/* GET /api/cartas/detalle-mes?mes=YYYY-MM&status=…&q=…
   Sin `mes` devuelve todos los meses; el frontend los agrupa. */
exports.detalleMes = async (req, res) => {
  try {
    const mes    = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
    const status = String(req.query.status || '').trim().toUpperCase();
    const q      = String(req.query.q || '').trim();

    const where = [], params = [];
    if (mes)    { where.push("DATE_FORMAT(ca.fecha,'%Y-%m') = ?"); params.push(mes); }
    if (status) { where.push('UPPER(ca.status) = ?');              params.push(status); }

    const [rows] = await pool.query(`
      SELECT DATE_FORMAT(ca.fecha,'%Y-%m') AS mes,
             ca.fecha, ca.op_carta, ca.id_financiera, ca.status,
             cr.num_op AS num_op,
             ca.ejecutivo, ca.cliente, ca.rut_cliente,
             ca.nombre_dealer, ca.rut_dealer,
             ca.vendedor AS vendedor_nombre
        FROM cartas_aprobacion ca
        LEFT JOIN creditos cr ON cr.id_financiera = ca.id_financiera
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ca.fecha DESC, ca.id DESC
       LIMIT 5000`, params);

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

    /* Buscador multi-variable: un solo cuadro que busca en TODOS los campos de la
       fila, incluidos RUT y correo del vendedor (que se resolvieron recién). Los
       RUT se comparan normalizados para que dé igual cómo los escriba el usuario. */
    let data = rows;
    if (q) {
      const t = q.toUpperCase(), tr = norm(q);
      data = rows.filter(r =>
        [r.op_carta, r.id_financiera, r.num_op, r.ejecutivo, r.cliente,
         r.nombre_dealer, r.vendedor_nombre, r.vendedor_mail, r.status]
          .some(v => String(v == null ? '' : v).toUpperCase().includes(t))
        || (tr && [r.rut_cliente, r.rut_dealer, r.vendedor_rut]
          .some(v => norm(v).includes(tr))));
    }

    // Resumen por mes (sobre el universo del filtro mes/estado, no del texto buscado).
    const meses = {};
    rows.forEach(r => {
      const k = r.mes || 'sin fecha';
      meses[k] = meses[k] || { mes: k, n: 0, sin_vendedor: 0, sin_datos_vendedor: 0 };
      meses[k].n++;
      if (!clave(r.vendedor_nombre)) meses[k].sin_vendedor++;
      else if (!r.vendedor_rut && !r.vendedor_mail) meses[k].sin_datos_vendedor++;
    });

    res.json({ success: true, data, meses: Object.values(meses).sort((a, b) => b.mes.localeCompare(a.mes)), error: null });
  } catch (e) {
    console.error('[cartas detalle-mes]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
