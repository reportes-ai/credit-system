'use strict';
const pptxgen = require('pptxgenjs');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const sharp = require('sharp');
const FA = require('react-icons/fa');

const NAVY='012D70', BLUE='0141A2', ACCENT='0255C5', SKY='009AFE',
      ICE='CADCFC', LIGHT='F1F5FB', WHITE='FFFFFF', GOLD='F2A900',
      INK='1E293B', MUTED='64748B', CARD='FFFFFF', RED='D6493C';
const HF='Georgia', BF='Calibri';
const LOGO_BS='api-gateway/public/img/logo-bs.png', BS_RATIO=988/398;

async function icon(Comp, color='#0141A2', size=256){
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp,{color,size:String(size)}));
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return 'image/png;base64,'+png.toString('base64');
}
const shadow = () => ({ type:'outer', color:'8AA0C0', blur:9, offset:3, angle:135, opacity:0.22 });

(async () => {
  const need = {
    layers:FA.FaLayerGroup, sliders:FA.FaSlidersH, seed:FA.FaSeedling,
    dash:FA.FaTachometerAlt, sign:FA.FaFileSignature, card:FA.FaCreditCard, users:FA.FaUsers,
    hands:FA.FaHandshake, flow:FA.FaProjectDiagram, bank:FA.FaUniversity, phone:FA.FaPhoneVolume,
    chart:FA.FaChartLine, bell:FA.FaBell, ushield:FA.FaUserShield, route:FA.FaRoute,
    bolt:FA.FaBolt, cloud:FA.FaCloud, check:FA.FaCheck, times:FA.FaTimes, scale:FA.FaBalanceScale,
    invoice:FA.FaFileInvoiceDollar, cogs:FA.FaCogs, arrow:FA.FaArrowRight, lock:FA.FaLock, bull:FA.FaBullhorn,
    excel:FA.FaFileExcel, share:FA.FaShareAlt, ban:FA.FaBan, dollar:FA.FaDollarSign, robot:FA.FaRobot,
    bulb:FA.FaLightbulb, rocket:FA.FaRocket, code:FA.FaCode, mobile:FA.FaMobileAlt, warn:FA.FaExclamationTriangle,
    brain:FA.FaBrain, piggy:FA.FaPiggyBank, history:FA.FaHistory
  };
  async function load(color){ const m={}; for(const k in need) m[k]=await icon(need[k],color); return m; }
  const icB = await load('#0141A2'), icW = await load('#FFFFFF'), icG = await load('#F2A900'),
        icS = await load('#009AFE'), icR = await load('#D6493C');

  const pres = new pptxgen();
  pres.defineLayout({ name:'W', width:13.333, height:7.5 });
  pres.layout='W'; pres.author='AutoFácil'; pres.title='AutoFácil Business Suite';
  const W=13.333, H=7.5;

  function header(s, kicker, title){
    s.addShape(pres.shapes.RECTANGLE,{x:0.55,y:0.5,w:0.16,h:0.62,fill:{color:GOLD}});
    if(kicker) s.addText(kicker.toUpperCase(),{x:0.85,y:0.46,w:11,h:0.3,fontFace:BF,fontSize:12,bold:true,color:ACCENT,charSpacing:3,margin:0});
    s.addText(title,{x:0.83,y:0.66,w:12,h:0.7,fontFace:HF,fontSize:29,bold:true,color:NAVY,margin:0});
  }
  function logoCard(s,x,y,w,h,pad){
    s.addShape(pres.shapes.ROUNDED_RECTANGLE,{x,y,w,h,rectRadius:0.1,fill:{color:WHITE},shadow:shadow()});
    let lw=w-2*pad, lh=lw/BS_RATIO; if(lh>h-2*pad){ lh=h-2*pad; lw=lh*BS_RATIO; }
    s.addImage({path:LOGO_BS,x:x+(w-lw)/2,y:y+(h-lh)/2,w:lw,h:lh});
  }
  function iconCard(s,x,y,w,h,iconData,title,body,opt={}){
    s.addShape(pres.shapes.RECTANGLE,{x,y,w,h,fill:{color:opt.fill||CARD},line:{color:opt.line||'E2E8F0',width:1},shadow:shadow()});
    s.addShape(pres.shapes.OVAL,{x:x+0.3,y:y+0.3,w:0.7,h:0.7,fill:{color:opt.chip||'EAF1FB'}});
    s.addImage({data:iconData,x:x+0.47,y:y+0.47,w:0.36,h:0.36});
    s.addText(title,{x:x+0.3,y:y+1.08,w:w-0.6,h:0.4,fontFace:BF,fontSize:15,bold:true,color:opt.tc||NAVY,margin:0});
    s.addText(body,{x:x+0.3,y:y+1.46,w:w-0.6,h:h-1.66,fontFace:BF,fontSize:11.5,color:opt.bc||MUTED,margin:0,lineSpacingMultiple:1.02});
  }
  // Tarjeta horizontal compacta (ícono izq, texto der) — para alturas pequeñas
  function iconCardH(s,x,y,w,h,iconData,title,body,opt={}){
    s.addShape(pres.shapes.RECTANGLE,{x,y,w,h,fill:{color:opt.fill||CARD},line:{color:opt.line||'E2E8F0',width:1},shadow:shadow()});
    s.addShape(pres.shapes.OVAL,{x:x+0.3,y:y+(h-0.8)/2,w:0.8,h:0.8,fill:{color:opt.chip||'EAF1FB'}});
    s.addImage({data:iconData,x:x+0.51,y:y+(h-0.8)/2+0.21,w:0.38,h:0.38});
    s.addText(title,{x:x+1.35,y:y+0.26,w:w-1.65,h:0.4,fontFace:BF,fontSize:15,bold:true,color:opt.tc||NAVY,margin:0});
    s.addText(body,{x:x+1.35,y:y+0.68,w:w-1.65,h:h-0.86,fontFace:BF,fontSize:11.5,color:opt.bc||MUTED,margin:0,lineSpacingMultiple:1.0});
  }
  function iconRow(s,x,y,w,iconData,title,body){
    s.addShape(pres.shapes.OVAL,{x,y,w:0.62,h:0.62,fill:{color:'EAF1FB'}});
    s.addImage({data:iconData,x:x+0.16,y:y+0.16,w:0.30,h:0.30});
    s.addText([{text:title+'  ',options:{bold:true,color:NAVY}},{text:body,options:{color:MUTED}}],
      {x:x+0.8,y:y-0.04,w:w-0.9,h:0.72,fontFace:BF,fontSize:12.5,margin:0,valign:'middle'});
  }
  function decor(s){ s.addShape(pres.shapes.OVAL,{x:10.3,y:-2.6,w:6.6,h:6.6,fill:{color:BLUE}});
    s.addShape(pres.shapes.OVAL,{x:11.6,y:4.0,w:5.0,h:5.0,fill:{color:ACCENT}}); }

  // ═════════════ 1 · PORTADA ═════════════
  let s = pres.addSlide(); s.background={color:NAVY};
  s.addShape(pres.shapes.RECTANGLE,{x:0,y:0,w:W,h:0.18,fill:{color:GOLD}}); decor(s);
  logoCard(s,0.9,1.25,5.7,2.2,0.42);
  s.addText('De planillas dispersas\na una plataforma propia',{x:0.92,y:3.85,w:11,h:1.5,fontFace:HF,fontSize:40,bold:true,color:WHITE,margin:0,lineSpacingMultiple:1.0});
  s.addText('La historia de cómo construimos el núcleo digital del negocio — y por qué cambia las reglas.',
    {x:0.95,y:5.5,w:10.5,h:0.6,fontFace:BF,fontSize:16,color:ICE,margin:0});
  s.addText([{text:'Presentación a Directorio',options:{bold:true,color:WHITE}},{text:'   ·   Junio 2026',options:{color:SKY}}],
    {x:0.95,y:6.55,w:9,h:0.4,fontFace:BF,fontSize:14,margin:0});

  // ═════════════ 2 · 2023 diagnóstico ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'2023 · El punto de partida','Un negocio que corría sobre planillas');
  iconCard(s,0.85,2.0,3.78,3.55,icB.excel,'Cada quien, su Excel','Prácticamente cada usuario tenía sus propias “bases” en Excel, sin un origen común.',{});
  iconCard(s,4.91,2.0,3.78,3.55,icR.warn,'Datos que no cuadraban','Información duplicada y, peor aún, cifras que no coincidían entre planillas.',{chip:'FBE3E0',line:'F0C5C0'});
  iconCard(s,8.97,2.0,3.78,3.55,icB.users,'Sin visión única','Imposible ver el negocio completo y confiable en un solo lugar.',{});
  s.addText('Diagnóstico al ingresar a AutoFácil: el dato existía, pero estaba fragmentado y sin control.',
    {x:0.85,y:5.85,w:11.8,h:0.5,fontFace:BF,fontSize:13,italic:true,color:MUTED,margin:0});

  // ═════════════ 3 · Base Única ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Primera solución','La “Base Única”: orden con lo que había');
  iconCard(s,0.85,2.0,5.66,3.5,icB.share,'Una sola planilla compartida','Una gran sábana de Excel en OneDrive donde todos trabajan y actualizan en línea y en paralelo, homologando datos y formas de trabajo.',{});
  iconCard(s,6.84,2.0,5.66,3.5,icB.dash,'Base de la información de hoy','Toda la información se extrae desde ahí y el Dashboard se alimenta de esa fuente. Un puente eficaz — pero todavía sobre Excel.',{chip:'FFF3D6',fill:'FFFDF6',line:'F3D88A'});

  // ═════════════ 4 · Intentos con proveedores ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'El camino con proveedores','Buscar afuera… y chocar con los límites');
  { const x=0.85, yy=1.95, rh=1.15, ww=11.8;
    iconRow(s,x,yy+0*rh,ww,icB.sign,'Levantamiento (ENGAGE)','Primer diagnóstico con un software del rubro; reconocido como acertado, pero no se autorizó la compra.');
    iconRow(s,x,yy+1*rh,ww,icB.warn,'Full Credit (software del grupo)','La comitiva priorizó Cobranzas cuando necesitábamos iniciación de créditos.');
    iconRow(s,x,yy+2*rh,ww,icB.ban,'Procesos rígidos, ajenos a Chile','Exigían datos no aplicables (p. ej. “parroquias”, cónyuges) e impedían adaptar la forma de trabajar.');
    iconRow(s,x,yy+3*rh,ww,icB.times,'No se instaló','Las reuniones se dilataron, se insistió en lo mismo y el proyecto no llegó a puerto.');
  }

  // ═════════════ 5 · El costo de depender de terceros ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'El costo de depender de terceros','Pagar mucho… por hacer poco');
  { const cards=[
      ['US$ 78.000','al año', 'BPO actual (Indexa): solo repositorio. Sin mejoras sin costo, sin acceso a la base de datos.', icR.dollar, RED],
      ['US$ 200.000','inicial','Cotización de proveedor para solo replicar lo que ya tenemos (2 ingenieros, 6 meses).', icR.code, RED],
      ['US$ 10.000','al mes','Arriendo BPO adicional que exigía ese mismo proveedor, por sobre el desarrollo.', icR.bank, RED],
    ];
    const x0=0.85, cw=3.78, gap=0.28, yy=1.95, ch=3.45;
    cards.forEach((c,i)=>{ const x=x0+i*(cw+gap);
      s.addShape(pres.shapes.RECTANGLE,{x,y:yy,w:cw,h:ch,fill:{color:WHITE},line:{color:'F0C5C0',width:1},shadow:shadow()});
      s.addShape(pres.shapes.RECTANGLE,{x,y:yy,w:cw,h:0.12,fill:{color:c[4]}});
      s.addImage({data:c[3],x:x+0.32,y:yy+0.4,w:0.5,h:0.5});
      s.addText(c[0],{x:x+0.3,y:yy+1.0,w:cw-0.6,h:0.7,fontFace:HF,fontSize:25,bold:true,color:NAVY,margin:0});
      s.addText(c[1],{x:x+0.32,y:yy+1.68,w:cw-0.6,h:0.32,fontFace:BF,fontSize:13,bold:true,color:c[4],margin:0});
      s.addText(c[2],{x:x+0.3,y:yy+2.05,w:cw-0.6,h:1.3,fontFace:BF,fontSize:11.5,color:MUTED,margin:0,lineSpacingMultiple:1.02});
    });
  }
  s.addText('Mucho dinero comprometido para seguir dependiendo de un proveedor — sin libertad para mejorar.',
    {x:0.85,y:5.75,w:11.8,h:0.5,fontFace:BF,fontSize:13,italic:true,color:MUTED,margin:0});

  // ═════════════ 6 · El giro: tecnología + IA ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'El giro','Tecnología, experiencia e Inteligencia Artificial');
  iconCardH(s,0.85,1.95,5.66,1.72,icB.brain,'Trayectoria en tecnología','Implementación de software World Class (retail y banca) y rediseño de procesos.',{});
  iconCardH(s,0.85,3.83,5.66,1.72,icB.robot,'Adopción de IA','Desde 2025, desarrollo asistido por IA — el multiplicador del proyecto.',{chip:'FFF3D6',fill:'FFFDF6',line:'F3D88A'});
  iconCardH(s,6.84,1.95,5.66,1.72,icB.mobile,'Cotizador instantáneo','Cuota a 12/24/36/48 meses ingresando el Saldo Precio, con seguros y gastos.',{});
  iconCardH(s,6.84,3.83,5.66,1.72,icB.dash,'Dashboard y herramientas','Dashboard web, seguimiento de créditos y gestor de tareas para las gerencias.',{});

  // ═════════════ 7 · La decisión ═════════════
  s = pres.addSlide(); s.background={color:NAVY};
  s.addShape(pres.shapes.RECTANGLE,{x:0,y:0,w:W,h:0.18,fill:{color:GOLD}});
  s.addShape(pres.shapes.OVAL,{x:-2.4,y:3.4,w:6.6,h:6.6,fill:{color:BLUE}});
  s.addShape(pres.shapes.RECTANGLE,{x:0.9,y:0.85,w:0.16,h:0.62,fill:{color:GOLD}});
  s.addText('ABRIL 2025 · LA DECISIÓN',{x:1.2,y:0.82,w:9,h:0.34,fontFace:BF,fontSize:13,bold:true,color:GOLD,charSpacing:3,margin:0});
  s.addText('Construir lo nuestro',{x:0.9,y:1.45,w:11,h:0.9,fontFace:HF,fontSize:40,bold:true,color:WHITE,margin:0});
  s.addText('El objetivo inicial era simple: dar de baja Indexa y dejar de pagar US$ 78.000 al año. El alcance creció — y hoy tenemos una plataforma que administra el negocio de punta a punta.',
    {x:0.95,y:2.5,w:11.4,h:1.0,fontFace:BF,fontSize:16,color:ICE,margin:0,lineSpacingMultiple:1.05});
  { const items=[[icG.rocket,'De repositorio a plataforma','Lo que empezó como un contenedor de operaciones se volvió un sistema integral.'],
      [icG.layers,'Punta a punta','Cubre desde la aprobación hasta la cobranza, en un solo lugar.'],
      [icG.users,'Más áreas, sin costo extra','Da soporte a áreas que hoy ni siquiera tienen acceso al sistema antiguo.']];
    const x0=0.95, cw=3.74, gap=0.3, yy=3.85, ch=2.4;
    items.forEach((it,i)=>{ const x=x0+i*(cw+gap);
      s.addShape(pres.shapes.RECTANGLE,{x,y:yy,w:cw,h:ch,fill:{color:'0B2A63'},line:{color:'1E4A93',width:1}});
      s.addImage({data:it[0],x:x+0.32,y:yy+0.3,w:0.5,h:0.5});
      s.addText(it[1],{x:x+0.3,y:yy+0.92,w:cw-0.6,h:0.6,fontFace:BF,fontSize:14,bold:true,color:WHITE,margin:0});
      s.addText(it[2],{x:x+0.3,y:yy+1.5,w:cw-0.6,h:0.85,fontFace:BF,fontSize:11.5,color:ICE,margin:0,lineSpacingMultiple:1.02});
    });
  }

  // ═════════════ 8 · REVEAL plataforma ═════════════
  s = pres.addSlide(); s.background={color:NAVY};
  s.addShape(pres.shapes.RECTANGLE,{x:0,y:0,w:W,h:0.18,fill:{color:GOLD}}); decor(s);
  s.addText('LA PLATAFORMA',{x:0,y:1.15,w:W,h:0.4,align:'center',fontFace:BF,fontSize:15,bold:true,color:GOLD,charSpacing:4,margin:0});
  logoCard(s,(W-6.6)/2,1.7,6.6,2.6,0.5);
  s.addText('El núcleo digital de AutoFácil — construido en casa, pensado para el negocio.',
    {x:0,y:4.6,w:W,h:0.5,align:'center',fontFace:HF,fontSize:20,italic:true,color:WHITE,margin:0});
  s.addText('Integral  ·  100% Paramétrico  ·  Trazable  ·  En la nube',
    {x:0,y:5.5,w:W,h:0.5,align:'center',fontFace:BF,fontSize:15,bold:true,color:SKY,charSpacing:1,margin:0});

  // ═════════════ 9 · No es archivo ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'El cambio de paradigma','No es un archivo. Es la plataforma del negocio.');
  s.addText('No solo almacena créditos: administra la operación completa — desde la aprobación hasta la cobranza — con control, trazabilidad y autonomía total para el negocio.',
    {x:0.85,y:1.5,w:11.6,h:0.7,fontFace:BF,fontSize:14,color:INK,margin:0});
  { const cy=2.55,cw=3.78,ch=3.6,gap=0.28; let cx=0.85;
    iconCard(s,cx,cy,cw,ch,icB.layers,'Plataforma integral','Reemplaza planillas dispersas y procesos manuales por un flujo único, en la nube, compartido y auditable.'); cx+=cw+gap;
    iconCard(s,cx,cy,cw,ch,icG.sliders,'100% Paramétrico','El Administrador configura montos, tasas, impuestos, estados, textos y permisos — sin programadores.',{chip:'FFF3D6',fill:'FFFDF6',line:'F3D88A'}); cx+=cw+gap;
    iconCard(s,cx,cy,cw,ch,icB.seed,'Diseñada para crecer','Cada proceso nuevo se suma como módulo, sin rehacer lo existente.');
  }

  // ═════════════ 10 · Mapa de capacidades ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Mapa de capacidades','Una sola plataforma, todo el negocio');
  const caps=[[icB.dash,'Dashboard','Indicadores en tiempo real'],[icB.sign,'Aprobación','Cartas y “cuatro ojos”'],
    [icB.card,'Créditos','Carga masiva y gestión'],[icB.users,'Clientes','Ficha integral 360°'],[icB.hands,'Comisiones','Cálculo y cartolas'],
    [icB.flow,'Post Venta','Pagos por workflow'],[icB.bank,'Tesorería','Cuentas y cajas'],[icB.phone,'Cobranza','Mora y gastos (normativa)'],
    [icB.chart,'Reportería','Informes a gerencia'],[icB.bell,'Alertas','Notificaciones y push']];
  { const cols=5, gx=0.85, gpad=0.16, gwid=(W-2*gx+gpad)/cols-gpad, gh=2.0, gyy=2.05;
    caps.forEach((c,i)=>{ const col=i%cols,row=Math.floor(i/cols),x=gx+col*(gwid+gpad),y=gyy+row*(gh+0.3);
      s.addShape(pres.shapes.RECTANGLE,{x,y,w:gwid,h:gh,fill:{color:CARD},line:{color:'E2E8F0',width:1},shadow:shadow()});
      s.addShape(pres.shapes.OVAL,{x:x+gwid/2-0.36,y:y+0.26,w:0.72,h:0.72,fill:{color:'EAF1FB'}});
      s.addImage({data:c[0],x:x+gwid/2-0.19,y:y+0.43,w:0.38,h:0.38});
      s.addText(c[1],{x:x+0.1,y:y+1.12,w:gwid-0.2,h:0.34,align:'center',fontFace:BF,fontSize:14,bold:true,color:NAVY,margin:0});
      s.addText(c[2],{x:x+0.1,y:y+1.46,w:gwid-0.2,h:0.46,align:'center',fontFace:BF,fontSize:10.5,color:MUTED,margin:0});
    });
  }

  // ═════════════ 11 · Proceso end-to-end ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Recorrido del proceso','Del primer contacto al pago y la cobranza');
  const steps=[[icB.sign,'Cotización\ny aprobación'],[icB.card,'Otorgamiento\ndel crédito'],[icB.bank,'Pago al\nconcesionario'],
    [icB.hands,'Comisión\ny cartola'],[icB.phone,'Cobranza'],[icB.chart,'Reportería\ngerencial']];
  { const n=steps.length,x0=0.7,x1=12.63,bw=1.78,bh=2.5,yb=2.7,slot=(x1-x0)/n;
    steps.forEach((st,i)=>{ const x=x0+i*slot+(slot-bw)/2;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE,{x,y:yb,w:bw,h:bh,rectRadius:0.12,fill:{color:i===3?NAVY:CARD},line:{color:i===3?NAVY:'E2E8F0',width:1},shadow:shadow()});
      s.addShape(pres.shapes.OVAL,{x:x+bw/2-0.42,y:yb+0.34,w:0.84,h:0.84,fill:{color:i===3?'13386E':'EAF1FB'}});
      s.addImage({data:i===3?icW.hands:st[0],x:x+bw/2-0.23,y:yb+0.53,w:0.46,h:0.46});
      s.addText(String(i+1),{x:x+0.12,y:yb+0.12,w:0.5,h:0.4,fontFace:HF,fontSize:16,bold:true,color:i===3?SKY:ICE,margin:0});
      s.addText(st[1],{x:x+0.1,y:yb+1.45,w:bw-0.2,h:0.9,align:'center',fontFace:BF,fontSize:13.5,bold:true,color:i===3?WHITE:NAVY,margin:0,lineSpacingMultiple:0.95});
      if(i<n-1) s.addImage({data:icG.arrow,x:x+bw+(slot-bw)/2-0.18,y:yb+bh/2-0.14,w:0.28,h:0.28});
    });
    s.addText('Todo el ciclo en una sola herramienta — cada etapa registra quién la ejecutó y cuándo.',
      {x:0.85,y:5.75,w:11.6,h:0.5,fontFace:BF,fontSize:13,italic:true,color:MUTED,margin:0});
  }

  // ═════════════ 12 · Del crédito al pago ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Funcionalidades clave','Del crédito al pago');
  { const x=0.85,yy=2.0,rh=1.18,ww=11.6;
    iconRow(s,x,yy+0*rh,ww,icB.sign,'Originación','Simulador de créditos, cartas de aprobación con doble validación (“cuatro ojos”) e historial.');
    iconRow(s,x,yy+1*rh,ww,icB.card,'Créditos','Carga masiva por Excel y cálculo automático de tramo MAYOR/MENOR 200 UF y TMC vigente.');
    iconRow(s,x,yy+2*rh,ww,icB.flow,'Post Venta','Pago al concesionario por workflow con etapas y atribuciones por perfil — totalmente trazable.');
    iconRow(s,x,yy+3*rh,ww,icB.invoice,'Comisiones e impuestos','Cartolas acumulativas, Boleta vs. Factura, IVA y Retención calculados y órdenes de pago agrupadas.');
  }

  // ═════════════ 13 · Control y soporte ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Funcionalidades clave','Control, soporte y visibilidad');
  { const x=0.85,yy=2.0,rh=1.18,ww=11.6;
    iconRow(s,x,yy+0*rh,ww,icB.bank,'Tesorería','Cuentas transitorias, cajas, cierre de caja y brokerage.');
    iconRow(s,x,yy+1*rh,ww,icB.phone,'Cobranza','Interés por mora y gasto de cobranza según normativa (Ley 19.496), por tramos en UF.');
    iconRow(s,x,yy+2*rh,ww,icB.scale,'CRM y gestiones','Registro de gestiones y seguimiento comercial centralizado.');
    iconRow(s,x,yy+3*rh,ww,icB.chart,'Reportería y Dashboard','Reportería “Tailor Made”, exportación a Excel y desempeño de analistas.');
  }

  // ═════════════ 14 · 100% PARAMÉTRICO (héroe) ═════════════
  s = pres.addSlide(); s.background={color:NAVY};
  s.addShape(pres.shapes.RECTANGLE,{x:0,y:0,w:W,h:0.18,fill:{color:GOLD}});
  s.addShape(pres.shapes.OVAL,{x:10.3,y:-2.6,w:6.6,h:6.6,fill:{color:BLUE}});
  s.addShape(pres.shapes.RECTANGLE,{x:0.9,y:0.82,w:0.16,h:0.62,fill:{color:GOLD}});
  s.addText('NUESTRA MAYOR VENTAJA',{x:1.2,y:0.8,w:9,h:0.34,fontFace:BF,fontSize:13,bold:true,color:GOLD,charSpacing:3,margin:0});
  s.addImage({data:icG.bolt,x:0.9,y:1.5,w:0.6,h:0.6});
  s.addText('100% Paramétrico',{x:1.68,y:1.38,w:10,h:0.9,fontFace:HF,fontSize:40,bold:true,color:WHITE,margin:0});
  s.addText('Ante un cambio legal o funcional, la empresa reacciona al instante: el propio Administrador lo configura desde un mantenedor — sin programadores, sin proveedores externos, sin esperas.',
    {x:0.95,y:2.45,w:11.4,h:0.9,fontFace:BF,fontSize:16,color:ICE,margin:0,lineSpacingMultiple:1.05});
  const stats=[['Minutos','de reacción, no semanas de espera'],['$ 0','en desarrollo externo por cada ajuste'],['100%','autonomía: lo decide el negocio']];
  { const x0=0.95,sw=3.74,sh=1.5,sgap=0.3,yy=3.6;
    stats.forEach((st,i)=>{ const x=x0+i*(sw+sgap);
      s.addShape(pres.shapes.RECTANGLE,{x,y:yy,w:sw,h:sh,fill:{color:'0B2A63'},line:{color:'1E4A93',width:1}});
      s.addShape(pres.shapes.RECTANGLE,{x,y:yy,w:0.12,h:sh,fill:{color:GOLD}});
      s.addText(st[0],{x:x+0.35,y:yy+0.16,w:sw-0.5,h:0.7,fontFace:HF,fontSize:33,bold:true,color:GOLD,margin:0});
      s.addText(st[1],{x:x+0.36,y:yy+0.92,w:sw-0.6,h:0.5,fontFace:BF,fontSize:12,color:ICE,margin:0,lineSpacingMultiple:0.98});
    });
  }
  s.addText('Se ajustan desde un mantenedor y rigen de inmediato:',{x:0.95,y:5.4,w:11,h:0.32,fontFace:BF,fontSize:12.5,bold:true,color:WHITE,margin:0});
  { const chips=['Nueva Retención de Honorarios','Cambio de IVA','Nuevo tramo de cobranza','Nueva tasa / UF'];
    let cxp=0.95; const cyp=5.82;
    chips.forEach(t=>{ const wch=0.40+t.length*0.098;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE,{x:cxp,y:cyp,w:wch,h:0.5,rectRadius:0.25,fill:{color:'13386E'},line:{color:SKY,width:1}});
      s.addText(t,{x:cxp,y:cyp,w:wch,h:0.5,align:'center',valign:'middle',fontFace:BF,fontSize:11.5,color:WHITE,margin:0});
      cxp+=wch+0.22;
    });
  }

  // ═════════════ 15 · Seguridad y gobierno ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'Control y confianza','Seguridad, trazabilidad y gobierno');
  { const cy2=1.95,cw2=5.66,ch2=2.45,gx=0.85,gp=0.28;
    iconCard(s,gx,cy2,cw2,ch2,icB.ushield,'Permisos por perfil','Cada acción sensible (emitir, pagar, reversar, cargar) se habilita por perfil desde la matriz de Perfiles y Permisos.');
    iconCard(s,gx+cw2+gp,cy2,cw2,ch2,icB.route,'Trazabilidad por etapa','Cada paso registra autor y fecha. El orden del proceso se respeta; lo configurable son los valores.');
    iconCard(s,gx,cy2+ch2+gp,cw2,ch2,icB.lock,'Acceso seguro','Token de autenticación (JWT), cambio de contraseña propio y auditoría de permisos.');
    iconCard(s,gx+cw2+gp,cy2+ch2+gp,cw2,ch2,icB.bull,'Operación asistida','Notificaciones por evento, ayuda contextual y base de conocimiento editable por el negocio.');
  }

  // ═════════════ 16 · Antes vs Con ═════════════
  s = pres.addSlide(); s.background={color:LIGHT};
  header(s,'El salto','De planillas y terceros a una plataforma propia');
  { const colW=5.66,x1=0.85,x2=0.85+colW+0.33,yy=1.95,hh=4.6;
    s.addShape(pres.shapes.RECTANGLE,{x:x1,y:yy,w:colW,h:0.7,fill:{color:'E2E8F0'}});
    s.addText('ANTES — Excel y proveedores',{x:x1,y:yy,w:colW,h:0.7,align:'center',valign:'middle',fontFace:BF,fontSize:15,bold:true,color:'475569',margin:0});
    s.addShape(pres.shapes.RECTANGLE,{x:x1,y:yy+0.7,w:colW,h:hh-0.7,fill:{color:WHITE},line:{color:'E2E8F0',width:1}});
    const before=['Datos dispersos en múltiples planillas','Cálculos manuales y cifras descuadradas','Sin trazabilidad de quién aprobó o pagó','Cada cambio depende de un proveedor','US$ 78.000 al año por un repositorio'];
    before.forEach((t,i)=>{ const y=yy+1.0+i*0.72;
      s.addImage({data:icR.times,x:x1+0.32,y:y+0.04,w:0.26,h:0.26});
      s.addText(t,{x:x1+0.75,y:y-0.06,w:colW-1.0,h:0.5,fontFace:BF,fontSize:12.5,color:'64748B',valign:'middle',margin:0});
    });
    s.addShape(pres.shapes.RECTANGLE,{x:x2,y:yy,w:colW,h:0.7,fill:{color:NAVY}});
    s.addText('CON BUSINESS SUITE',{x:x2,y:yy,w:colW,h:0.7,align:'center',valign:'middle',fontFace:BF,fontSize:15,bold:true,color:WHITE,margin:0});
    s.addShape(pres.shapes.RECTANGLE,{x:x2,y:yy+0.7,w:colW,h:hh-0.7,fill:{color:WHITE},line:{color:'C9DBF5',width:1.5}});
    const after=['Fuente única, en la nube, compartida','Cálculo automático y parametrizado','Auditoría por etapa, autor y fecha','El negocio configura — sin terceros','Plataforma propia: el ahorro queda en casa'];
    after.forEach((t,i)=>{ const y=yy+1.0+i*0.72;
      s.addImage({data:icB.check,x:x2+0.32,y:y+0.04,w:0.26,h:0.26});
      s.addText(t,{x:x2+0.75,y:y-0.06,w:colW-1.0,h:0.5,fontFace:BF,fontSize:12.5,bold:true,color:INK,valign:'middle',margin:0});
    });
  }

  // ═════════════ 17 · Cierre ═════════════
  s = pres.addSlide(); s.background={color:NAVY};
  s.addShape(pres.shapes.RECTANGLE,{x:0,y:0,w:W,h:0.18,fill:{color:GOLD}});
  s.addShape(pres.shapes.OVAL,{x:-2.4,y:3.6,w:6.4,h:6.4,fill:{color:BLUE}});
  logoCard(s,0.9,0.7,3.9,1.45,0.28);
  s.addText('De un gasto fijo a un activo propio',{x:0.9,y:2.35,w:11.5,h:0.85,fontFace:HF,fontSize:32,bold:true,color:WHITE,margin:0});
  { const yy=3.5,colW=5.66;
    s.addShape(pres.shapes.RECTANGLE,{x:0.9,y:yy,w:colW,h:2.0,fill:{color:'0B2A63'},line:{color:'1E4A93',width:1}});
    s.addImage({data:icG.piggy,x:1.25,y:yy+0.32,w:0.55,h:0.55});
    s.addText('El ahorro',{x:1.95,y:yy+0.34,w:colW-1.2,h:0.5,fontFace:BF,fontSize:16,bold:true,color:WHITE,margin:0,valign:'middle'});
    s.addText([
      {text:'Recuperamos US$ 78.000 al año del BPO actual',options:{bullet:{indent:14},breakLine:true,color:ICE}},
      {text:'Evitamos US$ 200.000 + arriendo de un proveedor',options:{bullet:{indent:14},breakLine:true,color:ICE}},
      {text:'Sin costo por cada mejora o cambio futuro',options:{bullet:{indent:14},color:ICE}},
    ],{x:1.25,y:yy+1.0,w:colW-0.6,h:0.95,fontFace:BF,fontSize:12.5,margin:0,lineSpacingMultiple:1.12});
    const x2=0.9+colW+0.33;
    s.addShape(pres.shapes.RECTANGLE,{x:x2,y:yy,w:colW,h:2.0,fill:{color:'0B2A63'},line:{color:'1E4A93',width:1}});
    s.addImage({data:icS.cloud,x:x2+0.35,y:yy+0.32,w:0.55,h:0.55});
    s.addText('La base para escalar',{x:x2+1.05,y:yy+0.34,w:colW-1.2,h:0.5,fontFace:BF,fontSize:16,bold:true,color:WHITE,margin:0,valign:'middle'});
    s.addText([
      {text:'Plataforma propia, en la nube, sin instalación',options:{bullet:{indent:14},breakLine:true,color:ICE}},
      {text:'Conectada a nuestros datos, mejorable al instante',options:{bullet:{indent:14},breakLine:true,color:ICE}},
      {text:'Soporta nuevas áreas sin rehacer lo existente',options:{bullet:{indent:14},color:ICE}},
    ],{x:x2+0.35,y:yy+1.0,w:colW-0.6,h:0.95,fontFace:BF,fontSize:12.5,margin:0,lineSpacingMultiple:1.12});
  }
  s.addShape(pres.shapes.RECTANGLE,{x:0.9,y:5.95,w:11.5,h:0.9,fill:{color:GOLD}});
  s.addText('Menos costo  ·  más control  ·  autonomía total  ·  una base para crecer',
    {x:0.9,y:5.95,w:11.5,h:0.9,align:'center',valign:'middle',fontFace:HF,fontSize:18,bold:true,color:NAVY,margin:0});

  await pres.writeFile({ fileName: 'docs/AutoFacil-BusinessSuite-Directorio.pptx' });
  console.log('OK deck completo generado');
})();
