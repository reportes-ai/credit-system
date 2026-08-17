'use strict';
/* ───────────────────────────────────────────────────────────────────
   Sincronizador del RCV (Registro de Compras del SII) vía SimpleAPI.
   POST https://servicios.simpleapi.cl/api/rcv/compras/{mes}/{año}
     - Auth: Basic base64("api:APIKEY")
     - multipart: campo "input" = JSON { RutUsuario, PasswordSII, RutEmpresa,
       Ambiente, RutCertificado?, Password? } + archivo "certificado" (.pfx) opcional.
   Plan gratuito: 30 consultas/mes → se sincroniza CADA 2 DÍAS el mes en curso
   (≈15 consultas) y, hasta el día 8, también el mes anterior (≈4 más, para F29).

   Env (Render):
     SIMPLEAPI_KEY     apikey de simpleapi.cl (obligatoria; sin ella no hace nada)
     SII_RUT_EMPRESA   RUT empresa con guión (ej: 77123456-7)
     SII_RUT_USUARIO   RUT del usuario autorizado (default: el de la empresa)
     SII_CLAVE         Clave Tributaria del SII
     SII_CERT_B64      (opcional) certificado digital .pfx en base64
     SII_CERT_PASS     (opcional) clave del certificado
     SII_RUT_CERT      (opcional) RUT del TITULAR del certificado, si no es el usuario
   El RCV es la FUENTE OFICIAL del libro de compras: ctb_rcv_compras es espejo
   read-only del SII (se reemplaza el mes completo en cada sync); el auxiliar
   ctb_compras_aux sigue siendo el libro operativo — el panel compara ambos.
   ─────────────────────────────────────────────────────────────────── */
const { programar } = require('../../../shared/scheduler.js');
const pool = require('../../../shared/config/database');

const BASE = 'https://servicios.simpleapi.cl/api/';
const cfg = () => ({
  key: process.env.SIMPLEAPI_KEY || '',
  rutEmpresa: process.env.SII_RUT_EMPRESA || '',
  rutUsuario: process.env.SII_RUT_USUARIO || process.env.SII_RUT_EMPRESA || '',
  clave: process.env.SII_CLAVE || '',
  certB64: process.env.SII_CERT_B64 || '',
  certPass: process.env.SII_CERT_PASS || '',
  /* El titular del certificado NO siempre es el usuario que entra al SII: el
     certificado puede ser de un tercero (contador, socio) autorizado a representar
     a la empresa. Antes se asumía que eran el mismo y eso da "RUT Certificado no
     válido". Si no se informa, se mantiene el comportamiento anterior. */
  rutCert: process.env.SII_RUT_CERT || process.env.SII_RUT_USUARIO || process.env.SII_RUT_EMPRESA || '',
});
const configurado = () => { const c = cfg(); return !!(c.key && c.rutEmpresa && c.clave); };

/* Diagnóstico del certificado, SIN exponer ningún secreto: solo dice si cada dato
   está puesto y si el .pfx se abre con la clave. Existe porque SimpleAPI responde
   "The specified network password is not correct" tanto si la clave está mala como
   si el base64 llegó cortado, y desde afuera no se distingue una cosa de la otra.
   El propio Node puede abrir un PKCS#12: si él tampoco puede, es la clave. */
function diagnosticoCert() {
  const c = cfg();
  const d = {
    apikey: !!c.key, rut_empresa: !!c.rutEmpresa, rut_usuario: !!c.rutUsuario,
    clave_sii: !!c.clave, cert_cargado: !!c.certB64, cert_pass: !!c.certPass,
    // Los RUT no son secretos y sin verlos no se puede diagnosticar un cruce mal puesto.
    rut_empresa_val: c.rutEmpresa || null, rut_usuario_val: c.rutUsuario || null, rut_cert_val: c.rutCert || null,
    cert_bytes: 0, cert_es_pfx: null, cert_abre: null, base64_con_espacios: false, mensaje: '',
  };
  if (!c.certB64) { d.mensaje = 'No hay certificado cargado (SII_CERT_B64 vacía).'; return d; }
  d.base64_con_espacios = /\s/.test(c.certB64);
  let buf;
  try { buf = Buffer.from(c.certB64, 'base64'); } catch (_) { d.mensaje = 'SII_CERT_B64 no es base64 válido.'; return d; }
  d.cert_bytes = buf.length;
  // Un .pfx (PKCS#12) es DER y empieza con SEQUENCE largo: 0x30 0x82
  d.cert_es_pfx = buf.length > 300 && buf[0] === 0x30 && buf[1] === 0x82;
  if (!d.cert_es_pfx) {
    d.mensaje = d.cert_bytes < 300
      ? `El certificado quedó en ${d.cert_bytes} bytes: el base64 llegó cortado. Pégalo completo, en UNA sola línea.`
      : 'Los bytes no corresponden a un archivo .pfx — revisa que el base64 sea del certificado y no de otro archivo.';
    return d;
  }
  try {
    require('tls').createSecureContext({ pfx: buf, passphrase: c.certPass || '' });
    d.cert_abre = true;
    d.mensaje = 'El certificado se abre correctamente con la clave configurada.';
  } catch (e) {
    d.cert_abre = false;
    d.mensaje = /mac verify|password|decrypt/i.test(e.message || '')
      ? 'El archivo .pfx está bien, pero SII_CERT_PASS no es su clave.'
      : 'No se pudo abrir el certificado: ' + String(e.message || '').slice(0, 120);
  }
  return d;
}

