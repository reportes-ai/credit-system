'use strict';
const pool = require('../../../../shared/config/database');

/* ── Migración + seed piloto (Post Venta) ─────────────────────────── */
require('../../../../shared/migrate').enFila('ayuda', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ayuda_paginas (
        ruta        VARCHAR(150) PRIMARY KEY,
        titulo      VARCHAR(150) NOT NULL,
        icono       VARCHAR(40)  DEFAULT 'bi-question-circle',
        descripcion TEXT,
        pasos       TEXT,        /* JSON: [{titulo, detalle}] */
        submodulos  TEXT,        /* JSON: [{nombre, para_que}] */
        siguiente   TEXT,
        updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);

    // Seed inicial de ayuda por módulo (INSERT IGNORE: no pisa lo editado en el mantenedor)
    const SEED = [
      { ruta:'/postventa/', titulo:'Post Venta', icono:'bi-truck',
        descripcion:'Hace seguimiento a los créditos después de otorgados: el pago del saldo precio al dealer y el ciclo de comisión, etapa por etapa. Te muestra en qué punto va cada operación y cuáles están listas para pagar.',
        pasos:[
          { titulo:'Marca el avance en Seguimiento', detalle:'Cada crédito tiene dos pistas de casillas: Saldo Precio y Comisión. Marca cada etapa a medida que se completa el trámite. Son secuenciales: no puedes marcar una si la anterior no está marcada.' },
          { titulo:'Paga los saldos liberados', detalle:'Cuando un crédito llega a "Liberado a pago", aparece en "Saldos Precios a Pagar". Ahí seleccionas las operaciones, ves cuánto cargar al banco y al guardar quedan pagadas.' },
          { titulo:'Configura las reglas (Admin)', detalle:'En "Mantenedores Post Venta" defines qué estado equivale a cada etapa y qué perfiles pueden marcar cada casilla.' },
        ],
        submodulos:[
          { nombre:'Seguimiento Saldos Precio y Comisiones', para_que:'Grilla por crédito con todas las etapas. El día a día: marcar avances.' },
          { nombre:'Saldos Precios a Pagar', para_que:'Operaciones listas para pago: seleccionarlas, cargarlas al banco y marcarlas pagadas.' },
          { nombre:'Mantenedores Post Venta', para_que:'Configura estados equivalentes y permisos por etapa. Solo Admin.' },
        ],
        siguiente:'Primero marca avances en "Seguimiento". Cuando un saldo quede "Liberado a pago", ve a "Saldos Precios a Pagar" para pagarlo.' },

      { ruta:'/clientes/', titulo:'Clientes', icono:'bi-people-fill',
        descripcion:'Registro y mantención de los clientes: datos personales, antecedentes laborales e información comercial (deudas y perfil financiero).',
        pasos:[
          { titulo:'Busca o crea el cliente', detalle:'Busca por RUT o nombre. Si no existe, créalo con sus datos personales.' },
          { titulo:'Completa antecedentes', detalle:'Agrega los antecedentes laborales y la información comercial para tener el perfil completo del cliente.' },
        ],
        submodulos:[
          { nombre:'Antecedentes Laborales', para_que:'Situación laboral del cliente (empleador, renta, antigüedad).' },
          { nombre:'Información Comercial', para_que:'Deudas y perfil comercial del cliente.' },
        ],
        siguiente:'Con el cliente completo, puedes generar una cotización o iniciar un crédito.' },

      { ruta:'/cotizaciones/', titulo:'Cotizaciones', icono:'bi-calculator',
        descripcion:'Simulador de créditos: calcula cuota, plazo y condiciones para presentar al cliente antes de cursar la operación.',
        pasos:[
          { titulo:'Ingresa los datos del vehículo y financiamiento', detalle:'Valor, pie, plazo y tasa. El sistema calcula la cuota y el detalle.' },
          { titulo:'Genera y descarga', detalle:'Guarda la cotización y descárgala para enviarla al cliente.' },
        ],
        submodulos:[],
        siguiente:'Si el cliente acepta, continúa en "Créditos" para cursar la operación.' },

      { ruta:'/creditos/', titulo:'Créditos', icono:'bi-credit-card-2-front',
        descripcion:'Administración de las operaciones de crédito: ingreso, documentos, validaciones, otorgamiento y gestión de cuotas.',
        pasos:[
          { titulo:'Ingresa o busca la operación', detalle:'Crea el crédito o búscalo por N° de operación / cliente.' },
          { titulo:'Carga y valida documentos', detalle:'Adjunta los documentos del crédito y pásalos por las validaciones correspondientes.' },
          { titulo:'Gestiona el ciclo', detalle:'Registra pagos de cuotas y acciones según el estado de la operación.' },
        ],
        submodulos:[],
        siguiente:'Tras otorgar, el crédito pasa a "Post Venta" para el seguimiento de saldo precio y comisión.' },

      { ruta:'/tesoreria/', titulo:'Tesorería', icono:'bi-safe2',
        descripcion:'Gestión del dinero: cajas, cierres de caja, cuentas transitorias y flujo de brokerage.',
        pasos:[
          { titulo:'Opera la caja', detalle:'Registra movimientos en "Caja" y administra las cajas existentes.' },
          { titulo:'Cierra la caja', detalle:'Al final del período realiza el cierre de caja para cuadrar.' },
        ],
        submodulos:[
          { nombre:'Caja / Administración de Cajas', para_que:'Movimientos y gestión de las cajas.' },
          { nombre:'Cierre de Caja', para_que:'Cuadratura y cierre del período.' },
          { nombre:'Cuentas Transitorias', para_que:'Conciliación de cuentas transitorias contra créditos.' },
          { nombre:'Panel Brokerage Tesorería', para_que:'Facturas y pagos del flujo brokerage.' },
        ],
        siguiente:'Para conciliar contra operaciones, revisa "Cuentas Transitorias".' },

      { ruta:'/crm/', titulo:'CRM', icono:'bi-headset',
        descripcion:'Gestión de relaciones con clientes: registro de contactos (inbound/outbound), campañas y estadísticas.',
        pasos:[
          { titulo:'Registra la gestión', detalle:'En "Gestiones de Contacto" anota cada interacción con el cliente.' },
          { titulo:'Trabaja campañas', detalle:'Crea y gestiona campañas de outbound y revisa sus resultados.' },
        ],
        submodulos:[
          { nombre:'Gestiones de Contacto', para_que:'Registro de interacciones con clientes.' },
          { nombre:'Estadísticas CRM', para_que:'Indicadores de la gestión de contacto.' },
          { nombre:'Campañas de Outbound', para_que:'Creación, gestión y resultados de campañas.' },
        ],
        siguiente:'Revisa "Estadísticas CRM" para medir el resultado de tu gestión.' },

      { ruta:'/cobranza/', titulo:'Cobranza', icono:'bi-bell-fill',
        descripcion:'Gestión de cartera morosa con cumplimiento de la Ley del Consumidor: control pre-judicial y judicial.',
        pasos:[
          { titulo:'Revisa las acciones urgentes', detalle:'El panel resalta los casos que requieren gestión inmediata.' },
          { titulo:'Gestiona según etapa', detalle:'Trabaja la cartera en Pre-judicial o Judicial según corresponda.' },
        ],
        submodulos:[
          { nombre:'Pre-judicial', para_que:'Gestión de cobranza antes de acciones legales.' },
          { nombre:'Judicial', para_que:'Seguimiento de casos en etapa judicial.' },
          { nombre:'Reportería Cobranzas', para_que:'Informes de la gestión de cobranza.' },
        ],
        siguiente:'Usa "Reportería Cobranzas" para medir avance y provisiones.' },

      { ruta:'/reporteria/', titulo:'Reportería', icono:'bi-bar-chart-line-fill',
        descripcion:'Informes, exportaciones y reportes personalizados del sistema.',
        pasos:[
          { titulo:'Elige el tipo de reporte', detalle:'"Tailor Made" para armar tu propio reporte campo por campo, o "Tablas Dinámicas" para agrupar y calcular.' },
          { titulo:'Filtra y exporta', detalle:'Aplica filtros y exporta a Excel exactamente lo que necesitas.' },
        ],
        submodulos:[
          { nombre:'Tailor Made', para_que:'Construye tu propio reporte: elige campos, filtros y exporta.' },
          { nombre:'Tablas Dinámicas', para_que:'Agrupa, suma, cuenta y promedia. Guarda y comparte tus tablas.' },
        ],
        siguiente:'Para análisis visual con gráficos, revisa el Dashboard.' },

      { ruta:'/comisiones/', titulo:'Comisión Ejecutivos', icono:'bi-cash-coin',
        descripcion:'Cálculo y revisión de las comisiones mensuales de los ejecutivos.',
        pasos:[
          { titulo:'Revisa el cálculo del mes', detalle:'En "Revisión y Aprobación Comisiones" verifica los montos por ejecutivo.' },
          { titulo:'Ajusta parámetros si aplica', detalle:'En "Mantenedor Variables Comisiones" configuras las reglas del cálculo.' },
        ],
        submodulos:[
          { nombre:'Revisión y Aprobación Comisiones', para_que:'Verifica y aprueba las comisiones del período.' },
          { nombre:'Mantenedor Variables Comisiones', para_que:'Parámetros configurables del cálculo.' },
        ],
        siguiente:'Una vez revisadas, apruébalas para cerrar el período.' },

      { ruta:'/carga-masiva/', titulo:'Carga Masiva', icono:'bi-cloud-upload',
        descripcion:'Importación masiva de operaciones desde Excel (AutoFácil y Trinidad), con equivalencias e historial.',
        pasos:[
          { titulo:'Carga el Excel', detalle:'En "Cargar" subes el Excel calculado de AutoFácil. Para Trinidad usa "Carga Trinidad".' },
          { titulo:'Revisa equivalencias', detalle:'Verifica los mapeos de estados y ejecutivos de Trinidad antes de confirmar.' },
          { titulo:'Confirma y revisa historial', detalle:'Tras cargar, revisa "Historial" para ver qué se actualizó.' },
        ],
        submodulos:[
          { nombre:'Cargar / Carga Trinidad', para_que:'Importación de operaciones desde Excel.' },
          { nombre:'Equivalencias (Estados / Ejecutivos)', para_que:'Mapeo Trinidad → AutoFácil.' },
          { nombre:'Historial', para_que:'Registro de cargas y campos actualizados.' },
        ],
        siguiente:'Tras cargar, los datos alimentan el Dashboard y la reportería.' },

      { ruta:'/edicion-creditos/', titulo:'Edición Créditos', icono:'bi-pencil-square',
        descripcion:'Edición completa de los campos de créditos en meses NO cerrados, con registro de cada cambio.',
        pasos:[
          { titulo:'Elige el conjunto', detalle:'"Otorgados" para créditos ya otorgados, "Otros" para el resto.' },
          { titulo:'Edita en la grilla', detalle:'Usa las letras de columna para ubicar el campo. Cada cambio queda registrado en el log.' },
        ],
        submodulos:[
          { nombre:'Edición Créditos Otorgados', para_que:'Grilla editable de créditos otorgados.' },
          { nombre:'Edición Otros Créditos', para_que:'Grilla editable del resto de créditos.' },
        ],
        siguiente:'Recuerda: si el mes está cerrado, no se permite editar.' },

      { ruta:'/dashboard/', titulo:'Dashboard', icono:'bi-bar-chart-line',
        descripcion:'Tablero de indicadores: colocación, instituciones, cumplimiento de presupuesto y evolución, calculado en vivo desde la base.',
        pasos:[
          { titulo:'Filtra por período', detalle:'Ajusta el rango de fechas para ver los indicadores del período que te interesa.' },
          { titulo:'Revisa el presupuesto', detalle:'La pestaña de presupuesto compara lo real contra la meta. La meta se edita en Mantenedores → Presupuesto.' },
        ],
        submodulos:[],
        siguiente:'Para editar la meta mensual, ve a Mantenedores → "Presupuesto".' },

      { ruta:'/aprobaciones/', titulo:'Aprobaciones', icono:'bi-envelope-paper',
        descripcion:'Generación, revisión, impresión y seguimiento de las cartas de aprobación y cartolas.',
        pasos:[
          { titulo:'Digita la carta', detalle:'En "Generador de Carta" creas una nueva carta de aprobación.' },
          { titulo:'Revisa e imprime', detalle:'El pool de cartas se aprueba/rechaza en "Revisión" y luego se imprime en PDF.' },
        ],
        submodulos:[
          { nombre:'Generador de Carta', para_que:'Digita una nueva carta de aprobación.' },
          { nombre:'Revisión de Cartas', para_que:'Aprueba o rechaza las cartas pendientes.' },
          { nombre:'Impresión de Cartas / Mis Cartas', para_que:'Imprime PDFs y haz seguimiento.' },
        ],
        siguiente:'Tras aprobar, imprime la carta y haz seguimiento en "Mis Cartas".' },

      { ruta:'/mantenedores/', titulo:'Mantenedores', icono:'bi-gear-fill',
        descripcion:'Configuración base del sistema: tasas, UF, dealers, parámetros, presupuesto, comisiones de seguro, permisos y bases de datos (Nivel Dios).',
        pasos:[
          { titulo:'Elige el mantenedor', detalle:'Cada card abre una tabla de configuración distinta.' },
          { titulo:'Edita y guarda', detalle:'Modifica los valores y guarda. Los cambios aplican de inmediato al sistema.' },
        ],
        submodulos:[
          { nombre:'Tasas / UF / Parámetros', para_que:'Valores base de cálculo de créditos.' },
          { nombre:'Presupuesto', para_que:'Meta mensual de operaciones y monto (la usa el Dashboard).' },
          { nombre:'SOLO DIOS', para_que:'Acceso directo a las bases (Operaciones, Clientes, etc.) con edición total.' },
        ],
        siguiente:'Tras cambiar permisos o perfiles, conviene revisar Usuarios → Perfiles y Permisos.' },

      { ruta:'/usuarios/', titulo:'Usuarios', icono:'bi-people',
        descripcion:'Administración de usuarios, perfiles y permisos del sistema.',
        pasos:[
          { titulo:'Gestiona usuarios', detalle:'Crea, edita o desactiva usuarios y resetea contraseñas.' },
          { titulo:'Define permisos por perfil', detalle:'En "Perfiles y Permisos" marcas qué módulos y acciones ve cada perfil.' },
        ],
        submodulos:[
          { nombre:'Usuarios', para_que:'Alta, edición y reseteo de contraseñas.' },
          { nombre:'Perfiles y Permisos', para_que:'Matriz de qué puede ver/hacer cada perfil.' },
          { nombre:'Seguridad', para_que:'Políticas de seguridad de acceso.' },
        ],
        siguiente:'Tras crear un perfil, asígnale permisos en "Perfiles y Permisos".' },

      { ruta:'/simulador/', titulo:'Simulador Rentabilidad', icono:'bi-calculator',
        descripcion:'Simula la rentabilidad de una operación o cartera: ingresos, comisiones y cuota en tiempo real para AutoFin y Unidad de Crédito.',
        pasos:[
          { titulo:'Ingresa los parámetros', detalle:'Monto, plazo, tasa y condiciones. El simulador recalcula al instante.' },
          { titulo:'Compara escenarios', detalle:'Ajusta los valores para ver cómo cambian ingresos, comisiones y rentabilidad.' },
        ],
        submodulos:[],
        siguiente:'Si el escenario te convence, genera una cotización formal en "Cotizaciones".' },

      { ruta:'/dealers-incorporacion/', titulo:'Creación/Mantenedor de Dealer', icono:'bi-building-add',
        descripcion:'Ficha de incorporación de concesionarios y parques, su autorización por niveles, la firma del cliente y la mantención de los dealers vigentes. Cada dealer guarda su PROPIA tabla de comisiones (la que rige sus operaciones); la pizarra Parque/Calle solo precarga el default y sirve para detectar excepciones que escalan a Gerencia.',
        pasos:[
          { titulo:'Crea o modifica la ficha', detalle:'En "Creación Nuevo Dealer" llenas la ficha. Si el RUT ya existe, pasa a Modificación y precarga los datos actuales.' },
          { titulo:'Autoriza por niveles', detalle:'La ficha se autoriza ANTES de imprimirse. En "Mantención Dealers → Revisión" cada nivel autoriza (o rechaza) según su permiso.' },
          { titulo:'Imprime, firma y cierra', detalle:'Autorizada la ficha, el ejecutivo la imprime (con las autorizaciones en letra chica), la firma con el cliente, la sube y Operaciones la cierra creando/actualizando el dealer.' },
        ],
        submodulos:[
          { nombre:'Creación Nuevo Dealer', para_que:'Llena la ficha (General/Parque o Modificación), adjunta informes y envíala a autorización.' },
          { nombre:'Mantención Dealers', para_que:'Autoriza/cierra las fichas pendientes, sigue tus solicitudes y edita dealers vigentes.' },
          { nombre:'Niveles de Aprobación', para_que:'Configura la cadena de autorización (orden, condición, permiso). Restringible por usuario.' },
        ],
        siguiente:'La comisión pactada de cada dealer es la que rige; la pizarra es solo referencia y umbral de escalamiento.' },

      { ruta:'/dealers-incorporacion/nuevo.html/', titulo:'Ficha de Dealer — Creación / Modificación', icono:'bi-building-add',
        descripcion:'Completa la ficha del concesionario. Cada dealer lleva su PROPIA tabla de comisiones, que es la que rige sus operaciones; la pizarra Parque/Calle solo precarga el valor por defecto y define el umbral: lo que la supere es "participación especial" y escala a Gerencia. Los términos se autorizan ANTES de imprimir y firmar.',
        pasos:[
          { titulo:'Identifica el dealer', detalle:'Tipea el RUT o usa "Buscar dealer existente". Si ya existe, la ficha pasa a Modificación de Dealer y precarga sus datos; lo que cambies saldrá en rojo en la revisión.' },
          { titulo:'Define la comisión pactada', detalle:'Viene precargada desde la pizarra (Parque o Calle). Ajústala solo si hubo negociación. Si algún tramo supera la pizarra, se marca participación especial y requerirá visto de Gerencia.' },
          { titulo:'Adjunta los respaldos', detalle:'Sube el Informe Comercial Empresa y Socios. Si la cuenta es de un tercero o cambias el depósito del dealer, sube también el Poder Simple y los Poderes del Representante Legal.' },
          { titulo:'Envía a autorización', detalle:'Pulsa "Enviar a autorización" (todavía NO se firma). La ficha recorre la cadena de niveles configurada.' },
          { titulo:'Imprime y firma', detalle:'Cuando quede AUTORIZADA, en "Mis fichas" pulsa "Imprimir / Firmar": la ficha sale con las autorizaciones en letra chica. Hazla firmar por el cliente, súbela y pulsa "Enviar firmada".' },
          { titulo:'Cierre', detalle:'Operaciones/Crédito revisa la firma y cierra: el dealer queda creado o actualizado con su tabla de comisiones.' },
        ],
        submodulos:[],
        siguiente:'Para autorizar/cerrar fichas ve a "Mantención Dealers". Para cambiar quién autoriza cada nivel, "Niveles de Aprobación".' },

      { ruta:'/dealers-incorporacion/mantencion.html/', titulo:'Mantención de Dealers', icono:'bi-clipboard-check',
        descripcion:'Revisión por niveles de las fichas, cierre de las firmadas y mantención de los dealers vigentes. Cada autorización queda registrada con nombre y fecha (se imprime en la ficha).',
        pasos:[
          { titulo:'Autoriza tu nivel', detalle:'En "Revisión" verás las fichas pendientes. Si tienes el permiso del nivel actual, pulsa Autorizar (o Rechazar con motivo). Al pasar todos los niveles, la ficha queda AUTORIZADA.' },
          { titulo:'Cierra la firmada', detalle:'Cuando el ejecutivo sube la ficha firmada, pasa a PEND. CIERRE: revisa el documento y pulsa Cerrar para crear/actualizar el dealer.' },
          { titulo:'Mantén los dealers', detalle:'En "Dealers vigentes" editas los datos de los dealers ya creados. Los que tienen participación especial muestran un sello con quién la aprobó.' },
        ],
        submodulos:[],
        siguiente:'Para configurar la cadena de niveles (quién autoriza qué) ve a "Niveles de Aprobación".' },

      { ruta:'/dealers-incorporacion/niveles.html/', titulo:'Niveles de Aprobación de Dealer', icono:'bi-diagram-3',
        descripcion:'Configura la cadena PARAMÉTRICA que autoriza cada ficha antes de imprimirla y firmarla. Defines qué niveles aprueban, en qué orden, bajo qué condición y con qué permiso. La pizarra Parque/Calle es el umbral: lo que la supera escala al nivel de Gerencia.',
        pasos:[
          { titulo:'Agrega un nivel', detalle:'Define orden (la secuencia), un nombre y la condición: "Siempre" (toda ficha), "Comisión sobre la pizarra" (solo si algún tramo supera el default) o "Depósito modificado" (solo si cambia el banco/cuenta).' },
          { titulo:'Elige el permiso requerido', detalle:'Quien tenga ese permiso (según la matriz de Perfiles y Permisos) podrá autorizar/rechazar ese nivel. Ej: Análisis usa "Revisar fichas de dealer"; Gerencia usa "Aprobar participación especial".' },
          { titulo:'Activa/ordena', detalle:'Activa o desactiva niveles; el orden define la secuencia. Solo se aplican los niveles cuya condición calce con la ficha.' },
          { titulo:'Restringe quién configura', detalle:'Esta página se abre solo con el permiso "Configurar niveles de aprobación de dealer". Dáselo o quítaselo a cada perfil/usuario en Usuarios → Perfiles y Permisos.' },
        ],
        submodulos:[],
        siguiente:'Los niveles con condición "Comisión sobre la pizarra" sellan "Participación especial aprobada por…" al autorizar. El resultado se ve en Mantención Dealers → Revisión.' },
    ];

    for (const a of SEED) {
      await pool.query(
        `INSERT IGNORE INTO ayuda_paginas (ruta, titulo, icono, descripcion, pasos, submodulos, siguiente)
         VALUES (?,?,?,?,?,?,?)`,
        [a.ruta, a.titulo, a.icono, a.descripcion,
         JSON.stringify(a.pasos||[]), JSON.stringify(a.submodulos||[]), a.siguiente||null]);
    }
    console.log('[ayuda] tabla OK + seed', SEED.length);
  } catch (e) { console.error('[ayuda migration]', e.message); }
});

