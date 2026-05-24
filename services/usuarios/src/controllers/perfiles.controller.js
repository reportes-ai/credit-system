const pool = require('../../../../shared/config/database');

// Migración: insertar módulos Tesorería, CRM, Cobranza, Reportería si no existen
(async () => {
  try {
    const nuevos = [
      { nombre: 'Tesorería',  icono: 'bi-safe2',        ruta: '/tesoreria/', descripcion: 'Gestión de pagos y flujos de caja', orden: 20 },
      { nombre: 'CRM',        icono: 'bi-people',        ruta: '/crm/',        descripcion: 'Gestión de relaciones con clientes', orden: 21 },
      { nombre: 'Cobranza',   icono: 'bi-bell',          ruta: '/cobranza/',   descripcion: 'Seguimiento y gestión de cobros', orden: 22 },
      { nombre: 'Reportería', icono: 'bi-bar-chart-line', ruta: '/reporteria/', descripcion: 'Informes y reportes del sistema', orden: 23 },
      { nombre: 'Política',   icono: 'bi-shield-check',  ruta: '/politica/',   descripcion: 'Política de crédito AutoFácil', orden: 24 },
    ];
    for (const m of nuevos) {
      const [rows] = await pool.query('SELECT id_modulo FROM modulos WHERE nombre = ?', [m.nombre]);
      let id_modulo;
      if (rows.length === 0) {
        const [ins] = await pool.query(
          `INSERT INTO modulos (nombre, descripcion, icono, ruta, orden, estado)
           VALUES (?, ?, ?, ?, ?, 'activo')`,
          [m.nombre, m.descripcion, m.icono, m.ruta, m.orden]
        );
        id_modulo = ins.insertId;
        // Funcionalidad base
        const [insF] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo)
           VALUES (?, ?, ?)`,
          [id_modulo, `Ver ${m.nombre}`, `${m.nombre.toLowerCase().replace(/\s/g,'_')}_ver`]
        );
        // Permisos: otorgar a todos los perfiles activos
        const [perfiles] = await pool.query('SELECT id_perfil FROM perfiles');
        for (const p of perfiles) {
          await pool.query(
            `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
             VALUES (?, ?, 1)`,
            [p.id_perfil, insF.insertId]
          );
        }
      }
    }
    // Mover Pagos dentro de Tesorería: actualizar ruta si existe y actualizar orden
    await pool.query(`UPDATE modulos SET orden = 99, estado = 'inactivo' WHERE nombre = 'Pagos' AND ruta NOT LIKE '/tesoreria/%'`);
  } catch (e) {
    console.error('[modulos migration]', e.message);
  }
})();

/* ─── Migración: agregar funcionalidades faltantes en todos los módulos ──── */
(async () => {
  try {
    // [nombre_modulo, nombre_funcionalidad, codigo, habilitado_default(0/1)]
    const nuevasFuncs = [
      // Clientes
      ['Clientes',     'Ver Antecedentes Laborales',      'clientes_antecedentes',       1],
      ['Clientes',     'Ver Información Comercial',        'clientes_info_comercial',     1],
      // Créditos
      ['Créditos',     'Cargar Documentos Respaldo',       'creditos_cargar_doc',         1],
      ['Créditos',     'Validar Documentos AF',            'creditos_validar_doc_af',     0],
      ['Créditos',     'Pagar Cuotas',                     'creditos_pagar_cuotas',       0],
      ['Créditos',     'Reversar Pagos',                   'creditos_reversar_pagos',     0],
      ['Créditos',     'Condonar Intereses',               'creditos_condonar_intereses', 0],
      ['Créditos',     'Condonar Gastos de Cobranza',      'creditos_condonar_gastos',    0],
      ['Créditos',     'Ver Auditoría de Crédito',         'creditos_auditoria',          0],
      // Tesorería
      ['Tesorería',    'Gestionar Cajas',                  'tesoreria_cajas',             0],
      ['Tesorería',    'Cierre de Caja',                   'tesoreria_cierre_caja',       0],
      // Mantenedores
      ['Mantenedores', 'Gestionar Vehículos',              'mantenedores_vehiculos',      0],
      ['Mantenedores', 'Gestionar Dealers',                'mantenedores_dealers',        0],
      ['Mantenedores', 'Gestionar Parámetros de Crédito',  'mantenedores_parametros',     0],
      ['Mantenedores', 'Gestionar Tipos de Documento',     'mantenedores_tipos_doc',      0],
      ['Mantenedores', 'Gestionar Plantillas',             'mantenedores_plantillas',     0],
      ['Mantenedores', 'Gestionar Comunas',                'mantenedores_comunas',        0],
      ['Mantenedores', 'Gestionar Pagarés',                'mantenedores_pagares',        0],
      // Cotizaciones
      ['Cotizaciones', 'Descargar Cotización',             'cotizaciones_descargar',      1],
      // CRM
      ['CRM',          'Crear Actividad CRM',              'crm_crear',                   0],
      ['CRM',          'Editar Actividad CRM',             'crm_editar',                  0],
      // Cobranza
      ['Cobranza',     'Gestionar Cobranza',               'cobranza_gestionar',          0],
      // Reportería
      ['Reportería',   'Exportar Reportes',                'reporteria_exportar',         0],
    ];

    const [perfiles] = await pool.query('SELECT id_perfil FROM perfiles');

    for (const [modNombre, funNombre, funCodigo, habDef] of nuevasFuncs) {
      // Buscar módulo (nombre exacto o con variante sin acento por seguridad)
      const [[mod]] = await pool.query(
        'SELECT id_modulo FROM modulos WHERE nombre = ? AND estado = \'activo\'',
        [modNombre]
      );
      if (!mod) continue;

      // Insertar funcionalidad si no existe (verificar por código)
      const [[existente]] = await pool.query(
        'SELECT id_funcionalidad FROM funcionalidades WHERE codigo = ?',
        [funCodigo]
      );
      let id_func;
      if (existente) {
        id_func = existente.id_funcionalidad;
      } else {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)',
          [mod.id_modulo, funNombre, funCodigo]
        );
        id_func = ins.insertId;
      }

      // Asignar a todos los perfiles (INSERT IGNORE para no sobreescribir config existente)
      for (const p of perfiles) {
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
           VALUES (?,?,?)`,
          [p.id_perfil, id_func, habDef]
        );
      }
    }
  } catch (e) {
    console.error('[funcionalidades migration]', e.message);
  }
})();

