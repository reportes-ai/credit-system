const pool = require('../../../../shared/config/database');
const RUT = require('../../../../api-gateway/public/js/rut-core');  // enforcement: RUT canónico
const { limpiarCachePermisos } = require('../../../../shared/middleware/permisos');
const { auditar } = require('../../../../shared/audit');

// Migración: insertar módulos Tesorería, CRM, Cobranza, Reportería si no existen
require('../../../../shared/migrate').migrarAuto('perfiles_b01', async () => {
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
});

/* ─── Perfil "Administrador de Sistema": sub-administrador con el alcance de la
   Fase 1 (Sistema Base) — Créditos, Clientes, Carga Masiva, mantenedores base
   (UF, tasas, dealers, vehículos, productos financiera, fórmulas, parámetros,
   comunas, estado créditos) y Usuarios completo para asignar funciones/permisos. ── */
require('../../../../shared/migrate').migrarAuto('perfil-admin-sistema', async () => {
  await pool.query(`INSERT IGNORE INTO perfiles (nombre, descripcion) VALUES
    ('Administrador de Sistema', 'Sub-administrador del Sistema Base (Fase 1): créditos, clientes, carga masiva, mantenedores base y gestión de usuarios y permisos')`);
  const [[perf]] = await pool.query(`SELECT id_perfil FROM perfiles WHERE nombre='Administrador de Sistema'`);
  if (!perf) return;
  // Módulos completos de la Fase 1
  await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
    SELECT ?, f.id_funcionalidad, 1 FROM funcionalidades f JOIN modulos m ON m.id_modulo=f.id_modulo
     WHERE m.ruta IN ('/creditos/','/clientes/','/carga-masiva/','/usuarios/')`, [perf.id_perfil]);
  // Mantenedores base de la Fase 1 (solo los del Sistema Base, no toda la sección)
  const MANT_F1 = ['mantenedores.ver', 'mantenedores_uf', 'mantenedores_tasas', 'mantenedores_dealers',
    'mantenedores_vehiculos', 'mant_productos_financiera', 'mantenedores_financieras', 'mantenedores_parametros',
    'mantenedores_comunas', 'mantenedores_estado_creditos', 'mantenedores_feriados', 'mantenedores_tipos_doc'];
  await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
    SELECT ?, id_funcionalidad, 1 FROM funcionalidades WHERE codigo IN (?)`, [perf.id_perfil, MANT_F1]);
  console.log('[perfil-admin-sistema] listo');
});

