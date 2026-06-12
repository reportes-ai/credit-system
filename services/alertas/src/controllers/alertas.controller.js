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
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    // Columnas para la campanita: clave de dedup + prioridad
    await pool.query(`ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS clave VARCHAR(140) DEFAULT NULL`).catch(()=>{});
    await pool.query(`ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS prioridad VARCHAR(10) DEFAULT 'normal'`).catch(()=>{});
    await pool.query(`CREATE INDEX idx_notif_clave ON notificaciones (clave)`).catch(()=>{});

    // Ejemplo inicial (solo si la tabla está vacía): cartas pendientes > 2 min, prioridad alta
    const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM alertas_config');
    if (c === 0) {
      await pool.query(
        `INSERT INTO alertas_config (nombre, origen, campo, operador, valor1, prioridad, destino, activo)
         VALUES (?,?,?,?,?,?,?,1)`,
        ['Cartas pendientes en el pool', 'cartas_pendientes', 'minutos', 'mayor', '2', 'alta', 'Administrador']);
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
};

/* Operadores: cuántos valores requieren (para que el mantenedor pinte 1 o 2 inputs) */
const OPERADORES = [
  { op: 'mayor',    label: 'Mayor que (>)',        valores: 1 },
  { op: 'menor',    label: 'Menor que (<)',        valores: 1 },
  { op: 'entre',    label: 'Entre (mín y máx)',    valores: 2 },
  { op: 'igual',    label: 'Igual a (=)',          valores: 1 },
  { op: 'contiene', label: 'Contiene (texto, separar con ;)', valores: 1 },
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

async function usuariosDestino(destino) {
  if (!destino || destino === 'TODOS') {
    const [u] = await pool.query("SELECT id_usuario FROM usuarios WHERE estado IS NULL OR estado <> 'inactivo'");
    return u.map(x => x.id_usuario);
  }
  const [u] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON u.id_perfil = p.id_perfil WHERE p.nombre = ?`, [destino]);
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
      const users = await usuariosDestino(rg.destino);
      const clavesActivas = [];
      for (const f of filas) {
        if (!cumple(f.vars[rg.campo], rg.operador, rg.valor1, rg.valor2)) continue;
        const clave = `alerta:${rg.id}:${f.key}`;
        clavesActivas.push(clave);
        for (const uid of users) {
          const [[ex]] = await pool.query(
            'SELECT 1 FROM notificaciones WHERE id_usuario = ? AND clave = ? AND leida = 0 LIMIT 1', [uid, clave]);
          if (ex) continue; // ya notificado y sin leer → no duplicar
          await pool.query(
            `INSERT INTO notificaciones (id_usuario, tipo, titulo, mensaje, href, clave, prioridad)
             VALUES (?,?,?,?,?,?,?)`,
            [uid, 'alerta', rg.nombre || f.titulo, f.mensaje, f.href, clave, rg.prioridad || 'normal']);
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
    res.json({ success: true, data: { origenes, operadores: OPERADORES, perfiles: perfiles.map(p => p.nombre) }, error: null });
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
    const { id, nombre, origen, campo, operador, valor1, valor2, prioridad, destino, activo } = req.body;
    if (!nombre || !ORIGENES[origen] || !OPERADORES.find(o => o.op === operador))
      return res.status(400).json({ success: false, data: null, error: 'nombre, origen y operador válidos requeridos' });
    const params = [nombre, origen, campo, operador, valor1 ?? null, valor2 ?? null, prioridad || 'normal', destino || 'Administrador', activo ? 1 : 0];
    if (id) {
      await pool.query(
        `UPDATE alertas_config SET nombre=?, origen=?, campo=?, operador=?, valor1=?, valor2=?, prioridad=?, destino=?, activo=? WHERE id=?`,
        [...params, id]);
    } else {
      await pool.query(
        `INSERT INTO alertas_config (nombre, origen, campo, operador, valor1, valor2, prioridad, destino, activo)
         VALUES (?,?,?,?,?,?,?,?,?)`, params);
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
