'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   MORA — MOTOR ÚNICO del dinero de la mora (Máxima 1: una magnitud, un motor).

   Dos magnitudes distintas, que NO se fusionan:
     · INTERÉS POR MORA   — diario simple sobre la cuota, a la TMC.
     · GASTO DE COBRANZA  — tramos marginales sobre la deuda en UF.

   Estas funciones vivían dentro de `services/cobranza/.../cobranza.controller.js`.
   Se movieron acá TAL CUAL (auditoría 03-08-2026, hallazgo B-3): el controller
   corre migraciones al importarse, así que el cálculo no se podía probar sin
   levantar la base. El controller las sigue exportando en `_calc` para no romper
   a sus consumidores (certificados, caja, motor de mora).

   No confundir con `public/js/mora-core.js`, que calcula DÍAS de mora y estado de
   cartera. Ese dice *cuánto se atrasó*; este dice *cuánto cuesta ese atraso*.
   ───────────────────────────────────────────────────────────────────────────── */

/* Gasto de cobranza: tramos MARGINALES sobre la deuda en UF (como la tabla de
   tramos del impuesto a la renta). tramos = [{hasta_uf, pct}, …]; el último con
   `hasta_uf` null/vacío cubre el resto de la deuda. */
function calcularGastoCobranza(deudaPesos, ufValor, tramos) {
  const uf = Number(ufValor) || 0;
  const deudaUF = uf > 0 ? (Number(deudaPesos) || 0) / uf : 0;
  let prev = 0, gastoUF = 0;
  const detalle = [];
  for (const t of (tramos || [])) {
    const tope = (t.hasta_uf == null || t.hasta_uf === '') ? Infinity : Number(t.hasta_uf);
    const porcion = Math.max(0, Math.min(deudaUF, tope) - prev);
    const aporte = porcion * (Number(t.pct) || 0) / 100;
    if (porcion > 0) detalle.push({ desde_uf: prev, hasta_uf: tope === Infinity ? null : tope, porcion_uf: porcion, pct: Number(t.pct) || 0, gasto_uf: aporte });
    gastoUF += aporte;
    prev = tope;
    if (deudaUF <= tope) break;
  }
  return { deuda_uf: deudaUF, gasto_uf: gastoUF, gasto_pesos: Math.round(gastoUF * uf), detalle };
}

/* Interés por mora: diario simple sobre la cuota original. Tasa diaria = TMC
   mensual / 30. El día 1 de mora es el SIGUIENTE al vencimiento.

   Modo de tasa (`cobranza_config.mora_tasa_modo`, mantenedor Parámetros de Cobranza):
     'fija_otorgamiento' (default) → TMC vigente a la FECHA DE OTORGAMIENTO del
       crédito, fija para toda la mora (Contrato cláusula 6.1: interés máximo
       convencional según monto y plazo, pactado al originar — Ley 18.010 art. 16
       permite pacto en contrario). Requiere `fechaTasaFija`; sin ella, variable.
     'variable' → cada día usa la TMC vigente de SU mes.
   El tramo del crédito (menor/mayor 200 UF) elige la columna.
     tasas = filas {fecha_desde, fecha_hasta, tasa_mensual_menor, tasa_mensual_mayor} */
function calcularInteresMora(cuota, fechaVenc, fechaCalc, tramo, tasas, fechaTasaFija) {
  const c = Number(cuota) || 0;
  if (!c || !fechaVenc) return { dias: 0, interes: 0, detalle: [] };
  const ini = new Date(fechaVenc + 'T00:00:00Z'); ini.setUTCDate(ini.getUTCDate() + 1); // día 1 de mora
  const fin = new Date((fechaCalc || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  const campo = tramo === 'mayor' ? 'tasa_mensual_mayor' : 'tasa_mensual_menor';
  const tmcDe = (fechaStr) => {
    const row = (tasas || []).find(t => String(t.fecha_desde) <= fechaStr && fechaStr <= String(t.fecha_hasta));
    return row ? (parseFloat(row[campo]) || 0) : 0; // % mensual
  };
  // Tasa fija al otorgamiento: se resuelve UNA vez y aplica a todos los días de mora.
  // Fallback: si a la fecha de otorgamiento no hay TMC cargada (historia incompleta), variable.
  const tmcFija = fechaTasaFija ? tmcDe(String(fechaTasaFija).slice(0, 10)) : 0;
  let dias = 0, interes = 0; const porPeriodo = {};
  for (let d = new Date(ini); d <= fin; d.setUTCDate(d.getUTCDate() + 1)) {
    const fs = d.toISOString().slice(0, 10);
    const tmcMes = tmcFija > 0 ? tmcFija : tmcDe(fs);
    const interesDia = c * (tmcMes / 100) / 30;
    interes += interesDia; dias++;
    const k = tmcMes.toFixed(4);
    porPeriodo[k] = porPeriodo[k] || { tmc_mensual: tmcMes, dias: 0, interes: 0 };
    porPeriodo[k].dias++; porPeriodo[k].interes += interesDia;
  }
  return { dias, interes: Math.round(interes), detalle: Object.values(porPeriodo).map(p => ({ ...p, interes: Math.round(p.interes) })) };
}

/* Fecha de tasa fija para el motor de mora según el modo configurado (null = variable). */
const moraFechaFija = (cfg, fechaOtorgado) =>
  String((cfg && cfg.mora_tasa_modo) || 'fija_otorgamiento') === 'variable' ? null : (fechaOtorgado || null);

/* Suma N días a una fecha 'YYYY-MM-DD' (en UTC, sin sorpresas de huso). */
function addDias(fechaStr, n) {
  const d = new Date(fechaStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { calcularGastoCobranza, calcularInteresMora, moraFechaFija, addDias };