/* ─── Migración: agregar funcionalidades faltantes en todos los módulos ──── */
require('../../../../shared/migrate').migrarAuto('perfiles_b02', async () => {
  try {
    // [nombre_modulo, nombre_funcionalidad, codigo, habilitado_default(0/1)]
    const nuevasFuncs = [
      // Clientes
      ['Clientes',     'Ver Antecedentes Laborales',      'clientes_antecedentes',       1],
      ['Clientes',     'Ver Información Comercial',        'clientes_info_comercial',     1],
      // Créditos
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
});

/* ─── Migración v2: módulos y funcionalidades completos ──────────────────── */
require('../../../../shared/migrate').migrarAuto('perfiles_b03', async () => {
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
      ['Créditos', 'Recalcular Comisiones',          'creditos_recalcular_comisiones', 0],
      // ── Tesorería ───────────────────────────────────────────
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
      ['Mantenedores', 'Configurar Workflow Brokerage','mantenedores_workflow',        0],
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
});

/* ─── Migración: Dealers como sub-item en Home (limpia el módulo "falso") ─────
   Antes registramos Dealers como módulo para que apareciera en Home. Con el render
   unificado (la home ya pinta sub-items colocados vía Vista Pantallas), eso ya no
   hace falta: Dealers vuelve a ser un sub-item normal y se coloca en Home por
   placement. Este bloque revierte el módulo falso + el gate 'home_dealers', restaura
   el href de 'mantenedores_dealers', y —una sola vez— mueve 'dealers' a la sección Home. */
require('../../../../shared/migrate').migrarAuto('perfiles_b04', async () => {
  try {
    // 1) Restaurar el sub-item Dealers (su href de menú)
    await pool.query("UPDATE funcionalidades SET href = '/mantenedores/dealers/' WHERE codigo = 'mantenedores_dealers' AND (href IS NULL OR href <> '/mantenedores/dealers/')");

    // 2) Eliminar el módulo "falso" + su funcionalidad-gate 'home_dealers'
    const [[hf]] = await pool.query("SELECT id_funcionalidad, id_modulo FROM funcionalidades WHERE codigo = 'home_dealers' LIMIT 1");
    if (hf) {
      await pool.query('DELETE FROM permisos_perfil WHERE id_funcionalidad = ?', [hf.id_funcionalidad]);
      await pool.query('DELETE FROM funcionalidades WHERE id_funcionalidad = ?', [hf.id_funcionalidad]);
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM funcionalidades WHERE id_modulo = ?', [hf.id_modulo]);
      if (n === 0) await pool.query("DELETE FROM modulos WHERE id_modulo = ? AND ruta = '/mantenedores/dealers/'", [hf.id_modulo]);
    }

    // 3) Una sola vez: mover 'dealers' a la sección Home en placement_v2 (config global).
    //    Con flag para no pelear con reubicaciones futuras en Vista Pantallas.
    const [[done]] = await pool.query("SELECT 1 AS y FROM migraciones_aplicadas WHERE clave = 'dealers_a_home_placement' LIMIT 1");
    if (!done) {
      const [[cfg]] = await pool.query("SELECT valor FROM config_ui WHERE clave = 'placement_v2' LIMIT 1");
      if (cfg && cfg.valor) {
        let pl = null; try { pl = JSON.parse(cfg.valor); } catch (_) {}
        if (pl && typeof pl === 'object') {
          Object.keys(pl).forEach(sec => { if (Array.isArray(pl[sec])) pl[sec] = pl[sec].filter(k => k !== 'dealers'); });
          if (!Array.isArray(pl.home)) pl.home = [];
          pl.home.push('dealers');
          await pool.query("UPDATE config_ui SET valor = ? WHERE clave = 'placement_v2'", [JSON.stringify(pl)]);
        }
      }
      await pool.query("INSERT IGNORE INTO migraciones_aplicadas (clave) VALUES ('dealers_a_home_placement')");
    }
    console.log('✓ Dealers: módulo falso revertido; queda como sub-item colocado en Home');
  } catch (e) {
    console.error('[migracion revert Dealers]', e.message);
  }
});

/* ─── Migración v3: nuevos módulos y funcionalidades ─────────────────────── */
require('../../../../shared/migrate').migrarAuto('perfiles_b05', async () => {
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
    await addFunc('Usuarios', 'Enviar Correos', 'usuarios_mails', 0);

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
});

/* ─── Migración v4: nombres alineados con la app ─────────────────────────── */
require('../../../../shared/migrate').migrarAuto('perfiles_b06', async () => {
  try {
    // 1) Actualizar nombres para que coincidan exactamente con las páginas/cards
    const renombrar = [
      // Tesorería
      ['tesoreria_cajas',            'Administración de Cajas'],
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
});

/* ─── Migración v5: funcionalidades granulares de Cartas de Aprobación ──── */
require('../../../../shared/migrate').migrarAuto('perfiles_b07', async () => {
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
});

/* ─── Retiro del flujo brokerage/fundantes VIEJO (jun-2026) ───────────────────
   La generación vieja —Tesorería "Panel Brokerage" + "Fundantes Brokerage" en
   Créditos— quedó sin uso: la reemplazaron Seguimiento Fundantes (/fundantes/) y
   Post Venta. Las tablas facturas_brokerage / pagos_brokerage / fundantes_brokerage
   están en 0 (nunca se usaron). Archivamos sus 6 funcionalidades en un módulo
   inactivo "Retirados" y les quitamos el href → dejan de aparecer como card en
   Tesorería y como checkbox en la grilla de Perfiles. Reversible: mover de vuelta
   a su módulo (Créditos/Tesorería) y restaurar el href. Los permisos_perfil y el
   código legacy se conservan. */
require('../../../../shared/migrate').migrarAuto('perfiles_b08', async () => {
  try {
    const FLAG = 'retiro_brokerage_fundantes_viejo_v1';
    await pool.query(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      clave VARCHAR(80) PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    const [[ya]] = await pool.query('SELECT 1 ok FROM migraciones_aplicadas WHERE clave=? LIMIT 1', [FLAG]);
    if (ya) return;

    let [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Retirados' LIMIT 1");
    if (!mod) {
      const [ins] = await pool.query(
        `INSERT INTO modulos (nombre, descripcion, icono, ruta, orden, estado)
         VALUES ('Retirados','Funcionalidades de módulos retirados (archivadas, sin uso)','bi-archive','/retirados/',999,'inactivo')`);
      mod = { id_modulo: ins.insertId };
    }
    const codigos = ['tesoreria_brokerage_ver','tesoreria_brokerage_facturas','tesoreria_brokerage_pagos',
                     'creditos_fundantes_cargar','creditos_fundantes_validar','creditos_fundantes_ver'];
    await pool.query('UPDATE funcionalidades SET id_modulo=?, href=NULL WHERE codigo IN (?)', [mod.id_modulo, codigos]);
    await pool.query('INSERT IGNORE INTO migraciones_aplicadas (clave) VALUES (?)', [FLAG]);
    limpiarCachePermisos();
    console.log('✓ Retiro brokerage/fundantes viejo: 6 funcionalidades archivadas en módulo inactivo "Retirados"');
  } catch (e) { console.error('[retiro brokerage viejo]', e.message); }
});

const getAllPerfiles = async (req, res) => {
  try {
    // Perfiles en orden alfabético (A→Z).
    const [perfiles] = await pool.query(
      "SELECT * FROM perfiles ORDER BY nombre ASC"
    );
    // Un no-Admin ve todos los perfiles para gestionarlos, EXCEPTO Administrador
    // (su matriz revelaría los módulos aún no liberados) y SU PROPIO perfil
    // (nadie edita sus propios permisos). La matriz y el guardado ya se filtran
    // a "solo lo que él tiene".
    const otorgables = await require('../otorgables').funcsOtorgables(req.usuario.id_usuario);
    if (otorgables === null) return res.json({ success: true, data: perfiles, error: null });
    const [[yo]] = await pool.query('SELECT id_perfil FROM usuarios WHERE id_usuario=?', [req.usuario.id_usuario]);
    const visibles = perfiles.filter(p => p.nombre !== 'Administrador' && p.id_perfil !== yo?.id_perfil);
    res.json({ success: true, data: visibles, error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

const getModulosConFuncionalidades = async (req, res) => {
  try {
    const [modulos] = await pool.query(
      `SELECT m.id_modulo, m.nombre AS modulo, m.icono, m.ruta,
              f.id_funcionalidad, f.nombre AS funcionalidad, f.codigo, f.href
       FROM modulos m
       JOIN funcionalidades f ON f.id_modulo = m.id_modulo
       WHERE m.estado = 'activo'
       ORDER BY m.nombre, f.id_funcionalidad`
    );

    // Agrupar por módulo
    const agrupado = [];
    const mapaModulos = {};
    for (const row of modulos) {
      if (!mapaModulos[row.id_modulo]) {
        mapaModulos[row.id_modulo] = { id_modulo: row.id_modulo, nombre: row.modulo, icono: row.icono, ruta: row.ruta, funcionalidades: [] };
        agrupado.push(mapaModulos[row.id_modulo]);
      }
      mapaModulos[row.id_modulo].funcionalidades.push({
        id_funcionalidad: row.id_funcionalidad,
        nombre: row.funcionalidad,
        codigo: row.codigo,
        href: row.href   // sub-item/página (NULL = permiso de acción)
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

    // "Solo ves lo que tienes": la matriz de un no-Admin solo muestra las
    // funcionalidades que él tiene — los módulos no liberados no aparecen.
    const otorgables = await require('../otorgables').funcsOtorgables(req.usuario.id_usuario);
    const visible = otorgables === null ? agrupado
      : agrupado.map(g => ({ ...g, funcionalidades: g.funcionalidades.filter(f => otorgables.has(f.id_funcionalidad)) }))
                .filter(g => g.funcionalidades.length);

    res.json({ success: true, data: visible, error: null });
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
    // "Solo ves lo que tienes": a un no-Admin no se le revelan permisos de
    // funcionalidades fuera de su alcance (módulos no liberados).
    const otorgables = await require('../otorgables').funcsOtorgables(req.usuario.id_usuario);
    permisos.forEach(p => { if (otorgables === null || otorgables.has(p.id_funcionalidad)) mapa[p.id_funcionalidad] = p.habilitado === 1; });
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

    // "Solo otorgas lo que tienes": no-Admin no puede tocar el perfil Administrador
    // ni conceder/quitar funcionalidades que él mismo no tenga habilitadas.
    const otorgables = await require('../otorgables').funcsOtorgables(req.usuario.id_usuario);
    let omitidas = 0;
    let filtrados = permisos.filter(p => p && p.id_funcionalidad != null);
    if (otorgables !== null) {
      const [[dest]] = await pool.query('SELECT nombre FROM perfiles WHERE id_perfil=?', [id]);
      if (dest && dest.nombre === 'Administrador')
        return res.status(403).json({ success: false, data: null, error: 'Solo un Administrador puede modificar el perfil Administrador' });
      const antes = filtrados.length;
      filtrados = filtrados.filter(p => otorgables.has(Number(p.id_funcionalidad)));
      omitidas = antes - filtrados.length;
    }

    // Un solo INSERT masivo (antes era 1 query por funcionalidad → lento/timeout en BD remota)
    const valores = filtrados.map(p => [id, p.id_funcionalidad, p.habilitado ? 1 : 0]);
    if (valores.length) {
      await pool.query(
        `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         VALUES ?
         ON DUPLICATE KEY UPDATE habilitado = VALUES(habilitado)`,
        [valores]
      );
    }
    limpiarCachePermisos();   // efecto inmediato en las APIs

    auditar({ req, accion: 'PERMISOS', modulo: 'usuarios', entidad: 'perfil', entidad_id: id, detalle: `Actualizó permisos del perfil #${id} (${valores.length} funcionalidades${omitidas ? `; ${omitidas} omitidas por no tenerlas quien edita` : ''})` });
    res.json({ success: true, data: { mensaje: omitidas ? `Permisos actualizados (${omitidas} no aplicados: solo puedes otorgar permisos que tú tienes)` : 'Permisos actualizados' }, error: null });
  } catch (error) {
    console.error('[updatePermisosPerfil]', error.message);
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

/* ─── Asignación / desasignación MASIVA (un módulo o submódulo, todos los perfiles) ─
   Activa o desactiva una funcionalidad (o todas las de un módulo) en TODOS los
   perfiles de una sola vez. Excluye al Administrador (siempre ve todo). */
const masivoPermisos = async (req, res) => {
  try {
    const { id_modulo, id_funcionalidad, habilitado } = req.body;
    const hab = habilitado ? 1 : 0;

    // Resolver las funcionalidades objetivo
    let funcs = [];
    if (id_funcionalidad != null && id_funcionalidad !== '') {
      funcs = [parseInt(id_funcionalidad)];
    } else if (id_modulo != null && id_modulo !== '') {
      const [rows] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE id_modulo = ?', [id_modulo]);
      funcs = rows.map(r => r.id_funcionalidad);
    } else {
      return res.status(400).json({ success: false, data: null, error: 'Indica un módulo o un submódulo' });
    }
    if (!funcs.length) return res.status(400).json({ success: false, data: null, error: 'No hay funcionalidades para aplicar' });

    // "Solo otorgas lo que tienes" (no-Admin)
    const otorgables = await require('../otorgables').funcsOtorgables(req.usuario.id_usuario);
    if (otorgables !== null) {
      funcs = funcs.filter(f => otorgables.has(Number(f)));
      if (!funcs.length) return res.status(403).json({ success: false, data: null, error: 'Solo puedes asignar masivamente permisos que tú tienes' });
    }

    // Perfiles destino: todos menos Administrador (que siempre tiene acceso total)
    const [perfiles] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre <> 'Administrador'");
    if (!perfiles.length) return res.json({ success: true, data: { perfiles: 0, funcionalidades: funcs.length }, error: null });

    // Producto perfiles × funcionalidades → un solo INSERT masivo (upsert)
    const valores = [];
    for (const p of perfiles) for (const f of funcs) valores.push([p.id_perfil, f, hab]);
    await pool.query(
      `INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
       VALUES ?
       ON DUPLICATE KEY UPDATE habilitado = VALUES(habilitado)`,
      [valores]
    );
    limpiarCachePermisos();   // efecto inmediato en las APIs

    auditar({ req, accion: 'PERMISOS', modulo: 'usuarios', entidad: 'masivo', entidad_id: (id_modulo || id_funcionalidad),
      detalle: `Asignación masiva: ${hab ? 'activó' : 'desactivó'} ${funcs.length} funcionalidad(es) en ${perfiles.length} perfiles` });
    res.json({ success: true, data: { perfiles: perfiles.length, funcionalidades: funcs.length, habilitado: hab }, error: null });
  } catch (error) {
    console.error('[masivoPermisos]', error.message);
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
    auditar({ req, accion: 'EDITAR', modulo: 'usuarios', entidad: 'modulos', entidad_id: 'orden', detalle: `Reordenó los módulos del menú (${orden.length})` });
    res.json({ success: true, data: { mensaje: 'Orden actualizado' }, error: null });
  } catch (error) {
    console.error('[reordenarModulos]', error.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── CREATE PERFIL ──────────────────────────────────────────────────────── */
const createPerfil = async (req, res) => {
  try {
    const { nombre, descripcion = null, ambito_ejecutivos } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ success: false, data: null, error: 'El nombre es requerido' });
    const amb = ['todos', 'asignados'].includes(ambito_ejecutivos) ? ambito_ejecutivos : 'todos';

    // Verificar que no exista
    const [[ex]] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre = ?', [nombre.trim()]);
    if (ex) return res.status(400).json({ success: false, data: null, error: 'Ya existe un perfil con ese nombre' });

    let r;
    try {
      [r] = await pool.query('INSERT INTO perfiles (nombre, descripcion, ambito_ejecutivos) VALUES (?, ?, ?)', [nombre.trim(), descripcion || null, amb]);
    } catch (_) {   // por si la columna aún no existe en este arranque
      [r] = await pool.query('INSERT INTO perfiles (nombre, descripcion) VALUES (?, ?)', [nombre.trim(), descripcion || null]);
    }
    const id_perfil = r.insertId;

    // Copiar todas las funcionalidades con habilitado=0 (un solo INSERT masivo)
    const [funcs] = await pool.query('SELECT id_funcionalidad FROM funcionalidades');
    if (funcs.length) {
      await pool.query(
        'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES ?',
        [funcs.map(f => [id_perfil, f.id_funcionalidad, 0])]
      );
    }

    const [[perfil]] = await pool.query('SELECT * FROM perfiles WHERE id_perfil = ?', [id_perfil]);
    auditar({ req, accion: 'CREAR', modulo: 'usuarios', entidad: 'perfil', entidad_id: id_perfil, detalle: `Creó el perfil/rol "${nombre.trim()}"` });
    res.status(201).json({ success: true, data: perfil, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── UPDATE PERFIL ──────────────────────────────────────────────────────── */
const updatePerfil = async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, descripcion = null, ambito_ejecutivos } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ success: false, data: null, error: 'El nombre es requerido' });
    const amb = ['todos', 'asignados'].includes(ambito_ejecutivos) ? ambito_ejecutivos : null;

    const [[perfil]] = await pool.query('SELECT nombre FROM perfiles WHERE id_perfil = ?', [id]);
    if (!perfil) return res.status(404).json({ success: false, data: null, error: 'Perfil no encontrado' });
    if (perfil.nombre === 'Administrador') return res.status(400).json({ success: false, data: null, error: 'No se puede renombrar el perfil Administrador' });

    // Verificar que no exista otro con el mismo nombre
    const [[dup]] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre = ? AND id_perfil != ?', [nombre.trim(), id]);
    if (dup) return res.status(400).json({ success: false, data: null, error: 'Ya existe un perfil con ese nombre' });

    if (amb) {
      await pool.query('UPDATE perfiles SET nombre=?, descripcion=?, ambito_ejecutivos=? WHERE id_perfil=?', [nombre.trim(), descripcion || null, amb, id]);
      try { require('../../../../shared/visibilidad-ejecutivos').invalidarCache(); } catch (_) {}
    } else {
      await pool.query('UPDATE perfiles SET nombre = ?, descripcion = ? WHERE id_perfil = ?', [nombre.trim(), descripcion || null, id]);
    }
    const [[updated]] = await pool.query('SELECT * FROM perfiles WHERE id_perfil = ?', [id]);
    auditar({ req, accion: 'EDITAR', modulo: 'usuarios', entidad: 'perfil', entidad_id: id, detalle: `Editó el perfil/rol #${id} → "${nombre.trim()}"` });
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

    auditar({ req, accion: 'ELIMINAR', modulo: 'usuarios', entidad: 'perfil', entidad_id: id, detalle: `Eliminó el perfil/rol "${perfil.nombre}" (#${id})` });
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
       FROM usuarios WHERE id_perfil = ? AND estado = 'activo' AND protegido = 0
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
require('../../../../shared/migrate').migrarAuto('perfiles_b09', async () => {
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
});

/* ─── Migración v7: workflow brokerage completo ───────────────────────────── */
require('../../../../shared/migrate').migrarAuto('perfiles_b10', async () => {
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
});

/* ─── Migración v8: funcionalidades faltantes detectadas ─────────────────── */
require('../../../../shared/migrate').migrarAuto('perfiles_b11', async () => {
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
});

/* ─── Migración v9: nombres exactos por card + Solo Dios + limpiar dupl. ─── */
require('../../../../shared/migrate').migrarAuto('perfiles_b12', async () => {
  try {
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
    const [[admin]]  = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");

    // 1) Renombrar funcionalidades para que coincidan EXACTAMENTE con el nombre de la card
    const renombres = [
      // Mantenedores
      ['mantenedores_parques',             'Arriendo y Comisión Parques'],
      ['mantenedores_broker_validaciones', 'Documentos a Validar Brokers'],
      ['mantenedores_financieras',         'Fórmulas Comisiones Financieras'],
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
});

/* ─── Migración v10: limpiar Tesoreros duplicados, Simulador duplicado, Dashboard permiso ── */
require('../../../../shared/migrate').migrarAuto('perfiles_b13', async () => {
  try {
    // 1) Eliminar Tesoreros duplicados — conservar solo el de menor id
    const [[primerTesorero]] = await pool.query(
      "SELECT MIN(id_perfil) AS id FROM perfiles WHERE nombre = 'Tesorero'"
    );
    if (primerTesorero?.id) {
      // Mover permisos y usuarios al perfil que conservamos
      // (copiar con INSERT IGNORE y borrar origen: UPDATE no acepta ON DUPLICATE KEY)
      await pool.query(
        `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, habilitado FROM permisos_perfil
         WHERE id_perfil IN (SELECT id_perfil FROM perfiles WHERE nombre='Tesorero' AND id_perfil != ?)`,
        [primerTesorero.id, primerTesorero.id]
      );
      await pool.query(
        "DELETE FROM permisos_perfil WHERE id_perfil IN (SELECT id_perfil FROM (SELECT id_perfil FROM perfiles WHERE nombre='Tesorero' AND id_perfil != ?) t)",
        [primerTesorero.id]
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
});

// ── Migración v11: asegurar funcionalidad ver_dashboard en todos los perfiles ──
require('../../../../shared/migrate').migrarAuto('perfiles_b14', async () => {
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
});

/* ─── Migración v12: Meses Cerrados, limpiar Caja duplicados, limpiar Simulador ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b15', async () => {
  try {
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');

    // 1) "Caja" duplicada por nombre. La canónica es 'teso-caja-operativa' (tiene
    //    href /tesoreria/caja/, ícono y genera el menú; la mantiene cajas.controller).
    //    'tesoreria_ver_cajas' quedó sin href y sin uso → se elimina para no duplicar "Caja".
    const [cajaDups] = await pool.query(
      "SELECT id_funcionalidad FROM funcionalidades WHERE codigo='tesoreria_ver_cajas'"
    );
    if (cajaDups.length) {
      const ids = cajaDups.map(r => r.id_funcionalidad);
      // Borrar en lotes para evitar limit de parámetros
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        await pool.query('DELETE FROM permisos_perfil WHERE id_funcionalidad IN (?)', [chunk]);
        await pool.query('DELETE FROM funcionalidades WHERE id_funcionalidad IN (?)', [chunk]);
      }
      console.log(`[v12b] funcionalidad Caja duplicada (tesoreria_ver_cajas) eliminada`);
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
});

/* ─── Migración v13: módulo Aprobaciones (reemplazo de Cartas de Aprobación) ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b16', async () => {
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
});

/* ─── Migración v14: permisos finos módulo Aprobaciones (ver_todas, cartolas) ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b17', async () => {
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
});

/* ─── Migración v15: card Preferencia Financiera en Mantenedores ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b18', async () => {
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
});

/* ─── Migración v16: eliminar módulo fantasma "Sistema" (/sistema/) ─
   Fue creado por código antiguo solo como contenedor del permiso
   ver_dashboard; nunca tuvo página. Sus funcionalidades se mueven al
   módulo Dashboard real y el módulo se elimina (o desactiva).        */
require('../../../../shared/migrate').migrarAuto('perfiles_b19', async () => {
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
});

/* ─── Migración v17: perfiles y usuarios desde planilla (UNA SOLA VEZ) ─
   Crea los 11 perfiles del organigrama y carga/actualiza los 25
   usuarios con clave inicial AF2026. Usuarios con perfil Administrador
   conservan su clave y su perfil. Flag en BD evita re-ejecución
   (los usuarios cambiarán su clave y un deploy no debe resetearla).  */
require('../../../../shared/migrate').migrarAuto('perfiles_b20', async () => {
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
          [RUT.normalizar(rut) || rut, nombre, apP, apM, centro, mail, hashAF2026, idPerfil]
        );
        creados++;
      }
    }

    await pool.query("INSERT INTO push_config (clave, valor) VALUES ('seed_usuarios_v17','done')");
    console.log(`✓ Perfiles v17: ${PERFILES_NUEVOS.length} perfiles, ${creados} usuarios creados, ${actualizados} actualizados (clave AF2026), ${protegidos} admin protegidos`);
  } catch (e) {
    console.error('[perfiles migration v17]', e.message);
  }
});

/* ─── Migración v18: deduplicar perfiles + limpiar permisos heredados ─
   1) v17 creó perfiles duplicados (la tabla no tenía UNIQUE en nombre):
      se conserva el más antiguo, se reasignan usuarios y se fusionan
      permisos; luego se agrega el índice único.
   2) Los seeds antiguos regalaban Cobranza/Tesorería/CRM por defecto:
      se apagan para Ejecutivo Comercial (config fina via Perfiles UI). */
require('../../../../shared/migrate').migrarAuto('perfiles_b21', async () => {
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
});

/* ─── Migración v19: módulo Post Venta ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b22', async () => {
  try {
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    let [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/postventa/' LIMIT 1");
    if (!mod) {
      const [[{ maxOrden }]] = await pool.query('SELECT COALESCE(MAX(orden),0)+1 AS maxOrden FROM modulos');
      const [ins] = await pool.query(
        "INSERT INTO modulos (nombre, descripcion, icono, ruta, orden, estado) VALUES (?,?,?,?,?,'activo')",
        ['Post Venta', 'Seguimiento de saldos precio y comisiones post otorgamiento',
         'bi-truck', '/postventa/', maxOrden]);
      mod = { id_modulo: ins.insertId };
      console.log('[v19] módulo Post Venta creado id=' + mod.id_modulo);
    }
    const funcs = [
      ['Post Venta',                          'postventa_ver',          '/postventa/'],
      ['Seguimiento Saldos y Comisiones',     'postventa_seguimiento',  null],
      ['Mantenedores Post Venta',             'postventa_mantenedores', null],
      ['Saldos Precios a Pagar',              'postventa_saldos_pagar', null],
      // 'Fundantes Pendientes' (postventa_fundantes) retirado jul-2026: redundante con el
      // módulo Seguimiento Fundantes (420001), que ya marca la etapa FUNDANTES RECIBIDOS.
      ['Consulta Estado Saldos Precio',       'postventa_consulta_saldos',   null],
      ['Consulta Estado Factura',             'postventa_consulta_factura',  null],
    ];
    for (const [nombre, codigo, href] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [codigo]);
      let idF = ex?.id_funcionalidad;
      if (!idF) {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
          [mod.id_modulo, nombre, codigo, href]);
        idF = ins.insertId;
      }
      if (adm) await pool.query(
        'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
        [adm.id_perfil, idF]);
    }
    console.log('✓ Perfiles v19: módulo Post Venta registrado');
  } catch (e) { console.error('[perfiles migration v19]', e.message); }
});

/* ─── Migración v20: módulo Edición Créditos ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b23', async () => {
  try {
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    let [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/edicion-creditos/' LIMIT 1");
    if (!mod) {
      const [[{ maxOrden }]] = await pool.query('SELECT COALESCE(MAX(orden),0)+1 AS maxOrden FROM modulos');
      const [ins] = await pool.query(
        "INSERT INTO modulos (nombre, descripcion, icono, ruta, orden, estado) VALUES (?,?,?,?,?,'activo')",
        ['Edición Créditos', 'Edición completa de campos de créditos de meses no cerrados',
         'bi-pencil-square', '/edicion-creditos/', maxOrden]);
      mod = { id_modulo: ins.insertId };
      console.log('[v20] módulo Edición Créditos creado id=' + mod.id_modulo);
    }
    const funcs = [
      ['Edición Créditos',           'edicion_creditos_ver',    '/edicion-creditos/'],
      ['Edición Créditos Otorgados', 'edicion_creditos_otor',   null],
      ['Edición Otros Créditos',     'edicion_creditos_otros',  null],
      ['Editar campos',              'edicion_creditos_editar', null],
    ];
    for (const [nombre, codigo, href] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [codigo]);
      let idF = ex?.id_funcionalidad;
      if (!idF) {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
          [mod.id_modulo, nombre, codigo, href]);
        idF = ins.insertId;
      }
      if (adm) await pool.query(
        'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
        [adm.id_perfil, idF]);
    }
    console.log('✓ Perfiles v20: módulo Edición Créditos registrado');
  } catch (e) { console.error('[perfiles migration v20]', e.message); }
});

/* ─── Migración v21: funcionalidad Presupuesto bajo Mantenedores ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b24', async () => {
  try {
    const [[modMan]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo'");
    if (!modMan) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mantenedores_presupuesto'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [modMan.id_modulo, 'Presupuesto', 'mantenedores_presupuesto', '/mantenedores/presupuesto/', 'bi-clipboard-data']);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v21: funcionalidad Presupuesto registrada');
  } catch (e) { console.error('[perfiles migration v21]', e.message); }
});

/* ─── Migración v22: funcionalidad Ayuda bajo Mantenedores ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b25', async () => {
  try {
    const [[modMan]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo'");
    if (!modMan) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mantenedores_ayuda'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [modMan.id_modulo, 'Ayuda', 'mantenedores_ayuda', '/mantenedores/ayuda/', 'bi-question-circle']);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v22: funcionalidad Ayuda registrada');
  } catch (e) { console.error('[perfiles migration v22]', e.message); }
});

/* ─── Migración v23: funcionalidad Alertas bajo Mantenedores ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b26', async () => {
  try {
    const [[modMan]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo'");
    if (!modMan) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mantenedores_alertas'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [modMan.id_modulo, 'Alertas', 'mantenedores_alertas', '/mantenedores/alertas/', 'bi-bell-fill']);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v23: funcionalidad Alertas registrada');
  } catch (e) { console.error('[perfiles migration v23]', e.message); }
});

/* ─── Migración v24: funcionalidad Desempeño Analistas en Cartas de Aprobación ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b27', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/aprobaciones/' LIMIT 1");
    if (!mod) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='aprob_desempeno'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
        [mod.id_modulo, 'Desempeño Analistas de Crédito', 'aprob_desempeno', null]);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v24: funcionalidad Desempeño Analistas registrada');
  } catch (e) { console.error('[perfiles migration v24]', e.message); }
});

/* ─── Migración v25: funcionalidad Mantenedor de Cartas de Aprobación ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b28', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/aprobaciones/' LIMIT 1");
    if (!mod) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='aprob_mantenedor'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
        [mod.id_modulo, 'Mantenedor de Cartas de Aprobación', 'aprob_mantenedor', null]);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v25: funcionalidad Mantenedor de Cartas registrada');
  } catch (e) { console.error('[perfiles migration v25]', e.message); }
});

/* ─── Migración v26: atribuciones granulares del flujo Saldos Precio ─
   Separa el proceso en acciones independientes para asignar por perfil:
   definir fondos (Finanzas/Tesorería), seleccionar (Comercial),
   confirmar pago (Tesorería = postventa_saldos_pagar ya existente),
   generar nómina, emitir orden de pago y revertir pago. */
require('../../../../shared/migrate').migrarAuto('perfiles_b29', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/postventa/' LIMIT 1");
    if (!mod) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const funcs = [
      ['Definir Fondos Disponibles (Saldos Precio)', 'pv_fondos_definir',    null],
      ['Seleccionar Saldos a Pagar',                 'pv_saldos_seleccionar',null],
      ['Generar Nómina de Pago (Saldos Precio)',     'pv_nomina_generar',    null],
      ['Emitir Orden de Pago',                       'pv_orden_emitir',      null],
      ['Revertir Pago de Saldo Precio',              'pv_saldos_revertir',   null],
    ];
    for (const [nombre, codigo, href] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [codigo]);
      let idF = ex?.id_funcionalidad;
      if (!idF) {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
          [mod.id_modulo, nombre, codigo, href]);
        idF = ins.insertId;
      }
      if (adm) await pool.query(
        'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
        [adm.id_perfil, idF]);
    }
    console.log('✓ Perfiles v26: atribuciones de Saldos Precio registradas');
  } catch (e) { console.error('[perfiles migration v26]', e.message); }
});

/* ─── Migración v27: funcionalidad Parámetros Cobranza bajo Mantenedores ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b30', async () => {
  try {
    const [[modMan]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo'");
    if (!modMan) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_cobranza_parametros'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [modMan.id_modulo, 'Parámetros Cobranza', 'mant_cobranza_parametros', '/mantenedores/cobranza-parametros/', 'bi-cash-stack']);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v27: funcionalidad Parámetros Cobranza registrada');
  } catch (e) { console.error('[perfiles migration v27]', e.message); }
});

/* ─── Migración v28: funcionalidad Definiciones (glosario) bajo Mantenedores ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b31', async () => {
  try {
    const [[modMan]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo'");
    if (!modMan) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_definiciones'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [modMan.id_modulo, 'Definiciones', 'mant_definiciones', '/mantenedores/definiciones/', 'bi-book']);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v28: funcionalidad Definiciones registrada');
  } catch (e) { console.error('[perfiles migration v28]', e.message); }
});

/* ─── Migración v29: funcionalidad Alertas Saldos Precio bajo Mantenedores ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b32', async () => {
  try {
    const [[modMan]] = await pool.query(
      "SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo'");
    if (!modMan) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_alertas_saldos'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [modMan.id_modulo, 'Alertas Saldos Precio', 'mant_alertas_saldos', '/mantenedores/alertas-saldos/', 'bi-bell']);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v29: funcionalidad Alertas Saldos Precio registrada');
  } catch (e) { console.error('[perfiles migration v29]', e.message); }
});

/* ─── Migración v30: permiso Carga Masiva de Cartas de Aprobación ─ */
require('../../../../shared/migrate').migrarAuto('perfiles_b33', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/aprobaciones/' LIMIT 1");
    if (!mod) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='aprob_carga_masiva'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
        [mod.id_modulo, 'Carga Masiva Cartas de Aprobación', 'aprob_carga_masiva', null]);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v30: permiso Carga Masiva Cartas registrado');
  } catch (e) { console.error('[perfiles migration v30]', e.message); }
});

/* ─── Migración v31: flujo de pago de Comisiones (espejo de Saldos Precio) ─
   Card de acceso (Comisiones a Pagar / Orden de Pago Comisión) + atribuciones
   granulares: definir fondos, seleccionar, pagar, generar nómina, emitir orden,
   revertir. Todas independientes de las de Saldo Precio. */
require('../../../../shared/migrate').migrarAuto('perfiles_b34', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/postventa/' LIMIT 1");
    if (!mod) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const funcs = [
      ['Comisiones Dealer a Pagar',                'postventa_comisiones_pagar', null],
      ['Definir Fondos Disponibles (Comisión)',    'pv_com_fondos_definir',  null],
      ['Seleccionar Comisiones a Pagar',           'pv_com_seleccionar',     null],
      ['Confirmar Pago de Comisión',               'pv_com_pagar',           null],
      ['Generar Nómina de Pago (Comisión)',        'pv_com_nomina_generar',  null],
      ['Emitir Orden de Pago de Comisión',         'pv_com_orden_emitir',    null],
      ['Revertir Pago de Comisión',                'pv_com_revertir',        null],
    ];
    for (const [nombre, codigo, href] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [codigo]);
      let idF = ex?.id_funcionalidad;
      if (!idF) {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
          [mod.id_modulo, nombre, codigo, href]);
        idF = ins.insertId;
      }
      if (adm) await pool.query(
        'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
        [adm.id_perfil, idF]);
    }
    console.log('✓ Perfiles v31: flujo de pago de Comisiones registrado');
  } catch (e) { console.error('[perfiles migration v31]', e.message); }
});

/* ─── Migración v32: permiso Reversar Envío de Cartola (Aprobaciones) ─
   Acción sensible: deshace un envío de cartola (des-estampa Mes Cartola y
   quita la etapa CARTOLA ENVIADA en Post Venta). Solo Admin por defecto;
   el Admin puede habilitarla a otros perfiles desde Perfiles y Permisos. */
require('../../../../shared/migrate').migrarAuto('perfiles_b35', async () => {
  try {
    const [[modAp]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/aprobaciones/' LIMIT 1");
    if (!modAp) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='aprob_cartola_reversar'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
        [modAp.id_modulo, 'Reversar envío de cartola', 'aprob_cartola_reversar', null]);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v32: permiso Reversar Envío de Cartola registrado');
  } catch (e) { console.error('[perfiles migration v32]', e.message); }
});

/* ─── Migración v33: funcionalidad Cartas de Aprobación Vigentes (Aprobaciones) ─
   Card + acciones Otorgar/Desistir sobre cartas aprobadas dentro de su vigencia. */
require('../../../../shared/migrate').migrarAuto('perfiles_b36', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/aprobaciones/' LIMIT 1");
    if (!mod) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='aprob_vigentes'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
        [mod.id_modulo, 'Cartas de Aprobación Vigentes', 'aprob_vigentes', null]);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v33: funcionalidad Cartas de Aprobación Vigentes registrada');
  } catch (e) { console.error('[perfiles migration v33]', e.message); }
});

/* ─── Migración v34: funcionalidad Rentabilidad de Cartas (Aprobaciones) ─
   Pestaña/acción restringida: ve la rentabilidad por carta (AutoFin vs UAC). */
require('../../../../shared/migrate').migrarAuto('perfiles_b37', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/aprobaciones/' LIMIT 1");
    if (!mod) return;
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Administrador' LIMIT 1");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='aprob_rentabilidad'");
    let idF = ex?.id_funcionalidad;
    if (!idF) {
      const [ins] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
        [mod.id_modulo, 'Rentabilidad de la Carta', 'aprob_rentabilidad', null]);
      idF = ins.insertId;
    }
    if (adm) await pool.query(
      'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)',
      [adm.id_perfil, idF]);
    console.log('✓ Perfiles v34: funcionalidad Rentabilidad de la Carta registrada');
  } catch (e) { console.error('[perfiles migration v34]', e.message); }
});

/* ─── Migración: consolidar "Parques". Había la card huérfana "Parques y Comisiones"
   (con href, generaba el menú) además del permiso canónico mantenedores_parques
   (sin href). Se le da el href al canónico y se elimina la huérfana. */
require('../../../../shared/migrate').migrarAuto('perfiles_b38', async () => {
  try {
    await pool.query(
      "UPDATE funcionalidades SET href='/mantenedores/parques/', icono=COALESCE(NULLIF(icono,''),'bi-tree') " +
      "WHERE codigo='mantenedores_parques' AND (href IS NULL OR href='')"
    );
    const [orphans] = await pool.query(
      "SELECT id_funcionalidad FROM funcionalidades WHERE codigo <> 'mantenedores_parques' " +
      "AND (nombre='Parques y Comisiones' OR href='/mantenedores/parques/')"
    );
    for (const o of orphans) {
      await pool.query('DELETE FROM permisos_perfil WHERE id_funcionalidad=?', [o.id_funcionalidad]);
      try { await pool.query('DELETE FROM permisos_usuario WHERE id_funcionalidad=?', [o.id_funcionalidad]); } catch (_) {}
      await pool.query('DELETE FROM funcionalidades WHERE id_funcionalidad=?', [o.id_funcionalidad]);
    }
    if (orphans.length) console.log(`[parques-consolidar] ${orphans.length} funcionalidad(es) sobrante(s) eliminada(s)`);
  } catch (e) { console.error('[parques-consolidar]', e.message); }
});

/* ─── Migración: eliminar funcionalidades duplicadas por NOMBRE (códigos distintos) ─
   Caso: dos funcionalidades con el mismo nombre visible y códigos diferentes (la
   dedup por código no las junta). Se conserva la canónica y se elimina la sobrante,
   no usada como gate. Lista extensible. */
require('../../../../shared/migrate').migrarAuto('perfiles_b39', async () => {
  // codigo a eliminar → (canónica que se conserva, solo informativo)
  const OBSOLETAS = ['creditos_cargar_doc', 'mantenedores_flujo_brokerage']; // creditos_cargar_doc: "Documentos del Crédito" dup → creditos_documentos. mantenedores_flujo_brokerage: submódulo redundante con Estado Créditos (se unificó)
  try {
    for (const cod of OBSOLETAS) {
      const [rows] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [cod]);
      for (const r of rows) {
        await pool.query('DELETE FROM permisos_perfil WHERE id_funcionalidad=?', [r.id_funcionalidad]);
        try { await pool.query('DELETE FROM permisos_usuario WHERE id_funcionalidad=?', [r.id_funcionalidad]); } catch (_) {}
        await pool.query('DELETE FROM funcionalidades WHERE id_funcionalidad=?', [r.id_funcionalidad]);
      }
      if (rows.length) console.log(`[func-obsoletas] eliminada '${cod}' (${rows.length})`);
    }
  } catch (e) { console.error('[func-obsoletas]', e.message); }
});

