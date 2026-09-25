/* ─────────────────────────────────────────────────────────────────────────────
   Cómo se nombra un dealer en la auditoría y en los avisos.

   Motor único (Máxima 1). Nació el 25-09-2026 porque la auditoría escribía solo
   "el dealer #257" y ese número es el id interno, NO el número del dealer: al
   buscar 257 en el mantenedor salía otro dealer (el que tiene ese número) o
   ninguno. La etiqueta lleva el número que el usuario ve, el nombre y el RUT.

   Ejemplo: "N°262 DYD AUTOMOVILES (76474201-K)"
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

/* Etiqueta legible de un dealer por su id interno. Nunca lanza: si no lo encuentra
   (o la consulta falla), cae al "#id" de siempre para no romper la acción que se audita. */
async function etiqueta(idDealer) {
  const id = Number(idDealer);
  if (!id) return `#${idDealer}`;
  try {
    const [[d]] = await pool.query(
      'SELECT numero, rut, nombre_razon, nombre_indexa FROM dealers WHERE id_dealer=?', [id]);
    if (!d) return `#${id}`;
    const nombre = (d.nombre_razon || d.nombre_indexa || '').trim();
    return [d.numero ? `N°${d.numero}` : `#${id}`, nombre, d.rut ? `(${d.rut})` : '']
      .filter(Boolean).join(' ');
  } catch (e) { return `#${id}`; }
}

module.exports = { etiqueta };
