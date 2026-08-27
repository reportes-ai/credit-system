'use strict';
const pool = require('../../../../shared/config/database');
const { comisionDealer, normRutD } = require('../../../../api-gateway/public/js/comision-dealer');

/* ── Vigía de consistencia dealer (caso 88986, 27-08-2026) ─────────────────────
   Un crédito cuyo rut_dealer no calza con la ficha vinculada (id_dealer) manda
   la comisión y la ODP a la CUENTA DE OTRO dealer. La emisión de ODP ya lo
   bloquea; este barrido diario avisa apenas nace un caso, para que la lista
   nunca vuelva a crecer en silencio. Destinatarios en Mantenedores → Avisos. */
require('../../../../shared/avisos').registrarAviso({
  evento: 'dealer_inconsistente', modulo: 'Créditos',
  nombre: 'Crédito con dealer inconsistente (RUT ≠ ficha)',
  descripcion: 'El RUT del dealer del crédito no calza con la ficha vinculada (id_dealer): comisiones, cartola y ODP leerían la cuenta de OTRO dealer. Corregir el dealer de la operación.',
  perfiles: ['Administrador'], prioridad: 'alta', sonido_tipo: 'alarma',
});
require('../../../../shared/scheduler').programar('vigia-dealer-consistencia', async () => {
  const [rows] = await pool.query(`
    SELECT c.num_op FROM creditos c JOIN dealers d ON d.id_dealer = c.id_dealer
     WHERE c.rut_dealer IS NOT NULL AND TRIM(c.rut_dealer) <> ''
       AND REPLACE(REPLACE(UPPER(c.rut_dealer),'.',''),'-','') <> REPLACE(REPLACE(UPPER(d.rut),'.',''),'-','')
     ORDER BY c.fecha_otorgado DESC LIMIT 50`);
  if (!rows.length) return;
  await require('../../../../shared/avisos').avisar('dealer_inconsistente', {
    tipo: 'creditos', prioridad: 'alta',
    titulo: `⚠ ${rows.length} crédito(s) con dealer inconsistente`,
    mensaje: ('El RUT del crédito no calza con la ficha vinculada — la plata iría a otra cuenta. OP: ' +
      rows.map(r => r.num_op).join(', ')).slice(0, 380),
    href: '/creditos/',
  });
}, 24 * 3600 * 1000);

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
