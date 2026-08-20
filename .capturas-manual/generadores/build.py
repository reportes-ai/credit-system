# -*- coding: utf-8 -*-
"""Construye el Manual de Operaciones completo."""
import estilo
import parte1, parte2, parte3, parte4

doc = estilo.nuevo_doc()
parte1.agregar(doc)
parte2.agregar(doc)
parte3.agregar(doc)
parte4.agregar(doc)
parte4.anexos(doc)

SALIDA = r'C:\Users\patri\Documents\Manual-Operaciones-Business-Suite.docx'
doc.save(SALIDA)
print('OK ->', SALIDA, '| capturas marcadas:', len(estilo.CAPTURAS))
