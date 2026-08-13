/* REGULARIZACIÓN DE MIGRACIÓN — comisiones de parque ya pagadas fuera del sistema.
   Decisión de Pato (13-08-2026), con la planilla "a pagar.xlsx" sobre la mesa:

   Las comisiones de parque de enero a julio 2026 ya se pagaron por planilla, antes
   de que existiera el módulo. No hay cartola que emitir ni ODP que correlacionar —
   son migración. Lo que falta es que el sistema lo REFLEJE, para que el circuito
   nuevo (v207.61) no las vuelva a cobrar en la cartola de agosto.

   Qué hace:
   1. Marca las 8 etapas del track PARQUE (hasta COMISION PAGADA) en cada operación
      del universo. Idempotente: uk_etapa (id_seguimiento, track, etapa) + INSERT IGNORE.
   2. Registra cada parque-mes en parques_pagos_mes como PAGO_REALIZADO, con su
      arriendo y la suma de comisiones, y deja la FOTO en parques_pagos_ops (así el
      motor sabe qué cartola cobró qué operación y no la arrastra de nuevo).

   UNIVERSO (op por op, criterio elegido por Pato):
   - Créditos OTORGADOS con mes contable 2026-01 .. 2026-07 (agosto queda FUERA).
   - Atribuidos a un parque del mantenedor (parque de la operación; si no, ficha del dealer).
   - EXCLUIDAS las 50 operaciones de "a pagar.xlsx": su SALDO PRECIO sigue pendiente,
     así que su comisión NO se paga y queda para arrastrar a la cartola que corresponda.

   NO genera asientos contables: el pago ocurrió fuera del sistema y su contabilidad
   ya está hecha. Contabilizarlo acá lo duplicaría (Máxima 4 aplica al dinero que
   mueve ESTE sistema, no a lo que se migra).
   NO emite correlativos ODP: no hubo orden de pago del sistema; inventar un número
   ensuciaría el ledger de Órdenes de Pago.

   Uso:  node scripts/regularizar-comisiones-parque-migracion.js            → simula
         node scripts/regularizar-comisiones-parque-migracion.js --aplicar  → escribe

   Opciones (por defecto el tramo 2026-01..2026-07 de la corrida original):
     --desde=YYYY-MM  --hasta=YYYY-MM     tramo de meses contables a regularizar
     --solo-liberadas=YYYY-MM-DD          solo las operaciones cuyo saldo precio
                                          quedó LIBERADO A PAGO (o posterior) antes
                                          de esa fecha. Se usó para 2025: se
                                          regularizó lo que estaba liberado al
                                          31-07-2026 y nada más, para no tapar
                                          comisiones que todavía no corresponde pagar.
*/
const pool = require('../shared/config/database');

const arg = (n, def) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : def; };
const APLICAR = process.argv.includes('--aplicar');
const DESDE = arg('desde', '2026-01') + '-01';
const HASTA = arg('hasta', '2026-07') + '-31';   // agosto 2026 queda fuera
const SOLO_LIBERADAS = arg('solo-liberadas', null);
const USUARIO = 'Migración';

/* Las 50 operaciones con SALDO PRECIO pendiente (planilla "a pagar.xlsx", 13-08-2026).
   Su comisión de parque NO se paga: se arrastra hasta que el saldo precio se libere. */
const EXCLUIDAS = new Set(['85865','86322','87194','88286','88563','88662','88786','88799','88833','88831',
  '88860','88873','88885','88916','88922','88926','88967','88973','88882','88942','88975','88976','88978',
  '88982','88981','88986','89037','89044','89045','89071','89082','89137','89141','89150','89158','89191',
  '89211','89213','89212','89237','89252','89253','89284','89286','89285','89321','89324','89347','89356','89365']);

// Orden oficial del track PARQUE (postventa_config → etapas_parque)
const ETAPAS = ['COMISION A PAGAR','CARTOLA EMITIDA','CARTOLA APROBADA','CARTOLA ENVIADA',
  'FACTURA RECIBIDA','ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','COMISION PAGADA'];

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

