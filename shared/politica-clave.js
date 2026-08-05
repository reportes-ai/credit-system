'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   POLÍTICA DE CLAVES — motor único (Máxima 1 + principio paramétrico)

   El mantenedor "Seguridad de Usuarios" deja configurar ocho reglas: longitud
   mínima, mayúsculas, números, caracteres especiales, historial, repetir la
   clave anterior, vencimiento e intentos de login.

   Hasta el 05-08-2026 **ninguna de las de composición se aplicaba**. El
   Administrador configuraba "mínimo 8, con mayúscula, número y símbolo" y el
   sistema aceptaba `123456`, porque el único control era un `length < 6`
   escrito a mano en `cambiarClave`. La configuración se guardaba, se pintaba en
   pantalla, y no mandaba sobre nada — el mismo patrón del cambio de clave
   obligatorio, que también vivía solo en el navegador.

   Acá vive la regla, una sola vez, leída del mantenedor. Todo punto que fije
   una clave debe pasar por `validarClave()`.

   Las cuentas protegidas quedan fuera a propósito: son la última vía de entrada
   cuando algo se rompe, y una política nueva no puede dejar al dueño afuera.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const CACHE_MS = 60 * 1000;
let _cache = { exp: 0, cfg: null };

/** Configuración vigente del mantenedor, cacheada 60 s (se lee en cada login). */
async function config() {
  if (_cache.cfg && Date.now() < _cache.exp) return _cache.cfg;
  const cfg = {};
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM config_seguridad');
    rows.forEach(r => { cfg[r.clave] = r.valor; });
  } catch (e) {
    // Sin configuración legible no se inventan reglas: se aplica el mínimo duro.
    console.error('[politica-clave] no se pudo leer config_seguridad:', e.message);
  }
  _cache = { exp: Date.now() + CACHE_MS, cfg };
  return cfg;
}

/** Olvida la caché — para que un cambio en el mantenedor aplique al instante. */
const olvidarConfig = () => { _cache = { exp: 0, cfg: null }; };

/** Texto de las reglas vigentes, para mostrarlo junto al campo de clave. */
async function describir() {
  const c = await config();
  const min = parseInt(c.longitud_minima) || 6;
  const req = [];
  if (c.req_mayusculas === '1') req.push('una mayúscula');
  if (c.req_numeros === '1')    req.push('un número');
  if (c.req_especiales === '1') req.push('un carácter especial');
  let t = `Mínimo ${min} caracteres`;
  if (req.length) t += `, con al menos ${req.join(', ')}`;
  const hist = parseInt(c.historial_claves) || 0;
  if (hist > 0) t += `. No puede repetir las últimas ${hist}`;
  else if (c.permitir_misma_clave === '0') t += '. No puede ser la misma que la actual';
  return t + '.';
}

/**
 * Valida una clave nueva contra la política del mantenedor.
 *
 * @param {string} clave      la clave propuesta
 * @param {object} opts
 * @param {number} [opts.id_usuario]  para comparar contra el historial
 * @param {boolean} [opts.protegido]  cuenta protegida → exenta de la política
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function validarClave(clave, { id_usuario, protegido } = {}) {
  const txt = String(clave == null ? '' : clave);
  if (protegido) return { ok: true };            // exenta a propósito (ver cabecera)

  const c = await config();
  const min = parseInt(c.longitud_minima) || 6;

  if (txt.length < min)
    return { ok: false, error: `La contraseña debe tener al menos ${min} caracteres.` };
  if (c.req_mayusculas === '1' && !/[A-ZÁÉÍÓÚÑ]/.test(txt))
    return { ok: false, error: 'La contraseña debe incluir al menos una mayúscula.' };
  if (c.req_numeros === '1' && !/[0-9]/.test(txt))
    return { ok: false, error: 'La contraseña debe incluir al menos un número.' };
  if (c.req_especiales === '1' && !/[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]/.test(txt))
    return { ok: false, error: 'La contraseña debe incluir al menos un carácter especial (por ejemplo . - _ * #).' };

  // Historial: comparar contra las últimas N. Requiere bcrypt por hash guardado,
  // así que se limita a lo configurado y no se recorre la tabla entera.
  const hist = parseInt(c.historial_claves) || 0;
  const noRepetirActual = c.permitir_misma_clave === '0';
  if (id_usuario && (hist > 0 || noRepetirActual)) {
    const bcrypt = require('bcryptjs');
    try {
      if (noRepetirActual) {
        const [[u]] = await pool.query('SELECT password_hash FROM usuarios WHERE id_usuario = ?', [id_usuario]);
        if (u && u.password_hash && await bcrypt.compare(txt, u.password_hash))
          return { ok: false, error: 'La contraseña nueva no puede ser igual a la actual.' };
      }
      if (hist > 0) {
        const [prev] = await pool.query(
          'SELECT password_hash FROM usuarios_claves_hist WHERE id_usuario = ? ORDER BY id DESC LIMIT ?',
          [id_usuario, hist]);
        for (const p of prev)
          if (p.password_hash && await bcrypt.compare(txt, p.password_hash))
            return { ok: false, error: `La contraseña no puede repetir ninguna de las últimas ${hist}.` };
      }
    } catch (e) {
      // Un fallo del historial no debe impedir cambiar la clave: las reglas de
      // composición ya se cumplieron y bloquear acá dejaría al usuario sin salida.
      console.error('[politica-clave] historial:', e.message);
    }
  }
  return { ok: true };
}

/** Guarda el hash saliente en el historial y poda lo que sobra. */
async function registrarEnHistorial(id_usuario, hashAnterior) {
  if (!id_usuario || !hashAnterior) return;
  try {
    const c = await config();
    const hist = parseInt(c.historial_claves) || 0;
    if (hist <= 0) return;
    await pool.query('INSERT INTO usuarios_claves_hist (id_usuario, password_hash) VALUES (?,?)',
      [id_usuario, hashAnterior]);
    // Deja solo las últimas N+1: el historial no crece sin techo.
    const [viejas] = await pool.query(
      'SELECT id FROM usuarios_claves_hist WHERE id_usuario = ? ORDER BY id DESC LIMIT ?, 50',
      [id_usuario, hist + 1]);
    if (viejas.length)
      await pool.query('DELETE FROM usuarios_claves_hist WHERE id IN (?)', [viejas.map(v => v.id)]);
  } catch (e) { console.error('[politica-clave] registrar historial:', e.message); }
}

module.exports = { validarClave, describir, config, olvidarConfig, registrarEnHistorial };
