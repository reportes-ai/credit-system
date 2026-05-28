# -*- coding: utf-8 -*-
import re, sys

src  = 'C:/Users/patri/autofacil-dashboard/index.html'
dest = 'C:/Users/patri/Documents/credit-system/api-gateway/public/dashboard/index.html'

with open(src, encoding='utf-8') as f:
    html = f.read()

# 1. Version
html = html.replace('<!-- v20260505_V3.6 -->', '<!-- v1.0 -->')

# 2. Eliminar login screen div
html = re.sub(r'<div id="login-screen".*?</div>\s*\n', '', html, flags=re.DOTALL)
print('login-screen removed:', '<div id="login-screen"' not in html)

# 3. Reemplazar bloque JS de login
old_login_js = re.search(
    r'<script>\s*// =+\s*// SISTEMA DE USUARIOS.*?</script>',
    html, flags=re.DOTALL
)
if old_login_js:
    icon = '\U0001f464'
    NEW_AUTH_JS = (
        '<script>\n'
        '// Auth: usa JWT del credit-system\n'
        "const _token = localStorage.getItem('token');\n"
        "const _usuario = JSON.parse(localStorage.getItem('usuario') || 'null');\n"
        "if (!_token) { window.location.href = '/login.html'; }\n\n"
        'let sesionActual = _usuario ? {\n'
        "  nombre: _usuario.nombre || _usuario.email || 'Usuario',\n"
        "  perfil: _usuario.perfil || 'USUARIO',\n"
        "  usuario: _usuario.email || ''\n"
        "} : { nombre: 'Usuario', perfil: 'USUARIO', usuario: '' };\n\n"
        'function actualizarTopbarUsuario() {\n'
        "  const el = document.getElementById('topbar-usuario');\n"
        '  if (el) {\n'
        "    el.innerHTML = '<span style=\"font-size:10px;color:#7bafd4\">" + icon + " ' + sesionActual.nombre + '</span>'\n"
        "      + '<button onclick=\"cerrarSesion()\" style=\"background:#1a3a6a;border:1px solid #2a4070;color:#aac4e8;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;margin-left:6px\">Salir</button>';\n"
        '  }\n'
        "  const tabAdmin = document.getElementById('tab-admin');\n"
        "  if (tabAdmin) tabAdmin.style.display = 'none';\n"
        '  aplicarPermisosNavTabs();\n'
        '}\n\n'
        'function cerrarSesion() {\n'
        "  localStorage.removeItem('token');\n"
        "  localStorage.removeItem('usuario');\n"
        "  window.location.href = '/login.html';\n"
        '}\n\n'
        "document.addEventListener('DOMContentLoaded', function() {\n"
        '  actualizarTopbarUsuario();\n'
        '});\n'
        '</script>'
    )
    html = html[:old_login_js.start()] + NEW_AUTH_JS + html[old_login_js.end():]
    print('login JS replaced: OK')
else:
    print('WARNING: login JS block not found')

# 4. Fetch de datos
OLD_FETCH = "const r = await fetch('/data/dashboard_data.json?t=' + Date.now());"
NEW_FETCH = ("const r = await fetch('/api/dashboard/datos', {\n"
             "      headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('token') || '') }\n"
             "    });")
if OLD_FETCH in html:
    html = html.replace(OLD_FETCH, NEW_FETCH)
    print('fetch replaced: OK')
else:
    print('WARNING: fetch not found')

# 5. Boton volver al sistema en topbar
OLD_TOPBAR = '<div id="topbar-usuario" style="display:flex;align-items:center;gap:6px;margin-left:auto">'
NEW_TOPBAR = (
    '<a href="/creditos" style="display:flex;align-items:center;gap:4px;color:#7bafd4;text-decoration:none;'
    'font-size:11px;padding:3px 10px;border:1px solid #2a4070;border-radius:4px;margin-left:auto;white-space:nowrap" '
    "onmouseover=\"this.style.color='#fff'\" onmouseout=\"this.style.color='#7bafd4'\">&#8592; Sistema</a>"
    '<div id="topbar-usuario" style="display:flex;align-items:center;gap:6px">'
)
if OLD_TOPBAR in html:
    html = html.replace(OLD_TOPBAR, NEW_TOPBAR)
    print('volver button added: OK')
else:
    print('WARNING: topbar-usuario not found')

with open(dest, 'w', encoding='utf-8') as f:
    f.write(html)
print('Saved. Lines:', html.count('\n'))
