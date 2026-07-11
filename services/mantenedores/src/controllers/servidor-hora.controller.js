'use strict';
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

// Migración: agregar parámetro db_tz_override si no existe
require('../../../../shared/migrate').enFila('servidor-hora', async () => {
  try {
    await pool.query(`
      INSERT IGNORE INTO parametros_credito (clave, valor, descripcion)
      VALUES ('db_tz_override', '', 'Override manual timezone BD (vacío = automático Chile DST)')
    `);
    // Card en Mantenedores (funcionalidad + permiso Administrador)
    const [[m]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre = 'Mantenedores' LIMIT 1");
    if (m) {
      let [[f]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo = 'mant_servidor_hora' LIMIT 1");
      if (!f) {
        const [r] = await pool.query(
          "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)",
          [m.id_modulo, 'Hora del Servidor', 'mant_servidor_hora', '/mantenedores/servidor-hora/', 'bi-clock-history']);
        f = { id_funcionalidad: r.insertId };
      }
      const [[adm]] = await pool.query("SELECT id_perfil FROM perfiles WHERE nombre = 'Administrador' LIMIT 1");
      if (adm) await pool.query("INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)", [adm.id_perfil, f.id_funcionalidad]);
    }
  } catch(e) { console.error('[servidor-hora migration]', e.message); }
});

/* Próximo cambio de horario DST en Chile */
function proximoCambioDST() {
  const now  = new Date();
  const year = now.getFullYear();
  const candidatos = [];
  for (let y = year; y <= year + 1; y++) {
    const mar = new Date(y, 2, 31);
    mar.setDate(31 - ((mar.getDay() + 1) % 7));
    mar.setHours(24, 0, 0, 0);
    candidatos.push({ fecha: mar, evento: `Cambio a INVIERNO (UTC-4) — ${mar.toLocaleDateString('es-CL')}` });
    const sep = new Date(y, 8, 1);
    sep.setDate(1 + ((6 - sep.getDay() + 7) % 7));
    sep.setHours(24, 0, 0, 0);
    candidatos.push({ fecha: sep, evento: `Cambio a VERANO (UTC-3) — ${sep.toLocaleDateString('es-CL')}` });
  }
  return candidatos.filter(c => c.fecha > now).sort((a, b) => a.fecha - b.fecha)[0] || null;
}

/* GET /api/servidor-hora */
exports.getInfo = async (req, res) => {
  try {
    const ahora = new Date();
    const horaChile = ahora.toLocaleString('es-CL', {
      timeZone: 'America/Santiago',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    const horaUTC = ahora.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    // Modo DST
    let chileTZ = 'GMT-04:00 (CLT)', modoActual = 'INVIERNO (UTC-4)';
    try {
      const parts = Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', timeZoneName: 'short' })
        .formatToParts(ahora);
      const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || '';
      if (tzPart.includes('CLST') || tzPart.includes('-3')) {
        chileTZ = 'GMT-03:00 (CLST)'; modoActual = 'VERANO (UTC-3)';
      }
    } catch(e) {}

    const tzProceso   = process.env.TZ || 'No configurado';
    const tzActivo    = pool.getActiveTZ();
    const tzOverride  = pool.getTZOverride();
    const tzAuto      = pool.getChileAutoOffset();

    const [[bdRow]] = await pool.query(
      'SELECT NOW() AS ahora_bd, @@global.time_zone AS tz_global, @@session.time_zone AS tz_session'
    );
    const [[ultimaOp]] = await pool.query(
      'SELECT id, num_op, updated_at AS created_at FROM creditos ORDER BY updated_at DESC LIMIT 1'
    );
    const [[ultimoCliente]] = await pool.query(
      'SELECT id_cliente, rut, fecha_creacion AS created_at FROM clientes ORDER BY fecha_creacion DESC LIMIT 1'
    );

    const proximo = proximoCambioDST();

    res.json({ success: true, data: {
      hora_chile:       horaChile,
      hora_utc:         horaUTC,
      modo_dst:         modoActual,
      offset_chile:     chileTZ,
      tz_proceso:       tzProceso,
      tz_bd_activo:     tzActivo,
      tz_bd_override:   tzOverride || '',
      tz_bd_auto:       tzAuto,
      tz_mysql2:        (typeof pool.getMysql2TZ === 'function') ? pool.getMysql2TZ() : null,
      bd_now:           bdRow?.ahora_bd,
      bd_tz_global:     bdRow?.tz_global,
      bd_tz_session:    bdRow?.tz_session,
      ultima_operacion: ultimaOp  || null,
      ultimo_cliente:   ultimoCliente || null,
      proximo_dst:      proximo ? proximo.evento : 'No determinado',
    }, error: null });
  } catch(e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* POST /api/servidor-hora/tz-override  { valor: '-03:00' | '' } */
exports.setTZOverride = async (req, res) => {
  try {
    const valor = (req.body.valor || '').trim();
    // Validar formato (vacío, +HH:MM, -HH:MM)
    if (valor !== '' && !/^[+-]\d{2}:\d{2}$/.test(valor)) {
      return res.status(400).json({ success: false, error: 'Formato inválido. Use +HH:MM o -HH:MM (ej: -04:00)' });
    }
    await pool.query(
      "UPDATE parametros_credito SET valor = ? WHERE clave = 'db_tz_override'", [valor]
    );
    pool.setTZOverride(valor);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'servidor_hora', entidad_id: 'tz_override', detalle: `Cambió el override de timezone de la BD a "${valor || '(automático)'}"` });
    res.json({ success: true, data: { tz_activo: pool.getActiveTZ(), override: valor || null }, error: null });
  } catch(e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};
