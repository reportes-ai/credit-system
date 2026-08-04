'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PROGRAMADOR DE TAREAS DE FONDO — un solo lugar donde se decide si un motor
   automático corre o no (Fase 4 de docs/plan-staging-prod.md).

   El problema: el sistema tiene ~25 `setInterval` repartidos en 25 archivos.
   Cada uno decidía por su cuenta si correr, y en staging todos se despertaban
   igual que en producción: consumiendo consultas de TiDB (que se pagan) y
   moviendo datos del espejo sin que nadie lo pidiera.

   `programar()` centraliza esa decisión:
     · En STAGING los motores que salen al mundo NO se registran siquiera.
     · Registra en el log qué quedó activo y qué no, para poder auditarlo.
     · `unref()` siempre: un temporizador nunca debe impedir que el proceso
       termine cuando corresponde.

   Uso:
     const { programar } = require('../../shared/scheduler');
     programar('correos-programados', tick, 60000);              // se apaga en staging
     programar('uptime', chequear, 300000, { enStaging: true }); // corre igual
   ───────────────────────────────────────────────────────────────────────────── */

const { esStaging } = require('./entorno');

/* ── MOTORES=off — el interruptor del host en espera ──────────────────────────
   Los motores automáticos MUTAN datos: aprueban comisiones, desisten aprobados
   vencidos, cierran castigos, generan devengos de vacaciones, escalan tickets.
   Si dos procesos apuntan a la MISMA base, cada reloj dispara dos veces y el
   daño es silencioso (una comisión aprobada dos veces no avisa).

   Por eso un host de contingencia tiene que poder estar levantado y atendiendo
   sin ejecutar un solo motor: se despliega con `MOTORES=off`, se prueba que
   responde, y el día que haga falta se promueve cambiando la variable. Un plan
   de contingencia que solo se puede probar durante la emergencia no es un plan.

   Solo `off` apaga; cualquier otro valor (o ninguno) deja todo normal. */
const MOTORES_OFF = String(process.env.MOTORES || '').trim().toLowerCase() === 'off';

const registrados = [];

/**
 * @param {string} nombre        identificador para el log
 * @param {Function} fn          tarea (puede ser async; los errores se registran)
 * @param {number} ms            intervalo
 * @param {object} [opts]
 * @param {boolean} [opts.enStaging=false]  correr también en el ambiente de pruebas
 * @param {boolean} [opts.infra=false]      tarea de INFRAESTRUCTURA (no toca datos de
 *                                          negocio: limpieza de memoria, latidos, caché).
 *                                          Corre siempre, incluso con MOTORES=off.
 * @param {number}  [opts.arranqueMs]       ejecutar una vez tras N ms del arranque
 * @param {Function} [opts.arranqueFn]      qué correr en ese arranque, si difiere de `fn`
 */
function programar(nombre, fn, ms, opts = {}) {
  const infra = opts.infra === true;
  const correr = infra || (!MOTORES_OFF && (opts.enStaging === true || !esStaging()));
  registrados.push({ nombre, ms, activo: correr, infra });

  if (!correr) {
    const motivo = MOTORES_OFF ? 'MOTORES=off' : 'entorno staging';
    console.log(`⏸  [scheduler] "${nombre}" NO se programa (${motivo})`);
    return null;
  }

  const envolver = async () => {
    try { await fn(); }
    catch (e) { console.error(`[scheduler:${nombre}]`, e && e.message ? e.message : e); }
  };

  /* `arranqueFn` existe porque varias tareas hacen algo DISTINTO al arrancar que
     en cada vuelta: indicadores-sync se pone al día con `{force:true}` al boot y
     después sincroniza normal. Sin esto, migrar esos temporizadores al scheduler
     les cambiaba el comportamiento en silencio. */
  if (opts.arranqueMs != null) {
    const arranque = async () => {
      try { await (opts.arranqueFn || fn)(); }
      catch (e) { console.error(`[scheduler:${nombre}:arranque]`, e && e.message ? e.message : e); }
    };
    const t0 = setTimeout(arranque, opts.arranqueMs);
    if (t0.unref) t0.unref();
  }
  const t = setInterval(envolver, ms);
  if (t.unref) t.unref();
  return t;
}

/** Qué motores quedaron programados (lo expone /api/health). */
const listar = () => registrados.map(r => ({ ...r }));

/** ¿Este proceso está ejecutando los motores de negocio? */
const motoresActivos = () => !MOTORES_OFF;

/** Resumen para el log de arranque: qué corre y qué no, sin tener que adivinar. */
function anunciar() {
  const activos = registrados.filter(r => r.activo && !r.infra).length;
  const dormidos = registrados.filter(r => !r.activo).length;
  if (MOTORES_OFF) {
    console.log('┌────────────────────────────────────────────────────────┐');
    console.log(`│  MOTORES=off — ${String(dormidos).padStart(2)} motores de negocio NO se programaron │`);
    console.log('│  Este proceso ATIENDE pero no ejecuta nada solo.       │');
    console.log('└────────────────────────────────────────────────────────┘');
  } else {
    console.log(`✓ Motores automáticos: ${activos} activos` + (dormidos ? `, ${dormidos} apagados` : ''));
  }
}

module.exports = { programar, listar, motoresActivos, anunciar };