/* ─── Migración: Carga Masiva paramétrica. Adopta las funcionalidades existentes
   (por href o por nombre viejo) y les fija código canónico + href, para que gateen
   cada card del landing y sus rutas. Si no existen, las crea. Admin=1 por defecto
   (preserva el Admin-only previo); el resto en 0. Idempotente. */
require('../../../../shared/migrate').migrarAuto('perfiles_b40', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta LIKE '%carga-masiva%' LIMIT 1");
    if (!mod) return;
    const CM = [
      ['cm_ver',          'Ver Carga Masiva',          '/carga-masiva/',             'bi-cloud-upload',      ['Ver Carga Masiva']],
      ['cm_cargar',       'Cargar (Excel AutoFácil)',  '/carga-masiva/cargar/',      'bi-cloud-upload-fill', ['Cargar AutoFácil (Excel)','Cargar AutoFácil','Cargar']],
      ['cm_trinidad',     'Carga Trinidad',            '/carga-masiva/trinidad/',    'bi-diagram-3-fill',    ['Cargar Trinidad','Carga Trinidad']],
      ['cm_eq_estados',   'Equivalencias Trinidad',    '/carga-masiva/eq-estados/',  'bi-arrow-left-right',  ['Equivalencias Estados','Equivalencia Estados','Equivalencias Trinidad']],
      ['cm_eq_ejecutivos','Equivalencia Ejecutivos',   '/carga-masiva/eq-ejecutivos/','bi-people-fill',      ['Equivalencias Ejecutivos','Equivalencia Ejecutivos']],
      ['cm_historial',    'Historial de Cargas',       '/carga-masiva/historial/',   'bi-clock-history',     ['Historial de Cargas','Historial']],
    ];
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
    for (const [cod, nombre, href, icono, viejos] of CM) {
      const nameList = [nombre, ...viejos];
      const [cands] = await pool.query(
        `SELECT id_funcionalidad, codigo FROM funcionalidades
         WHERE codigo=? OR href=? OR (id_modulo=? AND nombre IN (${nameList.map(() => '?').join(',')}))
         ORDER BY (codigo=?) DESC, id_funcionalidad ASC`,
        [cod, href, mod.id_modulo, ...nameList, cod]);
      let keepId;
      if (cands.length) {
        keepId = cands[0].id_funcionalidad;
        for (let i = 1; i < cands.length; i++) {
          const dupId = cands[i].id_funcionalidad;
          await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil,id_funcionalidad,habilitado) SELECT id_perfil,?,habilitado FROM permisos_perfil WHERE id_funcionalidad=?', [keepId, dupId]);
          await pool.query('DELETE FROM permisos_perfil WHERE id_funcionalidad=?', [dupId]);
          try { await pool.query('DELETE FROM permisos_usuario WHERE id_funcionalidad=?', [dupId]); } catch (_) {}
          await pool.query('DELETE FROM funcionalidades WHERE id_funcionalidad=?', [dupId]);
        }
        try {
          await pool.query('UPDATE funcionalidades SET codigo=?, nombre=?, href=?, icono=?, id_modulo=? WHERE id_funcionalidad=?',
            [cod, nombre, href, icono, mod.id_modulo, keepId]);
        } catch (e) { /* código ya en uso por otra fila: dejar el existente */ }
      } else {
        const [ins] = await pool.query('INSERT INTO funcionalidades (id_modulo,nombre,codigo,href,icono) VALUES (?,?,?,?,?)', [mod.id_modulo, nombre, cod, href, icono]);
        keepId = ins.insertId;
      }
      for (const p of perfiles) {
        const hab = p.nombre === 'Administrador' ? 1 : 0;
        await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil,id_funcionalidad,habilitado) VALUES (?,?,?)', [p.id_perfil, keepId, hab]);
      }
    }
  } catch (e) { console.error('[carga-masiva paramétrico]', e.message); }
});

