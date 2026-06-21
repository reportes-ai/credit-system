'use strict';
const pool = require('../../../../shared/config/database');
const ia = require('../../../../shared/ia');
const { analizar } = require('../../../../shared/anthropic');
const { auditar } = require('../../../../shared/audit');

const CODIGO = 'liq_sueldo';

// Reglas de negocio (parámetros — a futuro a mantenedor)
const MES_COMPLETO_DIAS  = 30;   // días de un mes completo (estándar liquidación CL)
const UMBRAL_VARIABLE_PCT = 5;   // variación de imponible sobre la cual la renta se considera variable

// Auto-registro + tabla de evaluaciones de renta.
(async () => {
  try {
    await ia.registrarFuncionalidad({
      codigo: CODIGO,
      nombre: 'Análisis de liquidaciones de sueldo',
      descripcion: 'Extrae datos, determina tipo de renta (fija/variable) y calcula la renta líquida según reglas',
      modelo: 'claude-haiku-4-5',
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_evaluaciones_renta (
      id                BIGINT AUTO_INCREMENT PRIMARY KEY,
      fecha             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      id_usuario        INT NULL,
      rut_trabajador    VARCHAR(20) NULL,
      trabajador        VARCHAR(300) NULL,
      empleador         VARCHAR(300) NULL,
      rut_empleador     VARCHAR(20) NULL,
      tipo_renta        VARCHAR(20) NULL,
      tipo_auto         VARCHAR(20) NULL,
      renta_liquida     BIGINT NULL,
      renta_imponible   BIGINT NULL,
      n_liquidaciones   INT NULL,
      liquidaciones     JSON NULL,
      meses_usados      VARCHAR(400) NULL,
      meses_descartados VARCHAR(400) NULL,
      explicacion       TEXT NULL,
      advertencia       VARCHAR(400) NULL,
      modelo            VARCHAR(60) NULL,
      tokens_in         INT NULL,
      tokens_out        INT NULL,
      costo_usd         DECIMAL(12,6) NULL,
      guardado_cliente  TINYINT NOT NULL DEFAULT 0,
      rut_cliente       VARCHAR(15) NULL,
      INDEX idx_fecha (fecha), INDEX idx_rut (rut_trabajador) )`);
  } catch (e) { console.error('[ia liquidaciones init]', e.message); }
})();

const normRut = v => v ? String(v).replace(/\./g, '').toUpperCase().trim() : null;
const ent = v => (v == null || v === '' || isNaN(parseInt(v))) ? null : parseInt(v);
const MESES = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7, agosto:8, septiembre:9, setiembre:9, octubre:10, noviembre:11, diciembre:12 };
function periodoOrden(p) {
  if (!p) return 0;
  const s = String(p).toLowerCase();
  const y = (s.match(/(20\d{2})/) || [])[1];
  let m = 0;
  for (const k in MESES) if (s.includes(k)) { m = MESES[k]; break; }
  if (!m) { const mm = s.match(/\b(0?[1-9]|1[0-2])\b/); if (mm) m = parseInt(mm[1]); }
  return (y ? parseInt(y) : 0) * 100 + m;
}

const SYSTEM = `Eres un analista de crédito chileno experto en liquidaciones de sueldo.
Extrae los datos con precisión. Los montos van en pesos chilenos como números ENTEROS, sin puntos, comas ni símbolos.
"dias_trabajados" es el número de días trabajados del mes que indica la liquidación (clave). Si un dato no aparece, devuélvelo como null. NUNCA inventes valores.`;

const PROMPT = `Extrae los datos de esta liquidación de sueldo y responde EXACTAMENTE con este JSON:
{
  "trabajador":"string|null","rut_trabajador":"string|null","empleador":"string|null","rut_empleador":"string|null",
  "periodo":"string|null","dias_trabajados":"number|null",
  "sueldo_base":"number|null","total_imponible":"number|null","total_haberes":"number|null",
  "afp_nombre":"string|null","afp_monto":"number|null","salud_nombre":"string|null","salud_monto":"number|null",
  "total_descuentos":"number|null","sueldo_liquido":"number|null"
}
"periodo" en formato "Mes Año" (ej "Mayo 2026").`;

/* Núcleo determinístico: aplica las reglas de cálculo de renta */
function calcularRenta(rawLiqs, tipoForzado, params = {}) {
  const MES = parseInt(params.mesCompleto) || MES_COMPLETO_DIAS;
  const UMBRAL = (params.umbral != null && !isNaN(parseFloat(params.umbral))) ? parseFloat(params.umbral) : UMBRAL_VARIABLE_PCT;
  const forz = (tipoForzado || '').toString().toUpperCase();
  const items = (rawLiqs || []).map(l => {
    const dias = ent(l.dias_trabajados);
    return {
      periodo: l.periodo || null, orden: periodoOrden(l.periodo),
      dias, diasConocidos: dias != null, completo: dias == null ? true : dias >= MES,
      imponible: ent(l.total_imponible), liquido: ent(l.sueldo_liquido),
      afp_nombre: l.afp_nombre || null, salud_nombre: l.salud_nombre || null, usada: false,
    };
  }).sort((a, b) => b.orden - a.orden);

  const completos = items.filter(i => i.completo);
  const incompletos = items.filter(i => !i.completo);

  // Tipo de renta
  let tipoAuto = 'FIJA';
  const impc = completos.map(i => i.imponible).filter(v => v != null);
  if (impc.length >= 2) {
    const max = Math.max(...impc), min = Math.min(...impc);
    const varia = min > 0 ? ((max - min) / min) * 100 : 0;
    tipoAuto = varia > UMBRAL ? 'VARIABLE' : 'FIJA';
  }
  const tipo = (forz === 'FIJA' || forz === 'VARIABLE') ? forz : tipoAuto;

  // Meses usados
  let usados;
  if (tipo === 'FIJA') usados = completos.length ? [completos[0]] : (items.length ? [items[0]] : []);
  else usados = completos.slice(0, 6);
  usados.forEach(u => { u.usada = true; });

  const prom = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const renta_liquida   = prom(usados.map(u => u.liquido).filter(v => v != null));
  const renta_imponible = prom(usados.map(u => u.imponible).filter(v => v != null));

  const fmt = n => n == null ? '—' : '$' + Number(n).toLocaleString('es-CL');
  const mUsados = usados.map(u => u.periodo || '(sin período)');
  const mDesc = incompletos.map(u => `${u.periodo || '(sin período)'} (${u.dias} días)`);

  let exp = `Tipo de renta: ${tipo}` + (forz === 'FIJA' || forz === 'VARIABLE'
    ? (forz !== tipoAuto ? ` (ajustado manualmente; el sistema detectó ${tipoAuto}). ` : ` (confirmado). `)
    : ` (detectado automáticamente). `);
  if (tipo === 'FIJA') exp += `Se usó la liquidación más reciente con mes completo: ${mUsados.join(', ') || '—'}. `;
  else exp += `Se promediaron ${usados.length} mes(es) completo(s): ${mUsados.join(', ') || '—'}. `;
  if (mDesc.length) exp += `Se descartaron por días incompletos (licencia/ausencia): ${mDesc.join(', ')}. Ante meses incompletos se consideran hasta 6 liquidaciones y se promedian solo los completos. `;
  exp += `Renta líquida calculada: ${fmt(renta_liquida)}. Cálculo asistido con Inteligencia Artificial de Anthropic (extracción de cada liquidación).`;

  let adv = null;
  if (!usados.length) adv = 'No hay meses completos para calcular. Solicita liquidaciones de meses completos.';
  else if (tipo === 'VARIABLE' && usados.length < 3) adv = `Renta variable con solo ${usados.length} mes(es) completo(s); se recomiendan 3.`;
  else if (incompletos.length && completos.length < 3) adv = 'Hay meses incompletos y menos de 3 completos; pide hasta 6 meses.';
  if (items.some(i => !i.diasConocidos)) adv = (adv ? adv + ' ' : '') + 'En alguna liquidación no se detectaron los días trabajados (se asumió mes completo).';

  return { tipo_renta: tipo, tipo_auto: tipoAuto, renta_liquida, renta_imponible,
    meses_usados: mUsados.join(', '), meses_descartados: mDesc.join(', '), explicacion: exp, advertencia: adv, items };
}

const parseLiqs = v => { try { return typeof v === 'string' ? JSON.parse(v) : (v || []); } catch { return []; } };

/* POST /api/ia/liquidaciones/evaluar (multipart: archivos[]) → extrae + calcula + guarda */
exports.evaluar = async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, data: null, error: 'Sube al menos una liquidación.' });
    if (files.length > 6) return res.status(400).json({ success: false, data: null, error: 'Máximo 6 liquidaciones.' });
    for (const f of files) {
      const mt = f.mimetype || '';
      if (!mt.includes('pdf') && !mt.startsWith('image/'))
        return res.status(400).json({ success: false, data: null, error: `Formato no soportado: ${f.originalname}. Usa PDF o imagen.` });
    }

    const raw = [];
    let modelo = null, tin = 0, tout = 0, costo = 0;
    for (const f of files) {
      const mt = f.mimetype || '';
      const doc = mt.includes('pdf')
        ? { tipo: 'pdf', data: f.buffer.toString('base64') }
        : { tipo: 'image', media_type: mt, data: f.buffer.toString('base64') };
      const r = await analizar({ codigo: CODIGO, id_usuario: req.usuario?.id_usuario, system: SYSTEM, prompt: PROMPT, documentos: [doc], json: true, max_tokens: 1200 });
      if (r.datos) { raw.push(r.datos); modelo = r.modelo; tin += r.tokens_in; tout += r.tokens_out; costo += (r.costo || 0); }
    }
    if (!raw.length) return res.status(422).json({ success: false, data: null, error: 'No se pudo interpretar ninguna liquidación. Prueba con imágenes más nítidas o PDF.' });

    const cfgP = (await ia.getConfig()).params || {};
    const calc = calcularRenta(raw, null, { mesCompleto: cfgP.liq_mes_completo, umbral: cfgP.liq_umbral_variable });
    const ident = raw.find(l => l.rut_trabajador) || raw[0] || {};

    let id = null;
    try {
      const [ins] = await pool.query(
        `INSERT INTO ia_evaluaciones_renta
          (id_usuario, rut_trabajador, trabajador, empleador, rut_empleador, tipo_renta, tipo_auto,
           renta_liquida, renta_imponible, n_liquidaciones, liquidaciones, meses_usados, meses_descartados,
           explicacion, advertencia, modelo, tokens_in, tokens_out, costo_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.usuario?.id_usuario || null, normRut(ident.rut_trabajador), ident.trabajador || null, ident.empleador || null, normRut(ident.rut_empleador),
         calc.tipo_renta, calc.tipo_auto, calc.renta_liquida, calc.renta_imponible, raw.length, JSON.stringify(raw),
         calc.meses_usados, calc.meses_descartados, calc.explicacion, calc.advertencia, modelo, tin, tout, costo]);
      id = ins.insertId;
    } catch (e) { console.error('[ia eval insert]', e.message); }

    auditar({ req, accion: 'ANALIZAR', modulo: 'ia', entidad: 'evaluacion_renta', entidad_id: id,
      detalle: `Evaluó renta con IA: ${calc.tipo_renta}, ${raw.length} liquidación(es) (${modelo})`, meta: { tokens_in: tin, tokens_out: tout } });

    res.json({ success: true, data: { id, identidad: { trabajador: ident.trabajador, rut_trabajador: ident.rut_trabajador, empleador: ident.empleador }, ...calc, modelo, tokens_in: tin, tokens_out: tout, costo }, error: null });
  } catch (e) {
    if (e.code === 'NO_KEY') return res.status(503).json({ success: false, data: null, error: 'La IA no está configurada en el servidor (falta ANTHROPIC_API_KEY).' });
    if (e.code === 'IA_OFF') return res.status(403).json({ success: false, data: null, error: 'La IA para liquidaciones está desactivada. Actívala en Mantenedores → Inteligencia Artificial.' });
    console.error('[ia evaluar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al evaluar: ' + e.message });
  }
};

