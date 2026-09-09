'use strict';
/* ───────────────────────────────────────────────────────────────────
   Aviso de preaprobación al equipo comercial — MOTOR ÚNICO.

   Cuando un dealer genera una preaprobación (Portal del Dealer, y cualquier
   canal que la registre en portal_preaprobaciones), se avisa por correo al
   EJECUTIVO asignado a ese dealer y al JEFE COMERCIAL de ese ejecutivo. Quién
   atiende a cada dealer vive en la base Zona - Parque - Dealer
   (zona_parque_dealer: jefe, ejecutivo1, ejecutivo2, por rut_dealer); los
   correos salen de la ficha de Usuarios (fuente única — no se copian).

   Todo paramétrico en Políticas de Preaprobación (preaprobacion_parametros):
   aviso_ejecutivo_activo, aviso_ejecutivo_resultados, aviso_ejecutivo_cc,
   aviso_ejecutivo_asunto, aviso_ejecutivo_msg. Placeholders: {dealer} {codigo}
   {fecha} {hora} {resultado}.

   Nombre del cliente: clientes.nombre_completo si es cliente; si no, el
   titular que trae el propio informe DealerNet (Perfil Comercial / Boletín),
   igual que el repositorio DealerNet. Sin dato → "(sin nombre en informes)".
   ─────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const fmtCLP = n => '$' + Math.round(+n || 0).toLocaleString('es-CL');
const soloRut = r => String(r || '').replace(/[^0-9kK]/g, '').toUpperCase();
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/* Nombre del cliente por RUT: clientes → informe DealerNet. */
async function nombreCliente(rut) {
  const rl = soloRut(rut);
  if (rl.length < 2) return null;
  try {
    const [[c]] = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(nombre_completo),''),
              TRIM(CONCAT(IFNULL(nombres,''),' ',IFNULL(apellido_paterno,''),' ',IFNULL(apellido_materno,'')))) AS nombre
         FROM clientes WHERE REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')=? LIMIT 1`, [rl]);
    if (c && c.nombre && c.nombre.trim()) return c.nombre.trim();
  } catch (_) {}
  try {
    const [[i]] = await pool.query(
      `SELECT COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(contenido,'$."DLNTPERCOMDLNTWS"."ROOT"."D"."@_nombre"')),''),
                       NULLIF(JSON_UNQUOTE(JSON_EXTRACT(contenido,'$."REGCIVRNDPAHTTP"."d"."@_nombre"')),'')) AS nombre
         FROM dealernet_informes WHERE rut=? AND retcode='0' ORDER BY created_at DESC LIMIT 20`, [rl.slice(0, -1)]);
    if (i && i.nombre) return String(i.nombre).trim();
  } catch (_) {}
  return null;
}

/* Destinatarios: ejecutivos y jefe del dealer según Zona - Parque - Dealer.
   Devuelve { to:[emails], nombres:[...], origen:'ZONA'|'JEFES' } */
async function destinatariosDealer(rutDealer) {
  const rd = soloRut(rutDealer);
  const nombres = new Set();
  if (rd) {
    const [filas] = await pool.query(
      `SELECT jefe, ejecutivo1, ejecutivo2 FROM zona_parque_dealer
        WHERE REPLACE(REPLACE(REPLACE(IFNULL(rut_dealer,''),'.',''),'-',''),' ','')=?`, [rd]);
    for (const f of filas) for (const n of [f.ejecutivo1, f.ejecutivo2, f.jefe]) if (n && norm(n)) nombres.add(norm(n));
  }
  const [us] = await pool.query(
    `SELECT u.id_usuario, u.nombre, u.apellido, u.email, u.id_supervisor, p.nombre AS perfil
       FROM usuarios u LEFT JOIN perfiles p ON p.id_perfil=u.id_perfil
      WHERE u.estado='activo' AND u.email IS NOT NULL AND u.email<>''`);
  const porNombre = new Map();
  for (const u of us) {
    const full = norm(u.nombre + ' ' + (u.apellido || ''));
    const corto = norm(String(u.nombre || '').split(/\s+/)[0] + ' ' + (u.apellido || ''));
    if (!porNombre.has(full)) porNombre.set(full, u);
    if (!porNombre.has(corto)) porNombre.set(corto, u);
  }
  const porId = new Map(us.map(u => [Number(u.id_usuario), u]));
  const dest = new Map();
  for (const n of nombres) { const u = porNombre.get(n); if (u) dest.set(Number(u.id_usuario), u); }
  // El jefe comercial del ejecutivo (id_supervisor de la ficha, solo si es Jefe Comercial) también recibe
  for (const u of [...dest.values()]) { const j = porId.get(Number(u.id_supervisor)); if (j && j.perfil === 'Jefe Comercial') dest.set(Number(j.id_usuario), j); }
  if (dest.size) return { to: [...dest.values()].map(u => u.email), nombres: [...dest.values()].map(u => u.nombre + ' ' + (u.apellido || '')), origen: 'ZONA' };
  // Sin asignación en la base → todos los Jefes Comerciales (nadie se queda sin aviso)
  const [jefes] = await pool.query(
    `SELECT u.email, u.nombre, u.apellido FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
      WHERE u.estado='activo' AND p.nombre='Jefe Comercial' AND u.email IS NOT NULL`);
  return { to: jefes.map(j => j.email), nombres: jefes.map(j => j.nombre + ' ' + (j.apellido || '')), origen: 'JEFES' };
}

