'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   FASE 2 del plan de staging (docs/plan-staging-prod.md) — base espejo.

   Crea `credit_system_staging` en el MISMO cluster de TiDB y la deja usable:
     · ESTRUCTURA de las 368 tablas, idéntica a producción;
     · DATOS solo de las tablas de la LISTA EXPLÍCITA de abajo (mantenedores,
       permisos, indicadores, maestros de negocio). Todo lo demás queda VACÍO.
     · La CARTERA no se copia: créditos, clientes, cuotas, pagos, cobranza,
       cartas, RRHH y contabilidad nacen vacíos. La QA crea sus propios casos.

   ── Por qué la lista es de lo que ENTRA y no de lo que se excluye ────────────
   La primera versión de este script usaba una lista de exclusión y dejaba pasar
   respaldos, movimientos bancarios y conversaciones con dealers. Con una lista
   de inclusión, una tabla nueva con datos de personas NO se copia sola: hay que
   agregarla a mano. Si falta algo en staging, se agrega acá — ese es el costo
   correcto, mucho más barato que filtrar datos de clientes a un ambiente de
   pruebas.

   ── Tres blindajes sobre los datos que sí se copian ──────────────────────────
   1. CONTACTO ENMASCARADO: toda columna de correo o teléfono se reemplaza. Es el
      cinturón sobre el tirante — `ENTORNO=staging` ya fuerza el Modo Desarrollo,
      pero así en staging simplemente NO EXISTE la dirección de nadie real.
   2. CONTRASEÑAS NUEVAS: no se copia ni un hash de producción. Todos los
      usuarios de staging quedan con una clave común conocida (`--clave`), para
      que QA pueda entrar con cualquier perfil sin arrastrar credenciales reales.
   3. SECRETOS FUERA: `credenciales_*` y `sesiones_usuario` no están en la lista.

   SOLO LEE producción. Todo lo que escribe va a la base de staging.

   Uso:  node scripts/crear-bd-staging.js                    (simulación)
         node scripts/crear-bd-staging.js --ejecutar
         node scripts/crear-bd-staging.js --ejecutar --recrear
         node scripts/crear-bd-staging.js --ejecutar --clave=MiClaveStaging
   ───────────────────────────────────────────────────────────────────────────── */
const pool   = require('../shared/config/database');
const bcrypt = require('bcryptjs');

const EJECUTAR = process.argv.includes('--ejecutar');
const RECREAR  = process.argv.includes('--recrear');
const CLAVE    = (process.argv.find(a => a.startsWith('--clave=')) || '--clave=Staging2026!').split('=')[1];
const DESTINO  = process.env.DB_NAME_STAGING || 'credit_system_staging';

/* ── Lo único que lleva datos ─────────────────────────────────────────────────
   Agrupado por para qué sirve, para que se pueda auditar de un vistazo. */
