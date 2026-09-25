/* ─────────────────────────────────────────────────────────────────────────────
   Formato automático de los nombres en los formularios.

   Usa el motor único /js/nombres-core.js — el MISMO archivo que requiere el backend — y
   formatea al salir del campo todo input marcado con:

     <input data-nombre="empresa">   → MAYÚSCULAS   (dealer, razón social, parque)
     <input data-nombre="persona">   → Nombre Propio (socio, contacto)
     <input data-nombre="persona" data-nombre-segun="#fCuentaTipo">
                                     → sigue la marca EMPRESA/PERSONA de ese campo
                                       (titular de la cuenta bancaria)

   Se formatea en `blur`, no en cada tecla: escribir sigue siendo natural y el
   usuario ve el resultado al salir del campo. Los campos que se llenan por
   código (cargar una ficha) también pasan por acá al enviarse, porque el backend
   aplica EXACTAMENTE el mismo motor.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  function aplicar(el) {
    if (!el || !window.AF_NOMBRES) return;
    let tipo = el.getAttribute('data-nombre');
    /* data-nombre-segun="#idDelSelect": el titular de la cuenta sigue la marca
       "la cuenta es de EMPRESA / PERSONA", no un formato fijo. */
    const segun = el.getAttribute('data-nombre-segun');
    if (segun) {
      const campo = document.querySelector(segun);
      tipo = campo && String(campo.value || '').toUpperCase() === 'EMPRESA' ? 'empresa' : 'persona';
    }
    /* data-nombre-segun-rut="#rut_cuenta": donde no se guarda la marca, se deduce del RUT
       de la cuenta con la misma regla de la ficha (sobre 50.000.000 = empresa). */
    const segunRut = el.getAttribute('data-nombre-segun-rut');
    if (segunRut) {
      const campo = document.querySelector(segunRut);
      tipo = campo && window.AF_NOMBRES.cuentaTipoDeRut(campo.value) === 'EMPRESA' ? 'empresa' : 'persona';
    }
    const fn = tipo === 'empresa' ? window.AF_NOMBRES.empresa : tipo === 'persona' ? window.AF_NOMBRES.persona : null;
    if (!fn) return;
    const antes = el.value;
    const despues = fn(antes);
    if (despues !== antes) {
      el.value = despues;
      // Por si la página escucha cambios (autoguardado, validación en vivo)
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // Delegado: sirve también para los campos que se crean después (socios dinámicos)
  document.addEventListener('focusout', e => {
    const el = e.target;
    if (el && el.matches && el.matches('[data-nombre]')) aplicar(el);
  }, true);

  window.AF_FORMATEAR_NOMBRE = aplicar;
})();
