'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CHEQUEO DE VARIABLES DE ENTORNO al arranque (auditoría 03-08-2026, A-4).

   El problema que resuelve: el código consume 44 variables y solo `JWT_SECRET`
   se validaba. El resto faltaba EN SILENCIO — la funcionalidad no andaba y nadie
   se enteraba hasta que un usuario reclamaba. Con staging a la vista (donde hay
   que replicar el entorno completo), eso se vuelve caro.

   Clasificación:
     CRITICA    → sin ella el sistema no puede operar: se corta el arranque.
     IMPORTANTE → el sistema parte, pero ese módulo queda fuera de servicio.
     OPCIONAL   → degradación controlada, se informa una vez y sigue.

   No valida el CONTENIDO (una clave equivocada se descubre al usarla): valida
   que esté presente, que es el 90% de los casos reales.
   ───────────────────────────────────────────────────────────────────────────── */

const CRITICAS = {
  DB_HOST: 'Host de la base de datos',
  DB_USER: 'Usuario de la base de datos',
  DB_NAME: 'Nombre de la base de datos',
  JWT_SECRET: 'Clave de firma de los tokens de sesión',
};

const IMPORTANTES = {
  MAIL_HOST: 'SMTP — sin esto NO sale ningún correo (cartolas, cobranza, alertas)',
  MAIL_USER: 'Usuario SMTP',
  MAIL_PASS: 'Clave SMTP',
  MAIL_FROM: 'Remitente de los correos del sistema',
  ALERTA_ERRORES_MAIL: 'Destino de la alerta ante errores 500 en producción',
  CMF_API_KEY: 'API CMF — sin esto no se sincronizan UF, UTM, dólar ni TMC',
  WSP_TOKEN: 'WhatsApp Meta — sin esto el bot y las campañas quedan simulados',
  WSP_PHONE_ID: 'WhatsApp Meta — id del número emisor',
  DEALERNET_USER: 'DealerNet — sin esto no hay informes comerciales',
  DEALERNET_PASS: 'DealerNet — clave del servicio',
};

const OPCIONALES = {
  ANTHROPIC_API_KEY: 'IA — lectura de PDFs e informes (degrada con aviso)',
  GOOGLE_MAPS_API_KEY: 'Mapa de dealers',
  FINTOC_SECRET_KEY: 'Cartola bancaria automática',
  SIMPLEAPI_KEY: 'Registro de Compras y Ventas del SII',
  WORKERA_API_KEY: 'Reloj control Workera',
  DEV_CORREOS_FALLBACK: 'Casillas de respaldo del Modo Desarrollo (fail-safe)',
};

const falta = (k) => !String(process.env[k] || '').trim();

function verificarEntorno({ cortarSiFalta = true } = {}) {
  const sinCriticas   = Object.keys(CRITICAS).filter(falta);
  const sinImportantes = Object.keys(IMPORTANTES).filter(falta);
  const sinOpcionales  = Object.keys(OPCIONALES).filter(falta);

  if (sinImportantes.length) {
    console.warn('\n⚠  Variables IMPORTANTES ausentes — estos módulos quedan fuera de servicio:');
    sinImportantes.forEach(k => console.warn(`   · ${k} — ${IMPORTANTES[k]}`));
  }
  if (sinOpcionales.length)
    console.log(`ℹ  Opcionales ausentes (degradación controlada): ${sinOpcionales.join(', ')}`);

  if (sinCriticas.length) {
    console.error('\n✗ FALTAN VARIABLES CRÍTICAS — el sistema no puede arrancar:');
    sinCriticas.forEach(k => console.error(`   · ${k} — ${CRITICAS[k]}`));
    console.error('  Revisa .env.example y la configuración de Render.\n');
    if (cortarSiFalta) process.exit(1);
  } else if (!sinImportantes.length && !sinOpcionales.length) {
    console.log('✓ Variables de entorno: las 44 presentes');
  } else {
    console.log('✓ Variables de entorno críticas: completas');
  }

  return { sinCriticas, sinImportantes, sinOpcionales };
}

module.exports = { verificarEntorno, CRITICAS, IMPORTANTES, OPCIONALES };
