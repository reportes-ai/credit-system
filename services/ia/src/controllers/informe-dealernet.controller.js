'use strict';
/**
 * Análisis de informe crediticio (DealerNet) con IA.
 * Lee los informes YA traídos del repositorio dealernet_informes (no llama a
 * DealerNet ni gasta su saldo) y resume el riesgo crediticio para el analista.
 */
const pool = require('../../../../shared/config/database');
const ia = require('../../../../shared/ia');
const { analizar } = require('../../../../shared/anthropic');
const { auditar } = require('../../../../shared/audit');

const CODIGO = 'informe_crediticio';

(async () => {
  try {
    await ia.registrarFuncionalidad({
      codigo: CODIGO,
      nombre: 'Análisis de informe crediticio (DealerNet)',
      descripcion: 'Analiza los antecedentes que trae DealerNet (deudas, morosidades) y resume el nivel de riesgo',
      modelo: 'claude-sonnet-4-6',
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_informes_dealernet (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      fecha         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      id_usuario    INT NULL,
      rut           VARCHAR(20) NULL,
      nivel_riesgo  VARCHAR(20) NULL,
      resumen       TEXT NULL,
      deudas        TEXT NULL,
      alertas       JSON NULL,
      factores      JSON NULL,
      recomendacion TEXT NULL,
      productos     VARCHAR(400) NULL,
      modelo        VARCHAR(60) NULL,
      tokens_in     INT NULL,
      tokens_out    INT NULL,
      costo_usd     DECIMAL(12,6) NULL,
      INDEX idx_fecha (fecha), INDEX idx_rut (rut) )`);
    try { await pool.query('ALTER TABLE ia_informes_dealernet ADD COLUMN IF NOT EXISTS causas JSON NULL'); } catch (e) { if (e.errno !== 1060) console.error('[ia informe-dn alter]', e.message); }
  } catch (e) { console.error('[ia informe-dn init]', e.message); }
})();

const rutNum = r => { const c = String(r || '').replace(/[.\s-]/g, '').toUpperCase(); return c.length > 1 ? c.slice(0, -1) : c; };
const normCli = v => v ? String(v).replace(/\./g, '').toUpperCase().trim() : null;   // formato clientes: NNNNNNN-DV
const arr = v => { try { return Array.isArray(v) ? v : (v ? JSON.parse(v) : []); } catch { return []; } };

/* Auto-actualiza informacion_comercial del cliente con los montos de deuda (upsert PARCIAL por RUT) */
async function aplicarComercial(rutRaw, deudas) {
  const rut = normCli(rutRaw);
  if (!rut) return { ok: false, cliente: null, rut: null, motivo: 'Sin RUT.' };
  const [[cli]] = await pool.query('SELECT nombres, apellido_paterno, apellido_materno FROM clientes WHERE rut = ? LIMIT 1', [rut]);
  if (!cli) return { ok: false, cliente: null, rut, motivo: `No existe un cliente con RUT ${rut}.` };
  const campos = ['deuda_vigente_total', 'deuda_morosa', 'deuda_castigada', 'monto_protestos', 'protestos_vigentes_q'];
  const set = {};
  for (const c of campos) { const v = deudas && deudas[c]; if (v != null && v !== '' && !isNaN(parseInt(v))) set[c] = parseInt(v); }
  const cols = Object.keys(set);
  if (cols.length) {
    await pool.query(
      `INSERT INTO informacion_comercial (rut_cliente, ${cols.join(', ')}) VALUES (${['?', ...cols.map(() => '?')].join(', ')})
       ON DUPLICATE KEY UPDATE ${cols.map(c => `${c}=VALUES(${c})`).join(', ')}, updated_at=CURRENT_TIMESTAMP`,
      [rut, ...cols.map(c => set[c])]);
  } else {
    await pool.query('INSERT IGNORE INTO informacion_comercial (rut_cliente) VALUES (?)', [rut]);
  }
  const nombre = [cli.nombres, cli.apellido_paterno, cli.apellido_materno].filter(Boolean).join(' ') || rut;
  return { ok: true, cliente: nombre, rut, campos: cols };
}

const SYSTEM = `Eres un analista de riesgo crediticio chileno. Recibes antecedentes comerciales reales de una persona, traídos del servicio DealerNet (perfil comercial, boletines de impagos vigentes/históricos, comportamiento civil/laboral/penal, índices judiciales, boletín de procesos penales, deudores de pensión de alimentos, etc.). Resume el riesgo para una evaluación de crédito automotriz.
Reglas: sé CONSERVADOR y objetivo; NO inventes datos; si algo no aparece, no lo afirmes. Incluye TODAS las causas judiciales CIVILES y PENALES que aparezcan, con su fecha, materia/carátula y demandante. Extrae los montos de deuda (vigente, morosa, castigada, protestos) si el perfil comercial los trae. Tu análisis ASISTE al analista, no reemplaza su decisión.`;

const promptDe = datos => `Analiza los siguientes antecedentes DealerNet y responde EXACTAMENTE este JSON:
{
  "nivel_riesgo": "BAJO|MEDIO|ALTO",
  "resumen": "2 a 4 frases con el panorama general",
  "deudas_morosidades": "detalle de morosidades/impagos vigentes, o 'Sin morosidades vigentes detectadas'",
  "deudas": { "deuda_vigente_total": "number|null", "deuda_morosa": "number|null", "deuda_castigada": "number|null", "monto_protestos": "number|null", "protestos_vigentes_q": "number|null" },
  "causas_judiciales": [ { "tipo": "CIVIL|PENAL", "fecha": "string|null", "materia": "razón o carátula", "demandante": "string|null", "tribunal": "string|null", "rol": "string|null", "estado": "string|null" } ],
  "alertas": ["banderas rojas relevantes para el crédito"],
  "factores_positivos": ["aspectos favorables"],
  "recomendacion": "sugerencia breve para el analista (no es decisión final)"
}
Montos en pesos chilenos como enteros sin puntos. Si no hay causas judiciales, devuelve "causas_judiciales": [].

ANTECEDENTES:
${datos}`;

/* POST /api/ia/informe-dealernet  { rut } */
exports.analizar = async (req, res) => {
  try {
    const rut = rutNum(req.body?.rut);
    if (!rut) return res.status(400).json({ success: false, data: null, error: 'RUT requerido.' });

    const [rows] = await pool.query(
      `SELECT codigo_producto, nombre_producto, contenido, created_at FROM dealernet_informes
       WHERE rut = ? AND retcode='0' ORDER BY created_at DESC`, [rut]);
    if (!rows.length) return res.status(404).json({ success: false, data: null, error: 'No hay informes DealerNet para este RUT. Solicítalos primero en Informes DealerNet.' });

    // Último informe por producto
    const seen = new Set(), ult = [];
    for (const r of rows) { if (seen.has(r.codigo_producto)) continue; seen.add(r.codigo_producto); ult.push(r); }

    const datos = ult.map(i => {
      let c = i.contenido; if (typeof c === 'string') { try { c = JSON.parse(c); } catch {} }
      let s = (typeof c === 'string') ? c : JSON.stringify(c);
      if (s.length > 6000) s = s.slice(0, 6000) + '…';
      return `### ${i.nombre_producto || i.codigo_producto}\n${s}`;
    }).join('\n\n');

    const r = await analizar({ codigo: CODIGO, id_usuario: req.usuario?.id_usuario, system: SYSTEM, prompt: promptDe(datos), json: true, max_tokens: 1500 });
    const x = r.datos;
    if (!x) return res.status(422).json({ success: false, data: { texto: r.texto }, error: 'No se pudo generar el análisis. Intenta de nuevo.' });

    const productos = ult.map(i => i.nombre_producto || i.codigo_producto).join(', ');
    let id = null;
    try {
      const [ins] = await pool.query(
        `INSERT INTO ia_informes_dealernet (id_usuario, rut, nivel_riesgo, resumen, deudas, causas, alertas, factores, recomendacion, productos, modelo, tokens_in, tokens_out, costo_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.usuario?.id_usuario || null, rut, String(x.nivel_riesgo || '').toUpperCase().slice(0, 20), x.resumen || null, x.deudas_morosidades || null,
         JSON.stringify(arr(x.causas_judiciales)), JSON.stringify(arr(x.alertas)), JSON.stringify(arr(x.factores_positivos)), x.recomendacion || null, productos.slice(0, 400), r.modelo, r.tokens_in, r.tokens_out, r.costo]);
      id = ins.insertId;
    } catch (e) { console.error('[ia informe-dn insert]', e.message); }

    auditar({ req, accion: 'ANALIZAR', modulo: 'ia', entidad: 'informe_dealernet', entidad_id: id,
      detalle: `Analizó informe crediticio DealerNet RUT ${rut} con IA (${r.modelo}) → riesgo ${x.nivel_riesgo}`, rut });

    // Auto-actualiza la información comercial del cliente (montos de deuda) si existe por RUT
    let guardado = { ok: false, cliente: null, motivo: null };
    try {
      guardado = await aplicarComercial(req.body?.rut, x.deudas);
      if (guardado.ok && guardado.campos.length)
        auditar({ req, accion: 'GUARDAR', modulo: 'ia', entidad: 'informacion_comercial', entidad_id: guardado.rut,
          detalle: `Actualizó información comercial (IA/DealerNet) de ${guardado.cliente}: ${guardado.campos.join(', ')}`, rut: guardado.rut });
    } catch (e) { console.error('[ia informe-dn comercial]', e.message); }

    res.json({ success: true, data: { id, rut, ...x, productos, n_informes: ult.length, fecha_informes: ult[0]?.created_at, guardado, modelo: r.modelo, tokens_in: r.tokens_in, tokens_out: r.tokens_out, costo: r.costo }, error: null });
  } catch (e) {
    if (e.code === 'NO_KEY') return res.status(503).json({ success: false, data: null, error: 'La IA no está configurada (falta ANTHROPIC_API_KEY).' });
    if (e.code === 'IA_OFF') return res.status(403).json({ success: false, data: null, error: 'La IA para informe crediticio está desactivada. Actívala en Mantenedores → Inteligencia Artificial.' });
    console.error('[ia informe-dn]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al analizar: ' + e.message });
  }
};

/* GET /api/ia/informe-dealernet/historial?limit=10 */
exports.historial = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const [rows] = await pool.query('SELECT id, fecha, rut, nivel_riesgo, resumen, costo_usd FROM ia_informes_dealernet ORDER BY fecha DESC LIMIT ?', [limit]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[ia informe-dn historial]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
