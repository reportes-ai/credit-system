'use strict';
const pool = require('../../../../shared/config/database');
const ia = require('../../../../shared/ia');
const { analizar } = require('../../../../shared/anthropic');
const { auditar } = require('../../../../shared/audit');

const CODIGO = 'liq_sueldo';

// Auto-registro de la funcionalidad + tabla de historial de análisis.
(async () => {
  try {
    await ia.registrarFuncionalidad({
      codigo: CODIGO,
      nombre: 'Análisis de liquidaciones de sueldo',
      descripcion: 'Extrae líquido/imponible, AFP/Isapre y los cruza con la renta declarada',
      modelo: 'claude-haiku-4-5',
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS ia_liquidaciones (
      id               BIGINT AUTO_INCREMENT PRIMARY KEY,
      fecha            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      id_usuario       INT NULL,
      rut_trabajador   VARCHAR(20) NULL,
      trabajador       VARCHAR(300) NULL,
      rut_empleador    VARCHAR(20) NULL,
      empleador        VARCHAR(300) NULL,
      periodo          VARCHAR(40) NULL,
      sueldo_base      BIGINT NULL,
      total_imponible  BIGINT NULL,
      total_haberes    BIGINT NULL,
      afp_nombre       VARCHAR(120) NULL,
      afp_monto        BIGINT NULL,
      salud_nombre     VARCHAR(120) NULL,
      salud_monto      BIGINT NULL,
      total_descuentos BIGINT NULL,
      sueldo_liquido   BIGINT NULL,
      observaciones    VARCHAR(600) NULL,
      modelo           VARCHAR(60) NULL,
      tokens_in        INT NULL,
      tokens_out       INT NULL,
      costo_usd        DECIMAL(12,6) NULL,
      guardado_cliente TINYINT NOT NULL DEFAULT 0,
      rut_cliente      VARCHAR(15) NULL,
      INDEX idx_fecha (fecha), INDEX idx_rut (rut_trabajador) )`);
  } catch (e) { console.error('[ia liquidaciones init]', e.message); }
})();

const normRut = v => v ? String(v).replace(/\./g, '').toUpperCase().trim() : null;
const ent = v => (v == null || v === '' || isNaN(parseInt(v))) ? null : parseInt(v);

const SYSTEM = `Eres un analista de crédito chileno experto en liquidaciones de sueldo.
Extrae los datos con precisión. Los montos van en pesos chilenos como números ENTEROS, sin puntos, comas ni símbolos.
Si un dato no aparece en el documento, devuélvelo como null. NUNCA inventes valores.`;

const PROMPT = `Extrae los datos de esta liquidación de sueldo y responde EXACTAMENTE con este JSON:
{
  "trabajador": "string|null",
  "rut_trabajador": "string|null",
  "empleador": "string|null",
  "rut_empleador": "string|null",
  "periodo": "string|null",
  "sueldo_base": "number|null",
  "total_imponible": "number|null",
  "total_haberes": "number|null",
  "afp_nombre": "string|null",
  "afp_monto": "number|null",
  "salud_nombre": "string|null",
  "salud_monto": "number|null",
  "total_descuentos": "number|null",
  "sueldo_liquido": "number|null",
  "observaciones": "string|null"
}
"periodo" en formato "Mes Año" (ej "Mayo 2026"). "observaciones": una nota BREVE relevante para evaluar crédito (ej. sueldo variable, descuentos por préstamos), o null.`;

/* POST /api/ia/liquidacion  (multipart: archivo) → analiza y guarda en el historial */
exports.analizar = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, data: null, error: 'Falta el archivo de la liquidación.' });
    const mt = req.file.mimetype || '';
    const esPdf = mt.includes('pdf');
    const esImg = mt.startsWith('image/');
    if (!esPdf && !esImg) return res.status(400).json({ success: false, data: null, error: 'Formato no soportado. Sube un PDF o una imagen (JPG/PNG).' });

    const doc = esPdf
      ? { tipo: 'pdf', data: req.file.buffer.toString('base64') }
      : { tipo: 'image', media_type: mt, data: req.file.buffer.toString('base64') };

    const r = await analizar({
      codigo: CODIGO, id_usuario: req.usuario?.id_usuario,
      system: SYSTEM, prompt: PROMPT, documentos: [doc], json: true, max_tokens: 1200,
    });

    const x = r.datos;
    if (!x) return res.status(422).json({ success: false, data: { texto: r.texto }, error: 'No se pudo interpretar la liquidación. Prueba con una imagen más nítida o un PDF.' });

    let id = null;
    try {
      const [ins] = await pool.query(
        `INSERT INTO ia_liquidaciones
           (id_usuario, rut_trabajador, trabajador, rut_empleador, empleador, periodo,
            sueldo_base, total_imponible, total_haberes, afp_nombre, afp_monto, salud_nombre, salud_monto,
            total_descuentos, sueldo_liquido, observaciones, modelo, tokens_in, tokens_out, costo_usd)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.usuario?.id_usuario || null, normRut(x.rut_trabajador), x.trabajador || null, normRut(x.rut_empleador), x.empleador || null, x.periodo || null,
         ent(x.sueldo_base), ent(x.total_imponible), ent(x.total_haberes), x.afp_nombre || null, ent(x.afp_monto), x.salud_nombre || null, ent(x.salud_monto),
         ent(x.total_descuentos), ent(x.sueldo_liquido), (x.observaciones ? String(x.observaciones).slice(0, 600) : null), r.modelo, r.tokens_in, r.tokens_out, r.costo]);
      id = ins.insertId;
    } catch (e) { console.error('[ia liq historial]', e.message); }

    auditar({ req, accion: 'ANALIZAR', modulo: 'ia', entidad: 'liquidacion', entidad_id: id,
      detalle: `Analizó una liquidación de sueldo con IA (${r.modelo})`, meta: { tokens_in: r.tokens_in, tokens_out: r.tokens_out } });

    res.json({ success: true, data: { id, extraccion: x, modelo: r.modelo, tokens_in: r.tokens_in, tokens_out: r.tokens_out, costo: r.costo }, error: null });
  } catch (e) {
    if (e.code === 'NO_KEY') return res.status(503).json({ success: false, data: null, error: 'La IA no está configurada en el servidor (falta ANTHROPIC_API_KEY).' });
    if (e.code === 'IA_OFF') return res.status(403).json({ success: false, data: null, error: 'La IA para liquidaciones está desactivada. Actívala en Mantenedores → Inteligencia Artificial.' });
    console.error('[ia liquidaciones]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al analizar: ' + e.message });
  }
};

