'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   SEGREGACIÓN DE FUNCIONES EN PAGOS — motor único (máxima 1)

   QUÉ RESUELVE
   Quien emite / manda a pago una orden NO puede ser quien registra su pago.
   Hasta acá el único candado para pagar era tener Caja Activa: alguien con
   permiso de emitir y con caja podía crear la orden y pagarla solo, sin que
   ninguna segunda persona mirara el monto ni la cuenta de destino. Ese es el
   control clásico de "cuatro ojos" y su ausencia es lo que permite pagar a una
   cuenta cambiada sin que nadie lo note.

   POR QUÉ UN SOLO LUGAR
   Hay más de un punto donde se registra un pago (ODP generales, saldo precio,
   comisiones, comisiones de parques). La regla vive UNA vez acá y todos la
   consultan: si mañana cambia (o se le agrega una excepción), cambia en un
   punto y rige en todos.

   ES PARAMÉTRICA (principio rector)
   El Administrador la activa o desactiva desde el mantenedor Cajas
   (caja_horario_pago.doble_persona). Nace ACTIVA. Si la tabla o la columna aún
   no existen se asume ACTIVA — ante la duda, el resultado seguro es exigir dos
   personas, no permitir el pago solitario.
   ───────────────────────────────────────────────────────────────────────────── */
// El pool se pide recién al consultar el parámetro: así la comparación pura se
// puede probar (y reusar) sin abrir conexión a la base.
const norm = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Caché corto: esto se consulta en cada pago y TiDB cobra por consulta.
let _cache = { exp: 0, valor: true };

async function exigeDoblePersona() {
  if (_cache.exp > Date.now()) return _cache.valor;
  let valor = true;   // fail-safe: sin config, se exige
  try {
    const pool = require('./config/database');
    const [[h]] = await pool.query('SELECT doble_persona FROM caja_horario_pago WHERE id = 1');
    if (h && h.doble_persona != null) valor = !!Number(h.doble_persona);
  } catch (_) { /* tabla/columna aún no creada → se exige */ }
  _cache = { exp: Date.now() + 60000, valor };
  return valor;
}

/* Se llama al guardar el parámetro: sin esto el cambio tardaría hasta 60s. */
function olvidarCache() { _cache = { exp: 0, valor: true }; }

/**
 * ¿Puede esta persona registrar el pago de esta orden?
 * Compara por id_usuario cuando ambos existen; si no, por nombre normalizado
 * (los flujos antiguos guardan solo el nombre del emisor).
 * Las órdenes emitidas por el "Sistema" (sin persona detrás) nunca bloquean.
 *
 * @returns {Promise<{ok:boolean, motivo?:string}>}
 */
async function validarPagador({ idEmisor, nombreEmisor, idPagador, nombrePagador } = {}) {
  if (!(await exigeDoblePersona())) return { ok: true };
  if (!esMismaPersona({ idEmisor, nombreEmisor, idPagador, nombrePagador })) return { ok: true };
  return { ok: false, motivo: 'Esta orden la emitiste tú: el pago debe registrarlo otra persona (segregación de funciones).' };
}

/* Comparación pura (sin BD) — el corazón de la regla, para poder probarla.
   Compara por id cuando ambos existen; si no, por nombre normalizado. */
function esMismaPersona({ idEmisor, nombreEmisor, idPagador, nombrePagador } = {}) {
  const nEmisor = norm(nombreEmisor);
  if (idEmisor == null && (!nEmisor || nEmisor === 'sistema')) return false;   // emitida por un motor automático
  if (idEmisor != null && idPagador != null) return Number(idEmisor) === Number(idPagador);
  return !!nEmisor && nEmisor === norm(nombrePagador);
}

module.exports = { validarPagador, esMismaPersona, exigeDoblePersona, olvidarCache };
