'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   GUARDIÁN DE PERMISOS — corre la auditoría de integridad de Perfiles y
   Permisos (scripts/audit-permisos.js) una vez al día. Si encuentra algún
   problema crítico (cards fuera de la matriz, duplicados, huérfanos, perfiles
   ciegos), avisa por correo al administrador ANTES de que lo descubra un
   usuario. Es el respaldo de la regla "la matriz manda".
   ───────────────────────────────────────────────────────────────────────────── */
const { execFile } = require('child_process');
const path = require('path');

async function tick() {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '../../../scripts/audit-permisos.js');
    execFile(process.execPath, [script], { timeout: 120000, cwd: path.join(__dirname, '../../..') },
      async (err, stdout) => {
        const salida = String(stdout || '');
        const fallo = !!err;   // el script sale con código 1 si hay problemas críticos
        if (fallo) {
          try {
            const { enviarCorreo } = require('../../../shared/mailer');
            const to = process.env.ALERTA_ERRORES_MAIL || 'patricio.escobar@autofacilchile.cl';
            const resumen = salida.split('\n').filter(l => /✗|⚠/.test(l)).slice(0, 30).join('<br>');
            await enviarCorreo({
              to,
              subject: '⚠ Guardián de Permisos: la auditoría encontró problemas críticos',
              html: `<p>La auditoría diaria de Perfiles y Permisos falló. Hallazgos:</p>
                     <div style="font-family:monospace;font-size:12px;background:#fef2f2;padding:12px;border-radius:8px">${resumen}</div>
                     <p>Detalle completo: correr <code>node scripts/audit-permisos.js</code>.</p>`,
            });
          } catch (e) { console.error('[guardian-permisos] no pudo avisar:', e.message); }
          console.error('[guardian-permisos] ✗ auditoría con problemas críticos — aviso enviado');
        } else {
          console.log('[guardian-permisos] ✓ matriz íntegra');
        }
        resolve({ fallo });
      });
  });
}

// Una vez al día; también al arrancar (deploy nuevo = momento más probable de romper algo)
require('../../../shared/scheduler').programar('guardian-permisos', tick, 24 * 60 * 60 * 1000);

module.exports = { tick };
