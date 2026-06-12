'use strict';
const pool = require('../../../../shared/config/database');

/* ════════════════════════════════════════════════════════════════
   MOTOR DE ALERTAS CONFIGURABLE
   - Reglas en tabla alertas_config (editables en mantenedor "Alertas").
   - Cada regla apunta a un "origen" predefinido (consulta segura) y a un
     "campo/variable" de ese origen, con un operador y valores.
   - El motor evalúa cada minuto: por cada registro que cumple, genera una
     notificación (con dedup por "clave"); cuando un registro deja de
     cumplir (ej: otro analista tomó la carta), borra su notificación.
   ════════════════════════════════════════════════════════════════ */

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alertas_config (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        nombre      VARCHAR(120) NOT NULL,
        origen      VARCHAR(50)  NOT NULL,
        campo       VARCHAR(50)  NOT NULL,
        operador    VARCHAR(20)  NOT NULL,   -- mayor | menor | entre | igual | contiene
        valor1      VARCHAR(200) DEFAULT NULL,
        valor2      VARCHAR(200) DEFAULT NULL,
        prioridad   VARCHAR(10)  NOT NULL DEFAULT 'normal',  -- normal | alta
        destino     VARCHAR(80)  NOT NULL DEFAULT 'Administrador', -- nombre de perfil o 'TODOS'
        activo      TINYINT(1)   NOT NULL DEFAULT 1,
        sonido      TINYINT(1)   NOT NULL DEFAULT 1,
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    // Columnas para la campanita: clave de dedup + prioridad + si suena
    await pool.query(`ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS clave VARCHAR(140) DEFAULT NULL`).catch(()=>{});
    await pool.query(`ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS prioridad VARCHAR(10) DEFAULT 'normal'`).catch(()=>{});
    await pool.query(`ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS sonar TINYINT(1) DEFAULT 1`).catch(()=>{});
    await pool.query(`ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS son_cada INT DEFAULT 30`).catch(()=>{});
    await pool.query(`ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS son_max INT DEFAULT 5`).catch(()=>{});
    await pool.query(`ALTER TABLE alertas_config ADD COLUMN IF NOT EXISTS sonido TINYINT(1) NOT NULL DEFAULT 1`).catch(()=>{});
    await pool.query(`ALTER TABLE alertas_config ADD COLUMN IF NOT EXISTS delay_min INT NOT NULL DEFAULT 60`).catch(()=>{});
    await pool.query(`ALTER TABLE alertas_config ADD COLUMN IF NOT EXISTS sonido_cada_seg INT NOT NULL DEFAULT 30`).catch(()=>{});
    await pool.query(`ALTER TABLE alertas_config ADD COLUMN IF NOT EXISTS sonido_max_min INT NOT NULL DEFAULT 5`).catch(()=>{});
    await pool.query(`ALTER TABLE alertas_config ADD COLUMN IF NOT EXISTS sonido_tipo VARCHAR(20) NOT NULL DEFAULT 'campana'`).catch(()=>{});
    await pool.query(`ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS son_tipo VARCHAR(20) DEFAULT 'campana'`).catch(()=>{});
    await pool.query(`ALTER TABLE alertas_config MODIFY COLUMN destino VARCHAR(250) NOT NULL DEFAULT 'Administrador'`).catch(()=>{});
    await pool.query(`CREATE INDEX idx_notif_clave ON notificaciones (clave)`).catch(()=>{});

    // Ejemplos iniciales (solo si la tabla está vacía). El usuario los edita/activa en el mantenedor.
    const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM alertas_config');
    if (c === 0) {
      const ej = [
        ['Cartas pendientes en el pool',        'cartas_pendientes',  'minutos', 'mayor', '2',  null, 'alta',   'Administrador', 1, 1],
        ['Carta rechazada sin corregir +1 día', 'cartas_rechazadas',  'dias',    'mayor', '1',  null, 'alta',   'CREADOR', 1, 1],
        ['Saldo liberado sin pagar +3 días',    'saldos_liberados',   'dias',    'mayor', '3',  null, 'normal', 'Administrador', 1, 1],
        ['Fundantes pendientes +5 días',        'fundantes_pendientes','dias',   'mayor', '5',  null, 'normal', 'Administrador', 1, 0],
        ['Comisión sin pagar +30 días',         'comision_sin_pagar', 'dias',    'mayor', '30', null, 'normal', 'Administrador', 0, 1],
        ['Operación en INGRESO +2 días',        'creditos_ingreso',   'dias',    'mayor', '2',  null, 'normal', 'Administrador', 0, 1],
      ];
      for (const e of ej) {
        await pool.query(
          `INSERT INTO alertas_config (nombre, origen, campo, operador, valor1, valor2, prioridad, destino, activo, sonido)
           VALUES (?,?,?,?,?,?,?,?,?,?)`, e);
      }
    }
    console.log('[alertas] tabla OK');
  } catch (e) { console.error('[alertas migration]', e.message); }
})();

