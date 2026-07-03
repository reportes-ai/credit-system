'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   WhatsApp — canal único de salida (Meta Cloud API directa, sin BSP).
   Patrón del mailer: credenciales por env vars, respeta Modo Desarrollo.
     WSP_TOKEN     → token permanente de la app Meta (System User)
     WSP_PHONE_ID  → Phone Number ID del número WhatsApp Business
     WSP_VERIFY    → verify token del webhook (lo inventamos nosotros)
   Sin credenciales el envío queda SIMULADO (se registra igual): permite armar
   y probar todo el módulo antes de tener el número migrado desde el BSP.
   Modo Desarrollo activo → redirige a dev_whatsapp (mantenimiento_config) o simula.
   ───────────────────────────────────────────────────────────────────────────── */
const { getDevMode } = require('./dev-mode');

const API_VER = 'v21.0';

// Normaliza a E.164 chileno: "9 1234 5678" → "56912345678"
function normalizarFono(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('56')) return d.length >= 11 ? d : null;
  if (d.length === 9 && d.startsWith('9')) return '56' + d;
  if (d.length === 8) return '569' + d;          // celular sin el 9
  return d.length >= 11 ? d : null;              // otro país, tal cual
}

/**
 * Envía un mensaje de WhatsApp.
 * @param {object} p
 * @param {string} p.telefono  destino (cualquier formato chileno)
 * @param {string} [p.texto]   mensaje libre (solo válido dentro de ventana 24h)
 * @param {string} [p.plantilla] nombre de plantilla HSM aprobada (abre conversación)
 * @param {string[]} [p.variables] variables {{1}},{{2}}… de la plantilla
 * @returns {Promise<{ok:boolean, simulado:boolean, telefono:string|null, wamid?:string, error?:string}>}
 */
async function enviarWhatsApp({ telefono, texto, plantilla, variables = [] } = {}) {
  let fono = normalizarFono(telefono);
  if (!fono) return { ok: false, simulado: false, telefono: null, error: 'Teléfono inválido: ' + telefono };

  // Modo Desarrollo: nunca a números reales — redirigir al de prueba o simular
  try {
    const dev = await getDevMode();
    if (dev.activo) {
      const devFono = normalizarFono(dev.whatsapp);
      if (devFono) fono = devFono;
      else return { ok: true, simulado: true, telefono: fono };
    }
  } catch (_) {}

  const token = process.env.WSP_TOKEN, phoneId = process.env.WSP_PHONE_ID;
  if (!token || !phoneId) return { ok: true, simulado: true, telefono: fono };

  const body = plantilla
    ? { messaging_product: 'whatsapp', to: fono, type: 'template',
        template: { name: plantilla, language: { code: 'es' },
          components: variables.length ? [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: String(v) })) }] : [] } }
    : { messaging_product: 'whatsapp', to: fono, type: 'text', text: { body: String(texto || '') } };

  try {
    const r = await fetch(`https://graph.facebook.com/${API_VER}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) return { ok: false, simulado: false, telefono: fono, error: j?.error?.message || ('HTTP ' + r.status) };
    return { ok: true, simulado: false, telefono: fono, wamid: j?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, simulado: false, telefono: fono, error: e.message };
  }
}

module.exports = { enviarWhatsApp, normalizarFono };