/* POST /api/ia/liquidacion/:id/guardar-cliente → escribe en antecedentes_laborales (upsert PARCIAL) */
exports.guardarCliente = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM ia_liquidaciones WHERE id = ? LIMIT 1', [req.params.id]);
    if (!row) return res.status(404).json({ success: false, data: null, error: 'Análisis no encontrado.' });
    const rut = normRut(row.rut_trabajador);
    if (!rut) return res.status(400).json({ success: false, data: null, error: 'La liquidación no trae el RUT del trabajador; no se puede asociar a un cliente.' });

    const [[cli]] = await pool.query('SELECT id_cliente, nombres, apellido_paterno, apellido_materno FROM clientes WHERE rut = ? LIMIT 1', [rut]);
    if (!cli) return res.status(404).json({ success: false, data: null, error: `No existe un cliente con RUT ${rut}. Créalo primero en Clientes.` });

    // Upsert PARCIAL: solo los campos de la liquidación. No pisa el resto del antecedente.
    await pool.query(
      `INSERT INTO antecedentes_laborales (rut_cliente, tipo_trabajador, empleador, rut_empresa, renta_fija_liquida)
       VALUES (?, 'Dependiente', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         empleador          = VALUES(empleador),
         rut_empresa        = COALESCE(VALUES(rut_empresa), rut_empresa),
         renta_fija_liquida = VALUES(renta_fija_liquida),
         tipo_trabajador    = COALESCE(tipo_trabajador, VALUES(tipo_trabajador)),
         updated_at         = CURRENT_TIMESTAMP`,
      [rut, row.empleador || null, row.rut_empleador || null, row.sueldo_liquido != null ? row.sueldo_liquido : null]);

    await pool.query('UPDATE ia_liquidaciones SET guardado_cliente = 1, rut_cliente = ? WHERE id = ?', [rut, row.id]);

    const nombre = [cli.nombres, cli.apellido_paterno, cli.apellido_materno].filter(Boolean).join(' ') || rut;
    auditar({ req, accion: 'GUARDAR', modulo: 'ia', entidad: 'antecedentes_laborales', entidad_id: rut,
      detalle: `Guardó datos de liquidación (IA) en antecedentes laborales de ${nombre}`, rut });

    res.json({ success: true, data: { rut_cliente: rut, cliente: nombre }, error: null });
  } catch (e) {
    console.error('[ia liq guardarCliente]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al guardar: ' + e.message });
  }
};

/* GET /api/ia/liquidaciones?limit=10 → historial reciente */
exports.historial = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const [rows] = await pool.query(
      `SELECT id, fecha, rut_trabajador, trabajador, empleador, periodo, total_imponible, sueldo_liquido, guardado_cliente, costo_usd
       FROM ia_liquidaciones ORDER BY fecha DESC LIMIT ?`, [limit]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[ia liq historial]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