/* ─── Migración: funcionalidad "Configurar Dashboard" (dashboard_config) ────────
   Gatea POST /api/dashboard/permisos y /presupuesto. Antes eran Admin-only
   (requirePerfil); se mantiene Admin-only por defecto (habilitado=1 solo Admin)
   y queda configurable desde la matriz. */
require('../../../../shared/migrate').migrarAuto('perfiles_b41', async () => {
  try {
    const [[modDash]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta LIKE '%dashboard%' LIMIT 1");
    if (!modDash) return;
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='dashboard_config'");
    let idF;
    if (ex) idF = ex.id_funcionalidad;
    else {
      const [ins] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, icono) VALUES (?,?,?,?)",
        [modDash.id_modulo, 'Configurar Dashboard', 'dashboard_config', 'bi-gear']);
      idF = ins.insertId;
    }
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles');
    for (const p of perfiles) {
      const hab = p.nombre === 'Administrador' ? 1 : 0;
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,?)', [p.id_perfil, idF, hab]);
    }
  } catch (e) { console.error('[dashboard_config seed]', e.message); }
});

/* ─── Migración: deduplicar funcionalidades por código + UNIQUE(codigo) ─────────
   Causa raíz de checkboxes duplicados (p.ej. "Caja", "Documentos del Crédito"):
   varias migraciones hacían INSERT sin que `codigo` fuera UNIQUE, acumulando
   filas con el mismo código en cada arranque. Se consolida a UNA fila por código
   (la de menor id), re-apuntando sus permisos, y se agrega UNIQUE(codigo) para
   que no vuelva a ocurrir. Idempotente y seguro de correr en cada boot. */