/* ── Orígenes predefinidos (consultas seguras + variables disponibles) ── */
const ORIGENES = {
  cartas_pendientes: {
    label: 'Cartas pendientes en el pool',
    href: '/aprobaciones/',
    campos: [
      { campo: 'minutos', label: 'Minutos en el pool', tipo: 'numero' },
      { campo: 'saldo',   label: 'Saldo ($)',          tipo: 'numero' },
      { campo: 'ejecutivo_nombre', label: 'Ejecutivo',  tipo: 'texto' },
      { campo: 'tipo',    label: 'Tipo de carta',       tipo: 'texto' },
    ],
    async filas() {
      const [rows] = await pool.query(
        `SELECT id, op_carta, ejecutivo_nombre, tipo, saldo,
                TIMESTAMPDIFF(MINUTE, fecha_creacion, NOW()) AS minutos
         FROM cartas_aprobacion WHERE status = 'PENDIENTE'`);
      return rows.map(r => ({
        key: 'carta:' + r.id,
        vars: { minutos: r.minutos, saldo: r.saldo, ejecutivo_nombre: r.ejecutivo_nombre, tipo: r.tipo },
        titulo: 'Carta pendiente',
        mensaje: `Carta ${r.op_carta || r.id} de ${r.ejecutivo_nombre || '—'} lleva ${r.minutos} min en el pool sin tomar.`,
        href: '/aprobaciones/',
      }));
    },
  },
  saldos_liberados: {
    label: 'Saldos liberados a pago sin pagar',
    href: '/postventa/saldos-a-pagar/',
    campos: [
      { campo: 'dias',         label: 'Días liberado sin pagar', tipo: 'numero' },
      { campo: 'saldo_precio', label: 'Saldo precio ($)',        tipo: 'numero' },
    ],
    async filas() {
      const [rows] = await pool.query(`
        SELECT s.id, s.num_op, s.saldo_precio,
               DATEDIFF(CURDATE(), DATE(elp.fecha)) AS dias
        FROM postventa_seguimiento s
        JOIN postventa_etapas elp ON elp.id_seguimiento = s.id AND elp.track='SALDO' AND elp.etapa='LIBERADO A PAGO'
        WHERE NOT EXISTS (SELECT 1 FROM postventa_etapas e
          WHERE e.id_seguimiento = s.id AND e.track='SALDO' AND e.etapa='SALDO PRECIO PAGADO')`);
      return rows.map(r => ({
        key: 'saldo:' + r.id,
        vars: { dias: r.dias, saldo_precio: r.saldo_precio },
        titulo: 'Saldo sin pagar',
        mensaje: `OP ${r.num_op} lleva ${r.dias} día(s) liberada a pago sin pagar ($${Number(r.saldo_precio||0).toLocaleString('es-CL')}).`,
        href: '/postventa/saldos-a-pagar/',
      }));
    },
  },
  fundantes_pendientes: {
    label: 'Fundantes pendientes (sin liberar a pago)',
    href: '/postventa/seguimiento/',
    campos: [
      { campo: 'dias',         label: 'Días desde otorgado', tipo: 'numero' },
      { campo: 'saldo_precio', label: 'Saldo precio ($)',    tipo: 'numero' },
    ],
    async filas() {
      const [rows] = await pool.query(`
        SELECT s.id, s.num_op, s.saldo_precio, DATEDIFF(CURDATE(), s.fecha_otorgado) AS dias
        FROM postventa_seguimiento s
        WHERE s.fecha_otorgado IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='SALDO' AND e.etapa='LIBERADO A PAGO')
          AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='SALDO' AND e.etapa='SALDO PRECIO PAGADO')`);
      return rows.map(r => ({
        key: 'fund:' + r.id,
        vars: { dias: r.dias, saldo_precio: r.saldo_precio },
        titulo: 'Fundantes pendientes',
        mensaje: `OP ${r.num_op} lleva ${r.dias} día(s) otorgada con fundantes aún sin liberar a pago.`,
        href: '/postventa/seguimiento/',
      }));
    },
  },
  comision_sin_pagar: {
    label: 'Comisión sin pagar',
    href: '/postventa/seguimiento/',
    campos: [
      { campo: 'dias',     label: 'Días desde otorgado', tipo: 'numero' },
      { campo: 'comision', label: 'Comisión ($)',        tipo: 'numero' },
    ],
    async filas() {
      const [rows] = await pool.query(`
        SELECT s.id, s.num_op, s.comision, DATEDIFF(CURDATE(), s.fecha_otorgado) AS dias
        FROM postventa_seguimiento s
        WHERE s.fecha_otorgado IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM postventa_etapas e WHERE e.id_seguimiento=s.id AND e.track='COMISION' AND e.etapa='COMISION PAGADA')`);
      return rows.map(r => ({
        key: 'com:' + r.id,
        vars: { dias: r.dias, comision: r.comision },
        titulo: 'Comisión sin pagar',
        mensaje: `OP ${r.num_op} lleva ${r.dias} día(s) otorgada con comisión sin pagar ($${Number(r.comision||0).toLocaleString('es-CL')}).`,
        href: '/postventa/seguimiento/',
      }));
    },
  },
  cartas_rechazadas: {
    label: 'Cartas rechazadas (a corregir)',
    href: '/aprobaciones/',
    campos: [
      { campo: 'dias',             label: 'Días desde rechazo', tipo: 'numero' },
      { campo: 'ejecutivo_nombre', label: 'Ejecutivo',          tipo: 'texto' },
    ],
    async filas() {
      // creado_por (email) → usuarios.email para notificar al creador
      const [rows] = await pool.query(`
        SELECT c.id, c.op_carta, c.ejecutivo_nombre,
               DATEDIFF(CURDATE(), DATE(c.fecha_creacion)) AS dias,
               u.id_usuario AS creador
        FROM cartas_aprobacion c
        LEFT JOIN usuarios u ON u.email = c.creado_por
        WHERE c.status = 'RECHAZADA'`);
      return rows.map(r => ({
        key: 'rech:' + r.id,
        vars: { dias: r.dias, ejecutivo_nombre: r.ejecutivo_nombre },
        creador: r.creador || null,
        titulo: 'Carta rechazada',
        mensaje: `Carta ${r.op_carta || r.id} rechazada hace ${r.dias} día(s). Debes corregirla.`,
        href: '/aprobaciones/',
      }));
    },
  },
  cartas_aprobadas: {
    label: 'Cartas aprobadas (avisar al creador)',
    href: '/aprobaciones/',
    campos: [
      { campo: 'dias',             label: 'Días desde aprobación', tipo: 'numero' },
      { campo: 'ejecutivo_nombre', label: 'Ejecutivo',             tipo: 'texto' },
    ],
    async filas() {
      const [rows] = await pool.query(`
        SELECT c.id, c.op_carta, c.ejecutivo_nombre,
               DATEDIFF(CURDATE(), DATE(COALESCE(c.fecha_aprobacion, c.fecha_creacion))) AS dias,
               u.id_usuario AS creador
        FROM cartas_aprobacion c
        LEFT JOIN usuarios u ON u.email = c.creado_por
        WHERE c.status = 'APROBADA'`);
      return rows.map(r => ({
        key: 'aprob:' + r.id,
        vars: { dias: r.dias, ejecutivo_nombre: r.ejecutivo_nombre },
        creador: r.creador || null,
        titulo: 'Carta aprobada',
        mensaje: `Tu carta ${r.op_carta || r.id} fue aprobada. 🎉`,
        href: '/aprobaciones/',
      }));
    },
  },
  creditos_ingreso: {
    label: 'Operaciones en INGRESO sin otorgar',
    href: '/creditos/',
    campos: [
      { campo: 'dias',      label: 'Días en INGRESO', tipo: 'numero' },
      { campo: 'ejecutivo', label: 'Ejecutivo',       tipo: 'texto' },
    ],
    async filas() {
      const [rows] = await pool.query(`
        SELECT id, num_op, ejecutivo, DATEDIFF(CURDATE(), DATE(fecha_estado)) AS dias
        FROM creditos WHERE estado = 'INGRESO' AND fecha_estado IS NOT NULL`);
      return rows.map(r => ({
        key: 'ing:' + r.id,
        vars: { dias: r.dias, ejecutivo: r.ejecutivo },
        titulo: 'Operación en INGRESO',
        mensaje: `OP ${r.num_op} (${r.ejecutivo || '—'}) lleva ${r.dias} día(s) en INGRESO sin otorgar.`,
        href: '/creditos/',
      }));
    },
  },
};

