'use strict';
const pool = require('../../../../shared/config/database');

// Lista de ejecutivos para los selectores (Digitación AutoFin, Carta de Aprobación).
// Fuente: USUARIOS autorizados al módulo (perfil Ejecutivo/Ejecutivo Comercial, o con
// permiso de crear Carta 'aprob_crear' o crear Crédito 'creditos.crear'), activos.
// Misma forma de respuesta {id, nombre, mail, tel} que la lista anterior.
const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario AS id,
              -- Convención: PRIMER nombre + apellido PATERNO (nombre completo solo en documentos formales)
              TRIM(CONCAT(SUBSTRING_INDEX(TRIM(u.nombre),' ',1), ' ', SUBSTRING_INDEX(TRIM(COALESCE(u.apellido,'')),' ',1))) AS nombre,
              u.email AS mail, u.telefono AS tel
         FROM usuarios u
         JOIN perfiles p ON p.id_perfil = u.id_perfil
        WHERE u.estado = 'activo'
          AND p.nombre <> 'Administrador'
          AND (
            p.nombre IN ('Ejecutivo', 'Ejecutivo Comercial')
            OR EXISTS (SELECT 1 FROM permisos_perfil pp
                         JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
                        WHERE pp.id_perfil = u.id_perfil AND pp.habilitado = 1
                          AND f.codigo IN ('aprob_crear', 'creditos.crear'))
            OR EXISTS (SELECT 1 FROM permisos_usuario puu
                         JOIN funcionalidades f2 ON f2.id_funcionalidad = puu.id_funcionalidad
                        WHERE puu.id_usuario = u.id_usuario AND puu.habilitado = 1
                          AND f2.codigo IN ('aprob_crear', 'creditos.crear'))
          )
        ORDER BY nombre`
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const create = async (req, res) => {
  try {
    const { nombre, mail, tel } = req.body;
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'nombre requerido' });
    const [r] = await pool.query(
      'INSERT INTO cartas_ejecutivos (nombre, mail, tel) VALUES (?, ?, ?)',
      [nombre, mail || null, tel || null]
    );
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const update = async (req, res) => {
  try {
    const { nombre, mail, tel } = req.body;
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'nombre requerido' });
    await pool.query(
      'UPDATE cartas_ejecutivos SET nombre=?, mail=?, tel=? WHERE id=?',
      [nombre, mail || null, tel || null, req.params.id]
    );
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const remove = async (req, res) => {
  try {
    await pool.query('UPDATE cartas_ejecutivos SET activo=0 WHERE id=?', [req.params.id]);
    res.json({ success: true, data: { mensaje: 'Ejecutivo eliminado' }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getAll, create, update, remove };
