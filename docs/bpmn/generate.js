'use strict';
/**
 * Generador de diagramas BPMN 2.0 para los procesos de AutoFácil.
 * Produce un .bpmn por proceso (importable en Bizagi Modeler) con su sección
 * de Diagram Interchange (coordenadas) calculada automáticamente, para que las
 * figuras queden posicionadas y no apiladas en el origen.
 *
 * Layout: columna central = "spine" (camino feliz, vertical); col 1 = ramas a
 * la derecha (excepciones / alternativas); los loopbacks suben por la misma
 * columna de la rama. Correr:  node docs/bpmn/generate.js
 */
const fs = require('fs');
const path = require('path');

/* ── Geometría ───────────────────────────────────────────────────────────── */
const DIM = {
  start: { w: 36, h: 36 }, end: { w: 36, h: 36 },
  task: { w: 160, h: 76 }, gateway: { w: 50, h: 50 }, subprocess: { w: 190, h: 96 },
};
const colX = c => 240 + c * 260;
const rowY = r => 110 + r * 140;
const dim = n => DIM[n.type] || DIM.task;
const cx = n => colX(n.col);
const cy = n => rowY(n.row);
const bbox = n => { const d = dim(n); return { x: cx(n) - d.w / 2, y: cy(n) - d.h / 2, w: d.w, h: d.h }; };
const port = (n, side) => {
  const b = bbox(n), midX = b.x + b.w / 2, midY = b.y + b.h / 2;
  if (side === 't') return { x: midX, y: b.y };
  if (side === 'b') return { x: midX, y: b.y + b.h };
  if (side === 'l') return { x: b.x, y: midY };
  return { x: b.x + b.w, y: midY }; // 'r'
};
function route(from, to, fromSide, toSide) {
  const sp = port(from, fromSide), tp = port(to, toSide);
  if ('tb'.includes(fromSide) && 'tb'.includes(toSide) && from.col === to.col) return [sp, tp];
  const elbow = 'lr'.includes(fromSide) ? { x: tp.x, y: sp.y } : { x: sp.x, y: tp.y };
  return [sp, elbow, tp];
}

/* ── XML helpers ─────────────────────────────────────────────────────────── */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const R = n => Math.round(n);
const elTag = t => (t === 'start' ? 'startEvent' : t === 'end' ? 'endEvent' : t === 'gateway' ? 'exclusiveGateway' : t === 'subprocess' ? 'task' : 'task');

