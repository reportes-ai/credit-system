'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CIERRE DE MES (Tesorería) — checklist obligatorio con responsables.
   · Mantenedor paramétrico de ÍTEMS: nombre, descripción, link a la pantalla
     donde se verifica, responsable (usuario o perfil), día hábil límite del mes
     siguiente, obligatorio, chequeo automático opcional.
   · Cada responsable da el OK de SUS ítems (semáforo por mes, auditado).
   · Recordatorio DIARIO por correo a los responsables con ítems pendientes cuyo
     día hábil límite ya llegó (tick 1 vez al día, respeta Modo Desarrollo vía mailer).
   · Con todos los obligatorios en verde, quien tenga `cierre_mes_cerrar` CIERRA
     EL MES: activa el candado contable (ctb_meses_cerrados) y envía el ACTA por
     correo a los destinatarios definidos.
   Chequeos automáticos disponibles (columna check_auto):
     PROVISIONES   → existe cierre de provisiones del mes (contab_saldos_mensuales)
     CONCILIACION  → movimientos bancarios del mes sin conciliar = 0
     TRANSITORIAS  → cuentas transitorias ACTIVAS con saldo sin aplicar
     ODP_PENDIENTES→ órdenes de pago EMITIDAS (sin pagar) emitidas en el mes
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { sumarDiasHabiles } = require('../../../../shared/feriados');
const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Migración ──────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('cierre-mes', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cierre_checklist_items (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        nombre       VARCHAR(160) NOT NULL,
        descripcion  VARCHAR(400) NULL,
        href         VARCHAR(200) NULL,              -- pantalla donde se verifica
        orden        INT DEFAULT 0,
        obligatorio  TINYINT(1) DEFAULT 1,
        dia_habil    INT DEFAULT 5,                  -- día hábil del mes siguiente en que vence
        resp_tipo    ENUM('USUARIO','PERFIL') DEFAULT 'PERFIL',
        id_usuario   INT NULL,
        id_perfil    INT NULL,
        check_auto   VARCHAR(30) NULL,               -- PROVISIONES | CONCILIACION | TRANSITORIAS | ODP_PENDIENTES
        activo       TINYINT(1) DEFAULT 1
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cierre_mes_checks (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        mes        CHAR(7) NOT NULL,
        id_item    INT NOT NULL,
        estado     ENUM('PENDIENTE','OK') DEFAULT 'PENDIENTE',
        comentario VARCHAR(500) NULL,
        ok_por     INT NULL,
        ok_nombre  VARCHAR(160) NULL,
        ok_at      DATETIME NULL,
        UNIQUE KEY uq_mes_item (mes, id_item)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cierre_mes_actas (
        mes         CHAR(7) PRIMARY KEY,
        cerrado_por INT NULL,
        cerrado_nombre VARCHAR(160) NULL,
        cerrado_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        acta        JSON NULL,                       -- detalle de cada OK al momento del cierre
        correo_a    VARCHAR(600) NULL
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cierre_mes_config (
        clave VARCHAR(50) PRIMARY KEY,
        valor TEXT NULL
      )`);
    await pool.query("INSERT IGNORE INTO cierre_mes_config (clave, valor) VALUES ('correos_acta','')");
    await pool.query("INSERT IGNORE INTO cierre_mes_config (clave, valor) VALUES ('recordatorio_hora','9')");

    // Ítems semilla (editables/eliminables en el mantenedor). Responsable default: perfil Tesorero.
    const [[hay]] = await pool.query('SELECT COUNT(*) n FROM cierre_checklist_items');
    if (!hay.n) {
      const [[pTes]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Tesorero' LIMIT 1");
      const [[pFin]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre='Gerente de Finanzas' LIMIT 1");
      const pT = pTes ? pTes.id_perfil : null, pF = pFin ? pFin.id_perfil : (pTes ? pTes.id_perfil : null);
      const seed = [
        ['Provisiones del mes cerradas', 'Cierre de Provisiones y Castigos guardado (snapshot + asiento).', '/tesoreria/castigos', 1, 3, pF, 'PROVISIONES'],
        ['Castigos del mes revisados', 'Castigos aplicados en el mes revisados y con sus dos firmas.', '/tesoreria/castigos', 2, 3, pF, null],
        ['Conciliación bancaria al día', 'Todos los movimientos bancarios del mes conciliados.', '/tesoreria/conciliacion-bancaria', 3, 5, pT, 'CONCILIACION'],
        ['Cuentas transitorias cuadradas', 'Sin dineros sin aplicar en cuentas transitorias.', '/tesoreria/cuentas-transitorias', 4, 5, pT, 'TRANSITORIAS'],
        ['Pagos pendientes resueltos', 'Órdenes de pago emitidas en el mes pagadas o justificadas.', '/ordenes-pago/', 5, 5, pT, 'ODP_PENDIENTES'],
        ['Comisiones del mes aprobadas', 'Revisión de comisiones de ejecutivos del mes completa.', '/comisiones/revision/', 6, 5, pF, null],
        ['Cartolas de dealers emitidas', 'Cartolas del mes generadas y facturas cuadradas.', '/post-venta/', 7, 5, pT, null],
      ];
      for (const [nombre, desc, href, orden, dh, perfil, auto] of seed)
        await pool.query(
          `INSERT INTO cierre_checklist_items (nombre, descripcion, href, orden, obligatorio, dia_habil, resp_tipo, id_perfil, check_auto)
           VALUES (?,?,?,?,1,?,'PERFIL',?,?)`, [nombre, desc, href, orden, dh, perfil, auto]);
    }

    // Funcionalidades: página (todos los que operan cierre) + acción de cerrar + mantenedor
    const [[modT]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (modT) {
      const seedFunc = async (nombre, codigo, href, icono) => {
        const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
        if (ex) return ex.id_funcionalidad;
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [modT.id_modulo, nombre, codigo, href, icono]);
        return r.insertId;
      };
      const fPag = await seedFunc('Cierre de Mes', 'cierre_mes', '/tesoreria/cierre-mes', 'bi-calendar2-check');
      const fCer = await seedFunc('Cerrar Mes (candado final)', 'cierre_mes_cerrar', null, 'bi-lock');
      const fCfg = await seedFunc('Configurar Checklist de Cierre', 'cierre_mes_config', null, 'bi-gear');
      const grant = async (idF, ...perfiles) => {
        for (const nom of perfiles) {
          const [[p]] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre=? LIMIT 1', [nom]);
          if (p) await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [p.id_perfil, idF]);
        }
      };
      await grant(fPag, 'Gerente General', 'Gerente de Finanzas', 'Gerente de Operaciones y Crédito', 'Tesorero', 'Auditor');
      await grant(fCer, 'Gerente General', 'Gerente de Finanzas');
      await grant(fCfg, 'Gerente General', 'Gerente de Finanzas');
    }
    console.log('[cierre-mes] módulo listo');
  } catch (e) { console.error('[cierre-mes migration]', e.message); }
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */
const mesAnteriorDe = (mes) => { let [y, m] = mes.split('-').map(Number); m--; if (m < 1) { m = 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; };
const mesDefault = () => mesAnteriorDe(new Date().toISOString().slice(0, 7));   // se cierra el mes anterior

async function cfgGet(clave) {
  const [[r]] = await pool.query('SELECT valor FROM cierre_mes_config WHERE clave=? LIMIT 1', [clave]);
  return r ? r.valor : null;
}

// Fecha límite de un ítem para el cierre de `mes`: N días hábiles contados desde
// el último día de ese mes (o sea, dentro del mes siguiente).
function fechaLimite(mes, diaHabil) {
  const [y, m] = mes.split('-').map(Number);
  const finMes = new Date(y, m, 0);                                // último día del mes a cerrar
  return sumarDiasHabiles(finMes, Math.max(1, Number(diaHabil) || 5)).toISOString().slice(0, 10);
}

/* Chequeos automáticos: devuelven { ok, detalle } */
const CHECKS_AUTO = {
  async PROVISIONES(mes) {
    const [[r]] = await pool.query("SELECT saldo FROM contab_saldos_mensuales WHERE mes=? AND cuenta='PROVISIONES' LIMIT 1", [mes]);
    return r ? { ok: true, detalle: `Cierre guardado (saldo $${Math.round(r.saldo).toLocaleString('es-CL')})` }
             : { ok: false, detalle: 'El mes aún no tiene cierre de provisiones guardado' };
  },
  async CONCILIACION(mes) {
    const [[r]] = await pool.query(
      "SELECT COUNT(*) n FROM banco_movimientos WHERE DATE_FORMAT(fecha,'%Y-%m')=? AND COALESCE(conciliado,0)=0", [mes]);
    return r.n === 0 ? { ok: true, detalle: 'Sin movimientos pendientes de conciliar' }
                     : { ok: false, detalle: `${r.n} movimiento(s) bancario(s) del mes sin conciliar` };
  },
  async TRANSITORIAS(mes) {
    const [[r]] = await pool.query(
      "SELECT COUNT(*) n, COALESCE(SUM(monto_original-monto_utilizado),0) s FROM cuentas_transitorias WHERE estado='ACTIVO' AND monto_original > monto_utilizado");
    return r.n === 0 ? { ok: true, detalle: 'Sin dineros sin aplicar' }
                     : { ok: false, detalle: `${r.n} transitoria(s) con $${Math.round(r.s).toLocaleString('es-CL')} sin aplicar` };
  },
  async ODP_PENDIENTES(mes) {
    const [[r]] = await pool.query(
      "SELECT COUNT(*) n FROM ordenes_pago WHERE estado='EMITIDA' AND DATE_FORMAT(fecha_emision,'%Y-%m') <= ?", [mes]);
    return r.n === 0 ? { ok: true, detalle: 'Sin órdenes de pago pendientes' }
                     : { ok: false, detalle: `${r.n} orden(es) de pago emitida(s) sin pagar` };
  },
};

async function responsableDe(item) {
  if (item.resp_tipo === 'USUARIO' && item.id_usuario) {
    const [[u]] = await pool.query("SELECT id_usuario, CONCAT(nombre,' ',apellido) nombre, email FROM usuarios WHERE id_usuario=?", [item.id_usuario]);
    return u ? [u] : [];
  }
  if (item.id_perfil) {
    const [us] = await pool.query(
      "SELECT id_usuario, CONCAT(nombre,' ',apellido) nombre, email FROM usuarios WHERE id_perfil=? AND estado='activo'", [item.id_perfil]);
    return us;
  }
  return [];
}

/* Estado completo del checklist de un mes (con chequeos automáticos al vuelo) */
async function estadoMes(mes) {
  const [items] = await pool.query('SELECT * FROM cierre_checklist_items WHERE activo=1 ORDER BY orden, id');
  const [checks] = await pool.query('SELECT * FROM cierre_mes_checks WHERE mes=?', [mes]);
  const mCheck = new Map(checks.map(c => [c.id_item, c]));
  const [[acta]] = await pool.query('SELECT * FROM cierre_mes_actas WHERE mes=?', [mes]);
  const [[candado]] = await pool.query('SELECT mes FROM ctb_meses_cerrados WHERE mes=?', [mes]);

  const out = [];
  for (const it of items) {
    const c = mCheck.get(it.id) || null;
    let auto = null;
    if (it.check_auto && CHECKS_AUTO[it.check_auto]) {
      try { auto = await CHECKS_AUTO[it.check_auto](mes); } catch (e) { auto = { ok: false, detalle: 'Error del chequeo: ' + e.message }; }
    }
    const resp = await responsableDe(it);
    let perfilNombre = null;
    if (it.resp_tipo === 'PERFIL' && it.id_perfil) {
      const [[p]] = await pool.query('SELECT nombre FROM perfiles WHERE id_perfil=?', [it.id_perfil]);
      perfilNombre = p && p.nombre;
    }
    out.push({
      ...it,
      limite: fechaLimite(mes, it.dia_habil),
      responsables: resp.map(r => ({ id_usuario: r.id_usuario, nombre: r.nombre })),
      responsable_txt: it.resp_tipo === 'USUARIO' ? (resp[0] ? resp[0].nombre : '—') : (perfilNombre || '—'),
      auto,
      estado: c ? c.estado : 'PENDIENTE',
      ok_nombre: c ? c.ok_nombre : null, ok_at: c ? c.ok_at : null, comentario: c ? c.comentario : null,
    });
  }
  const obligatoriosOk = out.filter(i => i.obligatorio).every(i => i.estado === 'OK');
  return { mes, items: out, obligatorios_ok: obligatoriosOk, cerrado: !!acta || !!candado, acta: acta || null };
}

/* ── Endpoints ──────────────────────────────────────────────────────────────── */
const getEstado = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : mesDefault();
    ok(res, await estadoMes(mes));
  } catch (e) { fail(res, e.message); }
};

// Un responsable (o admin) da el OK de un ítem
const marcarOk = async (req, res) => {
  try {
    const { mes, id_item, comentario, deshacer } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(mes || '') || !id_item) return fail(res, 'mes e id_item son obligatorios', 400);
    const [[cerrado]] = await pool.query('SELECT mes FROM cierre_mes_actas WHERE mes=?', [mes]);
    if (cerrado) return fail(res, 'El mes ya está cerrado — el checklist quedó congelado en el acta.', 409);
    const [[it]] = await pool.query('SELECT * FROM cierre_checklist_items WHERE id=? AND activo=1', [id_item]);
    if (!it) return fail(res, 'Ítem no encontrado', 404);

    // Autorización: responsable del ítem, o quien pueda cerrar el mes (admin del proceso)
    const uid = req.user.id_usuario;
    const resp = await responsableDe(it);
    const esResponsable = resp.some(r => r.id_usuario === uid);
    const { tieneFunc } = require('../../../../shared/middleware/permisos');
    const esAdmin = await tieneFunc(uid, 'cierre_mes_cerrar');
    if (!esResponsable && !esAdmin) return fail(res, 'Solo el responsable del punto (o quien cierra el mes) puede marcarlo.', 403);

    const nombre = `${req.user.nombre || ''} ${req.user.apellido || ''}`.trim() || req.user.email;
    if (deshacer) {
      await pool.query("UPDATE cierre_mes_checks SET estado='PENDIENTE', ok_por=NULL, ok_nombre=NULL, ok_at=NULL WHERE mes=? AND id_item=?", [mes, id_item]);
      auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'cierre_mes', entidad_id: id_item, detalle: `Deshizo OK de "${it.nombre}" del cierre ${mes}` });
      return ok(res, { deshecho: true });
    }
    await pool.query(
      `INSERT INTO cierre_mes_checks (mes, id_item, estado, comentario, ok_por, ok_nombre, ok_at)
       VALUES (?,?,'OK',?,?,?,NOW())
       ON DUPLICATE KEY UPDATE estado='OK', comentario=VALUES(comentario), ok_por=VALUES(ok_por), ok_nombre=VALUES(ok_nombre), ok_at=NOW()`,
      [mes, id_item, String(comentario || '').slice(0, 500) || null, uid, nombre]);
    auditar({ req, accion: 'VALIDAR', modulo: 'tesoreria', entidad: 'cierre_mes', entidad_id: id_item, detalle: `OK a "${it.nombre}" del cierre ${mes}${comentario ? ' · ' + comentario : ''}` });
    ok(res, { marcado: true });
  } catch (e) { fail(res, e.message); }
};

// Cierre TOTAL del mes: exige obligatorios OK, activa candado contable y envía el acta.
const cerrarMes = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.body.mes || '') ? req.body.mes : null;
    if (!mes) return fail(res, 'Mes inválido', 400);
    const est = await estadoMes(mes);
    if (est.cerrado) return fail(res, 'El mes ya está cerrado.', 409);
    if (!est.obligatorios_ok) {
      const faltan = est.items.filter(i => i.obligatorio && i.estado !== 'OK').map(i => i.nombre);
      return fail(res, 'Faltan puntos obligatorios: ' + faltan.join(' · '), 409);
    }
    const nombre = `${req.user.nombre || ''} ${req.user.apellido || ''}`.trim() || req.user.email;
    const acta = est.items.map(i => ({
      punto: i.nombre, obligatorio: !!i.obligatorio, estado: i.estado,
      ok_por: i.ok_nombre, ok_at: i.ok_at, comentario: i.comentario,
      responsable: i.responsable_txt, limite: i.limite,
    }));
    const correos = (await cfgGet('correos_acta') || '').split(/[;,\s]+/).filter(x => /@/.test(x));
    await pool.query('INSERT INTO cierre_mes_actas (mes, cerrado_por, cerrado_nombre, acta, correo_a) VALUES (?,?,?,?,?)',
      [mes, req.user.id_usuario, nombre, JSON.stringify(acta), correos.join(', ') || null]);
    // Candado contable (idempotente — misma tabla que usa Contabilidad)
    await pool.query('INSERT IGNORE INTO ctb_meses_cerrados (mes, cerrado_por) VALUES (?,?)', [mes, nombre]);
    auditar({ req, accion: 'CERRAR', modulo: 'tesoreria', entidad: 'cierre_mes', entidad_id: mes, detalle: `CERRÓ EL MES ${mes} (checklist completo, candado contable activado)` });

    // Acta por correo
    if (correos.length) {
      const filas = acta.map(a => `
        <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${a.punto}${a.obligatorio ? '' : ' <i>(opcional)</i>'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${a.estado === 'OK' ? '✅ OK' : '—'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${a.ok_por || ''}<br><small style="color:#888">${a.ok_at ? new Date(a.ok_at).toLocaleString('es-CL') : ''}</small></td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#555">${a.comentario || ''}</td></tr>`).join('');
      enviarCorreo({
        to: correos,
        subject: `[AutoFácil] Cierre de Mes ${mes} — acta de cierre`,
        html: envolverHTML(`
          <h2 style="color:#012d70;margin:0 0 6px">Cierre de Mes ${mes}</h2>
          <p>El mes <b>${mes}</b> fue cerrado por <b>${nombre}</b> el ${new Date().toLocaleString('es-CL')}.
          El candado contable quedó activado: no se pueden registrar movimientos con fecha de ese mes.</p>
          <table style="border-collapse:collapse;width:100%;font-size:14px">
            <tr style="background:#f0f4f8"><th style="padding:6px 10px;text-align:left">Punto</th><th style="padding:6px 10px;text-align:left">Estado</th><th style="padding:6px 10px;text-align:left">OK por</th><th style="padding:6px 10px;text-align:left">Comentario</th></tr>
            ${filas}
          </table>`),
      }).catch(e => console.error('[cierre-mes correo acta]', e.message));
    }
    ok(res, { mes, cerrado: true, correos_acta: correos.length });
  } catch (e) { fail(res, e.message); }
};

/* ── Mantenedor de ítems + config ───────────────────────────────────────────── */
const getConfig = async (req, res) => {
  try {
    const [items] = await pool.query('SELECT * FROM cierre_checklist_items ORDER BY orden, id');
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles ORDER BY nombre');
    const [usuarios] = await pool.query("SELECT id_usuario, CONCAT(nombre,' ',apellido) nombre FROM usuarios WHERE estado='activo' ORDER BY nombre");
    ok(res, { items, perfiles, usuarios, correos_acta: await cfgGet('correos_acta') || '', checks_auto: Object.keys(CHECKS_AUTO) });
  } catch (e) { fail(res, e.message); }
};

const guardarItem = async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.nombre || '').trim()) return fail(res, 'Nombre obligatorio', 400);
    const vals = [String(b.nombre).trim(), b.descripcion || null, b.href || null, Number(b.orden) || 0,
      b.obligatorio ? 1 : 0, Math.max(1, Number(b.dia_habil) || 5),
      b.resp_tipo === 'USUARIO' ? 'USUARIO' : 'PERFIL', b.id_usuario || null, b.id_perfil || null,
      CHECKS_AUTO[b.check_auto] ? b.check_auto : null, b.activo === 0 ? 0 : 1];
    if (b.id) {
      await pool.query(
        `UPDATE cierre_checklist_items SET nombre=?, descripcion=?, href=?, orden=?, obligatorio=?, dia_habil=?, resp_tipo=?, id_usuario=?, id_perfil=?, check_auto=?, activo=? WHERE id=?`,
        [...vals, b.id]);
    } else {
      await pool.query(
        `INSERT INTO cierre_checklist_items (nombre, descripcion, href, orden, obligatorio, dia_habil, resp_tipo, id_usuario, id_perfil, check_auto, activo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, vals);
    }
    auditar({ req, accion: b.id ? 'EDITAR' : 'CREAR', modulo: 'tesoreria', entidad: 'cierre_checklist', entidad_id: b.id || null, detalle: `Ítem de cierre: ${b.nombre}` });
    ok(res, { guardado: true });
  } catch (e) { fail(res, e.message); }
};

const guardarConfig = async (req, res) => {
  try {
    const { correos_acta } = req.body || {};
    await pool.query("INSERT INTO cierre_mes_config (clave, valor) VALUES ('correos_acta', ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)", [String(correos_acta || '')]);
    auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'cierre_mes_config', detalle: 'Actualizó destinatarios del acta de cierre' });
    ok(res, { guardado: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Recordatorio diario a responsables ─────────────────────────────────────────
   Una vez al día (a la hora configurada): para el mes a cerrar (mes anterior),
   si NO está cerrado, a cada responsable con ítems pendientes cuya fecha límite
   ya llegó se le manda UN correo con su lista. */
let _ultimoRecordatorio = null;   // 'YYYY-MM-DD' del último envío
async function tickRecordatorios() {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    if (_ultimoRecordatorio === hoy) return;
    const hora = parseInt(await cfgGet('recordatorio_hora'), 10) || 9;
    if (new Date().getHours() < hora) return;
    const mes = mesDefault();
    const est = await estadoMes(mes);
    if (est.cerrado) { _ultimoRecordatorio = hoy; return; }
    const porUsuario = new Map();   // id_usuario → { email, nombre, items: [] }
    for (const it of est.items) {
      if (it.estado === 'OK' || it.limite > hoy) continue;
      const resp = await responsableDe(it);
      for (const r of resp) {
        if (!r.email) continue;
        if (!porUsuario.has(r.id_usuario)) porUsuario.set(r.id_usuario, { email: r.email, nombre: r.nombre, items: [] });
        porUsuario.get(r.id_usuario).items.push(it);
      }
    }
    for (const [, u] of porUsuario) {
      const lis = u.items.map(i =>
        `<li style="margin-bottom:6px"><b>${i.nombre}</b> — vencía el ${i.limite.split('-').reverse().join('-')}
         ${i.auto && !i.auto.ok ? `<br><small style="color:#b45309">${i.auto.detalle}</small>` : ''}
         ${i.href ? `<br><a href="${(process.env.APP_URL || 'https://afbs.autofacilchile.cl')}${i.href}">Revisar aquí</a> · <a href="${(process.env.APP_URL || 'https://afbs.autofacilchile.cl')}/tesoreria/cierre-mes">Dar el OK</a>` : ''}</li>`).join('');
      enviarCorreo({
        to: u.email,
        subject: `[AutoFácil] Cierre de Mes ${mes}: tienes ${u.items.length} punto(s) pendiente(s)`,
        html: envolverHTML(`
          <h2 style="color:#012d70;margin:0 0 6px">Cierre de Mes ${mes}</h2>
          <p>Hola ${u.nombre.split(' ')[0]}, estos puntos del cierre están a tu cargo y su fecha límite ya llegó:</p>
          <ul>${lis}</ul>
          <p style="color:#666;font-size:13px">Este recordatorio se repetirá cada día hasta que des el OK en
          <a href="${(process.env.APP_URL || 'https://afbs.autofacilchile.cl')}/tesoreria/cierre-mes">Cierre de Mes</a>.</p>`),
      }).catch(e => console.error('[cierre-mes recordatorio]', e.message));
    }
    if (porUsuario.size) console.log(`[cierre-mes] recordatorios enviados a ${porUsuario.size} responsable(s) — cierre ${mes}`);
    _ultimoRecordatorio = hoy;
  } catch (e) { console.error('[cierre-mes tick]', e.message); }
}
setTimeout(tickRecordatorios, 2 * 60 * 1000);
setInterval(tickRecordatorios, 30 * 60 * 1000);   // revisa cada 30 min; envía 1 vez al día pasada la hora

module.exports = { getEstado, marcarOk, cerrarMes, getConfig, guardarItem, guardarConfig };
