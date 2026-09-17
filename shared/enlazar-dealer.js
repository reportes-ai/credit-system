'use strict';
/* ── Enlace crédito → ficha del dealer (id_dealer) por RUT — motor único ─────────────
   El crédito guarda el RUT del dealer, pero Post Venta, las Órdenes de Pago y el archivo
   TEF leen la ficha (banco, cuenta, correo, categoría) por `id_dealer`. El enlace solo se
   hacía en la carga masiva y en la corrección de dealer de la carta: el crédito que nace
   al OTORGAR UNA CARTA (y el de la carga Trinidad) quedaba con RUT pero sin ficha.
   Medido el 17-09-2026: 125 de los 272 otorgados desde jul-26 sin id_dealer, y 4 órdenes
   de comisión FUERA del TEF por llegar sin banco ni cuenta (Pato).

   · RUT comparado sin puntos, guion ni espacios y en mayúsculas (la base es case-sensitive).
   · Si un RUT tiene varias fichas gana la que tiene cuenta y, entre esas, la activa
     (mismo criterio que completarPagoPorRut de Post Venta).
   · Solo rellena los que están SIN enlace: nunca cambia un id_dealer ya puesto.
   · El motor de comisión dealer NO depende de id_dealer (busca por RUT): enlazar no mueve montos. */
const pool = require('./config/database');
const N = col => `UPPER(REPLACE(REPLACE(REPLACE(${col},'.',''),'-',''),' ',''))`;

/* enlazar({ idCredito }) → un crédito · enlazar() → todos los pendientes. Devuelve cuántos enlazó. */
async function enlazar({ idCredito = null } = {}) {
  const [r] = await pool.query(
    `UPDATE creditos c
        SET c.id_dealer = (
          SELECT d.id_dealer FROM dealers d
           WHERE ${N('d.rut')} = ${N('c.rut_dealer')}
           ORDER BY (d.num_cuenta IS NOT NULL AND d.num_cuenta <> '') DESC, COALESCE(d.activo,1) DESC, d.id_dealer DESC
           LIMIT 1)
      WHERE (c.id_dealer IS NULL OR c.id_dealer = 0)
        AND c.rut_dealer IS NOT NULL AND c.rut_dealer <> ''
        ${idCredito ? 'AND c.id = ?' : ''}
        AND EXISTS (SELECT 1 FROM dealers d2 WHERE ${N('d2.rut')} = ${N('c.rut_dealer')})`,
    idCredito ? [idCredito] : []);
  return r.affectedRows || 0;
}

/* Red de seguridad diaria: cualquier vía nueva que cree créditos sin enlazar queda cubierta. */
async function barrido() {
  try {
    const n = await enlazar();
    if (n) console.log(`[enlazar-dealer] ${n} crédito(s) enlazados a su ficha de dealer por RUT`);
  } catch (e) { console.error('[enlazar-dealer]', e.message); }
}
require('./scheduler').programar('creditos-enlazar-dealer', barrido, 6 * 60 * 60 * 1000, { arranqueFn: barrido });

module.exports = { enlazar, barrido };
