'use strict';
/* ════════════════════════════════════════════════════════════════════════════
   REVISOR AUTOMÁTICO DE CARTAS UNIDAD — Business Suite aprueba solo.

   Cuando el ejecutivo digita una carta UNIDAD y sube sus documentos, este motor
   revisa que lo digitado calce con lo que dicen la Carta Compromiso y la
   Cotización de Unidad (el `extracted` que el servidor parsea al subirlas), que
   la tasa cursada no rebaje más del máximo permitido sobre la pizarra, que la
   comisión dealer calce con el motor único, y que toda excepción venga
   respaldada por un código del sistema cuyo snapshot cumpla la escalera de
   estrellas (75%/50%/25% con 1⭐/2⭐/3⭐).

   - TODO cuadra → la carta queda APROBADA por "Business Suite (automática)" y
     se genera un CHECKLIST firmado (FES + QR verificable, timbre APROBACIÓN
     AUTOMÁTICA) que se sube junto a los documentos de la carta.
   - ALGO no cuadra o el motor está APAGADO → la carta queda PENDIENTE como
     siempre y la revisa el Analista de Crédito; el detalle de lo que no calzó
     queda en `revision_auto` para que lo vea con todo a la vista.

   Paramétrico (parametros_credito, mantenedor Excepciones Comerciales):
     rev_unidad_activo      1/0 — interruptor del motor (0 = todo al analista)
     rev_unidad_tolerancia  $ de tolerancia al comparar montos documento vs sistema
   ════════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../shared/config/database');
const AVISOS = require('../../../shared/avisos');
const almacen = require('../../../shared/almacen-docs');
const { registrarVerificable } = require('../../../shared/verificacion');
const { comisionDealer } = require('../../../api-gateway/public/js/comision-dealer');

require('../../../shared/migrate').enFila('revisor-unidad', async () => {
  try {
    try { await pool.query('ALTER TABLE cartas_aprobacion ADD COLUMN revision_auto JSON NULL'); }
    catch (e) { if (e.errno !== 1060) throw e; }
    /* BITÁCORA INMUTABLE del Revisor: una fila por cada revisión completa
       (aprobada o derivada), con el checklist íntegro — revision_auto de la
       carta se sobreescribe en cada pasada; esta tabla NUNCA se edita. */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS revisor_bitacora (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        id_carta        INT NOT NULL,
        op_carta        VARCHAR(30) NULL,
        id_financiera   VARCHAR(30) NULL,
        cliente         VARCHAR(200) NULL,
        rut_cliente     VARCHAR(20) NULL,
        ejecutivo       VARCHAR(200) NULL,
        creado_por      VARCHAR(200) NULL,
        resultado       VARCHAR(12) NOT NULL,          /* APROBADA | DERIVADA */
        motivo          VARCHAR(400) NULL,
        checks          JSON NULL,
        codigo_excepcion VARCHAR(20) NULL,
        checklist_codigo VARCHAR(40) NULL,             /* documentos_verificables.codigo */
        checklist_doc_id INT NULL,                     /* cartas_documentos.id del checklist */
        created_at      DATETIME DEFAULT NOW(),
        INDEX idx_carta (id_carta), INDEX idx_res (resultado), INDEX idx_fecha (created_at)
      )`);
    for (const [clave, valor, descripcion] of [
      ['rev_unidad_activo', 0, 'Revisor Automático de cartas UNIDAD: 1 = Business Suite revisa y aprueba solo las que cuadran; 0 = todas al Analista de Crédito'],
      ['rev_autofin_activo', 0, 'Revisor Automático de cartas AUTOFIN: 1 = Business Suite revisa y aprueba solo (exige pantallazo con la solicitud en Revisión Firma o Cursado); 0 = todas al Analista'],
      ['rev_unidad_tolerancia', 1, 'Revisor Automático (ambas financieras): tolerancia en $ al comparar los montos del documento contra lo digitado (redondeos)'],
    ]) await pool.query('INSERT IGNORE INTO parametros_credito (clave, valor, descripcion) VALUES (?,?,?)', [clave, valor, descripcion]);
    await pool.query("UPDATE parametros_credito SET descripcion='Revisor Automático (ambas financieras): tolerancia en $ al comparar los montos del documento contra lo digitado (redondeos)' WHERE clave='rev_unidad_tolerancia'");
    // Card "Bitácora Revisor Automático" en el módulo Cartas de Aprobación (300001)
    const [[fEx]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='aprob_bitacora_revisor' LIMIT 1");
    if (!fEx) await pool.query(
      `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
       VALUES (300001, 'Bitácora Revisor Automático', 'aprob_bitacora_revisor', '/aprobaciones/bitacora-revisor/', 'bi-robot')`);
    const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE UPPER(nombre) LIKE 'ADMINISTRADOR%' ORDER BY id_perfil LIMIT 1");
    if (adm) {
      await pool.query(
        `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT ?, id_funcionalidad, 1 FROM funcionalidades WHERE codigo='aprob_bitacora_revisor'`, [adm.id_perfil]);
      // habilitado=1 explícito: el default de la columna es 0 y mis-permisos filtra por él
      await pool.query(
        `UPDATE permisos_perfil pp JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
         SET pp.habilitado = 1 WHERE f.codigo='aprob_bitacora_revisor' AND pp.id_perfil = ?`, [adm.id_perfil]);
    }
    console.log('[revisor-unidad] listo');
  } catch (e) { console.error('[revisor-unidad migration]', e.message); }
});

const fmt = n => n == null ? '—' : '$' + Number(n).toLocaleString('es-CL');
const normRut = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();

async function params() {
  const [rows] = await pool.query("SELECT clave, valor FROM parametros_credito");
  const p = {}; rows.forEach(r => { p[r.clave] = parseFloat(r.valor); });
  return p;
}

/* Tasa pizarra UNIDAD a la fecha de la carta, por tramo mayor/menor 200 UF. */
async function tasaPizarra(fecha, saldo, p) {
  const [[t]] = await pool.query(
    `SELECT tasa_mensual_menor, tasa_mensual_mayor FROM tasas
      WHERE fecha_desde <= COALESCE(?, CURDATE()) ORDER BY fecha_desde DESC LIMIT 1`, [fecha || null]);
  if (!t) return null;
  const [[u]] = await pool.query(
    'SELECT valor FROM uf WHERE fecha <= COALESCE(?, CURDATE()) ORDER BY fecha DESC LIMIT 1', [fecha || null]);
  const uf = parseFloat(u?.valor) || 0;
  const mayor = uf > 0 && saldo / uf > (p.umbral_uf_tramo || 200);
  return parseFloat(mayor ? t.tasa_mensual_mayor : t.tasa_mensual_menor) || null;
}

/* Comisión dealer esperada (neta) por el motor único: tabla del dealer → pizarra. */
async function comisionEsperada(carta, p) {
  const esParque = String(carta.parque || '').toUpperCase().includes('PARQUE');
  let dealerTabla = null;
  if (carta.rut_dealer) {
    try {
      const [dr] = await pool.query(
        "SELECT com_6_12, com_13_24, com_25_36, com_37, com_parque_6_12, com_parque_13_24, com_parque_25_36, com_parque_37 FROM dealers WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ? LIMIT 1",
        [normRut(carta.rut_dealer)]);
      dealerTabla = dr[0] || null;
    } catch (e) { dealerTabla = null; }
  }
  let parqData = null;
  if (esParque) {
    try {
      const [pr] = await pool.query(
        'SELECT arriendo, comision_pct FROM parques_comisiones WHERE activo=1 AND UPPER(TRIM(nombre)) = ? LIMIT 1',
        [String(carta.parque || '').toUpperCase().trim()]);
      parqData = pr[0] || null;
    } catch (e) { /* motor cae a patio_pct */ }
  }
  const cd = comisionDealer({ saldo: parseFloat(carta.saldo) || 0, plazo: parseInt(carta.plazo) || 0, esParque },
                            { dealerTabla, parqData, pizarra: p });
  return { esParque, neta: Math.round(cd.comdea_real || 0) };
}

/* ── RENTABILIDAD REAL (server-side) ──────────────────────────────────────
   El snapshot del código trae rent_jugada/mejor_base calculados por el
   NAVEGADOR — un generar por API podría inflarlos. Acá se recomputa la
   rentabilidad con el MISMO motor AF_RENT pero con los números de la CARTA:
   no importa lo que el snapshot diga, la operación real debe cumplir el piso. */
let _RENT = null;
function motorRent() {
  if (_RENT) return _RENT;
  /* AF_RENT es window-only; se carga con un window temporal. OJO: dejar
     global.window definido cuelga pdf-parse — por eso se borra al tiro. */
  const had = global.window;
  if (!had) global.window = {};
  try {
    global.window.AF_RENT_CORE = global.window.AF_RENT_CORE || require('../../../api-gateway/public/js/rentabilidad-core');
    global.window.AF_COM_DEALER = global.window.AF_COM_DEALER || require('../../../api-gateway/public/js/comision-dealer');
    require('../../../api-gateway/public/js/rentabilidad-calc');
    _RENT = global.window.AF_RENT;
  } finally { if (!had) delete global.window; }
  return _RENT;
}

async function rentabilidadReal(carta, p, esAutofin) {
  const AF_RENT = motorRent();
  if (!AF_RENT) return null;
  const fecha = carta.fecha || new Date();
  const [[t]] = await pool.query(
    'SELECT tasa_mensual_menor, tasa_mensual_mayor, spread_menor, spread_mayor FROM tasas WHERE fecha_desde <= ? ORDER BY fecha_desde DESC LIMIT 1', [fecha]);
  const [[u]] = await pool.query('SELECT valor FROM uf WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1', [fecha]);
  if (!t || !u) return null;
  const mes = new Date(fecha).toISOString().slice(0, 7);
  const [[ops]] = await pool.query(
    `SELECT COUNT(*) n FROM creditos WHERE DATE_FORMAT(mes,'%Y-%m') = ?
       AND (financiera LIKE '%UNIDAD%' OR financiera LIKE '%UAC%') AND estado_credito IN ('OTORGADO','APROBADO')`, [mes]);
  const uacPct = require('../../creditos/src/utils/uac-tier').pctUACOperacion(
    { ops: Number(ops.n) || 0, plazo: parseInt(carta.plazo) || 0, mes }, p);
  const base = {
    valor: parseFloat(carta.precio_venta) || 0, pie: parseFloat(carta.pie) || 0,
    plazo: parseInt(carta.plazo) || 0, esPatio: String(carta.parque || '').toUpperCase().includes('PARQUE'),
    uacPct, corfo: false,
  };
  if (!(base.valor > 0) || !(base.plazo > 0)) return null;
  const UF = parseFloat(u.valor);
  // Jugada = los números REALES de la carta (tasa cursada + comisión pactada)
  const jug = AF_RENT.calcular({ ...base, tasaCli: parseFloat(carta.tasa_credito) / 100 || null,
    dealerComCLP: carta.part_bruto != null ? parseFloat(carta.part_bruto) : null }, p, UF, t);
  // Mejor base = ambos lados con pizarra (tasa TMC/mantenedor + comisión pizarra)
  const piz = AF_RENT.calcular({ ...base, tasaCli: null, dealerComCLP: null }, p, UF, t);
  return {
    jugada: esAutofin ? jug.af.rentab : jug.uac.rentab,
    mejor: Math.max(piz.af.rentab, piz.uac.rentab),
    comMax: Math.max(jug.costos.dealer, jug.costos.ejecutivo),
  };
}

/* ── LA REVISIÓN ─────────────────────────────────────────────────────────── */
async function revisar(carta, p) {
  const checks = [];
  const tol = Number.isFinite(p.rev_unidad_tolerancia) ? p.rev_unidad_tolerancia : 1;
  const add = (item, doc, sistema, ok, nota) => { checks.push({ item, doc, sistema, ok: !!ok, nota: nota || null }); return ok; };

  const esAutofin = String(carta.acreedor || '').toUpperCase().includes('AUTOFIN');
  const cerca = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;

  // 1. Documentos con lectura (Unidad: compromiso + cotización · Autofin: carta + pantallazo)
  const TIPOS = esAutofin ? ['CARTA_AUTOFIN', 'PANTALLAZO_AUTOFIN'] : ['COMPROMISO_UNIDAD', 'COTIZACION_UNIDAD'];
  const [docs] = await pool.query(
    'SELECT tipo, nombre, extracted FROM cartas_documentos WHERE id_carta=? AND tipo IN (?)', [carta.id, TIPOS]);
  const parse = {};
  for (const d of docs) { try { parse[d.tipo] = typeof d.extracted === 'object' && d.extracted ? d.extracted : JSON.parse(d.extracted || 'null'); } catch (_) {} }
  const comp = esAutofin ? parse.CARTA_AUTOFIN : parse.COMPROMISO_UNIDAD;
  const cot  = esAutofin ? null : parse.COTIZACION_UNIDAD;
  const pz   = esAutofin ? parse.PANTALLAZO_AUTOFIN : null;
  const faltan = TIPOS.filter(t => !parse[t]);
  if (faltan.length) return { checks, ok: false, motivo: 'Faltan documentos: ' + faltan.map(t => t.replace(/_/g, ' ')).join(', ') };
  for (const d of [comp, cot, pz]) if (d && (d.escaneado || d.error_lectura || d.sin_ia))
    return { checks, ok: false, motivo: 'Documento escaneado o ilegible: requiere ojo humano' };

  // 1b. AUTOFIN: el pantallazo debe mostrar la solicitud en Revisión Firma o Cursado
  if (esAutofin) {
    const est = String(pz.estado || '').toUpperCase().replace(/[^A-Z]/g, '');
    const estadoOk = est.includes('REVISIONFIRMA') || est.includes('CURSADO');
    add('Estado en Autofin (pantallazo)', pz.estado || 'no visible', 'Revisión Firma o Cursado', estadoOk,
        estadoOk ? null : 'la carta solo puede emitirse con la solicitud en Revisión Firma o Cursado');
    if (pz.idSolicitud) add('ID solicitud (pantallazo)', pz.idSolicitud, carta.id_financiera,
        String(pz.idSolicitud) === String(carta.id_financiera || ''));
  }

  // 1c. Datos mínimos del sistema: sin tasa o sin comisión digitada NO se aprueba
  //     a ciegas — esos checks quedarían saltados en silencio (auditoría, hallazgo 3).
  if (carta.tasa_credito == null || carta.part_neto == null || carta.monto_credito_clp == null || !carta.saldo || !carta.plazo)
    return { checks, ok: false, motivo: 'Carta con datos incompletos (tasa, comisión, montos o plazo): requiere ojo humano' };

  // 2. Documento vs sistema
  add('ID Financiera', comp.opOrigen || cot?.opOrigen, carta.id_financiera,
      String(comp.opOrigen || cot?.opOrigen || '') === String(carta.id_financiera || ''));
  if (comp.rutCliente) add('RUT cliente', comp.rutCliente, carta.rut_cliente, normRut(comp.rutCliente) === normRut(carta.rut_cliente));
  add('Saldo precio', fmt(cot?.saldo ?? comp.saldo), fmt(carta.saldo), cerca(cot?.saldo ?? comp.saldo, carta.saldo));
  add('Plazo (cuotas)', cot?.plazo ?? comp.plazo, carta.plazo, String(cot?.plazo ?? comp.plazo ?? '') === String(carta.plazo ?? ''));
  add('Monto bruto del crédito', fmt(esAutofin ? comp.montoCreditoCLP : cot?.montoCreditoCLP), fmt(carta.monto_credito_clp),
      cerca(esAutofin ? comp.montoCreditoCLP : cot?.montoCreditoCLP, carta.monto_credito_clp));

  // 3. Tasa: doc vs sistema + rebaja máxima sobre pizarra
  const tasaDoc = comp.tasaCredito != null ? parseFloat(String(comp.tasaCredito).replace(',', '.')) : null;
  const tasaCarta = carta.tasa_credito != null ? parseFloat(carta.tasa_credito) : null;
  if (tasaDoc != null && tasaCarta != null)
    add('Tasa cursada (doc vs sistema)', tasaDoc + '%', tasaCarta + '%', Math.abs(tasaDoc - tasaCarta) <= 0.005);
  const piz = await tasaPizarra(carta.fecha, parseFloat(carta.saldo) || 0, p);
  if (piz == null) return { checks, ok: false, motivo: 'Sin tasa pizarra vigente para la fecha de la carta: requiere ojo humano' };
  let tasaRebajada = false;
  if (piz != null && tasaCarta != null) {
    const minPermitida = Math.floor(piz * (1 - (p.exc_tasa_rebaja_max_pct || 5) / 100) * 100) / 100;
    tasaRebajada = tasaCarta < piz - 0.005;
    const dentroMax = tasaCarta >= minPermitida - 0.005;
    // ✅ solo si no hay rebaja, o si la rebaja está dentro del máximo Y viene con código
    add('Tasa pizarra / cursada', piz + '% pizarra', tasaCarta + '% cursada',
        !tasaRebajada || (dentroMax && !!carta.codigo_excepcion),
        !tasaRebajada ? 'sin rebaja'
        : !dentroMax ? `rebaja EXCEDE el máximo ${p.exc_tasa_rebaja_max_pct || 5}% (mínimo permitido ${minPermitida}%)`
        : carta.codigo_excepcion ? `rebaja dentro del máximo ${p.exc_tasa_rebaja_max_pct || 5}%, respaldada por código`
        : `rebaja dentro del máximo ${p.exc_tasa_rebaja_max_pct || 5}% pero SIN código de excepción`);
  }

  // 4. Comisión dealer: motor único vs carta. Solo una comisión MAYOR al motor
  //    es excepción (le cuesta plata a AutoFácil y necesita autorización); una
  //    menor es a favor y pasa sola (pedido Pato 10-08-2026).
  const ce = await comisionEsperada(carta, p);
  const netaCarta = carta.part_neto != null ? Math.round(parseFloat(carta.part_neto)) : null;
  const comisionModificada = netaCarta != null && netaCarta - ce.neta > tol;
  const comisionMenor = netaCarta != null && ce.neta - netaCarta > tol;
  add(`Comisión dealer (${ce.esParque ? 'parque' : 'calle'})`, fmt(ce.neta) + ' neta según motor', fmt(netaCarta) + ' neta en carta',
      !comisionModificada || !!carta.codigo_excepcion,
      comisionMenor ? 'menor al motor — a favor de AutoFácil, no requiere código'
      : !comisionModificada ? 'según pizarra/tabla del dealer'
      : carta.codigo_excepcion ? 'aumentada, respaldada por código de excepción'
      : 'aumentada SIN código de excepción');

  // 5. Excepciones ↔ código
  const hayExcepcion = tasaRebajada || comisionModificada;
  if (hayExcepcion || carta.codigo_excepcion) {
    if (!carta.codigo_excepcion)
      return { checks, ok: false, motivo: 'Hay excepción (tasa rebajada o comisión aumentada) sin código del sistema' };
    const [[cod]] = await pool.query(
      'SELECT tipo, estado, costo_estrellas, snapshot, financiera, saldo_precio, plazo FROM excepciones_codigos WHERE codigo=? LIMIT 1',
      [String(carta.codigo_excepcion).trim()]);
    if (!cod) return { checks, ok: false, motivo: 'El código de excepción no existe' };
    let s = {}; try { s = typeof cod.snapshot === 'object' && cod.snapshot ? cod.snapshot : JSON.parse(cod.snapshot || '{}'); } catch (_) {}
    add('Código de excepción', carta.codigo_excepcion + ' (' + cod.tipo + ')', 'usado en esta carta', cod.estado === 'USADO');
    if (cod.tipo !== 'GERENCIA') {
      const niv = parseInt(s.nivel) || 1;
      const costoOk = { 1: 1, 2: p.exc_piso2_estrellas || 2, 3: p.exc_nivel3_estrellas || 3 }[niv];
      add('Estrellas del nivel', `nivel ${niv} → ${'⭐'.repeat(costoOk || 1)}`, `${cod.costo_estrellas}⭐ cobradas`, cod.costo_estrellas === costoOk);
      /* PISO DE RENTABILIDAD — recomputado en el SERVIDOR con los números de la
         CARTA (auditoría: el snapshot lo calculó el navegador y podría venir
         forjado por API; la operación real debe cumplir el piso, diga lo que
         diga el snapshot). Holgura $2.000 por redondeos front/back. */
      const pct = { 1: p.exc_piso_pct || 75, 2: p.exc_piso2_pct || 50, 3: p.exc_piso3_pct || 25 }[niv];
      let rr = null;
      try { rr = await rentabilidadReal(carta, p, esAutofin); } catch (e) { console.error('[revisor rentReal]', e.message); }
      if (!rr) return { checks, ok: false, motivo: 'No se pudo recomputar la rentabilidad de la jugada: requiere ojo humano' };
      const HOLGURA = 2000;
      const cumple = rr.jugada >= rr.mejor * pct / 100 - HOLGURA
                  && (niv !== 3 || (rr.jugada >= (p.exc_nivel3_rent_min || 200000) - HOLGURA
                                    && rr.jugada >= rr.comMax * (1 + (p.exc_nivel3_factor_pct || 0) / 100) - HOLGURA));
      add(`Piso de rentabilidad (${pct}%) — recomputado`, fmt(Math.round(rr.mejor * pct / 100)) + ' mínimo (server)',
          fmt(Math.round(rr.jugada)) + ' rentab. real de la carta', cumple,
          (niv === 3 ? `nivel 3: además ≥ comisión más alta ${fmt(rr.comMax)} y mínimo absoluto ${fmt(p.exc_nivel3_rent_min || 200000)}. ` : '')
          + (s.rent_jugada != null ? `snapshot decía ${fmt(Math.round(s.rent_jugada))}` : 'snapshot sin medir'));
      const finEsperada = esAutofin ? 'AUTOFIN' : 'UNIDAD';
      add('Financiera del código', cod.financiera || '—', finEsperada, String(cod.financiera || '').toUpperCase().includes(finEsperada));
    }
  } else {
    add('Excepciones', 'sin excepciones', 'cursación estándar', true);
  }

  const malos = checks.filter(c => !c.ok);
  return { checks, ok: !malos.length, motivo: malos.length ? 'No cuadra: ' + malos.map(c => c.item).join(', ') : null };
}

/* ── CHECKLIST FIRMADO (HTML verificable, timbre APROBACIÓN AUTOMÁTICA) ──── */
async function generarChecklist(carta, checks) {
  const ahora = new Date();
  const fh = ahora.toLocaleString('es-CL', { timeZone: 'America/Santiago' });
  const codigo = await registrarVerificable({
    tipo: 'CHECKLIST_REVISOR_UNIDAD', ref_tabla: 'cartas_aprobacion', ref_id: carta.id,
    rut: carta.rut_cliente, nombre: carta.cliente,
    datos: { op_carta: carta.op_carta, id_financiera: carta.id_financiera, checks, fecha_hora: fh },
    emitido_por: 'Business Suite — Revisor Automático',
    firmante: { nombre: 'Business Suite', cargo: 'Revisor Automático de Cartas' },
  });
  const filas = checks.map(c => `
    <tr><td>${c.ok ? '✅' : '❌'}</td><td><b>${c.item}</b>${c.nota ? `<div class="nota">${c.nota}</div>` : ''}</td>
        <td>${c.doc ?? '—'}</td><td>${c.sistema ?? '—'}</td></tr>`).join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Checklist Revisor Automático — Carta ${carta.op_carta}</title>
<style>
  body{font-family:'Segoe UI',system-ui,sans-serif;color:#1e293b;max-width:820px;margin:24px auto;padding:0 18px}
  h1{color:#012d70;font-size:1.25rem;margin-bottom:2px} .sub{color:#64748b;font-size:.85rem;margin-bottom:18px}
  table{width:100%;border-collapse:collapse;font-size:.88rem} th,td{border:1px solid #e2e8f0;padding:7px 10px;text-align:left}
  th{background:#f1f5f9;color:#012d70} .nota{font-size:.75rem;color:#64748b}
  .timbre{display:inline-block;border:3px solid #16a34a;color:#16a34a;font-weight:800;border-radius:10px;
    padding:8px 18px;transform:rotate(-3deg);font-size:1rem;letter-spacing:1px;margin:18px 0}
  .firma{margin-top:22px;border-top:1px solid #e2e8f0;padding-top:12px;font-size:.82rem;color:#475569;display:flex;justify-content:space-between;align-items:center;gap:16px}
  @media print { .noprint{display:none} }
</style></head><body>
<h1>Checklist de Revisión — Carta de Aprobación ${carta.op_carta}</h1>
<div class="sub">Cliente ${carta.cliente || ''} · RUT ${carta.rut_cliente || ''} · Financiera ${carta.acreedor || ''} · ID ${carta.id_financiera || ''}<br>
Dealer ${carta.nombre_dealer || ''} · ${fh}</div>
<table><tr><th></th><th>Validación</th><th>Documento financiera</th><th>Business Suite</th></tr>${filas}</table>
<div class="timbre">✔ APROBACIÓN AUTOMÁTICA — BUSINESS SUITE</div>
<div class="firma">
  <div><b>Firmado electrónicamente por Business Suite</b> (Revisor Automático de Cartas Unidad)<br>
  ${fh} · Documento verificable — código <b>${codigo}</b><br>
  <span>Verificar en: ${(process.env.APP_URL || 'https://afbs.autofacilchile.cl')}/verificar/${codigo}</span></div>
  <div id="qr"></div>
</div>
<script src="/js/qrcode-generator.js"></script><script src="/js/qr-verificacion.js"></script>
<script>try{document.getElementById('qr').innerHTML=qrVerificacionHTML('${codigo}',{px:96});}catch(e){}</script>
</body></html>`;
  const buf = Buffer.from(html, 'utf8');
  const d = await almacen.colocar({ ambito: 'cartas', clave: carta.id, buffer: buf, mime: 'text/html', nombre: `checklist-${carta.op_carta}.html` });
  await pool.query('DELETE FROM cartas_documentos WHERE id_carta=? AND tipo=?', [carta.id, 'CHECKLIST_REVISOR']);
  const [ins] = await pool.query(
    `INSERT INTO cartas_documentos (id_carta, tipo, nombre, mime, tamano, data, doc_storage, doc_ruta, doc_bytes, extracted, subido_por)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [carta.id, 'CHECKLIST_REVISOR', `Checklist Revisor Automático ${carta.op_carta}.html`, 'text/html', buf.length,
     d.blob, d.storage, d.ruta, d.bytes, JSON.stringify({ codigo, checks }), 'businesssuite']);
  return { codigo, docId: ins.insertId };
}

/* Fila inmutable en la bitácora del Revisor (nunca se edita ni se borra). */
function anotarBitacora(carta, resultado, r, checklist) {
  return pool.query(
    `INSERT INTO revisor_bitacora (id_carta, op_carta, id_financiera, cliente, rut_cliente, ejecutivo, creado_por,
       resultado, motivo, checks, codigo_excepcion, checklist_codigo, checklist_doc_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [carta.id, carta.op_carta, carta.id_financiera, carta.cliente, carta.rut_cliente, carta.ejecutivo, carta.creado_por,
     resultado, r.motivo || null, JSON.stringify(r.checks || []), carta.codigo_excepcion || null,
     checklist?.codigo || null, checklist?.docId || null]
  ).catch(e => console.error('[revisor-unidad bitacora]', e.message));
}

