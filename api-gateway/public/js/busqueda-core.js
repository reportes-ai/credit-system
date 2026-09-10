/* ─────────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO de búsqueda de texto libre (Pato 10-09-2026) — isomorfo, como rut-core:
   lo usan las páginas (window.AF_BUSCA) y los controladores (require).

   Regla de todos los buscadores del sistema:
   · sin distinguir mayúsculas ni tildes (la base es utf8mb4_bin: 'Karen' ≠ 'KAREN');
   · si lo escrito parece un número o un RUT, se compara también SIN puntos, guion
     ni espacios en ambos lados: "123456789", "12.345.678-9" y "12345678-9" son lo mismo;
   · cada buscador solo declara QUÉ campos revisa (ID financiera, N° de operación,
     ODP, RUT, cliente, dealer, ejecutivo, carta…), nunca CÓMO compara.
   ───────────────────────────────────────────────────────────────────────────── */
(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AF_BUSCA = api;
})(function () {
  const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const rutN = s => String(s == null ? '' : s).replace(/[.\-\s]/g, '').toUpperCase();
  // Número o RUT: 4+ dígitos, con K opcional al final (tras quitar separadores).
  const pareceNumero = q => /^\d{4,}K?$/.test(rutN(q));

  /* Página: ¿el texto aparece en alguno de los valores? */
  function coincide(valores, q) {
    const t = norm(q);
    if (!t) return true;
    const num = pareceNumero(q) ? rutN(q) : null;
    return (valores || []).some(v => {
      if (v == null || v === '') return false;
      if (norm(v).includes(t)) return true;
      return !!num && rutN(v).includes(num);
    });
  }

  /* Servidor: condición SQL "(a OR b OR …)" + parámetros, o null si no hay texto.
     texto    → columnas comparadas en MAYÚSCULAS con LIKE %texto%
     rut      → columnas comparadas sin puntos/guion/espacios (solo si lo escrito parece número o RUT)
     subTexto → fragmentos SQL con UN '?' que recibe %TEXTO% (p. ej. un EXISTS a otra tabla)
     subRut   → fragmentos SQL con UN '?' que recibe %NUMERO% normalizado */
  const RUT_SQL = col => `REPLACE(REPLACE(REPLACE(UPPER(${col}),'.',''),'-',''),' ','')`;
  function sql(q, { texto = [], rut = [], subTexto = [], subRut = [] } = {}) {
    const t = String(q == null ? '' : q).trim().toUpperCase();
    if (!t) return null;
    const conds = [], args = [];
    for (const c of texto) { conds.push(`UPPER(CAST(${c} AS CHAR)) LIKE ?`); args.push(`%${t}%`); }
    for (const f of subTexto) { conds.push(f); args.push(`%${t}%`); }
    if (pareceNumero(q)) {
      const n = `%${rutN(q)}%`;
      for (const c of rut) { conds.push(`${RUT_SQL(c)} LIKE ?`); args.push(n); }
      for (const f of subRut) { conds.push(f); args.push(n); }
    }
    return conds.length ? { sql: `(${conds.join(' OR ')})`, args } : null;
  }

  return { norm, rutN, pareceNumero, coincide, sql, RUT_SQL };
});
