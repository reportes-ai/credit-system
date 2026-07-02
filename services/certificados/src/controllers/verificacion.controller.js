'use strict';
/* Endpoint PÚBLICO de verificación (se escanea desde un teléfono externo).
   Devuelve datos MÍNIMOS para confirmar autenticidad, con el RUT enmascarado. */
const { getVerificable } = require('../../../../shared/verificacion');

const TIPO_LABEL = {
  CERT_PAGO_CUOTA:      'Certificado de Pago de Cuota',
  CERT_PREPAGO:         'Certificado de Prepago',
  CERT_ALZAMIENTO:      'Certificado de Alzamiento de Prenda',
  CERT_CREDITO_VIGENTE: 'Certificado de Crédito Vigente',
  CERT_DEUDA_VIGENTE:   'Certificado de Deuda Vigente',
  CERT_DEUDA_PREPAGO:   'Certificado de Deuda Vigente para Prepago',
  CERT_PREAPROBADO:     'Certificado de Crédito Preaprobado',
  COMPROBANTE_CUOTA:    'Comprobante de Pago de Cuota',
  ORDEN_PAGO:           'Orden de Pago',
  CERT_ANTIGUEDAD:      'Certificado de Antigüedad Laboral',
};

function maskRut(rut) {
  if (!rut) return null;
  const s = String(rut).replace(/\s/g, '');
  const m = s.match(/^([\d.]+)-?([\dkK])$/);
  if (!m) return s;
  const cuerpo = m[1].replace(/\./g, '');
  return `${cuerpo.slice(0, 2)}.•••.•••-${m[2].toUpperCase()}`;
}

const verificar = async (req, res) => {
  try {
    const v = await getVerificable(req.params.codigo);
    if (!v) return res.status(404).json({ success: false, data: null, error: 'Documento no encontrado' });
    res.json({
      success: true,
      data: {
        codigo: v.codigo,
        tipo: v.tipo,
        tipo_label: TIPO_LABEL[v.tipo] || v.tipo,
        num_op: v.num_op,
        nombre: v.nombre,
        rut: maskRut(v.rut),
        emitido: v.created_at,
        emitido_por: v.emitido_por,
        anulado: v.anulado,
        motivo: v.motivo,
        datos: v.datos || {},
      },
      error: null,
    });
  } catch (e) {
    console.error('[verificar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno' });
  }
};

module.exports = { verificar };
