/* ─────────────────────────────────────────────────────────────────────────────
   AF_RENT — Motor de cálculo de rentabilidad (mismas fórmulas que el Simulador de
   Rentabilidad /simulador/). Lo usa el Simulador y la pestaña Rentabilidad de las
   Cartas de Aprobación, para que nunca diverjan.

   AF_RENT.calcular(inp, P, UF, T) → desglose AutoFin vs UAC.
     T = fila de tasas vigente (/api/tasas/vigente): tasa_mensual_menor/mayor y
         spread_menor/mayor (en %). Define el costo de fondo (CF = mensual_mayor −
         spread_mayor) y los spreads por tramo. Si se omite, usa los parámetros viejos.
     inp = {
       valor, pie, plazo,
       gastos:  { prenda, gps, rep, lim },       // booleans (default todos true)
       seguros: { desg, rdh, cesa },             // booleans (default todos true)
       tasaCli,            // % cliente mensual en decimal; si null → TMC automática
       esPatio,            // true = Patio/Parque (cobra parque 2,5%); false = Calle
       corfo,              // producto CORFO (ingreso extra AutoFin)
       dealerComCLP,       // override comisión dealer en $ (part_bruto de la carta). Si null → pizarra
       uacPct,             // % UAC del tier vigente (decimal). Si null → tier1
     }
     P  = objeto parametros_credito (obj). UF = valor UF.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const segRate = (P, tipo, plazo) => {
    // tipo: 'd' | 'r' | 'c'
    const k = plazo <= 6 ? 6 : plazo <= 12 ? 12 : plazo <= 24 ? 24 : plazo <= 36 ? 36 : plazo <= 48 ? 48 : 72;
    return (P['seg_' + tipo + '_' + k] || 0);
  };
  // Pizarra dealer: delega en el MOTOR ÚNICO /js/comision-dealer.js (AF_COM_DEALER);
  // copia local solo como fallback si el motor no está cargado en la página.
  const _CD = (typeof window !== 'undefined' && window.AF_COM_DEALER) ||
              (typeof module !== 'undefined' ? (() => { try { return require('./comision-dealer'); } catch (_) { return null; } })() : null);
  const dealerPctPizarra = (P, plazo) => {
    if (_CD) return _CD.pizarraParque(plazo, P);
    if (plazo <= 6)  return (P.dealer_pct_6  || 0) / 100;
    if (plazo <= 12) return (P.dealer_pct_12 || 0) / 100;
    if (plazo <= 24) return (P.dealer_pct_24 || 0) / 100;
    if (plazo <= 36) return (P.dealer_pct_36 || 0) / 100;
    return (P.dealer_pct_99 || 0) / 100;
  };
  const dealerCallePctPizarra = (P, plazo) => {
    if (_CD) return _CD.pizarraCalle(plazo, P);
    const patio = (P.patio_pct || 0) / 100;
    const fb = dealerPctPizarra(P, plazo) + patio;
    if (plazo <= 6)  return P.dealer_calle_pct_6  != null ? P.dealer_calle_pct_6  / 100 : fb;
    if (plazo <= 12) return P.dealer_calle_pct_12 != null ? P.dealer_calle_pct_12 / 100 : fb;
    if (plazo <= 24) return P.dealer_calle_pct_24 != null ? P.dealer_calle_pct_24 / 100 : fb;
    if (plazo <= 36) return P.dealer_calle_pct_36 != null ? P.dealer_calle_pct_36 / 100 : fb;
    return P.dealer_calle_pct_99 != null ? P.dealer_calle_pct_99 / 100 : fb;
  };

  function calcular(inp, P, UF, T) {
    P = P || {};
    T = T || {};
    const g = inp.gastos || { prenda: true, gps: true, rep: true, lim: true };
    const s = inp.seguros || { desg: true, rdh: true, cesa: true };
    const valor = Math.round(inp.valor || 0);
    const pie   = Math.round(inp.pie || 0);
    const plazo = Math.min(72, Math.max(1, parseInt(inp.plazo) || 0));
    const saldo = valor - pie;
    if (!valor || !plazo || saldo <= 0) return null;

    // Gastos operacionales (la inscripción siempre va)
    const gastos = (g.prenda ? (P.prenda || 0) : 0)
                 + (g.gps    ? (P.gps_24meses || 0) : 0)
                 + (g.rep    ? (P.reparaciones_menores || 0) : 0)
                 + (g.lim    ? (P.limitacion_dominio || 0) : 0)
                 + (P.inscripcion || 0);
    const sub_sin_seg = saldo + gastos;

    // Seguros (primas capitalizadas)
    const rateDesg = s.desg ? segRate(P, 'd', plazo) : 0;
    const rateRdh  = s.rdh  ? segRate(P, 'r', plazo) : 0;
    const rateCesa = s.cesa ? segRate(P, 'c', plazo) : 0;
    const totalRate = rateDesg + rateRdh + rateCesa;
    const factorSeg = totalRate > 0 ? 1 / (1 - totalRate) : 1;
    const capital   = Math.round(sub_sin_seg * factorSeg);
    const primaDesg = Math.round(capital * rateDesg);
    const primaRdh  = Math.round(capital * rateRdh);
    const primaCesa = Math.round(capital * rateCesa);
    const totalPrimas = primaDesg + primaRdh + primaCesa;
    const monto_fin = sub_sin_seg + totalPrimas;

    // Mayor / menor 200 UF
    const limite200 = UF ? 200 * UF : null;
    const esMayor   = limite200 ? monto_fin > limite200 : false;
    // Tasas vigentes = FUENTE DE VERDAD (módulo de tasas). Vienen en % (2.5525, 0.67).
    // Fallback a parámetros viejos solo si no se pasa la tabla de tasas.
    const mensualMenor = (T.tasa_mensual_menor != null) ? Number(T.tasa_mensual_menor) / 100 : (P.autofin_tmc_menor_200 || 33.60) / 100 / 12;
    const mensualMayor = (T.tasa_mensual_mayor != null) ? Number(T.tasa_mensual_mayor) / 100 : (P.autofin_tmc_mayor_200 || 29.40) / 100 / 12;
    const spreadMayor  = (T.spread_mayor != null) ? Number(T.spread_mayor) / 100 : (P.autofin_spread_fondo || 0.67) / 100;
    const tasaAuto  = esMayor ? mensualMayor : mensualMenor;
    const tasaCli   = (inp.tasaCli != null && inp.tasaCli > 0) ? inp.tasaCli : tasaAuto;

    // ── AutoFin: ingreso por colocación (VP de la cuota al costo de fondo) ──
    // CF = tasa_mensual_mayor − spread_mayor (igual para ambos tramos; ver módulo de tasas).
    // Así el spread ganado = spread_mayor (0,67%) en >200 UF y spread_menor (implícito) en ≤200 UF.
    const costoFondo = mensualMayor - spreadMayor;
    const cuotaDe = (tasa) => monto_fin * tasa * Math.pow(1 + tasa, plazo) / (Math.pow(1 + tasa, plazo) - 1);
    // Ingreso por colocación: MOTOR ÚNICO rentabilidad-core (mismo cálculo que guardar/recalcular).
    // Fallback a la fórmula inline si el core no cargó (cero regresión).
    const CORE = (typeof window !== 'undefined' && window.AF_RENT_CORE) ? window.AF_RENT_CORE : null;
    const ingColAF = (tCli) => CORE
      ? CORE.ingresoColocacionAutoFin({ montoCap: monto_fin, plazo, tasaCli: tCli, costoFondo })
      : ((tCli > 0 && costoFondo > 0) ? Math.round(cuotaDe(tCli) * (1 - Math.pow(1 + costoFondo, -plazo)) / costoFondo - monto_fin) : 0);
    const ing_tasa_af = ingColAF(tasaCli);
    let com_corfo_af = 0;
    if (inp.corfo) {
      const corfoSpread = esMayor ? 0.004 : 0.005;
      if (tasaCli - corfoSpread > 0) com_corfo_af = ingColAF(tasaCli - corfoSpread);
    }

    // ── UAC: % sobre saldo precio (tier vigente) ──
    const uacPct = (inp.uacPct != null && inp.uacPct > 0) ? inp.uacPct : ((P.uac_pct_tier1 || 14) / 100);
    const ing_tasa_uac = CORE ? CORE.ingresoColocacionUAC({ saldo, pctUAC: uacPct }) : Math.round(saldo * uacPct);

    // ── Ingreso por seguros: % traspaso AutoFin PAREJO sobre cada prima ──
    // Modelo 2026-07: AutoFin recibe la prima como comisión y nos traspasa el
    // seg_pct_traspaso_autofin (30%) de cada seguro (RDH ya incluye desgravamen).
    // Reparaciones Menores también comisiona (es prima, aunque se digita en gastos).
    // UAC no paga comisión de seguros.
    const pctTraspaso = (P.seg_pct_traspaso_autofin > 0 ? P.seg_pct_traspaso_autofin : 30) / 100;
    const ing_seg_desg = Math.round(primaDesg * pctTraspaso); // legado: hoy prima desg = 0 (va dentro del RDH)
    const ing_seg_rdh  = Math.round(primaRdh  * pctTraspaso);
    const ing_seg_cesa = Math.round(primaCesa * pctTraspaso);
    const ing_seg_rep  = g.rep ? Math.round((P.reparaciones_menores || 0) * pctTraspaso) : 0;
    const ing_seg_af   = ing_seg_desg + ing_seg_cesa + ing_seg_rdh + ing_seg_rep;

    // ── Comisiones (descuentos) ──
    const patioPct = (P.patio_pct || 2.50) / 100;
    let com_dealer, com_patio;
    if (inp.dealerComCLP != null && inp.dealerComCLP > 0) {
      // "La carta manda": comisión dealer real negociada
      com_dealer = Math.round(inp.dealerComCLP);
      com_patio  = inp.esPatio ? Math.round(saldo * patioPct) : 0;
    } else if (inp.esPatio) {
      com_dealer = Math.round(saldo * dealerPctPizarra(P, plazo));
      com_patio  = Math.round(saldo * patioPct);
    } else {
      com_dealer = Math.round(saldo * dealerCallePctPizarra(P, plazo));
      com_patio  = 0;
    }
    const pctEj  = (P.pct_ejecutivo_fin || 2.12) / 100;
    const com_ej = CORE ? CORE.comisionEjecutivo({ montoFin: monto_fin, pctEj }) : Math.round(monto_fin * pctEj);
    const total_cos = com_dealer + com_patio + com_ej;

    const cuota_af  = tasaCli > 0 ? Math.round(cuotaDe(tasaCli)) : Math.round(monto_fin / plazo);
    const cuota_uac = cuota_af;

    const rentab_af  = ing_tasa_af + ing_seg_af + com_corfo_af - total_cos;
    const rentab_uac = ing_tasa_uac - total_cos; // UAC no paga seguros

    return {
      saldo, gastos, plazo, monto_fin, capital, esMayor,
      tasaCli, tasaCliPct: tasaCli * 100,
      primas: { desg: primaDesg, rdh: primaRdh, cesa: primaCesa, total: totalPrimas },
      uacPct,
      costos: { dealer: com_dealer, patio: com_patio, ejecutivo: com_ej, total: total_cos, esPatio: !!inp.esPatio },
      af:  { ing_tasa: ing_tasa_af, ing_seg: ing_seg_af, ing_seg_desg, ing_seg_cesa, ing_seg_rdh, ing_seg_rep, com_corfo: com_corfo_af,
             total_ing: ing_tasa_af + ing_seg_af + com_corfo_af, rentab: rentab_af,
             pct: monto_fin ? rentab_af / monto_fin * 100 : 0, cuota: cuota_af },
      uac: { ing_tasa: ing_tasa_uac, ing_seg: 0, ing_seg_desg: 0, ing_seg_cesa: 0, ing_seg_rdh: 0, com_corfo: 0,
             total_ing: ing_tasa_uac, rentab: rentab_uac,
             pct: monto_fin ? rentab_uac / monto_fin * 100 : 0, cuota: cuota_uac },
    };
  }

  window.AF_RENT = { calcular };
})();