/* Operadores: cuántos valores requieren (para que el mantenedor pinte 1 o 2 inputs) */
const OPERADORES = [
  { op: 'mayor',    label: 'Mayor que (>)',        valores: 1 },
  { op: 'menor',    label: 'Menor que (<)',        valores: 1 },
  { op: 'entre',    label: 'Entre (mín y máx)',    valores: 2 },
  { op: 'igual',    label: 'Igual a (=)',          valores: 1 },
  { op: 'contiene', label: 'Contiene (texto, separar con ;)', valores: 1 },
];

const SONIDOS = [
  { id: 'campana',  label: '🛎️ Campana (hotel)' },
  { id: 'dingdong', label: '🔔 Timbre (ding-dong)' },
  { id: 'alarma',   label: '🚨 Alarma (sirena)' },
  { id: 'aplausos', label: '👏 Aplausos' },
];

function cumple(val, op, v1, v2) {
  if (op === 'mayor') return Number(val) >  Number(v1);
  if (op === 'menor') return Number(val) <  Number(v1);
  if (op === 'entre') return Number(val) >= Number(v1) && Number(val) <= Number(v2);
  if (op === 'igual') return String(val) === String(v1);
  if (op === 'contiene') {
    const toks = String(v1 || '').split(';').map(s => s.trim().toLowerCase()).filter(Boolean);
    const s = String(val ?? '').toLowerCase();
    return toks.some(t => s.includes(t));
  }
  return false;
}

