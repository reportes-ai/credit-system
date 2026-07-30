'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   UPTIME POR SERVICIO — historia para la card de Mantenedores
   Los datos los produce el motor único shared/uptime.js (checks cada 5 min en
   `uptime_checks`); acá solo se LEEN: resumen + serie diaria para los gráficos
   estilo status-page (evidencia de disponibilidad para la casa matriz).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const uptime = require('../../../../shared/uptime');

const DIAS = 90;          // ventana de la serie diaria (calza con la retención del motor)
const BUCKETS_DIA = 288;  // checks esperados por día (cada 5 min)

/* Recién desplegado: la fila de migraciones (shared/migrate) aún no crea las tablas.
   Un request que cae en esa ventana NO es un error del sistema — responder "preparando"
   en vez de 500 evita el correo de alerta en cada deploy. */
const TABLA_FALTA = (e) => e && (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE');
const preparando = (res, que) => res.status(200).json({
  success: true, data: { preparando: true, mensaje: `Preparando ${que}: el monitor se está inicializando tras el despliegue. Recarga en un minuto.` }, error: null,
});

/* ── Card en Mantenedores ── */
require('../../../../shared/migrate').enFila('uptime-card', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (!mod) return;
    let [[f]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='uptime_mant' LIMIT 1");
    if (!f) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?, 'Salud y Uptime', 'uptime_mant', '/mantenedores/uptime/', 'bi-activity')",
        [mod.id_modulo]);
      f = { id_funcionalidad: r.insertId };
    }
    await pool.query("UPDATE funcionalidades SET nombre='Salud y Uptime' WHERE codigo='uptime_mant' AND nombre<>'Salud y Uptime'");
    await pool.query(`INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                      SELECT p.id_perfil, ?, 1 FROM perfiles p
                      WHERE (p.nombre = 'Administrador' OR p.nombre LIKE 'Gerente%' OR p.nombre LIKE 'Director%')
                        AND NOT EXISTS (SELECT 1 FROM permisos_perfil pp WHERE pp.id_perfil=p.id_perfil AND pp.id_funcionalidad=?)`,
                     [f.id_funcionalidad, f.id_funcionalidad]);
  } catch (e) { console.error('[uptime card migration]', e.message); }
});

/* Gastos mensuales por servicio — bloque propio para que un tropiezo en la card
   no impida crear la tabla (paramétrico; NO inventar montos: lo no medido nace NULL) */