function buildBpmn(proc) {
  const nodes = proc.nodes, flows = proc.flows.map((f, i) => ({ id: 'f' + (i + 1), ...f }));
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const incoming = id => flows.filter(f => f.to === id).map(f => f.id);
  const outgoing = id => flows.filter(f => f.from === id).map(f => f.id);

  // Proceso
  const procEls = nodes.map(n => {
    const tag = elTag(n.type);
    const ins = incoming(n.id).map(id => `      <bpmn:incoming>${id}</bpmn:incoming>`).join('\n');
    const outs = outgoing(n.id).map(id => `      <bpmn:outgoing>${id}</bpmn:outgoing>`).join('\n');
    const body = [ins, outs].filter(Boolean).join('\n');
    return `    <bpmn:${tag} id="${n.id}" name="${esc(n.name)}">\n${body ? body + '\n' : ''}    </bpmn:${tag}>`;
  }).join('\n');
  const seqEls = flows.map(f =>
    `    <bpmn:sequenceFlow id="${f.id}" sourceRef="${f.from}" targetRef="${f.to}"${f.name ? ` name="${esc(f.name)}"` : ''} />`
  ).join('\n');

  // DI
  const shapes = nodes.map(n => {
    const b = bbox(n);
    const marker = n.type === 'gateway' ? ' isMarkerVisible="true"' : '';
    return `      <bpmndi:BPMNShape id="${n.id}_di" bpmnElement="${n.id}"${marker}>\n` +
      `        <omgdc:Bounds x="${R(b.x)}" y="${R(b.y)}" width="${b.w}" height="${b.h}" />\n` +
      `      </bpmndi:BPMNShape>`;
  }).join('\n');
  const edges = flows.map(f => {
    const wps = route(byId[f.from], byId[f.to], f.fs || 'b', f.ts || 't')
      .map(p => `        <omgdi:waypoint x="${R(p.x)}" y="${R(p.y)}" />`).join('\n');
    return `      <bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}">\n${wps}\n      </bpmndi:BPMNEdge>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:omgdc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:omgdi="http://www.omg.org/spec/DD/20100524/DI"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  id="Defs_${proc.id}" targetNamespace="http://autofacil.cl/bpmn">
  <bpmn:process id="${proc.id}" name="${esc(proc.name)}" isExecutable="false">
${procEls}
${seqEls}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="${proc.id}_diagram">
    <bpmndi:BPMNPlane id="${proc.id}_plane" bpmnElement="${proc.id}">
${shapes}
${edges}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}

/* ── Definición de los 8 procesos ────────────────────────────────────────── */
const N = (id, type, name, col, row) => ({ id, type, name, col, row });
const F = (from, to, name, fs, ts) => ({ from, to, name, fs, ts });

const PROCESOS = [
  {
    id: 'Credito_EndToEnd', file: '01-credito-end-to-end.bpmn',
    name: 'Proceso de Crédito (end-to-end)',
    nodes: [
      N('s', 'start', 'Carga masiva Excel / Digitación', 0, 0),
      N('t1', 'task', 'Operación creada (INGRESO)', 0, 1),
      N('t2', 'task', 'Revisión del analista de crédito', 0, 2),
      N('g1', 'gateway', '¿Aprueba el crédito?', 0, 3),
      N('e1', 'end', 'RECHAZADO', 1, 3),
      N('t3', 'task', 'APROBADO', 0, 4),
      N('g2', 'gateway', '¿Se otorga la operación?', 0, 5),
      N('e2', 'end', 'NO OTORGADO', 1, 5),
      N('t4', 'task', 'OTORGADO', 0, 6),
      N('sp', 'subprocess', 'Post Venta: fundantes → liberación → pago saldo → cartola → comisión', 0, 7),
      N('e3', 'end', 'Operación VIGENTE / cerrada', 0, 8),
    ],
    flows: [
      F('s', 't1'), F('t1', 't2'), F('t2', 'g1'),
      F('g1', 'e1', 'No', 'r', 'l'), F('g1', 't3', 'Sí'),
      F('t3', 'g2'), F('g2', 'e2', 'No', 'r', 'l'), F('g2', 't4', 'Sí'),
      F('t4', 'sp'), F('sp', 'e3'),
    ],
  },
  {
    id: 'Comisiones_Mensuales', file: '02-comisiones-mensuales.bpmn',
    name: 'Cálculo de Comisiones Mensuales',
    nodes: [
      N('s', 'start', 'Cierre de mes', 0, 0),
      N('t1', 'task', 'Calcula comisión por ejecutivo', 0, 1),
      N('g1', 'gateway', '¿Viene participación en la carta?', 0, 2),
      N('t2', 'task', 'Usa participación de la carta (manda)', 1, 2),
      N('t3', 'task', 'Calcula por parámetros (comisiones_variables)', 0, 3),
      N('g2', 'gateway', '', 0, 4),
      N('t4', 'task', 'Revisión de comisiones (ejecutivo)', 0, 5),
      N('t5', 'task', 'Marca COMISIÓN A PAGAR', 0, 6),
      N('e', 'end', 'Comisión pagada', 0, 7),
    ],
    flows: [
      F('s', 't1'), F('t1', 'g1'),
      F('g1', 't2', 'Sí', 'r', 'l'), F('g1', 't3', 'No'),
      F('t2', 'g2', null, 'b', 'r'), F('t3', 'g2'),
      F('g2', 't4'), F('t4', 't5'), F('t5', 'e'),
    ],
  },
  {
    id: 'Cobranza', file: '03-cobranza.bpmn',
    name: 'Proceso de Cobranza',
    nodes: [
      N('s', 'start', 'Cuota vencida / mora', 0, 0),
      N('t1', 'task', 'Genera gestión de cobranza (CRM)', 0, 1),
      N('g1', 'gateway', '¿Contacto exitoso?', 0, 2),
      N('t2', 'task', 'Reagenda nuevo intento', 1, 2),
      N('t3', 'task', 'Acuerdo / compromiso de pago', 0, 3),
      N('g2', 'gateway', '¿Paga?', 0, 4),
      N('t4', 'task', 'Emite carta de cobranza / deriva', 1, 4),
      N('e1', 'end', 'Deriva a cobranza judicial/externa', 1, 5),
      N('t5', 'task', 'Registra pago / regulariza', 0, 5),
      N('e2', 'end', 'Cuota al día', 0, 6),
    ],
    flows: [
      F('s', 't1'), F('t1', 'g1'),
      F('g1', 't2', 'No', 'r', 'l'), F('t2', 't1', 'reintento', 't', 'r'),
      F('g1', 't3', 'Sí'), F('t3', 'g2'),
      F('g2', 't4', 'No', 'r', 'l'), F('t4', 'e1'),
      F('g2', 't5', 'Sí'), F('t5', 'e2'),
    ],
  },
  {
    id: 'Brokerage_Tesoreria', file: '04-brokerage-tesoreria.bpmn',
    name: 'Brokerage — Pago de Saldo (Tesorería)',
    nodes: [
      N('s', 'start', 'Operación liberada a pago (brokerage)', 0, 0),
      N('t1', 'task', 'Registra factura (emisor / dealer)', 0, 1),
      N('g1', 'gateway', '¿Factura válida?', 0, 2),
      N('e1', 'end', 'Observa / rechaza factura', 1, 2),
      N('t2', 'task', 'Registra pago', 0, 3),
      N('t3', 'task', 'Registra transferencia (comprobante)', 0, 4),
      N('e2', 'end', 'Saldo pagado al dealer', 0, 5),
    ],
    flows: [
      F('s', 't1'), F('t1', 'g1'),
      F('g1', 'e1', 'No', 'r', 'l'), F('g1', 't2', 'Sí'),
      F('t2', 't3'), F('t3', 'e2'),
    ],
  },
  {
    id: 'Fundantes_Brokerage', file: '05-fundantes-brokerage.bpmn',
    name: 'Fundantes Brokerage (carga y validación)',
    nodes: [
      N('s', 'start', 'Operación requiere fundantes (PENDIENTE)', 0, 0),
      N('t1', 'task', 'Ejecutivo carga documentos (→ CARGADOS)', 0, 1),
      N('t2', 'task', 'Analista valida cada documento', 0, 2),
      N('g1', 'gateway', '¿Todos aprobados?', 0, 3),
      N('t3', 'task', 'RECHAZADOS / faltantes — corrige y recarga', 1, 3),
      N('t4', 'task', 'Fundantes APROBADOS', 0, 4),
      N('e', 'end', 'Habilita liberación a pago', 0, 5),
    ],
    flows: [
      F('s', 't1'), F('t1', 't2'), F('t2', 'g1'),
      F('g1', 't3', 'No', 'r', 'l'), F('t3', 't1', 'recarga', 't', 'r'),
      F('g1', 't4', 'Sí'), F('t4', 'e'),
    ],
  },
  {
    id: 'Incorporacion_Dealer', file: '06-incorporacion-dealer.bpmn',
    name: 'Incorporación de Dealer (ficha)',
    nodes: [
      N('s', 'start', 'Ejecutivo crea ficha (BORRADOR)', 0, 0),
      N('t1', 'task', 'Completa General + Parque + documentos', 0, 1),
      N('t2', 'task', 'Envía a revisión (EN_REVISION, pool Operaciones)', 0, 2),
      N('t3', 'task', 'Operaciones revisa la ficha', 0, 3),
      N('g1', 'gateway', '¿Aprueba?', 0, 4),
      N('t4', 'task', 'RECHAZADA — observa y devuelve', 1, 4),
      N('t5', 'task', 'APROBADA → Dealer VIGENTE', 0, 5),
      N('e', 'end', 'Dealer habilitado para operar', 0, 6),
    ],
    flows: [
      F('s', 't1'), F('t1', 't2'), F('t2', 't3'), F('t3', 'g1'),
      F('g1', 't4', 'No', 'r', 'l'), F('t4', 't1', 'corrige', 't', 'r'),
      F('g1', 't5', 'Sí'), F('t5', 'e'),
    ],
  },
  {
    id: 'Atencion_Remota', file: '07-atencion-remota.bpmn',
    name: 'Atención Remota de Dealers',
    nodes: [
      N('s', 'start', 'Dealer solicita cuenta (autoregistro)', 0, 0),
      N('t1', 'task', 'Solicitud PENDIENTE → notifica ejecutivos', 0, 1),
      N('g1', 'gateway', '¿Aprueba la solicitud?', 0, 2),
      N('e1', 'end', 'RECHAZADA', 1, 2),
      N('t2', 'task', 'Crea cuenta + link de acceso (magic link)', 0, 3),
      N('t3', 'task', 'Dealer ingresa (login o link, sesión recordada)', 0, 4),
      N('t4', 'task', 'Inicia conversación (cola ESPERA)', 0, 5),
      N('t5', 'task', 'Ejecutivo toma el chat (ACTIVA, hasta 3 en paralelo)', 0, 6),
      N('g2', 'gateway', '¿Requiere video?', 0, 7),
      N('t6', 'task', 'Videollamada WebRTC (audio / video / pantalla)', 1, 7),
      N('t7', 'task', 'Intercambio de mensajes y documentos', 0, 8),
      N('t8', 'task', 'Cierra conversación (CERRADA)', 0, 9),
      N('e2', 'end', 'Atención finalizada', 0, 10),
    ],
    flows: [
      F('s', 't1'), F('t1', 'g1'),
      F('g1', 'e1', 'No', 'r', 'l'), F('g1', 't2', 'Sí'),
      F('t2', 't3'), F('t3', 't4'), F('t4', 't5'), F('t5', 'g2'),
      F('g2', 't6', 'Sí', 'r', 'l'), F('t6', 't7', null, 'b', 'r'),
      F('g2', 't7', 'No'), F('t7', 't8'), F('t8', 'e2'),
    ],
  },
  {
    id: 'Consulta_DealerNet', file: '08-consulta-dealernet.bpmn',
    name: 'Consulta DealerNet (Central de Información)',
    nodes: [
      N('s', 'start', 'Requiere antecedentes de un RUT', 0, 0),
      N('t1', 'task', 'Selecciona productos activos (mantenedor)', 0, 1),
      N('t2', 'task', 'Arma envelope SOAP + credenciales (env)', 0, 2),
      N('t3', 'task', 'POST a Central de Información (DealerNet)', 0, 3),
      N('g1', 'gateway', '¿retcode = 0?', 0, 4),
      N('t4', 'task', 'Registra error (retcode / retmsg)', 1, 4),
      N('e1', 'end', 'Consulta fallida', 1, 5),
      N('t5', 'task', 'Parsea output por producto', 0, 5),
      N('t6', 'task', 'Guarda en dealernet_consultas + muestra en ficha', 0, 6),
      N('e2', 'end', 'Antecedentes disponibles', 0, 7),
    ],
    flows: [
      F('s', 't1'), F('t1', 't2'), F('t2', 't3'), F('t3', 'g1'),
      F('g1', 't4', 'No', 'r', 'l'), F('t4', 'e1'),
      F('g1', 't5', 'Sí'), F('t5', 't6'), F('t6', 'e2'),
    ],
  },
];

/* ── Escritura ───────────────────────────────────────────────────────────── */
const outDir = __dirname;
for (const p of PROCESOS) {
  fs.writeFileSync(path.join(outDir, p.file), buildBpmn(p), 'utf8');
  console.log('✓', p.file);
}
console.log(`\n${PROCESOS.length} diagramas BPMN generados en ${outDir}`);
