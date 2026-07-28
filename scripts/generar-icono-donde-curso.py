# -*- coding: utf-8 -*-
"""Ícono de la PWA "¿Dónde curso?" — un letrero caminero de dos brazos.

La idea: la app resuelve una bifurcación (AutoFin o Unidad de Crédito), así que
el ícono es un poste con dos flechas apuntando a lados opuestos. Se lee al tiro
en 48 px, que es el tamaño real en la pantalla de inicio de un celular.
Colores AutoFácil: fondo azul institucional, brazos blanco y celeste.
"""
from PIL import Image, ImageDraw
import os

NAVY_D = (1, 45, 112)      # #012D70
NAVY   = (1, 65, 162)      # #0141A2
CYAN   = (125, 211, 252)   # #7DD3FC — celeste claro: el #009AFE se perdía sobre el azul a 32 px
WHITE  = (255, 255, 255)
DEST   = r"C:\Users\patri\Documents\credit-system\api-gateway\public\donde-curso"

SS = 4          # supersampling: se dibuja 4× y se reduce → bordes suaves


def flecha(d, y, alto, x_ini, largo, punta, color, hacia):
    """Brazo del letrero con la punta en forma de flecha."""
    if hacia == "der":
        x0, x1 = x_ini, x_ini + largo
        pts = [(x0, y), (x1 - punta, y), (x1, y + alto / 2),
               (x1 - punta, y + alto), (x0, y + alto)]
    else:
        x0, x1 = x_ini - largo, x_ini
        pts = [(x1, y), (x0 + punta, y), (x0, y + alto / 2),
               (x0 + punta, y + alto), (x1, y + alto)]
    d.polygon(pts, fill=color)


def dibujar(size):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Fondo: cuadrado redondeado con degradé vertical navy → azul
    fondo = Image.new("RGB", (1, S))
    fd = ImageDraw.Draw(fondo)
    for y in range(S):
        t = y / max(1, S - 1)
        fd.point((0, y), fill=tuple(int(NAVY_D[i] + (NAVY[i] - NAVY_D[i]) * t) for i in range(3)))
    fondo = fondo.resize((S, S))
    mascara = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mascara).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img.paste(fondo, (0, 0), mascara)

    # Poste
    ancho_poste = int(S * 0.055)
    cx = S // 2
    d.rounded_rectangle([cx - ancho_poste // 2, int(S * 0.24), cx + ancho_poste // 2, int(S * 0.80)],
                        radius=ancho_poste // 2, fill=WHITE)

    # Dos brazos en direcciones opuestas: la decisión que resuelve la app
    alto = int(S * 0.145)
    largo = int(S * 0.325)
    punta = int(S * 0.105)
    flecha(d, int(S * 0.315), alto, cx - int(S * 0.012), largo, punta, WHITE, "der")
    flecha(d, int(S * 0.525), alto, cx + int(S * 0.012), largo, punta, CYAN, "izq")

    # Base del poste
    d.ellipse([cx - int(S * 0.075), int(S * 0.775), cx + int(S * 0.075), int(S * 0.825)],
              fill=(255, 255, 255, 90))

    return img.resize((size, size), Image.LANCZOS)


for size, nombre in [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")]:
    ruta = os.path.join(DEST, nombre)
    dibujar(size).save(ruta, "PNG")
    print("escrito", ruta, os.path.getsize(ruta), "bytes")

# Vista previa a los tamaños reales de uso, para revisar que se lea chico
prev = Image.new("RGB", (520, 210), (238, 242, 247))
x = 20
for s in [192, 96, 64, 48, 32]:
    prev.paste(dibujar(s), (x, 20))
    x += s + 16
prev.save(os.path.join(os.environ["TEMP"], "preview_icono.png"))
print("preview:", os.path.join(os.environ["TEMP"], "preview_icono.png"))
