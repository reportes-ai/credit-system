'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   OTRAS COMPRAS (ODC) — compras a proveedores FUERA del catálogo de oficina.

   · Proveedores: la MISMA base de Órdenes de Pago (tabla `proveedores`, una
     sola fuente); se puede crear uno nuevo al emitir, igual que en la ODP.
   · Correlativo propio ODCaannnn (ODC260001), secuencia atómica por año.
   · Adjuntos (cotizaciones / detalle): motor único de facturas de ODP
     (postventa guardarFacturaDoc, origen 'ODC') → bucket vía almacen-docs.
   · Workflow FIJO de dos firmas: 1) el SUPERVISOR de quien la generó
     (usuarios.id_supervisor; sin supervisor pasa directo a Finanzas),
     2) Administración y Finanzas (perfil Gerente de Finanzas; Admin siempre).
   · La trazabilidad queda impresa al pie del comprobante:
     Generado por X el dd/mm/aaaa HH:MM hrs ⟶ Supervisor ⟶ Adm. y Finanzas.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const nombreDe = u => [u?.nombre, u?.apellido].filter(Boolean).join(' ') || u?.usuario || 'Sistema';
const CLP = n => '$' + Number(n || 0).toLocaleString('es-CL');
const ADJ_MAX = 7 * 1024 * 1024;   // body express 10mb; el base64 infla ~37%

