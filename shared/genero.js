'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO — tratamiento según sexo de la ficha de usuario (usuarios.sexo).
   'F' → femenino, 'M' → masculino, NULL/otro → forma neutra masculina
   (cuentas técnicas o sin dato). "Hola" no necesita género — no usar esto ahí.
   Frontend: el sexo viaja en el objeto usuario del login (sessionStorage).
   ───────────────────────────────────────────────────────────────────────────── */
const F = s => String(s || '').toUpperCase() === 'F';
const estimado   = s => F(s) ? 'Estimada'   : 'Estimado';
const bienvenido = s => F(s) ? 'Bienvenida' : 'Bienvenido';
const listo      = s => F(s) ? 'lista'      : 'listo';
/* Genérico: sufijo("Design", "ado", "ada") o terminacionOA para o/a simple */
const oa = s => F(s) ? 'a' : 'o';
module.exports = { esFemenino: F, estimado, bienvenido, listo, oa };