require('../../../shared/migrate').enFila('ctb-rcv-sii', async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ctb_rcv_compras (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mes CHAR(7) NOT NULL,                          -- YYYY-MM (período tributario)
      tipo_dte INT NOT NULL,                         -- 33, 34, 46, 56, 61…
      tipo_dte_nombre VARCHAR(80) NULL,
      tipo_compra VARCHAR(40) NULL,
      rut_proveedor VARCHAR(20) NOT NULL,
      razon_social VARCHAR(200) NULL,
      folio BIGINT NOT NULL,
      fecha_emision DATE NULL,
      fecha_recepcion DATE NULL,
      monto_exento BIGINT NULL,
      monto_neto BIGINT NULL,
      iva_recuperable BIGINT NULL,
      iva_no_recuperable BIGINT NULL,
      monto_total BIGINT NULL,
      estado_acuse VARCHAR(30) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_doc (mes, tipo_dte, rut_proveedor, folio),
      INDEX idx_mes (mes)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ctb_rcv_sync_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mes CHAR(7) NOT NULL,
      resultado VARCHAR(10) NOT NULL,                -- OK | ERROR
      registros INT NULL, iva_total BIGINT NULL,
      detalle VARCHAR(500) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_mes (mes), INDEX idx_fecha (created_at)
    )`);
  console.log('✓ contabilidad: tablas RCV SII listas');
});

// lector case-insensitive (la API puede responder PascalCase o camelCase)
const g = (o, k) => { if (!o) return undefined; const lk = k.toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lk) return o[key]; return undefined; };
const fechaYmd = v => { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

async function consultarComprasSII(mes, anio) {
  const c = cfg();
  /* Con certificado se mandan RutCertificado + Password (el titular del certificado
     puede no ser el usuario que entra al SII). SIN certificado esos dos campos se
     OMITEN del todo: mandarlos vacíos hace que la API responda "Password de
     certificado no informado" en vez de intentar solo con la Clave Tributaria. */
  const input = { RutUsuario: c.rutUsuario, PasswordSII: c.clave, RutEmpresa: c.rutEmpresa, Ambiente: 1 };
  if (c.certB64 || c.certPass) { input.RutCertificado = c.rutCert; input.Password = c.certPass || ''; }
  const form = new FormData();
  if (c.certB64)
    form.append('certificado', new Blob([Buffer.from(c.certB64, 'base64')], { type: 'application/x-pkcs12' }), 'certificado.pfx');
  form.append('input', JSON.stringify(input));
  const res = await fetch(`${BASE}rcv/compras/${mes}/${anio}`, {
    method: 'POST', body: form,
    headers: { Authorization: 'Basic ' + Buffer.from('api:' + c.key).toString('base64') },
    signal: AbortSignal.timeout(180000),
  });
  const texto = await res.text();
  if (!res.ok) { const err = new Error(`SimpleAPI ${res.status}: ${texto.slice(0, 300)}`); err.status = res.status; throw err; }
  const j = JSON.parse(texto);
  const compras = g(j, 'compras') || j;
  return g(compras, 'detalleCompras') || [];
}

/* SimpleAPI admite 1 llamada por segundo: si dos consultas coinciden (el motor
   automático + el botón manual), responde 429. Se reintenta con espera — el 429
   no consume cuota del plan, solo pide calma. */
const pausa = ms => new Promise(r => setTimeout(r, ms));
async function consultarConCalma(mes, anio) {
  for (let intento = 1; ; intento++) {
    try { return await consultarComprasSII(mes, anio); }
    catch (e) {
      if (e.status !== 429 || intento >= 4) throw e;
      await pausa(1500 * intento);
    }
  }
}

/* Sincroniza UN período (reemplaza el mes completo: el SII es la fuente). */
async function sincronizarMes(anio, mes) {
  const per = `${anio}-${String(mes).padStart(2, '0')}`;
  try {
    const det = await consultarConCalma(mes, anio);
    await pool.query('DELETE FROM ctb_rcv_compras WHERE mes=?', [per]);
    let iva = 0;
    for (const d of det) {
      const ivaRec = Number(g(d, 'montoIvaRecuperable') || 0);
      iva += ivaRec;
      await pool.query(
        `INSERT IGNORE INTO ctb_rcv_compras
           (mes, tipo_dte, tipo_dte_nombre, tipo_compra, rut_proveedor, razon_social, folio,
            fecha_emision, fecha_recepcion, monto_exento, monto_neto, iva_recuperable,
            iva_no_recuperable, monto_total, estado_acuse)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [per, Number(g(d, 'tipoDTE') || 0), g(d, 'tipoDTEString') || null, g(d, 'tipoCompra') || null,
         String(g(d, 'rutProveedor') || ''), g(d, 'razonSocial') || null, Number(g(d, 'folio') || 0),
         fechaYmd(g(d, 'fechaEmision')), fechaYmd(g(d, 'fechaRecepcion')),
         Number(g(d, 'montoExento') || 0), Number(g(d, 'montoNeto') || 0), ivaRec,
         Number(g(d, 'montoIvaNoRecuperable') || 0), Number(g(d, 'montoTotal') || 0),
         g(d, 'acuseRecibo') || null]);
    }
    await pool.query('INSERT INTO ctb_rcv_sync_log (mes, resultado, registros, iva_total) VALUES (?,?,?,?)',
      [per, 'OK', det.length, iva]);
    console.log(`[rcv] ${per}: ${det.length} docs, IVA recuperable $${iva.toLocaleString('es-CL')}`);
    return { ok: true, mes: per, registros: det.length, iva_total: iva };
  } catch (e) {
    await pool.query('INSERT INTO ctb_rcv_sync_log (mes, resultado, detalle) VALUES (?,?,?)',
      [per, 'ERROR', String(e.message).slice(0, 500)]).catch(() => {});
    console.error('[rcv]', per, e.message);
    return { ok: false, mes: per, motivo: e.message };
  }
}

