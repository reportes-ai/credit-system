'use strict';
const pool = require('../../../../shared/config/database');

// Glosario de definiciones de negocio usadas en el sistema (editable por el Admin).
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS definiciones (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      termino     VARCHAR(120) NOT NULL,
      definicion  TEXT NOT NULL,
      categoria   VARCHAR(60) DEFAULT 'General',
      orden       INT DEFAULT 0,
      fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM definiciones');
    if (n === 0) {
      const seed = [
        ['Umbral UF (tramo MENOR/MAYOR)', 'Valor en UF (por defecto 200) que separa las operaciones en tramo MENOR o MAYOR. Se recalcula con la UF de la fecha de otorgamiento. Editable en Tasas → Modificar Umbrales.', 'Créditos'],
        ['MAYOR / MENOR 200 UF', 'Clasificación de una operación según si el saldo precio (en UF de su fecha de otorgamiento) supera o no el umbral. Determina la tasa/TMC aplicada.', 'Créditos'],
        ['TMC (Tasa Máxima Convencional)', 'Tasa máxima legal por período y por tramo (menor/mayor 200 UF), cargada por rango de fechas en el mantenedor de Tasas. Base del ingreso por tasa y del interés por mora.', 'Créditos'],
        ['Saldo Precio', 'Monto que AutoFin/financiera paga al concesionario por la operación. Se gestiona en Post Venta (orden de pago, envío a pago, pago).', 'Post Venta'],
        ['Orden de Pago Emitida', 'Etapa Post Venta: se generó la orden de pago del saldo precio (correlativo OP-AAAA-NNNNN) y se envió a Contabilidad. Se marca automáticamente desde Emisión Orden de Pago.', 'Post Venta'],
        ['Enviado a Pago', 'Etapa Post Venta intermedia: el Gerente Comercial (u otro habilitado) fijó la selección de operaciones a pagar. Quedan firmes en cola para que Tesorería confirme el pago.', 'Post Venta'],
        ['Gasto de Cobranza', 'Cargo por gestión de cobranza (Ley 19.496), aplicable solo tras 20 días corridos del vencimiento (día 21). Se calcula por tramos marginales sobre la deuda en UF: hasta 10 UF → 9%, 10–50 UF → 6%, sobre 50 UF → 3%. La UF se fija en el día 21.', 'Cobranza'],
        ['Interés por Mora', 'Interés diario simple (no compuesto) sobre el valor de la cuota original, usando la TMC vigente al día de mora, sumado por los días de atraso.', 'Cobranza'],
      ];
      let orden = 1;
      for (const [termino, definicion, categoria] of seed)
        await pool.query('INSERT INTO definiciones (termino, definicion, categoria, orden) VALUES (?,?,?,?)', [termino, definicion, categoria, orden++]);
    }
    console.log('✓ Mantenedores: tabla definiciones verificada');
  } catch (e) { console.error('✗ definiciones migración:', e.message); }
})();

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM definiciones ORDER BY categoria, orden, termino');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const crear = async (req, res) => {
  try {
    const { termino, definicion, categoria } = req.body || {};
    if (!termino || !definicion) return res.status(400).json({ success: false, data: null, error: 'término y definición requeridos' });
    const [[{ mx }]] = await pool.query('SELECT COALESCE(MAX(orden),0)+1 AS mx FROM definiciones');
    const [ins] = await pool.query('INSERT INTO definiciones (termino, definicion, categoria, orden) VALUES (?,?,?,?)',
      [termino, definicion, categoria || 'General', mx]);
    res.json({ success: true, data: { id: ins.insertId }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const actualizar = async (req, res) => {
  try {
    const { termino, definicion, categoria } = req.body || {};
    if (!termino || !definicion) return res.status(400).json({ success: false, data: null, error: 'término y definición requeridos' });
    await pool.query('UPDATE definiciones SET termino=?, definicion=?, categoria=? WHERE id=?',
      [termino, definicion, categoria || 'General', req.params.id]);
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const eliminar = async (req, res) => {
  try {
    await pool.query('DELETE FROM definiciones WHERE id=?', [req.params.id]);
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAll, crear, actualizar, eliminar };
