'use strict';
const pool = require('../../../../shared/config/database');

/* Próximo cambio de horario DST en Chile (America/Santiago) */
function proximoCambioDST() {
  const now = new Date();
  const year = now.getFullYear();
  // Chile: último sábado de marzo → invierno (UTC-4)
  //        primer sábado de septiembre → verano (UTC-3)
  // Aproximación simple para los próximos 2 años
  const candidatos = [];
  for (let y = year; y <= year + 1; y++) {
    // Último sábado de marzo
    const mar = new Date(y, 2, 31); // 31 marzo
    mar.setDate(31 - ((mar.getDay() + 1) % 7)); // retroceder al sábado
    mar.setHours(24, 0, 0, 0);
    candidatos.push({ fecha: mar, evento: `Cambio a INVIERNO (UTC-4) — ${mar.toLocaleDateString('es-CL')}` });

    // Primer sábado de septiembre (en realidad varía, pero aprox)
    const sep = new Date(y, 8, 1);
    sep.setDate(1 + ((6 - sep.getDay() + 7) % 7));
    sep.setHours(24, 0, 0, 0);
    candidatos.push({ fecha: sep, evento: `Cambio a VERANO (UTC-3) — ${sep.toLocaleDateString('es-CL')}` });
  }
  const futuros = candidatos.filter(c => c.fecha > now).sort((a, b) => a.fecha - b.fecha);
  return futuros[0] || null;
}

exports.getInfo = async (req, res) => {
  try {
    const ahora = new Date();

    // Hora del proceso Node (debería ser America/Santiago)
    const horaChile = ahora.toLocaleString('es-CL', {
      timeZone: 'America/Santiago',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    const horaUTC = ahora.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    // Offset actual de Chile
    const offsetMs   = -new Date().toLocaleString('en-US', { timeZone: 'America/Santiago', timeZoneName: 'shortOffset' })
      .match(/GMT([+-]\d+)/)?.[1] * 60 * 60 * 1000 || 0;
    const chileTZ    = Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', timeZoneName: 'longOffset' })
      .formatToParts(ahora).find(p => p.type === 'timeZoneName')?.value || '';
    const modoActual = chileTZ.includes('-03') ? 'VERANO (UTC-3)' : 'INVIERNO (UTC-4)';

    // TZ del proceso
    const tzProceso = process.env.TZ || 'No configurado (UTC por defecto)';

    // Hora según la BD
    const [[bdRow]] = await pool.query('SELECT NOW() AS ahora_bd, @@global.time_zone AS tz_global, @@session.time_zone AS tz_session');

    // Última operación creada
    const [[ultimaOp]] = await pool.query(
      'SELECT id, num_op, created_at FROM creditos ORDER BY created_at DESC LIMIT 1'
    );
    // Último cliente creado
    const [[ultimoCliente]] = await pool.query(
      'SELECT id_cliente, rut, created_at FROM clientes ORDER BY created_at DESC LIMIT 1'
    );

    const proximo = proximoCambioDST();

    res.json({ success: true, data: {
      hora_chile:       horaChile,
      hora_utc:         horaUTC,
      modo_dst:         modoActual,
      offset_chile:     chileTZ,
      tz_proceso:       tzProceso,
      bd_now:           bdRow?.ahora_bd,
      bd_tz_global:     bdRow?.tz_global,
      bd_tz_session:    bdRow?.tz_session,
      ultima_operacion: ultimaOp || null,
      ultimo_cliente:   ultimoCliente || null,
      proximo_dst:      proximo ? proximo.evento : 'No determinado',
    }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};
