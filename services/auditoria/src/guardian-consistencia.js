'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   GUARDIÁN DE CONSISTENCIA — vigila que las cifras que muestran las distintas
   pantallas (Dashboard, Rent x Ejec, informe Rentabilidad, reportería) no
   puedan divergir. Nació el 06-08-2026, el día en que julio decía 86
   operaciones en una pantalla y 84 en la de al lado: un descuadre visible
   destruye la confianza en TODO el sistema, aunque cada pantalla sea
   "técnicamente correcta".

   Qué revisa, por mes (últimos 13 meses):
   1. Otorgados sin campo MES → esa operación se cae de toda pantalla mensual.
   2. MES distinto del mes de fecha_otorgado → informativo: es el caso 84/86;
      las pantallas del sistema agrupan por MES, pero un reporte externo por
      fecha va a descuadrar. Se listan para poder explicarlos con nombre.
   3. Otorgados AF/UAC con ingreso_neto_total NULL o 0 → la rentabilidad de
      ese mes está subestimada en todas las pantallas a la vez.
   4. Descuadre interno del campo guardado: ingreso_neto_total distinto de
      (ingresos − com dealer − com parque) por más de $10 → el recálculo no
      pasó o alguien editó una pata sin la otra.
   5. Otorgados sin financiera reconocible, sin plazo o sin ejecutivo.

   Los puntos 1, 3 y 4 son CRÍTICOS (avisan por correo). 2 y 5 van en el mismo
   correo como contexto si hay críticos; solos no despiertan a nadie.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../shared/config/database');