/* POST /api/ia/evaluacion/:id/recalcular?tipo=FIJA|VARIABLE|auto → recalcula sin re-subir */
exports.recalcular = async (req, res) => {
  try {
    const [[ev]] = await pool.query('SELECT * FROM ia_evaluaciones_renta WHERE id = ? LIMIT 1', [req.params.id]);
    if (!ev) return res.status(404).json({ success: false, data: null, error: 'Evaluación no encontrada.' });
    const tipo = (req.query.tipo || '').toUpperCase();
    const cfgP = (await ia.getConfig()).params || {};
    const calc = calcularRenta(parseLiqs(ev.liquidaciones), (tipo === 'FIJA' || tipo === 'VARIABLE') ? tipo : null, { mesCompleto: cfgP.liq_mes_completo, umbral: cfgP.liq_umbral_variable });
    await pool.query(
      `UPDATE ia_evaluaciones_renta SET tipo_renta=?, renta_liquida=?, renta_imponible=?, meses_usados=?, meses_descartados=?, explicacion=?, advertencia=? WHERE id=?`,
      [calc.tipo_renta, calc.renta_liquida, calc.renta_imponible, calc.meses_usados, calc.meses_descartados, calc.explicacion, calc.advertencia, ev.id]);
    res.json({ success: true, data: { id: ev.id, identidad: { trabajador: ev.trabajador, rut_trabajador: ev.rut_trabajador, empleador: ev.empleador }, ...calc, modelo: ev.modelo, tokens_in: ev.tokens_in, tokens_out: ev.tokens_out, costo: Number(ev.costo_usd) }, error: null });
  } catch (e) { console.error('[ia recalcular]', e.message); res.status(500).json({ success: false, data: null, error: 'Error al recalcular: ' + e.message }); }
};