// Red de seguridad: corre en CADA boot (enFila, no migrar) — consolida duplicados por código.
require('../../../../shared/migrate').enFila('perfiles_dedup', async () => {
  try {
    const [dups] = await pool.query(
      `SELECT codigo, MIN(id_funcionalidad) AS keep_id, COUNT(*) AS n
       FROM funcionalidades WHERE codigo IS NOT NULL AND codigo <> ''
       GROUP BY codigo HAVING n > 1`
    );
    for (const d of dups) {
      const [rows] = await pool.query(
        'SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? AND id_funcionalidad<>?',
        [d.codigo, d.keep_id]
      );
      for (const r of rows) {
        const id = r.id_funcionalidad;
        // Conservar el permiso si el usuario/perfil lo tenía habilitado en CUALQUIER duplicado
        await pool.query(
          `UPDATE permisos_perfil pp
              JOIN (SELECT id_perfil, MAX(habilitado) h FROM permisos_perfil WHERE id_funcionalidad IN (?,?) GROUP BY id_perfil) x
                ON x.id_perfil = pp.id_perfil
             SET pp.habilitado = x.h
           WHERE pp.id_funcionalidad = ?`, [d.keep_id, id, d.keep_id]).catch(()=>{});
        await pool.query(
          'INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) ' +
          'SELECT id_perfil, ?, habilitado FROM permisos_perfil WHERE id_funcionalidad=?',
          [d.keep_id, id]);
        await pool.query('DELETE FROM permisos_perfil WHERE id_funcionalidad=?', [id]);
        try {
          await pool.query(
            'INSERT IGNORE INTO permisos_usuario (id_usuario, id_funcionalidad, habilitado) ' +
            'SELECT id_usuario, ?, habilitado FROM permisos_usuario WHERE id_funcionalidad=?',
            [d.keep_id, id]);
          await pool.query('DELETE FROM permisos_usuario WHERE id_funcionalidad=?', [id]);
        } catch (_) { /* tabla puede no existir */ }
        await pool.query('DELETE FROM funcionalidades WHERE id_funcionalidad=?', [id]);
      }
    }
    if (dups.length) console.log(`[func-dedup] ${dups.length} código(s) consolidado(s)`);
    try {
      await pool.query('ALTER TABLE funcionalidades ADD UNIQUE KEY uq_func_codigo (codigo)');
      console.log('[func-dedup] UNIQUE(codigo) agregado');
    } catch (e) { if (e.errno !== 1061 && e.errno !== 1062) console.error('[func-dedup uniq]', e.message); }
  } catch (e) { console.error('[func-dedup]', e.message); }
});

