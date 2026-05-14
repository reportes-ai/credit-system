const pool = require('../../../../shared/config/database');

const getAllPerfiles = async (req, res) => {
  try {
    const [perfiles] = await pool.query(
      'SELECT * FROM perfiles ORDER BY id_perfil'
    );
    res.json({ success: true, data: perfiles, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const getModulosConFuncionalidades = async (req, res) => {
  try {
    const [modulos] = await pool.query(
      `SELECT m.id_modulo, m.nombre AS modulo, m.icono,
              f.id_funcionalidad, f.nombre AS funcionalidad, f.codigo
       FROM modulos m
       JOIN funcionalidades f ON f.id_modulo = m.id_modulo
       WHERE m.estado = 'activo'
       ORDER BY m.orden, f.id_funcionalidad`
    );

    // Agrupar por módulo
    const agrupado = [];
    const mapaModulos = {};
    for (const row of modulos) {
      if (!mapaModulos[row.id_modulo]) {
        mapaModulos[row.id_modulo] = { id_modulo: row.id_modulo, nombre: row.modulo, icono: row.icono, funcionalidades: [] };
        agrupado.push(mapaModulos[row.id_modulo]);
      }
      mapaModulos[row.id_modulo].funcionalidades.push({
        id_funcionalidad: row.id_funcionalidad,
        nombre: row.funcionalidad,
        codigo: row.codigo
      });
    }

    res.json({ success: true, data: agrupado, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const getPermisosPerfil = async (req, res) => {
  try {
    const { id } = req.params;
    const [permisos] = await pool.query(
      'SELECT id_funcionalidad, habilitado FROM permisos_perfil WHERE id_perfil = ?',
      [id]
    );
    const mapa = {};
    permisos.forEach(p => { mapa[p.id_funcionalidad] = p.habilitado === 1; });
    res.json({ success: true, data: mapa, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const updatePermisosPerfil = async (req, res) => {
  try {
    const { id } = req.params;
    const { permisos } = req.body; // [{ id_funcionalidad, habilitado }]

    if (!Array.isArray(permisos)) {
      return res.status(400).json({ success: false, data: null, error: 'Formato de permisos inválido' });
    }

    for (const p of permisos) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE habilitado = VALUES(habilitado)`,
        [id, p.id_funcionalidad, p.habilitado ? 1 : 0]
      );
    }

    res.json({ success: true, data: { mensaje: 'Permisos actualizados' }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const reordenarModulos = async (req, res) => {
  try {
    const { orden } = req.body; // [{ id_modulo, orden }]
    if (!Array.isArray(orden)) return res.status(400).json({ success: false, data: null, error: 'Formato inválido' });
    for (const m of orden) {
      await pool.query('UPDATE modulos SET orden=? WHERE id_modulo=?', [m.orden, m.id_modulo]);
    }
    res.json({ success: true, data: { mensaje: 'Orden actualizado' }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

module.exports = { getAllPerfiles, getModulosConFuncionalidades, getPermisosPerfil, updatePermisosPerfil, reordenarModulos };
