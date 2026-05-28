# -*- coding: utf-8 -*-
"""Agrega el botón Dashboard en todas las barras de navegación."""
import os, glob

PUBLIC = r'C:/Users/patri/Documents/credit-system/api-gateway/public'

BTN = (
    '\n    <a href="/dashboard" title="Dashboard Analytics" '
    'style="display:flex;align-items:center;gap:5px;color:rgba(255,255,255,0.85);'
    'text-decoration:none;font-size:12px;font-weight:500;padding:5px 10px;'
    'border:1px solid rgba(255,255,255,0.25);border-radius:6px;transition:.15s" '
    "onmouseover=\"this.style.background='rgba(255,255,255,0.1)'\" "
    "onmouseout=\"this.style.background='transparent'\">\n"
    '      <i class="bi bi-bar-chart-line" style="font-size:15px"></i> Dashboard\n'
    '    </a>'
)

# Anchor principal: antes del user-chip
ANCHOR_CHIP  = '<div class="user-chip">'
# Anchor alternativo (tipos-documento y similares)
ANCHOR_ALT   = '</div>\n</nav>'

SKIP = {'dashboard/index.html'}  # ya tiene botón o no aplica

files = glob.glob(PUBLIC + '/**/*.html', recursive=True) + glob.glob(PUBLIC + '/*.html')

modified = skipped = already = 0
for fpath in sorted(files):
    rel = fpath.replace(PUBLIC + '/', '').replace(PUBLIC + '\\', '').replace('\\', '/')
    if rel in SKIP:
        skipped += 1
        continue

    with open(fpath, encoding='utf-8') as f:
        html = f.read()

    # Saltar si ya tiene el botón
    if '/dashboard' in html and 'bar-chart-line' in html:
        already += 1
        continue

    # Saltar si no tiene topnav
    if 'class="topnav"' not in html:
        skipped += 1
        continue

    if ANCHOR_CHIP in html:
        html = html.replace(ANCHOR_CHIP, BTN + '\n    ' + ANCHOR_CHIP, 1)
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(html)
        print(f'  ✓ {rel}')
        modified += 1
    else:
        # Fallback: insertar al inicio del topnav-right
        anchor2 = '<div class="topnav-right">'
        if anchor2 in html:
            html = html.replace(anchor2, anchor2 + BTN, 1)
            with open(fpath, 'w', encoding='utf-8') as f:
                f.write(html)
            print(f'  ✓ {rel} (alt)')
            modified += 1
        else:
            print(f'  ⚠ sin anchor: {rel}')

print(f'\nModificados: {modified} | Ya tenían: {already} | Saltados: {skipped}')
