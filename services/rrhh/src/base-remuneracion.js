'use strict';
// Remuneración base para indemnizaciones y provisiones (Máxima 1 — motor único).
// DOCTRINA DT verificada el 15-09-2026 (caso F. Contreras vs planilla de Constanza):
//   · Art. 71 CT: renta mixta = sueldo + "promedio de lo ganado en los últimos tres
//     meses trabajados". La DT lo aplica sobre lo PERCIBIDO en esos meses; las
//     comisiones pagadas desfasadas que no entraron al promedio se pagan aparte
//     (ORD. 5424/250 de 1995, ORD. N°495 de 2016, ORD. N°77 de 2025). NO es devengo.
//   · Meses TRABAJADOS completos: no cuentan los meses con licencia (ORD. 2994/171),
//     el mes de ingreso si no empezó el día 1, ni el mes del término.
//   · FERIADO proporcional (art. 73): la gratificación legal pagada mensualmente NO
//     integra la base (dictamen 836/046 de 2004, ORD. 5457/316) → `base_feriado`.
//     Colación y movilización tampoco (no son remuneración).
//   · INDEMNIZACIONES (art. 172): "última remuneración mensual" = toda cantidad que el
//     trabajador esté percibiendo, con la gratificación mensual garantizada incluida → `base`.
//     Desde el 01-10-2026 (verificado en la DT, consulta "¿Cuál es la remuneración mensual
//     que debe considerarse…?" y dictamen 75/8 de 1999):
//       + ENTRAN las asignaciones habituales NO imponibles: colación y movilización
//         (y las que el Administrador liste en `finiq_base_no_imp`);
//       − NO ENTRAN las horas extraordinarias ni lo esporádico o anual (aguinaldos):
//         los conceptos imponibles listados en `finiq_base_excluye`. La asignación
//         familiar tampoco (el sistema no la paga).
//     Antes la base era el promedio del imponible a secas: le faltaba la movilización
//     y arrastraba el aguinaldo de Fiestas Patrias a cualquier finiquito que promediara septiembre.
// Cascada de fuente: liquidaciones EMITIDAS del motor → Libro de Remuneraciones de
// AVSOFT (ctb_remun_aux, por RUT) → sueldo base × 1,25 (estimada).
// La usan: finiquito (indemnizaciones y feriado proporcional), la provisión de
// indemnización por años de servicio (Contabilidad › Provisiones) y la cartola de
// Vacaciones / analytics (provisión).
// NOTA: el tope 15% del art. 58 CT usa OTRA base a propósito (remuneración TOTAL
// de la última liquidación) — es otra magnitud, no se fusiona.
const pool = require('../../../shared/config/database');