require('../../../../shared/migrate').enFila('servicios-costos', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS servicios_costos (
      codigo VARCHAR(30) PRIMARY KEY,
      nombre VARCHAR(120) NOT NULL,
      costo_mensual DECIMAL(12,2) NULL,
      moneda VARCHAR(5) NOT NULL DEFAULT 'USD',
      es_variable TINYINT NOT NULL DEFAULT 0,       -- 1 = depende del uso (IA, WhatsApp)
      nota VARCHAR(300) NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    // Si la tabla nació en v163.9 con la columna `variable`, homologar ANTES del seed
    await pool.query('ALTER TABLE servicios_costos RENAME COLUMN variable TO es_variable').catch(() => {});
    const COSTOS_SEED = [
      // [codigo, nombre, costo, moneda, variable, nota]  — solo montos ya medidos; el resto por confirmar en su panel
      ['render',    'Render (hosting de la app)',            null, 'USD', 0, 'Confirmar plan en dashboard.render.com'],
      ['tidb',      'TiDB Cloud (base de datos)',            null, 'USD', 0, 'Confirmar plan en tidbcloud.com'],
      ['cloudsql',  'Google Cloud SQL (contingencia BD)',    2.40, 'USD', 0, 'Instancia DETENIDA; encendida ≈ US$4,8/día'],
      ['gcs',       'Bucket GCS (respaldos)',                0.05, 'USD', 0, 'Storage de respaldos'],
      ['ia',        'Claude / Anthropic (IA)',               null, 'USD', 1, 'Se calcula EN VIVO desde ia_uso (mes en curso)'],
      ['meta',      'Meta WhatsApp (Facilito)',              null, 'USD', 1, 'Por conversación; confirmar en Business Manager'],
      ['brevo',     'Brevo (correo transaccional)',          null, 'USD', 0, 'Confirmar plan en app.brevo.com'],
      ['dealernet', 'DealerNet (central de información)',    null, 'CLP', 1, 'Por consulta; confirmar con proveedor'],
      ['simpleapi', 'SimpleAPI (RCV SII)',                   0.00, 'CLP', 0, 'Plan gratis (libro cada 2 días)'],
      ['workera',   'Workera (reloj control)',               null, 'CLP', 0, 'Confirmar plan contratado'],
      ['dominio',   'Dominio NIC Chile',                     null, 'CLP', 0, 'Renovación anual; prorratear mensual'],
    ];
    for (const c of COSTOS_SEED)
      await pool.query('INSERT IGNORE INTO servicios_costos (codigo, nombre, costo_mensual, moneda, es_variable, nota) VALUES (?,?,?,?,?,?)', c);

    /* Qué hace cada servicio y qué pasa si se cae — en lenguaje de negocio.
       El texto vive acá (código = fuente) y se refresca en cada arranque con UPDATE,
       para que la explicación nunca quede desactualizada respecto de la realidad. */
    await pool.query('ALTER TABLE servicios_costos ADD COLUMN IF NOT EXISTS que_hace VARCHAR(600) NULL').catch(() => {});
    await pool.query('ALTER TABLE servicios_costos ADD COLUMN IF NOT EXISTS si_falla VARCHAR(400) NULL').catch(() => {});
    const EXPLICA = [
      ['render',
       'Es el computador donde vive la aplicación: un servidor físico en un datacenter de Oregon (EE.UU.) del que arrendamos una porción (memoria y CPU). Cada vez que se sube un cambio a GitHub, Render lo compila y lo deja andando; además entrega la dirección pública y el certificado HTTPS. NO guarda los datos — esos viven en TiDB.',
       'El sistema queda fuera de línea, pero no se pierde ningún dato. Es el único hueco sin plan de contingencia probado.'],
      ['tidb',
       'La base de datos en la nube: acá viven de verdad los créditos, clientes, cobranza y la contabilidad. La aplicación solo los lee y escribe; el dato autoritativo está siempre aquí.',
       'La aplicación responde pero sin información (pantallas vacías o error). Hay contingencia probada en Google Cloud SQL.'],
      ['cloudsql',
       'Copia de contingencia de la base de datos en Google. Está APAGADA a propósito: solo se enciende si TiDB falla, y por eso cuesta casi nada estando detenida.',
       'Se pierde el plan B de la base de datos; la operación normal no se ve afectada.'],
      ['gcs',
       'El bucket de Google donde se guardan los respaldos nocturnos de la base de datos.',
       'Dejan de guardarse respaldos nuevos (los existentes siguen ahí). No afecta la operación diaria.'],
      ['ia',
       'Claude (Anthropic) es el motor de inteligencia artificial: analiza informes comerciales de DealerNet, redacta el resumen ejecutivo diario, revisa liquidaciones y responde consultas. Se paga por uso real, no por plan fijo.',
       'Las pantallas con IA dejan de generar análisis; todo el resto del sistema funciona igual.'],
      ['meta',
       'La API de WhatsApp de Meta que mueve a "Facilito": avisos de cobranza, seguimiento de cartas y atención automática a clientes y dealers. Se cobra por conversación.',
       'No salen ni llegan WhatsApp. La cobranza por correo y el sistema siguen funcionando.'],
      ['brevo',
       'El servicio que envía todos los correos del sistema: cartas, certificados, órdenes de pago, informes programados y alertas.',
       'El sistema funciona pero nadie recibe correos — incluidas las alertas de error.'],
      ['dealernet',
       'La central de información comercial: se le consulta por RUT para traer los antecedentes del cliente que alimentan la evaluación crediticia y el scorecard.',
       'No se pueden pedir informes nuevos; los ya guardados en el repositorio siguen disponibles.'],
      ['simpleapi',
       'Trae automáticamente desde el SII el libro de compras (RCV) cada dos días, para que la contabilidad no se digite a mano.',
       'Hay que cargar el libro de compras manualmente. No detiene la operación.'],
      ['workera',
       'El reloj control del personal: entrega las marcas de entrada y salida que usa Recursos Humanos para asistencia y remuneraciones.',
       'No se actualizan las marcas; las remuneraciones tendrían que revisarse a mano.'],
      ['dominio',
       'El nombre autofacilchile.cl inscrito en NIC Chile. Es la dirección por la que todos entran al sistema.',
       'Si vence, el sistema deja de ser alcanzable por su nombre aunque el servidor esté sano. Renovación anual.'],
    ];
    for (const [cod, que, falla] of EXPLICA)
      await pool.query('UPDATE servicios_costos SET que_hace=?, si_falla=? WHERE codigo=?', [que, falla, cod]);
    // TiDB cobra por uso (request units + almacenamiento), no plan fijo → es variable.
    // es_variable lo manda el código (no se edita en la UI); el monto y la nota son de Pato.
    await pool.query("UPDATE servicios_costos SET es_variable=1 WHERE codigo='tidb'");
  } catch (e) { console.error('[servicios_costos migration]', e.message); }
});