const CON_DATOS = {
  'Acceso y permisos': [
    'usuarios', 'perfiles', 'permisos_perfil', 'permisos_usuario', 'funcionalidades',
    'modulos', 'usuario_config', 'usuario_ejecutivos', 'dashboard_config',
  ],
  'Configuración del sistema': [
    'config_sistema', 'config_seguridad', 'config_ui', 'config_meses', 'mantenimiento_config',
    'ayuda_paginas', 'definiciones', 'anuncios_config', 'comunicado_config', 'mi_dia_config',
    'push_config', 'rank_config', 'carrera_config', 'workflow_config', 'servicios_costos',
    'uptime_servicios', '_migraciones', 'migraciones_aplicadas', 'data_migraciones',
  ],
  'Indicadores y tablas legales': [
    'uf', 'utm', 'ipc', 'dolar', 'tasas', 'impuestos', 'feriados', 'indicadores_estado',
    'parametros_afp', 'rh_afp_tasas', 'rh_impuesto_tramos', 'tramos_iusc',
  ],
  'Geografía y catálogos': [
    'regiones', 'provincias', 'comunas', 'actividades_economicas', 'tipos_documento', 'vehiculos',
  ],
  'Parámetros de negocio': [
    'parametros_credito', 'cartas_parametros', 'cartera_parametros', 'cobranza_config',
    'comisiones_variables', 'comisiones_resumen_config', 'comisiones_alertas_config',
    'comisiones_seguro_pct_mes', 'comisiones_seguro_plazo', 'bono_jefe_config',
    'score_mora_config', 'preaprobacion_parametros', 'politica_aprobacion_matriz',
    'politica_v3_tablas', 'productos_financiera', 'trinidad_estados', 'trinidad_ejecutivos',
    'cierre_mes_config', 'cierre_checklist_items', 'postventa_config', 'fundantes_seg_tipos',
    'caja_horario_pago', 'cajas', 'caja_usuarios', 'visitas_config', 'cv_terminos',
  ],
  'Máquinas de estados': [
    'estados_credito', 'estados_transicion', 'estados_cartera', 'estados_cartera_transicion',
  ],
  'Maestros de negocio': [
    'dealers', 'dealer_categorias', 'dealer_comisiones', 'dealer_aprob_niveles',
    'dealer_potencial_config', 'dealer_liquidez_niveles', 'parques_comisiones',
    'vendedores_dealer', 'proveedores', 'cuentas_bancarias',
  ],
  'Avisos, alertas y plantillas': [
    'avisos_config', 'avisos_linea', 'avisos_clave_vencimiento', 'alertas_config',
    'alertas_vencimiento_config', 'dealer_alertas_config', 'postventa_alertas_config',
    'correos_programados', 'plantillas_documento', 'certificados_textos',
    'cobranza_mora_plantillas', 'cobranza_jud_catalogo', 'ar_config', 'ar_respuestas_rapidas',
  ],
  'Contabilidad (plan y reglas, sin movimientos)': [
    'ctb_config', 'ctb_cuentas', 'ctb_reglas', 'ctb_reglas_lineas', 'ctb_plantillas',
    'ctb_guardian_reglas', 'ctb_dir_rubros',
  ],
  'Integraciones y correlativos': [
    'apis_catalogo', 'dealernet_config', 'dealernet_productos', 'wsp_config',
    'wsp_plantillas_tipo', 'wsp_triggers', 'ia_config', 'ia_modelos', 'ia_funcionalidades',
    'ia_consulta_limites', 'op_correlativos', 'op_secuencia', 'correlativo_transacciones',
  ],
  'RRHH — solo tablas de configuración': [
    'rh_config', 'rh_cargos', 'rh_turnos', 'rh_sol_tipos', 'rh_finiquito_causales',
    'rh_onb_plantilla', 'rh_kuder_areas', 'rh_kuder_items', 'rh_previred_config',
    'rh_directorio_config',
  ],
  'Compras y soporte': [
    'compras_aprobacion_niveles', 'compras_articulos', 'compras_articulo_perfil',
    'compras_direcciones', 'ti_config', 'ti_motivos',
  ],
};
const LISTA = Object.values(CON_DATOS).flat();

/* Columnas de contacto que se enmascaran en TODO lo que se copia. */
const esCorreo   = c => /(mail|correo)/i.test(c);
const esTelefono = c => /(telefono|fono|celular|movil|whatsapp|wsp)/i.test(c);

const esc = v => {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
};

