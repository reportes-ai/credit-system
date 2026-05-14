const mysql = require('mysql2/promise');

async function setupDatabase() {
  try {
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: ''
    });

    console.log('✓ Conectado a MySQL');
    await connection.execute('CREATE DATABASE IF NOT EXISTS credit_system');
    console.log('✓ Base de datos creada');
    await connection.end();

    const dbConnection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'credit_system'
    });

    console.log('✓ Conectado a credit_system');

    const tables = [
      `CREATE TABLE IF NOT EXISTS clientes (
        id_cliente INT PRIMARY KEY AUTO_INCREMENT,
        rut VARCHAR(12) UNIQUE NOT NULL,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100),
        telefono VARCHAR(20),
        ciudad_id INT,
        estado VARCHAR(20),
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS cotizaciones (
        id_cotizacion INT PRIMARY KEY AUTO_INCREMENT,
        id_cliente INT NOT NULL,
        monto DECIMAL(15,2),
        plazo INT,
        cuota DECIMAL(15,2),
        interes DECIMAL(15,2),
        estado VARCHAR(20),
        FOREIGN KEY (id_cliente) REFERENCES clientes(id_cliente)
      )`,
      
      `CREATE TABLE IF NOT EXISTS creditos (
        id_credito INT PRIMARY KEY AUTO_INCREMENT,
        id_cliente INT NOT NULL,
        monto DECIMAL(15,2),
        plazo INT,
        cuota DECIMAL(15,2),
        saldo_pendiente DECIMAL(15,2),
        estado VARCHAR(20),
        FOREIGN KEY (id_cliente) REFERENCES clientes(id_cliente)
      )`
    ];

    for (let i = 0; i < tables.length; i++) {
      await dbConnection.execute(tables[i]);
      console.log(`✓ Tabla ${i + 1}/${tables.length} creada`);
    }

    await dbConnection.end();
    console.log('✓ ¡Base de datos lista!');
    process.exit(0);
  } catch (error) {
    console.error('✗ Error:', error.message);
    process.exit(1);
  }
}

setupDatabase();
