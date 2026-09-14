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

  // Semana ISO-8601 como clave 'YYYY-Sxx' — para deduplicar avisos semanales
  // (certificados AFP, cargos sin descripción, onboarding vencido, compliance, encuestas).
  function semanaISO(d) {
    const t = new Date(d); t.setHours(0, 0, 0, 0);
    t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
    const w1 = new Date(t.getFullYear(), 0, 4);
    return t.getFullYear() + '-S' + String(1 + Math.round(((t - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7)).padStart(2, '0');
  }

  // Monto en palabras (es-CL) para documentos legales: convenios de descuento,
  // aumento de renta y finiquito ("$1.234.567 (un millón doscientos ... pesos)").
  function numeroALetras(n) {
    n = Math.round(Number(n) || 0);
    if (!isFinite(n) || n < 0) return '';
    const U = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte'];
    const D = ['', '', 'veinti', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
    const C = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
    const tres = x => {
      if (x === 0) return ''; if (x === 100) return 'cien';
      let s = C[Math.floor(x / 100)]; const r = x % 100;
      if (r === 0) return s;
      if (s) s += ' ';
      if (r <= 20) return s + U[r];
      const d = Math.floor(r / 10), u = r % 10;
      if (d === 2) return s + 'veinti' + (u === 1 ? 'ún' : U[u]);
      return s + D[d] + (u ? ' y ' + (u === 1 ? 'un' : U[u]) : '');
    };
    if (n === 0) return 'cero';
    const mm = Math.floor(n / 1000000), mil = Math.floor(n % 1000000 / 1000), un = n % 1000;
    let out = '';
    if (mm) out += (mm === 1 ? 'un millón' : tres(mm) + ' millones');
    if (mil) out += (out ? ' ' : '') + (mil === 1 ? 'mil' : tres(mil) + ' mil');
    if (un) out += (out ? ' ' : '') + tres(un);
    return out;
  }

  const api = { cuotaFrancesa, provisionVacaciones, mesesAntiguedad, semanaISO, numeroALetras };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AF_RRHH = api;
})(typeof self !== 'undefined' ? self : this);
