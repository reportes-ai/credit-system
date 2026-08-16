'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   TRINQUETE DE PATRONES DE FECHA — que el bug de las 4 horas no vuelva a crecer.

   `toISOString().slice(0,10)` entrega el día en UTC: entre las 20:00 y la
   medianoche de Chile devuelve el día SIGUIENTE. El reemplazo correcto es
   shared/fecha-chile.js (hoyISO/isoDe/sumarDias...).

   Quedan ~80 usos históricos que se irán limpiando con calma. Esta prueba
   congela el conteo actual POR ARCHIVO y falla solo si aparece uno NUEVO
   (archivo nuevo con el patrón, o un archivo existente que sube su conteo).
   Si limpiaste usos, baja el número del archivo aquí — nunca lo subas.
   ───────────────────────────────────────────────────────────────────────────── */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const PATRON = /toISOString\(\)\.(slice|substring)\(0,\s*10\)/g;

/* Conteo congelado el 16-08-2026. BAJAR al limpiar; NUNCA subir. */
const BASELINE = {
  'services/campanas-ventas/src/controllers/campanas-ventas.controller.js': 1,
  'services/cartas/src/controllers/cartas.controller.js': 2,
  'services/certificados/src/controllers/certificados.controller.js': 1,
  'services/cobranza/src/controllers/cobranza.controller.js': 4,
  'services/cobranza/src/controllers/odp-cuotas.controller.js': 1,
  'services/comisiones/src/controllers/comisiones.controller.js': 1,
  'services/contabilidad/src/controllers/contabilidad.controller.js': 2,
  'services/contabilidad/src/controllers/finanzas-ia.controller.js': 1,
  'services/contabilidad/src/motor-asientos.js': 1,
  'services/creditos/src/utils/desistir-aprobados.js': 1,
  'services/dashboard/src/controllers/dashboard.controller.js': 4,
  'services/desempeno/src/controllers/desempeno.controller.js': 1,
  'services/ia/src/controllers/consulta.controller.js': 2,
  'services/mantenedores/src/controllers/alertas.controller.js': 1,
  'services/mantenedores/src/controllers/bd-clientes.controller.js': 3,
  'services/mantenedores/src/controllers/bd-operaciones.controller.js': 1,
  'services/mantenedores/src/controllers/db-maintenance-extra.js': 1,
  'services/mantenedores/src/controllers/dealers.controller.js': 1,
  'services/mantenedores/src/controllers/uptime.controller.js': 1,
  'services/mantenedores/src/controllers/visitas.controller.js': 1,
  'services/mantenedores/src/tmc-sync.js': 1,
  'services/ordenes-pago/src/controllers/ordenes-pago.controller.js': 3,
  'services/portal-cliente/src/controllers/portal-cliente.controller.js': 1,
  'services/postventa/src/controllers/postventa.controller.js': 6,
  'services/rrhh/src/controllers/asistencia.controller.js': 7,
  'services/rrhh/src/controllers/compliance.controller.js': 4,
  'services/rrhh/src/controllers/contratos.controller.js': 5,
  'services/rrhh/src/controllers/firmas.controller.js': 1,
  'services/rrhh/src/controllers/jornada.controller.js': 3,
  'services/rrhh/src/controllers/remuneraciones.controller.js': 1,
  'services/tesoreria/src/controllers/banco-conexiones.controller.js': 1,
  'services/tesoreria/src/controllers/cierre-caja.controller.js': 1,
  'services/tesoreria/src/controllers/cierre-mes.controller.js': 2,
  'services/tesoreria/src/controllers/conciliacion.controller.js': 4,
  'services/tesoreria/src/controllers/venta-cartera.controller.js': 1,
  'services/whatsapp/src/controllers/whatsapp.controller.js': 1,
  'shared/fecha-chile.js': 1,   // el comentario que explica el patrón malo
  'shared/mora-calc.js': 3,     // opera todo en UTC a propósito (días puros)
};

function listarJS(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listarJS(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

test('ningún archivo NUEVO usa toISOString().slice(0,10) — usar shared/fecha-chile', () => {
  const archivos = [...listarJS(path.join(RAIZ, 'services')), ...listarJS(path.join(RAIZ, 'shared'))];
  const infractores = [];
  for (const f of archivos) {
    const n = (fs.readFileSync(f, 'utf8').match(PATRON) || []).length;
    if (!n) continue;
    const rel = path.relative(RAIZ, f).replace(/\\/g, '/');
    const permitido = BASELINE[rel] || 0;
    if (n > permitido) infractores.push(`${rel}: ${n} uso(s), permitidos ${permitido}`);
  }
  assert.deepStrictEqual(infractores, [],
    'Usos NUEVOS del patrón UTC detectados (corre el día entre 20:00 y medianoche de Chile). ' +
    'Reemplazar por hoyISO()/isoDe() de shared/fecha-chile.js:\n' + infractores.join('\n'));
});
