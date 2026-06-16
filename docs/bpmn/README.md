# Diagramas de Procesos (BPMN 2.0) — AutoFácil

Diagramas de flujo de los procesos del sistema en notación **BPMN 2.0**, listos para
abrir y editar en **Bizagi Modeler** (gratuito).

## Cómo abrirlos en Bizagi Modeler
1. Descargar Bizagi Modeler (gratis): https://www.bizagi.com/es/plataforma/modeler
2. `Archivo → Importar → BPMN 2.0…` y elegir el `.bpmn` deseado.
3. Quedan editables: mover figuras, cambiar textos, agregar lanes/pools, exportar a PDF/Word/imagen.

> También abren en draw.io (diagrams.net), Camunda Modeler y cualquier herramienta BPMN 2.0.

## Procesos
| Archivo | Proceso | Hitos / estados clave |
|---|---|---|
| `01-credito-end-to-end.bpmn` | Crédito end-to-end | INGRESO → APROBADO/RECHAZADO → OTORGADO/NO OTORGADO → Post Venta → VIGENTE |
| `02-comisiones-mensuales.bpmn` | Comisiones mensuales | La carta manda; si no, parámetros (`comisiones_variables`) → COMISIÓN A PAGAR |
| `03-cobranza.bpmn` | Cobranza | Gestión CRM → compromiso → pago / carta de cobranza |
| `04-brokerage-tesoreria.bpmn` | Brokerage (Tesorería) | Factura → Pago → Transferencia (pago de saldo al dealer) |
| `05-fundantes-brokerage.bpmn` | Fundantes Brokerage | PENDIENTE → CARGADOS → APROBADOS/RECHAZADOS |
| `06-incorporacion-dealer.bpmn` | Incorporación de Dealer | BORRADOR → EN_REVISION (pool Operaciones) → APROBADA/RECHAZADA → VIGENTE |
| `07-atencion-remota.bpmn` | Atención Remota | Autoregistro → aprobación → chat (ESPERA→ACTIVA→CERRADA) + video WebRTC |
| `08-consulta-dealernet.bpmn` | Consulta DealerNet | SOAP Central de Información → retcode → parsea → guarda |

## Regenerar
Las definiciones viven en `generate.js` (nodos + flujos + layout). Para regenerar tras un cambio:

```bash
node docs/bpmn/generate.js
```

El script recalcula las coordenadas (Diagram Interchange) automáticamente, así que basta
editar los pasos en `generate.js` sin tocar coordenadas a mano.
