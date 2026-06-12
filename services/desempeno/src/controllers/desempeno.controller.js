'use strict';
const pool = require('../../../../shared/config/database');

/* ════════════════════════════════════════════════════════════════
   DESEMPEÑO ANALISTAS DE CRÉDITO
   Captura:
   - sesiones_usuario: login + heartbeat (last_seen) + logout → horas conectado.
   - carta_eventos: apertura de cartas ('abrir') por usuario.
   Decisiones (aprobar/rechazar) se leen de cartas_aprobacion (ya existen).
   ════════════════════════════════════════════════════════════════ */

const PERFILES_ANALISTA = ['Analista de Crédito', 'Supervisor de Crédito'];

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sesiones_usuario (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario INT NOT NULL,
        nombre     VARCHAR(200),
        perfil     VARCHAR(80),
        login_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        logout_at  DATETIME DEFAULT NULL,
        INDEX idx_user (id_usuario), INDEX idx_login (login_at)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS carta_eventos (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        id_carta   INT NOT NULL,
        id_usuario INT,
        usuario    VARCHAR(200),
        accion     VARCHAR(20) NOT NULL,   -- abrir
        ts         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_carta (id_carta), INDEX idx_user_ts (id_usuario, ts)
      )`);
    console.log('[desempeno] tablas OK');
  } catch (e) { console.error('[desempeno migration]', e.message); }
})();

/* ── Captura ─────────────────────────────────────────────────────── */
// Llamado desde el login (registra una sesión nueva)
async function registrarLogin(usuario) {
  try {
    const nombre = ((usuario.nombre || '') + ' ' + (usuario.apellido || '')).trim() || usuario.email;
    await pool.query(
      'INSERT INTO sesiones_usuario (id_usuario, nombre, perfil, login_at, last_seen) VALUES (?,?,?,NOW(),NOW())',
      [usuario.id_usuario, nombre, usuario.perfil_nombre || null]);
  } catch (e) { console.error('[desempeno login]', e.message); }
}

// Heartbeat: actualiza last_seen de la sesión abierta más reciente (o crea una si no hay)
const ping = async (req, res) => {
  try {
    const id = req.usuario.id_usuario;
    const [r] = await pool.query(
      `UPDATE sesiones_usuario SET last_seen = NOW()
       WHERE id_usuario = ? AND logout_at IS NULL
         AND last_seen > (NOW() - INTERVAL 15 MINUTE)
       ORDER BY login_at DESC LIMIT 1`, [id]);
    if (!r.affectedRows) {
      const nombre = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email;
      await pool.query('INSERT INTO sesiones_usuario (id_usuario, nombre, perfil, login_at, last_seen) VALUES (?,?,?,NOW(),NOW())',
        [id, nombre, req.usuario.perfil_nombre || null]);
    }
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error' }); }
};

const logout = async (req, res) => {
  try {
    await pool.query(
      `UPDATE sesiones_usuario SET logout_at = NOW() WHERE id_usuario = ? AND logout_at IS NULL`,
      [req.usuario.id_usuario]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error' }); }
};

// Registrar apertura de carta
const logApertura = async (req, res) => {
  try {
    const idCarta = parseInt(req.body.id_carta);
    if (!idCarta) return res.status(400).json({ success: false, data: null, error: 'id_carta requerido' });
    const nombre = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email;
    await pool.query('INSERT INTO carta_eventos (id_carta, id_usuario, usuario, accion) VALUES (?,?,?,?)',
      [idCarta, req.usuario.id_usuario, nombre, 'abrir']);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error' }); }
};

/* ── Helpers de tiempo ───────────────────────────────────────────── */
const DIAS = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const ymd = d => d.toISOString().slice(0, 10);
const overlapMin = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / 60000;
const finSesion = s => new Date(s.logout_at || s.last_seen);
// ventana 10:00–19:00 de un día (hora local del servidor; las fechas vienen de BD ya en local)
const ventana = (fechaYMD) => ({ ini: new Date(fechaYMD + 'T10:00:00'), fin: new Date(fechaYMD + 'T19:00:00') });

/* ── GET /api/desempeno/cartas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD ──── */
const reporteDiario = async (req, res) => {
  try {
    const hasta = req.query.hasta || ymd(new Date());
    const desde = req.query.desde || hasta;
    const [analistas] = await pool.query(
      `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON u.id_perfil = p.id_perfil WHERE p.nombre IN (?)`,
      [PERFILES_ANALISTA]);
    const ids = analistas.map(a => a.id_usuario);
    if (!ids.length) return res.json({ success: true, data: [], error: null });

    const [ses] = await pool.query(
      `SELECT id_usuario, login_at, last_seen, logout_at FROM sesiones_usuario
       WHERE id_usuario IN (?) AND login_at < (? + INTERVAL 1 DAY) AND COALESCE(logout_at, last_seen) >= ?`,
      [ids, hasta, desde]);
    const [creadas] = await pool.query(
      `SELECT id, DATE(fecha_creacion) f, status FROM cartas_aprobacion WHERE DATE(fecha_creacion) BETWEEN ? AND ?`, [desde, hasta]);
    const [aprob] = await pool.query(
      `SELECT id, DATE(fecha_aprobacion) f FROM cartas_aprobacion
         WHERE aprobado_por IS NOT NULL AND DATE(fecha_aprobacion) BETWEEN ? AND ?`, [desde, hasta]);
    const [rech] = await pool.query(
      `SELECT id, DATE(fecha_rechazo) f FROM cartas_aprobacion
         WHERE rechazado_por IS NOT NULL AND DATE(fecha_rechazo) BETWEEN ? AND ?`, [desde, hasta]);
    const [opened] = await pool.query(
      `SELECT DISTINCT id_carta, DATE(ts) f FROM carta_eventos WHERE accion='abrir' AND DATE(ts) BETWEEN ? AND ?`, [desde, hasta]);

    const ing = {}, pend = {}, ap = {}, re = {}, apIds = {}, reIds = {}, opIds = {};
    creadas.forEach(c => { const k = ymd(new Date(c.f)); ing[k] = (ing[k] || 0) + 1; if (c.status === 'PENDIENTE') pend[k] = (pend[k] || 0) + 1; });
    aprob.forEach(c => { const k = ymd(new Date(c.f)); ap[k] = (ap[k] || 0) + 1; (apIds[k] = apIds[k] || new Set()).add(c.id); });
    rech.forEach(c => { const k = ymd(new Date(c.f)); re[k] = (re[k] || 0) + 1; (reIds[k] = reIds[k] || new Set()).add(c.id); });
    opened.forEach(o => { const k = ymd(new Date(o.f)); (opIds[k] = opIds[k] || new Set()).add(o.id_carta); });

    const out = [];
    let d = new Date(desde + 'T00:00:00'), end = new Date(hasta + 'T00:00:00');
    while (d <= end) {
      const fk = ymd(d);
      const { ini, fin } = ventana(fk);
      const conectadosMin = {};
      ses.forEach(s => {
        const s0 = new Date(s.login_at), s1 = finSesion(s);
        const m = overlapMin(s0.getTime(), s1.getTime(), ini.getTime(), fin.getTime());
        if (m > 0) conectadosMin[s.id_usuario] = (conectadosMin[s.id_usuario] || 0) + m;
      });
      const personas = Object.keys(conectadosMin).length;
      const totalMin = Object.values(conectadosMin).reduce((a, b) => a + b, 0);
      // ignoradas: abiertas ese día que no fueron decididas ese día
      const decididas = new Set([...(apIds[fk] || []), ...(reIds[fk] || [])]);
      const ignoradas = [...(opIds[fk] || [])].filter(id => !decididas.has(id)).length;
      out.push({
        fecha: fk,
        dia_semana: DIAS[d.getDay()],
        promedio_conectados: Math.round((totalMin / 540) * 100) / 100, // 540 min = 9h
        personas,
        ingresadas: ing[fk] || 0,
        aprobadas: ap[fk] || 0,
        rechazadas: re[fk] || 0,
        ignoradas,
        pendientes: pend[fk] || 0,
      });
      d.setDate(d.getDate() + 1);
    }
    out.reverse();
    res.json({ success: true, data: out, error: null });
  } catch (e) {
    console.error('[desempeno diario]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── GET /api/desempeno/cartas/dia?fecha=YYYY-MM-DD ──────────────── */
const reporteDia = async (req, res) => {
  try {
    const fecha = req.query.fecha || ymd(new Date());
    const ini = fecha + ' 00:00:00', fin = fecha + ' 23:59:59';
    const [analistas] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) nombre, p.nombre perfil
       FROM usuarios u JOIN perfiles p ON u.id_perfil = p.id_perfil WHERE p.nombre IN (?)`, [PERFILES_ANALISTA]);
    const byId = {}; analistas.forEach(a => byId[a.id_usuario] = a);
    const ids = analistas.map(a => a.id_usuario);
    if (!ids.length) return res.json({ success: true, data: { fecha, dia_semana: DIAS[new Date(fecha + 'T00:00:00').getDay()], personas: [] }, error: null });

    const [ses] = await pool.query(
      `SELECT id_usuario, login_at, last_seen, logout_at FROM sesiones_usuario
       WHERE id_usuario IN (?) AND login_at <= ? AND COALESCE(logout_at, last_seen) >= ?`, [ids, fin, ini]);
    const [aprob] = await pool.query(
      `SELECT id, aprobado_por_nombre, fecha_aprobacion FROM cartas_aprobacion
        WHERE aprobado_por IS NOT NULL AND DATE(fecha_aprobacion) = ?`, [fecha]);
    const [rechs] = await pool.query(
      `SELECT id, rechazado_por_nombre, fecha_rechazo FROM cartas_aprobacion
        WHERE rechazado_por IS NOT NULL AND DATE(fecha_rechazo) = ?`, [fecha]);
    const [abrs] = await pool.query(
      `SELECT id_carta, id_usuario, ts FROM carta_eventos
        WHERE accion='abrir' AND id_usuario IN (?) AND DATE(ts) = ?`, [ids, fecha]);
    // cartas creadas ese día (para denominador "disponibles")
    const [creadas] = await pool.query(
      `SELECT id, fecha_creacion FROM cartas_aprobacion WHERE DATE(fecha_creacion) = ?`, [fecha]);

    // Agrupar por persona
    const sesByU = {}; ses.forEach(s => (sesByU[s.id_usuario] = sesByU[s.id_usuario] || []).push(s));
    const abrByU = {}; abrs.forEach(a => (abrByU[a.id_usuario] = abrByU[a.id_usuario] || []).push(a));
    // decisiones por nombre (cartas_aprobacion guarda nombre, no id)
    const decByNombre = {};
    aprob.forEach(c => { const k = c.aprobado_por_nombre; (decByNombre[k] = decByNombre[k] || []).push({ id: c.id, tipo: 'aprob', ts: new Date(c.fecha_aprobacion) }); });
    rechs.forEach(c => { const k = c.rechazado_por_nombre; (decByNombre[k] = decByNombre[k] || []).push({ id: c.id, tipo: 'rech', ts: new Date(c.fecha_rechazo) }); });

    const personas = [];
    const usuariosDelDia = new Set([...Object.keys(sesByU), ...Object.keys(abrByU)].map(Number));
    for (const uid of usuariosDelDia) {
      const info = byId[uid]; if (!info) continue;
      const mySes = (sesByU[uid] || []).map(s => ({ ini: new Date(s.login_at), fin: finSesion(s) }));
      let totalMin = 0, primer = null, ultimo = null;
      mySes.forEach(s => {
        totalMin += (s.fin - s.ini) / 60000;
        if (!primer || s.ini < primer) primer = s.ini;
        if (!ultimo || s.fin > ultimo) ultimo = s.fin;
      });
      const misAbiertas = abrByU[uid] || [];
      const cartasAbiertas = new Set(misAbiertas.map(a => a.id_carta));
      const revisó = cartasAbiertas.size;
      const decs = decByNombre[info.nombre] || [];
      const aprobó = decs.filter(x => x.tipo === 'aprob').length;
      const rechazó = decs.filter(x => x.tipo === 'rech').length;
      const decididasIds = new Set(decs.map(x => x.id));
      const ignoró = [...cartasAbiertas].filter(id => !decididasIds.has(id)).length;
      // tiempos: por cada decisión, última apertura previa de esa carta por el usuario
      const tProm = (tipo) => {
        const arr = decs.filter(x => x.tipo === tipo);
        const difs = [];
        arr.forEach(dec => {
          const opens = misAbiertas.filter(a => a.id_carta === dec.id && new Date(a.ts) <= dec.ts);
          if (opens.length) {
            const lastOpen = opens.reduce((m, a) => new Date(a.ts) > new Date(m.ts) ? a : m);
            difs.push((dec.ts - new Date(lastOpen.ts)) / 60000);
          }
        });
        return difs.length ? Math.round((difs.reduce((a, b) => a + b, 0) / difs.length) * 10) / 10 : null;
      };
      // denominador: cartas creadas mientras estaba conectado ese día
      const dispo = creadas.filter(c => {
        const t = new Date(c.fecha_creacion).getTime();
        return mySes.some(s => t >= s.ini.getTime() && t <= s.fin.getTime());
      }).length;
      personas.push({
        nombre: info.nombre, perfil: info.perfil,
        login: primer ? primer.toTimeString().slice(0, 5) : '—',
        logout: ultimo ? ultimo.toTimeString().slice(0, 5) : '—',
        horas: Math.round((totalMin / 60) * 100) / 100,
        aprobó, rechazó, ignoró, revisó,
        t_aprobar: tProm('aprob'), t_rechazar: tProm('rech'),
        pct_aprob: revisó ? Math.round(aprobó / revisó * 1000) / 10 : 0,
        pct_rech:  revisó ? Math.round(rechazó / revisó * 1000) / 10 : 0,
        pct_ignor: revisó ? Math.round(ignoró / revisó * 1000) / 10 : 0,
        pct_revisó: dispo ? Math.round(revisó / dispo * 1000) / 10 : null,
        disponibles: dispo,
      });
    }
    personas.sort((a, b) => (b.aprobó + b.rechazó) - (a.aprobó + a.rechazó));
    res.json({ success: true, data: { fecha, dia_semana: DIAS[new Date(fecha + 'T00:00:00').getDay()], personas }, error: null });
  } catch (e) {
    console.error('[desempeno dia]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { registrarLogin, ping, logout, logApertura, reporteDiario, reporteDia };
