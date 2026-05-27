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
      { nombre: 'Cartas de Aprobación', icono: 'bi-envelope-check', ruta: '/cartas-aprobacion/', descripcion: 'Generación e historial de cartas de aprobación de crédito', orden: 25 },
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
    res.status(500).json({ success: false, data: null, error: e.message });
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
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAllPerfiles, getModulosConFuncionalidades, getPermisosPerfil, updatePermisosPerfil, reordenarModulos, createPerfil, deletePerfil, getUsuariosByPerfil };
