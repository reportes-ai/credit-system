/* ─────────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO del formato de los nombres (Máxima 1).

   Convención acordada con Pato el 25-09-2026:
     · EMPRESAS (dealers, parques, razón social, nombre de fantasía) → MAYÚSCULAS.
       Es como llegan de Trinidad y del SII, y como ya se guardaban los parques y
       los locales. Evita discutir si va "SpA", "SPA" o "Spa".
     · PERSONAS (socios, representante legal, contactos, vendedores, titular de la
       cuenta) → Nombre Propio, con las partículas en minúscula: "Juan de la Fuente".

   Isomorfo: se usa igual en el backend (require) y en el navegador (window.AF_NOMBRES),
   para que el input formatee EXACTAMENTE igual que lo que después guarda el servidor.

   Ninguna de las dos funciones inventa datos: si entra vacío, sale vacío.
   ───────────────────────────────────────────────────────────────────────────── */
(function (raiz) {
  'use strict';

  const limpiar = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  /* Partículas que quedan en minúscula cuando van en medio del nombre. */
  const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'lo', 'los', 'y', 'e', 'da', 'das', 'do', 'dos', 'van', 'von', 'di', 'der']);

  /* Siglas y formas jurídicas que van SIEMPRE en mayúscula, aunque el texto sea de personas. */
  const SIGLAS = new Set(['SPA', 'SA', 'S.A.', 'LTDA', 'EIRL', 'E.I.R.L.', 'SPA.', 'RUT', 'II', 'III', 'IV']);

  /* Empresa / razón social / nombre de fantasía → MAYÚSCULAS. */
  function empresa(s) {
    return limpiar(s).toUpperCase();
  }

  /* Persona → Nombre Propio. Respeta guiones y apóstrofes ("Riquelme-Soto", "O'Higgins")
     y deja en minúscula las partículas que no abren el nombre. */
  function persona(s) {
    const txt = limpiar(s);
    if (!txt) return '';
    // Abren palabra el inicio, el guion, la barra y el apóstrofe: "JUAN-PABLO" → "Juan-Pablo", "O'HIGGINS" → "O'Higgins"
    const capital = p => p.toLowerCase().replace(/(^|[-\/'’])(\p{L})/gu, (_, sep, letra) => sep + letra.toUpperCase());
    return txt.split(' ').map((palabra, i) => {
      const plana = palabra.toUpperCase();
      if (SIGLAS.has(plana)) return plana;
      const baja = palabra.toLowerCase();
      if (i > 0 && PARTICULAS.has(baja)) return baja;
      return capital(palabra);
    }).join(' ');
  }

  /* Para comparar dos nombres sin que el formato importe (mayúsculas, acentos, espacios).
     Es otra magnitud que el formato de presentación: NO se fusiona con las de arriba. */
  function comparable(s) {
    return limpiar(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  /* ¿Cambiar el formato de este texto altera algo más que mayúsculas/acentos/espacios? */
  const mismoNombre = (a, b) => comparable(a) === comparable(b);

  /* Titular de una cuenta bancaria: sigue la marca "la cuenta es de" del dealer o de la
     ficha (cuenta_tipo). EMPRESA → mayúsculas; PERSONA o sin marca → Nombre Propio. */
  const titular = (s, cuentaTipo) =>
    String(cuentaTipo || '').trim().toUpperCase() === 'EMPRESA' ? empresa(s) : persona(s);

  /* Regla del sistema (ficha de incorporación): un RUT sobre 50.000.000 es de empresa.
     Sirve donde no se guarda la marca, solo el RUT de la cuenta. */
  function cuentaTipoDeRut(rut) {
    const cuerpo = String(rut || '').replace(/[^0-9kK]/g, '').slice(0, -1).replace(/\D/g, '');
    if (!cuerpo) return '';
    return parseInt(cuerpo, 10) > 50000000 ? 'EMPRESA' : 'PERSONA';
  }

  const API = { empresa, persona, titular, cuentaTipoDeRut, comparable, mismoNombre, limpiar };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (raiz) raiz.AF_NOMBRES = API;
})(typeof window !== 'undefined' ? window : null);
