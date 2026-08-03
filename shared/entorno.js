'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ENTORNO — motor único de "dónde estoy corriendo" (Máxima 1).

   Fase 4 de docs/plan-staging-prod.md. Una sola variable, `ENTORNO`, decide los
   blindajes del ambiente de pruebas:

     ENTORNO=staging   → ambiente espejo: NADA sale a clientes reales
     ENTORNO=produccion (o sin definir) → comportamiento normal

   Por qué una variable y no la URL o el nombre de la base: porque el blindaje
   tiene que ser IMPOSIBLE de olvidar. Si mañana se clona el servicio y alguien
   copia las env vars de producción tal cual, lo peor que puede pasar es que
   staging se comporte como producción y mande correos reales. Con `ENTORNO`
   explícito y fail-safe en el resto, ese riesgo queda acotado a un solo lugar.

   Qué activa `ENTORNO=staging`:
     1. Modo Desarrollo FORZADO (shared/dev-mode.js) — correo redirigido y
        WhatsApp simulado, sin depender de la BD ni de que alguien lo prenda.
     2. Motores automáticos APAGADOS (shared/scheduler.js) — cobranza, avisos de
        vencimiento, correos programados: nada dispara solo.
     3. Cinta visual "STAGING" en todas las páginas, para que nadie confunda
        dónde está parado.
     4. /api/health informa el entorno, para verificar de un vistazo.
   ───────────────────────────────────────────────────────────────────────────── */

const RAW = String(process.env.ENTORNO || '').trim().toLowerCase();

const ES_STAGING = RAW === 'staging' || RAW === 'stg' || RAW === 'test';
const NOMBRE = ES_STAGING ? 'staging' : 'produccion';

/** ¿Estoy en el ambiente de pruebas? */
const esStaging = () => ES_STAGING;

/** ¿Puedo comunicarme con el mundo real (clientes, dealers, proveedores)? */
const puedeContactarClientes = () => !ES_STAGING;

/** ¿Deben correr los motores automáticos (crons, envíos programados)? */
const motoresAutomaticosActivos = () => !ES_STAGING;

/* Aviso al arranque: que quede en el log de Render cuál es cuál. */
function anunciar() {
  if (ES_STAGING) {
    console.log('┌────────────────────────────────────────────────────────┐');
    console.log('│  ENTORNO: STAGING                                      │');
    console.log('│  · Modo Desarrollo FORZADO (nada sale a clientes)      │');
    console.log('│  · Motores automáticos APAGADOS                        │');
    console.log('└────────────────────────────────────────────────────────┘');
  } else {
    console.log('✓ Entorno: PRODUCCIÓN');
  }
}

module.exports = { esStaging, puedeContactarClientes, motoresAutomaticosActivos, NOMBRE, anunciar };
