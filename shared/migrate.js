'use strict';
/* ─────────────────────────────────────────────────────────────────
   CAPATAZ DE MIGRACIONES — serializa los bloques de boot (IIFE)

   Problema: cada controller aplica su estructura (CREATE/ALTER) en un
   bloque auto-ejecutado al arrancar. Corrían TODOS en paralelo y TiDB
   tira "column may have been updated by other DDL ran in parallel".

   Solución (camino liviano acordado):
   1. enFila(nombre, fn)  — encola el bloque: los bloques corren UNO A LA VEZ,
      en el orden en que se requieren los controllers. Mata el choque de DDL.
      El deploy sigue aplicando la estructura solo (sin paso manual).
   2. migrar(nombre, fn)  — como enFila, pero corre UNA SOLA VEZ en la vida
      del sistema: se registra en la tabla `_migraciones` (claim atómico por
      PK → seguro multi-instancia). Para backfills/movimientos de datos que
      no deben repetirse en cada arranque. Si falla, libera el claim para
      reintentar en el próximo boot.
   3. Reintento con backoff ante errores DDL transitorios de TiDB.

   Uso en un controller (reemplaza al IIFE):
     const { enFila } = require('../../../shared/migrate');
     enFila('cobranza', async () => { ...CREATE/ALTER idempotentes... });

     const { migrar } = require('../../../shared/migrate');
     migrar('homologacion_cluster7_v1', async () => { ...backfill una vez... });
   ───────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

let cadena = Promise.resolve();
let tablaLista = null;

const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// Errores DDL/lock transitorios de TiDB que ameritan reintento
const esTransitorio = (e) =>
  /DDL ran in parallel|Lock wait timeout|deadlock|try again later|Information schema is changed/i
    .test(e && e.message || '');

async function conReintento(fn, intentos = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= intentos || !esTransitorio(e)) throw e;
      console.warn(`[migrate] error transitorio (intento ${i}/${intentos}): ${e.message} — reintentando…`);
      await dormir(500 * Math.pow(2, i - 1));
    }
  }
}

/* Encola un bloque de boot: corre cuando terminó el anterior. Nunca rechaza
   (el error se loguea y la fila sigue) para no tumbar el arranque. */
function enFila(nombre, fn) {
  if (typeof nombre === 'function') { fn = nombre; nombre = 'anonimo'; }
  cadena = cadena.then(async () => {
    const t0 = Date.now();
    try {
      await conReintento(fn);
      const ms = Date.now() - t0;
      if (ms > 3000) console.log(`[migrate] ${nombre} tardó ${(ms / 1000).toFixed(1)}s`);
    } catch (e) {
      console.error(`[migrate] ${nombre} FALLÓ:`, e.message);
    }
  });
  return cadena;
}

async function asegurarTabla() {
  if (!tablaLista) tablaLista = pool.query(`CREATE TABLE IF NOT EXISTS _migraciones (
    nombre      VARCHAR(150) PRIMARY KEY,
    estado      VARCHAR(20) DEFAULT 'EN_CURSO',
    aplicada_en DATETIME NULL,
    creada_en   DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  return tablaLista;
}

/* Corre fn UNA sola vez en la vida del sistema (registro en _migraciones).
   Claim atómico por PK: en multi-instancia solo una gana. Si fn falla, se
   libera el claim para que el próximo arranque reintente. */
function migrar(nombre, fn) {
  return enFila(`migracion:${nombre}`, async () => {
    await asegurarTabla();
    const [r] = await pool.query('INSERT IGNORE INTO _migraciones (nombre) VALUES (?)', [nombre]);
    if (!r.affectedRows) return;                       // ya corrió (o la corre otra instancia)
    try {
      await fn();
      await pool.query("UPDATE _migraciones SET estado='OK', aplicada_en=NOW() WHERE nombre=?", [nombre]);
      console.log(`[migrate] migración ${nombre} aplicada`);
    } catch (e) {
      await pool.query('DELETE FROM _migraciones WHERE nombre=?', [nombre]).catch(() => {});
      throw e;
    }
  });
}

module.exports = { enFila, migrar };
