/* ════════════════════════════════════════════════════════════════════════
 * MORA-CORE — MOTOR ÚNICO de "días de mora / cuotas vencidas / estado de
 * cartera" (máxima #1: una magnitud = un motor).
 *
 * Isomorfo: module.exports en Node + window.AF_MORA en el navegador.
 *
 * Reglas de negocio (únicas, aquí):
 *  · El calendario CONGELADO (cuotas_credito) manda; la cuota francesa
 *    sintética (venc N = 1ª cuota + N−1 meses) es solo fallback.
 *  · Cuota pagada = pago registrado en la app ∪ estado PAGADA del calendario.
 *  · Días de mora = hoy − vencimiento de la cuota IMPAGA más antigua.
 *  · Estado: VIGENTE (< umbral mora) / MORA / VENCIDO (≥ umbral vencido);
 *    todas pagadas → PREPAGADO (antes del plazo) o TERMINADO.
 *  · Umbrales por defecto: mora desde 1 día, vencido desde 91 (tabla
 *    cartera_parametros los sobreescribe).
 *
 * GEMELO SQL: los caminos masivos (listado de créditos y MORA_SQL de
 * cobranza) implementan ESTA MISMA regla en SQL por rendimiento. Si cambias
 * algo aquí, cámbialo también en:
 *   · services/cobranza/src/controllers/cobranza.controller.js (MORA_SQL)
 *   · services/creditos/src/controllers/creditos.controller.js (SELECT_GESTION)
 * ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const DIA = 86400000;
  const UMBRALES_DEFAULT = { mora: 1, vencido: 91 };

  // Fecha (Date | 'YYYY-MM-DD' | ISO) → ms UTC a medianoche. null si inválida.
  function ymdUTC(v) {
    if (v == null) return null;
    if (v instanceof Date) return Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
    const s = String(v).slice(0, 10).split('-');
    if (s.length < 3 || !+s[0]) return null;
    return Date.UTC(+s[0], (+s[1]) - 1, +s[2]);
  }
  function addMonthsUTC(baseMs, n) {
    const d = new Date(baseMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate());
  }

  /* Calendario del crédito. `calendario` = filas reales de cuotas_credito
     [{numero_cuota, fecha_vencimiento, valor_cuota, estado_cuota, fecha_pago}];
     si viene vacío se sintetiza el francés con fecha_primera_cuota/plazo/cuota.
     Devuelve [{n, venc(ms), fecha('YYYY-MM-DD'), monto, pagadaCal, fpagoCal}]. */
  function buildSchedule({ plazo, fecha_primera_cuota, cuota, calendario } = {}) {
    if (Array.isArray(calendario) && calendario.length) {
      return calendario.map(q => {
        const venc = ymdUTC(q.fecha_vencimiento);
        return {
          n: parseInt(q.numero_cuota, 10),
          venc,
          fecha: venc != null ? new Date(venc).toISOString().slice(0, 10) : null,
          monto: Math.round(parseFloat(q.valor_cuota) || 0),
          pagadaCal: String(q.estado_cuota || '').toUpperCase() === 'PAGADA',
          fpagoCal: q.fecha_pago ? String(q.fecha_pago).slice(0, 10) : null,
        };
      }).sort((a, b) => a.n - b.n);
    }
    const n = parseInt(plazo, 10) || 0;
    const f0 = ymdUTC(fecha_primera_cuota);
    if (!n || f0 == null) return [];
    const monto = Math.round(parseFloat(cuota) || 0);
    return Array.from({ length: n }, (_, i) => {
      const venc = addMonthsUTC(f0, i);
      return { n: i + 1, venc, fecha: new Date(venc).toISOString().slice(0, 10), monto, pagadaCal: false, fpagoCal: null };
    });
  }

  // Días de atraso → estado (la ÚNICA definición de los umbrales).
  function clasificarPorDias(dias, umbrales) {
    const um = umbrales || UMBRALES_DEFAULT;
    if (dias >= (um.vencido ?? 91)) return 'VENCIDO';
    if (dias >= (um.mora ?? 1)) return 'MORA';
    return 'VIGENTE';
  }

  /* Estado de mora completo de un crédito.
     pagadas: Set/array de números de cuota pagados EN LA APP (pagos_credito);
     el PAGADA del calendario congelado ya viene en el schedule (pagadaCal).
     hoy: Date | 'YYYY-MM-DD' (default: hoy).
     → { estado, dias, cuotas_mora, monto_mora, oldest_n, oldest_venc, pagadas_count, schedule } */
  function estadoMora({ schedule, plazo, fecha_primera_cuota, cuota, calendario, pagadas, hoy, umbrales } = {}) {
    const sch = schedule || buildSchedule({ plazo, fecha_primera_cuota, cuota, calendario });
    if (!sch.length) return null;
    const paidSet = pagadas instanceof Set ? pagadas : new Set((pagadas || []).map(x => parseInt(x, 10)));
    const hoyMs = ymdUTC(hoy) ?? ymdUTC(new Date());
    const esPagada = q => q.pagadaCal || paidSet.has(q.n);

    const impagas = sch.filter(q => !esPagada(q));
    const pagadasCount = sch.length - impagas.length;
    if (!impagas.length) {
      const lastDue = sch[sch.length - 1].venc;
      return { estado: hoyMs < lastDue ? 'PREPAGADO' : 'TERMINADO', dias: 0, cuotas_mora: 0, monto_mora: 0,
               oldest_n: null, oldest_venc: null, pagadas_count: pagadasCount, schedule: sch };
    }
    const vencidas = impagas.filter(q => q.venc != null && q.venc <= hoyMs);
    if (!vencidas.length) {
      return { estado: 'VIGENTE', dias: 0, cuotas_mora: 0, monto_mora: 0,
               oldest_n: impagas[0].n, oldest_venc: impagas[0].fecha, pagadas_count: pagadasCount, schedule: sch };
    }
    const oldest = vencidas[0];
    const dias = Math.max(0, Math.floor((hoyMs - oldest.venc) / DIA));
    return {
      estado: clasificarPorDias(dias, umbrales),
      dias,
      cuotas_mora: vencidas.length,
      monto_mora: vencidas.reduce((s, q) => s + (q.monto || 0), 0),
      oldest_n: oldest.n, oldest_venc: oldest.fecha,
      pagadas_count: pagadasCount, schedule: sch,
    };
  }

  const api = { buildSchedule, estadoMora, clasificarPorDias, UMBRALES_DEFAULT, _ymdUTC: ymdUTC, _addMonthsUTC: addMonthsUTC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AF_MORA = api;
})();
