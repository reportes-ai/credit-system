/* ─────────────────────────────────────────────────────────────────────────────
   AF_PREF — MOTOR ÚNICO DE "¿EN QUÉ FINANCIERA CURSO?"

   Responde una sola pregunta: dadas la rentabilidad AutoFin y la rentabilidad
   Unidad de Crédito de una operación, ¿dónde conviene cursarla?

   Lo usan:
     · la PWA /donde-curso/ (el ejecutivo, antes de cursar)
     · el informe /reporteria/rentabilidad-creditos/ (después, para auditar)
   Así el ejecutivo en la calle y el informe de gerencia nunca dicen cosas
   distintas de la misma operación.

   NO calcula rentabilidad: eso es de AF_RENT (/js/rentabilidad-calc.js). Acá
   solo se decide con los dos números ya calculados.

   Dos reglas, en este orden:
     1. ELEGIBILIDAD — el cuadro de Preferencia de Financiera (mantenedor
        financiera_preferencia) dice qué financiera acepta ese plazo y ese
        saldo. Una financiera que no puede tomar la operación no compite,
        por muy rentable que se vea.
     2. RENTABILIDAD — si ambas pueden, gana la más rentable; pero si la
        diferencia es menor al umbral (10% por defecto, parametrizable en
        Parámetros del Crédito → pref_diff_pct), la plata es prácticamente la
        misma y la decisión se le devuelve al ejecutivo: "Decides Tú".
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var DIFF_PCT_DEF = 10;        // % bajo el cual da lo mismo
  var RENT_MIN_DEF = 100000;    // $ mínimos para que valga la pena cursar

  /* Un límite del cuadro puede venir en $ ("4000000"), en UF ("200 UF") o
     abierto ("SIN TOPE" / "NO SE PUEDE"). Se resuelve a pesos. */
  function saldoNum(v, def, UF) {
    var s = String(v == null ? '' : v).toUpperCase().trim();
    if (!s || s.indexOf('SIN TOPE') >= 0 || s.indexOf('NO SE PUEDE') >= 0) return def;
    if (s.indexOf('UF') >= 0) {
      var n = parseFloat(s.replace(/[^0-9.]/g, ''));
      return (UF && n) ? n * UF : def;
    }
    var m = parseInt(s.replace(/[^0-9]/g, ''), 10);
    return isNaN(m) ? def : m;
  }
  function esSi(v) {
    var s = String(v == null ? '' : v).toUpperCase().trim();
    return s.charAt(0) === 'S' || v === true || v === 1 || s === '1';
  }

  /* Qué dice el cuadro para (plazo, saldo).
     → { af:bool, uac:bool, pref:'AF'|'UAC'|null }  (pref = 1ª opción declarada) */
  function segunCuadro(plazo, saldo, tabla, UF) {
    var p = parseInt(plazo, 10) || 0;
    var vacio = { af: true, uac: true, pref: null };   // sin cuadro: no se descarta a nadie
    if (!p || !saldo || !tabla || !tabla.length) return vacio;

    // Formato nuevo: grilla cuotas (cd–ch) × saldo (sd–sh)
    var row = null, i, r;
    for (i = 0; i < tabla.length; i++) {
      r = tabla[i];
      if (r.cd == null && r.sd == null) continue;
      var cd = parseInt(r.cd != null ? r.cd : r.desde, 10);
      var ch = parseInt(r.ch != null ? r.ch : r.hasta, 10);
      if (p >= cd && p <= ch && saldo >= saldoNum(r.sd, 0, UF) && saldo <= saldoNum(r.sh, Infinity, UF)) { row = r; break; }
    }
    if (row) {
      var afOk = esSi(row.af), unOk = esSi(row.un);
      var pr = String(row.pref || row.preferente || '').toUpperCase();
      pr = pr.indexOf('UNIDAD') >= 0 ? 'UAC' : (pr.indexOf('AUTOFIN') >= 0 ? 'AF' : null);
      if (pr === 'AF' && !afOk) pr = unOk ? 'UAC' : null;
      else if (pr === 'UAC' && !unOk) pr = afOk ? 'AF' : null;
      else if (!pr) pr = afOk ? 'AF' : (unOk ? 'UAC' : null);
      return { af: afOk, uac: unOk, pref: pr };
    }

    // Compat: formato viejo (rangos de saldo por financiera)
    var old = null;
    for (i = 0; i < tabla.length; i++) {
      r = tabla[i];
      if (r.af_min != null && p >= parseInt(r.desde, 10) && p <= parseInt(r.hasta, 10)) { old = r; break; }
    }
    if (!old) return vacio;
    var enRango = function (mn, mx) {
      if (String(mn).toUpperCase().indexOf('NO SE PUEDE') >= 0) return false;
      return saldo >= saldoNum(mn, 0, UF) && saldo <= saldoNum(mx, Infinity, UF);
    };
    var a = enRango(old.af_min, old.af_max), u = enRango(old.un_min, old.un_max);
    var decl = String(old.preferente || 'AUTOFIN').toUpperCase().indexOf('UNIDAD') >= 0 ? 'UAC' : 'AF';
    return { af: a, uac: u, pref: (a && u) ? decl : (a ? 'AF' : (u ? 'UAC' : null)) };
  }

  /* Primera opción del cuadro, sin mirar rentabilidad. Es lo que consume el
     informe de rentabilidad en su columna "Según cuadro". */
  function preferenteSegunTabla(plazo, saldo, tabla, UF) {
    return segunCuadro(plazo, saldo, tabla, UF).pref;
  }

  /* Diferencia relativa entre las dos rentabilidades, medida sobre la MENOR
     (misma base que usa el informe para su chip "vs otra"). Si la menor es
     cero o negativa no hay porcentaje que valga: se considera diferencia total. */
  function diferenciaPct(a, b) {
    var mayor = Math.max(a, b), menor = Math.min(a, b);
    if (mayor === menor) return 0;
    if (menor <= 0) return Infinity;
    return (mayor - menor) / Math.abs(menor) * 100;
  }

  /* LA DECISIÓN.
       inp = { rentAF, rentUAC, plazo, saldo, tabla, UF, diffPct, rentMinima }
     → { veredicto: 'AUTOFIN'|'UNIDAD'|'DECIDES_TU'|'NINGUNA',
         motivo, diffPct, ganadora:'AF'|'UAC'|null, rentGanadora,
         elegible:{af,uac}, prefCuadro, bajoMinimo:bool } */
  function decidir(inp) {
    inp = inp || {};
    var rentAF  = Number(inp.rentAF)  || 0;
    var rentUAC = Number(inp.rentUAC) || 0;
    var umbral  = (inp.diffPct    != null && inp.diffPct    !== '') ? Number(inp.diffPct)    : DIFF_PCT_DEF;
    var rentMin = (inp.rentMinima != null && inp.rentMinima !== '') ? Number(inp.rentMinima) : RENT_MIN_DEF;

    var cuadro = segunCuadro(inp.plazo, inp.saldo, inp.tabla, inp.UF);
    var out = {
      diffPct: diferenciaPct(rentAF, rentUAC),
      elegible: { af: cuadro.af, uac: cuadro.uac },
      prefCuadro: cuadro.pref,
      ganadora: rentAF === rentUAC ? null : (rentAF > rentUAC ? 'AF' : 'UAC'),
      rentGanadora: Math.max(rentAF, rentUAC),
      bajoMinimo: false,
    };

    // 1) Elegibilidad: si el cuadro deja fuera a una, no hay nada que comparar.
    if (!cuadro.af && !cuadro.uac) {
      out.veredicto = 'NINGUNA';
      out.motivo = 'Para este plazo y este saldo, el cuadro de preferencia no habilita ninguna financiera.';
      out.ganadora = null; out.rentGanadora = 0;
      return out;
    }
    if (!cuadro.af || !cuadro.uac) {
      var solo = cuadro.af ? 'AF' : 'UAC';
      out.veredicto = solo === 'AF' ? 'AUTOFIN' : 'UNIDAD';
      out.ganadora = solo;
      out.rentGanadora = solo === 'AF' ? rentAF : rentUAC;
      out.motivo = 'Es la única que toma este plazo con este saldo.';
      out.bajoMinimo = out.rentGanadora < rentMin;
      return out;
    }

    // 2) Rentabilidad: gana la más alta, salvo que la diferencia sea despreciable.
    out.bajoMinimo = out.rentGanadora < rentMin;
    if (out.diffPct < umbral) {
      out.veredicto = 'DECIDES_TU';
      out.motivo = 'La diferencia es de ' + out.diffPct.toFixed(1).replace('.', ',') +
                   '%, menos del ' + umbral + '% — para la empresa da lo mismo.';
      return out;
    }
    out.veredicto = out.ganadora === 'AF' ? 'AUTOFIN' : 'UNIDAD';
    out.motivo = 'Deja ' + out.diffPct.toFixed(1).replace('.', ',') + '% más que la otra.';
    return out;
  }

  var API = { decidir: decidir, segunCuadro: segunCuadro, preferenteSegunTabla: preferenteSegunTabla,
              diferenciaPct: diferenciaPct, DIFF_PCT_DEF: DIFF_PCT_DEF, RENT_MIN_DEF: RENT_MIN_DEF };
  if (typeof window !== 'undefined') window.AF_PREF = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
