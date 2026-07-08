'use strict';
/* ───────────────────────────────────────────────────────────────────
   Mantenedor Políticas de Preaprobación — variables de la preaprobación
   automática de créditos en TODOS los canales (Portal del Dealer y
   WhatsApp/Facilito). Lectura por shared/preaprobacion-politicas.js.
   ─────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { DEFAULTS } = require('../../../../shared/preaprobacion-politicas');
const { auditar } = require('../../../../shared/audit');

const DESCS = {
  carga_max_pct:          'Cuota máxima como % de la renta líquida (portal dealer)',
  plazos:                 'Plazos en meses que se evalúan, separados por coma',
  tolerancia_renta_pct:   '% de diferencia entre renta declarada e interna que gatilla nota de verificación',
  precio_min:             'Precio mínimo del vehículo ($)',
  precio_max:             'Precio máximo del vehículo ($)',
  antiguedad_max_default: 'Antigüedad máxima del vehículo (años) si la matriz de política no define otra',
  max_protestos:          'Protestos vigentes permitidos (sobre esto → revisión)',
  max_deuda_morosa:       'Deuda morosa permitida en $ (sobre esto → revisión)',
  max_deuda_vencida:      'Deuda vencida permitida en $ (sobre esto → revisión)',
  max_deuda_castigada:    'Deuda castigada permitida en $ (sobre esto → revisión)',
  wsp_severidad_max:      'Peor severidad DealerNet que aún preaprueba (bueno | regular | malo) — todos los canales',
  wsp_pie_expres_pct:     '% de pie desde el cual la aprobación es instantánea/exprés — todos los canales',
  informes_codigos:       'Informes DealerNet que consulta la preevaluación (vacío = todos los activos)',
  ia_modelo:              'Modelo de IA del reporte crediticio de la preevaluación (auto = el configurado en el Subsistema IA)',
  msg_aprobado_expres:    'Mensaje de aprobación INSTANTÁNEA/exprés (pie ≥ % exprés). {pie} = pie informado',
  msg_sev_bueno:          'Mensaje cuando la severidad DealerNet es BUENA. {pie_expres} = % de pie exprés',
  msg_sev_regular:        'Mensaje cuando la severidad DealerNet es REGULAR. {pie_expres} = % de pie exprés',
  msg_sev_malo:           'Mensaje de rechazo (severidad MALA o grave)',
};
const IA_MODELOS = ['auto', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'];
const MSG_KEYS = ['msg_aprobado_expres', 'msg_sev_bueno', 'msg_sev_regular', 'msg_sev_malo'];

/* ─── Migración + seed (funcionalidad bajo módulo Mantenedores) ────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS preaprobacion_parametros (
        clave       VARCHAR(50) PRIMARY KEY,
        valor       VARCHAR(600) NOT NULL,
        descripcion VARCHAR(255) NULL,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by  VARCHAR(150) NULL
      )`);
    await pool.query('ALTER TABLE preaprobacion_parametros MODIFY valor VARCHAR(600) NOT NULL').catch(() => {});
    for (const [k, v] of Object.entries(DEFAULTS))
      await pool.query('INSERT IGNORE INTO preaprobacion_parametros (clave, valor, descripcion) VALUES (?,?,?)',
        [k, String(v), DESCS[k] || null]);

    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (mod) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_preaprobacion' LIMIT 1");
      let idF = ex?.id_funcionalidad;
      if (!idF) {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, 'Políticas de Preaprobación', 'mant_preaprobacion', '/mantenedores/preaprobacion/', 'bi-patch-check']);
        idF = ins.insertId;
      }
      const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
      if (adm) await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [adm.id_perfil, idF]);
    }
    console.log('✓ mantenedor Políticas de Preaprobación listo');
  } catch (e) { console.error('[preaprobacion-politicas migration]', e.message); }
})();

/* ─── GET /api/preaprobacion-politicas ─────────────────────────────── */
const getAll = async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT clave, valor, descripcion, updated_at, updated_by FROM preaprobacion_parametros');
    const porClave = {}; rows.forEach(r => porClave[r.clave] = r);
    // orden estable = orden de DEFAULTS; completa las claves que falten
    const data = Object.keys(DEFAULTS).map(k => porClave[k] ||
      ({ clave: k, valor: String(DEFAULTS[k]), descripcion: DESCS[k] || null, updated_at: null, updated_by: null }));
    // catálogo de productos DealerNet (para los checkboxes de informes) + modelos IA
    let productos = [];
    try { const [p] = await pool.query('SELECT codigo, nombre, activo FROM dealernet_productos ORDER BY orden'); productos = p; } catch (_) {}
    res.json({ success: true, data, productos, ia_modelos: IA_MODELOS, error: null });
  } catch (e) {
    console.error('[preaprobacion getAll]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── PUT /api/preaprobacion-politicas  { valores: { clave: valor } } ── */
const update = async (req, res) => {
  try {
    const valores = req.body?.valores || {};
    const cambios = [];
    for (const [k, v] of Object.entries(valores)) {
      if (!(k in DEFAULTS)) continue;                       // solo claves conocidas
      let val = String(v ?? '').trim();
      if (k === 'wsp_severidad_max') {
        if (!['bueno', 'regular', 'malo'].includes(val.toLowerCase()))
          return res.status(400).json({ success: false, data: null, error: 'Severidad debe ser bueno, regular o malo' });
        val = val.toLowerCase();
      } else if (MSG_KEYS.includes(k)) {
        if (!val) return res.status(400).json({ success: false, data: null, error: `El mensaje ${k} no puede quedar vacío` });
        val = val.slice(0, 600);
      } else if (k === 'ia_modelo') {
        if (!IA_MODELOS.includes(val)) return res.status(400).json({ success: false, data: null, error: 'Modelo IA inválido' });
      } else if (k === 'informes_codigos') {
        val = val.split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).join(',');   // CSV de códigos; vacío = todos
      } else if (k === 'plazos') {
        const arr = val.split(',').map(n => parseInt(n, 10)).filter(n => n >= 6 && n <= 96);
        if (!arr.length) return res.status(400).json({ success: false, data: null, error: 'Plazos inválidos (meses separados por coma)' });
        val = arr.join(',');
      } else {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0) return res.status(400).json({ success: false, data: null, error: `Valor inválido para ${k}` });
        val = String(n);
      }
      await pool.query(
        `INSERT INTO preaprobacion_parametros (clave, valor, descripcion, updated_by) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE valor=VALUES(valor), updated_by=VALUES(updated_by)`,
        [k, val, DESCS[k] || null, req.usuario?.nombre_completo || req.usuario?.email || null]);
      cambios.push(`${k}=${val}`);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'preaprobacion_politicas',
      detalle: 'Actualizó políticas de preaprobación: ' + cambios.join(', ') });
    res.json({ success: true, data: { actualizados: cambios.length }, error: null });
  } catch (e) {
    console.error('[preaprobacion update]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { getAll, update };