/* ─── Migración (UNA sola vez): preservar acceso histórico al migrar las rutas de
   Tesorería de requirePerfil → requireFunc. Otorga por defecto el permiso a los
   perfiles que antes accedían por nombre. Guardada en migraciones_aplicadas para
   NO volver a correr y NO pisar cambios posteriores del Administrador. */
require('../../../../shared/migrate').migrarAuto('perfiles_b43', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      clave VARCHAR(80) PRIMARY KEY,
      aplicada_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [[ya]] = await pool.query("SELECT 1 ok FROM migraciones_aplicadas WHERE clave='tesoreria_requirefunc_v1'");
    if (ya) return;
    const grants = {
      'tesoreria_cajas':                ['Gerente'],
      'tesoreria_cierre_caja':          ['Gerente', 'Supervisor', 'Tesorero'],
      'tesoreria_cuentas_transitorias': ['Gerente'],
    };
    for (const [cod, perfilesNom] of Object.entries(grants)) {
      const [[f]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [cod]);
      if (!f) continue;
      for (const nom of perfilesNom) {
        const [[p]] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre=? LIMIT 1', [nom]);
        if (!p) continue;
        await pool.query(
          'INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1) ' +
          'ON DUPLICATE KEY UPDATE habilitado=1', [p.id_perfil, f.id_funcionalidad]);
      }
    }
    await pool.query("INSERT IGNORE INTO migraciones_aplicadas (clave) VALUES ('tesoreria_requirefunc_v1')");
    console.log('[tesoreria_requirefunc_v1] permisos históricos preservados');
  } catch (e) { console.error('[tesoreria_requirefunc_v1]', e.message); }
});

