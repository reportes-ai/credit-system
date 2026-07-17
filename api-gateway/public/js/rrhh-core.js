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

  // NOTA: los días hábiles de un rango NO viven aquí — su motor único es
  // shared/feriados.diasHabilesEntre (backend), porque descuenta los feriados
  // legales de la tabla paramétrica y este módulo es puro (sin BD).

  // Provisión / valorización de feriado en pesos: días hábiles ×1,4 corridos ×
  // remuneración diaria (base/30) — la matemática del finiquito (feriado proporcional).
  // La usan: cartola de Vacaciones (provisión), finiquito y analytics.
  function provisionVacaciones(diasHab, base) {
    return Math.max(0, Math.round((Number(diasHab) || 0) * 1.4 * (Number(base) || 0) / 30));
  }

  // Meses de antigüedad COMPLETOS entre dos fechas (descuenta el mes en curso si el
  // día aún no llega). La usan: certificado de antigüedad, años de servicio del
  // finiquito y analytics (TIMESTAMPDIFF de MySQL tiene la misma semántica).
  function mesesAntiguedad(fechaIngreso, hasta) {
    const iso = f => f instanceof Date
      ? `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`
      : String(f || '').slice(0, 10);
    const a = new Date(iso(fechaIngreso) + 'T00:00:00'), b = new Date(iso(hasta) + 'T00:00:00');
    let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) m--;
    return Math.max(0, m);
  }

  const api = { cuotaFrancesa, provisionVacaciones, mesesAntiguedad };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AF_RRHH = api;
})(typeof self !== 'undefined' ? self : this);
