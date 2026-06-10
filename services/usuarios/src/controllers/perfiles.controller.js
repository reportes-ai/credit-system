const pool = require('../../../../shared/config/database');
const { limpiarCachePermisos } = require('../../../../shared/middleware/permisos');

// Migración: insertar módulos Tesorería, CRM, Cobranza, Reportería si no existen
(async () => {
  try {
    const nuevos = [
      { nombre: 'Tesorería',  icono: 'bi-safe2',        ruta: '/tesoreria/', descripcion: 'Gestión de pagos y flujos de caja', orden: 20 },
      { nombre: 'CRM',        icono: 'bi-people',        ruta: '/crm/',        descripcion: 'Gestión de relaciones con clientes', orden: 21 },
      { nombre: 'Cobranza',   icono: 'bi-bell',          ruta: '/cobranza/',   descripcion: 'Seguimiento y gestión de cobros', orden: 22 },
      { nombre: 'Reportería', icono: 'bi-bar-chart-line', ruta: '/reporteria/', descripcion: 'Informes y reportes del sistema', orden: 23 },
      { nombre: 'Política',   icono: 'bi-shield-check',  ruta: '/politica/',   descripcion: 'Política de crédito AutoFácil', orden: 24 },
      { nombre: 'Cartas de Aprobación', icono: 'bi-envelope-check', ruta: '/cartas-aprobacion/', descripcion: 'Generación e historial de cartas de aprobación de crédito', orden: 25 },
      { nombre: 'Comisión Ejecutivos', icono: 'bi-cash-coin', ruta: '/comisiones/', descripcion: 'Cálculo, revisión y aprobación de comisiones mensuales por ejecutivo comercial', orden: 26 },
      { nombre: 'Carga Masiva',       icono: 'bi-cloud-upload', ruta: '/carga-masiva/', descripcion: 'Importación masiva de operaciones desde archivo Excel. Solo Administrador.', orden: 27 },
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

/* ─── Migración v3: nuevos módulos y funcionalidades ─────────────────────── */
(async () => {
  try {
    const [perfiles] = await pool.query('SELECT id_perfil FROM perfiles');
    const [[admin]]  = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");

    // Helper: insertar funcionalidad si no existe y asignarla a todos los perfiles
    async function addFunc(modNombre, funNombre, funCodigo, habDef = 0) {
      const [[mod]] = await pool.query(
        "SELECT id_modulo FROM modulos WHERE nombre=? AND estado='activo'", [modNombre]
      );
      if (!mod) return;
      const [[ex]] = await pool.query(
        'SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [funCodigo]
      );
      let id_func;
      if (ex) {
        id_func = ex.id_funcionalidad;
      } else {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)',
          [mod.id_modulo, funNombre, funCodigo]
        );
        id_func = ins.insertId;
      }
      for (const p of perfiles) {
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)`,
          [p.id_perfil, id_func, habDef]
        );
      }
      return id_func;
    }

    // ── CRM: Campañas de Outbound ──────────────────────────────────────────
    await addFunc('CRM', 'Ver Campañas Outbound',        'crm_campanas_ver',        1);
    await addFunc('CRM', 'Crear Campaña Outbound',       'crm_campanas_crear',      0);
    await addFunc('CRM', 'Gestionar Campañas Outbound',  'crm_campanas_gestionar',  0);
    await addFunc('CRM', 'Ver Resultados de Campaña',    'crm_campanas_resultados', 0);

    // ── Usuarios: Seguridad ────────────────────────────────────────────────
    await addFunc('Usuarios', 'Gestionar Configuración de Seguridad', 'usuarios_seguridad', 0);

    // ── Créditos: nuevas acciones ──────────────────────────────────────────
    await addFunc('Créditos', 'Ver Documentos AF',       'creditos_documentos_af',  0);

    // ── Administrador: habilitar TODO lo nuevo ─────────────────────────────
    if (admin) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [admin.id_perfil]
      );
    }

    console.log('✓ Perfiles v3: nuevos módulos CRM-Campañas y Usuarios-Seguridad agregados');
  } catch (e) {
    console.error('[perfiles migration v3]', e.message);
  }
})();

/* ─── Migración v4: nombres alineados con la app ─────────────────────────── */
(async () => {
  try {
    // 1) Actualizar nombres para que coincidan exactamente con las páginas/cards
    const renombrar = [
      // Tesorería
      ['tesoreria_cajas',            'Administración de Cajas'],
      ['tesoreria_ver_cajas',        'Caja'],
      // CRM
      ['crm_gestiones',              'Gestiones de Contacto'],
      ['crm_estadisticas',           'Estadísticas CRM'],
      ['crm_campanas_ver',           'Campañas de Outbound'],
      ['crm_campanas_crear',         'Creación de Campaña'],
      ['crm_campanas_gestionar',     'Gestión de Campaña'],
      ['crm_campanas_resultados',    'Resultados de Campaña'],
      ['crm_crear',                  'Registrar Gestión CRM'],
      ['crm_editar',                 'Editar Gestión CRM'],
      // Cobranza
      ['cobranza_prejudicial',       'Pre-judicial'],
      ['cobranza_judicial',          'Judicial'],
      ['cobranza_mis',               'Reportería Cobranzas'],
      // Mantenedores
      ['mantenedores_vehiculos',     'Vehículos'],
      ['mantenedores_dealers',       'Dealers'],
      ['mantenedores_parametros',    'Parámetros Crédito'],
      ['mantenedores_tipos_doc',     'Tipos de Documento'],
      ['mantenedores_plantillas',    'Plantillas de Documentos'],
      ['mantenedores_comunas',       'Comunas'],
      ['mantenedores_pagares',       'Pagarés AutoFácil'],
      ['mantenedores_cuentas_bancarias', 'Cuentas Bancarias'],
      ['mantenedores_tasas',         'Tasas de Interés'],
      ['mantenedores_uf',            'Valores UF'],
      ['mantenedores_factores_seguro','Factores Seguro'],
      // Créditos
      ['creditos_revisar',           'Revisión de Crédito'],
      ['creditos_ver_respaldos',     'Carga de Respaldos'],
      ['creditos_cargar_doc',        'Documentos del Crédito'],
      ['creditos_documentos_af',     'Carga Documentos AutoFácil'],
      ['creditos_validar_doc_af',    'Validación de Documentos AF'],
      ['creditos_auditoria',         'Auditoría de Crédito'],
      ['creditos_pagar_cuotas',      'Pago de Cuotas'],
      // Usuarios
      ['usuarios_seguridad',         'Seguridad'],
      ['usuarios_perfiles',          'Perfiles y Permisos'],
    ];

    for (const [codigo, nombre] of renombrar) {
      await pool.query(
        'UPDATE funcionalidades SET nombre = ? WHERE codigo = ?',
        [nombre, codigo]
      );
    }

    // 2) Agregar funcionalidades faltantes (páginas que no tenían código propio)
    async function addFunc4(modNombre, funNombre, funCodigo, habDef = 0) {
      const [[mod]] = await pool.query(
        "SELECT id_modulo FROM modulos WHERE nombre=? AND estado='activo'", [modNombre]
      );
      if (!mod) return;
      const [[ex]] = await pool.query(
        'SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [funCodigo]
      );
      if (ex) return; // ya existe
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)',
        [mod.id_modulo, funNombre, funCodigo]
      );
      const id_func = ins.insertId;
      const [perfiles] = await pool.query('SELECT id_perfil FROM perfiles');
      for (const p of perfiles) {
        await pool.query(
          'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)',
          [p.id_perfil, id_func, habDef]
        );
      }
    }

    // Créditos — páginas que faltaban
    await addFunc4('Créditos', 'Documentos del Crédito',     'creditos_documentos',      1);
    // Clientes — submodulos con nombre de app
    await addFunc4('Clientes', 'Antecedentes Laborales',     'clientes_antecedentes_lab', 1);
    await addFunc4('Clientes', 'Información Comercial',      'clientes_info_comercial2',  1);
    // Cobranza — reportería específica (nueva ruta)
    await addFunc4('Cobranza', 'Reportería Cobranzas',       'cobranza_reporteria',       0);

    // 3) Administrador: habilitar TODAS las funcionalidades (incluyendo nuevas)
    const [[admin]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    if (admin) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [admin.id_perfil]
      );
    }

    console.log('✓ Perfiles v4: nombres de funcionalidades alineados con la app');
  } catch (e) {
    console.error('[perfiles migration v4]', e.message);
  }
})();

/* ─── Migración v5: funcionalidades granulares de Cartas de Aprobación ──── */
(async () => {
  try {
    const [perfiles] = await pool.query('SELECT id_perfil FROM perfiles');
    const [[admin]]  = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");

    async function addFuncV5(modNombre, funNombre, funCodigo, habDef = 0) {
      const [[mod]] = await pool.query(
        "SELECT id_modulo FROM modulos WHERE nombre=? AND estado='activo'", [modNombre]
      );
      if (!mod) return;
      const [[ex]] = await pool.query(
        'SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [funCodigo]
      );
      let id_func;
      if (ex) {
        id_func = ex.id_funcionalidad;
      } else {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)',
          [mod.id_modulo, funNombre, funCodigo]
        );
        id_func = ins.insertId;
      }
      for (const p of perfiles) {
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)`,
          [p.id_perfil, id_func, habDef]
        );
      }
    }

    const MOD = 'Cartas de Aprobación';
    await addFuncV5(MOD, 'Generador de Carta',          'cartas_generador',         1);
    await addFuncV5(MOD, 'Revisión de Carta',            'cartas_revision',          1);
    await addFuncV5(MOD, 'Impresión de Carta',           'cartas_impresion',         1);
    await addFuncV5(MOD, 'Informes de Cartas',           'cartas_informes',          1);
    await addFuncV5(MOD, 'Emisión de Cartolas',          'cartas_cartolas_emision',  1);
    await addFuncV5(MOD, 'Cartolas Enviadas',            'cartas_cartolas_enviadas', 1);
    await addFuncV5(MOD, 'Mantención Usuarios Cartas',   'cartas_manten_usuarios',   0);
    await addFuncV5(MOD, 'Parámetros Participación',     'cartas_params_particip',   0);
    await addFuncV5(MOD, 'Mantenedores Cartas',          'cartas_mantenedores',      0);

    // Administrador: habilitar TODAS (incluye las nuevas)
    if (admin) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [admin.id_perfil]
      );
    }

    console.log('✓ Perfiles v5: funcionalidades de Cartas de Aprobación agregadas');
  } catch (e) {
    console.error('[perfiles migration v5]', e.message);
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

    // ── Garantizar que "Ver Dashboard" aparece siempre en el grid de permisos ──
    // Busca o crea la funcionalidad ver_dashboard y la inyecta en el módulo correcto
    try {
      let [[fd]] = await pool.query("SELECT f.id_funcionalidad, f.id_modulo FROM funcionalidades f WHERE f.codigo='ver_dashboard'");
      if (!fd) {
        // Buscar cualquier módulo dashboard (activo o no)
        let [[modDash]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta LIKE '%dashboard%' LIMIT 1");
        if (!modDash) {
          // Crear un módulo Sistema si no hay nada
          const [ins] = await pool.query(
            "INSERT INTO modulos (nombre, icono, ruta, orden, estado) VALUES ('Sistema','bi-gear','/sistema/',99,'activo')"
          );
          modDash = { id_modulo: ins.insertId };
        }
        const [ins] = await pool.query(
          "INSERT INTO funcionalidades (id_modulo, nombre, codigo, icono) VALUES (?,?,?,?)",
          [modDash.id_modulo, 'Ver Dashboard', 'ver_dashboard', 'bi-bar-chart-line']
        );
        fd = { id_funcionalidad: ins.insertId, id_modulo: modDash.id_modulo };
        // Dar acceso a Admin y Gerente por defecto
        const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
        for (const p of perfiles) {
          const hab = ['Administrador','Gerente'].includes(p.nombre) ? 1 : 0;
          await pool.query(
            'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)',
            [p.id_perfil, fd.id_funcionalidad, hab]
          );
        }
      }
      // Inyectar en el grupo correspondiente si no está ya en agrupado
      const yaEsta = agrupado.some(g => g.funcionalidades.some(f => f.codigo === 'ver_dashboard'));
      if (!yaEsta) {
        // Buscar nombre del módulo al que pertenece
        const [[modInfo]] = await pool.query("SELECT nombre, icono FROM modulos WHERE id_modulo=?", [fd.id_modulo]);
        let grupo = agrupado.find(g => g.id_modulo === fd.id_modulo);
        if (!grupo) {
          grupo = { id_modulo: fd.id_modulo, nombre: modInfo?.nombre || 'Dashboard', icono: modInfo?.icono || 'bi-speedometer', funcionalidades: [] };
          agrupado.push(grupo);
        }
        grupo.funcionalidades.push({ id_funcionalidad: fd.id_funcionalidad, nombre: 'Ver Dashboard', codigo: 'ver_dashboard' });
      }
    } catch(e) { console.error('[ver_dashboard inject]', e.message); }

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
    limpiarCachePermisos();   // efecto inmediato en las APIs

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
    console.error('[reordenarModulos]', error.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── CREATE PERFIL ──────────────────────────────────────────────────────── */
const createPerfil = async (req, res) => {
  try {
    const { nombre, descripcion = null } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ success: false, data: null, error: 'El nombre es requerido' });

    // Verificar que no exista
    const [[ex]] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre = ?', [nombre.trim()]);
    if (ex) return res.status(400).json({ success: false, data: null, error: 'Ya existe un perfil con ese nombre' });

    const [r] = await pool.query(
      'INSERT INTO perfiles (nombre, descripcion) VALUES (?, ?)',
      [nombre.trim(), descripcion || null]
    );
    const id_perfil = r.insertId;

    // Copiar todas las funcionalidades con habilitado=0
    const [funcs] = await pool.query('SELECT id_funcionalidad FROM funcionalidades');
    for (const f of funcs) {
      await pool.query(
        'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,0)',
        [id_perfil, f.id_funcionalidad]
      );
    }

    const [[perfil]] = await pool.query('SELECT * FROM perfiles WHERE id_perfil = ?', [id_perfil]);
    res.status(201).json({ success: true, data: perfil, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── UPDATE PERFIL ──────────────────────────────────────────────────────── */
const updatePerfil = async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, descripcion = null } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ success: false, data: null, error: 'El nombre es requerido' });

    const [[perfil]] = await pool.query('SELECT nombre FROM perfiles WHERE id_perfil = ?', [id]);
    if (!perfil) return res.status(404).json({ success: false, data: null, error: 'Perfil no encontrado' });
    if (perfil.nombre === 'Administrador') return res.status(400).json({ success: false, data: null, error: 'No se puede renombrar el perfil Administrador' });

    // Verificar que no exista otro con el mismo nombre
    const [[dup]] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre = ? AND id_perfil != ?', [nombre.trim(), id]);
    if (dup) return res.status(400).json({ success: false, data: null, error: 'Ya existe un perfil con ese nombre' });

    await pool.query('UPDATE perfiles SET nombre = ?, descripcion = ? WHERE id_perfil = ?', [nombre.trim(), descripcion || null, id]);
    const [[updated]] = await pool.query('SELECT * FROM perfiles WHERE id_perfil = ?', [id]);
    res.json({ success: true, data: updated, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ─── DELETE PERFIL ──────────────────────────────────────────────────────── */
const deletePerfil = async (req, res) => {
  try {
    const { id } = req.params;

    // Proteger perfil Administrador
    const [[perfil]] = await pool.query('SELECT nombre FROM perfiles WHERE id_perfil = ?', [id]);
    if (!perfil) return res.status(404).json({ success: false, data: null, error: 'Perfil no encontrado' });
    if (perfil.nombre === 'Administrador') return res.status(400).json({ success: false, data: null, error: 'No se puede eliminar el perfil Administrador' });

    // Verificar que no haya usuarios con este perfil
    const [[usos]] = await pool.query('SELECT COUNT(*) AS cnt FROM usuarios WHERE id_perfil = ?', [id]);
    if (usos.cnt > 0) return res.status(400).json({ success: false, data: null, error: `No se puede eliminar: ${usos.cnt} usuario(s) tienen este perfil` });

    // Eliminar permisos y perfil
    await pool.query('DELETE FROM permisos_perfil WHERE id_perfil = ?', [id]);
    await pool.query('DELETE FROM perfiles WHERE id_perfil = ?', [id]);

    res.json({ success: true, data: { eliminado: id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── Usuarios por perfil (con indicadores de override) ─────────── */
const getUsuariosByPerfil = async (req, res) => {
  try {
    const { id } = req.params;

    // Permisos base del perfil
    const [baseRows] = await pool.query(
      'SELECT id_funcionalidad, habilitado FROM permisos_perfil WHERE id_perfil = ?', [id]
    );
    const base = {};
    baseRows.forEach(p => { base[p.id_funcionalidad] = p.habilitado === 1; });

    // Usuarios activos con este perfil
    const [users] = await pool.query(
      `SELECT id_usuario, nombre, apellido, email, estado
       FROM usuarios WHERE id_perfil = ? AND estado = 'activo'
       ORDER BY nombre, apellido`,
      [id]
    );

    // Para cada usuario, calcular cuántos permisos extra/faltan
    const result = [];
    for (const u of users) {
      const [ovRows] = await pool.query(
        'SELECT id_funcionalidad, habilitado FROM permisos_usuario WHERE id_usuario = ?',
        [u.id_usuario]
      );
      let extra = 0, missing = 0;
      for (const ov of ovRows) {
        const profileHas = base[ov.id_funcionalidad] || false;
        const userHas = ov.habilitado === 1;
        if (userHas && !profileHas) extra++;
        if (!userHas && profileHas) missing++;
      }
      result.push({ ...u, extra_count: extra, missing_count: missing });
    }

    res.json({ success: true, data: result, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── Migración v6: permisos de edición de créditos broker ───────────────── */
(async () => {
  try {
    const [[admin]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");

    async function addFuncV6(modNombre, funNombre, funCodigo) {
      const [[mod]] = await pool.query(
        "SELECT id_modulo FROM modulos WHERE nombre=? AND estado='activo'", [modNombre]
      );
      if (!mod) return null;
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [funCodigo]);
      if (ex) return ex.id_funcionalidad;
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)',
        [mod.id_modulo, funNombre, funCodigo]
      );
      return ins.insertId;
    }

    // Funcionalidad: Editar Crédito Broker (Analista, Supervisor, Gerente, Admin)
    const idEditBroker = await addFuncV6('Créditos', 'Editar Crédito Broker', 'creditos_editar_broker');
    // Funcionalidad: Modificar Crédito Otorgado (solo Gerente y Admin)
    const idModOtorg   = await addFuncV6('Créditos', 'Modificar Crédito Otorgado', 'creditos_modificar_otorgado');

    if (idEditBroker) {
      // Habilitar para Analista de Crédito, Supervisor, Gerente, Administrador
      const habilitados = ['Administrador','Gerente','Supervisor','Analista de Crédito'];
      const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
      for (const p of perfiles) {
        const hab = habilitados.includes(p.nombre) ? 1 : 0;
        await pool.query(
          `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
           VALUES (?,?,?) ON DUPLICATE KEY UPDATE habilitado=VALUES(habilitado)`,
          [p.id_perfil, idEditBroker, hab]
        );
      }
    }

    if (idModOtorg) {
      // Habilitar solo para Gerente y Administrador
      const habilitados = ['Administrador','Gerente'];
      const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
      for (const p of perfiles) {
        const hab = habilitados.includes(p.nombre) ? 1 : 0;
        await pool.query(
          `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
           VALUES (?,?,?) ON DUPLICATE KEY UPDATE habilitado=VALUES(habilitado)`,
          [p.id_perfil, idModOtorg, hab]
        );
      }
    }

    console.log('✓ Perfiles v6: permisos edición créditos broker configurados');
  } catch (e) {
    console.error('[perfiles migration v6]', e.message);
  }
})();

/* ─── Migración v7: workflow brokerage completo ───────────────────────────── */
(async () => {
  try {
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
    const [[admin]]  = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");

    async function addFuncV7(modNombre, funNombre, funCodigo, habPorPerfil = {}) {
      const [[mod]] = await pool.query(
        "SELECT id_modulo FROM modulos WHERE nombre=? AND estado='activo'", [modNombre]
      );
      if (!mod) return;
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [funCodigo]);
      let id_func;
      if (ex) {
        id_func = ex.id_funcionalidad;
      } else {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)',
          [mod.id_modulo, funNombre, funCodigo]
        );
        id_func = ins.insertId;
      }
      for (const p of perfiles) {
        const hab = habPorPerfil[p.nombre] !== undefined ? (habPorPerfil[p.nombre] ? 1 : 0) : 0;
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)`,
          [p.id_perfil, id_func, hab]
        );
      }
    }

    // Módulo Créditos — Brokerage
    await addFuncV7('Créditos', 'Cargar Fundantes Brokerage',     'creditos_fundantes_cargar',   { 'Administrador':1,'Gerente':1,'Supervisor':1,'Analista de Crédito':1,'Ejecutivo':1,'Ejecutivo Comercial':1 });
    await addFuncV7('Créditos', 'Validar Fundantes Brokerage',    'creditos_fundantes_validar',  { 'Administrador':1,'Gerente':1,'Supervisor':1,'Analista de Crédito':1 });
    await addFuncV7('Créditos', 'Liberar Pago Brokerage',         'creditos_liberar_pago',       { 'Administrador':1,'Gerente':1,'Supervisor':1,'Analista de Crédito':1 });
    await addFuncV7('Créditos', 'Marcar No Otorgado Brokerage',   'creditos_no_otorgado',        { 'Administrador':1,'Gerente':1,'Supervisor':1,'Analista de Crédito':1 });
    await addFuncV7('Créditos', 'Ver Fundantes Brokerage',        'creditos_fundantes_ver',      { 'Administrador':1,'Gerente':1,'Supervisor':1,'Analista de Crédito':1,'Ejecutivo':1,'Ejecutivo Comercial':1 });

    // Módulo Tesorería — Brokerage
    await addFuncV7('Tesorería', 'Panel Brokerage Tesorería',     'tesoreria_brokerage_ver',     { 'Administrador':1,'Gerente':1,'Supervisor':1,'Tesorería':1,'Tesoreria':1 });
    await addFuncV7('Tesorería', 'Registrar Facturas Brokerage',  'tesoreria_brokerage_facturas',{ 'Administrador':1,'Gerente':1,'Tesorería':1,'Tesoreria':1 });
    await addFuncV7('Tesorería', 'Registrar Pagos Brokerage',     'tesoreria_brokerage_pagos',   { 'Administrador':1,'Gerente':1,'Tesorería':1,'Tesoreria':1 });

    // Administrador: habilitar TODAS
    if (admin) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [admin.id_perfil]
      );
    }
    console.log('✓ Perfiles v7: funcionalidades brokerage workflow agregadas');
  } catch (e) {
    console.error('[perfiles migration v7]', e.message);
  }
})();

/* ─── Migración v8: funcionalidades faltantes detectadas ─────────────────── */
(async () => {
  try {
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
    const [[admin]]  = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");

    async function addFuncV8(modNombre, funNombre, funCodigo, habPorPerfil = {}) {
      const [[mod]] = await pool.query(
        "SELECT id_modulo FROM modulos WHERE nombre=? AND estado='activo'", [modNombre]
      );
      if (!mod) return;
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [funCodigo]);
      let id_func;
      if (ex) {
        id_func = ex.id_funcionalidad;
      } else {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)',
          [mod.id_modulo, funNombre, funCodigo]
        );
        id_func = ins.insertId;
      }
      for (const p of perfiles) {
        const hab = habPorPerfil[p.nombre] !== undefined ? (habPorPerfil[p.nombre] ? 1 : 0) : 0;
        await pool.query(
          'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)',
          [p.id_perfil, id_func, hab]
        );
      }
    }

    // Asegurar módulo Simulador (buscar por ruta para no crear duplicado)
    const [simMod] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/simulador/'");
    if (simMod.length === 0) {
      const [ins] = await pool.query(
        `INSERT INTO modulos (nombre, descripcion, icono, ruta, orden, estado)
         VALUES ('Simulador','Simulador de crédito automotriz','bi-calculator','/simulador/',28,'activo')`
      );
      await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)',
        [ins.insertId, 'Ver Simulador', 'simulador_ver']
      );
    }

    // Mantenedores — páginas sin permiso
    await addFuncV8('Mantenedores', 'Parques',              'mantenedores_parques',              { Administrador:1, Gerente:1 });
    await addFuncV8('Mantenedores', 'Financieras',          'mantenedores_financieras',          { Administrador:1, Gerente:1 });
    await addFuncV8('Mantenedores', 'Comisiones Seguro',    'mantenedores_comisiones_seguro',    { Administrador:1 });
    await addFuncV8('Mantenedores', 'BD Operaciones',       'mantenedores_bd_operaciones',       { Administrador:1 });
    await addFuncV8('Mantenedores', 'BD Clientes',          'mantenedores_bd_clientes',          { Administrador:1 });
    await addFuncV8('Mantenedores', 'Flujo Brokerage',      'mantenedores_flujo_brokerage',      { Administrador:1, Gerente:1, Supervisor:1 });
    await addFuncV8('Mantenedores', 'Broker Validaciones',  'mantenedores_broker_validaciones',  { Administrador:1, Gerente:1, Supervisor:1 });

    // Comisión Ejecutivos — subpáginas
    await addFuncV8('Comisión Ejecutivos', 'Variables de Comisión',    'comisiones_variables',  { Administrador:1, Gerente:1 });
    await addFuncV8('Comisión Ejecutivos', 'Revisión y Aprobación',    'comisiones_revision',   { Administrador:1, Gerente:1, Supervisor:1 });

    // Simulador — asignar a todos los perfiles
    await addFuncV8('Simulador', 'Ver Simulador', 'simulador_ver', { Administrador:1, Gerente:1, Supervisor:1, Ejecutivo:1, 'Ejecutivo Comercial':1 });

    // Administrador: habilitar TODAS
    if (admin) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [admin.id_perfil]
      );
    }

    console.log('✓ Perfiles v8: funcionalidades faltantes agregadas');
  } catch (e) {
    console.error('[perfiles migration v8]', e.message);
  }
})();

/* ─── Migración v9: nombres exactos por card + Solo Dios + limpiar dupl. ─── */
(async () => {
  try {
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
    const [[admin]]  = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");

    // 1) Renombrar funcionalidades para que coincidan EXACTAMENTE con el nombre de la card
    const renombres = [
      // Mantenedores
      ['mantenedores_parques',             'Arriendo y Comisión Parques'],
      ['mantenedores_flujo_brokerage',     'Flujo Crédito Brokerage'],
      ['mantenedores_broker_validaciones', 'Documentos a Validar Brokers'],
      ['mantenedores_financieras',         'Fórmulas Financieras'],
      ['mantenedores_comisiones_seguro',   'Comisiones de Seguro'],
      ['mantenedores_solo_dios',           'SOLO DIOS'],
      ['mantenedores_pagares',             'Pagarés Autofacil'],
      // Comisión Ejecutivos
      ['comisiones_variables',             'Mantenedor Variables Comisiones'],
      ['comisiones_revision',              'Revisión y Aprobación Comisiones'],
    ];
    for (const [codigo, nombre] of renombres) {
      await pool.query('UPDATE funcionalidades SET nombre=? WHERE codigo=?', [nombre, codigo]);
    }

    // 2) Agregar "SOLO DIOS" si no existe
    const [[modMan]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo'");
    if (modMan) {
      const [[exSD]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mantenedores_solo_dios'");
      let id_func;
      if (exSD) {
        id_func = exSD.id_funcionalidad;
      } else {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)',
          [modMan.id_modulo, 'SOLO DIOS', 'mantenedores_solo_dios']
        );
        id_func = ins.insertId;
      }
      for (const p of perfiles) {
        const hab = p.nombre === 'Administrador' ? 1 : 0;
        await pool.query(
          'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)',
          [p.id_perfil, id_func, hab]
        );
      }
    }

    // 3) Eliminar duplicados viejos por nombre (los que v4 no alcanzó a renombrar)
    //    Primero sacamos sus ids para borrar también los permisos
    const [dups] = await pool.query(
      "SELECT id_funcionalidad FROM funcionalidades WHERE nombre IN ('Gestionar Tasas','Gestionar UF')"
    );
    if (dups.length) {
      const ids = dups.map(r => r.id_funcionalidad);
      await pool.query('DELETE FROM permisos_perfil WHERE id_funcionalidad IN (?)', [ids]);
      await pool.query('DELETE FROM funcionalidades   WHERE id_funcionalidad IN (?)', [ids]);
    }

    // 4) Administrador: habilitar TODAS
    if (admin) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [admin.id_perfil]
      );
    }

    console.log('✓ Perfiles v9: nombres alineados con cards, Solo Dios agregado, duplicados eliminados');
  } catch (e) {
    console.error('[perfiles migration v9]', e.message);
  }
})();

/* ─── Migración v10: limpiar Tesoreros duplicados, Simulador duplicado, Dashboard permiso ── */
(async () => {
  try {
    // 1) Eliminar Tesoreros duplicados — conservar solo el de menor id
    const [[primerTesorero]] = await pool.query(
      "SELECT MIN(id_perfil) AS id FROM perfiles WHERE nombre = 'Tesorero'"
    );
    if (primerTesorero?.id) {
      // Mover permisos y usuarios al perfil que conservamos
      await pool.query(
        "UPDATE permisos_perfil SET id_perfil=? WHERE id_perfil IN (SELECT id_perfil FROM (SELECT id_perfil FROM perfiles WHERE nombre='Tesorero' AND id_perfil != ?) t) ON DUPLICATE KEY UPDATE habilitado=habilitado",
        [primerTesorero.id, primerTesorero.id]
      );
      await pool.query(
        "UPDATE usuarios SET id_perfil=? WHERE id_perfil IN (SELECT id_perfil FROM (SELECT id_perfil FROM perfiles WHERE nombre='Tesorero' AND id_perfil != ?) t)",
        [primerTesorero.id, primerTesorero.id]
      );
      await pool.query(
        "DELETE FROM perfiles WHERE nombre='Tesorero' AND id_perfil != ?",
        [primerTesorero.id]
      );
    }

    // 2) Eliminar módulo "Simulador" duplicado — conservar "Simulador Rentabilidad"
    const [[simDup]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Simulador' AND ruta='/simulador/' LIMIT 1"
    );
    const [[simOK]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Simulador Rentabilidad' LIMIT 1"
    );
    if (simDup && simOK) {
      // El "Simulador Rentabilidad" es el correcto — eliminar el duplicado "Simulador"
      const [funcs] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE id_modulo=?", [simDup.id_modulo]);
      if (funcs.length) {
        const ids = funcs.map(f => f.id_funcionalidad);
        await pool.query('DELETE FROM permisos_perfil WHERE id_funcionalidad IN (?)', [ids]);
        await pool.query('DELETE FROM funcionalidades WHERE id_funcionalidad IN (?)', [ids]);
      }
      await pool.query('DELETE FROM modulos WHERE id_modulo=?', [simDup.id_modulo]);
    }

    // 3) Agregar funcionalidad "Ver Dashboard" para control de permisos
    const [[modDash]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta LIKE '%dashboard%' AND estado='activo' LIMIT 1");
    if (modDash) {
      const [[exDash]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ver_dashboard'");
      let id_func_dash;
      if (exDash) {
        id_func_dash = exDash.id_funcionalidad;
      } else {
        const [ins] = await pool.query(
          "INSERT INTO funcionalidades (id_modulo, nombre, codigo) VALUES (?,?,?)",
          [modDash.id_modulo, 'Ver Dashboard', 'ver_dashboard']
        );
        id_func_dash = ins.insertId;
      }
      // Asignar: Admin y Gerente = 1, resto = 0
      const [todos] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
      for (const p of todos) {
        const hab = ['Administrador','Gerente'].includes(p.nombre) ? 1 : 0;
        await pool.query(
          'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)',
          [p.id_perfil, id_func_dash, hab]
        );
      }
    }

    // 4) Administrador: habilitar TODAS
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    if (adm) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [adm.id_perfil]
      );
    }

    console.log('✓ Perfiles v10: Tesoreros duplicados eliminados, Simulador deduplicado, Dashboard permiso agregado');
  } catch (e) {
    console.error('[perfiles migration v10]', e.message);
  }
})();

// ── Migración v11: asegurar funcionalidad ver_dashboard en todos los perfiles ──
(async () => {
  try {
    // Buscar módulo dashboard (cualquier estado)
    const [[modDash]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE ruta LIKE '%dashboard%' LIMIT 1"
    );
    if (!modDash) { console.warn('[v11] módulo dashboard no encontrado'); return; }

    // Crear funcionalidad si no existe (con icono para que aparezca en UI)
    let [[fd]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='ver_dashboard'");
    if (!fd) {
      const [ins] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, icono) VALUES (?,?,?,?)",
        [modDash.id_modulo, 'Ver Dashboard', 'ver_dashboard', 'bi-bar-chart-line']
      );
      fd = { id_funcionalidad: ins.insertId };
    }

    // Asegurar que TODOS los perfiles tienen un registro en permisos_perfil
    // Admin y Gerente = habilitado, resto = deshabilitado (para que aparezca en UI)
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
    for (const p of perfiles) {
      const hab = ['Administrador', 'Gerente'].includes(p.nombre) ? 1 : 0;
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE habilitado = habilitado`, // no sobreescribir si ya existe
        [p.id_perfil, fd.id_funcionalidad, hab]
      );
    }
    console.log('✓ Perfiles v11: ver_dashboard asegurado en todos los perfiles');
  } catch (e) {
    console.error('[perfiles migration v11]', e.message);
  }
})();

/* ─── Migración v12: Meses Cerrados, limpiar Caja duplicados, limpiar Simulador ─ */
(async () => {
  try {
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');

    // 1) Eliminar TODAS las funcionalidades duplicadas con código 'teso-caja-operativa'
    //    (la correcta es tesoreria_ver_cajas con id 150004)
    const [cajaDups] = await pool.query(
      "SELECT id_funcionalidad FROM funcionalidades WHERE codigo='teso-caja-operativa'"
    );
    if (cajaDups.length) {
      const ids = cajaDups.map(r => r.id_funcionalidad);
      // Borrar en lotes para evitar limit de parámetros
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        await pool.query('DELETE FROM permisos_perfil WHERE id_funcionalidad IN (?)', [chunk]);
        await pool.query('DELETE FROM funcionalidades WHERE id_funcionalidad IN (?)', [chunk]);
      }
      console.log(`[v12] ${cajaDups.length} duplicados Caja (teso-caja-operativa) eliminados`);
    }

    // 2) Limpiar módulo Simulador duplicado (conservar Simulador Rentabilidad)
    const [[simDup]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Simulador' AND ruta='/simulador/' LIMIT 1"
    );
    const [[simOK]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Simulador Rentabilidad' AND ruta='/simulador/' LIMIT 1"
    );
    if (simDup && simOK && simDup.id_modulo !== simOK.id_modulo) {
      const [simFuncs] = await pool.query(
        "SELECT id_funcionalidad FROM funcionalidades WHERE id_modulo=?", [simDup.id_modulo]
      );
      if (simFuncs.length) {
        const sids = simFuncs.map(f => f.id_funcionalidad);
        await pool.query('DELETE FROM permisos_perfil WHERE id_funcionalidad IN (?)', [sids]);
        await pool.query('DELETE FROM funcionalidades WHERE id_funcionalidad IN (?)', [sids]);
      }
      await pool.query("DELETE FROM modulos WHERE id_modulo=?", [simDup.id_modulo]);
      console.log(`[v12] módulo Simulador duplicado (${simDup.id_modulo}) eliminado`);
    }

    // 3) Agregar funcionalidad "Meses Cerrados" bajo Mantenedores
    const [[modMan]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo'"
    );
    if (modMan) {
      const [[exMC]] = await pool.query(
        "SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_meses_cerrados'"
      );
      let id_mc;
      if (exMC) {
        id_mc = exMC.id_funcionalidad;
      } else {
        const [ins] = await pool.query(
          "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)",
          [modMan.id_modulo, 'Meses Cerrados', 'mant_meses_cerrados', '/mantenedores/meses-cerrados/']
        );
        id_mc = ins.insertId;
        console.log('[v12] funcionalidad Meses Cerrados creada id=' + id_mc);
      }
      // Solo Admin puede acceder por defecto
      for (const p of perfiles) {
        const hab = p.nombre === 'Administrador' ? 1 : 0;
        await pool.query(
          'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)',
          [p.id_perfil, id_mc, hab]
        );
      }
    }

    // 4) Administrador: habilitar TODO
    if (adm) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [adm.id_perfil]
      );
    }

    console.log('✓ Perfiles v12: Meses Cerrados agregado, duplicados Caja y Simulador eliminados');
  } catch (e) {
    console.error('[perfiles migration v12]', e.message);
  }
})();

/* ─── Migración v13: módulo Aprobaciones (reemplazo de Cartas de Aprobación) ─ */
(async () => {
  try {
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');

    // 1) Crear módulo Aprobaciones si no existe
    let [[modAp]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE ruta='/aprobaciones/' LIMIT 1"
    );
    if (!modAp) {
      const [[{ maxOrden }]] = await pool.query('SELECT COALESCE(MAX(orden),0)+1 AS maxOrden FROM modulos');
      const [ins] = await pool.query(
        "INSERT INTO modulos (nombre, descripcion, icono, ruta, orden, estado) VALUES (?,?,?,?,?,'activo')",
        ['Aprobaciones', 'Cartas de aprobación de crédito: generación, revisión e impresión',
         'bi-patch-check', '/aprobaciones/', maxOrden]
      );
      modAp = { id_modulo: ins.insertId };
      console.log('[v13] módulo Aprobaciones creado id=' + modAp.id_modulo);
    }

    // 2) Funcionalidades: 1 con href (sub-item) + 3 de acción (href NULL)
    const funcs = [
      ['Aprobaciones',          'aprob_ver',     '/aprobaciones/'],
      ['Crear carta',           'aprob_crear',   null],
      ['Revisar carta',         'aprob_revisar', null],
      ['Editar parámetros',     'aprob_params',  null],
    ];
    for (const [nombre, codigo, href] of funcs) {
      const [[ex]] = await pool.query(
        'SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [codigo]
      );
      let idF;
      if (ex) {
        idF = ex.id_funcionalidad;
      } else {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
          [modAp.id_modulo, nombre, codigo, href]
        );
        idF = ins.insertId;
        console.log(`[v13] funcionalidad ${codigo} creada id=${idF}`);
      }
      // Por defecto solo Administrador habilitado
      for (const p of perfiles) {
        const hab = p.nombre === 'Administrador' ? 1 : 0;
        await pool.query(
          'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)',
          [p.id_perfil, idF, hab]
        );
      }
    }

    // 3) Administrador: habilitar todo
    if (adm) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [adm.id_perfil]
      );
    }

    console.log('✓ Perfiles v13: módulo Aprobaciones registrado');
  } catch (e) {
    console.error('[perfiles migration v13]', e.message);
  }
})();

/* ─── Migración v14: permisos finos módulo Aprobaciones (ver_todas, cartolas) ─ */
(async () => {
  try {
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
    const [[modAp]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/aprobaciones/' LIMIT 1");
    if (!modAp) return;

    const funcs = [
      ['Ver todas las cartas', 'aprob_ver_todas', null],
      ['Cartolas',             'aprob_cartolas',  null],
    ];
    for (const [nombre, codigo, href] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [codigo]);
      let idF;
      if (ex) { idF = ex.id_funcionalidad; }
      else {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
          [modAp.id_modulo, nombre, codigo, href]
        );
        idF = ins.insertId;
        console.log(`[v14] funcionalidad ${codigo} creada id=${idF}`);
      }
      // OJO: no se insertan 0 masivos — sin registro = comportamiento legacy
      // (ve todas). La restricción se activa al guardar la matriz en
      // Perfiles y Permisos. Solo Admin queda habilitado de inmediato.
      if (adm) {
        await pool.query(
          'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
          [adm.id_perfil, idF]
        );
      }
    }
    if (adm) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades
         ON DUPLICATE KEY UPDATE habilitado = 1`,
        [adm.id_perfil]
      );
    }
    console.log('✓ Perfiles v14: aprob_ver_todas y aprob_cartolas registrados');
  } catch (e) {
    console.error('[perfiles migration v14]', e.message);
  }
})();

/* ─── Migración v15: card Preferencia Financiera en Mantenedores ─ */
(async () => {
  try {
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[modMan]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo' LIMIT 1"
    );
    if (!modMan) return;
    // href debe partir con /mantenedores/ para que la página lo muestre;
    // el gateway redirige a /aprobaciones/?tab=params
    const HREF_PREF = '/mantenedores/preferencia-financiera/';
    const [[ex]] = await pool.query(
      "SELECT id_funcionalidad, href FROM funcionalidades WHERE codigo='mant_pref_financiera'"
    );
    let idF;
    if (ex) {
      idF = ex.id_funcionalidad;
      if (ex.href !== HREF_PREF) {
        await pool.query('UPDATE funcionalidades SET href=? WHERE id_funcionalidad=?', [HREF_PREF, idF]);
        console.log('[v15] href mant_pref_financiera corregido');
      }
    } else {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
        [modMan.id_modulo, 'Preferencia Financiera', 'mant_pref_financiera', HREF_PREF]
      );
      idF = ins.insertId;
      console.log('[v15] funcionalidad mant_pref_financiera creada id=' + idF);
    }
    if (adm) {
      await pool.query(
        'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
        [adm.id_perfil, idF]
      );
    }
    console.log('✓ Perfiles v15: card Preferencia Financiera en Mantenedores');
  } catch (e) {
    console.error('[perfiles migration v15]', e.message);
  }
})();

/* ─── Migración v16: eliminar módulo fantasma "Sistema" (/sistema/) ─
   Fue creado por código antiguo solo como contenedor del permiso
   ver_dashboard; nunca tuvo página. Sus funcionalidades se mueven al
   módulo Dashboard real y el módulo se elimina (o desactiva).        */
(async () => {
  try {
    const [[modSis]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE ruta='/sistema/' LIMIT 1"
    );
    if (!modSis) return;
    const [[modDash]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE ruta LIKE '%dashboard%' AND id_modulo <> ? LIMIT 1",
      [modSis.id_modulo]
    );
    if (modDash) {
      const [mv] = await pool.query(
        'UPDATE funcionalidades SET id_modulo = ? WHERE id_modulo = ?',
        [modDash.id_modulo, modSis.id_modulo]
      );
      await pool.query('DELETE FROM modulos WHERE id_modulo = ?', [modSis.id_modulo]);
      console.log(`✓ Perfiles v16: módulo Sistema eliminado (${mv.affectedRows} funcionalidades movidas a Dashboard)`);
    } else {
      // Sin módulo Dashboard: solo ocultar la card, conservando permisos
      await pool.query("UPDATE modulos SET estado='inactivo' WHERE id_modulo = ?", [modSis.id_modulo]);
      console.log('✓ Perfiles v16: módulo Sistema desactivado (sin Dashboard destino)');
    }
  } catch (e) {
    console.error('[perfiles migration v16]', e.message);
  }
})();

/* ─── Migración v17: perfiles y usuarios desde planilla (UNA SOLA VEZ) ─
   Crea los 11 perfiles del organigrama y carga/actualiza los 25
   usuarios con clave inicial AF2026. Usuarios con perfil Administrador
   conservan su clave y su perfil. Flag en BD evita re-ejecución
   (los usuarios cambiarán su clave y un deploy no debe resetearla).  */
(async () => {
  const bcrypt = require('bcryptjs');
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS push_config (clave VARCHAR(50) PRIMARY KEY, valor TEXT NOT NULL)`);
    const [[flag]] = await pool.query("SELECT valor FROM push_config WHERE clave='seed_usuarios_v17'");
    if (flag) return;

    // Asegurar columnas (puede correr antes que la migración de usuarios.controller)
    try { await pool.query('ALTER TABLE usuarios ADD COLUMN apellido_materno VARCHAR(100) NULL DEFAULT NULL'); }
    catch (e) { if (e.errno !== 1060) throw e; }
    try { await pool.query('ALTER TABLE usuarios ADD COLUMN centro_costo VARCHAR(100) NULL DEFAULT NULL'); }
    catch (e) { if (e.errno !== 1060) throw e; }

    const PERFILES_NUEVOS = [
      'Analista de Operaciones', 'Analista de Crédito', 'Analista Financiero',
      'Asistente Administrativa', 'Auditor', 'Ejecutivo Comercial',
      'Gerente de Finanzas', 'Gerente de Operaciones y Crédito',
      'Gerente General', 'Jefe Comercial', 'Supervisor de Crédito',
    ];
    for (const nombre of PERFILES_NUEVOS) {
      await pool.query(
        'INSERT IGNORE INTO perfiles (nombre, descripcion) VALUES (?,?)',
        [nombre, 'Perfil ' + nombre]
      );
    }
    const [perfRows] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
    const perfId = {};
    perfRows.forEach(p => perfId[p.nombre] = p.id_perfil);

    // [rut, nombre, ap_paterno, ap_materno, perfil, centro_costo, mail]
    const USUARIOS = [
      ['18154450-3','Ademir','Norambuena','Coloma','Analista de Operaciones','OPERACIONES','ademir.norambuena@autofacilchile.cl'],
      ['26790157-0','Alejandro','Arteaga','Melendez','Analista Financiero','FINANZAS','alejandro.arteaga@autofacilchile.cl'],
      ['16579884-8','Alvaro','Vargas','Vielma','Jefe Comercial','COMERCIAL','alvaro.vargas@autofacilchile.cl'],
      ['7818455-8','Bernardo','Ponce','Pinto','Analista de Crédito','RIESGO','bernardo.ponce@autofacilchile.cl'],
      ['18065250-7','Brandon','Barbas','Ruz','Ejecutivo Comercial','COMERCIAL','brandon.barbas@autofacilchile.cl'],
      ['18088259-6','Bryan','Saavedra','Rojas','Analista de Operaciones','OPERACIONES','bryan.saavedra@autofacilchile.cl'],
      ['17008339-3','Carlo','Moreno','Lizama','Ejecutivo Comercial','COMERCIAL','carlo.moreno@autofacilchile.cl'],
      ['13463753-6','Catherinne','Vargas','Vielma','Ejecutivo Comercial','COMERCIAL','catherinne.vargas@autofacilchile.cl'],
      ['9766899-K','Cristina','Peña','Vega','Asistente Administrativa','ADMINISTRACION Y FINANZAS','cristina.pena@autofacilchile.cl'],
      ['12260106-4','Dagoberto','Irribarra','Romero','Supervisor de Crédito','RIESGO','dagoberto.irribarra@autofacilchile.cl'],
      ['15330052-6','Fabian','Miranda','Fuentes','Ejecutivo Comercial','COMERCIAL','fabian.miranda@autofacilchile.cl'],
      ['11850529-8','Fernando','Contreras','Fernandez','Ejecutivo Comercial','COMERCIAL','fernando.contreras@autofacilchile.cl'],
      ['15820531-9','Hans','Vargas','Vielma','Ejecutivo Comercial','COMERCIAL','hans.vargas@autofacilchile.cl'],
      ['16693235-1','Jorge','Vargas','Castillo','Analista Financiero','ADMINISTRACION Y FINANZAS','jorge.vargas@autofacilchile.cl'],
      ['13564642-3','Juan','Bustamante','Donoso','Gerente de Finanzas','ADMINISTRACION Y FINANZAS','juan.bustamante@autofacilchile.cl'],
      ['12152111-3','Juan','Muñoz','Núñez','Ejecutivo Comercial','COMERCIAL','juan.muoz@autofacilchile.cl'],
      ['19637992-4','Karen','Mendez','Caneo','Ejecutivo Comercial','COMERCIAL','karen.mendez@autofacilchile.cl'],
      ['15821694-9','Karen','Farias','De La Torre','Ejecutivo Comercial','COMERCIAL','karen.farias@autofacilchile.cl'],
      ['21140816-2','Katherin','Trillo','Mauricio','Analista de Crédito','RIESGO','katherine.trillo@autofacilchile.cl'],
      ['23673582-6','Leonardo','Sevilla','Anda','Gerente General','ADMINISTRACION Y FINANZAS','leonardo.sevilla@autofacilchile.cl'],
      ['11404149-1','Luis','Soto','Ravello','Ejecutivo Comercial','COMERCIAL','luis.soto@autofacilchile.cl'],
      ['28817774-0','Noelia','Gonzalez','Zamora','Auditor','ADMINISTRACION Y FINANZAS','noelia.gonzalez@autofacilchile.cl'],
      ['7031537-8','Patricio','Escobar','Pohlhammer','Gerente de Operaciones y Crédito','OPERACIONES','patricio.escobar@autofacilchile.cl'],
      ['11478703-5','Sandra','Ayala','Rojas','Analista de Operaciones','OPERACIONES','sandra.ayala@autofacilchile.cl'],
      ['15418615-8','Solange','Vucina','Salazar','Ejecutivo Comercial','COMERCIAL','solange.vucina@autofacilchile.cl'],
    ];

    const hashAF2026 = await bcrypt.hash('AF2026', 10);
    let creados = 0, actualizados = 0, protegidos = 0;

    for (const [rut, nombre, apP, apM, perfil, centro, mail] of USUARIOS) {
      const idPerfil = perfId[perfil];
      if (!idPerfil) { console.warn('[v17] perfil no encontrado:', perfil); continue; }
      const [[ex]] = await pool.query(
        `SELECT u.id_usuario, p.nombre AS perfil_actual
         FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
         WHERE u.email = ? OR u.rut = ? LIMIT 1`, [mail, rut]
      );
      if (ex) {
        if (ex.perfil_actual === 'Administrador') {
          // Administrador: conserva clave y perfil; solo se completan datos
          await pool.query(
            'UPDATE usuarios SET nombre=?, apellido=?, apellido_materno=?, centro_costo=? WHERE id_usuario=?',
            [nombre, apP, apM, centro, ex.id_usuario]
          );
          protegidos++;
        } else {
          await pool.query(
            `UPDATE usuarios SET nombre=?, apellido=?, apellido_materno=?, centro_costo=?,
             email=?, id_perfil=?, password_hash=?, estado='activo' WHERE id_usuario=?`,
            [nombre, apP, apM, centro, mail, idPerfil, hashAF2026, ex.id_usuario]
          );
          actualizados++;
        }
      } else {
        await pool.query(
          `INSERT INTO usuarios (rut, nombre, apellido, apellido_materno, centro_costo, email, password_hash, id_perfil, estado)
           VALUES (?,?,?,?,?,?,?,?,'activo')`,
          [rut, nombre, apP, apM, centro, mail, hashAF2026, idPerfil]
        );
        creados++;
      }
    }

    await pool.query("INSERT INTO push_config (clave, valor) VALUES ('seed_usuarios_v17','done')");
    console.log(`✓ Perfiles v17: ${PERFILES_NUEVOS.length} perfiles, ${creados} usuarios creados, ${actualizados} actualizados (clave AF2026), ${protegidos} admin protegidos`);
  } catch (e) {
    console.error('[perfiles migration v17]', e.message);
  }
})();