/* GET /api/uptime/historia → resumen por servicio + serie diaria (90 días) */
const historia = async (req, res) => {
  try {
    const resumen = await uptime.resumen();   // motor único: % 24h/7d/30d, latencia, última falla

    // Semáforo de salud EN VIVO — mismo motor que el correo Salud del Sistema (Máxima 1)
    let salud = [];
    try { salud = await require('../../../correos-programados/src/controllers/correos.controller')._saludChecks(); }
    catch (e) { console.error('[uptime saludChecks]', e.message); }

    // Serie diaria por servicio
    const [dias] = await pool.query(`
      SELECT codigo, DATE_FORMAT(fecha, '%Y-%m-%d') dia,
             ROUND(100*AVG(ok), 2) pct, COUNT(*) checks,
             ROUND(AVG(CASE WHEN ok=1 THEN ms END)) ms
      FROM uptime_checks WHERE fecha >= CURDATE() - INTERVAL ? DAY
      GROUP BY codigo, DATE_FORMAT(fecha, '%Y-%m-%d') ORDER BY dia`, [DIAS - 1]);
    const seriePor = {};
    dias.forEach(d => (seriePor[d.codigo] = seriePor[d.codigo] || []).push(d));

    // % 90 días por servicio (la ventana completa de retención)
    const [p90s] = await pool.query(
      'SELECT codigo, ROUND(100*AVG(ok),2) p90 FROM uptime_checks GROUP BY codigo');
    const p90Por = Object.fromEntries(p90s.map(x => [x.codigo, x.p90]));

    // Serie diaria de la APP (Render), medida por omisión: buckets de 5 min con
    // al menos un check vs los 288 esperados del día (el día de hoy se escala
    // a los buckets transcurridos para no castigar el día en curso).
    const [appDias] = await pool.query(`
      SELECT DATE_FORMAT(fecha, '%Y-%m-%d') dia,
             COUNT(DISTINCT FLOOR(UNIX_TIMESTAMP(fecha)/300)) hechos
      FROM uptime_checks WHERE fecha >= CURDATE() - INTERVAL ? DAY
      GROUP BY DATE_FORMAT(fecha, '%Y-%m-%d') ORDER BY dia`, [DIAS - 1]);
    const hoy = new Date().toISOString().slice(0, 10);
    const buckHoy = Math.max(1, Math.floor((Date.now() - new Date(hoy + 'T00:00:00').getTime()) / 300000));
    const appSerie = appDias.map(d => ({
      dia: d.dia,
      pct: Math.min(100, Math.round(10000 * d.hechos / (d.dia === hoy ? buckHoy : BUCKETS_DIA)) / 100),
    }));

    res.json({
      success: true, error: null,
      data: {
        cada_min: resumen.cada_min, dias: DIAS, salud,
        app: { ...resumen.app, serie: appSerie },
        servicios: resumen.servicios.map(s => ({ ...s, p90: p90Por[s.codigo] != null ? p90Por[s.codigo] : null, serie: seriePor[s.codigo] || [] })),
      },
    });
  } catch (e) {
    if (TABLA_FALTA(e)) return preparando(res, 'el historial de uptime');
    console.error('[uptime historia]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* GET /api/uptime/costos → gastos mensuales por servicio (IA en vivo desde ia_uso) */
const costosGet = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM servicios_costos ORDER BY nombre');
    // Gasto IA del mes EN VIVO (misma fuente que Salud del Sistema: ia_uso)
    let iaVivo = null;
    try {
      const [[ia]] = await pool.query("SELECT ROUND(COALESCE(SUM(costo_usd),0),2) usd, COUNT(*) n FROM ia_uso WHERE fecha>=DATE_FORMAT(CURDATE(),'%Y-%m-01')");
      iaVivo = { usd: Number(ia.usd), n: ia.n };
    } catch (_) {}
    const data = rows.map(r => r.codigo === 'ia' && iaVivo
      ? { ...r, costo_mensual: iaVivo.usd, en_vivo: true, nota: `${iaVivo.n} análisis del mes en curso (ia_uso) — se actualiza solo` }
      : { ...r, en_vivo: false });
    const totales = {};
    for (const r of data) if (r.costo_mensual != null)
      totales[r.moneda] = Math.round(((totales[r.moneda] || 0) + Number(r.costo_mensual)) * 100) / 100;
    const por_confirmar = data.filter(r => r.costo_mensual == null).length;
    res.json({ success: true, data: { items: data, totales, por_confirmar }, error: null });
  } catch (e) {
    if (TABLA_FALTA(e)) return preparando(res, 'la tabla de gastos por servicio');
    console.error('[uptime costos]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* PUT /api/uptime/costos/:codigo { costo_mensual, moneda, nota } */
const costosSet = async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT codigo, nombre FROM servicios_costos WHERE codigo=?', [req.params.codigo]);
    if (!r) return res.status(404).json({ success: false, data: null, error: 'Servicio desconocido' });
    if (r.codigo === 'ia') return res.status(400).json({ success: false, data: null, error: 'El gasto IA se calcula en vivo desde ia_uso — no se digita.' });
    const costo = req.body.costo_mensual === null || req.body.costo_mensual === '' ? null : Number(req.body.costo_mensual);
    if (costo != null && !(costo >= 0)) return res.status(400).json({ success: false, data: null, error: 'Costo inválido' });
    const moneda = ['USD', 'CLP'].includes(req.body.moneda) ? req.body.moneda : 'USD';
    const nota = String(req.body.nota || '').slice(0, 300) || null;
    await pool.query('UPDATE servicios_costos SET costo_mensual=?, moneda=?, nota=? WHERE codigo=?', [costo, moneda, nota, r.codigo]);
    require('../../../../shared/audit').auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'servicio_costo',
      entidad_id: r.codigo, detalle: `Costo mensual de "${r.nombre}": ${costo == null ? 'por confirmar' : costo + ' ' + moneda}` });
    res.json({ success: true, data: { codigo: r.codigo }, error: null });
  } catch (e) { console.error('[uptime costosSet]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { historia, costosGet, costosSet };
