'use strict';
/**
 * Mantenedor de Categorías de Dealers (Socio / Partner / Super Partner).
 * Define niveles, metas (unidades/mes) y beneficios. Propone la categoría de
 * cada dealer según las ventas (créditos otorgados) del mes pasado.
 */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const normRut = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();

const SEED = [
  { nivel: 1, codigo: 'SOCIO', nombre: 'Socio', meta_min_unidades: 0, meta_texto: 'SIN MÍNIMO',
    descripcion: 'Base de la red y evaluación de potencial', color: '#64748b',
    beneficios: ['Acceso a plataforma digital AutoFácil', 'Financiamiento para clientes finales',
      'Gestión 100% online de operaciones', 'Dashboard de seguimiento básico', 'Capacitación inicial del equipo'] },
  { nivel: 2, codigo: 'PARTNER', nombre: 'Partner', meta_min_unidades: 4, meta_texto: '4+ UNIDADES / MES',
    descripcion: 'Fidelización y aumento de cuota de mercado', color: '#0141A2',
    beneficios: ['Todo lo del nivel Socio', 'Liquidez: pago operaciones en 48h', 'Kit básico de branding en punto de venta',
      'Reporte mensual de desempeño', 'Gestor comercial dedicado', 'Participación en campañas digitales'] },
  { nivel: 3, codigo: 'SUPER_PARTNER', nombre: 'Super Partner', meta_min_unidades: 8, meta_texto: '8+ UNIDADES / MES',
    descripcion: 'Alianza estratégica con beneficios exclusivos', color: '#7c2d12',
    beneficios: ['Todo lo de nivel Partner', 'Branding total + instalación completa', 'Liquidez prioritaria 24h garantizada',
      'Soporte comercial prioritario 7 días', 'Material POP premium y totem de marca',
      'Incentivos exclusivos por meta trimestral', 'Exclusividad territorial negociable'] },
];

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_categorias (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        nivel             INT          NOT NULL,
        codigo            VARCHAR(20)  NOT NULL UNIQUE,
        nombre            VARCHAR(60)  NOT NULL,
        meta_min_unidades INT          NOT NULL DEFAULT 0,
        meta_texto        VARCHAR(60)  NULL,
        descripcion       VARCHAR(200) NULL,
        color             VARCHAR(10)  NULL,
        beneficios        JSON         NULL,
        orden             INT          NOT NULL DEFAULT 0
      )`);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM dealer_categorias');
    if (n === 0) {
      for (const c of SEED) {
        await pool.query(
          `INSERT IGNORE INTO dealer_categorias (nivel, codigo, nombre, meta_min_unidades, meta_texto, descripcion, color, beneficios, orden)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [c.nivel, c.codigo, c.nombre, c.meta_min_unidades, c.meta_texto, c.descripcion, c.color, JSON.stringify(c.beneficios), c.nivel]);
      }
    }
    // Columnas de categoría en la tabla de dealers
    await pool.query(`ALTER TABLE dealers ADD COLUMN IF NOT EXISTS categoria_propuesta VARCHAR(20) NULL`);
    await pool.query(`ALTER TABLE dealers ADD COLUMN IF NOT EXISTS categoria_asignada VARCHAR(20) NULL`);
    await pool.query(`ALTER TABLE dealers ADD COLUMN IF NOT EXISTS unidades_mes_pasado INT NULL`);

    // Registro del mantenedor en el menú (bajo Mantenedores).
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo' LIMIT 1");
    if (mod) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_dealer_categorias' LIMIT 1");
      let idf = ex && ex.id_funcionalidad;
      if (!idf) {
        const [r] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
           VALUES (?, 'Categorías de Dealers', 'mant_dealer_categorias', '/mantenedores/dealer-categorias/', 'bi-award')`, [mod.id_modulo]);
        idf = r.insertId;
      }
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }
    console.log('[dealer-categorias] mantenedor registrado');
  } catch (e) { console.error('[dealer-categorias migration]', e.message); }
})();

/* Determina el código de categoría según unidades vendidas y las metas. */
function categoriaPara(unidades, cats) {
  // cats ordenadas por meta_min_unidades desc → la primera que cumple
  for (const c of cats) if (unidades >= c.meta_min_unidades) return c.codigo;
  return cats[cats.length - 1]?.codigo || 'SOCIO';
}

/* ── GET /api/dealer-categorias ───────────────────────────────────────────── */
const listar = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM dealer_categorias ORDER BY nivel');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[dealer-cat listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── PUT /api/dealer-categorias/:id ───────────────────────────────────────── */
const actualizar = async (req, res) => {
  try {
    const { nombre, meta_min_unidades, meta_texto, descripcion, color, beneficios } = req.body || {};
    const benef = Array.isArray(beneficios) ? beneficios.map(b => String(b).trim()).filter(Boolean) : null;
    await pool.query(
      `UPDATE dealer_categorias SET nombre=?, meta_min_unidades=?, meta_texto=?, descripcion=?, color=?, beneficios=? WHERE id=?`,
      [nombre, parseInt(meta_min_unidades) || 0, meta_texto || null, descripcion || null, color || null,
       benef ? JSON.stringify(benef) : null, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer_categoria', entidad_id: req.params.id,
      detalle: `Editó categoría de dealer "${nombre}" (meta ${meta_min_unidades} u/mes)` });
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { console.error('[dealer-cat actualizar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── PUT /api/dealer-categorias/asignar/:idDealer — fija la categoría asignada ── */
const asignar = async (req, res) => {
  try {
    const cat = String(req.body.categoria_asignada || '').toUpperCase() || null;
    if (cat) { const [[ok]] = await pool.query('SELECT 1 v FROM dealer_categorias WHERE codigo=?', [cat]); if (!ok) return res.status(400).json({ success: false, data: null, error: 'Categoría inválida' }); }
    await pool.query('UPDATE dealers SET categoria_asignada=? WHERE id_dealer=?', [cat, req.params.idDealer]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: req.params.idDealer,
      detalle: `Asignó categoría ${cat || '—'} al dealer #${req.params.idDealer}` });
    res.json({ success: true, data: { categoria_asignada: cat }, error: null });
  } catch (e) { console.error('[dealer-cat asignar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /api/dealer-categorias/recalcular — propone según ventas del mes pasado ── */
const recalcular = async (req, res) => {
  try {
    const [cats] = await pool.query('SELECT codigo, meta_min_unidades FROM dealer_categorias ORDER BY meta_min_unidades DESC');
    if (!cats.length) return res.status(400).json({ success: false, data: null, error: 'No hay categorías definidas' });

    // Unidades (créditos otorgados) por dealer el mes pasado.
    const [ventas] = await pool.query(`
      SELECT rut_dealer, COUNT(*) AS unidades FROM creditos
      WHERE rut_dealer IS NOT NULL AND fecha_otorgado IS NOT NULL
        AND fecha_otorgado >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
        AND fecha_otorgado <  DATE_FORMAT(CURDATE(), '%Y-%m-01')
      GROUP BY rut_dealer`);
    const ventasPorRut = new Map();
    ventas.forEach(v => ventasPorRut.set(normRut(v.rut_dealer), Number(v.unidades) || 0));

    const [dealers] = await pool.query('SELECT id_dealer, rut, categoria_asignada FROM dealers');
    let actualizados = 0, conVentas = 0;
    for (const d of dealers) {
      const u = ventasPorRut.get(normRut(d.rut)) || 0;
      if (u > 0) conVentas++;
      const cod = categoriaPara(u, cats);
      // Propuesta + unidades del mes pasado. La Asignada se inicializa = Propuesta solo si está vacía.
      if (d.categoria_asignada)
        await pool.query('UPDATE dealers SET categoria_propuesta=?, unidades_mes_pasado=? WHERE id_dealer=?', [cod, u, d.id_dealer]);
      else
        await pool.query('UPDATE dealers SET categoria_propuesta=?, categoria_asignada=?, unidades_mes_pasado=? WHERE id_dealer=?', [cod, cod, u, d.id_dealer]);
      actualizados++;
    }
    const [[{ movs }]] = await pool.query('SELECT COUNT(*) movs FROM dealers WHERE categoria_propuesta IS NOT NULL AND categoria_asignada IS NOT NULL AND categoria_propuesta<>categoria_asignada');
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer', detalle: `Recalculó categoría propuesta de ${actualizados} dealers según ventas del mes pasado (${conVentas} con ventas)` });
    res.json({ success: true, data: { actualizados, con_ventas: conVentas, movimientos: movs }, error: null });
  } catch (e) { console.error('[dealer-cat recalcular]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/dealer-categorias/movimientos — dealers que suben/bajan (propuesta≠asignada) ── */
const movimientos = async (req, res) => {
  try {
    const [cats] = await pool.query('SELECT codigo, nombre, nivel, meta_min_unidades, meta_texto, color FROM dealer_categorias');
    const nivel = Object.fromEntries(cats.map(c => [c.codigo, c.nivel]));
    const [rows] = await pool.query(`
      SELECT id_dealer, numero, rut, nombre_indexa, nombre_razon, categoria_asignada, categoria_propuesta, unidades_mes_pasado
      FROM dealers
      WHERE categoria_propuesta IS NOT NULL AND categoria_asignada IS NOT NULL
        AND categoria_propuesta <> categoria_asignada
      ORDER BY nombre_indexa`);
    const data = rows.map(d => ({ ...d,
      direccion_mov: (nivel[d.categoria_propuesta] || 0) > (nivel[d.categoria_asignada] || 0) ? 'SUBE' : 'BAJA' }));
    res.json({ success: true, data: { rows: data, categorias: cats }, error: null });
  } catch (e) { console.error('[dealer-cat movimientos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { listar, actualizar, asignar, recalcular, movimientos };