/* ─── Migración (UNA sola vez): preservar acceso al migrar meses-cerrados →
   requireFunc. Antes era Admin+Gerente; Admin pasa por bypass, así que solo hay
   que otorgar a Gerente. (workflow era solo Admin → no requiere grant). */
require('../../../../shared/migrate').migrarAuto('perfiles_b44', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      clave VARCHAR(80) PRIMARY KEY,
      aplicada_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [[ya]] = await pool.query("SELECT 1 ok FROM migraciones_aplicadas WHERE clave='meses_cerrados_requirefunc_v1'");
    if (ya) return;
    const [[f]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_meses_cerrados' LIMIT 1");
    const [[p]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Gerente' LIMIT 1");
    if (f && p) await pool.query(
      'INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1) ' +
      'ON DUPLICATE KEY UPDATE habilitado=1', [p.id_perfil, f.id_funcionalidad]);
    await pool.query("INSERT IGNORE INTO migraciones_aplicadas (clave) VALUES ('meses_cerrados_requirefunc_v1')");
    console.log('[meses_cerrados_requirefunc_v1] permiso histórico (Gerente) preservado');
  } catch (e) { console.error('[meses_cerrados_requirefunc_v1]', e.message); }
});

/* ─── Migración (UNA sola vez): preservar acceso al migrar CRM campañas →
   requireFunc. Antes create/update de campañas era Admin+Gerente; se otorga a
   Gerente (Admin pasa por bypass). */
