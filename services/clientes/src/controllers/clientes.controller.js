const pool = require('../../../../shared/config/database');

// Obtener todos los clientes
const getAllClientes = async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [clientes] = await connection.query('SELECT * FROM clientes');
    connection.release();
    
    res.json({
      success: true,
      data: clientes,
      error: null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      data: null,
      error: error.message
    });
  }
};

// Obtener cliente por ID
const getClienteById = async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();
    const [cliente] = await connection.query(
      'SELECT * FROM clientes WHERE id_cliente = ?',
      [id]
    );
    connection.release();

    if (cliente.length === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        error: 'Cliente no encontrado'
      });
    }

    res.json({
      success: true,
      data: cliente[0],
      error: null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      data: null,
      error: error.message
    });
  }
};

// Crear nuevo cliente
const createCliente = async (req, res) => {
  try {
    const { rut, nombre, email, telefono, direccion, ciudad_id } = req.body;

    if (!rut || !nombre) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'RUT y nombre son requeridos'
      });
    }

    const connection = await pool.getConnection();
    const [result] = await connection.query(
      'INSERT INTO clientes (rut, nombre, email, telefono, direccion, ciudad_id, estado) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [rut, nombre, email || null, telefono || null, direccion || null, ciudad_id || null, 'activo']
    );
    connection.release();

    res.status(201).json({
      success: true,
      data: {
        id_cliente: result.insertId,
        rut,
        nombre,
        email,
        telefono,
        direccion,
        ciudad_id,
        estado: 'activo'
      },
      error: null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      data: null,
      error: error.message
    });
  }
};

// Actualizar cliente
const updateCliente = async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, email, telefono, direccion, ciudad_id, estado } = req.body;

    const connection = await pool.getConnection();
    await connection.query(
      'UPDATE clientes SET nombre = ?, email = ?, telefono = ?, direccion = ?, ciudad_id = ?, estado = ? WHERE id_cliente = ?',
      [nombre, email, telefono, direccion, ciudad_id, estado, id]
    );
    connection.release();

    res.json({
      success: true,
      data: { id_cliente: id, nombre, email, telefono, direccion, ciudad_id, estado },
      error: null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      data: null,
      error: error.message
    });
  }
};

// Eliminar cliente
const deleteCliente = async (req, res) => {
  try {
    const { id } = req.params;

    const connection = await pool.getConnection();
    await connection.query('DELETE FROM clientes WHERE id_cliente = ?', [id]);
    connection.release();

    res.json({
      success: true,
      data: { mensaje: 'Cliente eliminado' },
      error: null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      data: null,
      error: error.message
    });
  }
};

module.exports = {
  getAllClientes,
  getClienteById,
  createCliente,
  updateCliente,
  deleteCliente
};