# -*- coding: utf-8 -*-
"""Manual de Cobranza — Business Suite."""
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
import estilo
from estilo import *

def construir():
    estilo.CAPTURAS.clear()
    doc = nuevo_doc()

    # ── Portada ──────────────────────────────────────────────────────────────
    for _ in range(4): doc.add_paragraph()
    par = doc.add_paragraph(); par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.add_run().add_picture(LOGO, width=Cm(7))
    p(doc, '', despues=18)
    p(doc, 'MANUAL DE COBRANZA', bold=True, color=AZUL_OSCURO, size=30, align=WD_ALIGN_PARAGRAPH.CENTER)
    p(doc, 'AutoFácil Business Suite', color=AZUL, size=16, align=WD_ALIGN_PARAGRAPH.CENTER)
    p(doc, '', despues=30)
    p(doc, 'De la mora temprana al castigo:', size=12, align=WD_ALIGN_PARAGRAPH.CENTER, color=GRIS)
    p(doc, 'recuperar la cartera cumpliendo la ley, con cada gestión trazada.', size=12, align=WD_ALIGN_PARAGRAPH.CENTER, color=GRIS)
    for _ in range(6): doc.add_paragraph()
    p(doc, 'Versión 1.0 · Agosto 2026', size=11, align=WD_ALIGN_PARAGRAPH.CENTER, color=GRIS_SUAVE)
    p(doc, 'Documento interno — AutoFácil Crédito Automotriz', size=10, align=WD_ALIGN_PARAGRAPH.CENTER, color=GRIS_SUAVE)

    h1(doc, 'Control de versiones')
    tabla(doc, ('Versión', 'Fecha', 'Autor', 'Cambios'),
          (('1.0', 'Agosto 2026', 'Business Suite', 'Emisión inicial del tomo Cobranza'),),
          (2.2, 3.2, 4.0, 7.1))
    h2(doc, 'Cómo usar este manual')
    p(doc, 'Cada capítulo: para qué existe el proceso, quién lo hace, prerequisitos, paso a paso y los '
           'recuadros ⚠ OJO / 🔒 Regla del sistema / 🧾 Caso real / 📸 CAPTURA (pendientes en esta '
           'versión). Las rutas se escriben "Módulo → Card".')
    h1(doc, 'Índice')
    toc(doc)

    # ── 1. El marco ─────────────────────────────────────────────────────────
    h1(doc, '1. El marco: estados, motores y ley')
    p(doc, 'La cobranza trabaja sobre la cartera propia, con dos coordenadas por crédito: la ETAPA '
           '(OTORGADO — no cambia por la mora) y el ESTADO DE CARTERA, que describe el pago:')
    flujo(doc, 'VIGENTE → EN MORA → VENCIDO → JUDICIAL → CASTIGADO · AL DÍA')
    p(doc, 'Los estados de cartera y sus transiciones son paramétricos (mantenedor Estado Cartera). '
           'Confundir etapa con estado de cartera es el error conceptual más común: un crédito EN MORA '
           'sigue siendo, en etapa, OTORGADO.')
    h2(doc, '1.1 Los motores únicos')
    vineta(doc, 'la tasa de mora queda FIJA al otorgamiento (TMC de ese momento, según el modo configurado). El interés de mora que muestra la caja, el portal del cliente, el certificado y esta área es EL MISMO: sale de un solo motor.', bold_hasta='Interés por mora: ')
    vineta(doc, 'corren recién desde el día 21 de atraso, según los tramos de Parámetros de Cobranza.', bold_hasta='Gastos de cobranza: ')
    vineta(doc, 'los valores del crédito quedaron congelados al otorgar; el calendario de cuotas es inmutable.', bold_hasta='El calendario: ')
    h2(doc, '1.2 La ley')
    regla(doc, 'Ley 21.320 y Ley del Consumidor: tope de gestiones por semana (bloqueado por el '
               'sistema, no por criterio), horarios permitidos y registro de cada contacto. El sistema '
               'traza todas las gestiones en la bitácora CRM — lo que no está en la bitácora no '
               'existió.')

    # ── 2. Mora temprana ────────────────────────────────────────────────────
    h1(doc, '2. Mora temprana: los motores automáticos')
    p(doc, 'En los primeros tramos de atraso el sistema gestiona solo: correo por tramo y secuencia de '
           'WhatsApp, cada envío registrado en la bitácora CRM del crédito. El analista entra cuando '
           'la automatización no alcanza.')
    ficha(doc,
          'Los motores automáticos (correo y WhatsApp) · el Analista de Cobranza supervisa',
          'Configuración en Parámetros de Cobranza',
          'Automatizaciones activadas · tramos y plantillas configurados',
          'Cobranza → Automatizaciones · Mantenedores → Parámetros de Cobranza')
    vineta(doc, 'cada tramo de atraso tiene su plantilla y su momento. Se apagan y prenden por parámetro, sin tocar código.', bold_hasta='Correo por tramo: ')
    vineta(doc, 'secuencia configurada de mensajes; respeta el tope semanal de gestiones.', bold_hasta='WhatsApp: ')
    vineta(doc, 'todo envío queda en la bitácora CRM del crédito, visible para cualquier analista que tome el caso.', bold_hasta='Trazabilidad: ')
    captura(doc, 'Cobranza → bitácora CRM de un crédito', 'La línea de tiempo con gestiones automáticas y humanas mezcladas.')
    regla(doc, 'El tope semanal de gestiones está bloqueado por sistema: si un contacto más viola el '
               'tope, el sistema no lo deja salir. No es optativo.')

    # ── 3. Pre-judicial ─────────────────────────────────────────────────────
    h1(doc, '3. Cobranza pre-judicial')
    p(doc, 'Cuando la mora avanza, la gestión pasa a ser humana: llamadas, visitas y compromisos de '
           'pago, todos registrados.')
    ficha(doc,
          'Analista de Cobranza',
          'Acceso a Cobranza → Pre-judicial',
          'Crédito en mora fuera del tramo temprano',
          'Cobranza → Pre-judicial')
    paso(doc, 1, 'Tomar el caso', 'La bandeja muestra la cartera en gestión con su atraso, saldo y '
         'última gestión.')
    paso(doc, 2, 'Gestionar y registrar', 'Cada llamada o contacto queda en la bitácora con su '
         'resultado. Los compromisos de pago se registran con fecha y monto.')
    paso(doc, 3, 'Seguir el compromiso', 'Un compromiso cumplido normaliza; uno incumplido escala la '
         'gestión.')
    captura(doc, 'Cobranza → Pre-judicial', 'La bandeja de casos con atraso y compromisos visibles.')
    p(doc, 'Herramientas de apoyo: la PWA de Terreno (ruta del día, check-in GPS y fotos) para las '
           'visitas, y el Score de Mora (mora histórica por segmento) para priorizar la cartera.')

    # ── 4. Judicial ─────────────────────────────────────────────────────────
    h1(doc, '4. Cobranza judicial')
    p(doc, 'La demanda con abogado, tribunal y etapa procesal. Los catálogos (abogados, tribunales, '
           'etapas) son paramétricos.')
    ficha(doc,
          'Analista de Cobranza · abogados externos',
          'Acceso a Cobranza → Judicial',
          'Decisión de demandar tomada · antecedentes del crédito completos',
          'Cobranza → Judicial')
    paso(doc, 1, 'Abrir la causa', 'Crédito, abogado, tribunal y etapa procesal inicial.')
    paso(doc, 2, 'Actualizar etapas', 'Cada avance procesal se registra; la historia completa queda en '
         'el caso.')
    captura(doc, 'Cobranza → Judicial', 'Una causa con su tribunal, abogado y etapa procesal.')

    # ── 5. Castigo ──────────────────────────────────────────────────────────
    h1(doc, '5. Castigo')
    p(doc, 'La baja contable de la operación incobrable. Es la última estación y es deliberadamente '
           'manual.')
    ficha(doc,
          'Gerencia — doble firma gerencial',
          'Atribución de castigo',
          'Gestión agotada · antecedentes de la causa',
          'Tesorería → Provisiones + Castigos')
    regla(doc, 'El castigo NUNCA es automático. Exige doble firma gerencial y genera su asiento '
               'contable por regla de centralización. El cierre automático mensual de provisiones no '
               'castiga: solo provisiona.')
    p(doc, 'Tras el castigo, el crédito queda CASTIGADO en estado de cartera. La recuperación '
           'posterior, si la hay, entra por caja como cualquier pago y genera su asiento.')
    captura(doc, 'Castigos', 'Una solicitud de castigo con sus dos firmas.')

    # ── 6. Pagos y salidas ──────────────────────────────────────────────────
    h1(doc, '6. Cómo paga el cliente: caja, portal y prepago')
    p(doc, 'Las vías de normalización que la cobranza debe conocer (el detalle operativo vive en el '
           'Manual de Contabilidad y Tesorería):')
    vineta(doc, 'cuotas individuales o en lote, con la mora y gastos del motor único. Comprobante con timbre PAGADO.', bold_hasta='Caja (Tesorería → Caja): ')
    vineta(doc, 'el cliente entra con RUT + código OTP a /mis-creditos, ve sus cuotas y su mora — los MISMOS valores que la caja, porque es el mismo motor.', bold_hasta='Portal del cliente: ')
    vineta(doc, 'saldar el crédito completo: al valor del motor (caja) o con descuento negociado (Aplicación de Fondos, con firmas). El orden de condonación es fijo: primero gastos, luego intereses; capital nunca.', bold_hasta='Prepago: ')
    vineta(doc, 'un abono no identificado espera en Cuentas Transitorias y se aplica al aclarar el pagador — si un cliente jura que pagó y no aparece, revisar ahí primero.', bold_hasta='Transitorias: ')
    advertencia(doc, 'Si el cliente reclama que "el sistema le cobra distinto" entre el portal, el '
                     'certificado y la caja: no puede pasar, es el mismo motor. Si de verdad difiere, '
                     'es un bug — reportarlo a TI de inmediato con los pantallazos.')

    # ── 7. Provisiones (vista cobranza) ─────────────────────────────────────
    h1(doc, '7. Lo que tu gestión mueve: provisiones y score')
    vineta(doc, 'cada tramo de atraso provisiona un porcentaje del saldo (Parámetros de Cobranza). Tu gestión que normaliza un crédito libera provisión el mes siguiente; el deterioro la constituye. El sistema la calcula solo al cierre.', bold_hasta='Provisiones: ')
    vineta(doc, 'la mora histórica por segmento alimenta la política de crédito — la cobranza de hoy es la política de admisión de mañana.', bold_hasta='Score de Mora: ')
    vineta(doc, 'las gestiones y compromisos quedan en el CRM y alimentan los informes del área.', bold_hasta='CRM: ')

    # ── Anexos ──────────────────────────────────────────────────────────────
    h1(doc, 'Anexo A. Síntomas frecuentes y su causa')
    tabla(doc, ('Síntoma', 'Causa probable', 'Qué hacer'),
          (('No puedo hacer otra gestión esta semana', 'Tope legal de gestiones alcanzado', 'Esperar: el bloqueo es de ley, no del sistema (cap. 1)'),
           ('El cliente dice que pagó y sigue en mora', 'Abono no identificado', 'Buscar en Cuentas Transitorias (cap. 6)'),
           ('La mora del portal difiere de la de caja', 'No puede pasar (mismo motor)', 'Reportar a TI con pantallazos (cap. 6)'),
           ('Los gastos de cobranza no aparecen', 'Menos de 21 días de atraso', 'Corren desde el día 21 (cap. 1)'),
           ('Quiero condonar parte del capital', 'No existe esa vía', 'El capital nunca se condona (cap. 6)'),
           ('El crédito moroso no sale en mi informe de otorgados', 'Confusión etapa / estado de cartera', 'EN MORA sigue siendo OTORGADO en etapa (cap. 1)')),
          (5.6, 5.6, 5.3))

    h1(doc, 'Anexo B. Glosario')
    tabla(doc, ('Término', 'Significado'),
          (('Estado de cartera', 'Cómo paga el crédito: VIGENTE, EN MORA, VENCIDO, PREPAGADO, CASTIGADO'),
           ('TMC', 'Tasa máxima convencional; la tasa de mora queda fija al otorgamiento'),
           ('Tramo', 'Rango de días de atraso que define gestiones, gastos y provisión'),
           ('Bitácora CRM', 'Registro único de todas las gestiones de un crédito'),
           ('Compromiso de pago', 'Promesa registrada con fecha y monto; su cumplimiento se sigue'),
           ('Provisión', 'Reconocimiento contable del riesgo por tramo de mora'),
           ('Castigo', 'Baja contable del incobrable; doble firma gerencial'),
           ('Aplicación de Fondos', 'Prepago con descuento negociado y cadena de firmas'),
           ('Score de Mora', 'Mora histórica por segmento; alimenta la política de crédito'),
           ('PWA Terreno', 'App móvil de visitas: ruta del día, check-in GPS y fotos')),
          (4.3, 12.2))

    h1(doc, 'Anexo C. Capturas pendientes de esta versión')
    p(doc, 'Recorrer las pantallas en este orden y reemplazar cada recuadro gris:')
    tabla(doc, ('N°', 'Pantalla', 'Qué debe mostrar'),
          tuple((str(n), pant, det) for n, pant, det in estilo.CAPTURAS),
          (1.2, 6.3, 9.0))

    return doc

if __name__ == '__main__':
    d = construir()
    out = r'C:\Users\patri\Documents\Manual-Cobranza-Business-Suite.docx'
    d.save(out)
    print('OK ->', out, '| capturas:', len(estilo.CAPTURAS))