/* ─── Migración v2: módulos y funcionalidades completos ──────────────────── */
(async () => {
  try {
    // 1) Asegurar módulo Usuarios
    const [uMod] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre = 'Usuarios'");
    if (uMod.length === 0) {
      await pool.query(
        `INSERT INTO modulos (nombre, descripcion, icono, ruta, orden, estado)
         VALUES ('Usuarios','Gestión de usuarios, perfiles y permisos','bi-people-fill','/usuarios/',5,'activo')`
      );
    }

    // 2) Nuevas funcionalidades completas (todos los módulos construidos)
    const nuevas = [
      // ── Créditos ────────────────────────────────────────────
      ['Créditos', 'Ver Respaldos de Crédito',      'creditos_ver_respaldos',       1],
      ['Créditos', 'Validación de Firma',            'creditos_validacion_firma',    0],
      ['Créditos', 'Revisar Crédito (Analista)',     'creditos_revisar',             0],
      // ── Tesorería ───────────────────────────────────────────
      ['Tesorería', 'Ver Cajas',                     'tesoreria_ver_cajas',          1],
      ['Tesorería', 'Cuentas Transitorias',          'tesoreria_cuentas_transitorias', 0],
      // ── Cobranza ────────────────────────────────────────────
      ['Cobranza', 'Ver Pre-judicial',               'cobranza_prejudicial',         1],
      ['Cobranza', 'Ver Judicial',                   'cobranza_judicial',            1],
      ['Cobranza', 'Ver Mis Cobranzas',              'cobranza_mis',                 1],
      ['Cobranza', 'Ver Provisiones de Mora',        'cobranza_provisiones',         0],
      // ── CRM ─────────────────────────────────────────────────
      ['CRM', 'Ver Gestiones CRM',                   'crm_gestiones',                1],
      ['CRM', 'Ver Estadísticas CRM',                'crm_estadisticas',             0],
      // ── Mantenedores ────────────────────────────────────────
      ['Mantenedores', 'Gestionar Cuentas Bancarias','mantenedores_cuentas_bancarias',0],
      ['Mantenedores', 'Gestionar Tasas',            'mantenedores_tasas',           0],
      ['Mantenedores', 'Gestionar Factores de Seguro','mantenedores_factores_seguro',0],
      ['Mantenedores', 'Gestionar UF',               'mantenedores_uf',              0],
      // ── Usuarios ────────────────────────────────────────────
      ['Usuarios', 'Gestionar Usuarios',             'usuarios_gestionar',           0],
      ['Usuarios', 'Gestionar Perfiles y Permisos',  'usuarios_perfiles',            0],
      ['Usuarios', 'Cambiar Mi Contraseña',          'usuarios_contrasena',          1],
    ];

    const [perfiles] = await pool.query('SELECT id_perfil FROM perfiles');

    for (const [modNombre, funNombre, funCodigo, habDef] of nuevas) {
      const [[mod]] = await pool.query(
        "SELECT id_modulo FROM modulos WHERE nombre = ? AND estado = 'activo'",
        [modNombre]
      );
      if (!mod) continue;

      const [[existente]] = await pool.query(
        'SELECT id_funcionalidad FROM funcionalidades WHERE codigo = ?', [funCodigo]
      );
      let id_func;
      if (existente) {
        id_func = existente.id_funcionalidad;
      } else {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)',
          [mod.id_modulo, funNombre, funCodigo]
        );
        id_func = ins.insertId;
      }

      for (const p of perfiles) {
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
           VALUES (?,?,?)`,
          [p.id_perfil, id_func, habDef]
        );
      }
    }

    // 3) Administrador: habilitar TODAS las funcionalidades
    const [[admin]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre = 'Administrador' LIMIT 1");
    if (admin) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [admin.id_perfil]
      );
    }

    console.log('✓ Perfiles v2: funcionalidades actualizadas, Administrador con acceso total');
  } catch (e) {
    console.error('[perfiles migration v2]', e.message);
  }
})();

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