async function revisar() {
  const criticos = [], avisos = [];
  const desde = 13; // meses hacia atrás

  // 1. Otorgados sin MES
  const [sinMes] = await pool.query(`
    SELECT num_op FROM creditos
    WHERE UPPER(estado)='OTORGADO' AND mes IS NULL
      AND fecha_otorgado >= DATE_SUB(CURDATE(), INTERVAL ? MONTH) LIMIT 20`, [desde]);
  if (sinMes.length) criticos.push(`${sinMes.length} otorgado(s) SIN campo MES (se caen de toda pantalla mensual): ${sinMes.map(r => r.num_op).join(', ')}`);

  // 2. MES ≠ mes de fecha_otorgado (informativo)
  const [cruzados] = await pool.query(`
    SELECT num_op, DATE_FORMAT(mes,'%Y-%m') mes, DATE_FORMAT(fecha_otorgado,'%Y-%m') f
    FROM creditos
    WHERE UPPER(estado)='OTORGADO' AND mes IS NOT NULL AND fecha_otorgado IS NOT NULL
      AND DATE_FORMAT(mes,'%Y-%m') <> DATE_FORMAT(fecha_otorgado,'%Y-%m')
      AND mes >= DATE_SUB(CURDATE(), INTERVAL ? MONTH) LIMIT 20`, [desde]);
  if (cruzados.length) avisos.push(`${cruzados.length} op(s) con MES distinto del mes de otorgamiento (las pantallas usan MES; un reporte por fecha va a diferir): ${cruzados.map(r => `${r.num_op} (mes ${r.mes}, otorgada ${r.f})`).join(' · ')}`);

  /* Meses con candado: sus hallazgos NO se autocorrigen (el recálculo los salta
     a propósito) y arreglarlos es una DECISIÓN (reabrir, recalcular, cerrar).
     Van como aviso con esa instrucción, no como crítico diario (24-08-2026). */
  const [mcRows] = await pool.query('SELECT mes FROM meses_cerrados WHERE cerrado=1');
  const mesCerrado = new Set(mcRows.map(r => r.mes));

  // 3. AF/UAC otorgados sin rentabilidad guardada
  const [sinRent] = await pool.query(`
    SELECT num_op, DATE_FORMAT(COALESCE(mes,fecha_otorgado),'%Y-%m') m FROM creditos
    WHERE UPPER(estado)='OTORGADO'
      AND (UPPER(financiera) LIKE '%AUTOFIN%' OR UPPER(financiera) LIKE '%UNIDAD%')
      AND (ingreso_neto_total IS NULL OR ingreso_neto_total = 0)
      AND COALESCE(mes,fecha_otorgado) >= DATE_SUB(CURDATE(), INTERVAL ? MONTH) LIMIT 20`, [desde]);
  const rentAb = sinRent.filter(r => !mesCerrado.has(r.m)), rentCe = sinRent.filter(r => mesCerrado.has(r.m));
  if (rentAb.length) criticos.push(`${rentAb.length} otorgado(s) AF/UAC con rentabilidad guardada NULA o 0 (subestima el mes en todas las pantallas): ${rentAb.map(r => `${r.num_op} (${r.m})`).join(', ')}`);
  if (rentCe.length) avisos.push(`${rentCe.length} otorgado(s) AF/UAC sin rentabilidad en MES CERRADO — el recálculo no los toca; corregirlos requiere reabrir el mes, recalcular y volver a cerrar: ${rentCe.map(r => `${r.num_op} (${r.m})`).join(', ')}`);

  // 4. Campo guardado internamente descuadrado (> $10)
  //    Fórmula del motor (rentabilidad-core.ingresoNetoTotal): ingresos − com
  //    dealer − com parque − arriendo parque prorrateado por operación.
  const [descuadre] = await pool.query(`
    SELECT num_op, DATE_FORMAT(COALESCE(mes,fecha_otorgado),'%Y-%m') m,
           ROUND(COALESCE(ingreso_neto_total,0) -
             (COALESCE(monto_comision_fin,0) + COALESCE(com_rdh,0) + COALESCE(com_cesantia,0) + COALESCE(com_reparaciones,0)
              - COALESCE(comdea_real,0) - COALESCE(com_parque,0) - COALESCE(arriendo_parque,0))) dif
    FROM creditos
    WHERE UPPER(estado)='OTORGADO'
      AND (UPPER(financiera) LIKE '%AUTOFIN%' OR UPPER(financiera) LIKE '%UNIDAD%')
      AND COALESCE(mes,fecha_otorgado) >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
    HAVING ABS(dif) > 10 LIMIT 20`, [desde]);
  const descAb = descuadre.filter(r => !mesCerrado.has(r.m)), descCe = descuadre.filter(r => mesCerrado.has(r.m));
  if (descAb.length) criticos.push(`${descAb.length} op(s) con ingreso_neto_total que no cuadra con sus componentes (recálculo pendiente o edición a medias): ${descAb.map(r => `${r.num_op} (dif $${Number(r.dif).toLocaleString('es-CL')})`).join(', ')}`);
  if (descCe.length) avisos.push(`${descCe.length} op(s) con ingreso_neto_total descuadrado en MES CERRADO — corregirlas requiere reabrir el mes, recalcular y volver a cerrar: ${descCe.map(r => `${r.num_op} (${r.m}, dif $${Number(r.dif).toLocaleString('es-CL')})`).join(', ')}`);

  /* 6. CARTA OTORGADA con el crédito atrás — el caso 26080532 (13-08-2026): la
        carta se otorgó, el crédito quedó en 'Digitado'/PENDIENTE y la venta
        desapareció del dashboard y de las comisiones sin que nadie se enterara.
        La causa de aquella vez ya está tapada (collation binaria + comparación
        en mayúsculas), pero el síntoma se vigila igual: cualquier causa nueva
        que deje la carta y el crédito desalineados aparece acá al día siguiente. */
  const [otorgadaSinCredito] = await pool.query(`
    SELECT ca.op_carta, cr.num_op, cr.estado_credito, ca.ejecutivo
      FROM cartas_aprobacion ca JOIN creditos cr ON cr.id = ca.id_credito_creado
     WHERE ca.otorgado = 1 AND UPPER(COALESCE(cr.estado_eval,'')) <> 'OTORGADO'
       -- ANULADO se excluye: la anulación de operación es un proceso deliberado
       -- con doble firma que deja bitácora y ajusta la cartola — no es una venta
       -- perdida invisible (caso real 26080813 / carta 26649697LS-R1, 24-08-2026)
       AND UPPER(COALESCE(cr.estado_eval,'')) <> 'ANULADO'
       AND ca.fecha_otorgado >= DATE_SUB(CURDATE(), INTERVAL ? MONTH) LIMIT 20`, [desde]);
  if (otorgadaSinCredito.length) criticos.push(
    `${otorgadaSinCredito.length} carta(s) OTORGADA(S) cuyo crédito NO quedó en OTORGADO — esas ventas no aparecen en el dashboard ni en comisiones: ` +
    otorgadaSinCredito.map(r => `${r.op_carta} → op ${r.num_op} está "${r.estado_credito}" (${r.ejecutivo || 'sin ejecutivo'})`).join(' · '));

  /* 7. Etapa escrita con otra capitalización: la base es case-sensitive, así que
        'Digitado' es invisible para quien compara con 'DIGITADO'. Debería ser
        siempre 0 — la carga Trinidad normaliza en cada arranque. */
  const [mixtos] = await pool.query(`
    SELECT COUNT(*) n FROM creditos
     WHERE (estado <> UPPER(estado) OR estado_credito <> UPPER(estado_credito) OR estado_eval <> UPPER(estado_eval))`);
  if (mixtos[0] && mixtos[0].n > 0) criticos.push(
    `${mixtos[0].n} crédito(s) con la etapa escrita en minúsculas: la base distingue mayúsculas, así que quedan invisibles para los procesos que comparan en MAYÚSCULAS (fue la causa de la venta perdida el 13-08-2026).`);

  // 5. Otorgados con datos base incompletos
  const [incompletos] = await pool.query(`
    SELECT num_op,
           CONCAT_WS('/', IF(financiera IS NULL OR financiera='','sin financiera',NULL),
                          IF(plazo IS NULL OR plazo=0,'sin plazo',NULL),
                          IF(ejecutivo IS NULL OR ejecutivo='','sin ejecutivo',NULL)) falta
    FROM creditos
    WHERE UPPER(estado)='OTORGADO'
      AND COALESCE(mes,fecha_otorgado) >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
      AND (financiera IS NULL OR financiera='' OR plazo IS NULL OR plazo=0 OR ejecutivo IS NULL OR ejecutivo='')
    LIMIT 20`, [desde]);
  if (incompletos.length) avisos.push(`${incompletos.length} otorgado(s) con datos base incompletos: ${incompletos.map(r => `${r.num_op} (${r.falta})`).join(', ')}`);

  // 6. Monto financiado ≤ saldo precio → el monto del crédito quedó mal leído.
  //    El capital del pagaré (Total Pagaré AutoFin / Monto Bruto Unidad) SIEMPRE
  //    es mayor al saldo precio: suma impuestos, primas y gastos. Igualdad exacta
  //    = se guardó el saldo como monto (bug de parseUnidad corregido en v193.1;
  //    casos reales: 26634853CV, 26631052DS, 26634247LS, 26626280KT, 26627944FC).
  const [montoMalo] = await pool.query(`
    SELECT num_op, DATE_FORMAT(COALESCE(mes,fecha_otorgado),'%Y-%m') m,
           saldo_precio, monto_financiado
    FROM creditos
    WHERE UPPER(estado)='OTORGADO'
      AND (UPPER(financiera) LIKE '%AUTOFIN%' OR UPPER(financiera) LIKE '%UNIDAD%')
      AND COALESCE(monto_financiado,0) > 0 AND COALESCE(saldo_precio,0) > 0
      AND monto_financiado <= saldo_precio
      AND COALESCE(mes,fecha_otorgado) >= DATE_SUB(CURDATE(), INTERVAL ? MONTH) LIMIT 20`, [desde]);
  if (montoMalo.length) criticos.push(`${montoMalo.length} op(s) con monto financiado MENOR O IGUAL al saldo precio (el capital del pagaré siempre es mayor: trae impuestos, primas y gastos — probable lectura del saldo como monto): ${montoMalo.map(r => `${r.num_op} (${r.m}: saldo $${Number(r.saldo_precio).toLocaleString('es-CL')} vs financiado $${Number(r.monto_financiado).toLocaleString('es-CL')})`).join(' · ')}`);

  // 7. Numeración (regla 27-08-2026): la OP nueva es AAMM#### de 8 dígitos y
  //    numero_credito la ESPEJA. Un crédito nuevo con OP de 7 dígitos (serie
  //    corta muerta — cae en el rango 1M–20M de los IDs Trinidad) o con
  //    numero_credito distinto de su OP significa que algún camino de inserción
  //    quedó fuera del motor único shared/num-op.js.
  const [numMalo] = await pool.query(`
    SELECT num_op, numero_credito, DATE(created_at) f
      FROM creditos
     WHERE created_at >= '2026-08-28'
       AND ( (num_op BETWEEN 1000000 AND 19999999 AND financiera NOT IN ('AUTOFIN','UNIDAD DE CREDITO')
              AND (id_financiera IS NULL OR id_financiera = '' OR id_financiera = CAST(num_op AS CHAR)))
          OR (numero_credito IS NOT NULL AND num_op IS NOT NULL AND numero_credito <> CAST(num_op AS CHAR)) )
     LIMIT 20`);
  if (numMalo.length) criticos.push(`${numMalo.length} crédito(s) nuevos con numeración fuera del motor único (la OP es AAMM#### de 8 dígitos y numero_credito la espeja — hay un camino de inserción saltándose shared/num-op.js): ${numMalo.map(r => `OP ${r.num_op} / n°cred ${r.numero_credito} (${r.f})`).join(' · ')}`);

  return { criticos, avisos };
}

