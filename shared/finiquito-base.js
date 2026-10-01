'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   BASE DE LAS INDEMNIZACIONES — art. 172 del Código del Trabajo (parte pura).

   La "última remuneración mensual" con que se pagan la indemnización por años
   de servicio y la sustitutiva del aviso previo comprende TODA cantidad que el
   trabajador esté percibiendo — incluidas las asignaciones habituales que no
   son imponibles, como colación y movilización — y EXCLUYE la asignación
   familiar, las horas extraordinarias y lo esporádico o que se paga una vez al
   año (aguinaldos). Dirección del Trabajo: dictamen 75/8 de 05-01-1999 y
   consulta "¿Cuál es la remuneración mensual que debe considerarse…?".

   Qué concepto es "esporádico" y qué no imponible es "habitual" lo decide el
   Administrador en dos listas (rh_config → finiq_base_excluye / finiq_base_no_imp,
   mantenedor Saludos y Certificados RRHH → Finiquito). Acá vive solo la regla
   para aplicarlas; quién trae los datos es services/rrhh/src/base-remuneracion.js.
   ───────────────────────────────────────────────────────────────────────────── */
const DEF_BASE = { finiq_base_excluye: 'HORAS EXTRAS,AGUINALDO,BONO NAVIDAD,BONO VACACIONES', finiq_base_no_imp: '' };

// Sin tildes ni mayúsculas: "Aguinaldo Fiestas Patrias" y "AGUINALDO" son el mismo concepto
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const lista = s => String(s || '').split(',').map(norm).filter(Boolean);
// "contiene": AGUINALDO cubre "Aguinaldo Fiestas Patrias (12/30 días)"
const coincide = (nombre, L) => { const n = norm(nombre); return !!n && (L || []).some(x => n.includes(x)); };

/* Aplica las listas a los adicionales de UN mes.
   items: [{ nombre, monto, imponible }] · P: { excluye: [...], noImp: [...] } (ya normalizadas con lista())
   → { excluidos, no_imp_lista }: lo imponible que sale de la base y lo no imponible que entra. */
function ajusteArt172(items, P) {
  let excluidos = 0, noImpLista = 0;
  for (const a of (Array.isArray(items) ? items : [])) {
    const m = Number(a && a.monto) || 0;
    if (a && a.imponible && coincide(a.nombre, P.excluye)) excluidos += m;
    else if (a && !a.imponible && coincide(a.nombre, P.noImp)) noImpLista += m;
  }
  return { excluidos: Math.round(excluidos), no_imp_lista: Math.round(noImpLista) };
}

/* Remuneración de UN mes para el art. 172: imponible − excluidos + no imponibles habituales.
   Lo excluido nunca supera el imponible (una lista mal puesta no puede dejar la base negativa). */
function base172DelMes({ imponible, excluidos, no_imponibles }) {
  const imp = Math.round(Number(imponible) || 0);
  const exc = Math.max(0, Math.min(Math.round(Number(excluidos) || 0), imp));
  return { excluidos: exc, base_172: imp - exc + Math.max(0, Math.round(Number(no_imponibles) || 0)) };
}

/* ─────────────────────────────────────────────────────────────────────────────
   RETENCIÓN POR PENSIÓN DE ALIMENTOS SOBRE LAS INDEMNIZACIONES DEL FINIQUITO
   Art. 13 de la Ley 14.908 (modificado por la Ley 21.389). Al término de la
   relación laboral el empleador debe retener, para pagarlo al alimentario:
     · de la indemnización sustitutiva del aviso previo: la suma equivalente a
       la pensión del mes siguiente al término;
     · de la indemnización por años de servicio: el porcentaje que la pensión
       representa en el ingreso mensual del trabajador.
   Ingreso mensual = la base del art. 172 SIN topar (el tope de 90 UF limita la
   indemnización, no lo que el trabajador gana). Nunca se retiene más que la
   indemnización misma; topeAviso/topeAnos son lo que queda disponible cuando
   hay más de una causa.
   ───────────────────────────────────────────────────────────────────────────── */
function retencionAlimentos({ pension, base, mesAviso, indemAnos, topeAviso, topeAnos } = {}) {
  const R = v => Math.max(0, Math.round(Number(v) || 0));
  const p = R(pension), b = Number(base) || 0, ma = R(mesAviso), ia = R(indemAnos);
  const pct = b > 0 && p > 0 ? Math.min(1, p / b) : 0;
  const ret_aviso = Math.min(topeAviso == null ? ma : Math.min(ma, R(topeAviso)), p);
  const ret_anos = Math.min(topeAnos == null ? ia : Math.min(ia, R(topeAnos)), Math.round(ia * pct));
  return { pct: Math.round(pct * 10000) / 100, ret_aviso, ret_anos, total: ret_aviso + ret_anos };
}

module.exports = { DEF_BASE, norm, lista, coincide, ajusteArt172, base172DelMes, retencionAlimentos };