const rellenar = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));

/* Punto de entrada: pre = fila de portal_preaprobaciones (id, codigo, dealer_nombre,
   rut_dealer, rut_cliente, precio, pie, renta, fuente_renta, resultado, opciones, created_at). */
async function avisarEjecutivo(pre) {
  const { getPoliticas } = require('./preaprobacion-politicas');
  const POL = await getPoliticas();
  if (String(POL.aviso_ejecutivo_activo).toUpperCase() !== 'SI') return { ok: false, motivo: 'desactivado' };
  const permitidos = String(POL.aviso_ejecutivo_resultados || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (permitidos.length && !permitidos.includes(String(pre.resultado).toUpperCase())) return { ok: false, motivo: 'resultado excluido' };

  const [nombre, dest] = await Promise.all([nombreCliente(pre.rut_cliente), destinatariosDealer(pre.rut_dealer)]);
  if (!dest.to.length) return { ok: false, motivo: 'sin destinatarios' };

  const cuando = pre.created_at ? new Date(pre.created_at) : new Date();
  const fecha = cuando.toLocaleDateString('es-CL', { timeZone: 'America/Santiago', day: 'numeric', month: 'numeric', year: 'numeric' });
  const hora = cuando.toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' });
  const dealer = pre.dealer_nombre || pre.rut_dealer || 'Dealer';
  const vars = { dealer, codigo: pre.codigo || ('#' + pre.id), fecha, hora, resultado: pre.resultado };
  const saldo = (+pre.precio || 0) - (+pre.pie || 0);
  let ops = []; try { ops = typeof pre.opciones === 'string' ? JSON.parse(pre.opciones || '[]') : (pre.opciones || []); } catch (_) {}

  const { enviarCorreo, envolverHTML } = require('./mailer');
  const html = envolverHTML(`
    <h2 style="margin:0 0 8px">Preaprobación ${esc(vars.codigo)} — ${esc(dealer)}</h2>
    <p>${esc(rellenar(POL.aviso_ejecutivo_msg, vars))}</p>
    <table cellpadding="6" style="border-collapse:collapse;font-size:14px">
      <tr><td><b>Dealer</b></td><td>${esc(dealer)}</td></tr>
      <tr><td><b>N° preaprobación</b></td><td>${esc(vars.codigo)}</td></tr>
      <tr><td><b>Fecha y hora</b></td><td>${esc(fecha)} a las ${esc(hora)} hrs</td></tr>
      <tr><td><b>Cliente</b></td><td>${esc(nombre || '(sin nombre en informes)')}</td></tr>
      <tr><td><b>RUT</b></td><td>${esc(pre.rut_cliente)}</td></tr>
      <tr><td><b>Valor del vehículo</b></td><td>${fmtCLP(pre.precio)}${pre.anio ? ' (año ' + pre.anio + ')' : ''}</td></tr>
      <tr><td><b>Pie</b></td><td>${fmtCLP(pre.pie)}</td></tr>
      <tr><td><b>Saldo precio</b></td><td>${fmtCLP(saldo)}</td></tr>
      <tr><td><b>Renta informada</b></td><td>${pre.renta ? fmtCLP(pre.renta) + (pre.fuente_renta === 'INTERNA' ? ' (antecedentes internos)' : ' (declarada por el dealer)') : '—'}</td></tr>
      <tr><td><b>Resultado</b></td><td><b>${esc(pre.resultado)}</b></td></tr>
      ${ops.length ? '<tr><td><b>Cuotas ofrecidas</b></td><td>' + ops.map(o => o.plazo + ' cuotas de ' + fmtCLP(o.cuota)).join(' · ') + '</td></tr>' : ''}
    </table>
    <p style="margin-top:12px"><b>Contacta al dealer</b> para ver si requiere asistencia o si generamos el crédito para el cliente.</p>
    <p style="font-size:12px;color:#64748b">Ficha completa en <a href="https://afbs.autofacilchile.cl/preaprobaciones/">Repositorio de Preaprobaciones</a>. Destinatarios según ${dest.origen === 'ZONA' ? 'la base Zona - Parque - Dealer' : 'perfil Jefe Comercial (dealer sin asignación en Zona - Parque - Dealer)'}.</p>`);
  const cc = String(POL.aviso_ejecutivo_cc || '').split(/[,;]/).map(s => s.trim()).filter(s => /@/.test(s));
  const r = await enviarCorreo({ to: dest.to.join(','), cc: cc.length ? cc.join(',') : undefined, subject: rellenar(POL.aviso_ejecutivo_asunto, vars), html });
  return { ok: !!(r && r.ok !== false), to: dest.to, nombres: dest.nombres, origen: dest.origen, nombre };
}

module.exports = { avisarEjecutivo, nombreCliente, destinatariosDealer };
