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
const { auditar } = require('../../../../shared/audit');

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
// Cobranza xlsx → Map(OP → SOLO los ~12 campos que usamos del crédito).
// Liviano a propósito (free tier ~256MB heap): header:1 + dense, no retiene las
// 38k filas completas (34 cols c/u) sino un objeto chico por OP.
function parseCobranza(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', dense: true, cellDates: false, cellNF: false, cellStyles: false, cellFormula: false, cellText: false, bookVBA: false, bookProps: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });  // arrays, no objetos por fila
  const byOp = new Map();
  if (!aoa.length) return byOp;
  const ix = {};
  aoa[0].forEach((h, i) => { const k = normKey(h); if (ix[k] === undefined) ix[k] = i; });
  const get = (row, name) => { const i = ix[normKey(name)]; return i === undefined ? '' : String(row[i] == null ? '' : row[i]).trim(); };
  const opIx = ix['OP'];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    const op = opIx === undefined ? '' : String(row[opIx] == null ? '' : row[opIx]).trim();
    if (!op || byOp.has(op)) continue;
    byOp.set(op, {
      nombre:      get(row, 'NOMBRE'),
      mail:        get(row, 'MAIL'),
      direccion:   get(row, 'DIRECCION APRTICUALR'),
      comuna:      get(row, 'COMUNA'),
      region:      get(row, 'REGION'),
      telefono:    get(row, 'TELEFONO CELUALR') || get(row, 'TELEFONO PARTICULAR'),
      cuotas:      get(row, 'CUOTAS'),
      marca:       get(row, 'MARCA VEHICULO'),
      modelo:      get(row, 'MODELO VEHICULO'),
      anio:        get(row, 'AÑO VEHICULO'),
      tipo:        get(row, 'TIPO VEHICULO'),
      nuevo_usado: get(row, 'NUEVO/USADO'),
    });
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
  let vencNoParse = 0, fpagoNoParse = 0;
  for (const [id, cuotas] of porCredito) {
    cuotas.sort((a, b) => pNum(G(a, 'Numero_Cuota')) - pNum(G(b, 'Numero_Cuota')));
    const estados = new Set(cuotas.map(c => G(c, 'Estado_Cuota')));
    const activo = estados.has('VIGENTE') || estados.has('COBRANZA');
    const first = cuotas[0];
    const cob = byOp.get(id) || {};

    out.push({
      id,
      num_op: parseInt(id, 10),
      rut: fmtRutConDV(G(first, 'Rut_Cliente')),
      nombres: G(first, 'Nombre_RazonSocial_Cliente') || null,
      ap_paterno: G(first, 'PN_Apellido_Paterno_Cliente') || null,
      ap_materno: G(first, 'PN_Apellido_Materno_Cliente') || null,
      nombre_completo: (cob.nombre || '') ||
        [G(first, 'Nombre_RazonSocial_Cliente'), G(first, 'PN_Apellido_Paterno_Cliente'), G(first, 'PN_Apellido_Materno_Cliente')].filter(Boolean).join(' '),
      activo,
      plazo: cob.cuotas ? pNum(cob.cuotas) : cuotas.length,
      tasa: pTasa(G(first, 'Tasa_Interes')),
      fecha_primera_cuota: pDate(G(first, 'Fecha_Vencimiento_Cuota')),
      monto_financiado: pNum(G(first, 'Saldo_Insoluto_Cuota')) + pNum(G(first, 'Amortizacion_Cuota')),
      // vehículo + contacto (xlsx, ya recortado en parseCobranza)
      marca: cob.marca || null,
      modelo: cob.modelo || null,
      anio: cob.anio ? pNum(cob.anio) : null,
      tipo_vehiculo: cob.tipo || null,
      nuevo_usado: cob.nuevo_usado || null,
      email: cob.mail || null,
      direccion: cob.direccion || null,
      telefono: cob.telefono || null,
      comuna: cob.comuna || null,
      region: cob.region || null,
      en_cobranza: byOp.has(id),
      cuotas: cuotas.map(c => {
        const rv = G(c, 'Fecha_Vencimiento_Cuota'), rp = G(c, 'Fecha_Pago');
        const venc = pDate(rv), fpago = pDate(rp);
        if (rv && !venc) vencNoParse++;
        if (rp && !fpago) fpagoNoParse++;
        return {
          numero: pNum(G(c, 'Numero_Cuota')),
          venc,
          interes: pNum(G(c, 'Interes_Cuota')),
          amort: pNum(G(c, 'Amortizacion_Cuota')),
          valor: pNum(G(c, 'Valor_Cuota')),
          saldo: pNum(G(c, 'Saldo_Insoluto_Cuota')),
          estado: G(c, 'Estado_Cuota') || null,
          fpago,
          dias: pNum(G(c, 'Días desfase')),
        };
      }),
    });
  }
  return { rows: out, meta: { vencNoParse, fpagoNoParse } };
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
    const { rows: data, meta } = construir(byOp, des);

    const cuotasAll = data.flatMap(d => d.cuotas);
    const estadoCuota = {};
    for (const c of cuotasAll) estadoCuota[c.estado || '∅'] = (estadoCuota[c.estado || '∅'] || 0) + 1;

    const activos = data.filter(d => d.activo);
    const pagadas = cuotasAll.filter(c => c.estado === 'PAGADA');
    const pagadasSinFecha = pagadas.filter(c => !c.fpago).length;
    const pagadasActSinFecha = activos.flatMap(d => d.cuotas).filter(c => c.estado === 'PAGADA' && !c.fpago).length;

    // anomalías de parseo (contadas durante construir, sin retener los crudos)
    const vencNoParse = meta.vencNoParse;
    const fpagoNoParse = meta.fpagoNoParse;
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
    // ¿algún choque cae en la cartera ACTIVA (lo urgente a cobrar)?
    const colSet = new Set(colisiones.map(String));
    const colActivas = data.filter(d => d.activo && colSet.has(String(d.num_op))).map(d => d.num_op);

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
        anomalias: { venc_no_parse: vencNoParse, fpago_no_parse: fpagoNoParse, num_op_colision: colisiones.length, num_op_colision_activos: colActivas.length, colisiones: colisiones.slice(0, 20), colisiones_activas: colActivas.slice(0, 20) },
        muestra,
      },
      error: null,
    });
  } catch (e) {
    console.error('[migracion-indexa dryRun]', e);
    res.status(400).json({ success: false, data: null, error: e.message || 'Error procesando archivos' });
  }
};

