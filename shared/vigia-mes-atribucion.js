'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   VIGÍA DE MES DE ATRIBUCIÓN — cada hora comprueba la invariante:

     crédito OTORGADO con fecha de curse >= corte  ⇒  mes = mes de la fecha de curse

   Por qué existe (07-09-2026): el dashboard, las cartolas y el ranking cuentan por la
   columna `mes` (mes contable). Siete operaciones cursadas el 03/04-09 quedaron con
   mes agosto (la carga Trinidad trae el MES de ingreso y al otorgar la carta no se
   movía el mes) y agosto pasó de 104 a 111 DESPUÉS del cierre. Se corrigió en cada
   escritor de `fecha_otorgado` (SET_MES_SQL), pero un escritor nuevo puede olvidarlo:
   este vigía es la red de seguridad, para que la próxima vez se corrija sola y avise.

   Qué hace:
   - Mes destino ABIERTO → corrige (`mes` = mes de la fecha), audita y avisa por correo.
   - Mes destino o mes actual CERRADO → NO toca (un mes cerrado está liquidado);
     solo avisa, para que una persona decida.
   Correo a ALERTA_ERRORES_MAIL, máx. 1 cada 6 h por proceso. Motor de negocio
   (se apaga con MOTORES=off en el standby).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');
const { programar } = require('./scheduler');
const { mesCorte } = require('./mes-atribucion');
const { ETAPA_SQL } = require('./etapa-credito');
const { isMesCerrado } = require('./utils/mes-cerrado');
const { auditar } = require('./audit');

const CADA_MS = 60 * 60 * 1000;
const AVISO_CADA_MS = 6 * 60 * 60 * 1000;
let ultimoAviso = 0;

async function revisar() {
  const corte = await mesCorte();
  const [rows] = await pool.query(
    `SELECT c.id, c.num_op, c.financiera, DATE_FORMAT(c.mes,'%Y-%m') mes_actual,
            DATE_FORMAT(c.fecha_otorgado,'%Y-%m') mes_curse, DATE_FORMAT(c.fecha_otorgado,'%Y-%m-%d') fecha
       FROM creditos c
      WHERE ${ETAPA_SQL('c')} = 'OTORGADO'
        AND c.fecha_otorgado IS NOT NULL AND c.fecha_otorgado >= ?
        AND (c.mes IS NULL OR DATE_FORMAT(c.mes,'%Y-%m') <> DATE_FORMAT(c.fecha_otorgado,'%Y-%m'))
      LIMIT 200`, [corte + '-01']);
  if (!rows.length) return { corregidas: [], bloqueadas: [] };

  const corregidas = [], bloqueadas = [];
  for (const r of rows) {
    const cerrado = (r.mes_actual && await isMesCerrado(r.mes_actual)) || await isMesCerrado(r.mes_curse);
    if (cerrado) { bloqueadas.push(r); continue; }
    const [u] = await pool.query(
      "UPDATE creditos SET mes = DATE_FORMAT(fecha_otorgado,'%Y-%m-01'), updated_at = NOW() WHERE id = ? AND DATE_FORMAT(COALESCE(mes,''),'%Y-%m') <> DATE_FORMAT(fecha_otorgado,'%Y-%m')", [r.id]);
    if (!u.affectedRows) continue;
    corregidas.push(r);
    auditar({ accion: 'EDITAR', modulo: 'creditos', entidad: 'credito', entidad_id: r.id,
      usuario: { nombre: 'Vigía mes de atribución', perfil_nombre: 'Sistema' },
      detalle: `Mes contable corregido en OP ${r.num_op}: ${r.mes_actual || '—'} → ${r.mes_curse} (fecha de curse ${r.fecha}; regla: desde ${corte} el mes sigue a la fecha de curse)` });
  }
  const linea = r => `${r.num_op} (${r.financiera || '?'}): mes ${r.mes_actual || '—'}, curse ${r.fecha}`;
  if (corregidas.length) console.warn(`⚠️ [vigia-mes-atribucion] ${corregidas.length} op(s) con mes distinto a la fecha de curse, corregidas:\n - ` + corregidas.map(linea).join('\n - '));
  if (bloqueadas.length) console.error(`🚨 [vigia-mes-atribucion] ${bloqueadas.length} op(s) apuntan a un MES CERRADO, sin tocar:\n - ` + bloqueadas.map(linea).join('\n - '));

  const ahora = Date.now();
  const destino = process.env.ALERTA_ERRORES_MAIL || '';
  if (!destino || ahora - ultimoAviso < AVISO_CADA_MS) return { corregidas, bloqueadas };
  ultimoAviso = ahora;
  try {
    const { enviarCorreo, mailConfigurado } = require('./mailer');
    if (!mailConfigurado()) return { corregidas, bloqueadas };
    const li = rs => rs.map(r => `<li>${linea(r)}</li>`).join('');
    await enviarCorreo({
      to: destino,
      subject: `📅 Mes de atribución — ${corregidas.length} corregida(s), ${bloqueadas.length} en mes cerrado`,
      html: `<p><b>Créditos otorgados cuyo mes contable no coincidía con su fecha de curse</b> (regla vigente desde ${corte}).</p>
        ${corregidas.length ? `<p>Corregidas automáticamente (mes abierto):</p><ul>${li(corregidas)}</ul>` : ''}
        ${bloqueadas.length ? `<p style="color:#b91c1c"><b>Sin tocar — apuntan a un mes cerrado, decide una persona:</b></p><ul>${li(bloqueadas)}</ul>` : ''}
        <p style="color:#888;font-size:12px">Si esto se repite, algún proceso escribe fecha_otorgado sin SET_MES_SQL (shared/mes-atribucion.js).
        Dashboard, cartolas y ranking cuentan por el mes contable; comisiones por la fecha de curse.</p>`,
    });
  } catch (_) { /* la alerta nunca debe causar otro error */ }
  return { corregidas, bloqueadas };
}

programar('vigia-mes-atribucion', () => revisar().catch(e => console.error('[vigia-mes-atribucion]', e.message)),
  CADA_MS, { arranqueMs: 3 * 60 * 1000 });

module.exports = { revisar };
