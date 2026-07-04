'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   CAMPAÑAS MASIVAS — Mail y WhatsApp, de Venta (marketing) y de Cobranza.
   - Campaña con correlativo único CM-####, fecha, descripción y hasta 10
     campos variables (catálogo CAMPOS) que definen la plantilla de carga.
   - Data MANUAL (Excel/CSV) o POR PARÁMETROS desde nuestras bases (mora,
     capital, término de crédito, renta…). Exclusión por región y grupo de
     CONTROL por deciles del RUT (champion–challenger).
   - Envío real: Mail via shared/mailer (respeta Modo Desarrollo); WhatsApp
     via Meta Cloud API (texto — fuera de ventana 24h requiere plantilla HSM).
   - Conversión: VENTA cruza con créditos otorgados post-envío; COBRANZA con
     pagos de cuotas post-envío. Todo queda como gestión en el CRM.
   ───────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Catálogo ÚNICO de campos variables (backend = fuente de verdad) ────── */
const CAMPOS = [
  { key: 'rut',             label: 'RUT',                    ejemplo: '12.345.678-9' },
  { key: 'nombre',          label: 'Nombre',                 ejemplo: 'María' },
  { key: 'ap_paterno',      label: 'Apellido Paterno',       ejemplo: 'González' },
  { key: 'ap_materno',      label: 'Apellido Materno',       ejemplo: 'Pérez' },
  { key: 'genero',          label: 'Género',                 ejemplo: 'F' },
  { key: 'saludo',          label: 'Saludo',                 ejemplo: 'Estimada' },
  { key: 'monto_credito',   label: 'Monto del Crédito $',    ejemplo: '8500000', num: true },
  { key: 'pie_monto',       label: 'Pie Requerido $',        ejemplo: '2000000', num: true },
  { key: 'pie_pct',         label: 'Pie Requerido %',        ejemplo: '25', num: true },
  { key: 'cuotas',          label: 'Cuotas del Crédito',     ejemplo: '36', num: true },
  { key: 'tasa',            label: 'Tasa del Crédito %',     ejemplo: '2,1', num: true },
  { key: 'valor_cuota',     label: 'Valor Cuota',            ejemplo: '285000', num: true },
  { key: 'seg_desgravamen', label: 'Seguro de Desgravamen',  ejemplo: '12500', num: true },
  { key: 'seg_cesantia',    label: 'Seguro de Cesantía',     ejemplo: '9800', num: true },
  { key: 'seg_rdh',         label: 'Seguro RDH',             ejemplo: '7400', num: true },
  { key: 'esp1',            label: 'Dato Especial 1',        ejemplo: 'texto libre' },
  { key: 'esp2',            label: 'Dato Especial 2',        ejemplo: 'texto libre' },
  { key: 'esp3',            label: 'Dato Especial 3',        ejemplo: 'texto libre' },
];
const CAMPO_KEYS = CAMPOS.map(c => c.key);