/* ── ENTRADA: se dispara al subir documentos o re-guardar una carta ────────
   _enCurso: candado por carta — dos documentos subiendo a la vez disparaban
   dos revisiones simultáneas (doble checklist y doble fila de bitácora). */
const _enCurso = new Set();
async function procesarCarta(idCarta) {
  if (_enCurso.has(idCarta)) return;
  _enCurso.add(idCarta);
  try { await _procesarCarta(idCarta); } finally { _enCurso.delete(idCarta); }
}
async function _procesarCarta(idCarta) {
  try {
    const [[carta]] = await pool.query('SELECT * FROM cartas_aprobacion WHERE id=? LIMIT 1', [idCarta]);
    if (!carta || carta.status !== 'PENDIENTE' || carta.otorgado) return;
    const acr = String(carta.acreedor || '').toUpperCase();
    const esAutofin = acr.includes('AUTOFIN');
    if (!esAutofin && !acr.includes('UNIDAD')) return;
    const p = await params();
    const activo = esAutofin ? p.rev_autofin_activo : p.rev_unidad_activo;
    if (!(activo > 0)) return;   // apagado: todo al analista, sin ruido
    /* Vigencia (auditoría, hallazgo 2): el humano no puede aprobar una carta
       vencida — el motor tampoco. El barrido la pasará a VENCIDA. */
    if (carta.fecha) {
      const dias = parseFloat(p.vigencia_carta_dias) > 0 ? parseFloat(p.vigencia_carta_dias) : 5;
      const vence = new Date(carta.fecha); vence.setDate(vence.getDate() + dias); vence.setHours(23, 59, 59);
      if (vence < new Date()) { console.log(`[revisor-unidad] carta ${carta.op_carta} vencida: no se aprueba`); return; }
    }

    const r = await revisar(carta, p);
    await pool.query('UPDATE cartas_aprobacion SET revision_auto=? WHERE id=?',
      [JSON.stringify({ ok: r.ok, motivo: r.motivo, checks: r.checks, at: new Date().toISOString() }), idCarta]);

    if (!r.ok) {
      // Sin ambos documentos aún no hay revisión completa: no ensuciar la bitácora
      if (!/Faltan documentos/.test(r.motivo || '')) await anotarBitacora(carta, 'DERIVADA', r, null);
      console.log(`[revisor-unidad] carta ${carta.op_carta}: al analista — ${r.motivo}`);
      return;   // queda PENDIENTE en la cola humana con el detalle en revision_auto
    }

    const checklist = await generarChecklist(carta, r.checks);
    await anotarBitacora(carta, 'APROBADA', r, checklist);
    await pool.query(
      `UPDATE cartas_aprobacion SET status='APROBADA', aprobado_por='businesssuite',
        aprobado_por_nombre='Business Suite (automática)', aprobado_por_initials='BS',
        fecha_aprobacion=NOW(), comentario_aprobacion='APROBACIÓN AUTOMÁTICA: documentos de la financiera validados contra el sistema por el Revisor de Business Suite. Checklist firmado adjunto en los documentos de la carta.'
       WHERE id=? AND status='PENDIENTE'`, [idCarta]);
    if (carta.id_credito_creado)
      await pool.query(`UPDATE creditos SET estado='CARTA_APROBACION', updated_at=NOW() WHERE id=? AND estado='INGRESO'`,
        [carta.id_credito_creado]).catch(e => console.error('[revisor-unidad credito]', e.message));

    AVISOS.retirar('carta:' + idCarta).catch(() => {});
    const [[autor]] = await pool.query('SELECT id_usuario FROM usuarios WHERE email=? LIMIT 1', [carta.creado_por || '']);
    if (autor) await AVISOS.avisar('carta_resuelta', {
      tipo: 'CARTA_APROBADA', titulo: '🤖✅ Carta aprobada automáticamente',
      mensaje: `Tu carta ${carta.op_carta} (${carta.cliente || ''}) pasó la revisión automática de Business Suite — ya puedes imprimirla. El checklist firmado quedó en sus documentos.`,
      href: '/aprobaciones/', son_tipo: 'dingdong',
    }, { extra: [autor.id_usuario] }).catch(() => {});
    try { require('../../../shared/audit').auditar({ usuario: { id_usuario: null, nombre: 'Business Suite', email: 'businesssuite' },
      accion: 'APROBAR', modulo: 'cartas', entidad: 'carta', entidad_id: idCarta,
      detalle: `APROBACIÓN AUTOMÁTICA carta ${carta.op_carta} — ${carta.cliente || ''} (Revisor Unidad)` }); } catch (_) {}
    console.log(`[revisor-unidad] carta ${carta.op_carta} APROBADA automáticamente ✔`);
  } catch (e) { console.error('[revisor-unidad]', e.message); }
}