/* ─── Migración v18: deduplicar perfiles + limpiar permisos heredados ─
   1) v17 creó perfiles duplicados (la tabla no tenía UNIQUE en nombre):
      se conserva el más antiguo, se reasignan usuarios y se fusionan
      permisos; luego se agrega el índice único.
   2) Los seeds antiguos regalaban Cobranza/Tesorería/CRM por defecto:
      se apagan para Ejecutivo Comercial (config fina via Perfiles UI). */
(async () => {
  try {
    // 1) Dedupe por nombre — conservar el id más bajo (el original)
    const [dups] = await pool.query(
      `SELECT nombre, MIN(id_perfil) AS keep_id, COUNT(*) AS n
       FROM perfiles GROUP BY nombre HAVING n > 1`
    );
    for (const d of dups) {
      const [rows] = await pool.query(
        'SELECT id_perfil FROM perfiles WHERE nombre = ? AND id_perfil <> ?',
        [d.nombre, d.keep_id]
      );
      for (const r of rows) {
        await pool.query('UPDATE usuarios SET id_perfil = ? WHERE id_perfil = ?', [d.keep_id, r.id_perfil]);
        // Fusionar permisos: los del original prevalecen; se copian los que falten
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
           SELECT ?, id_funcionalidad, habilitado FROM permisos_perfil WHERE id_perfil = ?`,
          [d.keep_id, r.id_perfil]
        );
        await pool.query('DELETE FROM permisos_perfil WHERE id_perfil = ?', [r.id_perfil]);
        await pool.query('DELETE FROM perfiles WHERE id_perfil = ?', [r.id_perfil]);
      }
      console.log(`[v18] perfil "${d.nombre}": ${rows.length} duplicado(s) fusionado(s) en id ${d.keep_id}`);
    }
    // Índice único para que no vuelva a pasar
    try { await pool.query('ALTER TABLE perfiles ADD UNIQUE KEY uk_perfil_nombre (nombre)'); }
    catch (e) { if (e.errno !== 1061) console.warn('[v18 unique]', e.message); }

    // 2) Ejecutivo Comercial: apagar Cobranza, Tesorería y CRM heredados
    const [[ej]] = await pool.query(
      "SELECT id_perfil FROM perfiles WHERE nombre = 'Ejecutivo Comercial' LIMIT 1"
    );
    if (ej) {
      const [r] = await pool.query(
        `UPDATE permisos_perfil pp
         JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
         JOIN modulos m ON m.id_modulo = f.id_modulo
         SET pp.habilitado = 0
         WHERE pp.id_perfil = ? AND m.ruta IN ('/cobranza/','/tesoreria/','/crm/')`,
        [ej.id_perfil]
      );
      if (r.affectedRows) console.log(`[v18] Ejecutivo Comercial: ${r.affectedRows} permisos Cobranza/Tesorería/CRM apagados`);
    }

    console.log('✓ Perfiles v18: duplicados fusionados y permisos heredados limpiados');
  } catch (e) {
    console.error('[perfiles migration v18]', e.message);
  }
})();

module.exports = { getAllPerfiles, getModulosConFuncionalidades, getPermisosPerfil, updatePermisosPerfil, reordenarModulos, createPerfil, updatePerfil, deletePerfil, getUsuariosByPerfil };
