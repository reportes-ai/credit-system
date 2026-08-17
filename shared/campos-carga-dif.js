'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   QUÉ CAMPOS SE CONTRASTAN CONTRA EL ARCHIVO DE LA CARGA — catálogo único.

   La carga masiva NO pisa lo que ya está digitado y revisado en el sistema, pero
   callar la diferencia deja el error pegado para siempre (op 6251839: precio,
   pie, saldo y pagaré malos desde el alta, veinte cargas después seguían igual).
   Cada discrepancia se anota en `carga_diferencias` y una persona elige cuál
   valor vale. La carga nunca decide sola.

   Este archivo es la ÚNICA lista: la usa el que detecta (carga-trinidad) y el
   que resuelve (carga-diferencias). Antes la lista de campos vivía en un lado y
   las etiquetas en el otro, así que agregar un campo obligaba a acordarse de dos
   archivos — y el que se olvidaba dejaba la diferencia sin nombre en la pantalla.

   Para agregar un campo: una línea acá y queda detectado, agrupado, mostrado y
   resoluble. No hay que tocar nada más.

   `tipo` decide cómo se compara y cómo se muestra:
     peso   → entero en $; tolera $1 de redondeo
     fecha  → YYYY-MM-DD
     texto  → compara normalizado (sin tildes, sin dobles espacios, MAYÚSCULAS),
              o sea que "Río Bueno" y "RIO BUENO" NO son una diferencia
   `grupo` es cómo se agrupa el informe en pantalla.

   OJO CON LO QUE NO ESTÁ: la comisión del dealer NO se contrasta. La columna
   "Comision Dealer" del export de Trinidad no es la nuestra (la nuestra sale de
   la carta y del motor de comisión), así que ponerla acá sería invitar a pisar
   el dato bueno con uno ajeno.
   ───────────────────────────────────────────────────────────────────────────── */

const CAMPOS_DIF = [
  /* ── Montos: lo que mueve plata y cálculo ── */
  { col: 'valor_vehiculo',   etiqueta: 'Precio del vehículo', tipo: 'peso',  grupo: 'Montos' },
  { col: 'pie',              etiqueta: 'Pie',                 tipo: 'peso',  grupo: 'Montos' },
  { col: 'saldo_precio',     etiqueta: 'Saldo precio',        tipo: 'peso',  grupo: 'Montos' },
  { col: 'monto_financiado', etiqueta: 'Monto del pagaré',    tipo: 'peso',  grupo: 'Montos' },

  /* ── Vehículo: no mueve plata, pero sale en cartas y certificados ── */
  { col: 'marca',            etiqueta: 'Marca',               tipo: 'texto', grupo: 'Vehículo' },
  { col: 'modelo',           etiqueta: 'Modelo',              tipo: 'texto', grupo: 'Vehículo' },

  /* ── Operación: de quién es el negocio. Cambia comisiones y reportería,
       así que se informa pero jamás se aplica solo. ── */
  { col: 'automotora',       etiqueta: 'Dealer',              tipo: 'texto', grupo: 'Operación' },
  { col: 'vendedor',         etiqueta: 'Vendedor',            tipo: 'texto', grupo: 'Operación' },
  { col: 'producto',         etiqueta: 'Producto',            tipo: 'texto', grupo: 'Operación' },

  /* ── Fechas: la de otorgamiento define el mes y con eso la comisión ── */
  { col: 'fecha_otorgado',   etiqueta: 'Fecha de otorgamiento', tipo: 'fecha', grupo: 'Fechas' },
];

/* Orden en que se muestran los grupos: primero lo que mueve plata. */
const ORDEN_GRUPOS = ['Montos', 'Fechas', 'Operación', 'Vehículo'];

const POR_COL = Object.fromEntries(CAMPOS_DIF.map(c => [c.col, c]));
const TOL_PESO = 1;   // $1 de redondeo no es una diferencia

/* Texto comparable: sin tildes, sin dobles espacios, en MAYÚSCULAS. Evita el
   ruido de "Rio Bueno" vs "RÍO BUENO", que no es una diferencia real y llenaba
   la pantalla de casos falsos que nadie iba a resolver. */
const DIACRIT = new RegExp('[\\u0300-\\u036f]', 'g');
function normTexto(v) {
  return String(v ?? '').normalize('NFD').replace(DIACRIT, '')
    .replace(/\s+/g, ' ').trim().toUpperCase();
}

function normFecha(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : String(v).trim();
}

/**
 * ¿Son distintos el valor del sistema y el del archivo, para este campo?
 * Devuelve false (no es diferencia) si a alguno de los dos le falta el dato:
 * un vacío no es un desacuerdo, es algo por completar — y la carga ya rellena
 * lo vacío por su cuenta.
 */
function difieren(campo, valorSistema, valorArchivo) {
  const c = typeof campo === 'string' ? POR_COL[campo] : campo;
  if (!c) return false;
  const vacio = v => v === null || v === undefined || String(v).trim() === '';
  if (vacio(valorSistema) || vacio(valorArchivo)) return false;

  if (c.tipo === 'peso') {
    const a = Number(valorSistema), b = Number(valorArchivo);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a <= 0 || b <= 0) return false;            // un 0 es "sin dato", no un desacuerdo
    return Math.abs(a - b) > TOL_PESO;
  }
  if (c.tipo === 'fecha') return normFecha(valorSistema) !== normFecha(valorArchivo);
  return normTexto(valorSistema) !== normTexto(valorArchivo);
}

/** Cómo se guarda en `carga_diferencias` (VARCHAR(60)) y se muestra después. */
function aTexto(campo, valor) {
  const c = typeof campo === 'string' ? POR_COL[campo] : campo;
  if (valor === null || valor === undefined) return null;
  if (c && c.tipo === 'fecha') return normFecha(valor);
  return String(valor).slice(0, 60);
}

/**
 * Qué meses entran en el contraste: el mes que se está cargando y `atras` meses
 * antes. Se contrasta solo el período que se carga (mes en curso, y a comienzos
 * de mes también el anterior para cerrarlo) — mirar más atrás son meses ya
 * cerrados y cuadrados, y llenar la pantalla de casos viejos hace que se dejen
 * de mirar los nuevos.
 * @param {string} mesActual 'YYYY-MM'
 * @param {number} atras     cuántos meses hacia atrás además del actual
 * @returns {Set<string>} meses 'YYYY-MM'
 */
function ventanaDesde(mesActual, atras = 1) {
  const [y, m] = String(mesActual).split('-').map(Number);
  const n = Number.isFinite(atras) && atras >= 0 ? Math.floor(atras) : 1;
  const meses = new Set();
  if (!Number.isFinite(y) || !Number.isFinite(m)) return meses;
  for (let i = 0; i <= n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));   // Date.UTC normaliza el cambio de año solo
    meses.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return meses;
}

module.exports = { CAMPOS_DIF, ORDEN_GRUPOS, POR_COL, TOL_PESO, difieren, aTexto, normTexto, normFecha, ventanaDesde };
