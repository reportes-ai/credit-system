'use strict';
const pool = require('../../../../shared/config/database');
const { tieneFunc } = require('../../../../shared/middleware/permisos');

/* Protección por-key: cartas_parametros es un store key-value compartido por varios
   módulos con permisos DISTINTOS → un requireFunc único en la ruta no sirve.
   Keys de configuración (mantenedores) exigen su permiso; las keys OPERATIVAS del
   flujo de cartas (dealers, cartolas, comisiones, financiera, …) quedan abiertas a
   autenticados — las escribe cartas-aprobacion/app.js en la operación normal. */
const KEY_PERMISOS = {
  pol_docs_respaldo:      ['política_ver'],
  financiera_preferencia: ['mant_pref_financiera'],
  factores_participacion: ['cartas_params_particip'],
  financieras_config:     ['mant_financieras', 'mantenedores_financieras'],
  carta_intro:            ['cartas_mantenedores'],
  carta_consideraciones:  ['cartas_mantenedores'],
  firma_empresa:          ['cartas_mantenedores'],
  plazo_reparos_dias:     ['cartas_mantenedores'],
  plazo_factura_dias:     ['cartas_mantenedores'],
  dealer_ia_limite_dia:   ['cartas_mantenedores'],
};

const getParam = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT `value` FROM cartas_parametros WHERE `key` = ?',
      [req.params.key]
    );
    if (!rows.length) return res.json({ success: true, data: null, error: null });
    res.json({ success: true, data: rows[0].value, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const setParam = async (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ success: false, data: null, error: 'value requerido' });
    const permisos = KEY_PERMISOS[req.params.key];
    if (permisos) {
      const uid = (req.usuario || req.user || {}).id_usuario;
      if (!uid || !(await tieneFunc(uid, ...permisos)))
        return res.status(403).json({ success: false, data: null, error: 'Sin permisos suficientes (' + permisos.join(' o ') + ')' });
    }
    const updatedBy = req.user ? (req.user.email || String(req.user.id_usuario)) : 'system';
    await pool.query(
      'INSERT INTO cartas_parametros (`key`, `value`, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`), updated_by=VALUES(updated_by), updated_at=NOW()',
      [req.params.key, String(value), updatedBy]
    );
    res.json({ success: true, data: { key: req.params.key }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getParam, setParam };
