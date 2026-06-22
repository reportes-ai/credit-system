const pool = require('../../../../shared/config/database');

/* ──────────────────────────────────────────────────────────────────────────
 * Evaluación Crediticia
 * Card propia en el Home (anti-hardcode: vive en BD) + endpoint agregador que
 * arma la "ficha" del cliente por RUT: nombre, antigüedad de antecedentes y
 * cotizaciones guardadas (última primero). El pull en vivo a DealerNet lo hace
 * el módulo /api/dealernet/consultar al iniciar la evaluación.
 * ────────────────────────────────────────────────────────────────────────── */

const normRut = v => v ? String(v).replace(/\./g, '').toUpperCase().trim() : null;

(async () => {
  try {
    // Módulo/card propio "Evaluación Crediticia" en el Home.
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (390001, 'Evaluación Crediticia',
               'Evalúa crediticiamente a un cliente por RUT: antecedentes, cotizaciones e informe DealerNet',
               'bi-clipboard-pulse', '/evaluacion-crediticia/', 106, 'activo')`);

    // Funcionalidad (genera la card por permiso y el sub-item gestionable).
    let idFunc;
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='evaluacion_crediticia' LIMIT 1");
    if (ex) idFunc = ex.id_funcionalidad;
    else {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (390001,?,?,?,?)",
        ['Evaluación Crediticia', 'evaluacion_crediticia', '/evaluacion-crediticia/', 'bi-clipboard-pulse']);
      idFunc = r.insertId;
    }

    // Permisos por defecto: Administrador (bypass igual) + perfiles que evalúan crédito.
    const nombres = ['Administrador', 'Gerente', 'Ejecutivo', 'Ejecutivo Comercial',
                     'Analista', 'Supervisor de Crédito', 'Jefe Comercial'];
    const [perfs] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre IN (?)', [nombres]);
    for (const { id_perfil } of perfs) {
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [id_perfil, idFunc]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [id_perfil, idFunc]);
    }
    console.log('[evaluacion-crediticia] módulo/card y permisos listos');
  } catch (e) { console.error('[evaluacion-crediticia migration]', e.message); }
})();

/* GET /api/evaluacion-crediticia/ficha/:rut — ficha del cliente para evaluar */
const ficha = async (req, res) => {
  try {
    const rut = normRut(decodeURIComponent(req.params.rut || ''));
    if (!rut) return res.status(400).json({ success: false, data: null, error: 'RUT requerido' });

    // 1) Cliente (nombre)
    let cliente = null;
    try {
      const [[c]] = await pool.query(
        'SELECT rut, nombre_completo, nombres, apellido_paterno, apellido_materno FROM clientes WHERE rut=? LIMIT 1', [rut]);
      if (c) {
        const armado = [c.nombres, c.apellido_paterno, c.apellido_materno].filter(Boolean).join(' ').trim();
        cliente = { rut: c.rut, nombre: (c.nombre_completo && c.nombre_completo.trim()) || armado || null };
      }
    } catch (_) {}
    // Fallback: nombre desde créditos (carga masiva) si no está en clientes
    if (!cliente) {
      try {
        const [[op]] = await pool.query(
          `SELECT cl.rut, COALESCE(cl.nombre_completo,'') AS nombre
           FROM clientes cl JOIN creditos cr ON cr.id_cliente = cl.id_cliente
           WHERE cl.rut=? LIMIT 1`, [rut]);
        if (op) cliente = { rut: op.rut, nombre: op.nombre || null };
      } catch (_) {}
    }

    // 2) Antecedentes laborales (antigüedad en días)
    let antecedentes = null;
    try {
      const [[a]] = await pool.query(
        `SELECT updated_at, created_at, tipo_trabajador,
                DATEDIFF(NOW(), COALESCE(updated_at, created_at)) AS dias
         FROM antecedentes_laborales WHERE rut_cliente=? LIMIT 1`, [rut]);
      if (a) antecedentes = {
        existe: true,
        fecha: a.updated_at || a.created_at,
        dias: a.dias == null ? null : Number(a.dias),
        tipo_trabajador: a.tipo_trabajador || null,
      };
    } catch (_) {}

    // 3) Cotizaciones guardadas (última primero)
    let cotizaciones = [];
    try {
      const [rows] = await pool.query(
        `SELECT id_cotizacion, fecha_cotizacion, created_at, valor_vehiculo, pie,
                monto_financiado, cuota, plazo
         FROM cotizaciones WHERE rut_cliente=? ORDER BY created_at DESC LIMIT 20`, [rut]);
      cotizaciones = rows.map(r => ({
        id: r.id_cotizacion,
        fecha: r.fecha_cotizacion || r.created_at,
        valor_vehiculo: r.valor_vehiculo,
        saldo_precio: (Number(r.valor_vehiculo) || 0) - (Number(r.pie) || 0),
        monto_credito: r.monto_financiado,
        cuota: r.cuota,
        plazo: r.plazo,
      }));
    } catch (_) {}

    res.json({ success: true, data: { cliente, antecedentes, cotizaciones }, error: null });
  } catch (e) {
    console.error('[evaluacion ficha]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { ficha };