/* ════════════════════════════════════════════════════════════════════════
   APLICAR — escritura idempotente, por lotes (job en memoria para no re-subir
   los archivos en cada chunk). Re-ejecutable: vuelve a correr y solo actualiza.
   ════════════════════════════════════════════════════════════════════════ */
const JOBS = new Map(); // jobId -> { data, total, createdAt, stats }
function gcJobs() { const now = Date.now(); for (const [k, v] of JOBS) if (now - v.createdAt > 30 * 60 * 1000) JOBS.delete(k); }

async function procesarChunk(slice) {
  const st = { clientes: 0, creditos_new: 0, creditos_enriquecidos: 0, cuotas: 0, pagos: 0, sin_rut: 0 };
  // Match por num_op SIN importar origen: muchos ya existen (cargados desde la base
  // única ene-2025+, incompletos y con financiera puesta a mano). Esos se ENRIQUECEN
  // (se rellena solo lo que falta, preservando financiera y lo ya cargado), no se duplican.
  const ops = slice.map(d => d.num_op).filter(Boolean);
  const idByOp = new Map();
  if (ops.length) {
    const [ex] = await pool.query(
      `SELECT id, num_op FROM creditos WHERE num_op IN (${ops.map(() => '?').join(',')}) ORDER BY id`, ops);
    ex.forEach(r => idByOp.set(r.num_op, r.id));
  }

  for (const d of slice) {
    // 1) Cliente (upsert por rut; nunca pisa con null)
    if (d.rut) {
      await pool.query(
        `INSERT INTO clientes (rut, tipo_cliente, nombres, apellido_paterno, apellido_materno, email, direccion, telefono_movil)
         VALUES (?, 'PERSONA', ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           nombres=COALESCE(VALUES(nombres),nombres),
           apellido_paterno=COALESCE(VALUES(apellido_paterno),apellido_paterno),
           apellido_materno=COALESCE(VALUES(apellido_materno),apellido_materno),
           email=COALESCE(VALUES(email),email),
           direccion=COALESCE(VALUES(direccion),direccion),
           telefono_movil=COALESCE(VALUES(telefono_movil),telefono_movil)`,
        [d.rut, d.nombres, d.ap_paterno, d.ap_materno, d.email, d.direccion, d.telefono]);
      st.clientes++;
    } else st.sin_rut++;

    // 2) Crédito. Existe (base única) → ENRIQUECER: rellena SOLO lo vacío (COALESCE),
    //    NO toca financiera ni estado_credito ni lo ya cargado. No existe → INSERT nuevo.
    const estadoCartera = d.activo ? null : 'PREPAGADO';
    let idc = idByOp.get(d.num_op);
    if (idc) {
      await pool.query(
        `UPDATE creditos SET
           rut_cliente         = COALESCE(NULLIF(rut_cliente,''), ?),
           nombre_cliente      = COALESCE(NULLIF(nombre_cliente,''), ?),
           marca               = COALESCE(NULLIF(marca,''), ?),
           modelo              = COALESCE(NULLIF(modelo,''), ?),
           anio_vehiculo       = COALESCE(anio_vehiculo, ?),
           fecha_primera_cuota = COALESCE(fecha_primera_cuota, ?),
           plazo               = COALESCE(plazo, ?),
           tascli_real         = COALESCE(tascli_real, ?),
           monto_financiado    = COALESCE(monto_financiado, ?),
           estado_cartera      = COALESCE(NULLIF(estado_cartera,''), ?),
           origen              = COALESCE(NULLIF(origen,''), 'INDEXA')
         WHERE id=?`,
        [d.rut, d.nombre_completo, d.marca, d.modelo, d.anio, d.fecha_primera_cuota, d.plazo, d.tasa, d.monto_financiado, estadoCartera, idc]);
      st.creditos_enriquecidos++;
    } else {
      const [r] = await pool.query(
        `INSERT INTO creditos (num_op, origen, financiera, rut_cliente, nombre_cliente, estado_credito, estado_cartera,
           fecha_primera_cuota, plazo, tascli_real, monto_financiado, marca, modelo, anio_vehiculo)
         VALUES (?, 'INDEXA', 'AUTOFACIL', ?, ?, 'OTORGADO', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.num_op, d.rut, d.nombre_completo, estadoCartera, d.fecha_primera_cuota, d.plazo, d.tasa, d.monto_financiado, d.marca, d.modelo, d.anio]);
      idc = r.insertId; st.creditos_new++;
    }

    // 3) Calendario (cuotas_credito) — bulk upsert por (id_credito, numero_cuota)
    if (d.cuotas.length) {
      const ph = [], v = [];
      for (const c of d.cuotas) {
        ph.push('(?,?,?,?,?,?,?,?,?,?,?,?,?)');
        v.push(idc, d.num_op, c.numero, c.venc, c.interes, c.amort, c.valor, c.saldo, c.estado, c.fpago, d.tasa, c.dias, 'INDEXA');
      }
      await pool.query(
        `INSERT INTO cuotas_credito
           (id_credito,num_op,numero_cuota,fecha_vencimiento,interes,amortizacion,valor_cuota,saldo_insoluto,estado_cuota,fecha_pago,tasa,dias_desfase,origen)
         VALUES ${ph.join(',')}
         ON DUPLICATE KEY UPDATE
           fecha_vencimiento=VALUES(fecha_vencimiento), interes=VALUES(interes), amortizacion=VALUES(amortizacion),
           valor_cuota=VALUES(valor_cuota), saldo_insoluto=VALUES(saldo_insoluto), estado_cuota=VALUES(estado_cuota),
           fecha_pago=VALUES(fecha_pago), tasa=VALUES(tasa), dias_desfase=VALUES(dias_desfase)`, v);
      st.cuotas += d.cuotas.length;
    }

    // 4) Pagos (cuotas PAGADA) — idempotente: borra los de esta migración y reinserta
    await pool.query(`DELETE FROM pagos_credito WHERE id_credito=? AND origen_fondos='MIGRACION INDEXA'`, [idc]);
    const pagadas = d.cuotas.filter(c => c.estado === 'PAGADA');
    if (pagadas.length) {
      const ph = [], v = [];
      for (const c of pagadas) {
        ph.push("(?,?,?,?,?,?,'PAGADO','Migración INDEXA','MIGRACION INDEXA')");
        v.push(idc, c.numero, c.venc, c.valor, c.valor, c.fpago);
      }
      await pool.query(
        `INSERT INTO pagos_credito
           (id_credito,numero_cuota,fecha_vencimiento,monto_cuota,total_pagado,fecha_pago,estado_pago,registrado_por,origen_fondos)
         VALUES ${ph.join(',')}`, v);
      st.pagos += pagadas.length;
    }
  }
  return st;
}

// POST /aplicar-init — sube los 2 archivos, parsea y deja el job listo en memoria
const aplicarInit = async (req, res) => {
  try {
    gcJobs();
    const { byOp, des } = leerArchivos(req);
    const { rows: data } = construir(byOp, des);
    const jobId = 'idx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    JOBS.set(jobId, { data, total: data.length, createdAt: Date.now(), stats: {} });
    res.json({ success: true, data: { jobId, total: data.length }, error: null });
  } catch (e) {
    console.error('[migracion-indexa aplicarInit]', e);
    res.status(400).json({ success: false, data: null, error: e.message || 'Error procesando archivos' });
  }
};

// POST /aplicar-chunk — procesa un tramo del job { jobId, offset, size }
const aplicarChunk = async (req, res) => {
  try {
    const { jobId } = req.body;
    const off = parseInt(req.body.offset, 10) || 0;
    const size = Math.min(parseInt(req.body.size, 10) || 120, 300);
    const job = JOBS.get(jobId);
    if (!job) return res.status(404).json({ success: false, data: null, error: 'Job expirado. Vuelve a iniciar la carga.' });

    const slice = job.data.slice(off, off + size);
    const st = await procesarChunk(slice);
    // acumular
    const acc = job.stats;
    for (const k of Object.keys(st)) acc[k] = (acc[k] || 0) + st[k];

    const processed = Math.min(off + slice.length, job.total);
    const done = processed >= job.total;
    if (done) {
      try { auditar({ req, accion: 'MIGRAR', modulo: 'cobranza', entidad: 'cartera_indexa', detalle: `Carga INDEXA aplicada: ${job.total} créditos`, meta: acc }); } catch (_) {}
      JOBS.delete(jobId);
    }
    res.json({ success: true, data: { processed, total: job.total, done, stats: st, acumulado: acc }, error: null });
  } catch (e) {
    console.error('[migracion-indexa aplicarChunk]', e);
    // 400 (no 500) a propósito: es una herramienta de admin y conviene VER el detalle
    // real (el middleware oculta el cuerpo de los 500). Surfacea la causa exacta.
    res.status(400).json({ success: false, data: null, error: 'APLICAR falló: ' + (e.sqlMessage || e.message || 'Error aplicando') });
  }
};

module.exports = { dryRun, aplicarInit, aplicarChunk, _internos: { construir, parseDesarrollo, parseCobranza, fmtRutConDV, pDate, pNum, pTasa, procesarChunk } };
