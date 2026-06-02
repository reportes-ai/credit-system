/* Toast reutilizable para confirmación de orden guardado */
(function () {
  const STYLE = `
    #orden-toast {
      position: fixed; bottom: 28px; right: 28px; z-index: 9999;
      background: #166534; color: #fff; border-radius: 10px;
      padding: 13px 22px; font-size: .9rem; font-weight: 600;
      display: flex; align-items: center; gap: 10px;
      box-shadow: 0 4px 24px rgba(0,0,0,.22);
      transform: translateY(80px); opacity: 0;
      transition: transform .28s cubic-bezier(.4,0,.2,1), opacity .28s;
      pointer-events: none;
    }
    #orden-toast.visible { transform: translateY(0); opacity: 1; }
  `;
  const el = document.createElement('div');
  el.id = 'orden-toast';
  el.innerHTML = '<i class="bi bi-check-circle-fill" style="font-size:1.15rem"></i><span id="orden-toast-msg">Orden guardado</span>';
  document.head.insertAdjacentHTML('beforeend', `<style>${STYLE}</style>`);
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(el));

  let timer;
  window.mostrarToastOrden = function (msg) {
    document.getElementById('orden-toast-msg').textContent = msg || 'Orden guardado';
    el.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('visible'), 2600);
  };
})();