/* ── Migración ── */
require('../../../../shared/migrate').enFila('otras-compras', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS odc_ordenes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    numero VARCHAR(12) NOT NULL UNIQUE,
    id_proveedor INT NULL,
    proveedor_nombre VARCHAR(200) NOT NULL,
    proveedor_rut VARCHAR(20) NULL,
    monto DECIMAL(12,0) NOT NULL,
    detalle TEXT NULL,
    comentarios TEXT NULL,
    estado VARCHAR(24) NOT NULL DEFAULT 'PENDIENTE_SUPERVISOR',
    id_usuario INT NULL, creado_por VARCHAR(160) NULL,
    sup_id INT NULL, sup_nombre VARCHAR(160) NULL, sup_fecha DATETIME NULL, sup_comentario VARCHAR(400) NULL,
    fin_id INT NULL, fin_nombre VARCHAR(160) NULL, fin_fecha DATETIME NULL, fin_comentario VARCHAR(400) NULL,
    rechazo_por VARCHAR(160) NULL, rechazo_motivo VARCHAR(400) NULL, rechazo_fecha DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_estado (estado), INDEX idx_usuario (id_usuario)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS odc_secuencia (
    anio INT PRIMARY KEY, ultimo INT NOT NULL DEFAULT 0
  )`);
  // Card "Otras Compras" en Soporte — mismos perfiles que Compras de Oficina
  const MOD_SOPORTE = 500001;
  const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='otras_compras' LIMIT 1");
  let idf = ex && ex.id_funcionalidad;
  if (!idf) {
    const [r] = await pool.query(
      "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?, 'Otras Compras', 'otras_compras', '/soporte/otras-compras/', 'bi-cart-plus')",
      [MOD_SOPORTE]);
    idf = r.insertId;
    await pool.query(`INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                      SELECT pp.id_perfil, ?, 1 FROM permisos_perfil pp
                      JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad AND f.codigo='compras'
                      WHERE NOT EXISTS (SELECT 1 FROM permisos_perfil x WHERE x.id_perfil=pp.id_perfil AND x.id_funcionalidad=?)`,
                     [idf, idf]);
  }
});

// Correlativo ODC del año (atómico, mismo patrón del libro ODP)
async function nextNumero() {
  const anio = new Date().getFullYear();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('INSERT INTO odc_secuencia (anio, ultimo) VALUES (?, 0) ON DUPLICATE KEY UPDATE anio=anio', [anio]);
    const [[row]] = await conn.query('SELECT ultimo FROM odc_secuencia WHERE anio=? FOR UPDATE', [anio]);
    const next = (row.ultimo || 0) + 1;
    await conn.query('UPDATE odc_secuencia SET ultimo=? WHERE anio=?', [next, anio]);
    await conn.commit();
    return 'ODC' + String(anio).slice(-2) + String(next).padStart(4, '0');
  } catch (e) { try { await conn.rollback(); } catch (_) {} throw e; }
  finally { conn.release(); }
}

// ¿El usuario es Administración y Finanzas? (perfil; Admin siempre puede)
async function esFinanzas(idUsuario) {
  const [[r]] = await pool.query(
    `SELECT p.nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?`, [idUsuario]);
  const n = String(r?.nombre || '');
  // 'Gerente de Finanzas', 'Analista Financiero', etc. — toda el área firma/recibe
  return n === 'Administrador' || /finan/i.test(n);
}
const esAdminPerfil = n => String(n || '') === 'Administrador';

/* Correo AUTOMÁTICO a Finanzas cuando la ODC queda esperando su firma —
   idéntico al de las ODP de proveedores: plantilla paramétrica (odc_finanzas),
   destino config correo_contabilidad, cotizaciones adjuntas. Nunca frena el flujo. */
function correoFinanzasODC(o, supervisorNombre) {
  (async () => {
    try {
      let to = 'contabilidad@autofacilchile.cl';
      try {
        const [[row]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='correo_contabilidad'");
        if (row) { const v = JSON.parse(row.valor); if (v && String(v).trim()) to = String(v).trim(); }
      } catch (_) {}
      const adjuntos = await require('../../../postventa/src/controllers/postventa.controller')
        .adjuntosFactura('ODC', [o.id]).catch(() => []);
      // CC a quien generó la orden: sigue el hilo de su propia compra
      let ccGen = [];
      if (o.id_usuario) {
        const [[cu]] = await pool.query('SELECT email FROM usuarios WHERE id_usuario=? AND email IS NOT NULL', [o.id_usuario]);
        if (cu?.email) ccGen = [String(cu.email)];
      }
      const env = await require('../../../../shared/plantillas-correo').enviar({
        codigo: 'odc_finanzas', to: [to], cc: ccGen,
        adjuntos: adjuntos.length ? adjuntos : undefined,
        datos: {
          ODC: o.numero, PROVEEDOR: o.proveedor_nombre, RUT: o.proveedor_rut || '—',
          DETALLE: String(o.detalle || '').slice(0, 500), TOTAL: CLP(o.monto),
          QUIEN: o.creado_por || '—', SUPERVISOR: supervisorNombre || 'sin supervisor asignado (pasa directo a Finanzas)',
        },
      });
      if (!env.enviado) console.warn('[odc correo finanzas]', o.numero, env.motivo);
    } catch (e) { console.error('[odc correo finanzas]', e.message); }
  })();
}

/* ── GET /datos — proveedores activos + contadores ── */
const getDatos = async (req, res) => {
  try {
    const [provs] = await pool.query("SELECT id, rut, nombre FROM proveedores WHERE COALESCE(activo,1)=1 ORDER BY nombre");
    const u = req.usuario || {};
    const [[perfil]] = await pool.query('SELECT p.nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?', [u.id_usuario]);
    ok(res, { proveedores: provs, es_finanzas: await esFinanzas(u.id_usuario), perfil: perfil?.nombre || '' });
  } catch (e) { console.error('[odc datos]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── POST / — crear la orden ── */
const crear = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    const monto = Math.round(Number(b.monto) || 0);
    if (monto <= 0) return fail(res, 'Indica el monto de la compra', 400);
    if (!String(b.detalle || '').trim()) return fail(res, 'Describe qué se está comprando', 400);

    // Proveedor: existente, o nuevo → se ANEXA a la base (igual que en la ODP)
    let idProv = Number(b.id_proveedor) || null, provNombre = '', provRut = null;
    if (idProv) {
      const [[p]] = await pool.query('SELECT id, nombre, rut FROM proveedores WHERE id=?', [idProv]);
      if (!p) return fail(res, 'Proveedor no encontrado', 400);
      provNombre = p.nombre; provRut = p.rut;
    } else {
      provNombre = String(b.prov_nombre || '').trim().slice(0, 200);
      provRut = String(b.prov_rut || '').trim().slice(0, 20) || null;
      if (!provNombre) return fail(res, 'Indica el proveedor', 400);
      const [[dup]] = provRut
        ? await pool.query("SELECT id FROM proveedores WHERE REPLACE(rut,'.','')=REPLACE(?,'.','') LIMIT 1", [provRut])
        : await pool.query('SELECT id FROM proveedores WHERE UPPER(nombre)=UPPER(?) LIMIT 1', [provNombre]);
      if (dup) idProv = dup.id;
      else {
        const [np] = await pool.query('INSERT INTO proveedores (rut, nombre, activo) VALUES (?,?,1)', [provRut, provNombre]);
        idProv = np.insertId;
        auditar({ req, accion: 'CREAR', modulo: 'otras-compras', entidad: 'proveedor', entidad_id: idProv,
          detalle: `Creó proveedor ${provNombre} (desde Otras Compras — completar banco y cuenta en la ficha)` });
      }
    }

    /* Anti-duplicado: tras un error de pantalla el usuario reintenta y quedan dos
       órdenes iguales (pasó con la ODC260001/2 el mismo día del estreno). Misma
       persona + mismo proveedor + mismo monto, pendiente y de menos de 15 min → 409. */
    const [[dupOrden]] = await pool.query(
      `SELECT numero FROM odc_ordenes
        WHERE id_usuario=? AND id_proveedor=? AND monto=? AND estado LIKE 'PENDIENTE%'
          AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE) LIMIT 1`, [u.id_usuario, idProv, monto]);
    if (dupOrden) return fail(res, `Ya emitiste la ${dupOrden.numero} con este proveedor y monto hace unos minutos — revisa el Historial antes de emitir de nuevo.`, 409);

    // Supervisor de quien genera; sin supervisor la orden salta directo a Finanzas
    const [[sup]] = await pool.query(
      `SELECT s.id_usuario, TRIM(CONCAT_WS(' ', s.nombre, s.apellido)) nombre
         FROM usuarios u JOIN usuarios s ON s.id_usuario = u.id_supervisor
        WHERE u.id_usuario=? AND s.estado='activo'`, [u.id_usuario]);
    const estado = sup ? 'PENDIENTE_SUPERVISOR' : 'PENDIENTE_FINANZAS';

    const numero = await nextNumero();
    const [r] = await pool.query(
      `INSERT INTO odc_ordenes (numero, id_proveedor, proveedor_nombre, proveedor_rut, monto, detalle, comentarios, estado, id_usuario, creado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [numero, idProv, provNombre, provRut, monto, String(b.detalle).trim().slice(0, 2000),
       String(b.comentarios || '').trim().slice(0, 2000) || null, estado, u.id_usuario || null, nombreDe(u)]);

    // Adjuntos: cotizaciones / detalle — motor único de las ODP (origen 'ODC')
    const { guardarFacturaDoc } = require('../../../postventa/src/controllers/postventa.controller');
    let adjuntos = 0;
    for (const a of (Array.isArray(b.adjuntos) ? b.adjuntos.slice(0, 5) : [])) {
      if (!a || !a.base64) continue;
      const buffer = Buffer.from(a.base64, 'base64');
      if (!buffer.length || buffer.length > ADJ_MAX) continue;
      await guardarFacturaDoc({ origen: 'ODC', ref_id: r.insertId, nombre: String(a.nombre || 'cotizacion').slice(0, 200), mime: a.mime || null, buffer, usuario: nombreDe(u) });
      adjuntos++;
    }

    if (sup) await notificar([sup.id_usuario], { tipo: 'ODC', titulo: '🛒 Orden de Compra por aprobar',
      mensaje: `${nombreDe(u)} generó la ${numero} (${provNombre}, ${CLP(monto)}). Esperando tu firma.`, href: '/soporte/otras-compras/' }).catch(() => {});
    else {
      const [fin] = await pool.query(`SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
        WHERE u.estado='activo' AND (p.nombre LIKE '%Finanzas%' OR p.nombre LIKE '%Financiero%')`);
      if (fin.length) await notificar(fin.map(x => x.id_usuario), { tipo: 'ODC', titulo: '🛒 Orden de Compra por aprobar',
        mensaje: `${nombreDe(u)} generó la ${numero} (${provNombre}, ${CLP(monto)}) — sin supervisor asignado, pasa directo a Finanzas.`, href: '/soporte/otras-compras/' }).catch(() => {});
      correoFinanzasODC({ id: r.insertId, numero, proveedor_nombre: provNombre, proveedor_rut: provRut, detalle: b.detalle, monto, creado_por: nombreDe(u), id_usuario: u.id_usuario }, null);
    }
    auditar({ req, accion: 'CREAR', modulo: 'otras-compras', entidad: 'odc', entidad_id: r.insertId,
      detalle: `Generó ${numero}: ${provNombre} ${CLP(monto)} — ${String(b.detalle).trim().slice(0, 120)}${adjuntos ? ` (${adjuntos} adjunto/s)` : ''}` });
    ok(res, { id: r.insertId, numero, estado });
  } catch (e) { console.error('[odc crear]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── GET /?vista=mias|por-aprobar|todas ── */
const listar = async (req, res) => {
  try {
    const u = req.usuario || {};
    const vista = req.query.vista || 'mias';
    const fin = await esFinanzas(u.id_usuario);
    const [[perfil]] = await pool.query('SELECT p.nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?', [u.id_usuario]);
    const admin = esAdminPerfil(perfil?.nombre);
    let rows;
    if (vista === 'por-aprobar') {
      [rows] = await pool.query(
        `SELECT o.*, (SELECT COUNT(*) FROM postventa_factura_docs d WHERE d.origen='ODC' AND d.ref_id=o.id) n_docs
           FROM odc_ordenes o
           LEFT JOIN usuarios cu ON cu.id_usuario = o.id_usuario
          WHERE (o.estado='PENDIENTE_SUPERVISOR' AND (cu.id_supervisor=? ${admin ? 'OR 1=1' : ''}))
             OR (o.estado='PENDIENTE_FINANZAS' AND ?)
          ORDER BY o.created_at`, [u.id_usuario, fin ? 1 : 0]);
    } else if (vista === 'todas' && (fin || admin)) {
      [rows] = await pool.query(
        `SELECT o.*, (SELECT COUNT(*) FROM postventa_factura_docs d WHERE d.origen='ODC' AND d.ref_id=o.id) n_docs
           FROM odc_ordenes o ORDER BY o.created_at DESC LIMIT 300`);
    } else {
      // Historial personal: las que generé + las de mi equipo (soy el supervisor
      // de quien las generó) + las que ya firmé en cualquier nivel
      [rows] = await pool.query(
        `SELECT o.*, (SELECT COUNT(*) FROM postventa_factura_docs d WHERE d.origen='ODC' AND d.ref_id=o.id) n_docs
           FROM odc_ordenes o
           LEFT JOIN usuarios cu ON cu.id_usuario = o.id_usuario
          WHERE o.id_usuario=? OR cu.id_supervisor=? OR o.sup_id=? OR o.fin_id=?
          ORDER BY o.created_at DESC LIMIT 300`, [u.id_usuario, u.id_usuario, u.id_usuario, u.id_usuario]);
    }
    ok(res, { ordenes: rows, es_finanzas: fin, es_admin: admin });
  } catch (e) { console.error('[odc listar]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── POST /:id/resolver { decision: APROBAR|RECHAZAR, comentario } ── */
const resolver = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    const decision = String(b.decision || '').toUpperCase();
    if (!['APROBAR', 'RECHAZAR'].includes(decision)) return fail(res, 'Decisión inválida', 400);
    if (decision === 'RECHAZAR' && !String(b.comentario || '').trim()) return fail(res, 'El motivo del rechazo es obligatorio', 400);
    const [[o]] = await pool.query('SELECT * FROM odc_ordenes WHERE id=?', [req.params.id]);
    if (!o) return fail(res, 'Orden no encontrada', 404);
    if (!['PENDIENTE_SUPERVISOR', 'PENDIENTE_FINANZAS'].includes(o.estado)) return fail(res, 'La orden ya fue resuelta', 409);

    const [[perfil]] = await pool.query('SELECT p.nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?', [u.id_usuario]);
    const admin = esAdminPerfil(perfil?.nombre);
    const comentario = String(b.comentario || '').trim().slice(0, 400) || null;

    /* RECHAZAR = DEVOLVER AL NIVEL ANTERIOR (siempre con comentario):
       Finanzas devuelve → vuelve al supervisor (su firma se borra y debe re-firmar);
       el supervisor devuelve → vuelve al generador (estado DEVUELTA: corrige,
       adjunta lo que falte y la reenvía). Nada muere en silencio. */
    if (o.estado === 'PENDIENTE_SUPERVISOR') {
      const [[cu]] = await pool.query('SELECT id_supervisor FROM usuarios WHERE id_usuario=?', [o.id_usuario]);
      if (!admin && cu?.id_supervisor !== u.id_usuario)
        return fail(res, 'Esta orden espera la firma del supervisor de quien la generó', 403);
      if (decision === 'RECHAZAR') {
        await pool.query(`UPDATE odc_ordenes SET estado='DEVUELTA', rechazo_por=?, rechazo_motivo=?, rechazo_fecha=NOW() WHERE id=?`,
          [nombreDe(u), comentario, o.id]);
      } else {
        await pool.query(`UPDATE odc_ordenes SET estado='PENDIENTE_FINANZAS', sup_id=?, sup_nombre=?, sup_fecha=NOW(), sup_comentario=? WHERE id=?`,
          [u.id_usuario, nombreDe(u), comentario, o.id]);
        const [fin] = await pool.query(`SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
          WHERE u.estado='activo' AND (p.nombre LIKE '%Finanzas%' OR p.nombre LIKE '%Financiero%')`);
        if (fin.length) await notificar(fin.map(x => x.id_usuario), { tipo: 'ODC', titulo: '🛒 Orden de Compra por aprobar',
          mensaje: `La ${o.numero} (${o.proveedor_nombre}, ${CLP(o.monto)}) tiene firma del supervisor. Falta Administración y Finanzas.`, href: '/soporte/otras-compras/' }).catch(() => {});
        correoFinanzasODC(o, nombreDe(u));   // mail a Finanzas con las cotizaciones adjuntas
      }
    } else { // PENDIENTE_FINANZAS
      if (!admin && !(await esFinanzas(u.id_usuario)))
        return fail(res, 'Esta orden espera la firma de Administración y Finanzas', 403);
      if (decision === 'RECHAZAR') {
        // Devuelve al supervisor: su firma anterior se limpia y debe volver a firmar
        await pool.query(`UPDATE odc_ordenes SET estado='PENDIENTE_SUPERVISOR', sup_id=NULL, sup_nombre=NULL, sup_fecha=NULL, sup_comentario=NULL,
                                                 rechazo_por=?, rechazo_motivo=?, rechazo_fecha=NOW() WHERE id=?`,
          [nombreDe(u), comentario, o.id]);
        const [[cu]] = await pool.query('SELECT id_supervisor FROM usuarios WHERE id_usuario=?', [o.id_usuario]);
        if (cu?.id_supervisor) await notificar([cu.id_supervisor], { tipo: 'ODC', titulo: '↩ Orden de Compra devuelta por Finanzas',
          mensaje: `La ${o.numero} (${o.proveedor_nombre}, ${CLP(o.monto)}) volvió a tu firma: ${comentario}`, href: '/soporte/otras-compras/' }).catch(() => {});
      } else {
        await pool.query(`UPDATE odc_ordenes SET estado='APROBADA', fin_id=?, fin_nombre=?, fin_fecha=NOW(), fin_comentario=? WHERE id=?`,
          [u.id_usuario, nombreDe(u), comentario, o.id]);
      }
    }
    if (o.id_usuario) await notificar([o.id_usuario], { tipo: 'ODC',
      titulo: decision === 'APROBAR' ? '✅ Orden de Compra avanzó' : '↩ Orden de Compra devuelta',
      mensaje: `${o.numero}: ${decision === 'RECHAZAR'
        ? (o.estado === 'PENDIENTE_SUPERVISOR' ? `devuelta a ti por ${nombreDe(u)} — ${comentario}. Corrígela y reenvíala.` : `Finanzas la devolvió al supervisor — ${comentario}`)
        : (o.estado === 'PENDIENTE_SUPERVISOR' ? 'aprobada por tu supervisor, falta Administración y Finanzas' : 'APROBADA por Administración y Finanzas')}`,
      href: '/soporte/otras-compras/' }).catch(() => {});
    auditar({ req, accion: decision === 'APROBAR' ? 'APROBAR' : 'RECHAZAR', modulo: 'otras-compras', entidad: 'odc', entidad_id: o.id,
      detalle: `${o.numero} (${o.estado === 'PENDIENTE_SUPERVISOR' ? 'nivel supervisor' : 'nivel Finanzas'}): ${decision}${comentario ? ' — ' + comentario : ''}` });
    ok(res, { id: o.id, decision });
  } catch (e) { console.error('[odc resolver]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── POST /:id/reenviar — el generador corrige una DEVUELTA y la manda de vuelta ── */
const reenviar = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    const [[o]] = await pool.query('SELECT * FROM odc_ordenes WHERE id=?', [req.params.id]);
    if (!o) return fail(res, 'Orden no encontrada', 404);
    if (o.estado !== 'DEVUELTA') return fail(res, 'Solo se reenvían órdenes devueltas', 409);
    const [[perfil]] = await pool.query('SELECT p.nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?', [u.id_usuario]);
    if (o.id_usuario !== u.id_usuario && !esAdminPerfil(perfil?.nombre))
      return fail(res, 'Solo quien generó la orden puede reenviarla', 403);
    // Puede corregir monto/detalle/comentarios antes de reenviar
    const monto = b.monto != null ? Math.round(Number(b.monto) || 0) : Number(o.monto);
    if (monto <= 0) return fail(res, 'Monto inválido', 400);
    const [[sup]] = await pool.query(
      `SELECT s.id_usuario FROM usuarios u JOIN usuarios s ON s.id_usuario=u.id_supervisor
        WHERE u.id_usuario=? AND s.estado='activo'`, [o.id_usuario]);
    const estado = sup ? 'PENDIENTE_SUPERVISOR' : 'PENDIENTE_FINANZAS';
    await pool.query(
      `UPDATE odc_ordenes SET estado=?, monto=?, detalle=COALESCE(?, detalle), comentarios=COALESCE(?, comentarios),
              rechazo_por=NULL, rechazo_motivo=NULL, rechazo_fecha=NULL WHERE id=?`,
      [estado, monto, String(b.detalle || '').trim() || null, String(b.comentarios || '').trim() || null, o.id]);
    if (sup) await notificar([sup.id_usuario], { tipo: 'ODC', titulo: '🛒 Orden de Compra reenviada',
      mensaje: `${nombreDe(u)} corrigió y reenvió la ${o.numero} (${o.proveedor_nombre}, ${CLP(monto)}). Esperando tu firma.`, href: '/soporte/otras-compras/' }).catch(() => {});
    auditar({ req, accion: 'EDITAR', modulo: 'otras-compras', entidad: 'odc', entidad_id: o.id,
      detalle: `Reenvió la ${o.numero} tras la devolución (${CLP(monto)})` });
    ok(res, { id: o.id, estado });
  } catch (e) { console.error('[odc reenviar]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── POST /:id/adjunto — agregar cotización/detalle a una orden aún pendiente ── */
const adjuntar = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    const [[o]] = await pool.query('SELECT * FROM odc_ordenes WHERE id=?', [req.params.id]);
    if (!o) return fail(res, 'Orden no encontrada', 404);
    if (!o.estado.startsWith('PENDIENTE') && o.estado !== 'DEVUELTA') return fail(res, 'La orden ya fue resuelta: no se pueden agregar adjuntos', 409);
    const [[perfil]] = await pool.query('SELECT p.nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?', [u.id_usuario]);
    if (o.id_usuario !== u.id_usuario && !esAdminPerfil(perfil?.nombre))
      return fail(res, 'Solo quien generó la orden puede adjuntar', 403);
    if (!b.base64) return fail(res, 'Falta el archivo', 400);
    const buffer = Buffer.from(b.base64, 'base64');
    if (!buffer.length) return fail(res, 'El archivo llegó vacío', 400);
    if (buffer.length > ADJ_MAX) return fail(res, 'El archivo supera el máximo de 7 MB', 400);
    const { guardarFacturaDoc } = require('../../../postventa/src/controllers/postventa.controller');
    const out = await guardarFacturaDoc({ origen: 'ODC', ref_id: o.id, nombre: String(b.nombre || 'adjunto').slice(0, 200), mime: b.mime || null, buffer, usuario: nombreDe(u) });
    auditar({ req, accion: 'CREAR', modulo: 'otras-compras', entidad: 'odc_adjunto', entidad_id: out.id,
      detalle: `Adjuntó "${b.nombre}" a la ${o.numero}` });
    ok(res, out);
  } catch (e) { console.error('[odc adjuntar]', e.message); fail(res, e.message || 'Error interno del servidor'); }
};

/* ── GET /:id/documento — la orden completa + adjuntos para el comprobante ── */
const documento = async (req, res) => {
  try {
    const u = req.usuario || {};
    const [[o]] = await pool.query('SELECT * FROM odc_ordenes WHERE id=?', [req.params.id]);
    if (!o) return fail(res, 'Orden no encontrada', 404);
    const [docs] = await pool.query("SELECT id, nombre FROM postventa_factura_docs WHERE origen='ODC' AND ref_id=? ORDER BY id", [o.id]);
    // ¿Quien mira el voucher puede firmarlo? → botón Aprobar/Rechazar en el documento
    let puedo_resolver = false;
    if (['PENDIENTE_SUPERVISOR', 'PENDIENTE_FINANZAS'].includes(o.estado)) {
      const [[perfil]] = await pool.query('SELECT p.nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?', [u.id_usuario]);
      if (esAdminPerfil(perfil?.nombre)) puedo_resolver = true;
      else if (o.estado === 'PENDIENTE_SUPERVISOR') {
        const [[cu]] = await pool.query('SELECT id_supervisor FROM usuarios WHERE id_usuario=?', [o.id_usuario]);
        puedo_resolver = cu?.id_supervisor === u.id_usuario;
      } else puedo_resolver = await esFinanzas(u.id_usuario);
    }
    ok(res, { ...o, docs, puedo_resolver });
  } catch (e) { console.error('[odc documento]', e.message); fail(res, 'Error interno del servidor'); }
};

module.exports = { getDatos, crear, listar, resolver, documento, adjuntar, reenviar };
