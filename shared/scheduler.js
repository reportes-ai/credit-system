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

const registrados = [];

/**
 * @param {string} nombre        identificador para el log
 * @param {Function} fn          tarea (puede ser async; los errores se registran)
 * @param {number} ms            intervalo
 * @param {object} [opts]
 * @param {boolean} [opts.enStaging=false]  correr también en el ambiente de pruebas
 * @param {number}  [opts.arranqueMs]       ejecutar una vez tras N ms del arranque
 */
function programar(nombre, fn, ms, opts = {}) {
  const correr = opts.enStaging === true || !esStaging();
  registrados.push({ nombre, ms, activo: correr });

  if (!correr) {
    console.log(`⏸  [scheduler] "${nombre}" NO se programa (entorno staging)`);
    return null;
  }

  const envolver = async () => {
    try { await fn(); }
    catch (e) { console.error(`[scheduler:${nombre}]`, e && e.message ? e.message : e); }
  };

  if (opts.arranqueMs != null) {
    const t0 = setTimeout(envolver, opts.arranqueMs);
    if (t0.unref) t0.unref();
  }
  const t = setInterval(envolver, ms);
  if (t.unref) t.unref();
  return t;
}

/** Qué motores quedaron programados (lo expone /api/health). */
const listar = () => registrados.map(r => ({ ...r }));

module.exports = { programar, listar };
