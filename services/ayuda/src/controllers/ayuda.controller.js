'use strict';
const pool = require('../../../../shared/config/database');

/* ── Migración + seed piloto (Post Venta) ─────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ayuda_paginas (
        ruta        VARCHAR(150) PRIMARY KEY,
        titulo      VARCHAR(150) NOT NULL,
        icono       VARCHAR(40)  DEFAULT 'bi-question-circle',
        descripcion TEXT,
        pasos       TEXT,        /* JSON: [{titulo, detalle}] */
        submodulos  TEXT,        /* JSON: [{nombre, para_que}] */
        siguiente   TEXT,
        updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);

    // Seed piloto: Post Venta (solo si no existe)
    const pasos = JSON.stringify([
      { titulo: 'Marca el avance en Seguimiento',
        detalle: 'En "Seguimiento Saldos Precio y Comisiones" cada crédito tiene dos pistas de casillas: Saldo Precio y Comisión. Marca cada etapa a medida que se completa el trámite. Las casillas son secuenciales (no puedes marcar una si la anterior no está marcada).' },
      { titulo: 'Paga los saldos liberados',
        detalle: 'Cuando un crédito llega a la etapa "Liberado a pago", aparece automáticamente en "Saldos Precios a Pagar". Ahí seleccionas las operaciones, ves cuánto cargar al banco y al guardar quedan marcadas como pagadas.' },
      { titulo: 'Configura las reglas (Admin)',
        detalle: 'En "Mantenedores Post Venta" defines qué estado (Pendiente / Para Pago / Pagado) equivale a cada etapa y qué perfiles pueden marcar cada casilla.' },
    ]);
    const submodulos = JSON.stringify([
      { nombre: 'Seguimiento Saldos Precio y Comisiones', para_que: 'Grilla por crédito con todas las etapas. Es el día a día: marcar avances.' },
      { nombre: 'Saldos Precios a Pagar', para_que: 'Operaciones listas para pago: seleccionarlas, cargarlas al banco y marcarlas pagadas.' },
      { nombre: 'Fundantes Pendientes', para_que: 'Consulta de operaciones con documentos fundantes pendientes (en preparación).' },
      { nombre: 'Consulta Estado Saldos Precio', para_que: 'Consulta del estado de saldo precio por operación (en preparación).' },
      { nombre: 'Consulta Estado Factura', para_que: 'Consulta del estado de factura y comisión (en preparación).' },
      { nombre: 'Mantenedores Post Venta', para_que: 'Configura estados equivalentes y permisos por etapa. Solo Admin.' },
    ]);
    await pool.query(
      `INSERT IGNORE INTO ayuda_paginas (ruta, titulo, icono, descripcion, pasos, submodulos, siguiente)
       VALUES (?,?,?,?,?,?,?)`,
      ['/postventa/', 'Post Venta', 'bi-truck',
       'Hace seguimiento a los créditos después de otorgados: el pago del saldo precio al dealer y el ciclo de comisión, etapa por etapa. Te muestra en qué punto va cada operación y cuáles están listas para pagar.',
       pasos, submodulos,
       'Lo habitual: primero entra a "Seguimiento" y marca los avances. Cuando un saldo quede "Liberado a pago", ve a "Saldos Precios a Pagar" para cargarlo al banco y marcarlo pagado.']);
    console.log('[ayuda] tabla OK');
  } catch (e) { console.error('[ayuda migration]', e.message); }
})();

const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const normRuta = r => { let x = String(r || '').split('?')[0].split('#')[0]; if (!x.endsWith('/')) x += '/'; return x; };

/* ── GET /api/ayuda?ruta=/postventa/ ─────────────────────────────── */
const getAyuda = async (req, res) => {
  try {
    const ruta = normRuta(req.query.ruta);
    const [[row]] = await pool.query('SELECT * FROM ayuda_paginas WHERE ruta = ?', [ruta]);
    if (!row) return res.json({ success: true, data: null, error: null });
    res.json({
      success: true,
      data: {
        ruta: row.ruta, titulo: row.titulo, icono: row.icono,
        descripcion: row.descripcion,
        pasos: parse(row.pasos, []),
        submodulos: parse(row.submodulos, []),
        siguiente: row.siguiente,
      },
      error: null,
    });
  } catch (e) {
    console.error('[ayuda getAyuda]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── PUT /api/ayuda/:ruta — para el futuro mantenedor de Ayuda ───── */
const upsertAyuda = async (req, res) => {
  try {
    const ruta = normRuta(req.body.ruta || req.params.ruta);
    const { titulo, icono, descripcion, pasos, submodulos, siguiente } = req.body;
    if (!titulo) return res.status(400).json({ success: false, data: null, error: 'titulo requerido' });
    await pool.query(
      `INSERT INTO ayuda_paginas (ruta, titulo, icono, descripcion, pasos, submodulos, siguiente)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE titulo=VALUES(titulo), icono=VALUES(icono), descripcion=VALUES(descripcion),
         pasos=VALUES(pasos), submodulos=VALUES(submodulos), siguiente=VALUES(siguiente)`,
      [ruta, titulo, icono || 'bi-question-circle', descripcion || null,
       JSON.stringify(pasos || []), JSON.stringify(submodulos || []), siguiente || null]);
    res.json({ success: true, data: { ruta }, error: null });
  } catch (e) {
    console.error('[ayuda upsert]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { getAyuda, upsertAyuda };