async function tick() {
  try {
    const { criticos, avisos } = await revisar();
    if (!criticos.length) {
      console.log(`[guardian-consistencia] ✓ cifras consistentes${avisos.length ? ` (${avisos.length} aviso(s) informativo(s))` : ''}`);
      return { fallo: false, avisos };
    }
    try {
      const { enviarCorreo } = require('../../../shared/mailer');
      const to = process.env.ALERTA_ERRORES_MAIL || 'patricio.escobar@autofacilchile.cl';
      const li = xs => xs.map(x => `<li>${x}</li>`).join('');
      await enviarCorreo({
        to,
        subject: '⚠ Guardián de Consistencia: hay cifras que van a descuadrar entre pantallas',
        html: `<p>La revisión diaria de consistencia de cifras (operaciones, montos y rentabilidad por mes) encontró problemas críticos:</p>
               <ul style="background:#fef2f2;padding:14px 14px 14px 30px;border-radius:8px">${li(criticos)}</ul>
               ${avisos.length ? `<p>Contexto adicional (informativo):</p><ul style="background:#fffbeb;padding:14px 14px 14px 30px;border-radius:8px">${li(avisos)}</ul>` : ''}
               <p>Mientras esto no se corrija, el Dashboard, Rent x Ejec y el informe de Rentabilidad pueden mostrar meses subestimados o poblaciones distintas.</p>`,
      });
    } catch (e) { console.error('[guardian-consistencia] no pudo avisar:', e.message); }
    console.error(`[guardian-consistencia] ✗ ${criticos.length} problema(s) crítico(s) — aviso enviado`);
    return { fallo: true, criticos, avisos };
  } catch (e) {
    console.error('[guardian-consistencia]', e.message);
    return { fallo: false, error: e.message };
  }
}

// Una vez al día; también al arrancar (igual que el guardián de permisos)
require('../../../shared/scheduler').programar('guardian-consistencia', tick, 24 * 60 * 60 * 1000);

module.exports = { tick, revisar };
