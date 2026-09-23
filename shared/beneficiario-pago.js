'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   BENEFICIARIO DEL PAGO — motor único (Pato, 23-09-2026).
   Un dealer/parque puede cobrar en la cuenta de un tercero (poder para depositar
   en la cuenta de un socio: COMPRA VENTA VERA LTDA → cuenta de Víctor Vera). El
   banco valida RUT + nombre CONTRA LA CUENTA, así que RUT y nombre del archivo TEF
   tienen que ser los del TITULAR de la cuenta, como PAR: el 22-09-2026 el TEF salió
   con el RUT de la empresa y la cuenta de la persona y el banco lo rechazó.

   Regla: si la ficha trae un RUT de pago distinto del RUT del proveedor → van el
   RUT de pago y el titular de la cuenta (si no hay titular, el nombre del proveedor,
   que el banco probablemente rechace: se marca `incompleto`). Si no hay RUT de pago
   o es el mismo → RUT y nombre del proveedor.
   ═══════════════════════════════════════════════════════════════════════════ */
const norm = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();

/* beneficiarioPago({ rut, nombre, rut_pago, nombre_cuenta }) → { rut, nombre, tercero, incompleto } */
function beneficiarioPago({ rut, nombre, rut_pago, nombre_cuenta } = {}) {
  const rp = norm(rut_pago), r = norm(rut);
  if (rp && rp !== r) {
    const titular = String(nombre_cuenta || '').trim();
    return { rut: rut_pago, nombre: titular || nombre || '', tercero: true, incompleto: !titular };
  }
  return { rut: rut || rut_pago || '', nombre: nombre || '', tercero: false, incompleto: false };
}

/* Deja en cada fila rut_pago / nombre_pago / pago_tercero listos para el TEF y la nómina. */
function aplicarBeneficiario(rows, campos = {}) {
  const { rut = 'rut_dealer', nombre = 'nombre_dealer', rut_pago = 'rut_pago', nombre_cuenta = 'nombre_cuenta' } = campos;
  for (const f of rows || []) {
    const b = beneficiarioPago({ rut: f[rut], nombre: f[nombre], rut_pago: f[rut_pago], nombre_cuenta: f[nombre_cuenta] });
    f.rut_pago = b.rut; f.nombre_pago = b.nombre; f.pago_tercero = b.tercero ? 1 : 0; f.pago_incompleto = b.incompleto ? 1 : 0;
  }
  return rows;
}

module.exports = { beneficiarioPago, aplicarBeneficiario };
if (typeof window !== 'undefined') window.AF_BENEFICIARIO = module.exports;
