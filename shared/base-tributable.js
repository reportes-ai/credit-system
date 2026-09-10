'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO — base del Impuesto Único de Segunda Categoría (art. 42 N°1 LIR)

   base = remuneración afecta − AFP − seguro de cesantía del trabajador
          − salud deducible − APV régimen B deducible

   · La remuneración afecta es la TOTAL (sin topar): el tope imponible limita las
     cotizaciones, no la renta que paga impuesto.
   · Salud deducible = la cotización pactada COMPLETA (7% + adicional isapre), con
     tope del 7% del tope imponible (art. 42 N°1 LIR / art. 18 DL 3.500).
   · APV régimen B rebaja la base hasta el tope en pesos que se pase (art. 42 bis).

   Lo usan el motor de liquidaciones (rrhh/remuneraciones.controller → calcLiquidacion)
   y la DJ 1887 (contabilidad), que la aplica al libro de remuneraciones de AVSOFT.
   Validado 10-09-2026 contra el LIBREMUN 2026 de AVSOFT: reproduce el impuesto único
   AL PESO en las 216 liquidaciones ene–ago, usando el tope imponible de cada mes (con
   el tope fijo de 90 UF fallaban 3 de enero por $37–$85). Equivalencia exacta con la
   fórmula anterior del motor de liquidaciones en 200.000 casos al azar.
   ───────────────────────────────────────────────────────────────────────────── */
const R = n => Math.round(Number(n) || 0);

function baseTributable({ remuneracion, afp = 0, afc = 0, salud = 0, apv = 0, topeImponible, saludPct = 7, apvTope = Infinity }) {
  const topeSalud = R(R(topeImponible) * saludPct / 100);
  const saludDeducible = Math.min(R(salud), topeSalud);
  const apvDeducible = Math.min(R(apv), apvTope === Infinity ? Infinity : R(apvTope));
  const base = Math.max(0, R(remuneracion) - R(afp) - saludDeducible - R(afc) - apvDeducible);
  return { base, saludDeducible, apvDeducible };
}

module.exports = { baseTributable };