const mesActual = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 7);
const mesSig = ym => { let [y, m] = String(ym).split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}`; };
const N = v => Number(v) || 0;
const prom = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;

/* Listas paramétricas de la base del art. 172 (Mantenedores → Saludos y Certificados RRHH → Finiquito).
   La regla para aplicarlas es pura y vive en shared/finiquito-base.js (la anclan las pruebas). */
const { DEF_BASE, lista, ajusteArt172, base172DelMes } = require('../../../shared/finiquito-base');
async function paramsBase() {
  const [rows] = await pool.query('SELECT clave, valor FROM rh_config WHERE clave IN (?)', [Object.keys(DEF_BASE)]).catch(() => [[]]);
  const c = { ...DEF_BASE }; rows.forEach(r => { if (r.valor != null) c[r.clave] = r.valor; });   // lista vacía a propósito = nada
  return { excluye: lista(c.finiq_base_excluye), noImp: lista(c.finiq_base_no_imp) };
}

/* { base, base_feriado, base_imponible, fuente: 'MOTOR'|'AVSOFT'|'ESTIMADA', meses: [...], detalle: [...] }
   base            → art. 172 (indemnizaciones): imponible − excluidos + no imponibles habituales
   base_feriado    → art. 73 (feriado): imponible − gratificación mensual
   base_imponible  → promedio del imponible a secas (referencia: era la base hasta el 01-10-2026)
   hastaMes (YYYY-MM, exclusivo): el mes del término no es completo. */
async function remuneracionBaseDetalle(idUsuario, hastaMes) {
  const hasta = /^\d{4}-\d{2}$/.test(hastaMes || '') ? hastaMes : mesActual();
  const [[u]] = await pool.query(
    `SELECT rut, DATE_FORMAT(fecha_ingreso,'%Y-%m') mes_ing, DAY(fecha_ingreso) dia_ing FROM usuarios WHERE id_usuario=?`, [idUsuario]);
  // Primer mes COMPLETO: el de ingreso solo si entró el día 1
  const desde = u && u.mes_ing ? (Number(u.dia_ing) === 1 ? u.mes_ing : mesSig(u.mes_ing)) : '0000-00';
  const P = await paramsBase();
  const armar = (fuente, detalle, extra) => ({
    base: prom(detalle.map(x => x.base_172)), base_feriado: prom(detalle.map(x => x.imponible - x.gratificacion)),
    base_imponible: prom(detalle.map(x => x.imponible)), fuente, meses: detalle.map(x => x.mes), detalle, ...(extra || {}) });

  // 1) Liquidaciones EMITIDAS por el motor (detalle JSON con la apertura)
  const [liqs] = await pool.query(
    `SELECT mes, total_imponible, detalle FROM rh_liquidaciones WHERE id_usuario=? AND estado='EMITIDA' AND mes < ? AND mes >= ? ORDER BY mes DESC LIMIT 3`,
    [idUsuario, hasta, desde]);
  if (liqs.length) {
    const det = l => { try { return typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) { return {}; } };
    const detalle = liqs.map(l => {
      const d = det(l), imponible = N(l.total_imponible);
      const aj = ajusteArt172(d.adicionales, P);   // el snapshot guarda cada adicional con su nombre y su monto BRUTO
      const no_imponibles = N(d.colacion) + N(d.movilizacion) + aj.no_imp_lista;
      const { excluidos, base_172 } = base172DelMes({ imponible, excluidos: aj.excluidos, no_imponibles });
      // semana_corrida viaja en el snapshot desde el 01-10-2026 como parte informativa de las comisiones: se muestra aparte
      return { mes: l.mes, imponible, sueldo: N(d.sueldo_base), comisiones: N(d.comisiones) - N(d.semana_corrida),
        semana_corrida: N(d.semana_corrida), gratificacion: N(d.gratificacion), otros: N(d.otros_imponibles) + N(d.bono_jefe), con_apertura: true,   // bono_jefe: haber propio desde el 28-09-2026, va en "otros (bonos)"
        excluidos, no_imponibles, base_172 };
    });
    return armar('MOTOR', detalle);
  }

  const [[f]] = await pool.query(`SELECT sueldo_base, colacion, movilizacion FROM rh_fichas WHERE id_usuario=?`, [idUsuario]);
  const sb = N(f?.sueldo_base), fichaNoImp = N(f?.colacion) + N(f?.movilizacion);

  // 2) Libro de Remuneraciones de AVSOFT (por RUT)
  const rut = String(u?.rut || '').replace(/\./g, '').toUpperCase();
  if (rut) {
    const [aux] = await pool.query(
      // total_ganado = imponible REAL; la columna imponible del LIBREMUN viene topada (87,8 UF) — el tope lo aplica el finiquito
      `SELECT mes, COALESCE(NULLIF(total_ganado,0), imponible) imponible, haberes, dias, sueldo_base, comisiones, semana_corrida, gratificacion, otros_imponibles
         FROM ctb_remun_aux WHERE UPPER(REPLACE(rut,'.',''))=? AND mes < ? AND mes >= ? AND imponible > 0 ORDER BY mes DESC LIMIT 3`, [rut, hasta, desde]);
    if (aux.length) {
      /* El libro de AVSOFT no separa las horas extras ni los aguinaldos (van en "otros imponibles") ni dice qué parte
         de los no imponibles es colación y movilización. Se cruzan con lo que SÍ sabe la Suite:
         · excluidos = los Adicionales de ese mes que estén en la lista, con tope en el "otros imponibles" del libro
           (un aguinaldo registrado en líquido queda apenas por debajo de su bruto: la base no baja de más);
         · no imponibles = colación + movilización de la ficha en 30avos, con tope en los no imponibles del libro. */
      const [ads] = await pool.query(
        `SELECT mes, causal, causal_texto, monto, imponible, permanente, permanente_fin FROM rh_adicionales WHERE id_usuario=? AND (mes IN (?) OR permanente=1)`,
        [idUsuario, aux.map(l => l.mes)]).catch(() => [[]]);
      const detalle = aux.map(l => {
        const imponible = N(l.imponible), otros = N(l.otros_imponibles);
        const delMes = ads.filter(a => a.mes === l.mes || (Number(a.permanente) && a.mes < l.mes && (!a.permanente_fin || a.permanente_fin > l.mes)))
          .map(a => ({ nombre: a.causal === 'OTRO' && a.causal_texto ? a.causal_texto : a.causal, monto: a.monto, imponible: !!Number(a.imponible) }));
        const aj = ajusteArt172(delMes, P);
        const excl0 = Math.min(aj.excluidos, otros > 0 ? otros : imponible);
        const noImpLibro = Math.max(0, N(l.haberes) - imponible);
        const dias = Math.max(0, Math.min(30, N(l.dias) || 30));
        const pedido = Math.round(fichaNoImp * dias / 30) + aj.no_imp_lista;
        const no_imponibles = N(l.haberes) > 0 ? Math.min(pedido, noImpLibro) : pedido;
        const { excluidos, base_172 } = base172DelMes({ imponible, excluidos: excl0, no_imponibles });
        return { mes: l.mes, imponible, sueldo: N(l.sueldo_base), comisiones: N(l.comisiones),
          semana_corrida: N(l.semana_corrida), gratificacion: N(l.gratificacion), otros,
          // apertura (solo si el auxiliar la trae: importaciones desde v241.1)
          con_apertura: N(l.comisiones) + N(l.gratificacion) + N(l.semana_corrida) > 0,
          excluidos, no_imponibles, base_172 };
      });
      return armar('AVSOFT', detalle);
    }
  }
  return { base: Math.round(sb * 1.25) + fichaNoImp, base_feriado: sb, base_imponible: Math.round(sb * 1.25), fuente: 'ESTIMADA', meses: [], detalle: [],
    sueldo_base: sb, no_imponibles: fichaNoImp };
}

async function remuneracionBase(idUsuario, hastaMes) {
  return (await remuneracionBaseDetalle(idUsuario, hastaMes)).base;
}

// Versión batch para pantallas de equipo (una sola pasada a BD) — misma cascada.
// Provisión de vacaciones: base sin gratificación (es lo que paga el feriado).
async function remuneracionBaseMapa() {
  const hasta = mesActual();
  const [fichas] = await pool.query(`SELECT f.id_usuario, f.sueldo_base, UPPER(REPLACE(u.rut,'.','')) rut FROM rh_fichas f JOIN usuarios u ON u.id_usuario=f.id_usuario`);
  const sb = {}, rutDe = {}; fichas.forEach(f => { sb[f.id_usuario] = Number(f.sueldo_base) || 0; rutDe[f.id_usuario] = f.rut || ''; });
  const [liqs] = await pool.query(
    `SELECT id_usuario, total_imponible, detalle FROM rh_liquidaciones WHERE estado='EMITIDA' AND mes < ? ORDER BY mes DESC`, [hasta]);
  const det = l => { try { return typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) { return {}; } };
  const acc = {};
  for (const l of liqs) { (acc[l.id_usuario] = acc[l.id_usuario] || []); if (acc[l.id_usuario].length < 3) acc[l.id_usuario].push(N(l.total_imponible) - N(det(l).gratificacion)); }
  const [aux] = await pool.query(
    `SELECT UPPER(REPLACE(rut,'.','')) rut, COALESCE(NULLIF(total_ganado,0), imponible) imponible, gratificacion FROM ctb_remun_aux WHERE mes < ? AND imponible > 0 ORDER BY mes DESC`, [hasta]);
  const accAux = {};
  for (const l of aux) { (accAux[l.rut] = accAux[l.rut] || []); if (accAux[l.rut].length < 3) accAux[l.rut].push(N(l.imponible) - N(l.gratificacion)); }
  return idU => {
    const a = acc[idU];
    if (a?.length) return prom(a);
    const b = accAux[rutDe[idU]];
    if (b?.length) return prom(b);
    return sb[idU] || 0;
  };
}

module.exports = { remuneracionBase, remuneracionBaseDetalle, remuneracionBaseMapa };
