'use strict';
const pool = require('../../../../shared/config/database');

// GET /api/alertas/vencimientos
// Verifica UF y Tasas — retorna alertas para mostrar al admin al conectarse
exports.getVencimientos = async (req, res) => {
  try {
    const alertas = [];
    const hoy = new Date().toISOString().slice(0, 10);

    // ── UF ──────────────────────────────────────────────────────────────
    const [[ufRow]] = await pool.query(
      `SELECT MAX(fecha) AS ultima_fecha,
              DATEDIFF(CURDATE(), MAX(fecha)) AS dias_atraso
       FROM uf`
    );
    const diasUF = ufRow && ufRow.ultima_fecha ? Number(ufRow.dias_atraso) : 999;
    if (diasUF > 0) {
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
    } else {
      // Hay tasa vigente — avisar si vence pronto (próximos 7 días)
      const diasParaVencer = Math.abs(
        Math.floor((new Date(tasaVigente.fecha_hasta) - new Date(hoy)) / 86400000)
      );
      if (diasParaVencer <= 7) {
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

function fmtFecha(f) {
  if (!f) return '–';
  const d = new Date(f);
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
