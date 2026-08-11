'use strict';
/* ════════════════════════════════════════════════════════════════════════
   ¿LA CUOTA CUADRA CON SU CRÉDITO?
   MOTOR ÚNICO de la validación. Nació del caso 26080010: alguien calculó la
   cuota sobre el SALDO PRECIO en vez del monto del crédito ($153.762 en vez de
   $204.406) y el sistema la guardó sin decir nada — la operación quedó con una
   cuota que no correspondía a ningún cálculo suyo.
   No bloquea: la financiera a veces redondea o incluye un cargo que no
   modelamos. Avisa, muestra la esperada y pide confirmar.
   Tolerancia paramétrica (`parametros_credito.cuota_tolerancia_pct`).
   ════════════════════════════════════════════════════════════════════════ */
const pool = require('./config/database');
const core = require('../api-gateway/public/js/rentabilidad-core');

let TOL_PCT = 2;            // % de diferencia aceptada, por defecto
let cargado = 0;
async function tolerancia() {
  if (Date.now() - cargado < 60000) return TOL_PCT;               // caché 60 s
  try {
    const [[r]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='cuota_tolerancia_pct' LIMIT 1");
    const v = parseFloat(r && r.valor);
    if (Number.isFinite(v) && v >= 0) TOL_PCT = v;
  } catch (_) { /* sin tabla/valor: queda el default */ }
  cargado = Date.now();
  return TOL_PCT;
}

/**
 * @returns {Promise<null | {esperada:number, digitada:number, dif:number, dif_pct:number, mensaje:string}>}
 *          null = cuadra (o faltan datos para opinar).
 */
async function revisarCuota({ monto, tasa, plazo, cuota }) {
  const m = Number(monto) || 0, t = Number(tasa) || 0, p = parseInt(plazo) || 0, c = Number(cuota) || 0;
  if (!(m > 0 && t > 0 && p > 0 && c > 0)) return null;           // sin la tripleta no hay nada que comparar
  const esperada = Math.round(core.cuotaFrancesa(m, t / 100, p));
  if (!(esperada > 0)) return null;
  const dif = c - esperada;
  const difPct = Math.abs(dif) / esperada * 100;
  const tol = await tolerancia();
  if (difPct <= tol) return null;
  const clp = v => '$' + Math.round(v).toLocaleString('es-CL');
  return {
    esperada, digitada: c, dif, dif_pct: Math.round(difPct * 10) / 10,
    mensaje: `La cuota digitada (${clp(c)}) no cuadra con el crédito: con ${clp(m)} a ${t}% en ${p} cuotas corresponde ${clp(esperada)} ` +
             `(${dif > 0 ? '+' : '−'}${clp(Math.abs(dif))}, ${Math.round(difPct * 10) / 10}%). ` +
             `Revisa que no se haya calculado sobre el saldo precio. Si el valor es el del pagaré, confirma para guardarlo igual.`,
  };
}

/* Semilla del parámetro (idempotente): se ejecuta una vez al primer require. */
(async () => {
  try {
    await pool.query(`INSERT IGNORE INTO parametros_credito (clave, valor, descripcion)
      VALUES ('cuota_tolerancia_pct','2','Diferencia máxima (%) entre la cuota digitada y la cuota francesa calculada antes de pedir confirmación')`);
  } catch (_) { /* la tabla puede no existir todavía en un boot temprano */ }
})();

module.exports = { revisarCuota, tolerancia };