/* Rutina automática: mes en curso; hasta el día 8, también el anterior (F29). */
async function sincronizar() {
  if (!configurado()) return { ok: false, motivo: 'Faltan SIMPLEAPI_KEY / SII_RUT_EMPRESA / SII_CLAVE en el entorno.' };
  const hoy = new Date();
  const out = [await sincronizarMes(hoy.getFullYear(), hoy.getMonth() + 1)];
  if (hoy.getDate() <= 8) {
    await pausa(1200);   // 1 llamada por segundo (límite SimpleAPI)
    const prev = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 15);
    out.push(await sincronizarMes(prev.getFullYear(), prev.getMonth() + 1));
  }
  return { ok: out.every(r => r.ok), meses: out };
}

/* Cron: cada 12h revisa si el último OK tiene 2+ días (presupuesto: 30 consultas/mes gratis).

   FRENO ANTE FALLAS (agosto 2026): el plan gratis da 30 consultas al mes y en agosto
   se hicieron 812. No fueron sincronizaciones: fue este mismo tick reintentando con
   una configuración que no podía funcionar (la clave del certificado estaba mala),
   una vez a los 45 s de CADA arranque — y con varios deploys al día eso son decenas
   de llamadas diarias que nadie pidió. Una integración rota no debe consumir la
   cuota que necesita cuando la arreglen.
   Por eso: si el último intento falló, se espera cada vez más (30 min, 1 h, 2 h… hasta
   12 h) según cuántas fallas seguidas van. Un arranque no reintenta si la falla es
   reciente. Cuando la configuración se arregla, el primer OK borra el castigo. */
const ESPERA_MIN = [30, 60, 120, 240, 480, 720];   // minutos, según fallas consecutivas

async function frenado() {
  const [[u]] = await pool.query("SELECT MAX(created_at) t FROM ctb_rcv_sync_log WHERE resultado='OK'");
  const [fallas] = await pool.query(
    `SELECT created_at FROM ctb_rcv_sync_log
      WHERE resultado='ERROR' AND created_at > COALESCE(?, '2000-01-01')
      ORDER BY id DESC LIMIT 6`, [u?.t || null]);
  if (!fallas.length) return false;
  const espera = ESPERA_MIN[Math.min(fallas.length, ESPERA_MIN.length) - 1] * 60000;
  const desde = Date.now() - new Date(fallas[0].created_at).getTime();
  if (desde < espera) {
    console.log(`[rcv] en pausa: ${fallas.length} fallas seguidas, próximo intento en ${Math.ceil((espera - desde) / 60000)} min`);
    return true;
  }
  return false;
}

async function tick() {
  try {
    if (!configurado()) return;
    const [[u]] = await pool.query("SELECT MAX(created_at) t FROM ctb_rcv_sync_log WHERE resultado='OK'");
    if (u?.t && Date.now() - new Date(u.t).getTime() < 2 * 86400000 - 3600000) return;
    if (await frenado()) return;
    await sincronizar();
  } catch (e) { console.error('[rcv tick]', e.message); }
}
setTimeout(tick, 45000);                       // al arrancar (tras migraciones)
programar('rcv-sii', tick, 12 * 60 * 60 * 1000);        // cada 12h, corre solo si tocan los 2 días

module.exports = { sincronizar, sincronizarMes, configurado, diagnosticoCert };
