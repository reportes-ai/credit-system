/* Motor ÚNICO: fecha de la 1ª cuota a partir del texto de una carta Autofin.
 *
 * Por qué existe: el Informe Canal NO trae este dato (se intentó derivarlo de
 * FechaTerminoContrato − (plazo−1) meses y quedaba desviado varios días — ver
 * services/creditos/src/controllers/carga-trinidad.controller.js). Una fecha de
 * primera cuota inventada corrompe la mora, así que el único origen legítimo es
 * el CUADRO DE PAGO del PDF de la carta (o la digitación manual).
 *
 * Regla: la primera cuota es la fecha de vencimiento MÁS TEMPRANA del cuadro de
 * pago posterior a la fecha de curse. Si el bloque "CUADRO DE PAGO" no se puede
 * aislar (PDF aplanado de otra forma), se cae al texto completo — por eso el
 * filtro por fecha de curse es imprescindible: sin él la fecha del documento o
 * la de aprobación ganarían.
 *
 * Isomorfo: module.exports + window.AF_FECHA_1A_CUOTA.
 */
(function (raiz) {
  'use strict';

  var RE_FECHA = /(\d{2})\/(\d{2})\/(\d{4})/g;

  function aISO(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function fechas(texto) {
    var out = [], m;
    RE_FECHA.lastIndex = 0;
    while ((m = RE_FECHA.exec(String(texto || '')))) {
      var d = new Date(+m[3], +m[2] - 1, +m[1]);
      if (!isNaN(d)) out.push(d);
    }
    return out;
  }

  /* texto: texto plano del PDF. fechaCurse: 'YYYY-MM-DD' (o null).
     Devuelve 'YYYY-MM-DD' o null. NUNCA adivina: sin candidata válida → null. */
  function fechaPrimeraCuota(texto, fechaCurse) {
    var t = String(texto || '');
    var curse = fechaCurse ? new Date(String(fechaCurse).slice(0, 10) + 'T00:00:00') : null;
    if (curse && isNaN(curse)) curse = null;

    // 1) Bloque del cuadro de pago: solo contiene vencimientos de cuotas.
    var blk = t.match(/CUADRO\s+DE\s+PAGO([\s\S]*?)(?:DOCUMENTOS|$)/i);
    var cand = blk ? fechas(blk[1]) : [];
    // 2) Fallback: texto completo (exige curse para no tomar la fecha del documento).
    if (cand.length < 2) cand = curse ? fechas(t) : [];

    if (curse) cand = cand.filter(function (d) { return d > curse; });
    if (!cand.length) return null;
    return aISO(cand.reduce(function (a, b) { return b < a ? b : a; }));
  }

  var api = { fechaPrimeraCuota: fechaPrimeraCuota };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (raiz) raiz.AF_FECHA_1A_CUOTA = api;
})(typeof window !== 'undefined' ? window : null);
