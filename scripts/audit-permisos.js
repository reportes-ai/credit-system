'use strict';
/* ─────────────────────────────────────────────────────────────────
   Auditoría de integridad del sistema de permisos
   Uso:  node scripts/audit-permisos.js
   Revisa automáticamente lo que no se alcanza a revisar a mano:
     1. Perfiles duplicados
     2. Usuarios apuntando a perfiles inexistentes
     3. Funcionalidades huérfanas (módulo inexistente o inactivo)
     4. Módulos activos sin ninguna funcionalidad
     5. Funcionalidades sin permisos definidos en ningún perfil
     6. Matriz: qué módulos (cards) ve cada perfil
     7. Perfiles con usuarios pero sin ningún módulo visible
   Sale con código 1 si encuentra problemas críticos.
   ───────────────────────────────────────────────────────────────── */
require('dotenv').config();
const pool = require('../shared/config/database');

(async () => {
  let problemas = 0;
  const titulo = t => console.log('\n═══ ' + t + ' ═══');
  const ok = m => console.log('  ✓ ' + m);
  const mal = m => { console.log('  ✗ ' + m); problemas++; };

  titulo('1. Perfiles duplicados');
  const [dups] = await pool.query(
    'SELECT nombre, COUNT(*) n FROM perfiles GROUP BY nombre HAVING n > 1');
  dups.length ? dups.forEach(d => mal(`"${d.nombre}" x${d.n}`)) : ok('Sin duplicados');

  titulo('2. Usuarios con perfil inexistente');
  const [huerf] = await pool.query(
    `SELECT u.id_usuario, u.email, u.id_perfil FROM usuarios u
     LEFT JOIN perfiles p ON p.id_perfil = u.id_perfil
     WHERE p.id_perfil IS NULL AND u.estado = 'activo'`);
  huerf.length ? huerf.forEach(u => mal(`${u.email} → perfil ${u.id_perfil} no existe`)) : ok('Todos los usuarios activos tienen perfil válido');

  titulo('3. Funcionalidades huérfanas (módulo inexistente)');
  const [fh] = await pool.query(
    `SELECT f.codigo, f.id_modulo FROM funcionalidades f
     LEFT JOIN modulos m ON m.id_modulo = f.id_modulo
     WHERE m.id_modulo IS NULL`);
  fh.length ? fh.forEach(f => mal(`${f.codigo} → módulo ${f.id_modulo} no existe`)) : ok('Todas las funcionalidades cuelgan de módulos existentes');
  const [fi] = await pool.query(
    `SELECT f.codigo, m.nombre FROM funcionalidades f
     JOIN modulos m ON m.id_modulo = f.id_modulo WHERE m.estado <> 'activo'`);
  if (fi.length) console.log(`  ⚠ ${fi.length} en módulos inactivos (sin card, permiso sigue operando): ` + fi.map(f=>f.codigo).join(', '));

  titulo('4. Módulos activos sin funcionalidades');
  const [msf] = await pool.query(
    `SELECT m.nombre FROM modulos m
     LEFT JOIN funcionalidades f ON f.id_modulo = m.id_modulo
     WHERE m.estado = 'activo' GROUP BY m.id_modulo, m.nombre HAVING COUNT(f.id_funcionalidad) = 0`);
  msf.length ? msf.forEach(m => mal(`"${m.nombre}" no tiene funcionalidades (card invisible para todos)`)) : ok('Todos los módulos tienen funcionalidades');

  titulo('5. Funcionalidades sin fila de permiso en algún perfil (heredarán default del seed)');
  const [[{ total: nPerf }]] = await pool.query('SELECT COUNT(*) total FROM perfiles');
  const [sinFila] = await pool.query(
    `SELECT f.codigo, COUNT(pp.id_perfil) n FROM funcionalidades f
     LEFT JOIN permisos_perfil pp ON pp.id_funcionalidad = f.id_funcionalidad
     GROUP BY f.id_funcionalidad, f.codigo HAVING n < ?`, [nPerf]);
  sinFila.length
    ? console.log(`  ⚠ ${sinFila.length} funcionalidades sin permiso definido en todos los perfiles (informativo)`)
    : ok('Matriz completa');

  titulo('6. Cards (módulos) visibles por perfil');
  const [vis] = await pool.query(
    `SELECT p.nombre AS perfil, GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.orden SEPARATOR ', ') AS modulos
     FROM perfiles p
     LEFT JOIN permisos_perfil pp ON pp.id_perfil = p.id_perfil AND pp.habilitado = 1
     LEFT JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad AND f.codigo <> 'usuarios_contrasena'
     LEFT JOIN modulos m ON m.id_modulo = f.id_modulo AND m.estado = 'activo'
     GROUP BY p.id_perfil, p.nombre ORDER BY p.nombre`);
  vis.forEach(v => console.log('  ' + v.perfil.padEnd(34) + '→ ' + (v.modulos || '(nada)')));

  titulo('7. Perfiles CON usuarios activos pero SIN módulos');
  const [pcu] = await pool.query(
    `SELECT p.nombre, COUNT(DISTINCT u.id_usuario) usuarios
     FROM perfiles p
     JOIN usuarios u ON u.id_perfil = p.id_perfil AND u.estado = 'activo'
     LEFT JOIN permisos_perfil pp ON pp.id_perfil = p.id_perfil AND pp.habilitado = 1
     LEFT JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad AND f.codigo <> 'usuarios_contrasena'
     LEFT JOIN modulos m ON m.id_modulo = f.id_modulo AND m.estado = 'activo'
     GROUP BY p.id_perfil, p.nombre
     HAVING COUNT(DISTINCT m.id_modulo) = 0`);
  pcu.length
    ? pcu.forEach(p => mal(`"${p.nombre}" tiene ${p.usuarios} usuario(s) que no ven NADA en el home`))
    : ok('Todo perfil con usuarios ve al menos un módulo');

  console.log('\n' + '─'.repeat(50));
  console.log(problemas ? `✗ ${problemas} problema(s) crítico(s) encontrados` : '✓ Integridad OK — sin problemas críticos');
  process.exit(problemas ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
