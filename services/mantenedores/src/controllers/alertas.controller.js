'use strict';
const pool = require('../../../../shared/config/database');

// ── Migración: config paramétrica de los avisos del popup de inicio ──────────
// Cada aviso del popup "Datos próximos a vencer" se puede activar/desactivar y
// (cuando aplica) fijar con cuántos días de anticipación/atraso avisar.
require('../../../../shared/migrate').enFila('alertas', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS alertas_vencimiento_config (
      clave        VARCHAR(40)  PRIMARY KEY,
      nombre       VARCHAR(120) NOT NULL,
      descripcion  VARCHAR(255) DEFAULT NULL,
      activo       TINYINT(1)   NOT NULL DEFAULT 1,
      usa_dias     TINYINT(1)   NOT NULL DEFAULT 0,
      dias_aviso   INT          DEFAULT NULL,
      orden        INT          DEFAULT 0
    )`);
    const seed = [
      ['uf',            'UF desactualizada',                       'Avisar si la UF lleva N o más días de atraso.',                                    1, 1, 1,    1],
      ['utm',           'UTM del mes no cargada',                  'Avisar si la UTM del mes en curso no está cargada.',                               1, 0, null, 2],
      ['tasas_vencidas','Tasas de interés vencidas',               'Avisar cuando no hay tasa vigente para hoy (crítico).',                            1, 0, null, 3],
      ['tasas_vencer',  'Tasas próximas a vencer',                 'Avisar con N días de anticipación al vencimiento de la tasa vigente.',             1, 1, 7,    4],
      ['sync',          'Problemas de sincronización automática',  'Avisar si la actualización automática de indicadores (UF/UTM/Dólar/IPC/TMC) falló.', 1, 0, null, 5],
    ];
    for (const s of seed) {
      await pool.query(
        `INSERT IGNORE INTO alertas_vencimiento_config
           (clave,nombre,descripcion,activo,usa_dias,dias_aviso,orden) VALUES (?,?,?,?,?,?,?)`, s);
    }
  } catch (e) { console.error('[alertas] migracion venc-config:', e.message); }
});

// GET /api/alertas-vencimiento
// Verifica UF y Tasas — retorna alertas para mostrar al admin al conectarse
exports.getVencimientos = async (req, res) => {
  try {
    const alertas = [];
    const hoy = new Date().toISOString().slice(0, 10);

    // ── Config paramétrica (activar/desactivar + días por aviso) ──────────
    const cfg = {};
    try {
      const [crows] = await pool.query(
        'SELECT clave, activo, dias_aviso FROM alertas_vencimiento_config');
      for (const c of crows) cfg[c.clave] = c;
    } catch (_) { /* tabla aún no creada → todo activo por defecto */ }
    const habil  = (k)       => !cfg[k] || cfg[k].activo != 0;
    const diasDe = (k, def)  => (cfg[k] && cfg[k].dias_aviso != null) ? Number(cfg[k].dias_aviso) : def;

    // ── UF ──────────────────────────────────────────────────────────────
    const [[ufRow]] = await pool.query(
      `SELECT MAX(fecha) AS ultima_fecha,
              DATEDIFF(CURDATE(), MAX(fecha)) AS dias_atraso
       FROM uf`
    );
    const diasUF = ufRow && ufRow.ultima_fecha ? Number(ufRow.dias_atraso) : 999;
    if (diasUF > 0 && diasUF >= diasDe('uf', 1) && habil('uf')) {
      alertas.push({
        tipo:      'uf',
        nivel:     diasUF >= 5 ? 'critico' : 'advertencia',
        titulo:    'UF desactualizada',
        mensaje:   diasUF === 1
          ? 'La UF no ha sido actualizada hoy. El último valor es del ' + fmtFecha(ufRow.ultima_fecha) + '.'
          : `La UF lleva ${diasUF} día(s) sin actualizar. Último valor: ${fmtFecha(ufRow.ultima_fecha)}.`,
        ultimo_valor: ufRow.ultima_fecha,
        dias_atraso:  diasUF,
        url: '/mantenedores/uf/',
        boton: 'Ir a UF',
      });
    }

    // ── UTM (mensual) ─────────────────────────────────────────────────────
    try {
      const [[utmRow]] = await pool.query(
        `SELECT MAX(fecha) AS ultima_fecha,
                DATE_FORMAT(MAX(fecha),'%Y-%m') AS ym_ult,
                DATE_FORMAT(CURDATE(),'%Y-%m')  AS ym_hoy
         FROM utm`
      );
      if ((!utmRow || !utmRow.ultima_fecha || utmRow.ym_ult < utmRow.ym_hoy) && habil('utm')) {
        alertas.push({
          tipo:    'utm',
          nivel:   'advertencia',
          titulo:  'UTM del mes no cargada',
          mensaje: (utmRow && utmRow.ultima_fecha)
            ? `La UTM del mes actual no está cargada. Último valor: ${fmtFecha(utmRow.ultima_fecha)}.`
            : 'No hay valores de UTM registrados en el sistema.',
          ultimo_valor: (utmRow && utmRow.ultima_fecha) ? utmRow.ultima_fecha : null,
          dias_atraso:  0,
          url: '/mantenedores/uf/',
          boton: 'Ir a UTM',
        });
      }
    } catch (_) { /* tabla utm aún no disponible */ }

    // ── Tasas de interés ─────────────────────────────────────────────────
    const [[tasaVigente]] = await pool.query(
      `SELECT id_tasa, fecha_desde, fecha_hasta,
              DATEDIFF(CURDATE(), fecha_hasta) AS dias_vencida
       FROM tasas
       WHERE fecha_hasta >= CURDATE()
       ORDER BY fecha_hasta DESC
       LIMIT 1`
    );
    const [[ultimaTasa]] = await pool.query(
      `SELECT id_tasa, fecha_desde, fecha_hasta,
              DATEDIFF(CURDATE(), fecha_hasta) AS dias_vencida
       FROM tasas
       ORDER BY fecha_hasta DESC
       LIMIT 1`
    );

    if (!tasaVigente) {
      // No hay ninguna tasa vigente hoy
      if (habil('tasas_vencidas')) {
        const diasVenc = ultimaTasa ? Number(ultimaTasa.dias_vencida) : 999;
        alertas.push({
          tipo:     'tasas',
          nivel:    'critico',
          titulo:   'Tasas de interés vencidas',
          mensaje:  ultimaTasa
            ? `No hay tasas vigentes para hoy. La última tasa venció el ${fmtFecha(ultimaTasa.fecha_hasta)} (hace ${diasVenc} día(s)).`
            : 'No hay tasas de interés registradas en el sistema.',
          ultimo_valor: ultimaTasa ? ultimaTasa.fecha_hasta : null,
          dias_atraso:  diasVenc,
          url: '/mantenedores/tasas/',
          boton: 'Ir a Tasas',
        });
      }
    } else {
      // Hay tasa vigente — avisar si vence pronto (días de anticipación configurables)
      const diasParaVencer = Math.abs(
        Math.floor((new Date(tasaVigente.fecha_hasta) - new Date(hoy)) / 86400000)
      );
      if (diasParaVencer <= diasDe('tasas_vencer', 7) && habil('tasas_vencer')) {
        alertas.push({
          tipo:     'tasas',
          nivel:    'advertencia',
          titulo:   'Tasas de interés próximas a vencer',
          mensaje:  `La tasa vigente vence el ${fmtFecha(tasaVigente.fecha_hasta)} (en ${diasParaVencer} día(s)). Recuerda cargar el período siguiente.`,
          ultimo_valor: tasaVigente.fecha_hasta,
          dias_atraso:  -diasParaVencer,
          url: '/mantenedores/tasas/',
          boton: 'Ir a Tasas',
        });
      }
    }

    // ── Errores de la sincronización automática (UF/UTM/TMC) ──────────────
    try {
      const [rows] = habil('sync') ? await pool.query(
        "SELECT clave, valor FROM indicadores_estado WHERE clave IN ('sync_uf','sync_utm','sync_dolar','sync_ipc','sync_tmc') AND valor <> ''") : [[]];
      for (const r of rows) {
        alertas.push({
          tipo:    r.clave,
          nivel:   'advertencia',
          titulo:  'Sincronización automática con problemas',
          mensaje: 'No se pudo actualizar automáticamente: ' + r.valor,
          ultimo_valor: null,
          dias_atraso:  0,
          url: '/mantenedores/uf/',
          boton: 'Ir a indicadores',
        });
      }
    } catch (_) { /* parametros_credito no disponible */ }

    return res.json({
      success: true,
      data: {
        alertas,
        tiene_alertas: alertas.length > 0,
        criticas:      alertas.filter(a => a.nivel === 'critico').length,
        advertencias:  alertas.filter(a => a.nivel === 'advertencia').length,
        timestamp:     new Date().toISOString(),
      },
      error: null,
    });
  } catch (err) {
    console.error('[alertas] getVencimientos:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  }
};

// GET /api/alertas-vencimiento/config — config de los avisos del popup de inicio
exports.getVencConfig = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT clave, nombre, descripcion, activo, usa_dias, dias_aviso, orden
         FROM alertas_vencimiento_config ORDER BY orden, nombre`);
    return res.json({ success: true, data: rows, error: null });
  } catch (err) {
    console.error('[alertas] getVencConfig:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  }
};

// PUT /api/alertas-vencimiento/config — body: { config:[{clave, activo, dias_aviso}] }
exports.setVencConfig = async (req, res) => {
  try {
    const list = Array.isArray(req.body && req.body.config) ? req.body.config : [];
    let n = 0;
    for (const c of list) {
      if (!c || !c.clave) continue;
      const activo = c.activo ? 1 : 0;
      const dias = (c.dias_aviso === '' || c.dias_aviso == null)
        ? null : Math.max(0, parseInt(c.dias_aviso, 10) || 0);
      const [r] = await pool.query(
        'UPDATE alertas_vencimiento_config SET activo=?, dias_aviso=? WHERE clave=?',
        [activo, dias, c.clave]);
      n += r.affectedRows || 0;
    }
    return res.json({ success: true, data: { updated: n }, error: null });
  } catch (err) {
    console.error('[alertas] setVencConfig:', err.message);
    return res.status(500).json({ success: false, data: null, error: err.message });
  }
};

function fmtFecha(f) {
  if (!f) return '–';
  const d = new Date(f);
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
