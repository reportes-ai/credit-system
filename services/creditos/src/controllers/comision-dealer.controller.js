'use strict';
const pool = require('../../../../shared/config/database');
const { comisionDealer, normRutD } = require('../utils/comision-dealer');

// Tramos de la carta (mismos cortes que el array COMISIONES del frontend).
const TRAMOS = [
  { desde: 1,  hasta: 12, plazo: 12 },
  { desde: 13, hasta: 24, plazo: 24 },
  { desde: 25, hasta: 36, plazo: 36 },
  { desde: 37, hasta: 72, plazo: 72 },
];

// GET /api/comision-dealer/tabla?rut_dealer=
// Devuelve la tabla EFECTIVA de comisión dealer (parque/calle por tramo) resuelta por el
// MOTOR ÚNICO: tabla pactada del dealer → pizarra. La consume la carta para no hardcodear.
exports.tabla = async (req, res) => {
  try {
    const rut = req.query.rut_dealer || '';
    const [pr] = await pool.query('SELECT clave, valor FROM parametros_credito');
    const pizarra = {}; pr.forEach(r => pizarra[r.clave] = parseFloat(r.valor));

    let dealerTabla = null;
    if (rut) {
      try {
        const [dr] = await pool.query(
          "SELECT com_6_12, com_13_24, com_25_36, com_37, com_parque_6_12, com_parque_13_24, com_parque_25_36, com_parque_37 FROM dealers WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ? LIMIT 1",
          [normRutD(rut)]);
        dealerTabla = dr[0] || null;
      } catch (e) { dealerTabla = null; }
    }

    const factor = (plazo, esParque) =>
      comisionDealer({ saldo: 1, plazo, esParque }, { dealerTabla, parqData: null, pizarra }).base_pct;

    const tabla = TRAMOS.map(t => ({
      desde:  t.desde,
      hasta:  t.hasta,
      parque: factor(t.plazo, true),
      calle:  factor(t.plazo, false),
    }));

    return res.json({ success: true, data: { tabla, tiene_tabla_propia: !!dealerTabla }, error: null });
  } catch (e) {
    console.error('[comision-dealer tabla]', e.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
