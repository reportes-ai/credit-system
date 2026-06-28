'use strict';
/**
 * Sincroniza el catálogo de artículos de oficina desde Dimeiggs (VTEX) → tabla compras_articulos.
 * API pública VTEX (sin key ni auth): /api/catalog_system/pub/products/search
 *   - Trae nombre, marca, categoría, precio (con IVA), stock. Paginado de a 50 (máx VTEX).
 *   - El header "resources: 0-49/2328" da el total; igual cortamos cuando una página trae < 50.
 * Ojo: el precio es el de retail web (con IVA), no un precio convenio.
 */
const axios = require('axios');
const pool = require('../../../shared/config/database');

const BASE = 'https://www.dimeiggs.cl';
const PAGE = 50;          // VTEX: máximo 50 por request
const MAX_OFFSET = 2500;  // VTEX no pagina más allá de ~2500 (devuelve error)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Producto VTEX → fila de compras_articulos
function mapProducto(p) {
  const it = (p.items && p.items[0]) || {};
  const seller = (it.sellers && it.sellers[0]) || {};
  const off = seller.commertialOffer || {};
  const cat = (Array.isArray(p.categories) && p.categories.length) ? p.categories[0] : '';
  const img = (it.images && it.images[0] && it.images[0].imageUrl) || null;
  const ref = p.productReference || (it.referenceId && it.referenceId[0] && it.referenceId[0].Value) || null;
  return {
    sku: String(p.productId || ''),
    codigo_ref: ref,
    nombre: p.productName || '',
    marca: p.brand || '',
    categoria: String(cat).replace(/^\/|\/$/g, ''),       // "/Oficina y Librería/.../" → "Oficina y Librería/..."
    precio: Number(off.Price) || 0,
    stock: Number(off.AvailableQuantity) || 0,
    imagen: img,
    link: p.linkText ? `${BASE}/${p.linkText}/p` : null,
  };
}

async function fetchPage(from) {
  const to = from + PAGE - 1;
  const url = `${BASE}/api/catalog_system/pub/products/search/?_from=${from}&_to=${to}`;
  const r = await axios.get(url, {
    timeout: 20000,
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    validateStatus: () => true,
  });
  if (r.status !== 200 && r.status !== 206) throw new Error('VTEX HTTP ' + r.status);
  return Array.isArray(r.data) ? r.data : [];
}

/**
 * Recorre todo el catálogo y hace upsert en compras_articulos (por sku UNIQUE).
 * No borra: marca activo=1 lo que vuelve a venir. (La limpieza de descontinuados se puede
 * agregar luego comparando fecha_sync.) Devuelve { paginas, procesados, upserts }.
 */
async function sincronizarCatalogo() {
  let from = 0, procesados = 0, upserts = 0, paginas = 0;
  while (from < MAX_OFFSET) {
    let arr;
    try { arr = await fetchPage(from); }
    catch (e) { console.error('[compras-sync]', 'page', from, e.message); break; }
    if (!arr.length) break;
    paginas++;
    for (const p of arr) {
      const a = mapProducto(p);
      if (!a.sku || !a.nombre) continue;
      try {
        await pool.query(
          `INSERT INTO compras_articulos
             (sku, codigo_ref, nombre, marca, categoria, precio, stock, imagen, link, activo, fecha_sync)
           VALUES (?,?,?,?,?,?,?,?,?,1,NOW())
           ON DUPLICATE KEY UPDATE
             codigo_ref=VALUES(codigo_ref), nombre=VALUES(nombre), marca=VALUES(marca),
             categoria=VALUES(categoria), precio=VALUES(precio), stock=VALUES(stock),
             imagen=VALUES(imagen), link=VALUES(link), activo=1, fecha_sync=NOW()`,
          [a.sku, a.codigo_ref, a.nombre, a.marca, a.categoria, a.precio, a.stock, a.imagen, a.link]);
        upserts++;
      } catch (e) { console.error('[compras-sync] upsert', a.sku, e.message); }
    }
    procesados += arr.length;
    from += PAGE;
    if (arr.length < PAGE) break;
    await sleep(250);   // cortesía con el servidor (no martillar)
  }
  console.log('[compras-sync]', JSON.stringify({ paginas, procesados, upserts }));
  return { paginas, procesados, upserts };
}

module.exports = { sincronizarCatalogo, mapProducto };