/* ══════════════════════════════════════════════════════════════════
   ACADEMIA AutoFácil — autocapacitación estilo curso Flash.
   Reutiliza el MISMO contenido de ayuda_paginas (una página = un curso;
   cada "paso" = una lección/slide). Solo agrega: registro del módulo
   (card) y persistencia de progreso por persona.
   ══════════════════════════════════════════════════════════════════ */
require('../../../../shared/migrate').enFila('academia', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS academia_progreso (
        id_usuario  INT          NOT NULL,
        ruta        VARCHAR(150) NOT NULL,
        slide_idx   INT          NOT NULL DEFAULT 0,   /* última lección vista */
        completado  TINYINT(1)   NOT NULL DEFAULT 0,
        updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id_usuario, ruta)
      )`);
    // Card en el menú (idempotente). Se habilita para TODOS los perfiles: es capacitación.
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (520001, 'Academia AutoFácil', 'Cursos de autocapacitación paso a paso por módulo', 'bi-mortarboard-fill', '/academia/', 107, 'activo')`);
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='academia_ver' LIMIT 1");
    let idFunc = ex && ex.id_funcionalidad;
    if (!idFunc) {
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
         VALUES (520001, 'Academia AutoFácil', 'academia_ver', '/academia/', 'bi-mortarboard-fill')`);
      idFunc = r.insertId;
    }
    // Habilitar la card para todos los perfiles que aún no la tengan (capacitación abierta).
    // OJO: NO usar "INSERT ... SELECT ... WHERE NOT EXISTS(SELECT FROM permisos_perfil)" —
    // referenciar la tabla destino en el subquery lanza error 1093 en MySQL/TiDB y deja el
    // módulo sin permiso (card invisible). Se hace por perfil, como Auditoría.
    const [perfilesRows] = await pool.query('SELECT id_perfil FROM perfiles');
    for (const { id_perfil } of perfilesRows) {
      const [[has]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [id_perfil, idFunc]);
      if (!has) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [id_perfil, idFunc]);
    }
    console.log('[academia] módulo + progreso OK (perfiles:', perfilesRows.length, ')');
  } catch (e) { console.error('[academia migration]', e.message); }
});

const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const normRuta = r => { let x = String(r || '').split('?')[0].split('#')[0]; if (!x.endsWith('/')) x += '/'; return x; };

/* Nº de lecciones (slides) de un curso: intro + pasos + submódulos + cierre. */
function nLecciones(row) {
  const pasos = parse(row.pasos, []), subs = parse(row.submodulos, []);
  return 1 /*intro*/ + pasos.length + (subs.length ? 1 : 0) + (row.siguiente ? 1 : 0);
}

/* ── GET /api/ayuda/academia/cursos — catálogo + mi progreso (solo verifyToken) ── */
const academiaCursos = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT ruta, titulo, icono, descripcion, pasos, submodulos, siguiente FROM ayuda_paginas ORDER BY titulo');
    const [prog] = await pool.query('SELECT ruta, slide_idx, completado FROM academia_progreso WHERE id_usuario=?', [req.user.id_usuario]);
    const pMap = {}; prog.forEach(p => pMap[p.ruta] = p);
    const cursos = rows.map(r => {
      const total = nLecciones(r);
      const p = pMap[r.ruta];
      const vistos = p ? Math.min(p.slide_idx + 1, total) : 0;
      return {
        ruta: r.ruta, titulo: r.titulo, icono: r.icono || 'bi-mortarboard',
        resumen: (r.descripcion || '').slice(0, 130),
        lecciones: total,
        vistos, completado: p ? !!p.completado : false,
        pct: total ? Math.round((p && p.completado ? total : vistos) / total * 100) : 0,
      };
    });
    res.json({ success: true, data: cursos, error: null });
  } catch (e) {
    console.error('[academia cursos]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── POST /api/ayuda/academia/progreso {ruta, slide_idx, completado} ── */
const academiaProgreso = async (req, res) => {
  try {
    const ruta = normRuta(req.body.ruta);
    const slide = Math.max(0, parseInt(req.body.slide_idx) || 0);
    const comp = req.body.completado ? 1 : 0;
    if (!ruta) return res.status(400).json({ success: false, data: null, error: 'ruta requerida' });
    await pool.query(
      `INSERT INTO academia_progreso (id_usuario, ruta, slide_idx, completado)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE
         slide_idx  = GREATEST(slide_idx, VALUES(slide_idx)),
         completado = GREATEST(completado, VALUES(completado))`,
      [req.user.id_usuario, ruta, slide, comp]);
    res.json({ success: true, data: { ruta }, error: null });
  } catch (e) {
    console.error('[academia progreso]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/ayuda?ruta=/postventa/ ─────────────────────────────── */
const getAyuda = async (req, res) => {
  try {
    const ruta = normRuta(req.query.ruta);
    const [[row]] = await pool.query('SELECT * FROM ayuda_paginas WHERE ruta = ?', [ruta]);
    if (!row) return res.json({ success: true, data: null, error: null });
    res.json({
      success: true,
      data: {
        ruta: row.ruta, titulo: row.titulo, icono: row.icono,
        descripcion: row.descripcion,
        pasos: parse(row.pasos, []),
        submodulos: parse(row.submodulos, []),
        siguiente: row.siguiente,
      },
      error: null,
    });
  } catch (e) {
    console.error('[ayuda getAyuda]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/ayuda/todas — lista para el mantenedor ─────────────── */
const listAyuda = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT ruta, titulo, icono, updated_at FROM ayuda_paginas ORDER BY titulo');
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── PUT /api/ayuda/:ruta — para el mantenedor de Ayuda ──────────── */
const upsertAyuda = async (req, res) => {
  try {
    const ruta = normRuta(req.body.ruta || req.params.ruta);
    const { titulo, icono, descripcion, pasos, submodulos, siguiente } = req.body;
    if (!titulo) return res.status(400).json({ success: false, data: null, error: 'titulo requerido' });
    await pool.query(
      `INSERT INTO ayuda_paginas (ruta, titulo, icono, descripcion, pasos, submodulos, siguiente)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE titulo=VALUES(titulo), icono=VALUES(icono), descripcion=VALUES(descripcion),
         pasos=VALUES(pasos), submodulos=VALUES(submodulos), siguiente=VALUES(siguiente)`,
      [ruta, titulo, icono || 'bi-question-circle', descripcion || null,
       JSON.stringify(pasos || []), JSON.stringify(submodulos || []), siguiente || null]);
    res.json({ success: true, data: { ruta }, error: null });
  } catch (e) {
    console.error('[ayuda upsert]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { getAyuda, listAyuda, upsertAyuda, academiaCursos, academiaProgreso };
