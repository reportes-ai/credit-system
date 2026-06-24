'use strict';
/* ════════════════════════════════════════════════════════════════════════
   Migración Cartera INDEXA → Business Suite
   Sube 2 archivos del informe diario de INDEXA:
     - Tabla de Desarrollo (CSV ';', latin1): calendario de cuotas por crédito
     - Archivo Cobranza (xlsx): datos de contacto + vehículo por OP
   Llave de cruce: OP (xlsx) == ID_Credito (csv).
   Regla de ámbito (definida por negocio): el crédito es cartera AutoFácil si
   tiene alguna cuota VIGENTE o COBRANZA; si están todas PAGADA (sin saldo) es
   brokerage/prepagado. num_op = OP de INDEXA tal cual. origen='INDEXA'.
   Esta fase: schema + DRY-RUN (no escribe). APLICAR llega en la siguiente etapa.
   ════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const XLSX = require('xlsx');

/* ── Schema: calendario real (no se recalcula) + marca de origen ───────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cuotas_credito (
        id_cuota          INT AUTO_INCREMENT PRIMARY KEY,
        id_credito        INT NOT NULL,
        num_op            INT NULL,
        numero_cuota      INT NOT NULL,
        fecha_vencimiento DATE NULL,
        interes           DECIMAL(15,0) DEFAULT 0,
        amortizacion      DECIMAL(15,0) DEFAULT 0,
        valor_cuota       DECIMAL(15,0) DEFAULT 0,
        saldo_insoluto    DECIMAL(15,0) DEFAULT 0,
        estado_cuota      VARCHAR(20) NULL,
        fecha_pago        DATE NULL,
        tasa              DECIMAL(8,4) NULL,
        dias_desfase      INT NULL,
        origen            VARCHAR(20) DEFAULT 'INDEXA',
        created_at        DATETIME DEFAULT NOW(),
        updated_at        DATETIME DEFAULT NOW() ON UPDATE NOW(),
        UNIQUE KEY uq_cuota (id_credito, numero_cuota),
        INDEX idx_credito (id_credito),
        INDEX idx_venc (fecha_vencimiento)
      )`);
    await pool.query(`ALTER TABLE creditos ADD COLUMN origen VARCHAR(20) NULL`).catch(() => {});
    console.log('✓ migracion-indexa: cuotas_credito + creditos.origen listos');
  } catch (e) { console.error('[migracion-indexa schema]', e.message); }
})();

/* ── Normalizadores ────────────────────────────────────────────────────── */
// CSV trae RUT con DV pegado ("129382163" → 12.938.216-3)
function fmtRutConDV(rutConDV) {
  let s = String(rutConDV || '').replace(/[^0-9kK]/g, '').toUpperCase();
  if (s.length < 2) return null;
  const dv = s.slice(-1), cuerpo = s.slice(0, -1);
  if (!/^\d+$/.test(cuerpo)) return null;
  const miles = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${miles}-${dv}`;
}
// dd/mm/yyyy → yyyy-mm-dd (null si no parsea)
function pDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
function pNum(s) {
  const n = parseInt(String(s == null ? '' : s).replace(/[^0-9\-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function pTasa(s) {
  const n = parseFloat(String(s == null ? '' : s).replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}
// quita acentos + upper + colapsa espacios (robustez de encabezados)
function normKey(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

/* ── Parseo de archivos ────────────────────────────────────────────────── */
// Cobranza xlsx → Map(OP → primera fila del crédito)
function parseCobranza(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  const byOp = new Map();
  for (const r of rows) {
    const op = String(r['OP'] == null ? '' : r['OP']).trim();
    if (op && !byOp.has(op)) byOp.set(op, r);
  }
  return byOp;
}
// Tabla Desarrollo CSV (latin1, ';') → { idx (por encabezado normalizado), rows[] }
function parseDesarrollo(buf) {
  const txt = Buffer.from(buf).toString('latin1');
  const lines = txt.split(/\r?\n/);
  let hi = 0;
  while (hi < lines.length && lines[hi].trim() === '') hi++;
  const head = lines[hi].split(';').map(h => h.trim());
  const idx = {};
  head.forEach((h, i) => { idx[normKey(h)] = i; });
  const rows = [];
  let malformadas = 0;
  for (let i = hi + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const c = lines[i].split(';');
    if (c.length > head.length) { malformadas++; continue; }
    while (c.length < head.length) c.push('');
    rows.push(c);
  }
  return { idx, rows, malformadas, ncols: head.length };
}

/* ── Construye la estructura por crédito (clasifica AutoFácil vs prepagado) ─ */
function construir(byOp, des) {
  const { idx, rows } = des;
  const G = (c, name) => { const i = idx[normKey(name)]; return i === undefined ? '' : String(c[i]).trim(); };

  const porCredito = new Map();
  for (const c of rows) {
    const id = G(c, 'ID_Credito');
    if (!id) continue;
    if (!porCredito.has(id)) porCredito.set(id, []);
    porCredito.get(id).push(c);
  }

  const out = [];
  for (const [id, cuotas] of porCredito) {
    cuotas.sort((a, b) => pNum(G(a, 'Numero_Cuota')) - pNum(G(b, 'Numero_Cuota')));
    const estados = new Set(cuotas.map(c => G(c, 'Estado_Cuota')));
    const activo = estados.has('VIGENTE') || estados.has('COBRANZA');
    const first = cuotas[0];
    const cob = byOp.get(id) || {};
    const sCob = (k) => { const v = cob[k]; return v == null ? '' : String(v).trim(); };

    out.push({
      id,
      num_op: parseInt(id, 10),
      rut: fmtRutConDV(G(first, 'Rut_Cliente')),
      nombres: G(first, 'Nombre_RazonSocial_Cliente') || null,
      ap_paterno: G(first, 'PN_Apellido_Paterno_Cliente') || null,
      ap_materno: G(first, 'PN_Apellido_Materno_Cliente') || null,
      nombre_completo: sCob('NOMBRE') ||
        [G(first, 'Nombre_RazonSocial_Cliente'), G(first, 'PN_Apellido_Paterno_Cliente'), G(first, 'PN_Apellido_Materno_Cliente')].filter(Boolean).join(' '),
      activo,
      plazo: sCob('CUOTAS') ? pNum(sCob('CUOTAS')) : cuotas.length,
      tasa: pTasa(G(first, 'Tasa_Interes')),
      fecha_primera_cuota: pDate(G(first, 'Fecha_Vencimiento_Cuota')),
      monto_financiado: pNum(G(first, 'Saldo_Insoluto_Cuota')) + pNum(G(first, 'Amortizacion_Cuota')),
      // vehículo (xlsx)
      marca: sCob('MARCA VEHICULO') || null,
      modelo: sCob('MODELO VEHICULO') || null,
      anio: sCob('AÑO VEHICULO') ? pNum(sCob('AÑO VEHICULO')) : null,
      tipo_vehiculo: sCob('TIPO VEHICULO') || null,
      nuevo_usado: sCob('Nuevo/usado') || null,
      // contacto (xlsx)
      email: sCob('MAIL') || null,
      direccion: sCob('DIRECCION APRTICUALR') || null,
      telefono: sCob('TELEFONO CELUALR') || sCob('TELEFONO PARTICULAR') || null,
      comuna: sCob('COMUNA') || null,
      region: sCob('REGION') || null,
      en_cobranza: byOp.has(id),
      cuotas: cuotas.map(c => ({
        numero: pNum(G(c, 'Numero_Cuota')),
        venc: pDate(G(c, 'Fecha_Vencimiento_Cuota')),
        venc_raw: G(c, 'Fecha_Vencimiento_Cuota'),
        interes: pNum(G(c, 'Interes_Cuota')),
        amort: pNum(G(c, 'Amortizacion_Cuota')),
        valor: pNum(G(c, 'Valor_Cuota')),
        saldo: pNum(G(c, 'Saldo_Insoluto_Cuota')),
        estado: G(c, 'Estado_Cuota') || null,
        fpago: pDate(G(c, 'Fecha_Pago')),
        fpago_raw: G(c, 'Fecha_Pago'),
        dias: pNum(G(c, 'Días desfase')),
      })),
    });
  }
  return out;
}

/* ── Helper: lee los 2 buffers subidos ─────────────────────────────────── */
function leerArchivos(req) {
  const f = req.files || {};
  const des = (f.desarrollo && f.desarrollo[0]) || null;
  const cob = (f.cobranza && f.cobranza[0]) || null;
  if (!des) throw new Error('Falta la Tabla de Desarrollo (CSV).');
  if (!cob) throw new Error('Falta el Archivo de Cobranza (xlsx).');
  return {
    byOp: parseCobranza(cob.buffer),
    des: parseDesarrollo(des.buffer),
  };
}

/* ── DRY-RUN: analiza y cuadra, sin escribir nada ──────────────────────── */
const dryRun = async (req, res) => {
  try {
    const { byOp, des } = leerArchivos(req);
    const data = construir(byOp, des);

    const cuotasAll = data.flatMap(d => d.cuotas);
    const estadoCuota = {};
    for (const c of cuotasAll) estadoCuota[c.estado || '∅'] = (estadoCuota[c.estado || '∅'] || 0) + 1;

    const activos = data.filter(d => d.activo);
    const pagadas = cuotasAll.filter(c => c.estado === 'PAGADA');
    const pagadasSinFecha = pagadas.filter(c => !c.fpago).length;
    const pagadasActSinFecha = activos.flatMap(d => d.cuotas).filter(c => c.estado === 'PAGADA' && !c.fpago).length;

    // anomalías de parseo
    const vencNoParse = cuotasAll.filter(c => c.venc_raw && !c.venc).length;
    const fpagoNoParse = cuotasAll.filter(c => c.fpago_raw && !c.fpago).length;
    const rutNulos = data.filter(d => !d.rut).length;

    // clientes únicos por rut
    const ruts = new Set(data.map(d => d.rut).filter(Boolean));

    // colisión de num_op con créditos nativos (no-INDEXA)
    const ids = data.map(d => d.num_op).filter(Boolean);
    let colisiones = [];
    for (let i = 0; i < ids.length; i += 800) {
      const chunk = ids.slice(i, i + 800);
      const [rows] = await pool.query(
        `SELECT num_op FROM creditos WHERE num_op IN (${chunk.map(() => '?').join(',')})
           AND (origen IS NULL OR origen <> 'INDEXA')`, chunk);
      colisiones.push(...rows.map(r => r.num_op));
    }

    // muestra (primeros 8 activos)
    const muestra = activos.slice(0, 8).map(d => {
      const impagas = d.cuotas.filter(c => c.estado !== 'PAGADA');
      const primImpaga = impagas[0];
      const ultPagada = [...d.cuotas].reverse().find(c => c.estado === 'PAGADA');
      return {
        num_op: d.num_op, rut: d.rut, nombre: d.nombre_completo,
        plazo: d.plazo, tasa: d.tasa, cuotas: d.cuotas.length,
        pagadas: d.cuotas.filter(c => c.estado === 'PAGADA').length,
        impagas: impagas.length,
        saldo_vigente: ultPagada ? ultPagada.saldo : d.monto_financiado,
        prox_venc_impaga: primImpaga ? primImpaga.venc : null,
        vehiculo: [d.marca, d.modelo, d.anio].filter(Boolean).join(' '),
        tel: d.telefono, comuna: d.comuna,
      };
    });

    res.json({
      success: true,
      data: {
        archivos: { cobranza_ops: byOp.size, desarrollo_cols: des.ncols, desarrollo_malformadas: des.malformadas },
        creditos: { total: data.length, autofacil_activos: activos.length, prepagados: data.length - activos.length, en_cobranza: data.filter(d => d.en_cobranza).length },
        cuotas: { total: cuotasAll.length, por_estado: estadoCuota },
        pagos: { pagadas_total: pagadas.length, pagadas_sin_fecha: pagadasSinFecha, pagadas_activas_sin_fecha: pagadasActSinFecha },
        clientes: { unicos: ruts.size, rut_nulos: rutNulos },
        anomalias: { venc_no_parse: vencNoParse, fpago_no_parse: fpagoNoParse, num_op_colision: colisiones.length, colisiones: colisiones.slice(0, 20) },
        muestra,
      },
      error: null,
    });
  } catch (e) {
    console.error('[migracion-indexa dryRun]', e);
    res.status(400).json({ success: false, data: null, error: e.message || 'Error procesando archivos' });
  }
};

module.exports = { dryRun, _internos: { construir, parseDesarrollo, parseCobranza, fmtRutConDV, pDate, pNum, pTasa } };