(async () => {
  const [[{ d: ORIGEN }]] = await pool.query('SELECT DATABASE() d');
  if (ORIGEN === DESTINO) throw new Error('El origen y el destino son la misma base. Aborta.');

  const [tablas] = await pool.query(`
    SELECT table_name n FROM information_schema.tables
     WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`, [ORIGEN]);
  const nombres = tablas.map(t => t.n);
  const set = new Set(nombres);

  const faltantes = LISTA.filter(t => !set.has(t));
  const conDatos  = LISTA.filter(t => set.has(t));

  console.log(`\nOrigen : ${ORIGEN} (${nombres.length} tablas)`);
  console.log(`Destino: ${DESTINO}`);
  console.log(`  · estructura : ${nombres.length} tablas`);
  console.log(`  · con datos  : ${conDatos.length} (lista explícita)`);
  console.log(`  · vacías     : ${nombres.length - conDatos.length} (cartera, personas, movimientos, respaldos)`);
  if (faltantes.length) console.log(`  ⚠ en la lista pero NO existen en producción: ${faltantes.join(', ')}`);

  if (!EJECUTAR) {
    for (const [grupo, ts] of Object.entries(CON_DATOS))
      console.log(`\n${grupo}:\n   ${ts.filter(t => set.has(t)).join(', ')}`);
    console.log('\n[SIMULACIÓN] No se creó nada. Corre con --ejecutar para aplicar.\n');
    process.exit(0);
  }

  if (RECREAR) { await pool.query(`DROP DATABASE IF EXISTS \`${DESTINO}\``); console.log(`✓ ${DESTINO} eliminada`); }
  await pool.query(`CREATE DATABASE IF NOT EXISTS \`${DESTINO}\` DEFAULT CHARACTER SET utf8mb4`);
  console.log(`✓ ${DESTINO} creada\n`);

  /* ── Estructura de TODAS las tablas ─────────────────────────────────────────
     En PASADAS: una tabla con clave foránea no se puede crear antes que la tabla
     a la que apunta (comunas→provincias→regiones). En vez de ordenar el grafo de
     dependencias a mano, se repite la pasada hasta que un ciclo completo no cree
     ninguna tabla nueva. Es el mismo gotcha de claves foráneas que apareció al
     restaurar el respaldo en Google Cloud SQL. */
  let hechas = 0; let pendientes = nombres.slice(); const fallidas = [];
  for (let pasada = 1; pendientes.length && pasada <= 10; pasada++) {
    const quedan = [];
    for (const n of pendientes) {
      const [[ddl]] = await pool.query(`SHOW CREATE TABLE \`${ORIGEN}\`.\`${n}\``);
      const sql = ddl['Create Table'].replace(/^CREATE TABLE `/, `CREATE TABLE IF NOT EXISTS \`${DESTINO}\`.\``);
      try { await pool.query(sql); hechas++; }
      catch (e) { quedan.push(n); fallidas.push(`${n}: ${e.message}`); }
    }
    if (quedan.length === pendientes.length) break;    // otra pasada no ayudaría
    pendientes = quedan;
    if (pendientes.length) console.log(`  … pasada ${pasada}: quedan ${pendientes.length} por claves foráneas`);
  }
  console.log(`✓ Estructura: ${hechas}/${nombres.length} tablas`);
  if (pendientes.length) {
    console.log('  ✗ no se pudieron crear:');
    pendientes.forEach(n => console.log('    ' + (fallidas.filter(f => f.startsWith(n + ':')).pop() || n)));
  }

  /* ── Datos, con contacto enmascarado ────────────────────────────────────────
     UNA sola conexión con las claves foráneas desactivadas. Sin esto, el orden
     de la lista importaba: `usuarios` se copiaba antes que `perfiles`, la FK
     fallaba y el INSERT IGNORE descartaba las 40 filas EN SILENCIO — el script
     informaba "40 filas" y la tabla quedaba vacía. De ahí la verificación de
     conteos al final: acá nada se puede perder sin que se note. */
  const hashStaging = bcrypt.hashSync(CLAVE, 10);
  let totalFilas = 0; const copiadas = [], vacias = [], errores = [];
  const cx = await pool.getConnection();
  await cx.query('SET FOREIGN_KEY_CHECKS = 0');

  for (const n of conDatos) {
    /* La metadata manda sobre el nombre de la columna, por dos motivos:
       · las columnas GENERADAS (rut_cuerpo, rut_dv) las calcula la base y no
         admiten un valor en el INSERT;
       · `password_updated_at` es una FECHA, no una clave: enmascararla por su
         nombre metía un hash de bcrypt en una columna DATETIME. */
    const [meta] = await pool.query(
      `SELECT column_name c, data_type t, extra e FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?`, [ORIGEN, n]);
    const generadas = new Set(meta.filter(m => /GENERATED/i.test(m.e || '')).map(m => m.c));
    const texto = new Set(meta.filter(m => /char|text/i.test(m.t)).map(m => m.c));
    // mysql2 entrega las columnas JSON ya parseadas como objeto: hay que volver a
    // serializarlas o el INSERT recibe "[object Object]" y la base lo rechaza.
    const json = new Set(meta.filter(m => /json/i.test(m.t)).map(m => m.c));

    const [filas] = await pool.query(`SELECT * FROM \`${ORIGEN}\`.\`${n}\``);
    if (!filas.length) { vacias.push(n); continue; }
    const cols = Object.keys(filas[0]).filter(c => !generadas.has(c));
    const mask = {};
    cols.forEach(c => {
      if (!texto.has(c)) return;                       // solo se enmascara texto
      /* OJO: en este código `clave` casi siempre significa LLAVE, no contraseña
         — las tablas de configuración son (clave, valor). Enmascarar por el
         nombre `clave` reemplazaba la LLAVE de cada parámetro por un hash y
         dejaba inservibles config_sistema, cobranza_config y compañía. Solo se
         enmascara lo que de verdad guarda una contraseña. */
      if (/password/i.test(c) || /(^|_)hash$/i.test(c)) mask[c] = 'clave';
      else if (esCorreo(c))   mask[c] = 'correo';
      else if (esTelefono(c)) mask[c] = 'fono';
    });

    try {
      for (let i = 0; i < filas.length; i += 200) {
        const lote = filas.slice(i, i + 200).map((r, k) => {
          /* El correo enmascarado lleva número de fila porque `usuarios.email`
             es UNIQUE: una sola dirección para todos rompía el INSERT. Todos
             llegan igual a la casilla de staging (subdirección con +). */
          const nro = i + k;
          return '(' + cols.map(c => {
            const v = r[c];
            if (mask[c] === 'clave')  return esc(hashStaging);      // nunca un hash de producción
            if (v == null || v === '') return esc(v);
            if (mask[c] === 'correo') return `'staging+${nro}@autofacilchile.cl'`;
            if (mask[c] === 'fono')   return `'+56900000000'`;
            if (json.has(c))          return esc(typeof v === 'string' ? v : JSON.stringify(v));
            return esc(v);
          }).join(',') + ')';
        }).join(',');
        await cx.query(
          `INSERT INTO \`${DESTINO}\`.\`${n}\` (${cols.map(c => '`' + c + '`').join(',')}) VALUES ${lote}`);
      }
    } catch (e) {
      // Una tabla que falla no puede tumbar el resto: se anota y se sigue.
      errores.push(`${n}: ${e.message}`);
      continue;
    }
    // Verificación: lo que quedó en destino debe ser lo que se leyó del origen.
    const [[chk]] = await cx.query(`SELECT COUNT(*) n FROM \`${DESTINO}\`.\`${n}\``);
    if (Number(chk.n) !== filas.length)
      errores.push(`${n}: se leyeron ${filas.length} filas pero quedaron ${chk.n}`);
    totalFilas += filas.length;
    copiadas.push({ n, filas: filas.length, mask: Object.keys(mask) });
  }
  await cx.query('SET FOREIGN_KEY_CHECKS = 1');
  cx.release();

  console.log('\nDatos copiados:');
  copiadas.sort((a, b) => b.filas - a.filas).forEach(c =>
    console.log(`   ${c.n.padEnd(34)} ${String(c.filas).padStart(6)} filas` +
                (c.mask.length ? `  · enmascarado: ${c.mask.join(', ')}` : '')));
  if (errores.length) {
    console.log('\n✗ Tablas que NO se pudieron copiar:');
    errores.forEach(e => console.log('   ' + e));
  }
  if (vacias.length) console.log(`\n(${vacias.length} tablas de la lista estaban vacías en producción: ${vacias.join(', ')})`);

  console.log(`\n✓ ${DESTINO} lista — ${hechas} tablas, ${totalFilas.toLocaleString('es-CL')} filas.`);
  console.log(`  Todos los usuarios entran con la clave: ${CLAVE}`);
  console.log('  La cartera queda vacía a propósito: la QA crea sus propios casos.');
  console.log(`\nEn Render (servicio staging): DB_NAME=${DESTINO} · ENTORNO=staging · JWT_SECRET distinto al de producción.\n`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