/* ── Migración ──────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campanas_masivas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        correlativo VARCHAR(20) NOT NULL UNIQUE,
        canal VARCHAR(6) NOT NULL,               -- MAIL | WSP
        objetivo VARCHAR(10) NOT NULL,           -- VENTA | COBRANZA
        descripcion VARCHAR(300) NOT NULL,
        estado VARCHAR(15) NOT NULL DEFAULT 'BORRADOR',   -- BORRADOR | ENVIADA | CERRADA
        origen_data VARCHAR(12) NOT NULL DEFAULT 'MANUAL', -- MANUAL | PARAMETROS
        campos JSON NULL,
        texto TEXT NULL,
        asunto VARCHAR(300) NULL,
        remitente VARCHAR(60) NULL,
        plantilla VARCHAR(20) NULL DEFAULT 'banner',       -- banner | logo | titulo
        titulo VARCHAR(200) NULL,
        color_titulo VARCHAR(9) NULL DEFAULT '#0141A2',
        parametros JSON NULL,
        deciles_control JSON NULL,
        excluir_regiones JSON NULL,
        analizar_ia TINYINT(1) NOT NULL DEFAULT 0,
        es_test TINYINT(1) NOT NULL DEFAULT 0,
        enviada_at DATETIME NULL,
        created_by INT NULL, created_nombre VARCHAR(120) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campanas_destinatarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_campana INT NOT NULL,
        rut VARCHAR(15) NULL, nombre VARCHAR(120) NULL,
        ap_paterno VARCHAR(80) NULL, ap_materno VARCHAR(80) NULL,
        genero VARCHAR(12) NULL, saludo VARCHAR(40) NULL,
        email VARCHAR(200) NULL, telefono VARCHAR(20) NULL,
        monto_credito DECIMAL(15,2) NULL, pie_monto DECIMAL(15,2) NULL, pie_pct DECIMAL(8,2) NULL,
        cuotas INT NULL, tasa DECIMAL(8,4) NULL, valor_cuota DECIMAL(15,2) NULL,
        seg_desgravamen DECIMAL(15,2) NULL, seg_cesantia DECIMAL(15,2) NULL, seg_rdh DECIMAL(15,2) NULL,
        esp1 VARCHAR(250) NULL, esp2 VARCHAR(250) NULL, esp3 VARCHAR(250) NULL,
        decil TINYINT NULL,
        grupo VARCHAR(10) NOT NULL DEFAULT 'CAMPANA',      -- CAMPANA | CONTROL
        estado VARCHAR(15) NOT NULL DEFAULT 'PENDIENTE',   -- PENDIENTE|ENVIADO|ERROR|LEIDO|NO_RECIBIDO
        error_msg VARCHAR(300) NULL,
        enviado_at DATETIME NULL, leido_at DATETIME NULL,
        convertido TINYINT(1) NOT NULL DEFAULT 0,
        convertido_at DATETIME NULL, dias_a_conversion INT NULL, monto_convertido DECIMAL(15,2) NULL,
        riesgo_ia VARCHAR(10) NULL,                        -- BAJO | MEDIO | ALTO
        renta DECIMAL(15,2) NULL,                          -- registrada o estimada (para análisis de política)
        renta_estimada TINYINT(1) NOT NULL DEFAULT 0,
        politica VARCHAR(12) NULL,                         -- CUMPLE | NO_CUMPLE | S/I
        contactos_dn JSON NULL,                            -- candidatos de contacto desde DealerNet
        telefonos_alt JSON NULL,                           -- teléfonos alternativos seleccionados (WSP)
        INDEX idx_camp (id_campana), INDEX idx_camp_estado (id_campana, estado)
      )`);

    for (const col of ["renta DECIMAL(15,2) NULL", "renta_estimada TINYINT(1) NOT NULL DEFAULT 0",
                       "politica VARCHAR(12) NULL", "contactos_dn JSON NULL", "telefonos_alt JSON NULL"]) {
      await pool.query(`ALTER TABLE campanas_destinatarios ADD COLUMN IF NOT EXISTS ${col}`);
    }

    // Card en el Home (anti-hardcode: módulo + funcionalidad + permiso Admin)
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (460001, 'Campañas Masivas', 'Campañas de Mail y WhatsApp: ventas y cobranza con medición de conversión', 'bi-megaphone-fill', '/campanas-masivas/', 116, 'activo')`);
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='campanas_masivas' LIMIT 1");
    let idFunc = ex && ex.id_funcionalidad;
    if (!idFunc) {
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
         VALUES (460001, 'Campañas Masivas', 'campanas_masivas', '/campanas-masivas/', 'bi-megaphone-fill')`);
      idFunc = r.insertId;
    }
    const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idFunc]);
    if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idFunc]);

    await seedCampanasTest();
    console.log('[campanas-masivas] módulo listo');
  } catch (e) { console.error('[campanas-masivas migration]', e.message); }
})();

/* ── Seed: 4 "Campaña TEST" (mail/wsp × venta/cobranza) con datos inventados ── */
async function seedCampanasTest() {
  const [[ya]] = await pool.query("SELECT COUNT(*) n FROM campanas_masivas WHERE es_test=1");
  if (ya.n) return;

  const NOMBRES = ['María', 'José', 'Camila', 'Felipe', 'Valentina', 'Diego', 'Fernanda', 'Matías', 'Carolina', 'Sebastián', 'Javiera', 'Cristóbal', 'Antonia', 'Ignacio', 'Constanza', 'Rodrigo', 'Daniela', 'Pablo', 'Francisca', 'Andrés'];
  const APELLIDOS = ['González', 'Muñoz', 'Rojas', 'Díaz', 'Pérez', 'Soto', 'Contreras', 'Silva', 'Martínez', 'Sepúlveda', 'Morales', 'Rodríguez', 'López', 'Fuentes', 'Hernández', 'Torres', 'Araya', 'Flores', 'Espinoza', 'Valenzuela'];
  // pseudo-aleatorio determinístico (sin Math.random para reproducibilidad)
  let semilla = 42;
  const rnd = (n) => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla % n; };

  const DEFS = [
    { canal: 'MAIL', objetivo: 'VENTA',    desc: 'Campaña TEST — Renueva tu auto (mail)',        asunto: '🚗 {{nombre}}, renueva tu auto con AutoFácil', conv: 0.14 },
    { canal: 'WSP',  objetivo: 'VENTA',    desc: 'Campaña TEST — Renueva tu auto (WhatsApp)',    asunto: null, conv: 0.19 },
    { canal: 'MAIL', objetivo: 'COBRANZA', desc: 'Campaña TEST — Ponte al día (mail)',           asunto: '📌 {{saludo}} {{ap_paterno}}: regulariza tu cuota', conv: 0.27 },
    { canal: 'WSP',  objetivo: 'COBRANZA', desc: 'Campaña TEST — Ponte al día (WhatsApp)',       asunto: null, conv: 0.33 },
  ];
  let corr = 0;
  for (const d of DEFS) {
    corr++;
    const campos = d.objetivo === 'VENTA'
      ? ['rut', 'nombre', 'ap_paterno', 'saludo', 'monto_credito', 'cuotas', 'valor_cuota', 'esp1']
      : ['rut', 'nombre', 'ap_paterno', 'saludo', 'valor_cuota', 'esp1', 'esp2'];
    const texto = d.objetivo === 'VENTA'
      ? '{{saludo}} {{nombre}} {{ap_paterno}}:\n\nTu próximo auto está más cerca de lo que crees 🚗✨. Tenemos preaprobado para ti un crédito de {{monto_credito}} en {{cuotas}} cuotas de {{valor_cuota}}.\n\n{{esp1}}\n\nResponde este mensaje o escríbenos al +56 9 3246 9071 y un Ejecutivo Comercial te contactará.\n\nEquipo AutoFácil'
      : '{{saludo}} {{nombre}} {{ap_paterno}}:\n\nQueremos ayudarte a ponerte al día 💪. Tu cuota de {{valor_cuota}} está pendiente ({{esp1}}).\n\n{{esp2}}\n\nPaga hoy y evita gastos de cobranza. ¿Dudas? Escríbenos al +56 9 3246 9071.\n\nEquipo AutoFácil';
    const enviadaHace = 12 + corr; // días atrás
    const [rc] = await pool.query(`
      INSERT INTO campanas_masivas
        (correlativo, canal, objetivo, descripcion, estado, origen_data, campos, texto, asunto, remitente,
         plantilla, titulo, color_titulo, deciles_control, excluir_regiones, analizar_ia, es_test, enviada_at, created_nombre)
      VALUES (?,?,?,?, 'ENVIADA', 'PARAMETROS', ?, ?, ?, 'contacto',
              ?, ?, '#0141A2', ?, ?, 0, 1, DATE_SUB(NOW(), INTERVAL ? DAY), 'Business Suite (seed)')`,
      [`CM-${String(corr).padStart(4, '0')}`, d.canal, d.objetivo, d.desc,
       JSON.stringify(campos), texto, d.asunto,
       d.canal === 'MAIL' ? 'banner' : null,
       d.objetivo === 'VENTA' ? '¡Es hora de renovar tu auto!' : 'Ponte al día con AutoFácil',
       JSON.stringify([8, 9]), JSON.stringify([]), enviadaHace]);
    const idCamp = rc.insertId;

    const filas = [];
    const nDest = 120 + rnd(40);
    for (let i = 0; i < nDest; i++) {
      const cuerpo = 8000000 + rnd(14000000);
      const decil = cuerpo % 10;
      const grupo = (decil === 8 || decil === 9) ? 'CONTROL' : 'CAMPANA';
      const nombre = NOMBRES[rnd(NOMBRES.length)];
      const apP = APELLIDOS[rnd(APELLIDOS.length)], apM = APELLIDOS[rnd(APELLIDOS.length)];
      const fem = rnd(2) === 0;
      const monto = 4000000 + rnd(9000000);
      const cuotas = [24, 36, 48][rnd(3)];
      const vc = Math.round(monto * 0.036);
      // estados: control queda PENDIENTE (no se envía); campaña 90% ENVIADO
      let estado = 'PENDIENTE', err = null, leido = null, envAt = null;
      if (grupo === 'CAMPANA') {
        const dice = rnd(100);
        if (dice < 4) { estado = 'ERROR'; err = d.canal === 'MAIL' ? 'Casilla inexistente (bounce)' : 'Número no tiene WhatsApp'; }
        else if (dice < 8) { estado = 'NO_RECIBIDO'; }
        else if (dice < 62) { estado = 'LEIDO'; leido = enviadaHace - 1; }
        else estado = 'ENVIADO';
        envAt = enviadaHace;
      }
      // conversión solo entre leídos/enviados; algo de conversión natural en control
      let conv = 0, convDias = null, convMonto = null;
      const base = (estado === 'LEIDO') ? d.conv * 1.6 : (estado === 'ENVIADO' ? d.conv * 0.7 : 0);
      const pConv = grupo === 'CONTROL' ? d.conv * 0.30 : base;
      if (rnd(1000) < pConv * 1000) {
        conv = 1; convDias = rnd(12); convMonto = d.objetivo === 'VENTA' ? monto : vc;
      }
      filas.push([idCamp, `${cuerpo}-${dvRut(cuerpo)}`, nombre, apP, apM, fem ? 'F' : 'M', fem ? 'Estimada' : 'Estimado',
        `${nombre.toLowerCase()}.${apP.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}@ejemplo.cl`,
        `+5699${String(1000000 + rnd(8999999))}`,
        monto, Math.round(monto * 0.3), 30, cuotas, 2.05, vc, 12500, 9800, 7400,
        d.objetivo === 'VENTA' ? 'Oferta válida hasta fin de mes' : `${1 + rnd(3)} cuota(s) pendiente(s)`,
        d.objetivo === 'COBRANZA' ? 'Paga en autofacilchile.cl o en nuestras cajas' : null, null,
        decil, grupo, estado, err,
        envAt, leido, conv, conv ? convDias : null, conv ? convDias : null, convMonto]);
    }
    await pool.query(`
      INSERT INTO campanas_destinatarios
        (id_campana, rut, nombre, ap_paterno, ap_materno, genero, saludo, email, telefono,
         monto_credito, pie_monto, pie_pct, cuotas, tasa, valor_cuota, seg_desgravamen, seg_cesantia, seg_rdh,
         esp1, esp2, esp3, decil, grupo, estado, error_msg, enviado_at, leido_at,
         convertido, dias_a_conversion, convertido_at, monto_convertido)
      VALUES ${filas.map(() => `(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
        DATE_SUB(NOW(), INTERVAL ? DAY), IF(? IS NULL, NULL, DATE_SUB(NOW(), INTERVAL ? DAY)),
        ?, ?, IF(? IS NULL, NULL, DATE_SUB(NOW(), INTERVAL ? DAY)), ?)`).join(',')}
    `.replace(/\s+/g, ' '), filas.flatMap(f => {
      const [idc, rut, nom, ap, am, ge, sa, em, te, mo, pm, pp, cu, ta, vc2, sd, sc, sr, e1, e2, e3, de, gr, es, er, envAt, leidoAt, conv, convDias, convAt, convMonto] = f;
      return [idc, rut, nom, ap, am, ge, sa, em, te, mo, pm, pp, cu, ta, vc2, sd, sc, sr, e1, e2, e3, de, gr, es, er,
        envAt ?? 0, leidoAt, leidoAt ?? 0, conv, convDias, convAt, convAt ?? 0, convMonto];
    }));
    // los PENDIENTE sin envío (control) no llevan enviado_at
    await pool.query(`UPDATE campanas_destinatarios SET enviado_at=NULL WHERE id_campana=? AND estado='PENDIENTE'`, [idCamp]);
  }
  console.log('[campanas-masivas] 4 campañas TEST sembradas');
}