/* GET /api/cartas/revisor-bitacora?mes=YYYY-MM&resultado=APROBADA|DERIVADA
   Bitácora de auditoría del Revisor (solo lectura; máx 500 filas por consulta). */
async function bitacora(req, res) {
  try {
    const cond = [], vals = [];
    if (/^\d{4}-\d{2}$/.test(req.query.mes || '')) { cond.push("DATE_FORMAT(created_at,'%Y-%m') = ?"); vals.push(req.query.mes); }
    if (['APROBADA', 'DERIVADA'].includes(req.query.resultado || '')) { cond.push('resultado = ?'); vals.push(req.query.resultado); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const [rows] = await pool.query(
      `SELECT id, id_carta, op_carta, id_financiera, cliente, rut_cliente, ejecutivo, creado_por,
              resultado, motivo, checks, codigo_excepcion, checklist_codigo, checklist_doc_id, created_at
         FROM revisor_bitacora ${where} ORDER BY created_at DESC, id DESC LIMIT 500`, vals);
    const [[tot]] = await pool.query(
      `SELECT COUNT(*) n, SUM(resultado='APROBADA') aprobadas, SUM(resultado='DERIVADA') derivadas FROM revisor_bitacora ${where}`, vals);
    rows.forEach(r => { try { r.checks = typeof r.checks === 'object' ? r.checks : JSON.parse(r.checks || '[]'); } catch (_) { r.checks = []; } });
    res.json({ success: true, data: { rows, stats: { total: Number(tot.n) || 0, aprobadas: Number(tot.aprobadas) || 0, derivadas: Number(tot.derivadas) || 0 } }, error: null });
  } catch (e) { console.error('[revisor-bitacora]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
}

module.exports = { procesarCarta, revisar, params, bitacora };   // revisar/params exportados para pruebas
