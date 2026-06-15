'use strict';
const pptxgen = require('pptxgenjs');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const sharp = require('sharp');
const FA = require('react-icons/fa');

// ── Paleta de marca AutoFácil ──────────────────────────────────────────────
const NAVY='012D70', BLUE='0141A2', ACCENT='0255C5', SKY='009AFE',
      ICE='CADCFC', LIGHT='F1F5FB', WHITE='FFFFFF', GOLD='F2A900',
      INK='1E293B', MUTED='64748B', CARD='FFFFFF';
const HF='Georgia', BF='Calibri';

async function icon(Comp, color='#0141A2', size=256){
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp,{color,size:String(size)}));
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return 'image/png;base64,'+png.toString('base64');
}
const shadow = () => ({ type:'outer', color:'8AA0C0', blur:9, offset:3, angle:135, opacity:0.22 });

(async () => {
  // Preload icons
  const ic = {};
  const need = {
    layers:FA.FaLayerGroup, sliders:FA.FaSlidersH, seed:FA.FaSeedling, expand:FA.FaExpand,
    dash:FA.FaTachometerAlt, sign:FA.FaFileSignature, card:FA.FaCreditCard, users:FA.FaUsers,
    hands:FA.FaHandshake, flow:FA.FaProjectDiagram, bank:FA.FaUniversity, phone:FA.FaPhoneVolume,
    chart:FA.FaChartLine, bell:FA.FaBell, shield:FA.FaShieldAlt, ushield:FA.FaUserShield,
    route:FA.FaRoute, bolt:FA.FaBolt, cloud:FA.FaCloud, check:FA.FaCheck, times:FA.FaTimes,
    scale:FA.FaBalanceScale, invoice:FA.FaFileInvoiceDollar, cogs:FA.FaCogs, arrow:FA.FaArrowRight,
    lock:FA.FaLock, bull:FA.FaBullhorn, money:FA.FaCoins, clock:FA.FaClock, plug:FA.FaPlug
  };
  async function load(color){ const m={}; for(const k in need) m[k]=await icon(need[k],color); return m; }
  const icB = await load('#0141A2');   // azul (sobre claro)
  const icN = await load('#012D70');   // navy
  const icW = await load('#FFFFFF');   // blanco (sobre navy)
  const icG = await load('#F2A900');   // dorado
  const icS = await load('#009AFE');   // sky

  const pres = new pptxgen();
  pres.defineLayout({ name:'W', width:13.333, height:7.5 });
  pres.layout='W';
  pres.author='AutoFácil'; pres.title='AutoFácil — Plataforma operativa';
  const W=13.333, H=7.5;

  // Header reutilizable para slides claras
  function header(s, kicker, title){
    s.addShape(pres.shapes.RECTANGLE,{x:0.55,y:0.5,w:0.16,h:0.62,fill:{color:GOLD}});
    if(kicker) s.addText(kicker.toUpperCase(),{x:0.85,y:0.46,w:11,h:0.3,fontFace:BF,fontSize:12,bold:true,color:ACCENT,charSpacing:3,margin:0});
    s.addText(title,{x:0.83,y:0.66,w:12,h:0.7,fontFace:HF,fontSize:30,bold:true,color:NAVY,margin:0});
  }
  // Tarjeta ícono + título + texto
  function iconCard(s, x,y,w,h, iconData, title, body, opt={}){
    s.addShape(pres.shapes.RECTANGLE,{x,y,w,h,fill:{color:opt.fill||CARD},line:{color:opt.line||'E2E8F0',width:1},shadow:shadow()});
    s.addShape(pres.shapes.OVAL,{x:x+0.3,y:y+0.32,w:0.7,h:0.7,fill:{color:opt.chip||'EAF1FB'}});
    s.addImage({data:iconData,x:x+0.47,y:y+0.49,w:0.36,h:0.36});
    s.addText(title,{x:x+0.3,y:y+1.12,w:w-0.6,h:0.4,fontFace:BF,fontSize:15,bold:true,color:opt.tc||NAVY,margin:0});
    s.addText(body,{x:x+0.3,y:y+1.5,w:w-0.6,h:h-1.7,fontFace:BF,fontSize:11.5,color:opt.bc||MUTED,margin:0,lineSpacingMultiple:1.02});
  }
  // Fila ícono + texto
  function iconRow(s, x,y,w, iconData, title, body){
    s.addShape(pres.shapes.OVAL,{x,y,w:0.62,h:0.62,fill:{color:'EAF1FB'}});
    s.addImage({data:iconData,x:x+0.16,y:y+0.16,w:0.30,h:0.30});
    s.addText([{text:title+'  ',options:{bold:true,color:NAVY}},{text:body,options:{color:MUTED}}],
      {x:x+0.8,y:y-0.04,w:w-0.9,h:0.72,fontFace:BF,fontSize:12.5,margin:0,valign:'middle',lineSpacingMultiple:1.0});
  }

  // ───────────────────────── SLIDE 1 — Portada ─────────────────────────
  let s = pres.addSlide(); s.background={color:NAVY};
  s.addShape(pres.shapes.RECTANGLE,{x:0,y:0,w:W,h:0.18,fill:{color:GOLD}});
  s.addShape(pres.shapes.OVAL,{x:9.7,y:-2.2,w:6.5,h:6.5,fill:{color:BLUE},line:{type:'none'}});
  s.addShape(pres.shapes.OVAL,{x:11.2,y:3.6,w:5.2,h:5.2,fill:{color:ACCENT},line:{type:'none'}});
  s.addImage({data:icG.layers,x:0.9,y:1.25,w:0.7,h:0.7});
  s.addText('AUTOFÁCIL · CRÉDITO AUTOMOTRIZ',{x:1.75,y:1.32,w:9,h:0.4,fontFace:BF,fontSize:14,bold:true,color:ICE,charSpacing:3,margin:0});
  s.addText('De repositorio de créditos\na plataforma operativa',{x:0.9,y:2.25,w:10.6,h:2.1,fontFace:HF,fontSize:46,bold:true,color:WHITE,margin:0,lineSpacingMultiple:1.0});
  s.addText('El software que administra el negocio completo — y se adapta solo, sin programadores.',
    {x:0.92,y:4.5,w:9.6,h:0.8,fontFace:BF,fontSize:17,color:ICE,margin:0});
  s.addText([{text:'Presentación a Directorio',options:{bold:true,color:WHITE}},{text:'   ·   Junio 2026',options:{color:SKY}}],
    {x:0.92,y:6.5,w:9,h:0.4,fontFace:BF,fontSize:14,margin:0});

  // ───────────────────── SLIDE 2 — Cambio de paradigma ─────────────────
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'El cambio de paradigma','No es un archivo. Es la plataforma del negocio.');
  s.addText('El sistema no solo almacena créditos: administra la operación completa — desde la aprobación hasta la cobranza — con control, trazabilidad y autonomía total para el negocio.',
    {x:0.85,y:1.5,w:11.6,h:0.7,fontFace:BF,fontSize:14,color:INK,margin:0});
  const cy=2.55, cw=3.78, ch=3.7, gap=0.28; let cx=0.85;
  iconCard(s,cx,cy,cw,ch,icB.layers,'Plataforma integral','Reemplaza planillas Excel dispersas y procesos manuales por un flujo único, en la nube, compartido y auditable.'); cx+=cw+gap;
  iconCard(s,cx,cy,cw,ch,icG.sliders,'100% Paramétrico','El Administrador configura montos, tasas, impuestos, estados, textos y permisos — sin depender de un programador.',{chip:'FFF3D6',fill:'FFFDF6',line:'F3D88A',tc:NAVY}); cx+=cw+gap;
  iconCard(s,cx,cy,cw,ch,icB.seed,'Diseñada para crecer','Cada proceso nuevo se suma como módulo. La arquitectura soporta más volumen y más áreas sin rehacer lo existente.');

  // ───────────────────── SLIDE 3 — Mapa de capacidades ────────────────
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Mapa de capacidades','Una sola plataforma, todo el negocio');
  const caps=[
    [icB.dash,'Dashboard','Indicadores en tiempo real'],
    [icB.sign,'Aprobación','Cartas y “cuatro ojos”'],
    [icB.card,'Créditos','Carga masiva y gestión'],
    [icB.users,'Clientes','Ficha integral 360°'],
    [icB.hands,'Comisiones','Cálculo y cartolas'],
    [icB.flow,'Post Venta','Pagos por workflow'],
    [icB.bank,'Tesorería','Cuentas y cajas'],
    [icB.phone,'Cobranza','Mora y gastos (normativa)'],
    [icB.chart,'Reportería','Informes a gerencia'],
    [icB.bell,'Alertas','Notificaciones y push'],
  ];
  { const cols=5, gx=0.85, gw=2.34, gpad=0.16, gwid=(W-2*gx+gpad)/cols-gpad, gh=2.0, gyy=2.05;
    caps.forEach((c,i)=>{ const col=i%cols, row=Math.floor(i/cols);
      const x=gx+col*(gwid+gpad), y=gyy+row*(gh+0.3);
      s.addShape(pres.shapes.RECTANGLE,{x,y,w:gwid,h:gh,fill:{color:CARD},line:{color:'E2E8F0',width:1},shadow:shadow()});
      s.addShape(pres.shapes.OVAL,{x:x+gwid/2-0.36,y:y+0.26,w:0.72,h:0.72,fill:{color:'EAF1FB'}});
      s.addImage({data:c[0],x:x+gwid/2-0.19,y:y+0.43,w:0.38,h:0.38});
      s.addText(c[1],{x:x+0.1,y:y+1.12,w:gwid-0.2,h:0.34,align:'center',fontFace:BF,fontSize:14,bold:true,color:NAVY,margin:0});
      s.addText(c[2],{x:x+0.1,y:y+1.46,w:gwid-0.2,h:0.46,align:'center',fontFace:BF,fontSize:10.5,color:MUTED,margin:0});
    });
  }

  // ───────────────────── SLIDE 4 — Proceso end-to-end ─────────────────
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Recorrido del proceso','Del primer contacto al pago y la cobranza');
  const steps=[
    [icB.sign,'Cotización\ny aprobación'],
    [icB.card,'Otorgamiento\ndel crédito'],
    [icB.bank,'Pago al\nconcesionario'],
    [icB.hands,'Comisión\ny cartola'],
    [icB.phone,'Cobranza'],
    [icB.chart,'Reportería\ngerencial'],
  ];
  { const n=steps.length, x0=0.7, x1=12.63, bw=1.78, bh=2.5, yb=2.7;
    const slot=(x1-x0)/n;
    steps.forEach((st,i)=>{ const x=x0+i*slot+(slot-bw)/2;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE,{x,y:yb,w:bw,h:bh,rectRadius:0.12,fill:{color:i===3?NAVY:CARD},line:{color:i===3?NAVY:'E2E8F0',width:1},shadow:shadow()});
      const chip=i===3?'13386E':'EAF1FB';
      s.addShape(pres.shapes.OVAL,{x:x+bw/2-0.42,y:yb+0.34,w:0.84,h:0.84,fill:{color:chip}});
      s.addImage({data:i===3?icW.hands:st[0],x:x+bw/2-0.23,y:yb+0.53,w:0.46,h:0.46});
      s.addText(String(i+1),{x:x+0.12,y:yb+0.12,w:0.5,h:0.4,fontFace:HF,fontSize:16,bold:true,color:i===3?SKY:ICE,margin:0});
      s.addText(st[1],{x:x+0.1,y:yb+1.45,w:bw-0.2,h:0.9,align:'center',fontFace:BF,fontSize:13.5,bold:true,color:i===3?WHITE:NAVY,margin:0,lineSpacingMultiple:0.95});
      if(i<n-1) s.addImage({data:icG.arrow,x:x+bw+(slot-bw)/2-0.18,y:yb+bh/2-0.14,w:0.28,h:0.28});
    });
    s.addText('Todo el ciclo en una sola herramienta — cada etapa registra quién la ejecutó y cuándo.',
      {x:0.85,y:5.75,w:11.6,h:0.5,fontFace:BF,fontSize:13,italic:true,color:MUTED,margin:0});
  }

  // ───────────────────── SLIDE 5 — Del crédito al pago ─────────────────
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Funcionalidades clave','Del crédito al pago');
  { const x=0.85, yy=2.0, rh=1.18, ww=11.6;
    iconRow(s,x,yy+0*rh,ww,icB.sign,'Originación','Simulador de créditos, cartas de aprobación con doble validación (“cuatro ojos”) e historial.');
    iconRow(s,x,yy+1*rh,ww,icB.card,'Créditos','Carga masiva por Excel, paginación, y cálculo automático de tramo MAYOR/MENOR 200 UF y TMC vigente.');
    iconRow(s,x,yy+2*rh,ww,icB.flow,'Post Venta','Pago al concesionario por workflow con etapas y atribuciones por perfil — totalmente trazable.');
    iconRow(s,x,yy+3*rh,ww,icB.invoice,'Comisiones e impuestos','Cartolas acumulativas, Boleta vs. Factura, IVA y Retención calculados y órdenes de pago agrupadas.');
  }

  // ───────────────────── SLIDE 6 — Control y soporte ───────────────────
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Funcionalidades clave','Control, soporte y visibilidad');
  { const x=0.85, yy=2.0, rh=1.18, ww=11.6;
    iconRow(s,x,yy+0*rh,ww,icB.bank,'Tesorería','Cuentas transitorias, cajas, cierre de caja y brokerage.');
    iconRow(s,x,yy+1*rh,ww,icB.phone,'Cobranza','Interés por mora y gasto de cobranza calculados según normativa (Ley 19.496), por tramos en UF.');
    iconRow(s,x,yy+2*rh,ww,icB.scale,'CRM y gestiones','Registro de gestiones y seguimiento comercial centralizado.');
    iconRow(s,x,yy+3*rh,ww,icB.chart,'Reportería y Dashboard','Reportería “Tailor Made” para gerencia, exportación a Excel y desempeño de analistas.');
  }

  // ═══════════════ SLIDE 7 — 100% PARAMÉTRICO (héroe) ═════════════════
  s = pres.addSlide(); s.background={color:NAVY};
  s.addShape(pres.shapes.RECTANGLE,{x:0,y:0,w:W,h:0.18,fill:{color:GOLD}});
  s.addShape(pres.shapes.OVAL,{x:10.3,y:-2.6,w:6.6,h:6.6,fill:{color:BLUE},line:{type:'none'}});
  s.addShape(pres.shapes.RECTANGLE,{x:0.9,y:0.85,w:0.16,h:0.62,fill:{color:GOLD}});
  s.addText('NUESTRA MAYOR VENTAJA',{x:1.2,y:0.82,w:9,h:0.34,fontFace:BF,fontSize:13,bold:true,color:GOLD,charSpacing:3,margin:0});
  s.addImage({data:icG.bolt,x:0.9,y:1.55,w:0.62,h:0.62});
  s.addText('100% Paramétrico',{x:1.7,y:1.42,w:10,h:0.95,fontFace:HF,fontSize:42,bold:true,color:WHITE,margin:0});
  s.addText('Ante un cambio legal o funcional, la empresa reacciona al instante: el propio Administrador lo configura desde un mantenedor — sin programadores, sin proveedores externos, sin esperas.',
    {x:0.95,y:2.55,w:11.4,h:0.9,fontFace:BF,fontSize:16,color:ICE,margin:0,lineSpacingMultiple:1.05});
  // Stat callouts
  const stats=[['Minutos','de reacción, no semanas de espera'],['$ 0','en desarrollo externo por cada ajuste'],['100%','autonomía: lo decide el negocio']];
  { const x0=0.95, sw=3.74, sh=1.55, sgap=0.3, yy=3.7;
    stats.forEach((st,i)=>{ const x=x0+i*(sw+sgap);
      s.addShape(pres.shapes.RECTANGLE,{x,y:yy,w:sw,h:sh,fill:{color:'0B2A63'},line:{color:'1E4A93',width:1}});
      s.addShape(pres.shapes.RECTANGLE,{x,y:yy,w:0.12,h:sh,fill:{color:GOLD}});
      s.addText(st[0],{x:x+0.35,y:yy+0.18,w:sw-0.5,h:0.7,fontFace:HF,fontSize:34,bold:true,color:GOLD,margin:0});
      s.addText(st[1],{x:x+0.36,y:yy+0.95,w:sw-0.6,h:0.5,fontFace:BF,fontSize:12,color:ICE,margin:0,lineSpacingMultiple:0.98});
    });
  }
  // Ejemplos chips
  s.addText('Se ajustan desde un mantenedor y rigen de inmediato:',{x:0.95,y:5.55,w:11,h:0.32,fontFace:BF,fontSize:12.5,bold:true,color:WHITE,margin:0});
  { const chips=['Nueva Retención de Honorarios','Cambio de IVA','Nuevo tramo de cobranza','Nueva tasa / UF'];
    let cxp=0.95; const cyp=5.95;
    chips.forEach(t=>{ const wch=0.40+t.length*0.098;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE,{x:cxp,y:cyp,w:wch,h:0.5,rectRadius:0.25,fill:{color:'13386E'},line:{color:SKY,width:1}});
      s.addText(t,{x:cxp,y:cyp,w:wch,h:0.5,align:'center',valign:'middle',fontFace:BF,fontSize:11.5,color:WHITE,margin:0});
      cxp+=wch+0.22;
    });
  }

  // ───────────────────── SLIDE 8 — Seguridad y gobierno ────────────────
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Control y confianza','Seguridad, trazabilidad y gobierno del proceso');
  { const cy2=2.0, cw2=5.66, ch2=2.25, gx=0.85, gp=0.28;
    iconCard(s,gx,cy2,cw2,ch2,icB.ushield,'Permisos por perfil','Matriz de Perfiles y Permisos: cada acción sensible (emitir, pagar, reversar, cargar) se habilita por perfil desde una pantalla.',{});
    iconCard(s,gx+cw2+gp,cy2,cw2,ch2,icB.route,'Trazabilidad por etapa','Cada paso del flujo registra autor y fecha. El orden del proceso se respeta; lo configurable son los valores, no la estructura.',{});
    iconCard(s,gx,cy2+ch2+gp,cw2,ch2,icB.lock,'Acceso seguro','Autenticación con token (JWT), cambio de contraseña propio y auditoría de integridad de permisos.',{});
    iconCard(s,gx+cw2+gp,cy2+ch2+gp,cw2,ch2,icB.bull,'Operación asistida','Notificaciones y alertas por evento, ayuda contextual y base de conocimiento editable por el negocio.',{});
  }

  // ───────────────────── SLIDE 9 — Antes vs Con la plataforma ──────────
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'El salto','De planillas y procesos manuales a una plataforma de control');
  { const colW=5.66, x1=0.85, x2=0.85+colW+0.33, yy=1.95, hh=4.6;
    // Antes
    s.addShape(pres.shapes.RECTANGLE,{x:x1,y:yy,w:colW,h:0.7,fill:{color:'E2E8F0'}});
    s.addText('ANTES — Excel y manual',{x:x1,y:yy,w:colW,h:0.7,align:'center',valign:'middle',fontFace:BF,fontSize:15,bold:true,color:'475569',margin:0});
    s.addShape(pres.shapes.RECTANGLE,{x:x1,y:yy+0.7,w:colW,h:hh-0.7,fill:{color:WHITE},line:{color:'E2E8F0',width:1}});
    const before=['Datos dispersos en múltiples planillas','Cálculos manuales (comisión, mora, impuestos)','Sin trazabilidad de quién aprobó o pagó','Cada cambio depende de un proveedor externo','Riesgo operacional y de control'];
    before.forEach((t,i)=>{ const y=yy+1.0+i*0.72;
      s.addImage({data:icN.times,x:x1+0.32,y:y+0.04,w:0.26,h:0.26});
      s.addText(t,{x:x1+0.75,y:y-0.06,w:colW-1.0,h:0.5,fontFace:BF,fontSize:12.5,color:'64748B',valign:'middle',margin:0});
    });
    // Con plataforma
    s.addShape(pres.shapes.RECTANGLE,{x:x2,y:yy,w:colW,h:0.7,fill:{color:NAVY}});
    s.addText('CON LA PLATAFORMA',{x:x2,y:yy,w:colW,h:0.7,align:'center',valign:'middle',fontFace:BF,fontSize:15,bold:true,color:WHITE,margin:0});
    s.addShape(pres.shapes.RECTANGLE,{x:x2,y:yy+0.7,w:colW,h:hh-0.7,fill:{color:WHITE},line:{color:'C9DBF5',width:1.5}});
    const after=['Fuente única, en la nube, compartida','Cálculo automático y parametrizado','Auditoría por etapa, autor y fecha','El Administrador configura — sin terceros','Permisos por perfil y validaciones'];
    after.forEach((t,i)=>{ const y=yy+1.0+i*0.72;
      s.addImage({data:icB.check,x:x2+0.32,y:y+0.04,w:0.26,h:0.26});
      s.addText(t,{x:x2+0.75,y:y-0.06,w:colW-1.0,h:0.5,fontFace:BF,fontSize:12.5,bold:true,color:INK,valign:'middle',margin:0});
    });
  }

  // ───────────────────── SLIDE 10 — Cierre / escalar ───────────────────
  s = pres.addSlide(); s.background={color:NAVY};
  s.addShape(pres.shapes.RECTANGLE,{x:0,y:0,w:W,h:0.18,fill:{color:GOLD}});
  s.addShape(pres.shapes.OVAL,{x:-2.4,y:3.6,w:6.4,h:6.4,fill:{color:BLUE},line:{type:'none'}});
  s.addShape(pres.shapes.RECTANGLE,{x:0.9,y:0.7,w:0.16,h:0.62,fill:{color:GOLD}});
  s.addText('UNA BASE PARA ESCALAR',{x:1.2,y:0.67,w:9,h:0.34,fontFace:BF,fontSize:13,bold:true,color:GOLD,charSpacing:3,margin:0});
  s.addText('Listo para crecer con el negocio',{x:0.9,y:1.25,w:11,h:0.8,fontFace:HF,fontSize:34,bold:true,color:WHITE,margin:0});
  // dos columnas
  { const yy=2.4, colW=5.66;
    s.addShape(pres.shapes.RECTANGLE,{x:0.9,y:yy,w:colW,h:3.0,fill:{color:'0B2A63'},line:{color:'1E4A93',width:1}});
    s.addImage({data:icS.cloud,x:1.25,y:yy+0.32,w:0.5,h:0.5});
    s.addText('Arquitectura cloud',{x:1.9,y:yy+0.33,w:colW-1.2,h:0.5,fontFace:BF,fontSize:16,bold:true,color:WHITE,margin:0,valign:'middle'});
    s.addText([
      {text:'Sin instalación: funciona desde cualquier navegador',options:{bullet:{indent:14},breakLine:true,color:ICE}},
      {text:'Base de datos administrada y despliegue automático',options:{bullet:{indent:14},breakLine:true,color:ICE}},
      {text:'Soporta más volumen y nuevas áreas sin rehacer',options:{bullet:{indent:14},color:ICE}},
    ],{x:1.25,y:yy+1.0,w:colW-0.6,h:1.8,fontFace:BF,fontSize:12.5,margin:0,lineSpacingMultiple:1.15});

    const x2=0.9+colW+0.33;
    s.addShape(pres.shapes.RECTANGLE,{x:x2,y:yy,w:colW,h:3.0,fill:{color:'0B2A63'},line:{color:'1E4A93',width:1}});
    s.addImage({data:icG.cogs,x:x2+0.35,y:yy+0.32,w:0.5,h:0.5});
    s.addText('Próximos pasos',{x:x2+1.0,y:yy+0.33,w:colW-1.2,h:0.5,fontFace:BF,fontSize:16,bold:true,color:WHITE,margin:0,valign:'middle'});
    s.addText([
      {text:'Respaldos y alertas de producción',options:{bullet:{indent:14},breakLine:true,color:ICE}},
      {text:'Auditoría de acciones críticas',options:{bullet:{indent:14},breakLine:true,color:ICE}},
      {text:'Doble factor (2FA) para administradores',options:{bullet:{indent:14},breakLine:true,color:ICE}},
      {text:'Caché y CDN cuando el volumen lo justifique',options:{bullet:{indent:14},color:ICE}},
    ],{x:x2+0.35,y:yy+1.0,w:colW-0.6,h:1.8,fontFace:BF,fontSize:12.5,margin:0,lineSpacingMultiple:1.15});
  }
  s.addShape(pres.shapes.RECTANGLE,{x:0.9,y:5.85,w:11.5,h:0.95,fill:{color:GOLD}});
  s.addText('Menos errores  ·  más control  ·  procesos más rápidos  ·  autonomía total del negocio',
    {x:0.9,y:5.85,w:11.5,h:0.95,align:'center',valign:'middle',fontFace:HF,fontSize:18,bold:true,color:NAVY,margin:0});

  await pres.writeFile({ fileName: 'docs/AutoFacil-Directorio.pptx' });
  console.log('OK deck generado');
})();