function dvRut(cuerpo) { let s = 1, m = 0; for (; cuerpo; cuerpo = Math.floor(cuerpo / 10)) s = (s + cuerpo % 10 * (9 - m++ % 6)) % 11; return s ? String(s - 1) : 'K'; }
const limpiaRut = r => String(r || '').replace(/[.\s-]/g, '').toUpperCase();
const decilDe = r => { const m = limpiaRut(r).match(/^(\d+)[\dK]$/); return m ? Number(m[1].slice(-1)) : null; };

/* ── Catálogo de campos + cuentas remitente + regiones ─────────────────── */
exports.catalogo = async (req, res) => {
  try {
    let cuentas = [];
    try { cuentas = require('../../../../shared/mailer').cuentasRemitente(); } catch (e) {}
    let regiones = [];
    try {
      const [r] = await pool.query('SELECT id_region AS id, nombre FROM regiones ORDER BY id_region');
      regiones = r;
    } catch (e) { /* sin tabla regiones */ }
    ok(res, { campos: CAMPOS, cuentas, regiones });
  } catch (e) { fail(res, e.message); }
};

/* ── CRUD campañas ──────────────────────────────────────────────────────── */
exports.listar = async (req, res) => {
  try {
    const { canal } = req.query;
    const [rows] = await pool.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM campanas_destinatarios d WHERE d.id_campana=c.id) destinatarios,
        (SELECT COUNT(*) FROM campanas_destinatarios d WHERE d.id_campana=c.id AND d.estado IN ('ENVIADO','LEIDO')) enviados,
        (SELECT COUNT(*) FROM campanas_destinatarios d WHERE d.id_campana=c.id AND d.estado='ERROR') errores,
        (SELECT COUNT(*) FROM campanas_destinatarios d WHERE d.id_campana=c.id AND d.convertido=1) conversiones
      FROM campanas_masivas c
      ${canal ? 'WHERE c.canal=?' : ''}
      ORDER BY c.id DESC LIMIT 200`, canal ? [canal] : []);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

exports.crear = async (req, res) => {
  try {
    const { canal, objetivo, descripcion } = req.body || {};
    if (!['MAIL', 'WSP'].includes(canal)) return fail(res, 'Canal inválido', 400);
    if (!['VENTA', 'COBRANZA'].includes(objetivo)) return fail(res, 'Objetivo inválido', 400);
    if (!descripcion || !String(descripcion).trim()) return fail(res, 'Falta la descripción', 400);
    const [[mx]] = await pool.query("SELECT COALESCE(MAX(CAST(SUBSTRING(correlativo,4) AS UNSIGNED)),0) n FROM campanas_masivas");
    const correlativo = 'CM-' + String(mx.n + 1).padStart(4, '0');
    const [r] = await pool.query(`
      INSERT INTO campanas_masivas (correlativo, canal, objetivo, descripcion, created_by, created_nombre)
      VALUES (?,?,?,?,?,?)`,
      [correlativo, canal, objetivo, String(descripcion).trim(), req.usuario.id_usuario, `${req.usuario.nombre} ${req.usuario.apellido || ''}`.trim()]);
    ok(res, { id: r.insertId, correlativo });
  } catch (e) { fail(res, e.message); }
};

exports.obtener = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const [[st]] = await pool.query(`
      SELECT COUNT(*) total,
        SUM(grupo='CONTROL') control,
        SUM(estado='PENDIENTE' AND grupo='CAMPANA') pendientes,
        SUM(estado IN ('ENVIADO','LEIDO')) enviados,
        SUM(estado='LEIDO') leidos,
        SUM(estado='ERROR') errores,
        SUM(estado='NO_RECIBIDO') no_recibidos,
        SUM(convertido=1) conversiones
      FROM campanas_destinatarios WHERE id_campana=?`, [c.id]);
    ok(res, { ...c, stats: st });
  } catch (e) { fail(res, e.message); }
};

const EDITABLES = ['descripcion', 'origen_data', 'campos', 'texto', 'asunto', 'remitente', 'plantilla', 'titulo', 'color_titulo', 'parametros', 'deciles_control', 'excluir_regiones', 'analizar_ia'];
exports.actualizar = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT estado FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'BORRADOR') return fail(res, 'Solo se edita una campaña en BORRADOR', 400);
    const sets = [], vals = [];
    for (const k of EDITABLES) {
      if (!(k in (req.body || {}))) continue;
      let v = req.body[k];
      if (k === 'campos') {
        v = (Array.isArray(v) ? v : []).filter(x => CAMPO_KEYS.includes(x)).slice(0, 10);
        v = JSON.stringify(v);
      } else if (['parametros', 'deciles_control', 'excluir_regiones'].includes(k)) v = JSON.stringify(v ?? null);
      else if (k === 'analizar_ia') v = v ? 1 : 0;
      sets.push(`${k}=?`); vals.push(v);
    }
    if (!sets.length) return fail(res, 'Nada que actualizar', 400);
    vals.push(req.params.id);
    await pool.query(`UPDATE campanas_masivas SET ${sets.join(',')} WHERE id=?`, vals);
    ok(res, { actualizado: true });
  } catch (e) { fail(res, e.message); }
};

exports.eliminar = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT estado, es_test FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'BORRADOR' && !c.es_test) return fail(res, 'Solo se elimina una campaña en BORRADOR', 400);
    await pool.query('DELETE FROM campanas_destinatarios WHERE id_campana=?', [req.params.id]);
    await pool.query('DELETE FROM campanas_masivas WHERE id=?', [req.params.id]);
    ok(res, { eliminado: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Carga MANUAL de destinatarios (filas ya parseadas por el frontend) ── */
exports.cargarDestinatarios = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'BORRADOR') return fail(res, 'La campaña ya fue enviada', 400);
    const filas = Array.isArray(req.body?.filas) ? req.body.filas.slice(0, 20000) : [];
    if (!filas.length) return fail(res, 'Sin filas', 400);
    const deciles = safeJSON(c.deciles_control) || [];
    await pool.query('DELETE FROM campanas_destinatarios WHERE id_campana=?', [c.id]);
    const cols = ['rut', 'nombre', 'ap_paterno', 'ap_materno', 'genero', 'saludo', 'email', 'telefono',
      'monto_credito', 'pie_monto', 'pie_pct', 'cuotas', 'tasa', 'valor_cuota', 'seg_desgravamen', 'seg_cesantia', 'seg_rdh', 'esp1', 'esp2', 'esp3'];
    const values = filas.map(f => {
      const decil = decilDe(f.rut);
      const grupo = (decil !== null && deciles.includes(decil)) ? 'CONTROL' : 'CAMPANA';
      return [c.id, ...cols.map(k => (f[k] === '' || f[k] === undefined) ? null : f[k]), decil, grupo];
    });
    await pool.query(`INSERT INTO campanas_destinatarios (id_campana, ${cols.join(',')}, decil, grupo)
      VALUES ${values.map(() => `(${'?,'.repeat(cols.length + 3).slice(0, -1)})`).join(',')}`, values.flat());
    const control = values.filter(v => v[v.length - 1] === 'CONTROL').length;
    ok(res, { cargados: values.length, control });
  } catch (e) { fail(res, e.message); }
};

/* ── Generar destinatarios DESDE NUESTRAS BASES por parámetros ──────────
   COBRANZA: créditos con cuotas vencidas impagas (mora entre X e Y días,
             capital adeudado, cuotas pagadas mínimas).
   VENTA:    créditos otorgados a punto de terminar (meses para el término),
             renta mínima registrada, antigüedad del crédito.               */
exports.generarDesdeBD = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'BORRADOR') return fail(res, 'La campaña ya fue enviada', 400);
    const p = req.body || {};
    const deciles = safeJSON(c.deciles_control) || [];
    const exReg = (safeJSON(c.excluir_regiones) || []).map(Number).filter(Boolean);
    const exRegSQL = exReg.length ? `AND (cl.id_region IS NULL OR cl.id_region NOT IN (${exReg.map(() => '?').join(',')}))` : '';

    let rows = [];
    if (c.objetivo === 'COBRANZA') {
      const [r] = await pool.query(`
        SELECT cl.rut, cl.nombres nombre, cl.apellido_paterno ap_paterno, cl.apellido_materno ap_materno,
               cl.sexo genero, IF(cl.sexo='FEMENINO','Estimada','Estimado') saludo,
               COALESCE(cl.email, cl.correo) email, COALESCE(cl.telefono_movil, cl.telefono) telefono,
               cr.monto_financiado monto_credito, cr.cuota valor_cuota, cr.plazo cuotas, cr.tascli_real tasa,
               COUNT(*) cuotas_vencidas, SUM(cu.valor_cuota) monto_vencido,
               MAX(DATEDIFF(CURDATE(), cu.fecha_vencimiento)) dias_mora
        FROM cuotas_credito cu
        JOIN creditos cr ON cr.id = cu.id_credito
        JOIN clientes cl ON cl.id_cliente = cr.id_cliente
        WHERE cu.fecha_vencimiento < CURDATE() AND cu.fecha_pago IS NULL
          AND COALESCE(cu.estado_cuota,'') NOT IN ('PAGADA','ANULADA')
          ${exRegSQL}
        GROUP BY cr.id, cl.id_cliente
        HAVING dias_mora BETWEEN ? AND ?
           AND monto_vencido >= ?
        LIMIT 10000`, [...exReg, Number(p.mora_min) || 1, Number(p.mora_max) || 3650, Number(p.capital_min) || 0]);
      rows = r.map(x => ({
        ...x,
        esp1: `${x.cuotas_vencidas} cuota(s) vencida(s) — ${x.dias_mora} días`,
        esp2: 'Paga en autofacilchile.cl, en nuestras cajas o pide tu orden de pago',
      }));
    } else {
      // VENTA / marketing: término del crédito próximo + renta mínima
      const [r] = await pool.query(`
        SELECT cl.rut, cl.nombres nombre, cl.apellido_paterno ap_paterno, cl.apellido_materno ap_materno,
               cl.sexo genero, IF(cl.sexo='FEMENINO','Estimada','Estimado') saludo,
               COALESCE(cl.email, cl.correo) email, COALESCE(cl.telefono_movil, cl.telefono) telefono,
               cr.monto_financiado monto_credito, cr.cuota valor_cuota, cr.plazo cuotas, cr.tascli_real tasa,
               TIMESTAMPDIFF(MONTH, CURDATE(), DATE_ADD(cr.fecha_otorgado, INTERVAL cr.plazo MONTH)) meses_para_termino,
               al.renta
        FROM creditos cr
        JOIN clientes cl ON cl.id_cliente = cr.id_cliente
        LEFT JOIN (
          SELECT rut_cliente, MAX(renta_fija_liquida) renta
          FROM antecedentes_laborales GROUP BY rut_cliente
        ) al ON al.rut_cliente = cl.rut
        WHERE cr.estado_credito='OTORGADO' AND cr.fecha_otorgado IS NOT NULL AND cr.plazo > 0
          AND TIMESTAMPDIFF(MONTH, CURDATE(), DATE_ADD(cr.fecha_otorgado, INTERVAL cr.plazo MONTH)) BETWEEN ? AND ?
          ${exRegSQL}
        LIMIT 10000`, [Number(p.termino_min) || 0, Number(p.termino_max) || 6, ...exReg]);
      // un cliente con más de un crédito por terminar recibe UN solo mensaje
      // Cuota faltante en créditos antiguos → cuota francesa con el MOTOR ÚNICO (rentabilidad-core)
      const { cuotaFrancesa } = require('../../../../api-gateway/public/js/rentabilidad-core');
      // Renta estimada desde la cuota (ej: cuota = 25% de la renta → renta = cuota/0,25)
      const estPct = Number(p.renta_est_pct) || 0;
      let base = r.map(x => {
        let vc = Number(x.valor_cuota) || 0;
        if (!vc && Number(x.monto_credito) && Number(x.cuotas) && Number(x.tasa) > 0) {
          vc = Math.round(cuotaFrancesa(Number(x.monto_credito), Number(x.tasa) / 100, Number(x.cuotas)));
        }
        let renta = Number(x.renta) || null, estimada = 0;
        if (!renta && estPct > 0 && vc) { renta = Math.round(vc / (estPct / 100)); estimada = 1; }
        return { ...x, valor_cuota: vc || x.valor_cuota, renta, renta_estimada: estimada };
      });
      // Monto mínimo de crédito a ofrecer
      const montoMin = Number(p.monto_min) || 0;
      if (montoMin > 0) base = base.filter(x => Number(x.monto_credito) >= montoMin);
      // Renta mínima (registrada o estimada)
      const rentaMin = Number(p.renta_min) || 0;
      if (rentaMin > 0) base = base.filter(x => Number(x.renta) >= rentaMin);
      const vistos = new Set();
      rows = base.filter(x => { const k = limpiaRut(x.rut); if (vistos.has(k)) return false; vistos.add(k); return true; })
        .map(x => ({
          ...x,
          esp1: x.meses_para_termino <= 0 ? 'Tu crédito ya está terminando' : `A tu crédito le quedan ${x.meses_para_termino} mes(es)`,
        }));
    }

    // Los sin dato de contacto SE CARGAN igual (se pueden completar desde DealerNet antes de enviar)
    const sinContacto = rows.filter(x => c.canal === 'MAIL' ? !(x.email && String(x.email).includes('@')) : !x.telefono).length;
    await pool.query('DELETE FROM campanas_destinatarios WHERE id_campana=?', [c.id]);
    const cols = ['rut', 'nombre', 'ap_paterno', 'ap_materno', 'genero', 'saludo', 'email', 'telefono',
      'monto_credito', 'cuotas', 'tasa', 'valor_cuota', 'esp1', 'esp2', 'renta', 'renta_estimada'];
    const values = rows.map(f => {
      const decil = decilDe(f.rut);
      const grupo = (decil !== null && deciles.includes(decil)) ? 'CONTROL' : 'CAMPANA';
      return [c.id, ...cols.map(k => f[k] ?? null), decil, grupo];
    });
    await pool.query(`INSERT INTO campanas_destinatarios (id_campana, ${cols.join(',')}, decil, grupo)
      VALUES ${values.map(() => `(${'?,'.repeat(cols.length + 3).slice(0, -1)})`).join(',')}`, values.flat());
    await pool.query('UPDATE campanas_masivas SET parametros=? WHERE id=?', [JSON.stringify(p), c.id]);
    ok(res, { cargados: values.length, control: values.filter(v => v[v.length - 1] === 'CONTROL').length,
              sin_contacto: sinContacto });
  } catch (e) { fail(res, e.message); }
};

/* ── Merge de variables ─────────────────────────────────────────────────── */
const fmtCLP = v => '$' + Number(v || 0).toLocaleString('es-CL');
function merge(texto, d) {
  return String(texto || '').replace(/\{\{(\w+)\}\}/g, (_, k) => {
    let v = d[k];
    if (v === null || v === undefined || v === '') return '';
    if (['monto_credito', 'pie_monto', 'valor_cuota', 'seg_desgravamen', 'seg_cesantia', 'seg_rdh'].includes(k)) return fmtCLP(v);
    if (k === 'pie_pct' || k === 'tasa') return Number(v).toLocaleString('es-CL') + '%';
    return String(v);
  });
}
/* Píxel de lectura: token = id + HMAC corto (no expone nada; solo marca LEIDO) */
const crypto = require('crypto');
const APP_URL = (process.env.APP_URL || 'https://credit-system-45em.onrender.com').replace(/\/+$/, '');
const firmaPixel = id => crypto.createHmac('sha256', process.env.JWT_SECRET || 'af').update('px' + id).digest('hex').slice(0, 12);

exports.pixel = async (req, res) => {
  // GIF transparente 1x1 SIEMPRE (aunque el token sea inválido, no filtrar nada)
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  try {
    const m = String(req.params.token || '').match(/^(\d+)-([a-f0-9]{12})/);
    if (m && firmaPixel(m[1]) === m[2]) {
      await pool.query(
        "UPDATE campanas_destinatarios SET estado='LEIDO', leido_at=COALESCE(leido_at, NOW()) WHERE id=? AND estado='ENVIADO'", [m[1]]);
    }
  } catch (e) { /* nunca fallar el píxel */ }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, private' }).end(gif);
};

function htmlMail(c, dest, opts = {}) {
  const cuerpo = merge(c.texto, dest).replace(/\n/g, '<br>');
  const pixel = (opts.pixel && dest.id)
    ? `<img src="${APP_URL}/api/campanas-masivas/pixel/${dest.id}-${firmaPixel(dest.id)}.gif" width="1" height="1" alt="" style="display:block">`
    : '';
  const azul = '#0141A2', navy = '#012d70';
  let head = '';
  if (c.plantilla === 'banner') {
    head = `<div style="background:linear-gradient(135deg,${navy},${azul});padding:26px 30px;border-radius:12px 12px 0 0">
      <div style="color:#fff;font-size:26px;font-weight:800;font-family:Segoe UI,Arial">Auto<span style="color:#7cc4ff">Fácil</span></div>
      <div style="color:#bfdbfe;font-size:12px;letter-spacing:2px">CRÉDITO AUTOMOTRIZ</div></div>`;
  } else if (c.plantilla === 'logo') {
    head = `<div style="padding:22px 30px;border-bottom:3px solid ${azul}">
      <span style="color:${navy};font-size:24px;font-weight:800;font-family:Segoe UI,Arial">Auto<span style="color:${azul}">Fácil</span></span></div>`;
  } else if (c.plantilla === 'titulo') {
    head = `<div style="padding:34px 30px 10px"><div style="color:${c.color_titulo || azul};font-size:32px;line-height:1.15;font-weight:800;font-family:Segoe UI,Arial">${merge(c.titulo || '', dest)}</div></div>`;
  }
  return `<div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;font-family:Segoe UI,Arial,sans-serif">
    ${head}
    <div style="padding:26px 30px;color:#1e293b;font-size:15px;line-height:1.65">${cuerpo}</div>
    <div style="background:#f8fafc;padding:14px 30px;color:#94a3b8;font-size:11px">AutoFácil Crédito Automotriz · autofacilchile.cl · +56 9 3246 9071</div>
  </div>${pixel}`;
}

/* ── Vista previa mail-merge (recorre registros) ────────────────────────── */
exports.preview = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const idx = Math.max(0, Number(req.query.i) || 0);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM campanas_destinatarios WHERE id_campana=? AND grupo='CAMPANA'", [c.id]);
    if (!n) return ok(res, { total: 0 });
    const [[d]] = await pool.query("SELECT * FROM campanas_destinatarios WHERE id_campana=? AND grupo='CAMPANA' ORDER BY id LIMIT 1 OFFSET ?", [c.id, Math.min(idx, n - 1)]);
    ok(res, {
      total: n, i: Math.min(idx, n - 1), destinatario: d,
      asunto: merge(c.asunto, d), texto: merge(c.texto, d),
      html: c.canal === 'MAIL' ? htmlMail(c, d) : null,
    });
  } catch (e) { fail(res, e.message); }
};

/* ── ENVÍO (por lotes de 60; el frontend repite hasta 0 pendientes) ─────── */
exports.enviar = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.es_test) return fail(res, 'La campaña TEST es solo demostrativa', 400);
    const [dests] = await pool.query(
      "SELECT * FROM campanas_destinatarios WHERE id_campana=? AND grupo='CAMPANA' AND estado='PENDIENTE' ORDER BY id LIMIT 60", [c.id]);
    if (!dests.length) {
      await pool.query("UPDATE campanas_masivas SET estado='ENVIADA', enviada_at=COALESCE(enviada_at, NOW()) WHERE id=?", [c.id]);
      return ok(res, { enviados: 0, pendientes: 0, fin: true });
    }
    if (c.estado === 'BORRADOR') await pool.query("UPDATE campanas_masivas SET estado='ENVIADA', enviada_at=NOW() WHERE id=?", [c.id]);

    let okN = 0, errN = 0;
    const gestiones = [];
    for (const d of dests) {
      let r = { ok: false, error: 'sin canal' };
      try {
        if (c.canal === 'MAIL') {
          if (!d.email) r = { ok: false, error: 'Sin email' };
          else {
            const { enviarCorreo, remitentePorClave } = require('../../../../shared/mailer');
            const from = c.remitente ? (remitentePorClave ? remitentePorClave(c.remitente) : undefined) : undefined;
            r = await enviarCorreo({ to: d.email, subject: merge(c.asunto || c.descripcion, d), html: htmlMail(c, d, { pixel: true }), from });
          }
        } else {
          const token = process.env.WSP_TOKEN, phoneId = process.env.WSP_PHONE_ID;
          if (!token || !phoneId) r = { ok: false, error: 'WhatsApp no configurado (WSP_TOKEN/WSP_PHONE_ID)' };
          else if (!d.telefono) r = { ok: false, error: 'Sin teléfono' };
          else {
            // Intentar el teléfono principal y luego los alternativos (DealerNet) hasta que uno acepte
            const lista = [d.telefono, ...(safeJSON(d.telefonos_alt) || [])].filter(Boolean);
            r = { ok: false, error: 'Sin teléfono' };
            for (const tel of lista) {
              let to = String(tel).replace(/\D/g, '');
              if (to.length === 9 && to.startsWith('9')) to = '56' + to;
              if (to.length === 8) to = '569' + to;
              const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: merge(c.texto, d) } }),
              });
              const j = await resp.json().catch(() => ({}));
              r = resp.ok ? { ok: true } : { ok: false, error: j.error?.message || `HTTP ${resp.status} (fuera de ventana 24h se requiere plantilla aprobada)` };
              if (r.ok) break;
            }
          }
        }
      } catch (e) { r = { ok: false, error: e.message }; }
      if (r.ok) {
        okN++;
        await pool.query("UPDATE campanas_destinatarios SET estado='ENVIADO', enviado_at=NOW(), error_msg=NULL WHERE id=?", [d.id]);
        gestiones.push(d);
      } else {
        errN++;
        await pool.query("UPDATE campanas_destinatarios SET estado='ERROR', error_msg=? WHERE id=?", [String(r.error || 'error').slice(0, 290), d.id]);
      }
    }
    // Registro en CRM (gestión de Venta / Cobranza por destinatario enviado)
    if (gestiones.length) {
      try {
        await pool.query(`
          INSERT INTO crm_gestiones (tipo_cliente, rut_cliente, nombre_cliente, telefono, email, canal, tipo_solicitud,
            descripcion, resultado, id_campana, nombre_campana, id_usuario, nombre_usuario, estado)
          VALUES ${gestiones.map(() => "('PERSONA',?,?,?,?,?,?,?,?,?,?,?,?,'CERRADA')").join(',')}`,
          gestiones.flatMap(d => [d.rut, [d.nombre, d.ap_paterno].filter(Boolean).join(' '), d.telefono, d.email,
            c.canal === 'MAIL' ? 'EMAIL' : 'WHATSAPP',
            c.objetivo === 'VENTA' ? 'CAMPAÑA VENTA' : 'CAMPAÑA COBRANZA',
            `Campaña masiva ${c.correlativo}: ${c.descripcion}`, 'ENVIADO',
            null, c.correlativo, req.usuario.id_usuario, `${req.usuario.nombre} ${req.usuario.apellido || ''}`.trim()]));
      } catch (e) { console.error('[campanas crm]', e.message); }
    }
    const [[{ p }]] = await pool.query("SELECT COUNT(*) p FROM campanas_destinatarios WHERE id_campana=? AND grupo='CAMPANA' AND estado='PENDIENTE'", [c.id]);
    ok(res, { enviados: okN, errores: errN, pendientes: p, fin: p === 0 });
  } catch (e) { fail(res, e.message); }
};

/* ── Recalcular conversión contra ventas / pagos reales ─────────────────── */
exports.recalcularConversion = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (!c.enviada_at) return fail(res, 'La campaña aún no se envía', 400);
    if (c.es_test) return ok(res, { convertidos: null, nota: 'Campaña TEST: resultados sembrados' });
    const dias = Math.min(90, Number(req.query.dias) || 30);
    let n = 0;
    if (c.objetivo === 'VENTA') {
      const [r] = await pool.query(`
        UPDATE campanas_destinatarios d
        JOIN clientes cl ON REPLACE(REPLACE(REPLACE(UPPER(cl.rut),'.',''),'-',''),' ','') = REPLACE(REPLACE(REPLACE(UPPER(d.rut),'.',''),'-',''),' ','')
        JOIN creditos cr ON cr.id_cliente = cl.id_cliente AND cr.estado_credito='OTORGADO'
          AND cr.fecha_otorgado >= DATE(?) AND cr.fecha_otorgado <= DATE_ADD(DATE(?), INTERVAL ? DAY)
        SET d.convertido=1, d.convertido_at=cr.fecha_otorgado,
            d.dias_a_conversion=DATEDIFF(cr.fecha_otorgado, DATE(?)),
            d.monto_convertido=cr.monto_financiado
        WHERE d.id_campana=?`, [c.enviada_at, c.enviada_at, dias, c.enviada_at, c.id]);
      n = r.affectedRows;
    } else {
      const [r] = await pool.query(`
        UPDATE campanas_destinatarios d
        JOIN clientes cl ON REPLACE(REPLACE(REPLACE(UPPER(cl.rut),'.',''),'-',''),' ','') = REPLACE(REPLACE(REPLACE(UPPER(d.rut),'.',''),'-',''),' ','')
        JOIN creditos cr ON cr.id_cliente = cl.id_cliente
        JOIN cuotas_credito cu ON cu.id_credito = cr.id AND cu.fecha_pago IS NOT NULL
          AND cu.fecha_pago >= DATE(?) AND cu.fecha_pago <= DATE_ADD(DATE(?), INTERVAL ? DAY)
        SET d.convertido=1, d.convertido_at=cu.fecha_pago,
            d.dias_a_conversion=DATEDIFF(cu.fecha_pago, DATE(?)),
            d.monto_convertido=cu.valor_cuota
        WHERE d.id_campana=?`, [c.enviada_at, c.enviada_at, dias, c.enviada_at, c.id]);
      n = r.affectedRows;
    }
    ok(res, { actualizados: n });
  } catch (e) { fail(res, e.message); }
};

/* ── Resultados: estados, conversión por día y champion–challenger ─────── */
exports.resultados = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const [estados] = await pool.query(`
      SELECT estado, COUNT(*) n FROM campanas_destinatarios
      WHERE id_campana=? AND grupo='CAMPANA' GROUP BY estado`, [c.id]);
    const [grupos] = await pool.query(`
      SELECT grupo, COUNT(*) n, SUM(convertido=1) conv, COALESCE(SUM(monto_convertido),0) monto
      FROM campanas_destinatarios WHERE id_campana=? GROUP BY grupo`, [c.id]);
    const [porDia] = await pool.query(`
      SELECT dias_a_conversion dia, grupo, COUNT(*) n
      FROM campanas_destinatarios
      WHERE id_campana=? AND convertido=1 AND dias_a_conversion IS NOT NULL
      GROUP BY dias_a_conversion, grupo ORDER BY dias_a_conversion`, [c.id]);
    const [riesgo] = await pool.query(`
      SELECT COALESCE(riesgo_ia,'SIN ANALIZAR') riesgo, COUNT(*) n
      FROM campanas_destinatarios WHERE id_campana=? GROUP BY riesgo_ia`, [c.id]);
    ok(res, { campana: c, estados, grupos, porDia, riesgo });
  } catch (e) { fail(res, e.message); }
};

/* ── Detalle de destinatarios (popup por estado + export) ───────────────── */
exports.destinatarios = async (req, res) => {
  try {
    const { estado, grupo, convertido } = req.query;
    const w = ['id_campana=?']; const p = [req.params.id];
    if (estado) { w.push('estado=?'); p.push(estado); }
    if (grupo) { w.push('grupo=?'); p.push(grupo); }
    if (convertido === '1') w.push('convertido=1');
    const [rows] = await pool.query(`SELECT * FROM campanas_destinatarios WHERE ${w.join(' AND ')} ORDER BY id LIMIT 5000`, p);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

/* ── Análisis IA de riesgo (informes DealerNet, lotes de 15) ────────────
   Marketing → riesgo de otorgar; Cobranza → probabilidad de no pago.
   Motor único asegurarInformes (caché 15 días) → severidad → BAJO/MEDIO/ALTO. */
exports.analizarIA = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const [prods] = await pool.query('SELECT codigo FROM dealernet_productos WHERE activo=1');
    if (!prods.length) return fail(res, 'DealerNet sin productos activos', 400);
    const { asegurarInformes } = require('../../../clientes/src/controllers/dealernet-ws.controller');
    const [pend] = await pool.query(`
      SELECT id, rut FROM campanas_destinatarios
      WHERE id_campana=? AND riesgo_ia IS NULL AND rut IS NOT NULL LIMIT 15`, [c.id]);
    if (!pend.length) return ok(res, { procesados: 0, pendientes: 0, fin: true });
    const SEV = ['bueno', 'regular', 'malo', 'grave'];
    let hechos = 0;
    for (const d of pend) {
      try {
        const rut = limpiaRut(d.rut).replace(/^(\d+)([\dK])$/, '$1-$2');
        const r = await asegurarInformes({ rut, productos: prods.map(p => String(p.codigo)), usuario: null });
        const disp = (r.items || []).filter(i => i.disponible);
        const peor = disp.length ? disp.reduce((a, i) => Math.max(a, SEV.indexOf(i.severidad)), 0) : null;
        const riesgo = peor === null ? 'S/I' : (peor <= 0 ? 'BAJO' : peor === 1 ? 'MEDIO' : 'ALTO');
        await pool.query('UPDATE campanas_destinatarios SET riesgo_ia=? WHERE id=?', [riesgo, d.id]);
        hechos++;
      } catch (e) {
        await pool.query("UPDATE campanas_destinatarios SET riesgo_ia='S/I' WHERE id=?", [d.id]);
      }
    }
    const [[{ p }]] = await pool.query('SELECT COUNT(*) p FROM campanas_destinatarios WHERE id_campana=? AND riesgo_ia IS NULL AND rut IS NOT NULL', [c.id]);
    ok(res, { procesados: hechos, pendientes: p, fin: p === 0 });
  } catch (e) { fail(res, e.message); }
};

/* ── ANÁLISIS DE CRÉDITO (política) — aparte del de informes, ambos opcionales ──
   Regla: la cuota no debe superar carga_max% de la renta (registrada o estimada).
   Sin renta → S/I (no se castiga). Marca la columna politica por destinatario. */
exports.analizarPolitica = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const cargaMax = Number(req.body?.carga_max_pct) || 30;
    const estPct   = Number(req.body?.renta_est_pct) || 0;
    if (estPct > 0) {
      await pool.query(`
        UPDATE campanas_destinatarios
        SET renta = ROUND(valor_cuota / (? / 100)), renta_estimada = 1
        WHERE id_campana=? AND (renta IS NULL OR renta = 0) AND valor_cuota IS NOT NULL AND valor_cuota > 0`,
        [estPct, c.id]);
    }
    await pool.query(`
      UPDATE campanas_destinatarios
      SET politica = CASE
        WHEN renta IS NULL OR renta = 0 OR valor_cuota IS NULL OR valor_cuota = 0 THEN 'S/I'
        WHEN (valor_cuota / renta) * 100 <= ? THEN 'CUMPLE'
        ELSE 'NO_CUMPLE' END
      WHERE id_campana=?`, [cargaMax, c.id]);
    const [dist] = await pool.query(
      'SELECT politica, COUNT(*) n FROM campanas_destinatarios WHERE id_campana=? GROUP BY politica', [c.id]);
    ok(res, { carga_max_pct: cargaMax, dist });
  } catch (e) { fail(res, e.message); }
};

/* ── Excluir del envío por política (NO_CUMPLE) ── */
exports.excluirPolitica = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT estado FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'BORRADOR') return fail(res, 'La campaña ya fue enviada', 400);
    const [r] = await pool.query(
      "UPDATE campanas_destinatarios SET grupo='EXCLUIDO' WHERE id_campana=? AND grupo='CAMPANA' AND politica='NO_CUMPLE'",
      [req.params.id]);
    ok(res, { excluidos: r.affectedRows });
  } catch (e) { fail(res, e.message); }
};

/* ── ENRIQUECER CONTACTOS desde DealerNet ────────────────────────────────
   Para destinatarios SIN el dato del canal: consulta Directorio Correo (3411) /
   Directorio Teléfonos (3410) + Contactabilidad (3407) + Identificación (3440),
   extrae candidatos del informe (extractor genérico sobre el JSON) y los deja
   en contactos_dn para REVISIÓN UNO A UNO (nombre DealerNet vs nuestro nombre).
   Lotes de 5 (cada consulta DealerNet tiene costo; caché 15 días). */
// Perfil Comercial (3435) trae nombre, correos y teléfonos — activo en el plan y con caché
const PROD_MAIL = ['3435'];
const PROD_TEL  = ['3435'];
function extraerContactos(textos, rutCuerpo) {
  const todo = textos.join('\n');
  const emails = [...new Set((todo.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])
    .map(e => e.toLowerCase()).filter(e => !e.includes('dealernet')))];
  // teléfonos chilenos normalizados; puntaje = frecuencia en el informe + bonus móvil
  const freq = {};
  for (const m of (todo.match(/(?:\+?56)?\s?(?:9\s?\d{4}\s?\d{4}|\d{8,9})/g) || [])) {
    let d = m.replace(/\D/g, '');
    if (d.startsWith('56')) d = d.slice(2);
    if (d.length === 9 && d.startsWith('9')) d = '56' + d;
    else if (d.length === 9 && d.startsWith('2')) d = '56' + d;
    else if (d.length === 8) d = '569' + d;
    else continue;
    freq[d] = (freq[d] || 0) + 1;
  }
  const telefonos = Object.entries(freq)
    .filter(([num]) => !rutCuerpo || !num.includes(String(rutCuerpo)))   // el RUT no es un teléfono
    .map(([num, n]) => ({ num: '+' + num, score: n + (num.startsWith('569') ? 10 : 0) }))
    .sort((a, b) => b.score - a.score).slice(0, 8);
  const nf = {};
  for (const m of (todo.match(/"@_nombre":\s*"([^"]{5,80})"/g) || [])) {
    const v = m.replace(/^"@_nombre":\s*"/, '').replace(/"$/, '').trim().toUpperCase();
    if (v && !/EMPRESA|BANCO/.test(v)) nf[v] = (nf[v] || 0) + 1;
  }
  const nombre_dn = Object.entries(nf).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { nombre_dn, emails: emails.slice(0, 6), telefonos };
}

exports.enriquecerContactos = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT * FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'BORRADOR') return fail(res, 'La campaña ya fue enviada', 400);
    const cond = c.canal === 'MAIL' ? "(email IS NULL OR email='' OR email NOT LIKE '%@%')" : "(telefono IS NULL OR telefono='')";
    const [pend] = await pool.query(`
      SELECT id, rut FROM campanas_destinatarios
      WHERE id_campana=? AND grupo IN ('CAMPANA','CONTROL') AND ${cond} AND contactos_dn IS NULL AND rut IS NOT NULL
      LIMIT 5`, [c.id]);
    if (!pend.length) {
      const [[{ q }]] = await pool.query(`SELECT COUNT(*) q FROM campanas_destinatarios WHERE id_campana=? AND ${cond} AND contactos_dn IS NOT NULL`, [c.id]);
      return ok(res, { procesados: 0, pendientes: 0, revisables: q, fin: true });
    }
    const { asegurarInformes } = require('../../../clientes/src/controllers/dealernet-ws.controller');
    const productos = c.canal === 'MAIL' ? PROD_MAIL : PROD_TEL;
    let hechos = 0;
    for (const d of pend) {
      try {
        const rut = limpiaRut(d.rut).replace(/^(\d+)([\dK])$/, '$1-$2');
        await asegurarInformes({ rut, productos, usuario: null });
        const m = limpiaRut(d.rut).match(/^(\d+)([\dK])$/);
        const [infs] = await pool.query(
          `SELECT contenido FROM dealernet_informes WHERE rut=? AND codigo_producto IN (?) AND retcode=0 ORDER BY id DESC LIMIT 6`,
          [m ? m[1] : d.rut, productos]);
        const cand = extraerContactos(
          infs.map(i => typeof i.contenido === 'string' ? i.contenido : JSON.stringify(i.contenido || {})),
          m ? m[1] : null);
        await pool.query('UPDATE campanas_destinatarios SET contactos_dn=? WHERE id=?', [JSON.stringify(cand), d.id]);
        hechos++;
      } catch (e) {
        await pool.query('UPDATE campanas_destinatarios SET contactos_dn=? WHERE id=?',
          [JSON.stringify({ error: e.message.slice(0, 120) }), d.id]);
      }
    }
    const [[{ p2 }]] = await pool.query(`
      SELECT COUNT(*) p2 FROM campanas_destinatarios
      WHERE id_campana=? AND grupo IN ('CAMPANA','CONTROL') AND ${cond} AND contactos_dn IS NULL AND rut IS NOT NULL`, [c.id]);
    ok(res, { procesados: hechos, pendientes: p2, fin: p2 === 0 });
  } catch (e) { fail(res, e.message); }
};

/* ── Casos a revisar + asignación UNO A UNO ── */
exports.contactosPendientes = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT canal FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    const cond = c.canal === 'MAIL' ? "(email IS NULL OR email='' OR email NOT LIKE '%@%')" : "(telefono IS NULL OR telefono='')";
    const [rows] = await pool.query(`
      SELECT id, rut, nombre, ap_paterno, ap_materno, email, telefono, contactos_dn
      FROM campanas_destinatarios
      WHERE id_campana=? AND ${cond} AND contactos_dn IS NOT NULL
      ORDER BY id LIMIT 500`, [req.params.id]);
    ok(res, rows);
  } catch (e) { fail(res, e.message); }
};

exports.asignarContacto = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT estado, canal FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'BORRADOR') return fail(res, 'La campaña ya fue enviada', 400);
    const { id_destinatario, email, telefonos } = req.body || {};
    if (!id_destinatario) return fail(res, 'Falta id_destinatario', 400);
    if (c.canal === 'MAIL') {
      if (!email || !String(email).includes('@')) return fail(res, 'Email inválido', 400);
      await pool.query('UPDATE campanas_destinatarios SET email=? WHERE id=? AND id_campana=?',
        [String(email).trim().toLowerCase(), id_destinatario, req.params.id]);
    } else {
      const tels = (Array.isArray(telefonos) ? telefonos : []).map(t => String(t).trim()).filter(Boolean).slice(0, 3);
      if (!tels.length) return fail(res, 'Selecciona al menos 1 teléfono', 400);
      await pool.query('UPDATE campanas_destinatarios SET telefono=?, telefonos_alt=? WHERE id=? AND id_campana=?',
        [tels[0], JSON.stringify(tels.slice(1)), id_destinatario, req.params.id]);
    }
    ok(res, { asignado: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Excluir del envío por riesgo IA (grupo EXCLUIDO — nunca se les envía) ── */
exports.excluirRiesgo = async (req, res) => {
  try {
    const [[c]] = await pool.query('SELECT estado FROM campanas_masivas WHERE id=?', [req.params.id]);
    if (!c) return fail(res, 'Campaña no existe', 404);
    if (c.estado !== 'BORRADOR') return fail(res, 'La campaña ya fue enviada', 400);
    const niveles = (Array.isArray(req.body?.niveles) ? req.body.niveles : ['ALTO']).filter(x => ['ALTO', 'MEDIO', 'S/I'].includes(x));
    if (!niveles.length) return fail(res, 'Niveles inválidos', 400);
    const [r] = await pool.query(
      `UPDATE campanas_destinatarios SET grupo='EXCLUIDO' WHERE id_campana=? AND grupo='CAMPANA' AND riesgo_ia IN (?)`,
      [req.params.id, niveles]);
    ok(res, { excluidos: r.affectedRows });
  } catch (e) { fail(res, e.message); }
};

function safeJSON(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }
