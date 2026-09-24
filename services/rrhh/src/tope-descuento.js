'use strict';
/* Topes legales de los descuentos a la remuneración (motor único — Máxima 1).
   Paramétricos en Mantenedores → Indicadores de Remuneraciones → "Topes legales de descuentos"
   (rh_config), sembrados con la norma vigente (Pato, 24-09-2026):
     rem_tope_dcto_otros_pct     15  art. 58 CT: otros pagos acordados por escrito (anticipos,
                                     préstamos, Caja, descuentos varios…): 15% de la remuneración
     rem_tope_dcto_vivienda_pct  30  art. 58 CT: vivienda, educación y ahorro (APV): 30%
     rem_tope_dcto_total_pct     45  art. 58 CT: la SUMA de todos los descuentos voluntarios: 45%
     rem_tope_pension_pct        50  Ley 14.908 art. 7: pensión de alimentos y retenciones
                                     judiciales: hasta 50% de los ingresos; NO entran en el 45%
     rem_dcto_judiciales         lista de conceptos que son judiciales (separados por coma)
     rem_dcto_vivienda           lista de conceptos que son vivienda/educación/ahorro
   Base: total haberes de la última liquidación EMITIDA; si no hay, sueldo base de la ficha.
   Sin referencia no se valida (RRHH decide). Lo usan Solicitudes (paso RRHH) y el registro
   directo en Descuentos. Los descuentos LEGALES (AFP, salud, impuesto) no pasan por aquí. */
const pool = require('../../../shared/config/database');

const DEF = { rem_tope_dcto_otros_pct: 15, rem_tope_dcto_vivienda_pct: 30, rem_tope_dcto_total_pct: 45, rem_tope_pension_pct: 50,
              rem_dcto_judiciales: 'ORDEN TRIBUNAL,PENSIÓN DE ALIMENTOS', rem_dcto_vivienda: 'APV' };
const lista = s => String(s || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);

async function topes() {
  const [rows] = await pool.query('SELECT clave, valor FROM rh_config WHERE clave IN (?)', [Object.keys(DEF)]).catch(() => [[]]);
  const c = { ...DEF }; rows.forEach(r => { if (r.valor !== null && r.valor !== '') c[r.clave] = r.valor; });
  return { otros: Number(c.rem_tope_dcto_otros_pct) || 0, vivienda: Number(c.rem_tope_dcto_vivienda_pct) || 0,
           total: Number(c.rem_tope_dcto_total_pct) || 0, pension: Number(c.rem_tope_pension_pct) || 0,
           judiciales: lista(c.rem_dcto_judiciales), viviendaLista: lista(c.rem_dcto_vivienda) };
}

// JUDICIAL (pensión / tribunal, tope propio y fuera del 45%) · VIVIENDA (30%) · OTROS (15%)
function categoriaDe(tipo, subtipo, T) {
  const s = String(subtipo || '').toUpperCase();
  if (T.judiciales.some(j => s.includes(j))) return 'JUDICIAL';
  if (T.viviendaLista.some(v => s === v || s.startsWith(v + ' '))) return 'VIVIENDA';
  return 'OTROS';
}

async function baseDe(idUsuario) {
  const [[liq]] = await pool.query(
    `SELECT total_haberes FROM rh_liquidaciones WHERE id_usuario=? AND estado='EMITIDA' ORDER BY mes DESC LIMIT 1`, [idUsuario]);
  let base = Number(liq?.total_haberes) || 0;
  if (!base) { const [[f]] = await pool.query(`SELECT sueldo_base FROM rh_fichas WHERE id_usuario=?`, [idUsuario]); base = Number(f?.sueldo_base) || 0; }
  return base;
}

const $ = v => '$' + Math.round(v).toLocaleString('es-CL');
const difMeses = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));

/* Valida la cuota de un descuento NUEVO contra los topes. Lanza Error con el mensaje para el usuario.
   { idUsuario, valorCuota, tipo, subtipo, excluirId } — excluirId: descuento que se está reemplazando. */
async function validarTope({ idUsuario, valorCuota, tipo, subtipo, excluirId }) {
  valorCuota = Number(valorCuota) || 0;
  if (!valorCuota) return;
  const base = await baseDe(idUsuario);
  if (!base) return;
  const T = await topes();
  const cat = categoriaDe(tipo, subtipo, T);
  if (cat === 'JUDICIAL') {
    if (!T.pension) return;
    const tope = Math.round(base * T.pension / 100);
    if (valorCuota > tope) throw new Error(
      `La cuota de ${$(valorCuota)} supera el tope legal del ${T.pension}% de los ingresos para pensión de alimentos / retención judicial (Ley 14.908 art. 7): máximo ${$(tope)}.`);
    return;
  }
  const pctInd = cat === 'VIVIENDA' ? T.vivienda : T.otros;
  if (pctInd) {
    const tope = Math.round(base * pctInd / 100);
    if (valorCuota > tope) throw new Error(
      `La cuota de ${$(valorCuota)} supera el tope legal del ${pctInd}% de la remuneración (art. 58 CT${cat === 'VIVIENDA' ? ', vivienda/educación/ahorro' : ''}): máximo ${$(tope)} — sube el número de cuotas o baja el monto.`);
  }
  if (!T.total) return;
  // Suma de lo que ya se descuenta este mes (voluntarios vigentes, sin los judiciales) + la cuota nueva
  const mes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
  const [vig] = await pool.query(
    `SELECT id, tipo, subtipo, valor_cuota, cuotas, mes_inicio FROM rh_descuentos WHERE id_usuario=? AND estado='VIGENTE'`, [idUsuario]);
  let suma = 0;
  for (const d of vig) {
    if (excluirId && d.id === excluirId) continue;
    if (categoriaDe(d.tipo, d.subtipo, T) === 'JUDICIAL') continue;
    const k = difMeses(String(d.mes_inicio || mes), mes);
    if (Number(d.cuotas) > 0 && k >= Number(d.cuotas)) continue;   // ya terminó
    suma += Number(d.valor_cuota) || 0;
  }
  const topeTot = Math.round(base * T.total / 100);
  if (suma + valorCuota > topeTot) throw new Error(
    `Con esta cuota el total de descuentos voluntarios del mes llega a ${$(suma + valorCuota)} (ya vigentes ${$(suma)} + nuevo ${$(valorCuota)}) y supera el tope legal del ${T.total}% de la remuneración (art. 58 CT): máximo ${$(topeTot)}.`);
}

// Compatibilidad: Solicitudes valida anticipos/préstamos (categoría OTROS).
const validarTope15 = (idUsuario, valorCuota) => validarTope({ idUsuario, valorCuota, tipo: 'ANTICIPO', subtipo: null });

module.exports = { validarTope, validarTope15, topes, categoriaDe, DEF };
