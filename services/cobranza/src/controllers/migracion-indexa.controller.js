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

/* ── Fix one-time (idempotente): la 1a carga dejó los créditos INDEXA con campos
   que el listado exige en NULL (numero_credito/estado_eval/fecha_otorgado/mes) y
   los RUT con puntos (el sistema usa SIN puntos). Esto los hace visibles y
   buscables sin re-aplicar. Tras correr no quedan filas que tocar. ── */
(async () => {
  try {
    const [r1] = await pool.query(
      `UPDATE creditos
          SET numero_credito = COALESCE(NULLIF(numero_credito,''), CAST(num_op AS CHAR)),
              estado_eval    = COALESCE(NULLIF(estado_eval,''), 'OTORGADO'),
              fecha_otorgado = COALESCE(fecha_otorgado, fecha_primera_cuota),
              mes            = COALESCE(mes, DATE_FORMAT(fecha_primera_cuota, '%Y-%m-01'))
        WHERE origen='INDEXA'
          AND (numero_credito IS NULL OR estado_eval IS NULL OR mes IS NULL)`);
    if (r1.affectedRows) console.log(`[migracion-indexa fix] créditos completados: ${r1.affectedRows}`);

    // Monto de la cuota mensual = valor de la cuota 1 del calendario
    const [rc] = await pool.query(
      `UPDATE creditos c SET c.cuota = (
           SELECT cc.valor_cuota FROM cuotas_credito cc
            WHERE cc.id_credito = c.id AND cc.numero_cuota = 1 LIMIT 1)
        WHERE c.origen='INDEXA' AND (c.cuota IS NULL OR c.cuota = 0)`);
    // Fecha de otorgamiento ≈ 1 mes antes de la 1a cuota (solo los nuevos, que quedaron = fecha_primera_cuota)
    const [rf] = await pool.query(
      `UPDATE creditos
          SET fecha_otorgado = DATE_SUB(fecha_primera_cuota, INTERVAL 1 MONTH),
              mes            = DATE_FORMAT(DATE_SUB(fecha_primera_cuota, INTERVAL 1 MONTH), '%Y-%m-01')
        WHERE origen='INDEXA' AND fecha_otorgado = fecha_primera_cuota`);
    // nombre_completo de clientes (lo usa el listado) = nombres + apellidos
    const [rn] = await pool.query(
      `UPDATE clientes SET nombre_completo = TRIM(CONCAT_WS(' ', nombres, apellido_paterno, apellido_materno))
        WHERE (nombre_completo IS NULL OR nombre_completo='') AND COALESCE(nombres,apellido_paterno,apellido_materno) IS NOT NULL`);
    if (rc.affectedRows || rf.affectedRows || rn.affectedRows)
      console.log(`[migracion-indexa fix2] cuota:${rc.affectedRows} fecha:${rf.affectedRows} nombre_completo:${rn.affectedRows}`);

    // RUT clientes: con puntos → sin puntos. Si ya existe el sin-puntos, fusiona
    // (re-apunta créditos al existente y borra el duplicado punteado).
    // 1) Fusiones: los punteados con gemelo sin-puntos → copia contacto faltante al
    //    que se conserva, re-apunta créditos y borra el duplicado.
    const [merges] = await pool.query(`
      SELECT c.id_cliente AS dup, c2.id_cliente AS keep
      FROM clientes c JOIN clientes c2
        ON c2.rut = REPLACE(c.rut,'.','') AND c2.id_cliente <> c.id_cliente
      WHERE c.rut LIKE '%.%'`);
    for (const m of merges) {
      await pool.query(
        `UPDATE clientes k JOIN clientes d ON d.id_cliente=?
           SET k.email=COALESCE(k.email,d.email), k.direccion=COALESCE(k.direccion,d.direccion),
               k.telefono_movil=COALESCE(k.telefono_movil,d.telefono_movil),
               k.nombres=COALESCE(k.nombres,d.nombres),
               k.apellido_paterno=COALESCE(k.apellido_paterno,d.apellido_paterno),
               k.apellido_materno=COALESCE(k.apellido_materno,d.apellido_materno)
         WHERE k.id_cliente=?`, [m.dup, m.keep]).catch(() => {});
      await pool.query('UPDATE creditos SET id_cliente=? WHERE id_cliente=?', [m.keep, m.dup]);
      await pool.query('DELETE FROM clientes WHERE id_cliente=?', [m.dup]);
    }
    // 2) El resto (sin gemelo): renombrar a sin-puntos EN BLOQUE (ya sin colisiones).
    const [r2] = await pool.query("UPDATE clientes SET rut=REPLACE(rut,'.','') WHERE rut LIKE '%.%'");
    if (merges.length || r2.affectedRows) console.log(`[migracion-indexa fix] RUT: ${r2.affectedRows} renombrados, ${merges.length} fusionados`);
  } catch (e) { console.error('[migracion-indexa fix]', e.message); }
})();

