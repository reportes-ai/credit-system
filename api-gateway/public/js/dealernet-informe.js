/* ─────────────────────────────────────────────────────────────────────────
 * dealernet-informe.js — Render del informe DealerNet (formato legible).
 * Extraído tal cual de /dealernet-informes para reusarlo en Evaluación Crediticia
 * sin duplicar criterio. Expone window.DNInforme.render(d) / renderTree / esc.
 * Requiere que la página defina un descargarPdf(id) global (para el certificado).
 * ───────────────────────────────────────────────────────────────────────── */
(function(){
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
/* ── Render de informe con el formato DealerNet ──────────────────────────── */
const FTE = { '16':'Digitación', '2101':'Registro Civil', '3425':'DealerNET', '3435':'DealerNET' };
const LOGO = (location && location.origin ? location.origin : '') + '/img/logo.png';
const LOGO_DN = (location && location.origin ? location.origin : '') + '/img/logo-dealernet.png';
const REPORT_CSS = `
  .report { background:#fff; color:#1f2937; font-size:.84rem; }
  .rep-titularbar { display:flex; justify-content:space-between; align-items:baseline; border-bottom:2px solid #0141A2; padding-bottom:6px; margin-bottom:4px; }
  .rep-titularbar b { font-size:.95rem; color:#012d70; }
  .rep-titularbar span { font-family:ui-monospace,monospace; color:#475569; }
  .rep-title { font-size:1.15rem; font-weight:800; color:#012d70; margin:10px 0 6px; }
  .rep-meta { display:flex; flex-wrap:wrap; gap:4px 18px; font-size:.76rem; color:#475569; background:#f8fafc; border:1px solid #eef2f7; border-radius:8px; padding:8px 12px; margin-bottom:14px; }
  .rep-h { font-size:.8rem; font-weight:800; color:#fff; background:#0141A2; border-radius:6px; padding:5px 10px; margin:14px 0 8px; }
  .rep-kv { margin:3px 0; } .rep-kv b { color:#374151; }
  .rep-tb { width:100%; border-collapse:collapse; font-size:.8rem; margin:6px 0; }
  .rep-tb th { background:#eef4fb; color:#012d70; text-align:left; padding:6px 8px; border:1px solid #dbe6f3; font-size:.72rem; text-transform:uppercase; }
  .rep-tb td { padding:6px 8px; border:1px solid #eef2f7; vertical-align:top; }
  .pill-ok { background:#dcfce7; color:#15803d; font-weight:800; padding:2px 10px; border-radius:11px; }
  .pill-bad { background:#fee2e2; color:#b91c1c; font-weight:800; padding:2px 10px; border-radius:11px; }
  .rep-note { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:8px; padding:8px 12px; font-size:.78rem; margin-bottom:10px; }
  .rep-sep { border:none; border-top:1px dashed #e2e8f0; margin:8px 0; }
  .rep-legal { margin-top:18px; padding-top:8px; border-top:1px solid #eef2f7; font-size:.68rem; color:#94a3b8; font-style:italic; }
  .rep-tree { font-size:.8rem; } .rep-tree b { color:#374151; }
  .rep-logo { margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; } .rep-logo img.l-af { height:40px; width:auto; } .rep-logo img.l-dn { height:60px; width:auto; }
  .rep-page { margin-bottom:56px; }
  @media print { .rep-page { page-break-after:always; margin-bottom:0; } .rep-page:last-child { page-break-after:auto; } }`;
(function(){ const st=document.createElement('style'); st.textContent=REPORT_CSS; document.head.appendChild(st); })();

// Busca el primer valor escalar cuya clave (sin @_) coincida, recursivo.
function deepFind(o, names, depth=0){
  if(!o || typeof o!=='object' || depth>12) return null;
  for(const k of Object.keys(o)){
    const kn=k.replace(/^@_/,'').toLowerCase();
    if(names.includes(kn) && o[k]!=null && typeof o[k]!=='object' && String(o[k]).trim()!=='') return o[k];
  }
  for(const k of Object.keys(o)){ if(o[k]&&typeof o[k]==='object'){ const r=deepFind(o[k],names,depth+1); if(r!=null) return r; } }
  return null;
}
// Render genérico (fallback) estilizado, mientras se afina el formato exacto.
function renderTree(o, depth=0){
  if(o==null) return '<span class="muted">—</span>';
  if(typeof o!=='object') return esc(String(o));
  if(Array.isArray(o)) return o.map(x=>renderTree(x,depth)).join('<hr class="rep-sep">');
  return Object.keys(o).filter(k=>k!=='#text').map(k=>{
    const label=k.replace(/^@_/,''); const v=o[k];
    if(v && typeof v==='object') return '<div class="rep-kv"><b>'+esc(label)+'</b></div><div style="padding-left:14px">'+renderTree(v,depth+1)+'</div>';
    return '<div class="rep-kv"><b>'+esc(label)+':</b> '+esc(String(v))+'</div>';
  }).join('');
}
// Boletín de Deudores de Pensión de Alimentos (2101): informe + se conserva el certificado.
function bodyPension(d, cont){
  const nombre = deepFind(cont,['nombre']) || '';
  const inddeu = String(deepFind(cont,['inddeu']) || '').trim();
  const sin = !inddeu || /sin/i.test(inddeu);
  const accion = d.pdf_url ? `<button class="btn-ghost" onclick="descargarPdf(${d.id})"><i class="bi bi-file-earmark-pdf"></i> Certificado</button>` : '—';
  return `<div class="rep-kv"><b>Nombre:</b> ${esc(nombre)||'—'}</div>
    <div class="rep-kv"><b>Rut:</b> ${esc(d.rut)}-${esc(d.dv||'')}</div>
    <div class="rep-h">Resultado Búsqueda</div>
    <table class="rep-tb"><thead><tr><th>Ruta deudor</th><th>Nombre deudor</th><th>Resultado consulta</th><th>Acción</th></tr></thead>
    <tbody><tr><td>${esc(d.rut)}-${esc(d.dv||'')}</td><td>${esc(nombre||'—')}</td>
    <td><span class="pill-${sin?'ok':'bad'}">${esc((inddeu||'SIN DEUDA').toUpperCase())}</span></td><td>${accion}</td></tr></tbody></table>
    ${d.pdf_url?'<div class="muted" style="margin-top:8px"><i class="bi bi-shield-check"></i> Se conserva el <b>certificado</b> emitido por el Registro Civil.</div>':''}`;
}
/* ── Helpers de navegación / formato ─────────────────────────────────────── */
function gp(o, ...keys){ for(const k of keys){ if(o==null) return undefined; o=o[k]; } return o; }
function arr(x){ return x==null?[]:(Array.isArray(x)?x:[x]); }
function fmtMiles(n){ const v=Number(n); return isNaN(v)?esc(String(n??'')):v.toLocaleString('es-CL'); }
function rutFmt(num,dv){ const n=Number(num); if(!n) return ''; return n.toLocaleString('es-CL')+'-'+(dv??''); }
function anomes(a){ const s=String(a||''); return s.length===6 ? s.slice(4)+'/'+s.slice(0,4) : esc(s); }
function relList(rel){ return arr(gp(rel,'relacion')).filter(Boolean).map(esc).join(', '); }
const secEmpty = () => '<span class="muted">No se registra información</span>';
const noinfo = () => '<div class="rep-kv" style="margin-top:8px">'+secEmpty()+'</div>';

/* ── Tablas reutilizables (Perfil Comercial) ─────────────────────────────── */
function tblContactos(nodo){
  const ds = arr(gp(nodo,'d')); if(!ds.length) return secEmpty();
  return '<table class="rep-tb"><thead><tr><th>Dato</th><th>Detalle</th><th>Relación</th></tr></thead><tbody>'+
    ds.map(x=>{
      const val = x.telefono||x.correo||x.direccion||'';
      const det = [x.ubicacion, x.locacion, x.clasificacion==='C'?'Celular':(x.clasificacion==='F'?'Fijo':''), x.ind_whatsapp?'WhatsApp':''].filter(Boolean).join(' · ');
      return '<tr><td>'+esc(val)+'</td><td class="muted">'+esc(det)+'</td><td>'+relList(x.relacionados)+'</td></tr>';
    }).join('')+'</tbody></table>';
}
function tblVehiculos(nodo){
  const ds = arr(gp(nodo,'d')); if(!ds.length) return secEmpty();
  return '<table class="rep-tb"><thead><tr><th>Patente</th><th>Marca / Modelo</th><th>Año</th></tr></thead><tbody>'+
    ds.map(v=>'<tr><td>'+esc(v.patente)+'</td><td>'+esc((v.marca||'')+' / '+(v.modelo||''))+'</td><td>'+esc(v.agno)+'</td></tr>').join('')+'</tbody></table>';
}
function tblRelacionados(nodo){
  const ds = arr(gp(nodo,'d')); if(!ds.length) return secEmpty();
  return '<table class="rep-tb"><thead><tr><th>RUT</th><th>Nombre</th><th>Relación</th></tr></thead><tbody>'+
    ds.map(r=>{ const nom=(r.organizacion||((r.nombres||'')+' '+(r.apellidos||''))).trim();
      return '<tr><td>'+esc(rutFmt(r.rut,r.dv))+'</td><td>'+esc(nom)+'</td><td>'+esc(r.relacion)+'</td></tr>'; }).join('')+'</tbody></table>';
}
function tblSociedades(nodo){
  const ds = arr(gp(nodo,'d')); if(!ds.length) return secEmpty();
  return '<table class="rep-tb"><thead><tr><th>RUT</th><th>Nombre</th><th>Participación</th></tr></thead><tbody>'+
    ds.map(s=>'<tr><td>'+esc(rutFmt(s.rut,s.dv))+'</td><td>'+esc(s.nombre)+'</td><td>'+(s.participacion!=null&&s.participacion!==''?esc(s.participacion)+'%':'--')+'</td></tr>').join('')+'</tbody></table>';
}
function bodyTributaria(dtrib){
  if(!dtrib) return secEmpty();
  const actList = arr(gp(dtrib,'actividades','ACTIVIDADES','ACTIVIDAD'));
  const docYear = gp(arr(gp(dtrib,'documentos','DOCUMENTOS','DOCUMENTO'))[0]||{}, 'YEAR');
  let html = '<div class="rep-kv"><b>Fecha inicio actividades:</b> '+esc(gp(dtrib,'fch_inicio_actividades')||'—')+'</div>'+
    '<div class="rep-kv"><b>Año último timbraje (Boletas Honorarios Electrónicas):</b> '+esc(docYear||'—')+'</div>';
  if(actList.length) html += '<table class="rep-tb"><thead><tr><th>Actividad económica vigente</th><th>Código</th><th>Categoría</th><th>Afecta IVA</th><th>Fecha</th></tr></thead><tbody>'+
    actList.map(a=>'<tr><td>'+esc(a.NOMBRE)+'</td><td>'+esc(a.CODIGO)+'</td><td>'+esc(a.CATEGORIA)+'</td><td>'+esc(a.AFECTO==='S'?'Sí':'No')+'</td><td>'+esc(a.FECHA)+'</td></tr>').join('')+'</tbody></table>';
  const obs = gp(dtrib,'OBSERVACION','TEXTO');
  if(obs) html += '<div class="muted" style="margin-top:6px;font-size:.72rem;line-height:1.45">'+esc(obs)+'</div>';
  return html;
}

/* ── Cuerpos por producto (formato DealerNet) ────────────────────────────── */
function bodyComportamiento(prd){
  const r = prd.r1603 || {}; const cab = r.r16031 || {}; const periodos = arr(r.r16032);
  if(!periodos.length && cab['@_anomes']==null) return noinfo();
  const rows = [
    ['AL DÍA E IMPAGOS < 30 DÍAS','deuda_direc_vig'],['IMPAGOS 30 Y 90 DÍAS','deuda_morosa'],
    ['IMPAGOS 90 Y 180 DÍAS','deuda_venci_direc'],['IMPAGOS 180 DÍAS Y 3 AÑOS','deuda_dir_venc_180d_3anos'],
    ['IMPAGOS >= 3 AÑOS','deuda_cast_directa'],['CRÉDITOS DE CONSUMO','deuda_cred_consumo'],
    ['NRO. ENTIDADES CRED. CONSUMO','nro_acree_cred_consumo'],['CRÉDITOS PARA VIVIENDA','deuda_cred_hipoteca'],
    ['OPERACIONES FINANCIERAS','deuda_ope_c_pacto'],['INSTRUM. DEUDAS ADQUIRIDOS','deuda_inv_finan'],
    ['CRÉDITOS COMERCIALES','deuda_comercial'],['DEUDA COM. VIGENTE MEX','mto_deuda_com_vig_mdaext'],
    ['DEUDA COM. VENCIDA MEX','mto_deuda_com_venci_mdaext'],['INDIRECTA IMPAGOS < 30 DÍAS','deuda_indirec_vig'],
    ['INDIRECTA IMPAGOS 30 DÍAS Y 3 AÑOS','deuda_indirec_venci'],['INDIRECTA IMPAGOS >= 3 AÑOS','deuda_cast_indirecta'],
    ['LÍNEA CRÉDITO DISPONIBLE','linea_cred_disponible'],['CRÉDITOS CONTINGENTES','deuda_cred_contingentes'],
    ['NRO. ENTIDADES CRED. COMER.','nro_inst_cred_com'],['CRÉDITOS LEASING AL DÍA','deuda_leasing'],
    ['CRÉDITOS LEASING IMPAGO','deuda_morosa_leasing'],
  ];
  const head = '<tr><th>Variables / Periodos</th>'+periodos.map(p=>'<th style="text-align:right">'+anomes(p['@_ano_y_mes_deuda'])+'</th>').join('')+'</tr>';
  const bd = rows.map(([lbl,key])=>'<tr><td>'+lbl+'</td>'+periodos.map(p=>'<td style="text-align:right">'+fmtMiles(p['@_'+key])+'</td>').join('')+'</tr>').join('');
  return '<div class="rep-h">Resumen</div>'+
    '<div class="rep-kv"><b>Deuda Total:</b> '+fmtMiles(cab['@_deuda_total'])+'</div>'+
    '<div class="rep-kv"><b>Año y Mes Deuda:</b> '+anomes(cab['@_anomes'])+'</div>'+
    '<div class="rep-kv"><b>Nombre:</b> '+esc(cab['@_nom_superinten']||'')+'</div>'+
    '<div class="rep-h">Historial de Documentos M$</div>'+
    '<table class="rep-tb"><thead>'+head+'</thead><tbody>'+bd+'</tbody></table>';
}
function bodyPerfilComercial(prd){
  const colect = gp(prd,'DLNTPERCOMDLNTWS','ROOT','D','result','colect');
  if(!colect) return noinfo();
  const titular = colect.titular || {};
  const civ = gp(titular,'det','detalle_rut','datos_civiles','d') || {};
  const trib = gp(titular,'det','detalle_rut','detalle_rut','xmldatos','xmldata','d');
  const sec = (t,h) => '<div class="rep-h">'+t+'</div>'+h;
  const idRows = [
    ['NACIONALIDAD', civ.nacionalidad],['FECHA DE NACIMIENTO', civ.fch_nacimiento],
    ['LUGAR DE NACIMIENTO', civ.nacimiento_lugar],['SEXO', civ.sexo],
    ['EDAD', civ.edad!=null?civ.edad+' Años':''],['OCUPACIÓN', gp(civ,'ocupacion','profesion')],
    ['PERFIL SOCIO ECONÓMICO', civ.perfil_socioeconomico],['ESTADO CIVIL', civ.matrimonio_estado_civil],
    ['HIJOS', gp(civ,'asignacion_familiar','hijos')],['CÓNYUGE', gp(civ,'asignacion_familiar','conyuge')],
  ];
  const idHtml = '<table class="rep-tb"><tbody>'+idRows.map(([k,v])=>'<tr><th style="width:42%">'+k+'</th><td>'+esc(v!=null&&v!==''?v:'—')+'</td></tr>').join('')+'</tbody></table>';
  let h = sec('Identificación', idHtml);
  h += sec('Vehículos Motorizados Históricos', tblVehiculos(gp(titular,'activos','activo_detalle_vehiculo_historico')));
  h += sec('Teléfonos más probables de contacto', tblContactos(gp(colect,'telefonos','telefono_contacto_probable')));
  h += sec('Teléfonos alternativos', tblContactos(gp(colect,'telefonos','telefono_contacto_alternativo')));
  h += sec('Teléfonos laborales', tblContactos(gp(colect,'telefonos','telefono_contacto_laboral')));
  h += sec('Direcciones más probables de residencia', tblContactos(gp(colect,'direcciones','residencia_probable')));
  h += sec('Direcciones alternativas', tblContactos(gp(colect,'direcciones','residencia_alternativa')));
  h += sec('Dirección laboral', tblContactos(gp(colect,'direcciones','direccion_laboral')));
  h += sec('Correos electrónicos más probables', tblContactos(gp(colect,'correos','correo_contacto_probable')));
  h += sec('Correos electrónicos alternativos', tblContactos(gp(colect,'correos','correo_contacto_alternativo')));
  h += sec('Situación tributaria', bodyTributaria(trib));
  h += sec('Participaciones en sociedades', tblSociedades(gp(titular,'sociedades','empresa')));
  h += sec('Relacionados', tblRelacionados(titular.relacionados));
  h += sec('Fuentes', (arr(gp(titular,'fuentes','fuente')).map(esc).join(', ')||secEmpty()));
  return h;
}
function bodyBoletinSimple(prd){
  const wsTag = Object.keys(prd).filter(k=>!k.startsWith('@_'))[0];
  const body = wsTag ? prd[wsTag] : null;
  const dnode = gp(body,'ROOT','D');
  const hasDetail = dnode && Object.keys(dnode).some(k=>!k.startsWith('@_') && k!=='param');
  if(!hasDetail) return noinfo();
  return '<div class="rep-tree">'+renderTree(body)+'</div>';
}
// Boletín Impagos Vigentes (3425): Resumen (tipo acreedor × año) + Detalle de causas.
function bodyBoletinImpagos(prd){
  const wsTag = Object.keys(prd).filter(k=>!k.startsWith('@_'))[0];
  const P = gp(prd, wsTag, 'ROOT','D','result','PRODUCTO');
  if(!P) return bodyBoletinSimple(prd);                 // estructura inesperada → árbol crudo
  const detalle  = arr(gp(P,'detalle','d'));
  const indice   = arr(gp(P,'indice','d'));
  const totalano = arr(gp(P,'totalano','d'));
  if(!detalle.length && !indice.length) return noinfo();

  // Años (columnas) de mayor a menor
  let anos = totalano.map(x=>String(x['@_a'])).filter(Boolean);
  if(!anos.length) anos = indice.flatMap(r=>arr(r.a).map(a=>String(a['@_n'])));
  anos = [...new Set(anos)].sort((a,b)=>Number(b)-Number(a));

  const cell = v => (v==null||v===''||Number(v)===0) ? '--' : esc(String(v));

  // ── Resumen ──
  let h = '<div class="rep-h">Resumen</div>'+
    '<table class="rep-tb"><thead>'+
    '<tr><th rowspan="2">Tipo Acreedor</th><th colspan="'+(anos.length||1)+'" style="text-align:center">Cantidad</th></tr>'+
    '<tr>'+(anos.length?anos:['']).map(a=>'<th style="text-align:right">'+esc(a)+'</th>').join('')+'</tr>'+
    '</thead><tbody>';
  indice.forEach(r=>{
    const byYear={}; arr(r.a).forEach(a=>byYear[String(a['@_n'])]=a['@_valor']);
    h += '<tr><td>'+esc(r['@_nombre']||'')+'</td>'+anos.map(a=>'<td style="text-align:right">'+cell(byYear[a])+'</td>').join('')+'</tr>';
  });
  const totPorAno={}; totalano.forEach(x=>totPorAno[String(x['@_a'])]=x['@_c']);
  const granTotal = arr(gp(P,'total','d')).reduce((s,x)=>s+(Number(x['@_c'])||0),0);
  h += '<tr style="font-weight:700"><td>Total</td>'+anos.map(a=>'<td style="text-align:right">'+cell(totPorAno[a])+'</td>').join('')+'</tr>';
  h += '</tbody></table>';
  if(granTotal) h += '<div class="rep-kv" style="margin-top:4px"><b>Total impagos vigentes:</b> '+granTotal+'</div>';

  // ── Detalle ──
  h += '<div class="rep-h">Detalle</div>';
  if(!detalle.length){ h += noinfo(); return h; }
  h += '<table class="rep-tb"><thead><tr>'+
    ['Identificación','Tipo Acreedor','Acreedor','Fecha Publicación','Documento / Fuente','Días en Cobranza','RUT','Clasificación','Referencia']
      .map(t=>'<th>'+t+'</th>').join('')+'</tr></thead><tbody>'+
    detalle.map(x=>{
      const ref = x.referencia||x.url;
      const refLink = ref ? '<a href="'+esc(ref)+'" target="_blank" rel="noopener">ver Causa</a>' : '—';
      const fuente = esc(x.fuente||'') + (x.proceso?'<div class="muted" style="font-size:.68rem">'+esc(x.proceso)+'</div>':'');
      return '<tr><td>'+esc(x.identificacion||'')+'</td><td>'+esc(x.glscodacteco||'')+'</td><td>'+esc(x.acreedor||'')+'</td>'+
        '<td>'+esc(x.fecha||'')+'</td><td>'+fuente+'</td><td style="text-align:right">'+fmtMiles(x.diamora)+'</td>'+
        '<td>'+esc(rutFmt(x.rutacreedor,x.digacreedor)||'')+'</td><td>'+esc(x.clasificacion||'')+'</td><td>'+refLink+'</td></tr>';
    }).join('')+'</tbody></table>';
  return h;
}

function renderInforme(d){
  let cont = d.contenido; if(typeof cont==='string'){ try{cont=JSON.parse(cont);}catch(_){ } }
  const prd = cont || {};
  const cod = String(d.codigo_producto);
  const titular = deepFind(prd,['nombre']) || '';
  let body;
  if(cod==='2101') body = bodyPension(d, prd);
  else if(cod==='16') body = bodyComportamiento(prd);
  else if(cod==='3435') body = bodyPerfilComercial(prd);
  else if(cod==='3425') body = bodyBoletinImpagos(prd);
  else body = '<div class="rep-note">Datos recibidos del Web Service:</div><div class="rep-tree">'+renderTree(prd)+'</div>';
  const f = new Date(d.created_at);
  const meta = `<div class="rep-meta">
    <span><b>Gestor:</b> ${esc(d.usuario_nombre||'—')}</span>
    <span><b>Fecha Consulta:</b> ${f.toLocaleDateString('es-CL')}</span>
    <span><b>Fte. Proveedora:</b> ${esc(FTE[cod]||'DealerNET')}</span>
    <span><b>Resolución:</b> On Line</span>
    <span><b>Hora Consulta:</b> ${f.toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'})}</span></div>`;
  return `<div class="report">
    <div class="rep-logo"><img class="l-af" src="${LOGO}" alt="AutoFácil"><img class="l-dn" src="${LOGO_DN}" alt="DealerNET"></div>
    <div class="rep-titularbar"><b>${esc(titular||'')}</b><span>${esc(rutFmt(d.rut,d.dv)||(d.rut+'-'+(d.dv||'')))}</span></div>
    <div class="rep-title">${esc(d.nombre_producto||cod)}</div>
    ${meta}
    <div class="rep-body">${body}</div>
    <div class="rep-legal">El presente informe ha sido emitido de conformidad con la ley N° 19.628 a partir de fuentes de información de acceso público. La información comprendida en este informe es para uso exclusivo de nuestros suscriptores y sólo puede ser utilizada con fines estrictamente comerciales.</div>
  </div>`;
}
  window.DNInforme = { render: renderInforme, renderTree: renderTree, esc: esc };
})();
