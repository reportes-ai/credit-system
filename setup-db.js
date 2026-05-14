const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function setupDatabase() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || ''
    });

    console.log('✓ Conectado a MySQL');
    await connection.execute('CREATE DATABASE IF NOT EXISTS credit_system');
    console.log('✓ Base de datos creada');
    await connection.end();

    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'credit_system'
    });

    console.log('✓ Conectado a credit_system');

    // --- Tablas base (sin FK) ---
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS perfiles (
        id_perfil INT PRIMARY KEY AUTO_INCREMENT,
        nombre VARCHAR(50) NOT NULL,
        descripcion VARCHAR(200),
        estado VARCHAR(20) DEFAULT 'activo',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS modulos (
        id_modulo INT PRIMARY KEY AUTO_INCREMENT,
        nombre VARCHAR(100) NOT NULL,
        descripcion VARCHAR(200),
        icono VARCHAR(50) DEFAULT 'bi-grid',
        ruta VARCHAR(100),
        orden INT DEFAULT 0,
        estado VARCHAR(20) DEFAULT 'activo'
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS clientes (
        id_cliente INT PRIMARY KEY AUTO_INCREMENT,
        rut VARCHAR(12) UNIQUE NOT NULL,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100),
        telefono VARCHAR(20),
        direccion VARCHAR(200),
        ciudad_id INT,
        estado VARCHAR(20) DEFAULT 'activo',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // --- Tablas con FK de primer nivel ---
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS funcionalidades (
        id_funcionalidad INT PRIMARY KEY AUTO_INCREMENT,
        id_modulo INT NOT NULL,
        nombre VARCHAR(100) NOT NULL,
        codigo VARCHAR(50) NOT NULL,
        FOREIGN KEY (id_modulo) REFERENCES modulos(id_modulo)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id_usuario INT PRIMARY KEY AUTO_INCREMENT,
        rut VARCHAR(12) UNIQUE NOT NULL,
        nombre VARCHAR(100) NOT NULL,
        apellido VARCHAR(100) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        id_perfil INT NOT NULL,
        id_supervisor INT NULL,
        ultimo_acceso TIMESTAMP NULL,
        estado VARCHAR(20) DEFAULT 'activo',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_perfil) REFERENCES perfiles(id_perfil),
        FOREIGN KEY (id_supervisor) REFERENCES usuarios(id_usuario)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS permisos_perfil (
        id_permiso INT PRIMARY KEY AUTO_INCREMENT,
        id_perfil INT NOT NULL,
        id_funcionalidad INT NOT NULL,
        habilitado TINYINT(1) DEFAULT 0,
        UNIQUE KEY uq_perfil_func (id_perfil, id_funcionalidad),
        FOREIGN KEY (id_perfil) REFERENCES perfiles(id_perfil),
        FOREIGN KEY (id_funcionalidad) REFERENCES funcionalidades(id_funcionalidad)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cotizaciones (
        id_cotizacion INT PRIMARY KEY AUTO_INCREMENT,
        id_cliente INT NOT NULL,
        monto DECIMAL(15,2),
        plazo INT,
        cuota DECIMAL(15,2),
        interes DECIMAL(15,2),
        estado VARCHAR(20) DEFAULT 'borrador',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_cliente) REFERENCES clientes(id_cliente)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS creditos (
        id_credito INT PRIMARY KEY AUTO_INCREMENT,
        id_cliente INT NOT NULL,
        monto DECIMAL(15,2),
        plazo INT,
        cuota DECIMAL(15,2),
        saldo_pendiente DECIMAL(15,2),
        estado VARCHAR(20) DEFAULT 'vigente',
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id_cliente) REFERENCES clientes(id_cliente)
      )
    `);

    console.log('✓ Tablas creadas');

    // --- Seed: Perfiles ---
    const [perfilesExistentes] = await connection.execute('SELECT COUNT(*) as total FROM perfiles');
    if (perfilesExistentes[0].total === 0) {
      await connection.execute(`
        INSERT INTO perfiles (nombre, descripcion) VALUES
        ('Administrador', 'Acceso total al sistema'),
        ('Gerente', 'Visibilidad global y reportes'),
        ('Supervisor', 'Gestión de ejecutivos de su equipo'),
        ('Ejecutivo Comercial', 'Gestión de sus propias operaciones'),
        ('Analista de Crédito', 'Análisis y evaluación de créditos'),
        ('Analista de Operaciones', 'Procesamiento de operaciones')
      `);
      console.log('✓ Perfiles creados');
    }

    // --- Seed: Módulos ---
    const [modulosExistentes] = await connection.execute('SELECT COUNT(*) as total FROM modulos');
    if (modulosExistentes[0].total === 0) {
      await connection.execute(`
        INSERT INTO modulos (nombre, descripcion, icono, ruta, orden) VALUES
        ('Usuarios', 'Gestión de usuarios, perfiles y permisos', 'bi-people-fill', '/usuarios/', 1),
        ('Clientes', 'Creación y mantención de clientes', 'bi-person-lines-fill', '/clientes/', 2),
        ('Cotizaciones', 'Simulación y gestión de cotizaciones', 'bi-calculator-fill', '/cotizaciones/', 3),
        ('Créditos', 'Administración de créditos automotrices', 'bi-credit-card-2-front-fill', '/creditos/', 4),
        ('Pagos', 'Registro y seguimiento de cuotas', 'bi-cash-stack', '/pagos/', 5),
        ('Vehículos', 'Catálogo de vehículos financiables', 'bi-car-front-fill', '/vehiculos/', 6)
      `);
      console.log('✓ Módulos creados');
    }

    // --- Seed: Funcionalidades ---
    const [funcExistentes] = await connection.execute('SELECT COUNT(*) as total FROM funcionalidades');
    if (funcExistentes[0].total === 0) {
      const [mods] = await connection.execute('SELECT id_modulo, nombre FROM modulos');
      const modMap = {};
      mods.forEach(m => { modMap[m.nombre] = m.id_modulo; });

      const funcionalidades = [
        // Usuarios
        [modMap['Usuarios'], 'Ver Usuarios', 'usuarios.ver'],
        [modMap['Usuarios'], 'Crear Usuarios', 'usuarios.crear'],
        [modMap['Usuarios'], 'Editar Usuarios', 'usuarios.editar'],
        [modMap['Usuarios'], 'Eliminar Usuarios', 'usuarios.eliminar'],
        [modMap['Usuarios'], 'Resetear Contraseñas', 'usuarios.reset_clave'],
        [modMap['Usuarios'], 'Gestionar Permisos', 'usuarios.permisos'],
        // Clientes
        [modMap['Clientes'], 'Ver Clientes', 'clientes.ver'],
        [modMap['Clientes'], 'Crear Clientes', 'clientes.crear'],
        [modMap['Clientes'], 'Editar Clientes', 'clientes.editar'],
        [modMap['Clientes'], 'Eliminar Clientes', 'clientes.eliminar'],
        // Cotizaciones
        [modMap['Cotizaciones'], 'Ver Cotizaciones', 'cotizaciones.ver'],
        [modMap['Cotizaciones'], 'Crear Cotizaciones', 'cotizaciones.crear'],
        [modMap['Cotizaciones'], 'Editar Cotizaciones', 'cotizaciones.editar'],
        [modMap['Cotizaciones'], 'Aprobar Cotizaciones', 'cotizaciones.aprobar'],
        // Créditos
        [modMap['Créditos'], 'Ver Créditos', 'creditos.ver'],
        [modMap['Créditos'], 'Crear Créditos', 'creditos.crear'],
        [modMap['Créditos'], 'Editar Créditos', 'creditos.editar'],
        [modMap['Créditos'], 'Aprobar Créditos', 'creditos.aprobar'],
        // Pagos
        [modMap['Pagos'], 'Ver Pagos', 'pagos.ver'],
        [modMap['Pagos'], 'Registrar Pagos', 'pagos.crear'],
        // Vehículos
        [modMap['Vehículos'], 'Ver Vehículos', 'vehiculos.ver'],
        [modMap['Vehículos'], 'Crear Vehículos', 'vehiculos.crear'],
        [modMap['Vehículos'], 'Editar Vehículos', 'vehiculos.editar'],
        [modMap['Vehículos'], 'Eliminar Vehículos', 'vehiculos.eliminar'],
      ];

      for (const [id_modulo, nombre, codigo] of funcionalidades) {
        await connection.execute(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?, ?, ?)',
          [id_modulo, nombre, codigo]
        );
      }
      console.log('✓ Funcionalidades creadas');
    }

    // --- Seed: Permisos para Administrador (todos habilitados) ---
    const [permisosExistentes] = await connection.execute('SELECT COUNT(*) as total FROM permisos_perfil');
    if (permisosExistentes[0].total === 0) {
      const [perfiles] = await connection.execute('SELECT id_perfil, nombre FROM perfiles');
      const [funcs] = await connection.execute('SELECT id_funcionalidad, codigo FROM funcionalidades');

      for (const perfil of perfiles) {
        for (const func of funcs) {
          const esAdmin = perfil.nombre === 'Administrador';
          await connection.execute(
            'INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?, ?, ?)',
            [perfil.id_perfil, func.id_funcionalidad, esAdmin ? 1 : 0]
          );
        }
      }
      console.log('✓ Permisos creados (Administrador con acceso total)');
    }

    // --- Seed: Usuario Administrador ---
    const [usuariosExistentes] = await connection.execute('SELECT COUNT(*) as total FROM usuarios');
    if (usuariosExistentes[0].total === 0) {
      const [adminPerfil] = await connection.execute("SELECT id_perfil FROM perfiles WHERE nombre = 'Administrador'");
      const passwordHash = await bcrypt.hash('Admin123!', 10);

      await connection.execute(`
        INSERT INTO usuarios (rut, nombre, apellido, email, password_hash, id_perfil, estado)
        VALUES (?, ?, ?, ?, ?, ?, 'activo')
      `, ['11111111-1', 'Admin', 'Sistema', 'admin@sistema.cl', passwordHash, adminPerfil[0].id_perfil]);

      console.log('✓ Usuario administrador creado');
      console.log('  Email: admin@sistema.cl');
      console.log('  Clave: Admin123!');
    }

    await connection.end();
    console.log('\n✓ ¡Base de datos lista!');
    process.exit(0);
  } catch (error) {
    console.error('✗ Error:', error.message);
    if (connection) await connection.end();
    process.exit(1);
  }
}

setupDatabase();