/* Usuarios fijos de la regla (por perfil o TODOS). El token 'CREADOR' se
   resuelve por registro en el motor (no aquí). */
async function usuariosBase(destino) {
  const lista = String(destino || '').split(',').map(s => s.trim()).filter(Boolean);
  if (lista.includes('TODOS')) {
    const [u] = await pool.query("SELECT id_usuario FROM usuarios WHERE estado IS NULL OR estado <> 'inactivo'");
    return u.map(x => x.id_usuario);
  }
  const perfiles = lista.filter(t => t !== 'CREADOR');
  if (!perfiles.length) return [];
  const [u] = await pool.query(
    `SELECT DISTINCT u.id_usuario FROM usuarios u JOIN perfiles p ON u.id_perfil = p.id_perfil WHERE p.nombre IN (?)`, [perfiles]);
  return u.map(x => x.id_usuario);
}

/* ── Evaluación periódica ───────────────────────────────────────── */
let evaluando = false;
async function evaluarAlertas() {
  if (evaluando) return; evaluando = true;
  try {
    const [reglas] = await pool.query('SELECT * FROM alertas_config WHERE activo = 1');
    for (const rg of reglas) {
      const orig = ORIGENES[rg.origen];
      if (!orig) continue;
      let filas;
      try { filas = await orig.filas(); } catch (e) { console.error('[alertas origen]', rg.origen, e.message); continue; }
      const base = await usuariosBase(rg.destino);
      const usaCreador = String(rg.destino || '').split(',').map(s => s.trim()).includes('CREADOR');
      const clavesActivas = [];
      for (const f of filas) {
        if (!cumple(f.vars[rg.campo], rg.operador, rg.valor1, rg.valor2)) continue;
        const clave = `alerta:${rg.id}:${f.key}`;
        clavesActivas.push(clave);
        // Destinatarios: base (perfiles/TODOS) + creador del registro si la regla usa 'CREADOR'
        let users = base.slice();
        if (usaCreador && f.creador) users.push(f.creador);
        users = [...new Set(users)];
        for (const uid of users) {
          // Dedup + delay: no re-notificar si hay una sin leer, o una (leída o no) creada
          // dentro de la ventana de "delay" (cooldown configurable por alerta).
          const [[ex]] = await pool.query(
            `SELECT 1 FROM notificaciones WHERE id_usuario = ? AND clave = ?
               AND (leida = 0 OR created_at > (NOW() - INTERVAL ? MINUTE)) LIMIT 1`,
            [uid, clave, rg.delay_min || 0]);
          if (ex) continue;
          await pool.query(
            `INSERT INTO notificaciones (id_usuario, tipo, titulo, mensaje, href, clave, prioridad, sonar, son_cada, son_max, son_tipo)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [uid, 'alerta', rg.nombre || f.titulo, f.mensaje, f.href, clave, rg.prioridad || 'normal',
             rg.sonido ? 1 : 0, rg.sonido_cada_seg || 30, rg.sonido_max_min || 5, rg.sonido_tipo || 'campana']);
        }
      }
      // Resolver: borrar notificaciones no leídas de esta regla cuyo registro ya no cumple
      const inList = clavesActivas.length ? clavesActivas : ['__none__'];
      await pool.query(
        `DELETE FROM notificaciones WHERE clave LIKE ? AND leida = 0 AND clave NOT IN (?)`,
        [`alerta:${rg.id}:%`, inList]);
    }
  } catch (e) { console.error('[alertas evaluar]', e.message); }
  finally { evaluando = false; }
}
setTimeout(evaluarAlertas, 8000);          // primera corrida al arrancar
setInterval(evaluarAlertas, 60000);        // cada 60s

/* ── Endpoints CRUD + metadatos ─────────────────────────────────── */
const getMeta = async (req, res) => {
  try {
    const origenes = Object.entries(ORIGENES).map(([id, o]) => ({ id, label: o.label, campos: o.campos }));
    const [perfiles] = await pool.query('SELECT nombre FROM perfiles ORDER BY nombre');
    res.json({ success: true, data: { origenes, operadores: OPERADORES, sonidos: SONIDOS, perfiles: perfiles.map(p => p.nombre) }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const listAlertas = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM alertas_config ORDER BY id DESC');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const saveAlerta = async (req, res) => {
  try {
    let { id, nombre, origen, campo, operador, valor1, valor2, prioridad, destino, destinos, activo, sonido, delay_min, sonido_cada_seg, sonido_max_min, sonido_tipo } = req.body;
    if (!nombre || !ORIGENES[origen] || !OPERADORES.find(o => o.op === operador))
      return res.status(400).json({ success: false, data: null, error: 'nombre, origen y operador válidos requeridos' });
    // destino acepta string CSV o arreglo (hasta 3 perfiles)
    if (Array.isArray(destinos)) destino = destinos.filter(Boolean).slice(0, 3).join(',');
    const tipoSon = SONIDOS.find(s => s.id === sonido_tipo) ? sonido_tipo : 'campana';
    const params = [nombre, origen, campo, operador, valor1 ?? null, valor2 ?? null, prioridad || 'normal',
      destino || 'Administrador', activo ? 1 : 0, sonido ? 1 : 0,
      Math.max(0, parseInt(delay_min) || 0), Math.max(5, parseInt(sonido_cada_seg) || 30), Math.max(1, parseInt(sonido_max_min) || 5), tipoSon];
    if (id) {
      await pool.query(
        `UPDATE alertas_config SET nombre=?, origen=?, campo=?, operador=?, valor1=?, valor2=?, prioridad=?, destino=?, activo=?, sonido=?, delay_min=?, sonido_cada_seg=?, sonido_max_min=?, sonido_tipo=? WHERE id=?`,
        [...params, id]);
    } else {
      await pool.query(
        `INSERT INTO alertas_config (nombre, origen, campo, operador, valor1, valor2, prioridad, destino, activo, sonido, delay_min, sonido_cada_seg, sonido_max_min, sonido_tipo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params);
    }
    evaluarAlertas();
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[alertas save]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const deleteAlerta = async (req, res) => {
  try {
    await pool.query('DELETE FROM alertas_config WHERE id = ?', [req.params.id]);
    await pool.query('DELETE FROM notificaciones WHERE clave LIKE ? AND leida = 0', [`alerta:${req.params.id}:%`]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getMeta, listAlertas, saveAlerta, deleteAlerta };