/* POST /api/ia/evaluacion/:id/guardar-cliente → escribe la renta en antecedentes_laborales (upsert PARCIAL) */
exports.guardarCliente = async (req, res) => {
  try {
    const [[ev]] = await pool.query('SELECT * FROM ia_evaluaciones_renta WHERE id = ? LIMIT 1', [req.params.id]);
    if (!ev) return res.status(404).json({ success: false, data: null, error: 'Evaluación no encontrada.' });
    const rut = normRut(ev.rut_trabajador);
    if (!rut) return res.status(400).json({ success: false, data: null, error: 'La evaluación no trae el RUT del trabajador; no se puede asociar a un cliente.' });
    const [[cli]] = await pool.query('SELECT id_cliente, nombres, apellido_paterno, apellido_materno FROM clientes WHERE rut = ? LIMIT 1', [rut]);
    if (!cli) return res.status(404).json({ success: false, data: null, error: `No existe un cliente con RUT ${rut}. Créalo primero en Clientes.` });

    await pool.query(
      `INSERT INTO antecedentes_laborales (rut_cliente, tipo_trabajador, empleador, rut_empresa, renta_fija_liquida)
       VALUES (?, 'Dependiente', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         empleador          = VALUES(empleador),
         rut_empresa        = COALESCE(VALUES(rut_empresa), rut_empresa),
         renta_fija_liquida = VALUES(renta_fija_liquida),
         tipo_trabajador    = COALESCE(tipo_trabajador, VALUES(tipo_trabajador)),
         updated_at         = CURRENT_TIMESTAMP`,
      [rut, ev.empleador || null, ev.rut_empleador || null, ev.renta_liquida != null ? ev.renta_liquida : null]);
    await pool.query('UPDATE ia_evaluaciones_renta SET guardado_cliente = 1, rut_cliente = ? WHERE id = ?', [rut, ev.id]);

    const nombre = [cli.nombres, cli.apellido_paterno, cli.apellido_materno].filter(Boolean).join(' ') || rut;
    auditar({ req, accion: 'GUARDAR', modulo: 'ia', entidad: 'antecedentes_laborales', entidad_id: rut,
      detalle: `Guardó renta ${ev.tipo_renta} (IA) en antecedentes de ${nombre}: $${Number(ev.renta_liquida || 0).toLocaleString('es-CL')}`, rut });
    res.json({ success: true, data: { rut_cliente: rut, cliente: nombre }, error: null });
  } catch (e) { console.error('[ia guardarCliente]', e.message); res.status(500).json({ success: false, data: null, error: 'Error al guardar: ' + e.message }); }
};

/* GET /api/ia/evaluaciones?limit=10 → historial */
exports.historial = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const [rows] = await pool.query(
      `SELECT id, fecha, rut_trabajador, trabajador, tipo_renta, renta_liquida, n_liquidaciones, guardado_cliente, costo_usd
       FROM ia_evaluaciones_renta ORDER BY fecha DESC LIMIT ?`, [limit]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[ia historial]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
