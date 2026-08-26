'use strict';
const pool = require('../../../../shared/config/database');
const { comisionDealer, normRutD } = require('../../../../api-gateway/public/js/comision-dealer');

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

    let dealerTabla = null, dealerUbics = null;
    if (rut) {
      try {
        const [dr] = await pool.query(
          "SELECT com_6_12, com_13_24, com_25_36, com_37, com_parque_6_12, com_parque_13_24, com_parque_25_36, com_parque_37 FROM dealers WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ? LIMIT 1",
          [normRutD(rut)]);
        dealerTabla = dr[0] || null;
      } catch (e) { dealerTabla = null; }
      // Tablas POR UBICACIÓN (multi-parque + calle): con ?ubicacion= la columna
      // "parque" del resultado usa la tabla de ESE local; sin el parámetro, legacy.
      try {
        [dealerUbics] = await pool.query(
          `SELECT dc.ubicacion, dc.com_6_12, dc.com_13_24, dc.com_25_36, dc.com_37
             FROM dealer_comisiones dc JOIN dealers d ON d.id_dealer = dc.id_dealer
            WHERE UPPER(REPLACE(REPLACE(REPLACE(d.rut,'.',''),'-',''),' ','')) = ?`, [normRutD(rut)]);
      } catch (e) { dealerUbics = null; }
    }

    const ubic = String(req.query.ubicacion || '').toUpperCase().trim();
    const factor = (plazo, esParque) =>
      comisionDealer({ saldo: 1, plazo, esParque, ubicacion: esParque ? ubic : 'CALLE' },
        { dealerTabla, dealerUbicaciones: dealerUbics, parqData: null, pizarra }).base_pct;

    const tabla = TRAMOS.map(t => ({
      desde:  t.desde,
      hasta:  t.hasta,
      parque: factor(t.plazo, true),
      calle:  factor(t.plazo, false),
    }));

    // tiene_tabla_propia también cuando SOLO existe tabla por ubicación (multi-local):
    // sin esto la carta descartaba el resultado y caía a la pizarra.
    return res.json({ success: true, data: { tabla, tiene_tabla_propia: !!dealerTabla || !!(dealerUbics && dealerUbics.length), ubicaciones: (dealerUbics || []).map(u => u.ubicacion) }, error: null });
  } catch (e) {
    console.error('[comision-dealer tabla]', e.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};
