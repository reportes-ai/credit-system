// rrhh-core.js — motores únicos de RRHH (Máxima 1), isomorfo backend/frontend
// como rentabilidad-core.js: require() en Node y window.AF_RRHH en el navegador.
(function (root) {
  'use strict';

  // Cuota francesa de préstamos/anticipos al personal (solo capital + interés).
  // La usan: Descuentos Remuneración (creación y preview) y Solicitudes (ejecución).
  function cuotaFrancesa(M, iPct, n) {
    const i = (Number(iPct) || 0) / 100;
    n = Number(n) || 1;
    return i > 0 ? Math.round(M * i / (1 - Math.pow(1 + i, -n))) : Math.round(M / n);
  }

  // Días hábiles L-V entre dos fechas inclusive (sin feriados legales — si algún día
  // se incorporan, se agregan AQUÍ y todos los consumidores quedan corregidos).
  // Acepta Date o 'YYYY-MM-DD'. La usan: vacaciones (cargo en cuenta y solicitud),
  // ausencias y compliance (plazos).
  function diasHabiles(desde, hasta) {
    const d0 = typeof desde === 'string' ? new Date(desde + 'T12:00:00') : new Date(desde);
    const d1 = typeof hasta === 'string' ? new Date(hasta + 'T12:00:00') : new Date(hasta);
    let n = 0;
    for (const d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
      const w = d.getDay();
      if (w !== 0 && w !== 6) n++;
    }
    return n;
  }

  // Provisión / valorización de feriado en pesos: días hábiles ×1,4 corridos ×
  // remuneración diaria (base/30) — la matemática del finiquito (feriado proporcional).
  // La usan: cartola de Vacaciones (provisión), finiquito y analytics.
  function provisionVacaciones(diasHab, base) {
    return Math.max(0, Math.round((Number(diasHab) || 0) * 1.4 * (Number(base) || 0) / 30));
  }

  const api = { cuotaFrancesa, diasHabiles, provisionVacaciones };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AF_RRHH = api;
})(typeof self !== 'undefined' ? self : this);
