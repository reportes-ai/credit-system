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

/* Estado observable del capataz (diagnóstico 19-08-2026: la fila se cuelga en
   algún bloque intermedio en Render y los one-shots posteriores nunca corren).
   Se expone en /api/health → capataz, y el watchdog acusa al bloque colgado. */
const _estado = { actual: null, iniciado: 0, completados: 0, fallados: 0, encolados: 0, ultimo_ok: null };
function estadoCapataz() {
  return {
    corriendo: _estado.actual,
    hace_seg: _estado.actual ? Math.round((Date.now() - _estado.iniciado) / 1000) : null,
    completados: _estado.completados,
    fallados: _estado.fallados,
    encolados: _estado.encolados,
    pendientes: _estado.encolados - _estado.completados - _estado.fallados - (_estado.actual ? 1 : 0),
    ultimo_ok: _estado.ultimo_ok,
  };
}
// Watchdog: si un bloque lleva >2 min corriendo, acusarlo por nombre cada minuto.
setInterval(() => {
  if (_estado.actual && Date.now() - _estado.iniciado > 2 * 60 * 1000)
    console.error(`[migrate] ⚠ BLOQUE COLGADO: "${_estado.actual}" lleva ${Math.round((Date.now() - _estado.iniciado) / 60000)} min — la fila de migraciones está detenida aquí`);
}, 60 * 1000).unref();

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
  _estado.encolados++;
  cadena = cadena.then(async () => {
    const t0 = Date.now();
    _estado.actual = nombre; _estado.iniciado = t0;
    try {
      await conReintento(fn);
      const ms = Date.now() - t0;
      if (ms > 3000) console.log(`[migrate] ${nombre} tardó ${(ms / 1000).toFixed(1)}s`);
      _estado.completados++; _estado.ultimo_ok = nombre;
    } catch (e) {
      _estado.fallados++;
      console.error(`[migrate] ${nombre} FALLÓ:`, e.message);
    } finally {
      _estado.actual = null;
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
  const cuerpo = async () => {
    await asegurarTabla();
    let [r] = await pool.query('INSERT IGNORE INTO _migraciones (nombre) VALUES (?)', [nombre]);
    if (!r.affectedRows) {
      // Claim huérfano: quedó EN_CURSO >30 min (proceso muerto a mitad de camino) → retomar.
      const [ret] = await pool.query(
        "UPDATE _migraciones SET creada_en=NOW() WHERE nombre=? AND estado='EN_CURSO' AND creada_en < (NOW() - INTERVAL 30 MINUTE)", [nombre]);
      if (!ret.affectedRows) return;                   // ya corrió OK (o la corre otra instancia)
      console.warn(`[migrate] retomando migración huérfana ${nombre}`);
    }
    try {
      await fn();
      await pool.query("UPDATE _migraciones SET estado='OK', aplicada_en=NOW() WHERE nombre=?", [nombre]);
      console.log(`[migrate] migración ${nombre} aplicada`);
    } catch (e) {
      await pool.query('DELETE FROM _migraciones WHERE nombre=?', [nombre]).catch(() => {});
      throw e;
    }
  };
  /* GUARDIA ANTI-ABRAZO-MORTAL: un `await migrar()` DENTRO de un bloque enFila
     se encolaría detrás del bloque que lo espera → la fila entera se congela
     (pasó con dealernet-sin-datos-v1, 12→19-08-2026: dejó todos los one-shots
     sin correr en Render). Si ya estamos dentro de un bloque, se ejecuta
     directo — el claim atómico en _migraciones lo mantiene seguro igual. */
  if (_estado.actual) {
    console.error(`[migrate] ⚠ migrar("${nombre}") llamado DENTRO del bloque "${_estado.actual}" — se ejecuta directo para no congelar la fila. Muévelo a nivel de módulo.`);
    return cuerpo().catch(e => console.error(`[migrate] migración ${nombre} FALLÓ:`, e.message));
  }
  return enFila(`migracion:${nombre}`, cuerpo);
}

/* Como migrar(), pero el registro incluye un hash del CÓDIGO del bloque:
   si el bloque nunca cambia, corre una sola vez; si un programador lo edita
   (ej. agrega una funcionalidad al array), el hash cambia y el bloque corre
   una vez más. Ideal para las migraciones versionadas de boot (Perfiles vN)
   sin riesgo de que una edición futura quede silenciosamente sin aplicar. */
function migrarAuto(nombre, fn) {
  const src = fn.toString();
  let h = 0; for (let i = 0; i < src.length; i++) { h = ((h << 5) - h + src.charCodeAt(i)) | 0; }
  return migrar(`${nombre}@${(h >>> 0).toString(36)}`, fn);
}

module.exports = { enFila, migrar, migrarAuto, estadoCapataz };