(async () => {
  const [parques] = await pool.query('SELECT nombre, arriendo FROM parques_comisiones WHERE activo=1');
  const canon = new Map(parques.map(p => [norm(p.nombre), p.nombre]));
  const arriendoDe = new Map(parques.map(p => [p.nombre, Math.round(Number(p.arriendo) || 0)]));

  const [dealers] = await pool.query('SELECT rut, ccs_parque, nombre_razon FROM dealers');
  const rutN = r => String(r || '').replace(/[^0-9kK]/g, '').toUpperCase();
  const dby = new Map(dealers.map(d => [rutN(d.rut), d]));

  const [rows] = await pool.query(`
    SELECT c.num_op, c.id, DATE_FORMAT(c.mes,'%Y-%m') mes, c.rut_dealer, c.parque, c.com_parque,
           c.saldo_precio, c.ejecutivo, c.automotora, s.id AS id_seg,
           DATE_FORMAT(c.fecha_otorgado,'%Y-%m-%d') fecha_otorgado
      FROM creditos c
      LEFT JOIN postventa_seguimiento s ON s.id_credito = c.id
     WHERE c.estado='OTORGADO' AND c.mes BETWEEN ? AND ?` +
    (SOLO_LIBERADAS ? `
       AND EXISTS (SELECT 1 FROM postventa_etapas le WHERE le.id_seguimiento=s.id AND le.track='SALDO'
             AND le.etapa IN ('LIBERADO A PAGO','ORDEN DE PAGO EMITIDA','ENVIADO A PAGO','SALDO PRECIO PAGADO')
             AND le.fecha < ?)` : ''),
    SOLO_LIBERADAS ? [DESDE, HASTA, SOLO_LIBERADAS] : [DESDE, HASTA]);

  const porMesParque = new Map();   // 'YYYY-MM|PARQUE' -> ops[]
  let excluidas = 0, sinParque = 0, sinSeg = 0;
  for (const r of rows) {
    const d = dby.get(rutN(r.rut_dealer));
    const parque = canon.get(norm(r.parque)) || canon.get(norm(d?.ccs_parque));
    if (!parque) { sinParque++; continue; }
    if (EXCLUIDAS.has(String(r.num_op))) { excluidas++; continue; }
    if (!r.id_seg) { sinSeg++; continue; }   // sin ficha de seguimiento no hay dónde marcar
    const k = r.mes + '|' + parque;
    if (!porMesParque.has(k)) porMesParque.set(k, []);
    porMesParque.get(k).push({
      num_op: r.num_op, id_seg: r.id_seg,
      dealer: d?.nombre_razon || r.automotora || '—', ejecutivo: r.ejecutivo || '—',
      fecha_otorgado: r.fecha_otorgado || null,
      saldo_precio: Math.round(Number(r.saldo_precio) || 0),
      com_parque: Math.round(Number(r.com_parque) || 0),
    });
  }

  console.log(APLICAR ? '=== APLICANDO ===' : '=== SIMULACIÓN (usa --aplicar para escribir) ===');
  console.log(`Universo ${DESDE.slice(0,7)} a ${HASTA.slice(0,7)} · excluidas por saldo precio pendiente: ${excluidas}` +
              ` · fuera de parque: ${sinParque}` + (sinSeg ? ` · sin ficha de seguimiento: ${sinSeg}` : ''));
  console.log('');

  let totOps = 0, totCom = 0, totArr = 0, etapasNuevas = 0;
  for (const k of [...porMesParque.keys()].sort()) {
    const [mes, parque] = k.split('|');
    const ops = porMesParque.get(k);
    const com = ops.reduce((a, o) => a + o.com_parque, 0);
    const arr = arriendoDe.get(parque) || 0;
    totOps += ops.length; totCom += com; totArr += arr;
    console.log(`${mes} ${parque.padEnd(28)} ${String(ops.length).padStart(3)} ops · comisión $${com.toLocaleString('es-CL').padStart(11)}` +
                ` · arriendo $${arr.toLocaleString('es-CL').padStart(9)} · total $${(com + arr).toLocaleString('es-CL')}`);

    if (!APLICAR) continue;

    // 1) Etapas del track PARQUE en cada operación (idempotente por uk_etapa)
    for (const etapa of ETAPAS) {
      const vals = ops.map(o => [o.id_seg, 'PARQUE', etapa, USUARIO]);
      const [r] = await pool.query(
        'INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario, fecha) VALUES ' +
        vals.map(() => '(?,?,?,?,NOW())').join(','), vals.flat());
      etapasNuevas += r.affectedRows;
    }

    // 2) FOTO de la cartola (qué operaciones cubrió este parque-mes)
    await pool.query("DELETE FROM parques_pagos_ops WHERE parque=? AND DATE_FORMAT(mes,'%Y-%m')=?", [parque, mes]);
    await pool.query(
      'INSERT INTO parques_pagos_ops (parque, mes, num_op, dealer, ejecutivo, fecha_otorgado, saldo_precio, com_parque) VALUES ?',
      [ops.map(o => [parque, mes + '-01', o.num_op, o.dealer, o.ejecutivo, o.fecha_otorgado, o.saldo_precio, o.com_parque])]);

    // 3) El parque-mes queda PAGADO. Sin odp_numero: no hubo ODP del sistema.
    await pool.query(`
      INSERT INTO parques_pagos_mes (parque, mes, arriendo, comision_creditos, ops, etapa,
                                     aprobada_por, fecha_aprobada, emitida_por, fecha_emitida, pagada_por, fecha_pagada)
      VALUES (?,?,?,?,?,'PAGO_REALIZADO',?,NOW(),?,NOW(),?,NOW())
      ON DUPLICATE KEY UPDATE arriendo=VALUES(arriendo), comision_creditos=VALUES(comision_creditos),
        ops=VALUES(ops), etapa='PAGO_REALIZADO',
        pagada_por=COALESCE(pagada_por, VALUES(pagada_por)), fecha_pagada=COALESCE(fecha_pagada, NOW())`,
      [parque, mes + '-01', arr, com, ops.length, USUARIO, USUARIO, USUARIO]);
  }

  console.log('');
  console.log(`TOTAL: ${totOps} operaciones · comisión $${totCom.toLocaleString('es-CL')}` +
              ` + arriendos $${totArr.toLocaleString('es-CL')} = $${(totCom + totArr).toLocaleString('es-CL')}`);
  if (APLICAR) {
    console.log(`Etapas nuevas marcadas: ${etapasNuevas} (${porMesParque.size} cartolas parque-mes en PAGO_REALIZADO)`);
    try {
      await require('../shared/audit').auditar({
        usuario: USUARIO, accion: 'EDITAR', modulo: 'postventa', entidad: 'parque_pago',
        detalle: `Regularización de migración: ${totOps} comisiones de parque (2026-01 a 2026-07) marcadas COMISION PAGADA — ` +
                 `$${totCom.toLocaleString('es-CL')} + arriendos $${totArr.toLocaleString('es-CL')}. ` +
                 `Excluidas ${excluidas} operaciones con saldo precio pendiente (planilla "a pagar" 13-08-2026). Sin ODP ni asiento: pago hecho fuera del sistema.`,
      });
    } catch (e) { console.error('[auditoría]', e.message); }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