/* ── Normalizadores ────────────────────────────────────────────────────── */
// CSV trae RUT con DV pegado ("129382163" → 12.938.216-3)
function fmtRutConDV(rutConDV) {
  let s = String(rutConDV || '').replace(/[^0-9kK]/g, '').toUpperCase();
  if (s.length < 2) return null;
  const dv = s.slice(-1), cuerpo = s.slice(0, -1);
  if (!/^\d+$/.test(cuerpo)) return null;
  return `${cuerpo}-${dv}`;   // formato del sistema: SIN puntos (ej. 11428178-6)
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
// Cobranza → Map(OP → SOLO los ~12 campos del crédito). Acepta el .txt CRUDO de
// INDEXA (latin1, ';', SIN encabezado, por posición) o el xlsx con encabezados.
function parseCobranza(buf) {
  return (buf[0] === 0x50 && buf[1] === 0x4B) ? parseCobranzaXlsx(buf) : parseCobranzaTxt(buf);
}
// Export crudo de INDEXA: 34 columnas FIJAS por posición, sin encabezado.
function parseCobranzaTxt(buf) {
  const lines = Buffer.from(buf).toString('latin1').split(/\r?\n/);
  const byOp = new Map();
  const I = { op: 1, nombre: 2, mail: 3, direccion: 4, comuna: 6, region: 8, telCel: 10, telPar: 9, cuotas: 25, marca: 27, modelo: 28, anio: 29, tipo: 30, nuevo: 31 };
  for (const ln of lines) {
    if (!ln.trim()) continue;
    const c = ln.split(';');
    const g = i => String(c[i] == null ? '' : c[i]).trim();
    const op = g(I.op);
    if (!/^\d+$/.test(op) || byOp.has(op)) continue;   // salta líneas sin OP numérico
    byOp.set(op, {
      nombre: g(I.nombre), mail: g(I.mail), direccion: g(I.direccion),
      comuna: g(I.comuna), region: g(I.region),
      telefono: g(I.telCel) || g(I.telPar),
      cuotas: g(I.cuotas), marca: g(I.marca), modelo: g(I.modelo),
      anio: g(I.anio), tipo: g(I.tipo), nuevo_usado: g(I.nuevo),
    });
  }
  return byOp;
}
// xlsx con encabezados (versión armada a mano). Liviano: header:1 + dense.
function parseCobranzaXlsx(buf) {
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
    // 1) Cliente (upsert por rut) + obtener su id_cliente (FK que usa creditos)
    let idCliente = null;
    if (d.rut) {
      await pool.query(
        `INSERT INTO clientes (rut, tipo_cliente, nombres, apellido_paterno, apellido_materno, nombre_completo, email, direccion, telefono_movil)
         VALUES (?, 'PERSONA', ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           nombres=COALESCE(VALUES(nombres),nombres),
           apellido_paterno=COALESCE(VALUES(apellido_paterno),apellido_paterno),
           apellido_materno=COALESCE(VALUES(apellido_materno),apellido_materno),
           nombre_completo=COALESCE(NULLIF(nombre_completo,''),VALUES(nombre_completo)),
           email=COALESCE(VALUES(email),email),
           direccion=COALESCE(VALUES(direccion),direccion),
           telefono_movil=COALESCE(VALUES(telefono_movil),telefono_movil)`,
        [d.rut, d.nombres, d.ap_paterno, d.ap_materno, d.nombre_completo, d.email, d.direccion, d.telefono]);
      const [[cli]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut=? LIMIT 1', [d.rut]);
      idCliente = cli ? cli.id_cliente : null;
      st.clientes++;
    } else st.sin_rut++;

    // 2) Crédito. Existe (base única) → ENRIQUECER: rellena SOLO lo vacío (COALESCE),
    //    NO toca financiera ni estado_credito ni lo ya cargado. No existe → INSERT nuevo.
    const estadoCartera = d.activo ? null : 'PREPAGADO';
    const cuotaMonto = (d.cuotas[0] && d.cuotas[0].valor) || null;   // cuota mensual = valor de la cuota 1
    let idc = idByOp.get(d.num_op);
    if (idc) {
      await pool.query(
        `UPDATE creditos SET
           id_cliente          = COALESCE(id_cliente, ?),
           numero_credito      = COALESCE(NULLIF(numero_credito,''), ?),
           estado_eval         = COALESCE(NULLIF(estado_eval,''), 'OTORGADO'),
           fecha_otorgado      = COALESCE(fecha_otorgado, ?),
           mes                 = COALESCE(mes, DATE_FORMAT(?, '%Y-%m-01')),
           marca               = COALESCE(NULLIF(marca,''), ?),
           modelo              = COALESCE(NULLIF(modelo,''), ?),
           anio                = COALESCE(anio, ?),
           tipo_vehiculo       = COALESCE(NULLIF(tipo_vehiculo,''), ?),
           fecha_primera_cuota = COALESCE(fecha_primera_cuota, ?),
           plazo               = COALESCE(plazo, ?),
           tascli_real         = COALESCE(tascli_real, ?),
           cuota               = COALESCE(cuota, ?),
           monto_financiado    = COALESCE(monto_financiado, ?),
           estado_cartera      = COALESCE(NULLIF(estado_cartera,''), ?),
           origen              = COALESCE(NULLIF(origen,''), 'INDEXA')
         WHERE id=?`,
        [idCliente, String(d.num_op), d.fecha_primera_cuota, d.fecha_primera_cuota, d.marca, d.modelo, d.anio, d.tipo_vehiculo, d.fecha_primera_cuota, d.plazo, d.tasa, cuotaMonto, d.monto_financiado, estadoCartera, idc]);
      st.creditos_enriquecidos++;
    } else {
      const [r] = await pool.query(
        `INSERT INTO creditos (num_op, numero_credito, origen, financiera, id_cliente, estado, estado_eval, estado_cartera,
           fecha_otorgado, mes, fecha_primera_cuota, plazo, tascli_real, cuota, monto_financiado, marca, modelo, anio, tipo_vehiculo)
         VALUES (?, ?, 'INDEXA', 'AUTOFACIL', ?, 'OTORGADO', 'OTORGADO', ?,
           DATE_SUB(?, INTERVAL 1 MONTH), DATE_FORMAT(DATE_SUB(?, INTERVAL 1 MONTH), '%Y-%m-01'), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.num_op, String(d.num_op), idCliente, estadoCartera, d.fecha_primera_cuota, d.fecha_primera_cuota, d.fecha_primera_cuota, d.plazo, d.tasa, cuotaMonto, d.monto_financiado, d.marca, d.modelo, d.anio, d.tipo_vehiculo]);
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

/* ════════════════════════════════════════════════════════════════════════
   ENRIQUECER — completa la cartera ya migrada con datos del "Informe de
   Créditos Otorgados" (el .xls oficial trae lo que INDEXA no: género, fecha
   de nacimiento, ejecutivo, vendedor, rut del dealer y la FECHA DE CURSE =
   fecha de otorgamiento real). El .xls crudo pesa 38MB y revienta el instance
   (528MB de heap); por eso se ingiere un CSV LIVIANO (';', UTF-8) con solo las
   columnas necesarias, extraído del .xls. Cruce por num_op (la llave fiable:
   el crédito ya está linkeado a su cliente). Idempotente, por lotes.
   Columnas CSV: num_op;sexo;fecha_nacimiento;fecha_curse;nombre;ejecutivo;vendedor;rut_dealer
   ════════════════════════════════════════════════════════════════════════ */
function parseEnriquecimiento(buf) {
  let txt = Buffer.from(buf).toString('utf8');
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);   // BOM
  const lines = txt.split(/\r?\n/);
  let hi = 0; while (hi < lines.length && lines[hi].trim() === '') hi++;
  const ix = {};
  lines[hi].split(';').forEach((h, i) => { const k = normKey(h); if (ix[k] === undefined) ix[k] = i; });
  const iOp = ix['NUM_OP'], iSexo = ix['SEXO'], iFnac = ix['FECHA_NACIMIENTO'],
        iCurse = ix['FECHA_CURSE'], iNom = ix['NOMBRE'], iEje = ix['EJECUTIVO'],
        iVen = ix['VENDEDOR'], iRut = ix['RUT_DEALER'],
        iMarca = ix['MARCA'], iModelo = ix['MODELO'], iAnio = ix['ANIO'],
        iTasa = ix['TASA_PISO'], iRdh = ix['SEGURO_RDH'], iRep = ix['SEGURO_REP_MENOR'],
        iVal = ix['VALOR_VEHICULO'], iPie = ix['PIE'], iSp = ix['SALDO_PRECIO'];
  if (iOp === undefined) throw new Error('El CSV no tiene la columna num_op. Usa el archivo de enriquecimiento generado.');
  const g = (c, j) => (j === undefined || c[j] == null) ? '' : String(c[j]).trim();
  const rows = [];
  for (let i = hi + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = lines[i].split(';');
    const op = parseInt(g(c, iOp), 10);
    if (isNaN(op)) continue;
    rows.push({
      op,
      sexo:       g(c, iSexo) || null,
      fnac:       g(c, iFnac) || null,
      curse:      g(c, iCurse) || null,
      nombre:     g(c, iNom) || null,
      ejecutivo:  g(c, iEje) || null,
      vendedor:   g(c, iVen) || null,
      rut_dealer: g(c, iRut) || null,
      marca:      g(c, iMarca) || null,
      modelo:     g(c, iModelo) || null,
      anio:       g(c, iAnio) || null,
      tasa_piso:  g(c, iTasa) || null,
      seguro_rdh: g(c, iRdh) || null,
      seguro_rep: g(c, iRep) || null,
      valor_veh:  g(c, iVal) || null,
      pie:        g(c, iPie) || null,
      saldo_pre:  g(c, iSp) || null,
    });
  }
  return rows;
}

async function procesarEnriqChunk(slice) {
  const st = { filas: 0, sexo: 0, fnac: 0, curse: 0, ejecutivo: 0, vendedor: 0, rut_dealer: 0, marca: 0, tasa_piso: 0, seguro_rdh: 0, seguro_rep: 0, valor_veh: 0, pie: 0, saldo_pre: 0 };
  for (const d of slice) {
    st.filas++;
    if (d.sexo) st.sexo++; if (d.fnac) st.fnac++; if (d.curse) st.curse++;
    if (d.ejecutivo) st.ejecutivo++; if (d.vendedor) st.vendedor++; if (d.rut_dealer) st.rut_dealer++;
    if (d.marca) st.marca++; if (d.tasa_piso) st.tasa_piso++; if (d.seguro_rdh) st.seguro_rdh++; if (d.seguro_rep) st.seguro_rep++;
    if (d.valor_veh) st.valor_veh++; if (d.pie) st.pie++; if (d.saldo_pre) st.saldo_pre++;
    // 1) Cliente (vía el crédito ya linkeado): rellena SOLO lo vacío (no pisa lo cargado).
    await pool.query(
      `UPDATE creditos c JOIN clientes cl ON cl.id_cliente = c.id_cliente
          SET cl.sexo             = COALESCE(NULLIF(cl.sexo,''), ?),
              cl.fecha_nacimiento = COALESCE(cl.fecha_nacimiento, ?),
              cl.nombre_completo  = COALESCE(NULLIF(cl.nombre_completo,''), ?)
        WHERE c.num_op = ?`,
      [d.sexo, d.fnac, d.nombre, d.op]);
    // 2) Crédito: rellena lo vacío (vehículo, tasa piso, primas de seguro). fecha_otorgado +
    //    mes = FECHA DE CURSE (autoritativa: reemplaza la aproximación de la migración INDEXA).
    //    Para montos de seguro, NULLIF(...,0) trata 0 como vacío (INDEXA los dejó en 0/NULL).
    await pool.query(
      `UPDATE creditos
          SET ejecutivo        = COALESCE(NULLIF(ejecutivo,''), ?),
              vendedor         = COALESCE(NULLIF(vendedor,''), ?),
              rut_dealer       = COALESCE(NULLIF(rut_dealer,''), ?),
              id_dealer        = COALESCE(NULLIF(id_dealer,0), (SELECT d.id_dealer FROM dealers d WHERE UPPER(d.rut)=UPPER(REPLACE(?, '-','')) LIMIT 1)),
              marca            = COALESCE(NULLIF(marca,''), ?),
              modelo           = COALESCE(NULLIF(modelo,''), ?),
              anio             = COALESCE(NULLIF(anio,0), ?),
              tasa_piso        = COALESCE(NULLIF(tasa_piso,0), ?),
              seguro_rdh       = COALESCE(NULLIF(seguro_rdh,0), ?, seguro_rdh),
              seguro_rep_menor = COALESCE(NULLIF(seguro_rep_menor,0), ?, seguro_rep_menor),
              valor_vehiculo   = COALESCE(NULLIF(valor_vehiculo,0), ?),
              pie              = COALESCE(NULLIF(pie,0), ?),
              saldo_precio     = COALESCE(NULLIF(saldo_precio,0), ?),
              fecha_otorgado   = COALESCE(?, fecha_otorgado),
              mes              = CASE WHEN ? IS NOT NULL THEN DATE_FORMAT(?, '%Y-%m-01') ELSE mes END
        WHERE num_op = ?`,
      [d.ejecutivo, d.vendedor, d.rut_dealer, d.rut_dealer, d.marca, d.modelo, d.anio, d.tasa_piso, d.seguro_rdh, d.seguro_rep, d.valor_veh, d.pie, d.saldo_pre, d.curse, d.curse, d.curse, d.op]);
  }
  return st;
}

// POST /enriquecer-init — sube el CSV liviano, lo parsea y deja el job listo
const enriquecerInit = async (req, res) => {
  try {
    gcJobs();
    const f = (req.files && req.files.archivo && req.files.archivo[0]) || req.file;
    if (!f) throw new Error('Falta el archivo CSV de enriquecimiento.');
    const rows = parseEnriquecimiento(f.buffer);
    if (!rows.length) throw new Error('El CSV no tiene filas válidas.');
    // cuántos num_op del CSV calzan con créditos (informativo, una sola pasada)
    const ops = [...new Set(rows.map(r => r.op))];
    let match = 0;
    for (let i = 0; i < ops.length; i += 900) {
      const ch = ops.slice(i, i + 900);
      const [rr] = await pool.query(
        `SELECT COUNT(*) n FROM creditos WHERE num_op IN (${ch.map(() => '?').join(',')})`, ch);
      match += rr[0].n;
    }
    const conSexo = rows.filter(r => r.sexo).length;
    const conFnac = rows.filter(r => r.fnac).length;
    const conCurse = rows.filter(r => r.curse).length;
    const jobId = 'enr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    JOBS.set(jobId, { data: rows, total: rows.length, createdAt: Date.now(), stats: {} });
    res.json({ success: true, data: { jobId, total: rows.length, match, conSexo, conFnac, conCurse }, error: null });
  } catch (e) {
    console.error('[migracion-indexa enriquecerInit]', e);
    res.status(400).json({ success: false, data: null, error: e.message || 'Error procesando el CSV' });
  }
};

// POST /enriquecer-chunk — procesa un tramo del job { jobId, offset, size }
const enriquecerChunk = async (req, res) => {
  try {
    const { jobId } = req.body;
    const off = parseInt(req.body.offset, 10) || 0;
    const size = Math.min(parseInt(req.body.size, 10) || 200, 400);
    const job = JOBS.get(jobId);
    if (!job) return res.status(404).json({ success: false, data: null, error: 'Job expirado. Vuelve a iniciar la carga.' });

    const slice = job.data.slice(off, off + size);
    const st = await procesarEnriqChunk(slice);
    const acc = job.stats;
    for (const k of Object.keys(st)) acc[k] = (acc[k] || 0) + st[k];

    const processed = Math.min(off + slice.length, job.total);
    const done = processed >= job.total;
    if (done) {
      try { auditar({ req, accion: 'ENRIQUECER', modulo: 'cobranza', entidad: 'cartera_indexa', detalle: `Enriquecimiento Créditos Otorgados: ${job.total} filas`, meta: acc }); } catch (_) {}
      JOBS.delete(jobId);
    }
    res.json({ success: true, data: { processed, total: job.total, done, stats: st, acumulado: acc }, error: null });
  } catch (e) {
    console.error('[migracion-indexa enriquecerChunk]', e);
    res.status(400).json({ success: false, data: null, error: 'ENRIQUECER falló: ' + (e.sqlMessage || e.message || 'Error aplicando') });
  }
};

module.exports = { dryRun, aplicarInit, aplicarChunk, enriquecerInit, enriquecerChunk, _internos: { construir, parseDesarrollo, parseCobranza, parseEnriquecimiento, fmtRutConDV, pDate, pNum, pTasa, procesarChunk, procesarEnriqChunk } };