require('../../../../shared/migrate').migrarAuto('perfiles_b45', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      clave VARCHAR(80) PRIMARY KEY,
      aplicada_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [[ya]] = await pool.query("SELECT 1 ok FROM migraciones_aplicadas WHERE clave='crm_campanas_requirefunc_v1'");
    if (ya) return;
    const [[p]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Gerente' LIMIT 1");
    if (p) for (const cod of ['crm_campanas_crear', 'crm_campanas_gestionar']) {
      const [[f]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [cod]);
      if (f) await pool.query(
        'INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1) ' +
        'ON DUPLICATE KEY UPDATE habilitado=1', [p.id_perfil, f.id_funcionalidad]);
    }
    await pool.query("INSERT IGNORE INTO migraciones_aplicadas (clave) VALUES ('crm_campanas_requirefunc_v1')");
    console.log('[crm_campanas_requirefunc_v1] permiso histórico (Gerente) preservado');
  } catch (e) { console.error('[crm_campanas_requirefunc_v1]', e.message); }
});

/* ─── Migración (UNA sola vez): preservar acceso al migrar auditoría de crédito →
   requireFunc. Antes Admin+Gerente; se otorga a Gerente (Admin pasa por bypass). */
require('../../../../shared/migrate').migrarAuto('perfiles_b46', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      clave VARCHAR(80) PRIMARY KEY,
      aplicada_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [[ya]] = await pool.query("SELECT 1 ok FROM migraciones_aplicadas WHERE clave='auditoria_credito_requirefunc_v1'");
    if (ya) return;
    const [[f]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='creditos_auditoria' LIMIT 1");
    const [[p]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Gerente' LIMIT 1");
    if (f && p) await pool.query(
      'INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1) ' +
      'ON DUPLICATE KEY UPDATE habilitado=1', [p.id_perfil, f.id_funcionalidad]);
    await pool.query("INSERT IGNORE INTO migraciones_aplicadas (clave) VALUES ('auditoria_credito_requirefunc_v1')");
    console.log('[auditoria_credito_requirefunc_v1] permiso histórico (Gerente) preservado');
  } catch (e) { console.error('[auditoria_credito_requirefunc_v1]', e.message); }
});

module.exports = { getAllPerfiles, getModulosConFuncionalidades, getPermisosPerfil, updatePermisosPerfil, masivoPermisos, reordenarModulos, createPerfil, updatePerfil, deletePerfil, getUsuariosByPerfil };
