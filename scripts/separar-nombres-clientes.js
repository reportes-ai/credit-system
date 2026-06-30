#!/usr/bin/env node
/**
 * separar-nombres-clientes.js — Parser de nombres chilenos: separa nombre_completo en
 * nombres + apellido_paterno + apellido_materno SOLO para los clientes que tienen el
 * completo pero NO las partes. No pisa partes existentes. Backup en bkp_nombres_clientes.
 *
 * Orden chileno: [nombres...] [paterno] [materno]. Absorbe partículas de apellido compuesto
 * (DE/DEL/LA/LAS/LOS, SAN/SANTA, ST, DA/DOS/DAS). Salta empresas y nombres demasiado cortos
 * (los deja sin partes, para revisión manual — no adivina).
 *
 * Validado contra los ~5.000 que ya tienen partes (golden master de precisión).
 * Uso:  node scripts/separar-nombres-clientes.js            (valida + dry-run)
 *       node scripts/separar-nombres-clientes.js --apply
 */
'use strict';
const pool = require('../shared/config/database');
const APPLY = process.argv.includes('--apply');

const PART = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'SAN', 'SANTA', 'ST', 'DA', 'DOS', 'DAS']);
const EMPRESA = /\b(SPA|LTDA|EIRL|LIMITADA|SOCIEDAD|SOC|COMERCIAL|INVERSIONES|INVERSION|S\.?A\.?|AUTOMOTRIZ|TRANSPORTES?|SERVICIOS?|CONSTRUCTORA|COMERCIALIZADORA|EMPRESA|LEASING|SEGUROS?|RENT|RENTACAR)\b/;
const JUNK = /\b(SIN INFORMACION|CONFIRMAR|POR CONFIRMAR|XXXX+|NN\b|NO APLICA|TODO)\b/;
const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

function parse(c) {
  const raw = norm(c);
  if (!raw) return { flag: 'vacio' };
  if (EMPRESA.test(raw)) return { flag: 'empresa' };
  if (JUNK.test(raw)) return { flag: 'junk' };
  const t = raw.split(' ');
  if (t.length < 3) return { flag: 'corto' };
  let matStart = t.length - 1;
  while (matStart - 1 >= 0 && PART.has(t[matStart - 1])) matStart--;
  let patEnd = matStart - 1;
  if (patEnd < 1) return { flag: 'corto' };
  let patStart = patEnd;
  while (patStart - 1 >= 1 && PART.has(t[patStart - 1])) patStart--;
  if (patStart < 1) return { flag: 'corto' };
  return { nombres: t.slice(0, patStart).join(' '), pat: t.slice(patStart, patEnd + 1).join(' '), mat: t.slice(matStart).join(' ') };
}

(async () => {
  try {
    // 1) Validación contra los que YA tienen partes
    const [ref] = await pool.query("SELECT nombre_completo c, nombres, apellido_paterno pat, apellido_materno mat FROM clientes WHERE nombres<>'' AND apellido_paterno<>'' AND apellido_materno<>'' AND nombre_completo<>''");
    let ok = 0, mis = 0, fl = 0;
    for (const r of ref) { const p = parse(r.c); if (p.flag) { fl++; continue; } (norm(p.nombres) === norm(r.nombres) && norm(p.pat) === norm(r.pat) && norm(p.mat) === norm(r.mat)) ? ok++ : mis++; }
    console.log(`Validación: ${ok}/${ok + mis} exactos (${(ok / (ok + mis) * 100).toFixed(1)}%), ${fl} flaggeados, de ${ref.length} de referencia`);

    // 2) Objetivo: solo completo, sin partes
    const [tgt] = await pool.query("SELECT id_cliente, nombre_completo c FROM clientes WHERE nombre_completo<>'' AND (nombres IS NULL OR nombres='') AND (apellido_paterno IS NULL OR apellido_paterno='')");
    const conf = [], flags = {};
    for (const r of tgt) { const p = parse(r.c); if (p.flag) { flags[p.flag] = (flags[p.flag] || 0) + 1; } else conf.push({ id: r.id_cliente, ...p }); }
    console.log(`\nObjetivo (solo completo): ${tgt.length} | parseables: ${conf.length} | flaggeados: ${JSON.stringify(flags)}`);
    console.log('Ejemplos parseados:'); conf.slice(0, 6).forEach(p => console.log(`  [${p.nombres} | ${p.pat} | ${p.mat}]`));

    if (!APPLY) { console.log('\n[DRY-RUN] --apply para escribir (solo rellena partes vacías; backup en bkp_nombres_clientes).'); return; }

    const [[bk]] = await pool.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='bkp_nombres_clientes'");
    if (!bk.n) {
      await pool.query('CREATE TABLE bkp_nombres_clientes (id_cliente BIGINT PRIMARY KEY, nombres VARCHAR(200), apellido_paterno VARCHAR(200), apellido_materno VARCHAR(200))');
      await pool.query('INSERT INTO bkp_nombres_clientes SELECT id_cliente, nombres, apellido_paterno, apellido_materno FROM clientes');
      console.log('✓ Backup bkp_nombres_clientes');
    }
    let n = 0;
    for (const p of conf) {
      await pool.query('UPDATE clientes SET nombres=?, apellido_paterno=?, apellido_materno=? WHERE id_cliente=? AND (nombres IS NULL OR nombres=\'\')', [p.nombres, p.pat, p.mat, p.id]);
      if (++n % 1000 === 0) console.log(`  ${n}/${conf.length}`);
    }
    console.log(`✓ ${n} clientes separados. Flaggeados (${JSON.stringify(flags)}) quedan sin partes para revisión manual.`);
  } catch (e) { console.error('ERR', e.message); } finally { await pool.end(); }
})();
