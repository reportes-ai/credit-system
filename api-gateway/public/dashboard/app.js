// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 15
// ──────────────────────────────────────────────────────────────
// ── Auth: usa JWT del credit-system ──────────────────────────────────────────
const _token = sessionStorage.getItem('token');
const _usuario = JSON.parse(sessionStorage.getItem('usuario') || 'null');
if (!_token) { window.location.href = '/login.html'; }

// Stub para llamadas de usuarios que no aplican (sub-tab oculto)
const _sesionToken = _token;
async function apiUsuarios() { return { ok: false, error: 'Gestión de usuarios en el sistema principal' }; }

let sesionActual = _usuario ? {
  nombre: _usuario.nombre || _usuario.email || 'Usuario',
  perfil: _usuario.perfil || _usuario.perfil_nombre || 'USUARIO',
  usuario: _usuario.email || ''
} : { nombre: 'Usuario', perfil: 'USUARIO', usuario: '' };

// Funcionalidades del usuario (matriz Perfiles y Permisos); se llena en cargarPermisosDesdeAPI
let _funcsDash = new Set();
// "Admin" del dashboard = Administrador O quien tenga 'dashboard_config' (config de tabs/presupuesto)
function esAdmin() {
  if (sesionActual && sesionActual.perfil &&
      sesionActual.perfil.toLowerCase() === 'administrador') return true;
  return _funcsDash.has('dashboard_config');
}

function actualizarTopbarUsuario() {
  const el = document.getElementById('topbar-usuario');
  if (el) {
    el.innerHTML = '<span style="font-size:10px;color:#7bafd4">👤 ' + sesionActual.nombre + '</span>'
      + '<button onclick="cerrarSesion()" style="background:#1a3a6a;border:1px solid #2a4070;color:#aac4e8;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;margin-left:6px">Salir</button>';
  }
  // Mostrar tab Admin solo para Administrador
  const tabAdmin = document.getElementById('tab-admin');
  if (tabAdmin) tabAdmin.style.display = esAdmin() ? 'flex' : 'none';
  aplicarPermisosNavTabs();
}

function cerrarSesion() {
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('usuario');
  window.location.href = '/login.html';
}

// ── API dashboard propia ──────────────────────────────────────────────────────
async function apiDashboard(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _token }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('/api/dashboard/' + path, opts);
  return r.json();
}

async function cargarPermisosDesdeAPI() {
  try {
    const data = await apiDashboard('GET', 'permisos');
    if (data.success && data.permisos) {
      sessionStorage.setItem('af_tab_permisos', JSON.stringify(data.permisos));
    }
  } catch(e) { console.warn('No se pudieron cargar permisos:', e); }
  // Funcionalidades del usuario (para dashboard_config y futuros gates)
  try {
    const r = await fetch('/api/auth/mis-permisos?_='+Date.now(), { headers:{ Authorization:'Bearer '+_token } });
    const j = await r.json();
    _funcsDash = new Set(j.funcionalidades || []);
  } catch(e) { /* sin permisos extra */ }
}

document.addEventListener('DOMContentLoaded', async function() {
  await cargarPermisosDesdeAPI();
  actualizarTopbarUsuario();
});
// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 676
// ──────────────────────────────────────────────────────────────
// ======== DATA ========
const RAW = null; // reemplazado abajo

// Formato
const fM = v => {
  const a = Math.abs(v);
  if(a>=1e6) return (v/1e6).toFixed(1)+'M';
  if(a>=1e3) return (v/1e3).toFixed(0)+'K';
  return v.toLocaleString('es-CL',{maximumFractionDigits:0});
};
const fN = v => v==null?'0':Math.round(v).toLocaleString('es-CL');
const pct = (a,b) => b ? ((a-b)/b*100).toFixed(1) : '—';

const C = {
  navy:'#1a3a6a',blue:'#2196F3',teal:'#00838f',green:'#43a047',
  orange:'#fb8c00',red:'#e53935',yellow:'#fdd835',gray:'#90a4ae',
  lblue:'#64b5f6',lgray:'#eceff1'
};
const chOpts = (extra={}) => ({
  responsive:true, maintainAspectRatio:false,
  plugins:{ legend:{display:false}, tooltip:{backgroundColor:'#1a3a6a',titleColor:'#fff',bodyColor:'#cce0ff',cornerRadius:6,borderWidth:0} },
  scales:{ x:{grid:{color:'#f0f2f5'},ticks:{color:'#888',font:{size:9}}}, y:{grid:{color:'#f0f2f5'},ticks:{color:'#888',font:{size:9}}} },
  animation:{duration:500},
  ...extra
});

// ======== SHOW VIEW ========
function showV(id, el) {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
  if(id==='v1b') { buildV1b(); window._v1b=true; }
  if(id==='v2') {
    window.destroyCharts && window.destroyCharts();
    if (!window.DASH?.feb?.detalle_v2?.length) window.aplicarFiltro();
    buildV2();
    window._v2=true;
  }
  if(id==='v2pl') {
    window.destroyCharts && window.destroyCharts();
    if (!window.DASH?.feb?.detalle_v2?.length) window.aplicarFiltro();
    buildV2pl();
    window._v2pl=true;
  }
  if(id==='v3'&&!window._v3) { buildV3(); window._v3=true; }
  if(id==='v4') { buildV4(); window._v4=true; }
  if(id==='v5'&&!window._v5) { buildV5(); window._v5=true; }
  if(id==='v7') { const sd7=document.getElementById('sel-desde'); if(!sd7?.value) window.aplicarFiltro(); buildV7(); window._v7=true; }
  if(id==='v8') { const sd8=document.getElementById('sel-desde'); if(!sd8?.value) window.aplicarFiltro(); buildV8(); window._v8=true; }
  if(id==='vhist') { initVHist(); }
  if(id==='vppto') { buildVPpto(); }
  if(id==='vevol') { buildVEvol(); }
  if(id==='vseg')  { buildVSeg(); }
  if(id==='vdealers') { buildColocMensual('vdealers'); }
  if(id==='vparques') { buildColocMensual('vparques'); }
  if(id==='vproy2') { buildVProy2(); }
  if(id==='vadmin') {
    if (!esAdmin()) { alert('Acceso denegado.'); return; }
    buildVAdmin();
  }
  if(id==='v6') {
    const sd = document.getElementById('sel-desde');
    if (!sd?.value) window.aplicarFiltro();
    buildV6(); window._v6=true;
  }
}

// ======== FILTERS v2 ========
const fil = {mm:'', fin:'', ccs:''};
const fil_pl = {mm:'', fin:'', ccs:''};
function setFil(k, v, el) {
  fil[k]=v;
  const parent = el.parentElement;
  parent.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  buildRentabTable();
}

// ======== VISTA 1 ========
function buildV1() {
  const D = window.DASH;
  const f = D.feb, j = D.jan;

  // KPIs - datos de operaciones APROBADAS del mes (con financiera real)
  const totSaldo = (f.financieras.AUTOFIN?.saldo||0)+(f.financieras.UNIDAD?.saldo||0);
  const totOps = (f.financieras.AUTOFIN?.ops||0)+(f.financieras.UNIDAD?.ops||0);
  const totCD = (f.financieras.AUTOFIN?.com_dealer||0)+(f.financieras.UNIDAD?.com_dealer||0);
  const totAFA = (f.financieras.AUTOFIN?.rentab_afa||0)+(f.financieras.UNIDAD?.rentab_afa||0);
  const totSeg = (f.financieras.AUTOFIN?.com_seguros||0)+(f.financieras.UNIDAD?.com_seguros||0);

  document.getElementById('kpi1').innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Total a Financiar</div><div class="kpi-val big">${fM(totSaldo)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Operaciones Aprobadas</div><div class="kpi-val big">${totOps}</div></div>`;

  // Prom plazo y % financiado badges
  const af = f.financieras.AUTOFIN||{};


  // Tabla instituciones
  const rows = ['AUTOFIN','UNIDAD'].map(k => {
    const v = f.financieras[k];
    if(!v) return '';
    return `<tr>
      <td>${k==='AUTOFIN'?'AUTOFIN':'UNIDAD'}</td>
      <td>${v.ops}</td>
      <td>${fM(v.saldo)}</td>
      <td>${fM(v.prom_fin&&v.ops?v.prom_fin/v.ops:0)}</td>
      <td>${fM(v.saldo)}</td>
      <td>${fM(v.com_dealer)}</td>
      <td>${fM(v.rentab_afa)}</td>
      <td>${fM(v.com_seguros)}</td>
    </tr>`;
  }).join('');
  const totU = f.financieras.UNIDAD||{ops:0,saldo:0,com_dealer:0,rentab_afa:0,com_seguros:0,prom_fin:0};
  document.getElementById('t-fin').innerHTML = `
    <thead><tr><th>Institución</th><th>Ops Aprobadas</th><th>Total a Financiar</th><th>Prom. Fin</th><th>Saldo Precio</th><th>Com Dealer</th><th>Ing. x Colocaciones</th><th>Ing. x Seguros</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>Total</td><td>${totOps}</td><td>${fM(totSaldo)}</td><td>${fM(totSaldo/totOps)}</td><td>${fM(totSaldo)}</td><td>${fM(totCD)}</td><td>${fM(totAFA)}</td><td>${fM(totSeg)}</td></tr></tfoot>`;

  // Donut
  const dv = [f.financieras.AUTOFIN?.saldo||0, f.financieras.UNIDAD?.saldo||0];
  const dtot = dv.reduce((a,b)=>a+b,0);
  const pAF = dtot?(dv[0]/dtot*100).toFixed(1):0;
  document.getElementById('donut-pct').textContent = pAF+'%';
  new Chart(document.getElementById('ch-donut'),{
    type:'doughnut',
    data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:dv,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff',hoverOffset:4}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+fM(ctx.raw)+' ('+((ctx.raw/dtot)*100).toFixed(1)+'%)'}}},animation:{duration:600},responsive:true,maintainAspectRatio:false}
  });
  document.getElementById('donut-leg').innerHTML = ['AUTOFIN','UNIDAD'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]}"></div>
    <div><div style="font-size:9px;color:#555">${l}</div>
    <span class="dleg-val" style="font-size:11px">${fM(dv[i])}</span>
    <div style="font-size:10px;color:#888">${dtot?(dv[i]/dtot*100).toFixed(1):0}%</div></div></div>`).join('');

  // Donut Operaciones Aprobadas
  const dvOps1 = ['AUTOFIN','UNIDAD'].map(k => f.financieras[k]?.ops||0);
  const dtotOps1 = dvOps1.reduce((a,b)=>a+b,0);
  document.getElementById('donut-ops-pct').textContent = dtotOps1?(dvOps1[0]/dtotOps1*100).toFixed(1)+'%':'—';
  const existDOps = Chart.getChart(document.getElementById('ch-donut-ops'));
  if (existDOps) existDOps.destroy();
  new Chart(document.getElementById('ch-donut-ops'),{
    type:'doughnut',
    data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:dvOps1,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${ctx.raw} ops (${(ctx.raw/(dtotOps1||1)*100).toFixed(1)}%)`}}},animation:{duration:500},responsive:true,maintainAspectRatio:false}
  });
  document.getElementById('donut-ops-leg').innerHTML = ['AUTOFIN','UNIDAD'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]}"></div>
    <div><div style="font-size:9px;color:#555">${l}</div>
    <span class="dleg-val" style="font-size:11px">${dvOps1[i]}</span>
    <div style="font-size:10px;color:#888">${dtotOps1?(dvOps1[i]/dtotOps1*100).toFixed(1):0}%</div></div></div>`).join('');

  // 4 donuts adicionales v1 — usando RAW_DATA aprobados del período
  const aprobados1 = window.RAW_DATA.filter(r => {
    const desde = document.getElementById('sel-desde')?.value||'';
    const hasta  = document.getElementById('sel-hasta')?.value||'';
    return r.mes >= desde && r.mes <= hasta &&
           ['APROBADO','OTORGADO'].includes(r.estado_eval);
  });
  const finAp = {};
  aprobados1.forEach(r => {
    const inst = r.institucion==='UNIDAD DE CREDITO'?'UNIDAD':'AUTOFIN';
    if(!finAp[inst]) finAp[inst]={ops:0,saldo:0,fin:0,plazo_sum:0,afa:0,mayor:0,menor:0};
    finAp[inst].ops++; finAp[inst].saldo+=r.saldo_precio; finAp[inst].fin+=r.monto_financiado;
    finAp[inst].plazo_sum+=r.plazo; finAp[inst].afa+=r.rentab_afa;
    // mayor_menor calculado con UF de fecha_otorgado (viene del API)
    if((r.mayor_menor||'').includes('MAYOR')) finAp[inst].mayor++;
    else finAp[inst].menor++;
  });
  const totAp = aprobados1.length;
  const mayorAp = aprobados1.filter(r=>(r.mayor_menor||'').includes('MAYOR')).length;
  const menorAp = totAp - mayorAp;

  // Donut 1: Composición 200UF
  const dvMM1 = [mayorAp, menorAp], dtMM1 = dvMM1[0]+dvMM1[1];
  document.getElementById('d1-mm-pct').textContent = dtMM1?(dvMM1[0]/dtMM1*100).toFixed(1)+'%':'—';
  ['ch-d1-mm'].forEach(id=>{const c=Chart.getChart(document.getElementById(id));if(c)c.destroy();});
  new Chart(document.getElementById('ch-d1-mm'),{type:'doughnut',
    data:{labels:['MAYOR 200UF','MENOR 200UF'],datasets:[{data:dvMM1,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.raw} ops (${(ctx.raw/(dtMM1||1)*100).toFixed(1)}%)`}}},animation:{duration:300},responsive:true,maintainAspectRatio:false}});
  document.getElementById('d1-mm-leg').innerHTML = [['MAYOR 200UF',mayorAp],['MENOR 200UF',menorAp]].map(([l,v],i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]};width:8px;height:8px"></div>
    <div><div style="font-size:9px">${l}</div><span style="font-size:10px;font-weight:600">${v}</span>
    <span style="font-size:9px;color:#888"> ${dtMM1?(v/dtMM1*100).toFixed(1):0}%</span></div></div>`).join('');

  // Donut 2: Plazo prom por institución
  const plazos1 = ['AUTOFIN','UNIDAD'].map(k=>finAp[k]&&finAp[k].ops?Math.round(finAp[k].plazo_sum/finAp[k].ops):0);
  const plazoTot1 = totAp?Math.round(aprobados1.reduce((a,r)=>a+r.plazo,0)/totAp):0;
  document.getElementById('d1-plazo-pct').textContent = plazoTot1+'m';
  ['ch-d1-plazo'].forEach(id=>{const c=Chart.getChart(document.getElementById(id));if(c)c.destroy();});
  new Chart(document.getElementById('ch-d1-plazo'),{type:'doughnut',
    data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:plazos1,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${ctx.raw}m`}}},animation:{duration:300},responsive:true,maintainAspectRatio:false}});
  document.getElementById('d1-plazo-leg').innerHTML = ['AUTOFIN','UNIDAD'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]};width:8px;height:8px"></div>
    <div><div style="font-size:9px">${l}</div><span style="font-size:10px;font-weight:600">${plazos1[i]}m</span></div></div>`).join('');

  // Donut 3: Monto prom por institución
  const montos1 = ['AUTOFIN','UNIDAD'].map(k=>finAp[k]&&finAp[k].ops?finAp[k].fin/finAp[k].ops:0);
  const montoTot1 = totAp?aprobados1.reduce((a,r)=>a+r.monto_financiado,0)/totAp:0;
  document.getElementById('d1-monto-pct').textContent = fM(montoTot1);
  ['ch-d1-monto'].forEach(id=>{const c=Chart.getChart(document.getElementById(id));if(c)c.destroy();});
  new Chart(document.getElementById('ch-d1-monto'),{type:'doughnut',
    data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:montos1,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${fM(ctx.raw)}`}}},animation:{duration:300},responsive:true,maintainAspectRatio:false}});
  document.getElementById('d1-monto-leg').innerHTML = ['AUTOFIN','UNIDAD'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]};width:8px;height:8px"></div>
    <div><div style="font-size:9px">${l}</div><span style="font-size:10px;font-weight:600">${fM(montos1[i])}</span></div></div>`).join('');

  // Donut 4: Ing. x Col. por institución
  const afas1 = ['AUTOFIN','UNIDAD'].map(k=>finAp[k]?.afa||0);
  const afaTot1 = afas1.reduce((a,b)=>a+b,0);
  document.getElementById('d1-afa-pct').textContent = afaTot1?(afas1[0]/afaTot1*100).toFixed(1)+'%':'—';
  ['ch-d1-afa'].forEach(id=>{const c=Chart.getChart(document.getElementById(id));if(c)c.destroy();});
  new Chart(document.getElementById('ch-d1-afa'),{type:'doughnut',
    data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:afas1,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${fM(ctx.raw)} (${(ctx.raw/(afaTot1||1)*100).toFixed(1)}%)`}}},animation:{duration:300},responsive:true,maintainAspectRatio:false}});
  document.getElementById('d1-afa-leg').innerHTML = ['AUTOFIN','UNIDAD'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]};width:8px;height:8px"></div>
    <div><div style="font-size:9px">${l}</div><span style="font-size:10px;font-weight:600">${fM(afas1[i])}</span>
    <span style="font-size:9px;color:#888"> ${afaTot1?(afas1[i]/afaTot1*100).toFixed(1):0}%</span></div></div>`).join('');

  // Resumen mes anterior (enero)
  const jaf = j.financieras?.AUTOFIN||{}, jun = j.financieras?.UNIDAD||{};
  const jOt = jaf.ops||0; const jSeg = j.estados?.APROBADO?.ops||0;
  const jSaldoOt = jaf.saldo||0; const jSaldoSeg = 0;
  // Calcular APROBADOS = APROBADO + OTORGADO + ANULADO + PENDIENTE
  const jEstados = j.estados || {};
  const jAprobQ = (jEstados.APROBADO?.ops||0) + (jEstados.OTORGADO?.ops||0) + (jEstados.ANULADO?.ops||0) + (jEstados.PENDIENTE?.ops||0);
  const jAprobS = (jEstados.APROBADO?.saldo||0) + (jEstados.OTORGADO?.saldo||0) + (jEstados.ANULADO?.saldo||0) + (jEstados.PENDIENTE?.saldo||0);
  const jRecQ   = jEstados.RECHAZADO?.ops||0;
  const jRecS   = jEstados.RECHAZADO?.saldo||0;
  const jTotalQ = j.total_ops||0;
  document.getElementById('t-jan').innerHTML =
    '<thead><tr><th>Estado Comercial</th><th>Q</th><th>%</th><th>Total a Financiar</th></tr></thead>' +
    '<tbody>' +
    '<tr><td>APROBADOS</td><td>'+jAprobQ+'</td><td>'+(jTotalQ?(jAprobQ/jTotalQ*100).toFixed(1):0)+'%</td><td>'+fM(jAprobS)+'</td></tr>' +
    '<tr><td>RECHAZADOS</td><td>'+jRecQ+'</td><td>'+(jTotalQ?(jRecQ/jTotalQ*100).toFixed(1):0)+'%</td><td>'+fM(jRecS)+'</td></tr>' +
    '</tbody>' +
    '<tfoot><tr><td>Total</td><td>'+jTotalQ+'</td><td>100%</td><td>'+fM(j.total_saldo||0)+'</td></tr></tfoot>';

  // Tabla concesionarios
  const ccsRows = f.ccs.map((c,i)=>`<tr>
    <td><span class="rank">${i+1}.</span>${c.nombre.length>28?c.nombre.substring(0,28)+'…':c.nombre}</td>
    <td>${c.ops}</td><td>${fM(c.saldo)}</td><td>${fM(c.saldo/c.ops)}</td>
    <td>${fM(c.saldo)}</td><td>${fM(c.com_dealer)}</td><td>${fM(c.rentab_afa)}</td>
  </tr>`).join('');
  const totCC = f.ccs.reduce((a,c)=>({ops:a.ops+c.ops,saldo:a.saldo+c.saldo,cd:a.cd+c.com_dealer}),{ops:0,saldo:0,cd:0});
  document.getElementById('t-ccs').innerHTML = `
    <thead><tr><th>Ccs</th><th>Q</th><th>Total a Financiar</th><th>Prom a Fin</th><th>Saldo Precio</th><th>Com Dealer</th><th>Ing. x Colocaciones</th></tr></thead>
    <tbody>${ccsRows}</tbody>
    <tfoot><tr><td>Total</td><td>${totCC.ops}</td><td>${fM(totCC.saldo)}</td><td>—</td><td>${fM(totCC.saldo)}</td><td>${fM(totCC.cd)}</td><td>—</td></tr></tfoot>`;

  // Tabla ejecutivos
  const ejRows = f.ejecutivos.map((e,i)=>`<tr>
    <td><span class="rank">${i+1}.</span><a class="ej-link" onclick="abrirDetalleEjecutivo('${e.nombre.replace(/'/g,"\\'")}','ap')">${e.nombre.length>24?e.nombre.substring(0,24)+'…':e.nombre}</a></td>
    <td>${e.ops}</td><td>${fM(e.saldo)}</td><td>${fM(e.saldo/e.ops)}</td>
    <td>${fM(e.saldo)}</td><td>${fM(e.com_dealer)}</td><td>${fM(e.rentab_afa)}</td>
  </tr>`).join('');
  const totEJ = f.ejecutivos.reduce((a,e)=>({ops:a.ops+e.ops,saldo:a.saldo+e.saldo,cd:a.cd+e.com_dealer}),{ops:0,saldo:0,cd:0});
  document.getElementById('t-ej').innerHTML = `
    <thead><tr><th>Ejecutivo</th><th>Record</th><th>Total a Financiar</th><th>Prem a Fin</th><th>Saldo Precio</th><th>Com Dealer</th><th>Ing. x Colocaciones</th></tr></thead>
    <tbody>${ejRows}</tbody>
    <tfoot><tr><td>Total</td><td>${totEJ.ops}</td><td>${fM(totEJ.saldo)}</td><td>—</td><td>${fM(totEJ.saldo)}</td><td>${fM(totEJ.cd)}</td><td>—</td></tr></tfoot>`;

  // Estado comercial — OTORGADO se suma a APROBADO (ambos son aprobados)
  const estadosAgrup = {};
  Object.entries(f.estados||{}).forEach(([k,v]) => {
    // OTORGADO y APROBADO se agrupan como "APROBADO" / EN SEGUIMIENTO
    const label = (k==='OTORGADO'||k==='APROBADO'||k==='SOLICITUD EN EVALUACION'||k==='CURSADO') ? 'APROBADO' :
                  k==='RECHAZADO' ? 'RECHAZADO' :
                  k==='ANULADO'   ? 'ANULADO'   : k;
    if (!estadosAgrup[label]) estadosAgrup[label] = {ops:0,saldo:0};
    estadosAgrup[label].ops   += v.ops;
    estadosAgrup[label].saldo += v.saldo;
  });
  const totEst = Object.values(estadosAgrup).reduce((a,v)=>({ops:a.ops+v.ops,saldo:a.saldo+v.saldo}),{ops:0,saldo:0});
  const estOrdAgrup = ['APROBADO','RECHAZADO','ANULADO','PENDIENTE'];
  const estRows = estOrdAgrup.filter(k=>estadosAgrup[k]).map(k=>{
    const v=estadosAgrup[k];
    const pct = totEst.ops ? (v.ops/totEst.ops*100).toFixed(1) : 0;
    return '<tr><td>'+k+'</td><td>'+v.ops+'</td><td>'+pct+'%</td><td>'+fM(v.saldo)+'</td></tr>';
  }).join('');
  document.getElementById('t-estado').innerHTML =
    '<thead><tr><th>Estado Comercial</th><th>N° op</th><th>%</th><th>Total Fin.</th></tr></thead>' +
    '<tbody>'+estRows+'</tbody>' +
    '<tfoot><tr><td>Total</td><td>'+totEst.ops+'</td><td>100%</td><td>'+fM(totEst.saldo)+'</td></tr></tfoot>';

  // Motivo (usando estados crédito como proxy)
  const motOrd = ['OTORGADO','APROBADO','ANULADO','RECHAZADO'];
  const motRows = motOrd.filter(k=>f.motivos[k]).map(k=>{
    const v=f.motivos[k]; const label = k==='OTORGADO'?'FIRMADO':k==='APROBADO'?'CONFIRMACIÓN CLIENTE':k==='RECHAZADO'?'DESISTE':k;
    return `<tr><td>${label}</td><td>${v.ops}</td><td>${v.pct}%</td><td>${fM(v.saldo)}</td></tr>`;
  }).join('');
  document.getElementById('t-motivo').innerHTML = `
    <thead><tr><th>Motivo</th><th>N° op</th><th>%</th><th>Total Fin.</th></tr></thead>
    <tbody>${motRows}</tbody>
    <tfoot><tr><td>Total</td><td>${totEst.ops}</td><td>100%</td><td>${fM(totEst.saldo)}</td></tr></tfoot>`;
}

// ======== VISTA 2 ========
function buildV2() {
  const D = window.DASH;
  // SIEMPRE leer desde DASH.feb que se actualiza en aplicarFiltro
  const det = (D.feb && D.feb.detalle_v2) ? D.feb.detalle_v2 : (D.detalle_v2 || []);
  const f = D.feb;

  // Actualizar título con período actual
  const lbl = document.getElementById('periodo-label')?.textContent || '';
  const tituloEl = document.getElementById('titulo-detalle-v2');
  if (tituloEl) tituloEl.textContent = 'Detalle Operaciones Otorgadas — ' + lbl;

  const totFin = det.reduce((a,r)=>a+r.total_a_financiar,0);
  const totSal = det.reduce((a,r)=>a+r.saldo_precio,0);
  const totAFA = det.reduce((a,r)=>a+r.ing_autofacil,0);
  const totCD  = det.reduce((a,r)=>a+r.com_dealer,0);
  const totSeg = det.reduce((a,r)=>a+r.com_seguros,0);
  const totPar = det.reduce((a,r)=>a+r.com_par,0);
  const totIG  = det.reduce((a,r)=>a+r.ingreso_bruto,0);
  const totCD_P= totCD+totPar;
  const totOps = det.length;
  const avgPlazo = det.length ? Math.round(det.reduce((a,r)=>a+r.plazo,0)/det.length) : 0;
  const avgFin   = totOps ? Math.round(totFin/totOps) : 0;

  const totIN = totIG - totCD_P;
  const totSpread = totAFA - totCD - totPar;
  document.getElementById('kpi2').innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Ingreso Bruto</div><div class="kpi-val big">${fM(totIG)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Comisión Dealer</div><div class="kpi-val big">${fM(totCD)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Comisión Parque</div><div class="kpi-val big">${fM(totPar)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Spread AutoFácil</div><div class="kpi-val big">${fM(totSpread)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Comisión Seguros</div><div class="kpi-val big">${fM(totSeg)}</div></div>`;
  document.getElementById('r-ingneto').textContent = fM(totIN);

  // Donut mayor/menor
  const mayor = det.filter(r=>r.mm==='>');
  const menor = det.filter(r=>r.mm==='<');
  const dv2 = [mayor.reduce((a,r)=>a+r.ing_autofacil,0), menor.reduce((a,r)=>a+r.ing_autofacil,0)];
  const dt2 = dv2.reduce((a,b)=>a+b,0);
  document.getElementById('donut2-pct').textContent = dt2?(dv2[0]/dt2*100).toFixed(1)+'%':'—';
  new Chart(document.getElementById('ch-donut2'),{
    type:'doughnut',
    data:{labels:['MAYOR','MENOR'],datasets:[{data:dv2,backgroundColor:[C.blue,C.teal],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+fM(ctx.raw)}}},animation:{duration:500},responsive:true,maintainAspectRatio:false}
  });
  document.getElementById('donut2-leg').innerHTML = ['MAYOR 200UF','MENOR 200UF'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,C.teal][i]}"></div>
    <div><div style="font-size:10px;color:#555">${l}</div>
    <span class="dleg-val">${fM(dv2[i])}</span>
    <div style="font-size:11px;color:#888">${dt2?(dv2[i]/dt2*100).toFixed(1):0}%</div></div></div>`).join('');

  // ── Donut 3: Composición Colocaciones por N° Ops y Monto ──
  const dv3ops = [mayor.length, menor.length];
  const dv3sal = [mayor.reduce((a,r)=>a+r.saldo_precio,0), menor.reduce((a,r)=>a+r.saldo_precio,0)];
  const dt3 = dv3ops.reduce((a,b)=>a+b,0);
  const dt3sal = dv3sal.reduce((a,b)=>a+b,0);
  document.getElementById('donut3-pct').textContent = dt3?(dv3ops[0]/dt3*100).toFixed(1)+'%':'—';
  const existingDonut3 = Chart.getChart(document.getElementById('ch-donut3'));
  if (existingDonut3) existingDonut3.destroy();
  new Chart(document.getElementById('ch-donut3'),{
    type:'doughnut',
    data:{labels:['MAYOR 200UF','MENOR 200UF'],datasets:[{data:dv3ops,backgroundColor:[C.blue,C.teal],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${ctx.raw} ops (${(ctx.raw/(dt3||1)*100).toFixed(1)}%)`}}},animation:{duration:500},responsive:true,maintainAspectRatio:false}
  });
  document.getElementById('donut3-leg').innerHTML = ['MAYOR 200UF','MENOR 200UF'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,C.teal][i]}"></div>
    <div><div style="font-size:10px;color:#555">${l}</div>
    <span class="dleg-val">${dv3ops[i]} ops</span>
    <span class="dleg-pct"> ${dt3?(dv3ops[i]/dt3*100).toFixed(1):0}%</span>
    <div style="font-size:10px;color:#888">${fM(dv3sal[i])}</div></div></div>`).join('');

  // Estado eval riesgo
  document.getElementById('t-estado2').innerHTML = `
    <thead><tr><th>Estado Eval. Riesgo</th><th>OP</th></tr></thead>
    <tbody>
      <tr><td>✓ OTORGADO</td><td>${det.length}</td></tr>
      <tr><td>✓ ANULADO</td><td>1</td></tr>
    </tbody>`;

  // Chart mayor/menor AFA vs total
  new Chart(document.getElementById('ch-mm'),{
    type:'bar',
    data:{labels:['MAYOR','MENOR'],datasets:[
      {label:'Ing.AFA+Seg',data:dv2,backgroundColor:[C.blue+'bb',C.teal+'bb'],borderRadius:4},
      {label:'Total Fin.',data:[mayor.reduce((a,r)=>a+r.total_a_financiar,0),menor.reduce((a,r)=>a+r.total_a_financiar,0)],backgroundColor:[C.red+'bb',C.orange+'99'],borderRadius:4}
    ]},
    options:{...chOpts(),plugins:{...chOpts().plugins,legend:{display:true,labels:{color:'#555',font:{size:9},boxWidth:10}}}}
  });

  // Chart com desglosado
  new Chart(document.getElementById('ch-com'),{
    type:'bar',
    data:{labels:['Ing.AFA','Com.Seguros','Ing.AFA+Seg'],datasets:[{data:[totAFA,totSeg,totAFA+totSeg],backgroundColor:[C.blue+'bb',C.teal+'bb',C.green+'bb'],borderRadius:4}]},
    options:{...chOpts(),indexAxis:'y'}
  });

  // Chart ops por mes
  const last8 = (D.tendencia||[]).slice(-8);
  new Chart(document.getElementById('ch-qmes'),{
    type:'bar',
    data:{labels:last8.map(t=>t.mes),datasets:[{data:last8.map(t=>t.otorgados),backgroundColor:C.yellow+'cc',borderRadius:3}]},
    options:{...chOpts()}
  });

  // Populate ccs filter
  // Resetear filtros al reconstruir v2
  fil.mm=''; fil.fin=''; fil.ccs='';
  document.querySelectorAll('#v2 .pill').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('#v2 .pill:first-child').forEach(p=>p.classList.add('active'));

  const ccsUniq = [...new Set(det.map(r=>r.ccs))].sort();
  document.getElementById('fil-ccs').innerHTML = '<option value="">Todos</option>' + ccsUniq.map(c=>`<option value="${c}">${c}</option>`).join('');
  document.getElementById('fil-ccs').onchange = function(){ fil.ccs=this.value; buildRentabTable(); };

  buildRentabTable();
}

function buildRentabTable() {
  const D = window.DASH;
  const det = (D.feb && D.feb.detalle_v2) ? D.feb.detalle_v2 : (D.detalle_v2 || []);
  let rows = det;
  if(fil.mm) rows = rows.filter(r=>r.mm===fil.mm);
  if(fil.ccs) rows = rows.filter(r=>r.ccs===fil.ccs);
  if(fil.fin) rows = rows.filter(r=>r.financiera===fil.fin);

  const pClass = p => p>=25?'pct-ok':p>=15?'pct-hi':p>=8?'pct-warn':'pct-bad';
  const trs = rows.map((r,i)=>`<tr>
    <td>${r.op||'—'}</td>
    <td><span class="${r.mm==='>'?'tag-may':'tag-men'}">${r.mm==='>'?'MAYOR':'MENOR'}</span></td>
    <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;text-align:left">${r.ccs.length>24?r.ccs.substring(0,24)+'…':r.ccs}</td>
    <td><span class="${r.financiera==='AUTOFIN'?'tag-men':'tag-may'}">${r.financiera||'—'}</span></td>
    <td>${fN(r.saldo_precio)}</td>
    <td>${fN(r.total_a_financiar)}</td>
    <td>${r.plazo}</td>
    <td>${fN(r.ing_autofacil)}</td>
    <td><span class="${pClass(r.pct_a)}">${r.pct_a}%</span></td>
    <td>${fN(r.com_dealer)}</td>
    <td><span class="${pClass(r.pct_d)}">${r.pct_d}%</span></td>
    <td>${fN(r.com_par)}</td>
    <td>0,0%</td>
    <td>${fN(r.total_com_broke)}</td>
    <td><span class="${pClass(r.pct_t)}">${r.pct_t}%</span></td>
    <td>${fN(r.com_seguros)}</td>
    <td>${fN(r.ingreso_bruto)}</td>
    <td><span class="${pClass(r.pct_b)}">${r.pct_b}%</span></td>
  </tr>`).join('');

  const tot = rows.reduce((a,r)=>({
    sal:a.sal+r.saldo_precio,fin:a.fin+r.total_a_financiar,
    afa:a.afa+r.ing_autofacil,cd:a.cd+r.com_dealer,par:a.par+r.com_par,
    tcb:a.tcb+r.total_com_broke,seg:a.seg+r.com_seguros,ig:a.ig+r.ingreso_bruto
  }),{sal:0,fin:0,afa:0,cd:0,par:0,tcb:0,seg:0,ig:0});
  const totOpsR = rows.length;
  const tAfaPct = tot.fin?(tot.afa/tot.fin*100).toFixed(1):0;
  const tCdPct  = tot.fin?(tot.cd/tot.fin*100).toFixed(1):0;
  const tTcbPct = tot.fin?(tot.tcb/tot.fin*100).toFixed(1):0;
  const tIgPct  = tot.fin?(tot.ig/tot.fin*100).toFixed(1):0;

  document.getElementById('t-rentab').innerHTML = `
    <thead><tr>
      <th>OP</th><th>&gt;=200UF</th><th style="text-align:left">Ccs</th><th>Financiera</th>
      <th>Saldo Precio</th><th>Total a Fin.</th><th>Plazo</th>
      <th>Ing.AutoFácil</th><th>%_A</th>
      <th>Com.Dealer</th><th>%_D</th>
      <th>Com Par</th><th>%_P</th>
      <th>Total Com Broke</th><th>%_t</th>
      <th>Com.Seguros</th>
      <th>Ingreso Bruto</th><th>%_B</th>
    </tr></thead>
    <tbody>${trs}</tbody>
    <tfoot><tr>
      <td colspan="4">Total / Prom.</td>
      <td>${fN(tot.sal)}</td><td>${fN(tot.fin)}</td>
      <td>${totOpsR ? Math.round(rows.reduce((a,r)=>a+r.plazo,0)/totOpsR) : '—'}m</td>
      <td>${fN(tot.afa)}</td><td><span class="${pClass(parseFloat(tAfaPct))}">${tAfaPct}%</span></td>
      <td>${fN(tot.cd)}</td><td><span class="${pClass(parseFloat(tCdPct))}">${tCdPct}%</span></td>
      <td>${fN(tot.par)}</td><td>0%</td>
      <td>${fN(tot.tcb)}</td><td><span class="${pClass(parseFloat(tTcbPct))}">${tTcbPct}%</span></td>
      <td>${fN(tot.seg)}</td>
      <td>${fN(tot.ig)}</td><td><span class="${pClass(parseFloat(tIgPct))}">${tIgPct}%</span></td>
    </tr></tfoot>`;

  // ── Actualizar KPIs con totales de filas filtradas ──
  const totOpsF = rows.length;
  const avgPlazoF = totOpsF ? Math.round(rows.reduce((a,r)=>a+r.plazo,0)/totOpsF) : 0;
  const avgFinF   = totOpsF ? Math.round(tot.fin/totOpsF) : 0;
  const totIN_F = tot.ig - (tot.cd + tot.par);
  const totSpread_F = tot.afa - tot.cd - tot.par;
  document.getElementById('kpi2').innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Ingreso Bruto</div><div class="kpi-val big">${fM(tot.ig)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Comisión Dealer</div><div class="kpi-val big">${fM(tot.cd)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Comisión Parque</div><div class="kpi-val big">${fM(tot.par)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Spread AutoFácil</div><div class="kpi-val big">${fM(totSpread_F)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Comisión Seguros</div><div class="kpi-val big">${fM(tot.seg)}</div></div>`;
  document.getElementById('r-ingneto').textContent = fM(totIN_F);
}

// ======== P&L OPERATIVO (copia independiente de v2) ========

/* Comisión de ejecutivos del período (motor único módulo Comisiones, por mes).
   Cachea por período; al llegar actualiza la caja Com. Ejecutivos y descuenta
   del KPI Ing. Neto AutoFácil (usa window.__PL_LAST = {totIN, totFin} del
   último render, así sobrevive a los re-render por filtros). */
const __plComEjCache = {};

/* Arriendo FIJO mensual total de los parques activos (mantenedor parques_comisiones).
   Los parques CON otorgadas ya suman su fijo vía prorrateo en las ops; el resto
   (parques sin colocación en el mes) se agrega aparte como costo fijo. */
// % sobre Total Financiado para los subtítulos de las cajas de dinero del P&L
const pctFin = (v, fin) => fin ? ((v / fin) * 100).toFixed(1) + '%' : '';
const setPct = (id, v, fin) => { const e = document.getElementById(id); if (e) e.textContent = pctFin(v, fin); };

let __arrFijoMes = null;
async function getArrFijoMes() {
  if (__arrFijoMes != null) return __arrFijoMes;
  try {
    const r = await fetch('/api/parques-comisiones', {
      headers: { Authorization: 'Bearer ' + (sessionStorage.getItem('token') || '') }
    }).then(x => x.json());
    __arrFijoMes = (r.data || [])
      .filter(p => p.activo === undefined || p.activo == 1)
      .reduce((a, p) => a + (parseFloat(p.arriendo) || 0), 0);
  } catch (e) { __arrFijoMes = 0; }
  return __arrFijoMes;
}
async function cargarComEjPL() {
  const cell = document.getElementById('r-comejec-pl');
  if (!cell) return;
  const aplicar = (comEj, nMeses) => {
    cell.textContent = fM(comEj);
    const L = window.__PL_LAST || {};
    setPct('r-comejec-pct-pl', comEj, L.totFin);
    // Arriendo fijo total del período: parques con ops ya lo aportan prorrateado
    // (L.arrOps); el resto (parques sin colocación) se descuenta como faltante.
    const arrTotal = (__arrFijoMes || 0) * (nMeses || 1);
    const arrFaltante = Math.max(0, arrTotal - (L.arrOps || 0));
    const arrCell = document.getElementById('r-arrparque-pl');
    if (arrCell && arrTotal > 0) { arrCell.textContent = fM(arrTotal); setPct('r-arrparque-pct-pl', arrTotal, L.totFin); }
    const inFinal = (L.totIN || 0) - comEj - arrFaltante;
    const kv = document.getElementById('kpi-in-pl'), ks = document.getElementById('kpi-in-sub-pl');
    if (kv) kv.textContent = fM(inFinal);
    if (ks) ks.textContent = pctFin(inFinal, L.totFin);
  };
  try {
    const desde = document.getElementById('sel-desde')?.value || '';
    const hasta = document.getElementById('sel-hasta')?.value || desde;
    if (!desde) { cell.textContent = '—'; return; }
    const meses = [];
    let [y, m] = desde.split('-').map(Number);
    const [hy, hm] = hasta.split('-').map(Number);
    while (y < hy || (y === hy && m <= hm)) {
      meses.push(`${y}-${String(m).padStart(2, '0')}`);
      m++; if (m > 12) { m = 1; y++; }
      if (meses.length > 24) break; // tope defensivo
    }
    await getArrFijoMes();
    const clave = desde + '|' + hasta;
    if (__plComEjCache[clave] != null) return aplicar(__plComEjCache[clave], meses.length);
    const H = { Authorization: 'Bearer ' + (sessionStorage.getItem('token') || '') };
    let comEj = 0;
    for (const mes of meses) {
      const r = await fetch('/api/comisiones/calculo?mes=' + mes, { headers: H }).then(x => x.json());
      if (r.success) comEj += (r.data || []).reduce((a, e) => a + (parseFloat(e.incentivo_final) || 0), 0);
    }
    __plComEjCache[clave] = comEj;
    aplicar(comEj, meses.length);
  } catch (e) { cell.textContent = '—'; }
}

function setFilPL(k, v, el) {
  fil_pl[k] = v;
  el.parentElement.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  buildRentabTablePL();
}

function buildV2pl() {
  const D = window.DASH;
  const det = (D.feb && D.feb.detalle_v2) ? D.feb.detalle_v2 : (D.detalle_v2 || []);

  const lbl = document.getElementById('periodo-label')?.textContent || '';
  const tituloEl = document.getElementById('titulo-detalle-v2-pl');
  if (tituloEl) tituloEl.textContent = 'Detalle Operaciones Otorgadas — ' + lbl;

  const totFin = det.reduce((a,r)=>a+r.total_a_financiar,0);
  const totSal = det.reduce((a,r)=>a+r.saldo_precio,0);
  const totAFA = det.reduce((a,r)=>a+r.ing_autofacil,0);
  const totCD  = det.reduce((a,r)=>a+r.com_dealer,0);
  const totSeg = det.reduce((a,r)=>a+r.com_seguros,0);
  const totPar = det.reduce((a,r)=>a+r.com_par,0);
  const totIG  = det.reduce((a,r)=>a+r.ingreso_bruto,0);
  const totCD_P= totCD+totPar;
  const totOps = det.length;
  const avgPlazo = det.length ? Math.round(det.reduce((a,r)=>a+r.plazo,0)/det.length) : 0;
  const avgFin   = totOps ? Math.round(totFin/totOps) : 0;
  // Ingreso neto = motor único ingreso_neto_total (incluye arriendo de parque);
  // la comisión de ejecutivos se descuenta aparte (async) en aplicarNetoPL.
  const totIN = det.reduce((a,r)=>a+(r.ing_neto||0),0);

  document.getElementById('kpi2-pl').innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Total Financiado</div><div class="kpi-val big">${fM(totFin)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Operaciones Otorgadas</div><div class="kpi-val big">${totOps}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. x Colocaciones</div><div class="kpi-val big">${fM(totAFA)}</div><div class="kpi-sub">${pctFin(totAFA, totFin)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. x Seguros</div><div class="kpi-val big">${fM(totSeg)}</div><div class="kpi-sub">${pctFin(totSeg, totFin)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. Bruto</div><div class="kpi-val big">${fM(totIG)}</div><div class="kpi-sub">${pctFin(totIG, totFin)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. Neto AutoFácil</div><div class="kpi-val big" id="kpi-in-pl">${fM(totIN)}</div><div class="kpi-sub" id="kpi-in-sub-pl">${pctFin(totIN, totFin)}</div></div>`;

  document.getElementById('r-saldo-pl').textContent = fM(totSal);
  document.getElementById('r-comdealer-pl').textContent = fM(totCD);
  document.getElementById('r-comparque-pl').textContent = fM(totPar);
  document.getElementById('r-totcd-pl').textContent = fM(totCD_P);
  document.getElementById('r-totcd-pct-pl').textContent = pctFin(totCD_P, totFin);
  const arrOps = det.reduce((a,r)=>a+(r.arriendo_parque||0),0);
  document.getElementById('r-arrparque-pl').textContent = fM(arrOps);
  setPct('r-saldo-pct-pl', totSal, totFin);
  setPct('r-comdealer-pct-pl', totCD, totFin);
  setPct('r-comparque-pct-pl', totPar, totFin);
  setPct('r-arrparque-pct-pl', arrOps, totFin);

  window.__PL_LAST = { totIN, totFin, arrOps };
  cargarComEjPL();
  document.getElementById('r-plazo-pl').textContent = avgPlazo+'m';
  document.getElementById('r-finprom-pl').textContent = fM(avgFin);

  const mayor = det.filter(r=>r.mm==='>');
  const menor = det.filter(r=>r.mm==='<');
  const dv2 = [mayor.reduce((a,r)=>a+r.ing_autofacil,0), menor.reduce((a,r)=>a+r.ing_autofacil,0)];
  const dt2 = dv2.reduce((a,b)=>a+b,0);
  document.getElementById('donut2-pct-pl').textContent = dt2?(dv2[0]/dt2*100).toFixed(1)+'%':'—';
  const ec2 = Chart.getChart(document.getElementById('ch-donut2-pl')); if(ec2) ec2.destroy();
  new Chart(document.getElementById('ch-donut2-pl'),{
    type:'doughnut',
    data:{labels:['MAYOR','MENOR'],datasets:[{data:dv2,backgroundColor:[C.blue,C.teal],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+fM(ctx.raw)}}},animation:{duration:500},responsive:true,maintainAspectRatio:false}
  });
  document.getElementById('donut2-leg-pl').innerHTML = ['MAYOR 200UF','MENOR 200UF'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,C.teal][i]}"></div>
    <div><div style="font-size:10px;color:#555">${l}</div>
    <span class="dleg-val">${fM(dv2[i])}</span>
    <div style="font-size:11px;color:#888">${dt2?(dv2[i]/dt2*100).toFixed(1):0}%</div></div></div>`).join('');

  const dv3ops = [mayor.length, menor.length];
  const dv3sal = [mayor.reduce((a,r)=>a+r.saldo_precio,0), menor.reduce((a,r)=>a+r.saldo_precio,0)];
  const dt3 = dv3ops.reduce((a,b)=>a+b,0);
  document.getElementById('donut3-pct-pl').textContent = dt3?(dv3ops[0]/dt3*100).toFixed(1)+'%':'—';
  const ec3 = Chart.getChart(document.getElementById('ch-donut3-pl')); if(ec3) ec3.destroy();
  new Chart(document.getElementById('ch-donut3-pl'),{
    type:'doughnut',
    data:{labels:['MAYOR 200UF','MENOR 200UF'],datasets:[{data:dv3ops,backgroundColor:[C.blue,C.teal],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${ctx.raw} ops`}}},animation:{duration:500},responsive:true,maintainAspectRatio:false}
  });
  document.getElementById('donut3-leg-pl').innerHTML = ['MAYOR 200UF','MENOR 200UF'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,C.teal][i]}"></div>
    <div><div style="font-size:10px;color:#555">${l}</div>
    <span class="dleg-val">${dv3ops[i]} ops</span>
    <span class="dleg-pct"> ${dt3?(dv3ops[i]/dt3*100).toFixed(1):0}%</span>
    <div style="font-size:10px;color:#888">${fM(dv3sal[i])}</div></div></div>`).join('');

  document.getElementById('t-estado2-pl').innerHTML = `
    <thead><tr><th>Estado Eval. Riesgo</th><th>OP</th></tr></thead>
    <tbody>
      <tr><td>✓ OTORGADO</td><td>${det.length}</td></tr>
      <tr><td>✓ ANULADO</td><td>1</td></tr>
    </tbody>`;

  const ecMM = Chart.getChart(document.getElementById('ch-mm-pl')); if(ecMM) ecMM.destroy();
  new Chart(document.getElementById('ch-mm-pl'),{
    type:'bar',
    data:{labels:['MAYOR','MENOR'],datasets:[
      {label:'Ing.AFA+Seg',data:dv2,backgroundColor:[C.blue+'bb',C.teal+'bb'],borderRadius:4},
      {label:'Total Fin.',data:[mayor.reduce((a,r)=>a+r.total_a_financiar,0),menor.reduce((a,r)=>a+r.total_a_financiar,0)],backgroundColor:[C.red+'bb',C.orange+'99'],borderRadius:4}
    ]},
    options:{...chOpts(),plugins:{...chOpts().plugins,legend:{display:true,labels:{color:'#555',font:{size:9},boxWidth:10}}}}
  });

  const ecCom = Chart.getChart(document.getElementById('ch-com-pl')); if(ecCom) ecCom.destroy();
  new Chart(document.getElementById('ch-com-pl'),{
    type:'bar',
    data:{labels:['Ing.AFA','Com.Seguros','Ing.AFA+Seg'],datasets:[{data:[totAFA,totSeg,totAFA+totSeg],backgroundColor:[C.blue+'bb',C.teal+'bb',C.green+'bb'],borderRadius:4}]},
    options:{...chOpts(),indexAxis:'y'}
  });

  const last8 = (D.tendencia||[]).slice(-8);
  const ecQ = Chart.getChart(document.getElementById('ch-qmes-pl')); if(ecQ) ecQ.destroy();
  new Chart(document.getElementById('ch-qmes-pl'),{
    type:'bar',
    data:{labels:last8.map(t=>t.mes),datasets:[{data:last8.map(t=>t.otorgados),backgroundColor:C.yellow+'cc',borderRadius:3}]},
    options:{...chOpts()}
  });

  fil_pl.mm=''; fil_pl.fin=''; fil_pl.ccs='';
  document.querySelectorAll('#v2pl .pill').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('#v2pl .pill:first-child').forEach(p=>p.classList.add('active'));

  const ccsUniq = [...new Set(det.map(r=>r.ccs))].sort();
  const filCcsPL = document.getElementById('fil-ccs-pl');
  if (filCcsPL) {
    filCcsPL.innerHTML = '<option value="">Todos</option>' + ccsUniq.map(c=>`<option value="${c}">${c}</option>`).join('');
    filCcsPL.onchange = function(){ fil_pl.ccs=this.value; buildRentabTablePL(); };
  }

  buildRentabTablePL();
}

function buildRentabTablePL() {
  const D = window.DASH;
  const det = (D.feb && D.feb.detalle_v2) ? D.feb.detalle_v2 : (D.detalle_v2 || []);
  let rows = det;
  if(fil_pl.mm)  rows = rows.filter(r=>r.mm===fil_pl.mm);
  if(fil_pl.ccs) rows = rows.filter(r=>r.ccs===fil_pl.ccs);
  if(fil_pl.fin) rows = rows.filter(r=>r.financiera===fil_pl.fin);

  const pClass = p => p>=25?'pct-ok':p>=15?'pct-hi':p>=8?'pct-warn':'pct-bad';
  const trs = rows.map(r=>`<tr>
    <td>${r.op||'—'}</td>
    <td><span class="${r.mm==='>'?'tag-may':'tag-men'}">${r.mm==='>'?'MAYOR':'MENOR'}</span></td>
    <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;text-align:left">${r.ccs.length>24?r.ccs.substring(0,24)+'…':r.ccs}</td>
    <td><span class="${r.financiera==='AUTOFIN'?'tag-men':'tag-may'}">${r.financiera||'—'}</span></td>
    <td>${fN(r.saldo_precio)}</td>
    <td>${fN(r.total_a_financiar)}</td>
    <td>${r.plazo}</td>
    <td>${fN(r.ing_autofacil)}</td>
    <td><span class="${pClass(r.pct_a)}">${r.pct_a}%</span></td>
    <td>${fN(r.com_dealer)}</td>
    <td><span class="${pClass(r.pct_d)}">${r.pct_d}%</span></td>
    <td>${fN(r.com_par)}</td>
    <td>0,0%</td>
    <td>${fN(r.total_com_broke)}</td>
    <td><span class="${pClass(r.pct_t)}">${r.pct_t}%</span></td>
    <td>${fN(r.com_seguros)}</td>
    <td>${fN(r.ingreso_bruto)}</td>
    <td><span class="${pClass(r.pct_b)}">${r.pct_b}%</span></td>
  </tr>`).join('');

  const tot = rows.reduce((a,r)=>({
    sal:a.sal+r.saldo_precio, fin:a.fin+r.total_a_financiar,
    afa:a.afa+r.ing_autofacil, cd:a.cd+r.com_dealer, par:a.par+r.com_par,
    tcb:a.tcb+r.total_com_broke, seg:a.seg+r.com_seguros, ig:a.ig+r.ingreso_bruto
  }),{sal:0,fin:0,afa:0,cd:0,par:0,tcb:0,seg:0,ig:0});
  const totOpsR = rows.length;
  const tAfaPct = tot.fin?(tot.afa/tot.fin*100).toFixed(1):0;
  const tCdPct  = tot.fin?(tot.cd/tot.fin*100).toFixed(1):0;
  const tTcbPct = tot.fin?(tot.tcb/tot.fin*100).toFixed(1):0;
  const tIgPct  = tot.fin?(tot.ig/tot.fin*100).toFixed(1):0;

  document.getElementById('t-rentab-pl').innerHTML = `
    <thead><tr>
      <th>OP</th><th>&gt;=200UF</th><th style="text-align:left">Ccs</th><th>Financiera</th>
      <th>Saldo Precio</th><th>Total a Fin.</th><th>Plazo</th>
      <th>Ing.AutoFácil</th><th>%_A</th>
      <th>Com.Dealer</th><th>%_D</th>
      <th>Com Par</th><th>%_P</th>
      <th>Total Com Broke</th><th>%_t</th>
      <th>Com.Seguros</th>
      <th>Ingreso Bruto</th><th>%_B</th>
    </tr></thead>
    <tbody>${trs}</tbody>
    <tfoot><tr>
      <td colspan="4">Total / Prom.</td>
      <td>${fN(tot.sal)}</td><td>${fN(tot.fin)}</td>
      <td>${totOpsR?Math.round(rows.reduce((a,r)=>a+r.plazo,0)/totOpsR):'—'}m</td>
      <td>${fN(tot.afa)}</td><td><span class="${pClass(parseFloat(tAfaPct))}">${tAfaPct}%</span></td>
      <td>${fN(tot.cd)}</td><td><span class="${pClass(parseFloat(tCdPct))}">${tCdPct}%</span></td>
      <td>${fN(tot.par)}</td><td>0%</td>
      <td>${fN(tot.tcb)}</td><td><span class="${pClass(parseFloat(tTcbPct))}">${tTcbPct}%</span></td>
      <td>${fN(tot.seg)}</td>
      <td>${fN(tot.ig)}</td><td><span class="${pClass(parseFloat(tIgPct))}">${tIgPct}%</span></td>
    </tr></tfoot>`;

  const totOpsF = rows.length;
  const avgPlazoF = totOpsF ? Math.round(rows.reduce((a,r)=>a+r.plazo,0)/totOpsF) : 0;
  const avgFinF   = totOpsF ? Math.round(tot.fin/totOpsF) : 0;
  // Motor único: ingreso_neto_total (incluye arriendo); com. ejecutivos se descuenta en cargarComEjPL
  const totIN_F = rows.reduce((a,r)=>a+(r.ing_neto||0),0);
  const arrOpsF = rows.reduce((a,r)=>a+(r.arriendo_parque||0),0);
  document.getElementById('kpi2-pl').innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Total Financiado</div><div class="kpi-val big">${fM(tot.fin)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Operaciones Otorgadas</div><div class="kpi-val big">${totOpsF}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. x Colocaciones</div><div class="kpi-val big">${fM(tot.afa)}</div><div class="kpi-sub">${pctFin(tot.afa, tot.fin)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. x Seguros</div><div class="kpi-val big">${fM(tot.seg)}</div><div class="kpi-sub">${pctFin(tot.seg, tot.fin)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. Bruto</div><div class="kpi-val big">${fM(tot.ig)}</div><div class="kpi-sub">${pctFin(tot.ig, tot.fin)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. Neto AutoFácil</div><div class="kpi-val big" id="kpi-in-pl">${fM(totIN_F)}</div><div class="kpi-sub" id="kpi-in-sub-pl">${pctFin(totIN_F, tot.fin)}</div></div>`;
  window.__PL_LAST = { totIN: totIN_F, totFin: tot.fin, arrOps: arrOpsF };
  cargarComEjPL();
  document.getElementById('r-saldo-pl').textContent = fM(tot.sal);
  document.getElementById('r-comdealer-pl').textContent = fM(tot.cd);
  document.getElementById('r-comparque-pl').textContent = fM(tot.par);
  document.getElementById('r-totcd-pl').textContent = fM(tot.cd + tot.par);
  document.getElementById('r-totcd-pct-pl').textContent = pctFin(tot.cd + tot.par, tot.fin);
  document.getElementById('r-arrparque-pl').textContent = fM(arrOpsF);
  setPct('r-saldo-pct-pl', tot.sal, tot.fin);
  setPct('r-comdealer-pct-pl', tot.cd, tot.fin);
  setPct('r-comparque-pct-pl', tot.par, tot.fin);
  setPct('r-arrparque-pct-pl', arrOpsF, tot.fin);
  document.getElementById('r-plazo-pl').textContent = avgPlazoF+'m';
  document.getElementById('r-finprom-pl').textContent = fM(avgFinF);
}

// ======== VISTA 3 ========
function buildV3() {
  const T = window.DASH.tendencia || [];
  const s25 = T.filter(t=>t.mes_key.startsWith('2025'));
  const totOps25 = s25.reduce((a,t)=>a+t.total_ops,0);
  const totOt25  = s25.reduce((a,t)=>a+t.otorgados,0);
  const totSal25 = s25.reduce((a,t)=>a+t.saldo_ot,0);
  const tcProm   = (totOt25/totOps25*100).toFixed(1);
  const best     = s25.reduce((a,b)=>b.otorgados>a.otorgados?b:a,s25[0]);

  document.getElementById('kpi3').innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Total Ingresados 2025</div><div class="kpi-val">${fN(totOps25)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Otorgados 2025</div><div class="kpi-val">${fN(totOt25)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Saldo Total 2025</div><div class="kpi-val">${fM(totSal25)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Tasa Conv. Prom.</div><div class="kpi-val">${tcProm}%</div></div>
    <div class="kpi-box"><div class="kpi-label">Mejor Mes</div><div class="kpi-val">${best.mes}</div><div class="kpi-sub">${best.otorgados} otorgados</div></div>`;

  const lbl = T.map(t=>t.mes);
  const chO = chOpts();

  new Chart(document.getElementById('ch-t1'),{
    type:'bar',
    data:{labels:lbl,datasets:[
      {label:'Otorgados',data:T.map(t=>t.otorgados),backgroundColor:T.map(t=>t.mes_key.startsWith('2026')?C.lblue+'dd':C.blue+'99'),borderRadius:4},
      {label:'Rechazados',data:T.map(t=>t.rechazados),backgroundColor:C.red+'44',borderRadius:4}
    ]},
    options:{...chO,plugins:{...chO.plugins,legend:{display:true,labels:{color:'#555',font:{size:9},boxWidth:10}}}}
  });
  new Chart(document.getElementById('ch-t2'),{
    type:'line',
    data:{labels:lbl,datasets:[{label:'Prom. por Op (M$)',data:T.map(t=>t.otorgados>0?+(t.saldo_ot/t.otorgados/1e6).toFixed(2):0),borderColor:C.green,backgroundColor:C.green+'22',fill:true,tension:.4,pointRadius:4,pointBackgroundColor:C.green}]},
    options:{...chO,scales:{...chO.scales,y:{...chO.scales.y,ticks:{...chO.scales.y.ticks,callback:v=>v+'M'}}}}
  });
  new Chart(document.getElementById('ch-t3'),{
    type:'bar',
    data:{labels:lbl,datasets:[
      {label:'Ing. AFA',data:T.map(t=>t.rentab_afa/1e6),backgroundColor:C.blue+'bb',borderRadius:3},
      {label:'Com. Dealer',data:T.map(t=>t.com_dealer/1e6),backgroundColor:C.orange+'99',borderRadius:3}
    ]},
    options:{...chO,plugins:{...chO.plugins,legend:{display:true,labels:{color:'#555',font:{size:9},boxWidth:10}}}}
  });
  new Chart(document.getElementById('ch-t4'),{
    type:'line',
    data:{labels:lbl,datasets:[{label:'%Conv',data:T.map(t=>t.tasa_conversion),borderColor:C.teal,backgroundColor:C.teal+'22',fill:true,tension:.4,pointRadius:3,pointBackgroundColor:C.teal}]},
    options:{...chO,scales:{...chO.scales,y:{...chO.scales.y,ticks:{...chO.scales.y.ticks,callback:v=>v+'%'}}}}
  });

  // Tabla resumen tendencia
  const trs = T.map(t=>`<tr>
    <td>${t.mes}</td><td>${t.total_ops}</td><td>${t.otorgados}</td>
    <td>${t.rechazados}</td><td>${fM(t.saldo_ot)}</td>
    <td>${fM(t.com_dealer)}</td><td>${fM(t.rentab_afa)}</td>
    <td>${t.tasa_conversion}%</td>
  </tr>`).join('');
  document.getElementById('t-tend').innerHTML = `
    <thead><tr><th>Mes</th><th>Total Ingresados</th><th>Otorgados</th><th>Rechazados</th><th>Prom. Op.</th><th>Com. Dealer</th><th>Ing. AFA</th><th>% Conv.</th></tr></thead>
    <tbody>${trs}</tbody>`;
}


// ======== VISTA 1b: SEGUIMIENTO OTORGADOS ========
function buildV1b() {
  const D = window.DASH;
  const f = D.feb, j = D.jan;

  // Solo otorgados del período
  const ot = D.feb.ot_otorgados || {}; // se calcula en calcResumen extendido
  
  // KPIs — usando datos de otorgados
  const afin = f.financieras?.AUTOFIN || {};
  const ufin = f.financieras?.UNIDAD || {};
  
  // Para otorgados usamos detalle_v2 que ya son solo otorgados
  const det = D.feb.detalle_v2 || [];
  const totOps = det.length;
  const totSaldo = det.reduce((a,r)=>a+r.saldo_precio,0);
  const totFin   = det.reduce((a,r)=>a+r.total_a_financiar,0);
  const totCD    = det.reduce((a,r)=>a+r.com_dealer,0);
  const totAFA   = det.reduce((a,r)=>a+r.ing_autofacil,0);
  const totSeg   = det.reduce((a,r)=>a+r.com_seguros,0);
  const avgPlazo = totOps ? Math.round(det.reduce((a,r)=>a+r.plazo,0)/totOps) : 0;

  document.getElementById('kpi1b').innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Total a Financiar</div><div class="kpi-val big">${fM(totFin)}</div></div>
    <div class="kpi-box" style="cursor:pointer" onclick="mostrarListaOps()" title="Ver detalle de operaciones">
      <div class="kpi-label">Operaciones Otorgadas</div>
      <div class="kpi-val big">${totOps}</div>
      <div class="kpi-sub" style="color:#4fc3f7;font-size:9px">🔍 ver detalle</div>
    </div>
    <div class="kpi-box highlight"><div class="kpi-label">Com. Dealer</div><div class="kpi-val big">${fM(totCD)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. x Colocaciones</div><div class="kpi-val big">${fM(totAFA)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. x Seguros</div><div class="kpi-val big">${fM(totSeg)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Plazo Prom.</div><div class="kpi-val big">${avgPlazo}m</div></div>`;

  // Guardar det para el modal
  window._detOps = det;

  // ── Alerta otorgados con datos incompletos ──────────────────────
  cargarAlertaIncompletos();

  // Tabla instituciones desde detalle_v2
  const finOt = {};
  det.forEach(r => {
    const k = r.financiera || 'AUTOFIN';
    if(!finOt[k]) finOt[k] = {ops:0,saldo:0,fin:0,com_dealer:0,rentab_afa:0,com_seguros:0,plazo_sum:0};
    finOt[k].ops++; finOt[k].saldo+=r.saldo_precio; finOt[k].fin+=r.total_a_financiar;
    finOt[k].com_dealer+=r.com_dealer; finOt[k].rentab_afa+=r.ing_autofacil;
    finOt[k].com_seguros+=r.com_seguros; finOt[k].plazo_sum+=r.plazo;
  });
  const finRows = ['AUTOFIN','UNIDAD'].map(k=>{
    const v=finOt[k]; if(!v) return '';
    return `<tr><td><strong>${k}</strong></td><td>${v.ops}</td><td>${fM(v.fin)}</td><td>${fM(v.ops?v.fin/v.ops:0)}</td><td>${fM(v.saldo)}</td><td>${fM(v.com_dealer)}</td><td>${fM(v.rentab_afa)}</td><td>${fM(v.com_seguros)}</td></tr>`;
  }).join('');
  document.getElementById('t-fin1b').innerHTML = `
    <thead><tr><th>Institución</th><th>Ops</th><th>Total Fin.</th><th>Prom. Fin</th><th>Saldo Precio</th><th>Com Dealer</th><th>Ing. x Col.</th><th>Ing. x Seguros</th></tr></thead>
    <tbody>${finRows}</tbody>
    <tfoot><tr><td>Total</td><td>${totOps}</td><td>${fM(totFin)}</td><td>${fM(totOps?totFin/totOps:0)}</td><td>${fM(totSaldo)}</td><td>${fM(totCD)}</td><td>${fM(totAFA)}</td><td>${fM(totSeg)}</td></tr></tfoot>`;

  // Donut
  const dv = ['AUTOFIN','UNIDAD'].map(k=>(finOt[k]?.saldo||0));
  const dtot = dv.reduce((a,b)=>a+b,0);
  document.getElementById('donut1b-pct').textContent = dtot?(dv[0]/dtot*100).toFixed(1)+'%':'—';
  new Chart(document.getElementById('ch-donut1b'),{
    type:'doughnut',
    data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:dv,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+fM(ctx.raw)+' ('+((ctx.raw/(dtot||1))*100).toFixed(1)+'%)'}}},animation:{duration:500},responsive:true,maintainAspectRatio:false}
  });
  // Donut 1: Saldo Precio por institución (% al lado de la cifra, como ING. AFA)
  document.getElementById('donut1b-leg').innerHTML = ['AUTOFIN','UNIDAD'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]}"></div>
    <div><div style="font-size:9px;color:#555">${l}</div>
    <span class="dleg-val" style="font-size:11px">${fM(dv[i])}</span>
    <span style="font-size:10px;color:#888"> ${dtot?(dv[i]/dtot*100).toFixed(1):0}%</span></div></div>`).join('');

  // Donut 2: Operaciones por institución
  const dvOps = ['AUTOFIN','UNIDAD'].map(k => finOt[k]?.ops||0);
  const dtotOps = dvOps.reduce((a,b)=>a+b,0);
  document.getElementById('donut1b-ops-pct').textContent = dtotOps?(dvOps[0]/dtotOps*100).toFixed(1)+'%':'—';
  const existD1bOps = Chart.getChart(document.getElementById('ch-donut1b-ops'));
  if (existD1bOps) existD1bOps.destroy();
  new Chart(document.getElementById('ch-donut1b-ops'),{
    type:'doughnut',
    data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:dvOps,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${ctx.raw} ops (${(ctx.raw/(dtotOps||1)*100).toFixed(1)}%)`}}},animation:{duration:500},responsive:true,maintainAspectRatio:false}
  });
  document.getElementById('donut1b-ops-leg').innerHTML = ['AUTOFIN','UNIDAD'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]}"></div>
    <div><div style="font-size:9px;color:#555">${l}</div>
    <span class="dleg-val" style="font-size:11px">${dvOps[i]}</span>
    <span style="font-size:10px;color:#888"> ${dtotOps?(dvOps[i]/dtotOps*100).toFixed(1):0}%</span></div></div>`).join('');

  // ── 4 Donuts adicionales ──
  // 1. Composición 200UF (ops)
  const mayor1b = det.filter(r=>r.mm==='>'), menor1b = det.filter(r=>r.mm==='<');
  const dvMM = [mayor1b.length, menor1b.length], dtMM = dvMM[0]+dvMM[1];
  document.getElementById('d1b-mm-pct').textContent = dtMM?(dvMM[0]/dtMM*100).toFixed(1)+'%':'—';
  ['ch-d1b-mm'].forEach(id => { const c=Chart.getChart(document.getElementById(id)); if(c) c.destroy(); });
  new Chart(document.getElementById('ch-d1b-mm'),{type:'doughnut',
    data:{labels:['MAYOR 200UF','MENOR 200UF'],datasets:[{data:dvMM,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.raw} ops (${(ctx.raw/(dtMM||1)*100).toFixed(1)}%)`}}},animation:{duration:300},responsive:true,maintainAspectRatio:false}});
  document.getElementById('d1b-mm-leg').innerHTML = [['MAYOR 200UF',mayor1b.length],[' MENOR 200UF',menor1b.length]].map(([l,v],i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]};width:8px;height:8px"></div>
    <div><div style="font-size:9px">${l}</div><span style="font-size:10px;font-weight:600">${v}</span>
    <span style="font-size:9px;color:#888"> ${dtMM?(v/dtMM*100).toFixed(1):0}%</span></div></div>`).join('');

  // 2. Plazo promedio por institución
  const plazos = ['AUTOFIN','UNIDAD'].map(k => finOt[k] ? Math.round(finOt[k].plazo_sum/finOt[k].ops)||0 : 0);
  const plazoTot = totOps ? Math.round(det.reduce((a,r)=>a+r.plazo,0)/totOps) : 0;
  document.getElementById('d1b-plazo-pct').textContent = plazoTot+'m';
  ['ch-d1b-plazo'].forEach(id => { const c=Chart.getChart(document.getElementById(id)); if(c) c.destroy(); });
  new Chart(document.getElementById('ch-d1b-plazo'),{type:'doughnut',
    data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:plazos,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${ctx.raw}m`}}},animation:{duration:300},responsive:true,maintainAspectRatio:false}});
  document.getElementById('d1b-plazo-leg').innerHTML = ['AUTOFIN','UNIDAD'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]};width:8px;height:8px"></div>
    <div><div style="font-size:9px">${l}</div><span style="font-size:10px;font-weight:600">${plazos[i]}m</span></div></div>`).join('');

  // 3. Monto promedio por institución
  const montos = ['AUTOFIN','UNIDAD'].map(k => finOt[k] && finOt[k].ops ? finOt[k].fin/finOt[k].ops : 0);
  const montoTotProm = totOps ? totFin/totOps : 0;
  document.getElementById('d1b-monto-pct').textContent = fM(montoTotProm);
  ['ch-d1b-monto'].forEach(id => { const c=Chart.getChart(document.getElementById(id)); if(c) c.destroy(); });
  new Chart(document.getElementById('ch-d1b-monto'),{type:'doughnut',
    data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:montos,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${fM(ctx.raw)}`}}},animation:{duration:300},responsive:true,maintainAspectRatio:false}});
  document.getElementById('d1b-monto-leg').innerHTML = ['AUTOFIN','UNIDAD'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]};width:8px;height:8px"></div>
    <div><div style="font-size:9px">${l}</div><span style="font-size:10px;font-weight:600">${fM(montos[i])}</span></div></div>`).join('');

  // 4. Ingreso AFA por institución
  const afas = ['AUTOFIN','UNIDAD'].map(k => finOt[k]?.rentab_afa||0);
  const afaTot = afas.reduce((a,b)=>a+b,0);
  document.getElementById('d1b-afa-pct').textContent = afaTot?(afas[0]/afaTot*100).toFixed(1)+'%':'—';
  ['ch-d1b-afa'].forEach(id => { const c=Chart.getChart(document.getElementById(id)); if(c) c.destroy(); });
  new Chart(document.getElementById('ch-d1b-afa'),{type:'doughnut',
    data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:afas,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${fM(ctx.raw)} (${(ctx.raw/(afaTot||1)*100).toFixed(1)}%)`}}},animation:{duration:300},responsive:true,maintainAspectRatio:false}});
  document.getElementById('d1b-afa-leg').innerHTML = ['AUTOFIN','UNIDAD'].map((l,i)=>`
    <div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]};width:8px;height:8px"></div>
    <div><div style="font-size:9px">${l}</div><span style="font-size:10px;font-weight:600">${fM(afas[i])}</span>
    <span style="font-size:9px;color:#888"> ${afaTot?(afas[i]/afaTot*100).toFixed(1):0}%</span></div></div>`).join('');

  // Mes anterior otorgados
  const jDet = D.jan.detalle_v2||[];
  const jTotOps = jDet.length, jTotFin = jDet.reduce((a,r)=>a+r.total_a_financiar,0);
  const jTotCD = jDet.reduce((a,r)=>a+r.com_dealer,0), jTotAFA = jDet.reduce((a,r)=>a+r.ing_autofacil,0);
  const jTotSeg = jDet.reduce((a,r)=>a+(r.com_seguros||0),0);
  const jTotPar = jDet.reduce((a,r)=>a+(r.com_par||0),0);
  const jTotArr = jDet.reduce((a,r)=>a+(r.arriendo_parque||0),0);
  const jTotNeto = jDet.reduce((a,r)=>a+(r.ing_neto||0),0);
  const jFinStyle = jTotFin < 30000000 ? 'color:#e53935;font-weight:700' : '';
  // Nombre del mes anterior en el título — mismo criterio de mes que la comisión ejecutivos
  const _refJ = document.getElementById('sel-hasta')?.value || document.getElementById('sel-desde')?.value || '';
  const [_jy, _jm] = _refJ ? _refJ.split('-').map(Number) : [new Date().getFullYear(), new Date().getMonth() + 1];
  const _dJ = new Date(_jy, _jm - 2, 1);
  const MES_NOM = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
  const headJ = document.getElementById('head-jan1b');
  if (headJ) headJ.textContent = `Resumen Mes Anterior — Otorgados (${MES_NOM[_dJ.getMonth()]})`;
  document.getElementById('t-jan1b').innerHTML = `
    <thead><tr><th>Métrica</th><th>Valor</th></tr></thead>
    <tbody>
      <tr><td>Operaciones Otorgadas</td><td>${jTotOps}</td></tr>
      <tr><td>Total Financiado</td><td style="${jFinStyle}">${fM(jTotFin)}</td></tr>
      <tr><td>Ing. x Colocaciones</td><td>${fM(jTotAFA)}</td></tr>
      <tr><td>Ing. x Seguros</td><td>${fM(jTotSeg)}</td></tr>
      <tr><td><b>Total Ingresos</b></td><td><b>${fM(jTotAFA + jTotSeg)}</b></td></tr>
      <tr><td>Com. Dealer</td><td>${fM(jTotCD)}</td></tr>
      <tr><td>Com. Parque</td><td>${fM(jTotPar)}</td></tr>
      <tr><td>Arriendo Parque</td><td id="jan1b-arr">${fM(jTotArr)}</td></tr>
      <tr><td>Comisión Ejecutivos</td><td id="jan1b-comej">…</td></tr>
      <tr><td><b>Ingreso Neto</b></td><td><b id="jan1b-neto">${fM(jTotNeto)}</b></td></tr>
    </tbody>`;
  // Comisión de ejecutivos del mes anterior — motor único del módulo Comisiones
  cargarComisionEjecutivosMesAnt();

  async function cargarComisionEjecutivosMesAnt() {
    const cell = document.getElementById('jan1b-comej');
    if (!cell) return;
    try {
      // Mes anterior al período seleccionado (mismo criterio que D.jan)
      const ref = document.getElementById('sel-hasta')?.value || document.getElementById('sel-desde')?.value || '';
      const [ry, rm] = ref ? ref.split('-').map(Number) : [new Date().getFullYear(), new Date().getMonth() + 1];
      const d = new Date(ry, rm - 2, 1); // -2: mes-1 en base 0
      const mesAnt = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const r = await fetch('/api/comisiones/calculo?mes=' + mesAnt, {
        headers: { Authorization: 'Bearer ' + (sessionStorage.getItem('token') || '') }
      }).then(x => x.json());
      if (!r.success) throw new Error(r.error);
      const tot = (r.data || []).reduce((a, e) => a + (parseFloat(e.incentivo_final) || 0), 0);
      cell.textContent = fM(tot);
      // Arriendo fijo del mes completo: los parques SIN colocación también suman
      const arrFijo = await getArrFijoMes();
      const arrFaltante = Math.max(0, (arrFijo || 0) - jTotArr);
      if (arrFijo > 0) {
        const arrCell = document.getElementById('jan1b-arr');
        if (arrCell) arrCell.textContent = fM(arrFijo);
      }
      // Ingreso Neto final = neto del motor − com. ejecutivos − arriendo de parques sin colocación
      const netoCell = document.getElementById('jan1b-neto');
      if (netoCell) netoCell.textContent = fM(jTotNeto - tot - arrFaltante);
    } catch (e) { cell.textContent = '—'; }
  }

  // ── Tabla "Mismos días faltantes mes anterior" ──
  // Calcular: hoy → días faltantes hasta fin de mes actual → aplicar al mes anterior
  // Usar el período seleccionado como referencia (no la fecha de hoy)
  const desde = document.getElementById('sel-desde')?.value || '';
  const hasta  = document.getElementById('sel-hasta')?.value  || '';
  // Si el período es un solo mes, usar ese mes como referencia; si es rango, usar el último mes
  const refMesStr = hasta || desde; // YYYY-MM
  const refAnio = refMesStr ? parseInt(refMesStr.split('-')[0]) : new Date().getFullYear();
  const refMes  = refMesStr ? parseInt(refMesStr.split('-')[1]) - 1 : new Date().getMonth(); // 0-based

  const hoy = new Date();
  const diaHoy = hoy.getDate();

  // Último día del mes de referencia
  const ultimoDiaMesActual = new Date(refAnio, refMes + 1, 0).getDate();
  // Si el mes de referencia es el mes actual, usar días faltantes reales; si es futuro/pasado usar el último día
  const esElMesActual = (refAnio === hoy.getFullYear() && refMes === hoy.getMonth());
  const diasFaltantes = esElMesActual ? (ultimoDiaMesActual - diaHoy) : 0;

  // Mes anterior al mes de referencia
  const mesAnt = refMes === 0 ? 11 : refMes - 1;
  const anioAnt = refMes === 0 ? refAnio - 1 : refAnio;
  const ultimoDiaMesAnt = new Date(anioAnt, mesAnt + 1, 0).getDate();
  const diaCorteAnt = diasFaltantes > 0 ? ultimoDiaMesAnt - diasFaltantes : ultimoDiaMesAnt;
  const mesAntKey = (anioAnt) + '-' + String(mesAnt + 1).padStart(2,'0');

  // Formatear fecha de corte para el título
  const mesesNombres = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const fechaCorteStr = diaCorteAnt + ' ' + mesesNombres[mesAnt] + ' ' + anioAnt;
  const tituloAnt = document.getElementById('titulo-mismos-dias');
  if (tituloAnt) tituloAnt.textContent =
    'Mismos días faltantes — ' + mesesNombres[mesAnt] + ' ' + anioAnt +
    ' (al ' + fechaCorteStr + ', ' + diasFaltantes + ' días antes del cierre)';

  // Filtrar RAW_DATA del mes anterior hasta el día de corte usando fecha_ot
  const todosAntMes = window.RAW_DATA.filter(r =>
    r.mes === mesAntKey && r.estado_eval === 'OTORGADO' &&
    (r.institucion === 'AUTOFIN' || r.institucion === 'UNIDAD DE CREDITO')
  );

  // Solo mostrar si los datos tienen fecha_ot exacta
  const tienenFechaOt = todosAntMes.some(r => r.fecha_ot && r.fecha_ot.length >= 10);
  if (!tienenFechaOt) {
    const tblAnt = document.getElementById('t-fin1b-ant');
    if (tblAnt) tblAnt.innerHTML = '<tr><td colspan="8" style="padding:12px;color:#888;text-align:center">Actualiza los datos para ver esta comparación</td></tr>';
    if (tituloAnt) tituloAnt.textContent = 'Mismos días faltantes — ' + mesesNombres[mesAnt] + ' ' + anioAnt + ' (pendiente actualización)';
    // NO retornar — continuar con DEALERS, EJECUTIVOS, etc.
  } else {
  const rawAnt = todosAntMes.filter(r => {
    if (!r.fecha_ot) return false;
    const diaOt = parseInt(r.fecha_ot.split('-')[2]);
    return diaOt <= diaCorteAnt;
  });

  // Agrupar por institución
  const finAnt = {};
  rawAnt.forEach(r => {
    const k = r.institucion === 'AUTOFIN' ? 'AUTOFIN' : 'UNIDAD';
    if (!finAnt[k]) finAnt[k] = {ops:0,saldo:0,fin:0,com_dealer:0,afa:0,com_seg:0};
    finAnt[k].ops++; finAnt[k].saldo += r.saldo_precio;
    finAnt[k].fin += r.monto_financiado; finAnt[k].com_dealer += r.com_dealer;
    finAnt[k].afa += r.rentab_afa; finAnt[k].com_seg += r.com_seguros;
  });
  const totAnt = {ops:0,saldo:0,fin:0,com_dealer:0,afa:0,com_seg:0};
  Object.values(finAnt).forEach(v => {
    totAnt.ops+=v.ops; totAnt.saldo+=v.saldo; totAnt.fin+=v.fin;
    totAnt.com_dealer+=v.com_dealer; totAnt.afa+=v.afa; totAnt.com_seg+=v.com_seg;
  });

  const finRowsAnt = ['AUTOFIN','UNIDAD'].map(k => {
    const v = finAnt[k]; if(!v) return '';
    return '<tr><td><strong>'+k+'</strong></td><td>'+v.ops+'</td><td>'+fM(v.fin)+'</td><td>'+fM(v.ops?v.fin/v.ops:0)+'</td><td>'+fM(v.saldo)+'</td><td>'+fM(v.com_dealer)+'</td><td>'+fM(v.afa)+'</td><td>'+fM(v.com_seg)+'</td></tr>';
  }).join('');

  const tblAnt = document.getElementById('t-fin1b-ant');
  if (tblAnt) tblAnt.innerHTML =
    '<thead><tr><th>Institución</th><th>Ops</th><th>Total Fin.</th><th>Prom. Fin</th><th>Saldo Precio</th><th>Com Dealer</th><th>Ing. x Col.</th><th>Ing. x Seguros</th></tr></thead>' +
    '<tbody>'+finRowsAnt+'</tbody>' +
    '<tfoot><tr><td>Total</td><td>'+totAnt.ops+'</td><td>'+fM(totAnt.fin)+'</td><td>'+fM(totAnt.ops?totAnt.fin/totAnt.ops:0)+'</td><td>'+fM(totAnt.saldo)+'</td><td>'+fM(totAnt.com_dealer)+'</td><td>'+fM(totAnt.afa)+'</td><td>'+fM(totAnt.com_seg)+'</td></tr></tfoot>';
  } // fin else tienenFechaOt

  // Dealers otorgados
  const ccsOt = {};
  det.forEach(r=>{ const k=r.ccs||''; if(!k) return;
    if(!ccsOt[k]) ccsOt[k]={ops:0,saldo:0,fin:0,cd:0,afa:0}; ccsOt[k].ops++; ccsOt[k].saldo+=r.saldo_precio; ccsOt[k].fin+=r.total_a_financiar; ccsOt[k].cd+=r.com_dealer; ccsOt[k].afa+=r.ing_autofacil; });
  const topCcs = Object.entries(ccsOt).sort((a,b)=>b[1].saldo-a[1].saldo);
  const ccsRows = topCcs.map(([n,v],i)=>`<tr><td><span class="rank">${i+1}.</span>${n.length>28?n.substring(0,28)+'…':n}</td><td>${v.ops}</td><td>${fM(v.fin)}</td><td>${fM(v.saldo/v.ops)}</td><td>${fM(v.saldo)}</td><td>${fM(v.cd)}</td><td>${fM(v.afa)}</td></tr>`).join('');
  const totCC = topCcs.reduce((a,[,v])=>({ops:a.ops+v.ops,fin:a.fin+v.fin,cd:a.cd+v.cd}),{ops:0,fin:0,cd:0});
  document.getElementById('t-ccs1b').innerHTML = `
    <thead><tr><th>Dealer</th><th>Q</th><th>Total Fin.</th><th>Prom.</th><th>Saldo Precio</th><th>Com Dealer</th><th>Ing. x Col.</th></tr></thead>
    <tbody>${ccsRows}</tbody>
    <tfoot><tr><td>Total</td><td>${totCC.ops}</td><td>${fM(totCC.fin)}</td><td>—</td><td>—</td><td>${fM(totCC.cd)}</td><td>—</td></tr></tfoot>`;

  // Ejecutivos otorgados
  // Ejecutivos — desde detalle_v2 (solo otorgados, con campo ejecutivo)
  const ejOt = {};
  det.forEach(r => {
    const k = r.ejecutivo || ''; if (!k) return;
    if (!ejOt[k]) ejOt[k] = {ops:0, saldo:0, fin:0, cd:0, afa:0};
    ejOt[k].ops++; ejOt[k].saldo += r.saldo_precio; ejOt[k].fin += r.total_a_financiar;
    ejOt[k].cd += r.com_dealer; ejOt[k].afa += r.ing_autofacil;
  });
  // Orden: Q otorgados y, a igual Q, por Total Financiado (no saldo precio)
  const topEj = Object.entries(ejOt).sort((a,b)=>b[1].ops-a[1].ops||b[1].fin-a[1].fin);
  const ejRows2 = topEj.map(([nombre,v],i)=>{
    const finStyle = v.fin < 40000000 ? 'color:#e53935;font-weight:700' : '';
    return `<tr>
    <td><span class="rank">${i+1}.</span><a class="ej-link" onclick="abrirDetalleEjecutivo('${nombre.replace(/'/g,"\\'")}','ot')">${nombre.length>24?nombre.substring(0,24)+'…':nombre}</a></td>
    <td>${v.ops}</td><td style="${finStyle}">${fM(v.fin)}</td><td>${fM(v.ops?v.fin/v.ops:0)}</td>
    <td>${fM(v.saldo)}</td><td>${fM(v.cd)}</td><td>${fM(v.afa)}</td>
  </tr>`;}).join('');
  const totEJ2 = topEj.reduce((a,[,v])=>({ops:a.ops+v.ops,fin:a.fin+v.fin,saldo:a.saldo+v.saldo,cd:a.cd+v.cd,afa:a.afa+v.afa}),{ops:0,fin:0,saldo:0,cd:0,afa:0});
  document.getElementById('t-ej1b').innerHTML = `
    <thead><tr><th>Ejecutivo</th><th>Q Otorgados</th><th>Total Fin.</th><th>Prom. Fin.</th><th>Saldo Precio</th><th>Com Dealer</th><th>Ing. x Col.</th></tr></thead>
    <tbody>${ejRows2}</tbody>
    <tfoot><tr><td>Total</td><td>${totEJ2.ops}</td><td>${fM(totEJ2.fin)}</td><td>${fM(totEJ2.ops?totEJ2.fin/totEJ2.ops:0)}</td><td>${fM(totEJ2.saldo)}</td><td>${fM(totEJ2.cd)}</td><td>${fM(totEJ2.afa)}</td></tr></tfoot>`;

  // Estado comercial (solo otorgados y relacionados)
  // Estado Otorgados — misma lógica: INGRESADAS=todos, APROBADAS=aprobado+otorgado
  const grpEst1b = {INGRESADAS:0,APROBADAS:0,OTORGADAS:0,PENDIENTE:0,RECHAZADAS:0,ANULADAS:0};
  const salEst1b = {INGRESADAS:0,APROBADAS:0,OTORGADAS:0,PENDIENTE:0,RECHAZADAS:0,ANULADAS:0};
  Object.entries(f.estados||{}).forEach(([k,v]) => {
    grpEst1b.INGRESADAS+=v.ops; salEst1b.INGRESADAS+=v.saldo;
    if (k==='APROBADO'||k==='OTORGADO'||k==='SOLICITUD EN EVALUACION'||k==='CURSADO'){grpEst1b.APROBADAS+=v.ops;salEst1b.APROBADAS+=v.saldo;}
    if (k==='OTORGADO'){grpEst1b.OTORGADAS+=v.ops;salEst1b.OTORGADAS+=v.saldo;}
    if (k==='PENDIENTE'){grpEst1b.PENDIENTE+=v.ops;salEst1b.PENDIENTE+=v.saldo;}
    if (k==='RECHAZADO'){grpEst1b.RECHAZADAS+=v.ops;salEst1b.RECHAZADAS+=v.saldo;}
    if (k==='ANULADO'){grpEst1b.ANULADAS+=v.ops;salEst1b.ANULADAS+=v.saldo;}
  });
  const totIng1b = grpEst1b.INGRESADAS||1;
  const estRowsOt = ['INGRESADAS','APROBADAS','OTORGADAS','PENDIENTE','RECHAZADAS','ANULADAS']
    .filter(k=>grpEst1b[k]>0).map(k=>{
      const pct=(grpEst1b[k]/totIng1b*100).toFixed(1);
      return '<tr><td>'+k+'</td><td>'+grpEst1b[k]+'</td><td>'+pct+'%</td><td>'+fM(salEst1b[k])+'</td></tr>';
    }).join('');
  document.getElementById('t-estado1b').innerHTML =
    '<thead><tr><th>Estado</th><th>N° op</th><th>%</th><th>Total Fin.</th></tr></thead>' +
    '<tbody>'+estRowsOt+'</tbody>' +
    '<tfoot><tr><td>INGRESADAS</td><td>'+grpEst1b.INGRESADAS+'</td><td>100%</td><td>'+fM(salEst1b.INGRESADAS)+'</td></tr></tfoot>';

  // Chart evolución otorgados
  const last6 = (window.DASH.tendencia||[]).slice(-6);
  new Chart(document.getElementById('ch-evol1b'),{
    type:'bar',
    data:{labels:last6.map(t=>t.mes),datasets:[
      {label:'Otorgados',data:last6.map(t=>t.otorgados),backgroundColor:C.green+'bb',borderRadius:4}
    ]},
    options:{...chOpts(),plugins:{...chOpts().plugins,legend:{display:false}}}
  });
}

// ======== LOAD DATA ========
// se inicializa abajo
// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 1747
// ──────────────────────────────────────────────────────────────
// ======== INLINE DATA FALLBACK (por si no hay servidor) ========
window.DASH_INLINE = {
    // CLAUDE: Los datos reales fueron removidos por tamaño.
    // Asume que aquí viene la estructura agrupada del dashboard.
};
// window.DASH debe existir ANTES de aplicarFiltro (que hace window.DASH.feb = ...).
// Sin esto, en el camino exitoso aplicarFiltro lanzaba "Cannot set 'feb' of undefined"
// y caía al catch, dejando el dashboard vacío (había que apretar "Aplicar").
window.DASH = window.DASH || { feb: {}, jan: {} };
// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 1754
// ──────────────────────────────────────────────────────────────
(function() {
  // Solo ejecutar si DASH_INLINE tiene datos embebidos (feb/jan)
  if (!window.DASH_INLINE || !window.DASH_INLINE.feb || !window.DASH_INLINE.jan) return;
  const opMap = {};
  (window.RAW_DATA||[]).forEach(r => { opMap[r.op] = r; });
  // Función para derivar institución desde producto (igual que Python)
  const derInst = (r) => {
    const fin = (r.financiera||'').toUpperCase();
    const prod = (r.producto||r.PRODUCTO||'').toUpperCase();
    if (fin==='AUTOFIN' || prod.startsWith('AUTOFIN') || prod.startsWith('AUTOFACIL')) return 'AUTOFIN';
    if (fin.includes('UNIDAD') || prod.startsWith('UNIDAD')) return 'UNIDAD';
    if (r.institucion === 'AUTOFIN' || r.institucion === 'UNIDAD DE CREDITO')
      return r.institucion === 'AUTOFIN' ? 'AUTOFIN' : 'UNIDAD';
    return null; // NO APLICA — no incluir en rentabilidades
  };
  (window.DASH_INLINE.feb.detalle_v2||[]).forEach(d => {
    const r = opMap[d.op];
    if (r) {
      d.financiera = derInst(r) || 'AUTOFIN';
      d.ejecutivo  = r.ejecutivo || '';
    }
  });
  (window.DASH_INLINE.jan.detalle_v2||[]).forEach(d => {
    const r = opMap[d.op];
    if (r) {
      d.financiera = derInst(r) || 'AUTOFIN';
      d.ejecutivo  = r.ejecutivo || '';
    }
  });
})();
// ── Cargar datos frescos desde el JSON generado automáticamente ──
async function cargarDatos() {
  const loadingEl = document.getElementById('loading-overlay');
  try {
    const r = await fetch('/api/dashboard/datos', {
      headers: { 'Authorization': 'Bearer ' + (sessionStorage.getItem('token') || '') }
    });
    if (!r.ok) throw new Error('No se pudo cargar el JSON');
    const datos = await r.json();

    // Enriquecer detalle_v2 con financiera y ejecutivo
    const opMap = {};
    (datos.raw||[]).forEach(r => { opMap[r.op] = r; });

    // Actualizar RAW_DATA global
    window.RAW_DATA = (datos.raw || []).map(function(r) {
      // Alias: el API devuelve fecha_otorgado, el código interno usa fecha_ot
      if (!r.fecha_ot && r.fecha_otorgado) r.fecha_ot = r.fecha_otorgado;
      // Derivar dia_mes y dia_semana desde fecha_estado (FECHA EV, col J) para todos
      if (!r.dia_mes) {
        const f = r.fecha_estado && r.fecha_estado !== 'NO APLICA' ? r.fecha_estado : null;
        if (f && f.length >= 10) {
          r.dia_mes = parseInt(f.split('-')[2]);
          const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
          r.dia_semana = dias[new Date(f).getDay()];
        }
      }
      return r;
    });

    // Recalcular DASH desde raw para el período por defecto (último mes completo)
    const meses = [...new Set(window.RAW_DATA.map(r=>r.mes))].sort();
    const ultimoMes = meses[meses.length - 1];

    // Usar datos embebidos como base y actualizar tendencia y ej_perf
    window.DASH_INLINE = window.DASH_INLINE || {};

    // Actualizar tendencia con datos frescos (también en window.DASH: es el objeto
    // que leen buildV2/buildV2pl/buildV3 — sin esto D.tendencia queda undefined y
    // el render muere antes de pintar el detalle)
    window.DASH_INLINE.tendencia = datos.tendencia || [];
    window.DASH.tendencia = datos.tendencia || [];

    // Actualizar EJ_PERF con datos frescos
    if (datos.ej_perf) {
      Object.assign(EJ_PERF, datos.ej_perf);
    }

    // Actualizar badge de última actualización
    if (datos.generado_en) {
      // Convertir generado_en a hora de Santiago (UTC-3)
      // Soporta tanto ISO "2026-05-25T12:00:00.000Z" como "2026-05-25 12:00:00"
      const _gen = datos.generado_en;
      const fechaUTC = new Date(_gen.endsWith('Z') ? _gen : _gen.replace(' ', 'T') + 'Z');
      const fechaSCL = fechaUTC.toLocaleString('es-CL', {
        timeZone: 'America/Santiago',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      document.getElementById('ultima-act').textContent = '🔄 ' + fechaSCL;
      // Guardar fecha del JSON para usarla en el comparativo (formato: "7 May 2026")
      const _mnJ = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
      const _pJ  = fechaSCL.split(',')[0].split('-'); // ["07","05","2026"]
      window._infoFechaJSON = parseInt(_pJ[0]) + ' ' + _mnJ[parseInt(_pJ[1])-1] + ' ' + _pJ[2];
    }

    // Inicializar selects con meses reales
    const selDesde = document.getElementById('sel-desde');
    const selHasta = document.getElementById('sel-hasta');
    if (selDesde && selHasta) {
      selDesde.innerHTML = '';
      selHasta.innerHTML = '';
      meses.forEach(m => {
        const lbl = EJ_PERF.meses_labels?.[m] || m;
        selDesde.innerHTML += `<option value="${m}">${lbl}</option>`;
        selHasta.innerHTML += `<option value="${m}">${lbl}</option>`;
      });
      selDesde.value = ultimoMes;
      selHasta.value = ultimoMes;
    }

    // Aplicar filtro con el último mes disponible en los datos
    const mesKeys = datos.ej_perf?.meses || [];
    const ultimoMesKey = mesKeys[mesKeys.length - 1];
    if (ultimoMesKey) {
      const selD = document.getElementById('sel-desde');
      const selH = document.getElementById('sel-hasta');
      if (selD) selD.value = ultimoMesKey;
      if (selH) selH.value = ultimoMesKey;
    }
    window.aplicarFiltro();
    window._v2 = false; // forzar rebuild de v2 con datos frescos

    // Actualizar badge de período
    document.querySelectorAll('#badge-periodo').forEach(el => {
      el.textContent = '📅 ' + (EJ_PERF.meses_labels?.[ultimoMes] || ultimoMes);
    });
    document.getElementById('periodo-label').textContent = EJ_PERF.meses_labels?.[ultimoMes] || ultimoMes;

  } catch(e) {
    console.warn('No se pudo cargar datos del API:', e.message);
    window.DASH = window.DASH_INLINE;
    buildV1(); buildV1b();
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
    // Render inicial garantizado: si hay datos y los selects tienen período, aplicar
    // el filtro solo — así no hay que apretar "Aplicar" al entrar (aunque algo haya
    // fallado arriba, RAW_DATA ya quedó cargado y esto lo pinta).
    try {
      const sd = document.getElementById('sel-desde');
      const sh = document.getElementById('sel-hasta');
      if (window.RAW_DATA && window.RAW_DATA.length && sd && sd.value && sh && sh.value) {
        window.aplicarFiltro();
      }
    } catch (e2) { console.warn('auto-aplicar inicial:', e2.message); }
  }
}

// Mostrar spinner mientras carga
document.body.insertAdjacentHTML('afterbegin', `
  <div id="loading-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:#f0f2f5;z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px">
    <div style="width:40px;height:40px;border:4px solid #dce3ed;border-top-color:#1a3a6a;border-radius:50%;animation:spin 0.8s linear infinite"></div>
    <div id="loading-msg" style="color:#1a3a6a;font-family:'Roboto',sans-serif;font-size:13px;font-weight:600">Cargando datos actualizados...</div>
  </div>
  
`);

cargarDatos();
// RAW_DATA se carga dinámicamente desde la API (GET /api/dashboard/datos)
window.RAW_DATA = [];

// ======== FILTRADO DINÁMICO POR FECHAS ========
(function() {
  // Generar meses_labels dinámicamente hasta 24 meses desde 2025-01
  const meses_labels = {};
  const _mN = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  for (let y = 2024; y <= 2027; y++) {
    for (let m = 1; m <= 12; m++) {
      const key = y+'-'+String(m).padStart(2,'0');
      meses_labels[key] = _mN[m-1]+' '+y;
    }
  }
  const meses_orden = Object.keys(meses_labels);

  // Poblar selects
  function initSelects() {
    // Los selects se pueblan en cargarDatos() con los meses reales del JSON
  }

  // Calcular resumen de un mes/rango desde RAW_DATA
  function calcResumen(rows) {
    // Operaciones aprobadas: APROBADO + OTORGADO (Cursado en Trinidad)
    const aprobados = rows.filter(r => ['APROBADO','OTORGADO'].includes(r.estado_eval));
    // mayor_menor ya viene calculado correctamente desde el API (UF de fecha_otorgado)
    const resolveInst = r => {
      if (r.institucion === 'AUTOFIN' || r.institucion === 'UNIDAD DE CREDITO') return r.institucion;
      const f = (r.financiera||'').toUpperCase();
      const p = (r.producto||'').toUpperCase();
      if (f.includes('UNIDAD') || p.startsWith('UNIDAD')) return 'UNIDAD DE CREDITO';
      return 'AUTOFIN';
    };
    const con_fin = aprobados.map(r => ({ ...r, institucion: resolveInst(r) }));
    const fin = {};
    con_fin.forEach(r => {
      const k = r.institucion === 'AUTOFIN' ? 'AUTOFIN' : 'UNIDAD';
      if (!fin[k]) fin[k] = {ops:0,saldo:0,prom_fin:0,saldo_precio:0,com_dealer:0,rentab_afa:0,com_seguros:0,plazo_sum:0,cnt_plazo:0};
      fin[k].ops++; fin[k].saldo += r.saldo_precio; fin[k].prom_fin += r.monto_financiado;
      fin[k].saldo_precio += r.saldo_precio; fin[k].com_dealer += r.com_dealer;
      fin[k].rentab_afa += r.rentab_afa; fin[k].com_seguros += r.com_seguros;
      if (r.plazo > 0) { fin[k].plazo_sum += r.plazo; fin[k].cnt_plazo++; }
    });
    Object.keys(fin).forEach(k => {
      fin[k].prom_plazo = fin[k].cnt_plazo ? +(fin[k].plazo_sum/fin[k].cnt_plazo).toFixed(1) : 0;
      fin[k].prom_op = fin[k].ops ? Math.round(fin[k].saldo/fin[k].ops) : 0;
    });

    const ccs = {}, ej = {}, estados = {}, motivos = {};
    // ccs y ejecutivos usan aprobados (no rechazados/anulados) — mismo universo que KPIs
    aprobados.forEach(r => {
      if (r.automotora) {
        if (!ccs[r.automotora]) ccs[r.automotora] = {ops:0,saldo:0,prom_fin:0,saldo_precio:0,com_dealer:0,rentab_afa:0,prom_plazo:0};
        ccs[r.automotora].ops++; ccs[r.automotora].saldo += r.saldo_precio;
        ccs[r.automotora].prom_fin += r.monto_financiado; ccs[r.automotora].com_dealer += r.com_dealer;
        ccs[r.automotora].rentab_afa += r.rentab_afa;
      }
      if (r.ejecutivo) {
        if (!ej[r.ejecutivo]) ej[r.ejecutivo] = {ops:0,saldo:0,prom_fin:0,saldo_precio:0,com_dealer:0,rentab_afa:0,plazo_sum:0,cnt_plazo:0,prom_plazo:0};
        ej[r.ejecutivo].ops++; ej[r.ejecutivo].saldo += r.saldo_precio;
        ej[r.ejecutivo].prom_fin += r.monto_financiado; ej[r.ejecutivo].com_dealer += r.com_dealer;
        ej[r.ejecutivo].rentab_afa += r.rentab_afa;
        if (r.plazo > 0) { ej[r.ejecutivo].plazo_sum += r.plazo; ej[r.ejecutivo].cnt_plazo++; }
      }
    });
    // estados y motivos usan todos los registros del período (para el panel de estado comercial)
    rows.forEach(r => {
      if (!estados[r.estado_eval]) estados[r.estado_eval] = {ops:0,pct:0,saldo:0};
      estados[r.estado_eval].ops++; estados[r.estado_eval].saldo += r.saldo_precio;
      if (!motivos[r.estado_credito]) motivos[r.estado_credito] = {ops:0,pct:0,saldo:0};
      motivos[r.estado_credito].ops++; motivos[r.estado_credito].saldo += r.saldo_precio;
    });

    const total_ops = rows.length;
    Object.keys(estados).forEach(k => estados[k].pct = total_ops ? +((estados[k].ops/total_ops)*100).toFixed(1) : 0);
    Object.keys(motivos).forEach(k => motivos[k].pct = total_ops ? +((motivos[k].ops/total_ops)*100).toFixed(1) : 0);

    const donut = {
      AUTOFIN: fin.AUTOFIN?.saldo||0,
      UNIDAD: fin.UNIDAD?.saldo||0
    };

    const otorgados = con_fin.filter(r => r.estado_eval === 'OTORGADO');
    const detalle_v2 = otorgados.sort((a,b) => b.saldo_precio - a.saldo_precio).map(r => {
      const fin2 = r.monto_financiado || 1;
      const pct_a = +(r.rentab_afa/fin2*100).toFixed(1);
      const pct_d = +(r.com_dealer/fin2*100).toFixed(1);
      const tcb = r.com_dealer + r.com_seguros + r.com_parque;
      const pct_t = +(tcb/fin2*100).toFixed(1);
      const ib = r.rentab_afa + r.com_seguros;
      const pct_b = +(ib/fin2*100).toFixed(1);
      return {
        op: r.op, mm: r.mayor_menor.includes('MAYOR') ? '>' : '<',
        ccs: r.automotora, ejecutivo: r.ejecutivo || '',
        financiera: (() => {
          if (r.institucion === 'AUTOFIN' || r.financiera === 'AUTOFIN') return 'AUTOFIN';
          if (r.institucion === 'UNIDAD DE CREDITO' || r.financiera === 'UNIDAD DE CREDITO') return 'UNIDAD';
          const prod = (r.producto||'').toUpperCase();
          if (prod.startsWith('AUTOFIN') || prod.startsWith('AUTOFACIL')) return 'AUTOFIN';
          if (prod.startsWith('UNIDAD')) return 'UNIDAD';
          return 'AUTOFIN';
        })(),
        saldo_precio: r.saldo_precio, total_a_financiar: r.monto_financiado,
        plazo: r.plazo, tasa_cli: r.tasa_cli||0, ing_autofacil: r.rentab_afa, pct_a,
        com_dealer: r.com_dealer, pct_d, com_par: r.com_parque, pct_p: 0,
        total_com_broke: tcb, pct_t, com_seguros: r.com_seguros,
        ingreso_bruto: ib, pct_b,
        ing_neto: r.ingreso_neto_total || 0, arriendo_parque: r.arriendo_parque || 0
      };
    });

    return {
      total_ops,
      total_saldo: rows.reduce((a,r)=>a+r.saldo_precio,0),
      total_com_dealer: con_fin.reduce((a,r)=>a+r.com_dealer,0),
      total_rentab_afa: con_fin.reduce((a,r)=>a+r.rentab_afa,0),
      total_com_seguros: con_fin.reduce((a,r)=>a+r.com_seguros,0),
      prom_fin: con_fin.reduce((a,r)=>a+r.monto_financiado,0),
      ot_ops: otorgados.length,
      ot_saldo: otorgados.reduce((a,r)=>a+r.saldo_precio,0),
      financieras: fin,
      ccs: Object.entries(ccs).sort((a,b)=>b[1].saldo-a[1].saldo).map(([nombre,v])=>({nombre,...v})),
      ejecutivos: Object.entries(ej).sort((a,b)=>b[1].ops-a[1].ops||b[1].prom_fin-a[1].prom_fin).map(([nombre,v])=>({nombre,...v,prom_plazo:v.cnt_plazo?+(v.plazo_sum/v.cnt_plazo).toFixed(1):0})),
      estados, motivos, donut, detalle_v2
    };
  }

  window.aplicarFiltro = function() {
    const desde = document.getElementById('sel-desde').value;
    const hasta = document.getElementById('sel-hasta').value;
    if (desde > hasta) { alert('La fecha de inicio debe ser anterior o igual a la fecha fin'); return; }

    // Mes anterior al rango (para comparativo)
    const idx_desde = Object.keys(meses_labels).indexOf(desde);
    const mes_ant_key = idx_desde > 0 ? Object.keys(meses_labels)[idx_desde-1] : null;

    // Filtrar registros
    const rows_periodo = window.RAW_DATA.filter(r => r.mes >= desde && r.mes <= hasta);
    const rows_ant = mes_ant_key ? window.RAW_DATA.filter(r => r.mes === mes_ant_key) : [];

    // Calcular resúmenes
    const feb_new = calcResumen(rows_periodo);
    const jan_new = rows_ant.length ? calcResumen(rows_ant) : window.DASH.jan;

    // Actualizar DASH
    window.DASH.feb = feb_new;
    window.DASH.jan = jan_new;

    // Label del período
    const lbl = desde === hasta
      ? meses_labels[desde]
      : `${meses_labels[desde]} – ${meses_labels[hasta]}`;
    document.querySelectorAll('#badge-periodo').forEach(el => el.textContent = '📅 ' + lbl);
    document.getElementById('periodo-label').textContent = lbl;

    // Rebuild vistas activas
    destroyCharts();
    window._v2 = false; window._v3 = false; window._v4 = false; window._v1b = false; window._v5 = false; window._v6 = false; window._v6_filtro = null; window._v7 = false; window._v8 = false; window._v2pl = false;
    buildV1();
    if (document.getElementById('v1b').classList.contains('active')) { buildV1b(); window._v1b=true; }
    if (document.getElementById('v2').classList.contains('active')) { buildV2(); window._v2 = true; }
    if (document.getElementById('v2pl') && document.getElementById('v2pl').classList.contains('active')) { buildV2pl(); window._v2pl = true; }
    if (document.getElementById('v3').classList.contains('active')) { buildV3(); window._v3 = true; }
    if (document.getElementById('v4').classList.contains('active')) { buildV4(); window._v4 = true; }
    if (document.getElementById('v6') && document.getElementById('v6').classList.contains('active')) { buildV6(); window._v6 = true; }
    if (document.getElementById('v7') && document.getElementById('v7').classList.contains('active')) { buildV7(); window._v7 = true; }
    if (document.getElementById('v8') && document.getElementById('v8').classList.contains('active')) { buildV8(); window._v8 = true; }
  };

  window.destroyCharts = destroyCharts;   // exponer para showV (nivel global)
  function destroyCharts() {
    ['ch-donut','ch-donut-ops','ch-d1-mm','ch-d1-plazo','ch-d1-monto','ch-d1-afa','ch-evol','ch-donut1b','ch-donut1b-ops','ch-evol1b','ch-d1b-mm','ch-d1b-plazo','ch-d1b-monto','ch-d1b-afa','ch-donut2','ch-donut3','ch-mm','ch-com','ch-qmes','ch-t1','ch-t2','ch-t3','ch-t4','ch-donut2-pl','ch-donut3-pl','ch-mm-pl','ch-com-pl','ch-qmes-pl'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { const ex = Chart.getChart(el); if (ex) ex.destroy(); }
    });
  }

  // Inicializar al cargar
  document.addEventListener('DOMContentLoaded', function() {
    initSelects();
    // Aplicar filtro para poblar DASH.feb.detalle_v2 desde el inicio
    setTimeout(() => {
      // Asegurarse que los selects tienen valor antes de aplicar
      const sd = document.getElementById('sel-desde');
      const sh = document.getElementById('sel-hasta');
      if (sd && sd.value && sh && sh.value) {
        window.aplicarFiltro();
      }
    }, 300);
  });
})();


// ======== VISTA 4: SEGUIMIENTO OTORGADOS ========
function buildV4() {
  const D = window.DASH;
  const f = D.feb;
  const j = D.jan;
  const af = f.financieras.AUTOFIN || {};
  const un = f.financieras.UNIDAD  || {};
  const totOps   = (af.ops||0)+(un.ops||0);
  const totSaldo = (af.saldo||0)+(un.saldo||0);
  const totCD    = (af.com_dealer||0)+(un.com_dealer||0);
  const totAFA   = (af.rentab_afa||0)+(un.rentab_afa||0);
  const totSeg   = (af.com_seguros||0)+(un.com_seguros||0);
  const promFin  = totOps ? totSaldo/totOps : 0;

  document.getElementById('kpi4').innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Total a Financiar</div><div class="kpi-val big">${fM(totSaldo)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Operaciones Aprobadas</div><div class="kpi-val big">${totOps}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Com. Dealer</div><div class="kpi-val big">${fM(totCD)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. x Colocaciones</div><div class="kpi-val big">${fM(totAFA)}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Ing. x Seguros</div><div class="kpi-val big">${fM(totSeg)}</div></div>
    <div class="kpi-box"><div class="kpi-label">Prom. por Op.</div><div class="kpi-val big">${fM(promFin)}</div></div>`;

  const finRows4 = ['AUTOFIN','UNIDAD'].map(k => {
    const v = f.financieras[k];
    if (!v || !v.ops) return '';
    return `<tr><td>${k}</td><td>${v.ops}</td><td>${fM(v.saldo)}</td><td>${fM(v.ops?v.saldo/v.ops:0)}</td><td>${fM(v.saldo)}</td><td>${fM(v.com_dealer)}</td><td>${fM(v.rentab_afa)}</td><td>${fM(v.com_seguros)}</td></tr>`;
  }).join('');
  document.getElementById('t-fin4').innerHTML = `
    <thead><tr><th>Institución</th><th>Ops</th><th>Total Fin.</th><th>Prom. Fin</th><th>Saldo Precio</th><th>Com Dealer</th><th>Ing. x Colocaciones</th><th>Ing. x Seguros</th></tr></thead>
    <tbody>${finRows4}</tbody>
    <tfoot><tr><td>Total</td><td>${totOps}</td><td>${fM(totSaldo)}</td><td>${fM(promFin)}</td><td>${fM(totSaldo)}</td><td>${fM(totCD)}</td><td>${fM(totAFA)}</td><td>${fM(totSeg)}</td></tr></tfoot>`;

  const dv4=[af.saldo||0,un.saldo||0]; const dt4=dv4[0]+dv4[1];
  document.getElementById('donut4-pct').textContent = dt4?(dv4[0]/dt4*100).toFixed(1)+'%':'—';
  const ex4=Chart.getChart(document.getElementById('ch-donut4')); if(ex4) ex4.destroy();
  new Chart(document.getElementById('ch-donut4'),{type:'doughnut',data:{labels:['AUTOFIN','UNIDAD'],datasets:[{data:dv4,backgroundColor:[C.blue,'#ff7043'],borderWidth:2,borderColor:'#fff'}]},options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+fM(ctx.raw)+' ('+(dt4?(ctx.raw/dt4*100).toFixed(1):0)+'%)'}}},animation:{duration:500},responsive:true,maintainAspectRatio:false}});
  document.getElementById('donut4-leg').innerHTML=['AUTOFIN','UNIDAD'].map((l,i)=>`<div class="dleg"><div class="dleg-dot" style="background:${[C.blue,'#ff7043'][i]}"></div><span class="dleg-name">${l}</span><span class="dleg-val">${fM(dv4[i])}</span><span class="dleg-pct"> ${dt4?(dv4[i]/dt4*100).toFixed(1):0}%</span></div>`).join('');

  const jaf4=j.financieras?.AUTOFIN||{}, jun4=j.financieras?.UNIDAD||{};
  const jTot4=(jaf4.ops||0)+(jun4.ops||0);
  document.getElementById('t-jan4').innerHTML=`<thead><tr><th>Institución</th><th>Ops</th><th>%</th><th>Total Fin.</th></tr></thead><tbody><tr><td>AUTOFIN</td><td>${jaf4.ops||0}</td><td>${jTot4?((jaf4.ops||0)/jTot4*100).toFixed(1):0}%</td><td>${fM(jaf4.saldo||0)}</td></tr><tr><td>UNIDAD</td><td>${jun4.ops||0}</td><td>${jTot4?((jun4.ops||0)/jTot4*100).toFixed(1):0}%</td><td>${fM(jun4.saldo||0)}</td></tr></tbody><tfoot><tr><td>Total</td><td>${jTot4}</td><td>100%</td><td>${fM((jaf4.saldo||0)+(jun4.saldo||0))}</td></tr></tfoot>`;

  const det=window.DASH.detalle_v2, ccs4={};
  det.forEach(r=>{if(!ccs4[r.ccs])ccs4[r.ccs]={ops:0,saldo:0,com_dealer:0,rentab_afa:0};ccs4[r.ccs].ops++;ccs4[r.ccs].saldo+=r.saldo_precio;ccs4[r.ccs].com_dealer+=r.com_dealer;ccs4[r.ccs].rentab_afa+=r.ing_autofacil;});
  const topCcs4=Object.entries(ccs4).sort((a,b)=>b[1].saldo-a[1].saldo);
  const totCcs4=topCcs4.reduce((a,[,v])=>({ops:a.ops+v.ops,saldo:a.saldo+v.saldo,cd:a.cd+v.com_dealer}),{ops:0,saldo:0,cd:0});
  document.getElementById('t-ccs4').innerHTML=`<thead><tr><th>Dealer</th><th>Q</th><th>Total Fin.</th><th>Prom.</th><th>Com Dealer</th><th>Ing. x Col.</th></tr></thead><tbody>${topCcs4.map(([nombre,v],i)=>`<tr><td><span class="rank">${i+1}.</span>${nombre.length>28?nombre.substring(0,28)+'…':nombre}</td><td>${v.ops}</td><td>${fM(v.saldo)}</td><td>${fM(v.saldo/v.ops)}</td><td>${fM(v.com_dealer)}</td><td>${fM(v.rentab_afa)}</td></tr>`).join('')}</tbody><tfoot><tr><td>Total</td><td>${totCcs4.ops}</td><td>${fM(totCcs4.saldo)}</td><td>—</td><td>${fM(totCcs4.cd)}</td><td>—</td></tr></tfoot>`;

  const desde=document.getElementById('sel-desde').value, hasta=document.getElementById('sel-hasta').value;
  const rawOt=window.RAW_DATA?window.RAW_DATA.filter(r=>r.mes>=desde&&r.mes<=hasta&&r.estado_eval==='OTORGADO'&&(r.financiera==='AUTOFIN'||r.financiera==='UNIDAD DE CREDITO')):[];
  const ej4={};
  rawOt.forEach(r=>{const k=r.ejecutivo||'S/E';if(!ej4[k])ej4[k]={ops:0,saldo:0,com_dealer:0,rentab_afa:0,plazo_sum:0,cnt:0};ej4[k].ops++;ej4[k].saldo+=r.saldo_precio;ej4[k].com_dealer+=r.com_dealer;ej4[k].rentab_afa+=r.rentab_afa;if(r.plazo>0){ej4[k].plazo_sum+=r.plazo;ej4[k].cnt++;}});
  const topEj4=Object.entries(ej4).sort((a,b)=>b[1].saldo-a[1].saldo);
  const totEj4=topEj4.reduce((a,[,v])=>({ops:a.ops+v.ops,saldo:a.saldo+v.saldo,cd:a.cd+v.com_dealer}),{ops:0,saldo:0,cd:0});
  document.getElementById('t-ej4').innerHTML=`<thead><tr><th>Ejecutivo</th><th>Q</th><th>Total Fin.</th><th>Prom.</th><th>Plazo</th><th>Com Dealer</th><th>Ing. x Col.</th></tr></thead><tbody>${topEj4.map(([nombre,v],i)=>`<tr><td><span class="rank">${i+1}.</span>${nombre.length>22?nombre.substring(0,22)+'…':nombre}</td><td>${v.ops}</td><td>${fM(v.saldo)}</td><td>${fM(v.saldo/v.ops)}</td><td>${v.cnt?Math.round(v.plazo_sum/v.cnt)+'m':'—'}</td><td>${fM(v.com_dealer)}</td><td>${fM(v.rentab_afa)}</td></tr>`).join('')}</tbody><tfoot><tr><td>Total</td><td>${totEj4.ops}</td><td>${fM(totEj4.saldo)}</td><td>—</td><td>—</td><td>${fM(totEj4.cd)}</td><td>—</td></tr></tfoot>`;

  document.getElementById('t-estado4').innerHTML=`<thead><tr><th>Estado</th><th>N° op</th><th>%</th><th>Total Fin.</th></tr></thead><tbody><tr><td>AUTOFIN</td><td>${af.ops||0}</td><td>${totOps?((af.ops||0)/totOps*100).toFixed(1):0}%</td><td>${fM(af.saldo||0)}</td></tr><tr><td>UNIDAD</td><td>${un.ops||0}</td><td>${totOps?((un.ops||0)/totOps*100).toFixed(1):0}%</td><td>${fM(un.saldo||0)}</td></tr></tbody><tfoot><tr><td>Total</td><td>${totOps}</td><td>100%</td><td>${fM(totSaldo)}</td></tr></tfoot>`;

  const exEv4=Chart.getChart(document.getElementById('ch-evol4')); if(exEv4) exEv4.destroy();
  const last6=(window.DASH.tendencia||[]).slice(-6);
  new Chart(document.getElementById('ch-evol4'),{type:'bar',data:{labels:last6.map(t=>t.mes),datasets:[{label:'Otorgados',data:last6.map(t=>t.otorgados),backgroundColor:C.green+'bb',borderRadius:4},{label:'Com.Dealer M$',data:last6.map(t=>+(t.com_dealer/1e6).toFixed(1)),backgroundColor:C.blue+'66',borderRadius:4,yAxisID:'y2'}]},options:{...chOpts(),plugins:{...chOpts().plugins,legend:{display:true,labels:{color:'#555',font:{size:9},boxWidth:10}}},scales:{x:{grid:{color:'#f0f2f5'},ticks:{color:'#888',font:{size:9}}},y:{grid:{color:'#f0f2f5'},ticks:{color:'#888',font:{size:9}}},y2:{position:'right',grid:{display:false},ticks:{color:'#888',font:{size:9},callback:v=>v+'M'}}}}});
}
// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 2203
// ──────────────────────────────────────────────────────────────
// ======== VISTA 5: DESEMPEÑO EJECUTIVOS ========
const EJ_PERF = {"meses": ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"], "meses_labels": {"2025-01": "Ene 25", "2025-02": "Feb 25", "2025-03": "Mar 25", "2025-04": "Abr 25", "2025-05": "May 25", "2025-06": "Jun 25", "2025-07": "Jul 25", "2025-08": "Ago 25", "2025-09": "Sep 25", "2025-10": "Oct 25", "2025-11": "Nov 25", "2025-12": "Dic 25", "2026-01": "Ene 26", "2026-02": "Feb 26", "2026-03": "Mar 26"}, "ejecutivos": [{"nombre": "VARGAS VIELMA ALVARO BRIAN", "nombre_corto": "Alvaro Brian", "meses": {"2025-01": {"ing": 77, "apro": 50, "ot": 8, "rec": 26, "tc": 16.0, "ta": 64.9, "prom": 5.07}, "2025-02": {"ing": 90, "apro": 48, "ot": 9, "rec": 42, "tc": 18.8, "ta": 53.3, "prom": 4.52}, "2025-03": {"ing": 96, "apro": 53, "ot": 14, "rec": 43, "tc": 26.4, "ta": 55.2, "prom": 4.81}, "2025-04": {"ing": 159, "apro": 75, "ot": 10, "rec": 84, "tc": 13.3, "ta": 47.2, "prom": 5.32}, "2025-05": {"ing": 178, "apro": 80, "ot": 8, "rec": 98, "tc": 10.0, "ta": 44.9, "prom": 6.03}, "2025-06": {"ing": 128, "apro": 69, "ot": 13, "rec": 59, "tc": 18.8, "ta": 53.9, "prom": 6.86}, "2025-07": {"ing": 86, "apro": 50, "ot": 11, "rec": 35, "tc": 22.0, "ta": 58.1, "prom": 6.88}, "2025-08": {"ing": 87, "apro": 47, "ot": 14, "rec": 40, "tc": 29.8, "ta": 54.0, "prom": 6.19}, "2025-09": {"ing": 96, "apro": 59, "ot": 16, "rec": 37, "tc": 27.1, "ta": 61.5, "prom": 7.8}, "2025-10": {"ing": 103, "apro": 73, "ot": 13, "rec": 30, "tc": 17.8, "ta": 70.9, "prom": 3.76}, "2025-11": {"ing": 105, "apro": 65, "ot": 17, "rec": 40, "tc": 26.2, "ta": 61.9, "prom": 8.43}, "2025-12": {"ing": 93, "apro": 63, "ot": 10, "rec": 30, "tc": 15.9, "ta": 67.7, "prom": 7.41}, "2026-01": {"ing": 78, "apro": 51, "ot": 16, "rec": 27, "tc": 31.4, "ta": 65.4, "prom": 5.86}, "2026-02": {"ing": 74, "apro": 51, "ot": 9, "rec": 23, "tc": 17.6, "ta": 68.9, "prom": 5.21}, "2026-03": {"ing": 16, "apro": 9, "ot": 0, "rec": 7, "tc": 0.0, "ta": 56.2, "prom": 0}}, "p12": {"ing": 100.2, "apro": 57.7, "ot": 11.4, "rec": 42.5, "tc": 19.8, "ta": 57.5, "prom": 6.46}, "p6": {"ing": 78.2, "apro": 52.0, "ot": 10.8, "rec": 26.2, "tc": 20.8, "ta": 66.5, "prom": 6.26}, "p3": {"ing": 56.0, "apro": 37.0, "ot": 8.3, "rec": 19.0, "tc": 22.5, "ta": 66.1, "prom": 5.63}}, {"nombre": "ARRIAGADA CABEZAS TATIANA", "nombre_corto": "Cabezas Tatiana", "meses": {"2025-01": {"ing": 57, "apro": 38, "ot": 12, "rec": 19, "tc": 31.6, "ta": 66.7, "prom": 4.78}, "2025-02": {"ing": 74, "apro": 33, "ot": 10, "rec": 41, "tc": 30.3, "ta": 44.6, "prom": 5.2}, "2025-03": {"ing": 77, "apro": 43, "ot": 13, "rec": 34, "tc": 30.2, "ta": 55.8, "prom": 4.98}, "2025-04": {"ing": 123, "apro": 71, "ot": 3, "rec": 52, "tc": 4.2, "ta": 57.7, "prom": 4.52}, "2025-05": {"ing": 29, "apro": 14, "ot": 0, "rec": 15, "tc": 0.0, "ta": 48.3, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 86, "apro": 53, "ot": 9, "rec": 33, "tc": 17.0, "ta": 61.6, "prom": 5.93}, "2025-08": {"ing": 82, "apro": 51, "ot": 14, "rec": 31, "tc": 27.5, "ta": 62.2, "prom": 6.26}, "2025-09": {"ing": 102, "apro": 59, "ot": 17, "rec": 43, "tc": 28.8, "ta": 57.8, "prom": 4.73}, "2025-10": {"ing": 142, "apro": 95, "ot": 20, "rec": 46, "tc": 21.1, "ta": 66.9, "prom": 5.68}, "2025-11": {"ing": 91, "apro": 63, "ot": 16, "rec": 28, "tc": 25.4, "ta": 69.2, "prom": 6.02}, "2025-12": {"ing": 73, "apro": 53, "ot": 13, "rec": 20, "tc": 24.5, "ta": 72.6, "prom": 5.34}, "2026-01": {"ing": 87, "apro": 47, "ot": 16, "rec": 40, "tc": 34.0, "ta": 54.0, "prom": 4.79}, "2026-02": {"ing": 19, "apro": 13, "ot": 9, "rec": 5, "tc": 69.2, "ta": 68.4, "prom": 4.43}, "2026-03": {"ing": 45, "apro": 27, "ot": 7, "rec": 18, "tc": 25.9, "ta": 60.0, "prom": 5.65}}, "p12": {"ing": 73.2, "apro": 45.5, "ot": 10.3, "rec": 27.6, "tc": 22.7, "ta": 62.1, "prom": 5.41}, "p6": {"ing": 76.2, "apro": 49.7, "ot": 13.5, "rec": 26.2, "tc": 27.2, "ta": 65.2, "prom": 5.38}, "p3": {"ing": 50.3, "apro": 29.0, "ot": 10.7, "rec": 21.0, "tc": 36.8, "ta": 57.6, "prom": 4.88}}, {"nombre": "FARIAS DE LA TORRE KAREN GRACE MARJORIE", "nombre_corto": "Grace Marjorie", "meses": {"2025-01": {"ing": 38, "apro": 24, "ot": 10, "rec": 13, "tc": 41.7, "ta": 63.2, "prom": 4.59}, "2025-02": {"ing": 98, "apro": 43, "ot": 10, "rec": 55, "tc": 23.3, "ta": 43.9, "prom": 5.05}, "2025-03": {"ing": 100, "apro": 61, "ot": 11, "rec": 39, "tc": 18.0, "ta": 61.0, "prom": 4.98}, "2025-04": {"ing": 100, "apro": 53, "ot": 14, "rec": 47, "tc": 26.4, "ta": 53.0, "prom": 5.2}, "2025-05": {"ing": 171, "apro": 85, "ot": 12, "rec": 85, "tc": 14.1, "ta": 49.7, "prom": 5.68}, "2025-06": {"ing": 109, "apro": 67, "ot": 7, "rec": 42, "tc": 10.4, "ta": 61.5, "prom": 5.22}, "2025-07": {"ing": 96, "apro": 59, "ot": 10, "rec": 37, "tc": 16.9, "ta": 61.5, "prom": 4.66}, "2025-08": {"ing": 81, "apro": 60, "ot": 16, "rec": 21, "tc": 26.7, "ta": 74.1, "prom": 4.78}, "2025-09": {"ing": 78, "apro": 47, "ot": 9, "rec": 31, "tc": 19.1, "ta": 60.3, "prom": 5.64}, "2025-10": {"ing": 75, "apro": 42, "ot": 10, "rec": 33, "tc": 23.8, "ta": 56.0, "prom": 4.96}, "2025-11": {"ing": 88, "apro": 65, "ot": 14, "rec": 23, "tc": 21.5, "ta": 73.9, "prom": 4.39}, "2025-12": {"ing": 72, "apro": 56, "ot": 10, "rec": 16, "tc": 17.9, "ta": 77.8, "prom": 3.78}, "2026-01": {"ing": 57, "apro": 41, "ot": 15, "rec": 16, "tc": 36.6, "ta": 71.9, "prom": 5.26}, "2026-02": {"ing": 66, "apro": 35, "ot": 5, "rec": 31, "tc": 14.3, "ta": 53.0, "prom": 8.47}, "2026-03": {"ing": 25, "apro": 17, "ot": 3, "rec": 8, "tc": 17.6, "ta": 68.0, "prom": 4.56}}, "p12": {"ing": 84.8, "apro": 52.2, "ot": 10.4, "rec": 32.5, "tc": 19.9, "ta": 61.6, "prom": 5.08}, "p6": {"ing": 63.8, "apro": 42.7, "ot": 9.5, "rec": 21.2, "tc": 22.3, "ta": 66.8, "prom": 4.98}, "p3": {"ing": 49.3, "apro": 31.0, "ot": 7.7, "rec": 18.3, "tc": 24.7, "ta": 62.8, "prom": 5.86}}, {"nombre": "MUÑOZ NUÑEZ JUAN", "nombre_corto": "Nuñez Juan", "meses": {"2025-01": {"ing": 35, "apro": 23, "ot": 6, "rec": 12, "tc": 26.1, "ta": 65.7, "prom": 7.37}, "2025-02": {"ing": 52, "apro": 37, "ot": 12, "rec": 15, "tc": 32.4, "ta": 71.2, "prom": 11.2}, "2025-03": {"ing": 63, "apro": 31, "ot": 4, "rec": 32, "tc": 12.9, "ta": 49.2, "prom": 5.48}, "2025-04": {"ing": 72, "apro": 46, "ot": 5, "rec": 26, "tc": 10.9, "ta": 63.9, "prom": 12.03}, "2025-05": {"ing": 100, "apro": 55, "ot": 7, "rec": 45, "tc": 12.7, "ta": 55.0, "prom": 7.46}, "2025-06": {"ing": 90, "apro": 49, "ot": 5, "rec": 40, "tc": 10.2, "ta": 54.4, "prom": 7.32}, "2025-07": {"ing": 128, "apro": 88, "ot": 15, "rec": 40, "tc": 17.0, "ta": 68.8, "prom": 6.16}, "2025-08": {"ing": 82, "apro": 49, "ot": 12, "rec": 32, "tc": 24.5, "ta": 59.8, "prom": 11.83}, "2025-09": {"ing": 72, "apro": 44, "ot": 6, "rec": 28, "tc": 13.6, "ta": 61.1, "prom": 9.23}, "2025-10": {"ing": 85, "apro": 56, "ot": 9, "rec": 29, "tc": 16.1, "ta": 65.9, "prom": 9.09}, "2025-11": {"ing": 55, "apro": 46, "ot": 10, "rec": 9, "tc": 21.7, "ta": 83.6, "prom": 7.17}, "2025-12": {"ing": 83, "apro": 59, "ot": 13, "rec": 24, "tc": 22.0, "ta": 71.1, "prom": 9.53}, "2026-01": {"ing": 87, "apro": 64, "ot": 18, "rec": 23, "tc": 28.1, "ta": 73.6, "prom": 10.26}, "2026-02": {"ing": 76, "apro": 51, "ot": 4, "rec": 25, "tc": 7.8, "ta": 67.1, "prom": 7.44}, "2026-03": {"ing": 54, "apro": 36, "ot": 7, "rec": 17, "tc": 19.4, "ta": 66.7, "prom": 6.85}}, "p12": {"ing": 82.0, "apro": 53.6, "ot": 9.2, "rec": 28.2, "tc": 17.3, "ta": 65.3, "prom": 8.82}, "p6": {"ing": 73.3, "apro": 52.0, "ot": 10.2, "rec": 21.2, "tc": 19.6, "ta": 70.9, "prom": 8.85}, "p3": {"ing": 72.3, "apro": 50.3, "ot": 9.7, "rec": 21.7, "tc": 19.2, "ta": 69.6, "prom": 9.05}}, {"nombre": "SOTO RAVELLO LUIS ALBERTO", "nombre_corto": "Luis Alberto", "meses": {"2025-01": {"ing": 31, "apro": 21, "ot": 11, "rec": 10, "tc": 52.4, "ta": 67.7, "prom": 4.69}, "2025-02": {"ing": 33, "apro": 18, "ot": 8, "rec": 15, "tc": 44.4, "ta": 54.5, "prom": 4.4}, "2025-03": {"ing": 60, "apro": 38, "ot": 8, "rec": 22, "tc": 21.1, "ta": 63.3, "prom": 5.04}, "2025-04": {"ing": 61, "apro": 32, "ot": 4, "rec": 28, "tc": 12.5, "ta": 52.5, "prom": 5.18}, "2025-05": {"ing": 61, "apro": 33, "ot": 10, "rec": 28, "tc": 30.3, "ta": 54.1, "prom": 5.45}, "2025-06": {"ing": 47, "apro": 29, "ot": 3, "rec": 18, "tc": 10.3, "ta": 61.7, "prom": 4.15}, "2025-07": {"ing": 61, "apro": 33, "ot": 4, "rec": 28, "tc": 12.1, "ta": 54.1, "prom": 6.28}, "2025-08": {"ing": 41, "apro": 23, "ot": 10, "rec": 18, "tc": 43.5, "ta": 56.1, "prom": 5.08}, "2025-09": {"ing": 60, "apro": 36, "ot": 12, "rec": 24, "tc": 33.3, "ta": 60.0, "prom": 4.71}, "2025-10": {"ing": 83, "apro": 59, "ot": 21, "rec": 24, "tc": 35.6, "ta": 71.1, "prom": 4.23}, "2025-11": {"ing": 38, "apro": 24, "ot": 9, "rec": 14, "tc": 37.5, "ta": 63.2, "prom": 4.98}, "2025-12": {"ing": 39, "apro": 23, "ot": 9, "rec": 15, "tc": 39.1, "ta": 59.0, "prom": 4.88}, "2026-01": {"ing": 35, "apro": 17, "ot": 6, "rec": 18, "tc": 35.3, "ta": 48.6, "prom": 4.95}, "2026-02": {"ing": 46, "apro": 27, "ot": 8, "rec": 19, "tc": 29.6, "ta": 58.7, "prom": 3.82}, "2026-03": {"ing": 8, "apro": 7, "ot": 3, "rec": 1, "tc": 42.9, "ta": 87.5, "prom": 6.59}}, "p12": {"ing": 48.3, "apro": 28.6, "ot": 8.2, "rec": 19.6, "tc": 28.9, "ta": 59.1, "prom": 4.83}, "p6": {"ing": 41.5, "apro": 26.2, "ot": 9.3, "rec": 15.2, "tc": 35.7, "ta": 63.1, "prom": 4.6}, "p3": {"ing": 29.7, "apro": 17.0, "ot": 5.7, "rec": 12.7, "tc": 33.3, "ta": 57.3, "prom": 4.71}}, {"nombre": "PINOCHET LILLO ALVARO", "nombre_corto": "Lillo Alvaro", "meses": {"2025-01": {"ing": 38, "apro": 27, "ot": 13, "rec": 11, "tc": 48.1, "ta": 71.1, "prom": 5.63}, "2025-02": {"ing": 38, "apro": 23, "ot": 8, "rec": 15, "tc": 34.8, "ta": 60.5, "prom": 6.61}, "2025-03": {"ing": 53, "apro": 27, "ot": 5, "rec": 26, "tc": 18.5, "ta": 50.9, "prom": 5.48}, "2025-04": {"ing": 86, "apro": 46, "ot": 9, "rec": 40, "tc": 19.6, "ta": 53.5, "prom": 4.47}, "2025-05": {"ing": 93, "apro": 54, "ot": 6, "rec": 39, "tc": 11.1, "ta": 58.1, "prom": 4.44}, "2025-06": {"ing": 75, "apro": 39, "ot": 6, "rec": 36, "tc": 15.4, "ta": 52.0, "prom": 4.39}, "2025-07": {"ing": 92, "apro": 55, "ot": 16, "rec": 37, "tc": 29.1, "ta": 59.8, "prom": 4.63}, "2025-08": {"ing": 61, "apro": 29, "ot": 6, "rec": 32, "tc": 20.7, "ta": 47.5, "prom": 4.74}, "2025-09": {"ing": 60, "apro": 34, "ot": 9, "rec": 26, "tc": 26.5, "ta": 56.7, "prom": 6.69}, "2025-10": {"ing": 64, "apro": 35, "ot": 7, "rec": 29, "tc": 20.0, "ta": 54.7, "prom": 5.56}, "2025-11": {"ing": 36, "apro": 24, "ot": 7, "rec": 11, "tc": 29.2, "ta": 66.7, "prom": 5.11}, "2025-12": {"ing": 49, "apro": 27, "ot": 8, "rec": 22, "tc": 29.6, "ta": 55.1, "prom": 6.75}, "2026-01": {"ing": 28, "apro": 18, "ot": 5, "rec": 10, "tc": 27.8, "ta": 64.3, "prom": 5.53}, "2026-02": {"ing": 30, "apro": 18, "ot": 6, "rec": 12, "tc": 33.3, "ta": 60.0, "prom": 6.07}, "2026-03": {"ing": 43, "apro": 25, "ot": 4, "rec": 18, "tc": 16.0, "ta": 58.1, "prom": 5.67}}, "p12": {"ing": 59.8, "apro": 33.7, "ot": 7.4, "rec": 26.0, "tc": 22.0, "ta": 56.3, "prom": 5.3}, "p6": {"ing": 41.7, "apro": 24.5, "ot": 6.2, "rec": 17.0, "tc": 25.2, "ta": 58.8, "prom": 5.82}, "p3": {"ing": 33.7, "apro": 20.3, "ot": 5.0, "rec": 13.3, "tc": 24.6, "ta": 60.4, "prom": 5.78}}, {"nombre": "MORENO LIZAMA CARLO", "nombre_corto": "Lizama Carlo", "meses": {"2025-01": {"ing": 41, "apro": 27, "ot": 8, "rec": 14, "tc": 29.6, "ta": 65.9, "prom": 4.07}, "2025-02": {"ing": 25, "apro": 12, "ot": 4, "rec": 13, "tc": 33.3, "ta": 48.0, "prom": 4.93}, "2025-03": {"ing": 18, "apro": 9, "ot": 0, "rec": 9, "tc": 0.0, "ta": 50.0, "prom": 0}, "2025-04": {"ing": 13, "apro": 6, "ot": 0, "rec": 7, "tc": 0.0, "ta": 46.2, "prom": 0}, "2025-05": {"ing": 33, "apro": 21, "ot": 5, "rec": 12, "tc": 23.8, "ta": 63.6, "prom": 5.25}, "2025-06": {"ing": 39, "apro": 27, "ot": 5, "rec": 12, "tc": 18.5, "ta": 69.2, "prom": 4.91}, "2025-07": {"ing": 53, "apro": 31, "ot": 5, "rec": 21, "tc": 16.1, "ta": 58.5, "prom": 5.71}, "2025-08": {"ing": 54, "apro": 33, "ot": 5, "rec": 21, "tc": 15.2, "ta": 61.1, "prom": 4.74}, "2025-09": {"ing": 38, "apro": 24, "ot": 5, "rec": 14, "tc": 20.8, "ta": 63.2, "prom": 4.86}, "2025-10": {"ing": 58, "apro": 33, "ot": 5, "rec": 25, "tc": 15.2, "ta": 56.9, "prom": 5.54}, "2025-11": {"ing": 42, "apro": 29, "ot": 8, "rec": 13, "tc": 27.6, "ta": 69.0, "prom": 4.42}, "2025-12": {"ing": 42, "apro": 26, "ot": 4, "rec": 15, "tc": 15.4, "ta": 61.9, "prom": 7.37}, "2026-01": {"ing": 41, "apro": 21, "ot": 6, "rec": 20, "tc": 28.6, "ta": 51.2, "prom": 6.45}, "2026-02": {"ing": 60, "apro": 31, "ot": 3, "rec": 29, "tc": 9.7, "ta": 51.7, "prom": 4.72}, "2026-03": {"ing": 23, "apro": 12, "ot": 2, "rec": 11, "tc": 16.7, "ta": 52.2, "prom": 4.38}}, "p12": {"ing": 41.3, "apro": 24.5, "ot": 4.4, "rec": 16.7, "tc": 18.0, "ta": 59.3, "prom": 5.31}, "p6": {"ing": 44.3, "apro": 25.3, "ot": 4.7, "rec": 18.8, "tc": 18.4, "ta": 57.1, "prom": 5.51}, "p3": {"ing": 41.3, "apro": 21.3, "ot": 3.7, "rec": 20.0, "tc": 17.2, "ta": 51.6, "prom": 5.6}}, {"nombre": "VUCINA SALAZAR SOLANGE", "nombre_corto": "Salazar Solange", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 6, "apro": 3, "ot": 0, "rec": 3, "tc": 0.0, "ta": 50.0, "prom": 0}, "2025-07": {"ing": 41, "apro": 14, "ot": 2, "rec": 27, "tc": 14.3, "ta": 34.1, "prom": 5.88}, "2025-08": {"ing": 33, "apro": 17, "ot": 2, "rec": 16, "tc": 11.8, "ta": 51.5, "prom": 4.48}, "2025-09": {"ing": 21, "apro": 15, "ot": 4, "rec": 6, "tc": 26.7, "ta": 71.4, "prom": 4.91}, "2025-10": {"ing": 27, "apro": 17, "ot": 5, "rec": 10, "tc": 29.4, "ta": 63.0, "prom": 5.15}, "2025-11": {"ing": 28, "apro": 20, "ot": 5, "rec": 8, "tc": 25.0, "ta": 71.4, "prom": 6.99}, "2025-12": {"ing": 37, "apro": 23, "ot": 6, "rec": 14, "tc": 26.1, "ta": 62.2, "prom": 5.23}, "2026-01": {"ing": 20, "apro": 13, "ot": 3, "rec": 7, "tc": 23.1, "ta": 65.0, "prom": 5.03}, "2026-02": {"ing": 31, "apro": 21, "ot": 8, "rec": 10, "tc": 38.1, "ta": 67.7, "prom": 4.95}, "2026-03": {"ing": 20, "apro": 9, "ot": 1, "rec": 11, "tc": 11.1, "ta": 45.0, "prom": 5.98}}, "p12": {"ing": 22.0, "apro": 12.7, "ot": 3.0, "rec": 9.3, "tc": 23.7, "ta": 57.6, "prom": 5.36}, "p6": {"ing": 27.2, "apro": 17.2, "ot": 4.7, "rec": 10.0, "tc": 27.2, "ta": 63.2, "prom": 5.45}, "p3": {"ing": 23.7, "apro": 14.3, "ot": 4.0, "rec": 9.3, "tc": 27.9, "ta": 60.6, "prom": 5.06}}, {"nombre": "VERGARA VERGARA CLAUDIA", "nombre_corto": "Vergara Claudia", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 19, "apro": 7, "ot": 2, "rec": 12, "tc": 28.6, "ta": 36.8, "prom": 4.69}, "2025-06": {"ing": 31, "apro": 21, "ot": 3, "rec": 10, "tc": 14.3, "ta": 67.7, "prom": 5.29}, "2025-07": {"ing": 58, "apro": 30, "ot": 2, "rec": 28, "tc": 6.7, "ta": 51.7, "prom": 3.39}, "2025-08": {"ing": 58, "apro": 26, "ot": 2, "rec": 32, "tc": 7.7, "ta": 44.8, "prom": 4.49}, "2025-09": {"ing": 57, "apro": 34, "ot": 4, "rec": 22, "tc": 11.8, "ta": 59.6, "prom": 4.17}, "2025-10": {"ing": 55, "apro": 27, "ot": 8, "rec": 28, "tc": 29.6, "ta": 49.1, "prom": 6.09}, "2025-11": {"ing": 24, "apro": 12, "ot": 3, "rec": 12, "tc": 25.0, "ta": 50.0, "prom": 6.51}, "2025-12": {"ing": 34, "apro": 16, "ot": 5, "rec": 18, "tc": 31.2, "ta": 47.1, "prom": 6.65}, "2026-01": {"ing": 6, "apro": 1, "ot": 0, "rec": 5, "tc": 0.0, "ta": 16.7, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 28.5, "apro": 14.5, "ot": 2.4, "rec": 13.9, "tc": 16.7, "ta": 50.9, "prom": 5.49}, "p6": {"ing": 19.8, "apro": 9.3, "ot": 2.7, "rec": 10.5, "tc": 28.6, "ta": 47.1, "prom": 6.34}, "p3": {"ing": 2.0, "apro": 0.3, "ot": 0.0, "rec": 1.7, "tc": 0.0, "ta": 16.7, "prom": 0}}, {"nombre": "VILORIA URBINA DEYANIRA", "nombre_corto": "Urbina Deyanira", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 1, "apro": 1, "ot": 1, "rec": 0, "tc": 100.0, "ta": 100.0, "prom": 6.5}, "2025-05": {"ing": 74, "apro": 34, "ot": 7, "rec": 40, "tc": 20.6, "ta": 45.9, "prom": 6.43}, "2025-06": {"ing": 83, "apro": 30, "ot": 7, "rec": 53, "tc": 23.3, "ta": 36.1, "prom": 3.89}, "2025-07": {"ing": 88, "apro": 45, "ot": 3, "rec": 43, "tc": 6.7, "ta": 51.1, "prom": 5.74}, "2025-08": {"ing": 44, "apro": 19, "ot": 3, "rec": 25, "tc": 15.8, "ta": 43.2, "prom": 4.31}, "2025-09": {"ing": 50, "apro": 21, "ot": 2, "rec": 29, "tc": 9.5, "ta": 42.0, "prom": 5.14}, "2025-10": {"ing": 8, "apro": 3, "ot": 0, "rec": 5, "tc": 0.0, "ta": 37.5, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 29.0, "apro": 12.8, "ot": 1.9, "rec": 16.2, "tc": 15.0, "ta": 44.0, "prom": 5.18}, "p6": {"ing": 1.3, "apro": 0.5, "ot": 0.0, "rec": 0.8, "tc": 0.0, "ta": 37.5, "prom": 0}, "p3": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}}, {"nombre": "VARGAS CATHERINNE", "nombre_corto": "Vargas Catherinne", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 19, "apro": 13, "ot": 5, "rec": 6, "tc": 38.5, "ta": 68.4, "prom": 5.52}, "2026-01": {"ing": 19, "apro": 14, "ot": 5, "rec": 5, "tc": 35.7, "ta": 73.7, "prom": 5.83}, "2026-02": {"ing": 43, "apro": 22, "ot": 11, "rec": 21, "tc": 50.0, "ta": 51.2, "prom": 4.44}, "2026-03": {"ing": 41, "apro": 28, "ot": 1, "rec": 13, "tc": 3.6, "ta": 68.3, "prom": 3.48}}, "p12": {"ing": 10.2, "apro": 6.4, "ot": 1.8, "rec": 3.8, "tc": 28.6, "ta": 63.1, "prom": 4.96}, "p6": {"ing": 20.3, "apro": 12.8, "ot": 3.7, "rec": 7.5, "tc": 28.6, "ta": 63.1, "prom": 4.96}, "p3": {"ing": 34.3, "apro": 21.3, "ot": 5.7, "rec": 13.0, "tc": 26.6, "ta": 62.1, "prom": 4.79}}, {"nombre": "VERA MARIANELA", "nombre_corto": "Vera Marianela", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 5, "apro": 5, "ot": 1, "rec": 0, "tc": 20.0, "ta": 100.0, "prom": 3.29}, "2025-04": {"ing": 28, "apro": 17, "ot": 5, "rec": 11, "tc": 29.4, "ta": 60.7, "prom": 5.23}, "2025-05": {"ing": 31, "apro": 14, "ot": 0, "rec": 17, "tc": 0.0, "ta": 45.2, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 4.9, "apro": 2.6, "ot": 0.4, "rec": 2.3, "tc": 16.1, "ta": 52.5, "prom": 5.23}, "p6": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p3": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}}, {"nombre": "MILLAR SEBASTIAN", "nombre_corto": "Millar Sebastian", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 5, "apro": 5, "ot": 5, "rec": 0, "tc": 100.0, "ta": 100.0, "prom": 5.64}, "2026-03": {"ing": 34, "apro": 18, "ot": 0, "rec": 16, "tc": 0.0, "ta": 52.9, "prom": 0}}, "p12": {"ing": 3.2, "apro": 1.9, "ot": 0.4, "rec": 1.3, "tc": 21.7, "ta": 59.0, "prom": 5.64}, "p6": {"ing": 6.5, "apro": 3.8, "ot": 0.8, "rec": 2.7, "tc": 21.7, "ta": 59.0, "prom": 5.64}, "p3": {"ing": 13.0, "apro": 7.7, "ot": 1.7, "rec": 5.3, "tc": 21.7, "ta": 59.0, "prom": 5.64}}, {"nombre": "PEÑA CRISTINA", "nombre_corto": "Peña Cristina", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 8, "apro": 2, "ot": 0, "rec": 6, "tc": 0.0, "ta": 25.0, "prom": 0}, "2025-05": {"ing": 23, "apro": 6, "ot": 0, "rec": 17, "tc": 0.0, "ta": 26.1, "prom": 0}, "2025-06": {"ing": 14, "apro": 1, "ot": 0, "rec": 13, "tc": 0.0, "ta": 7.1, "prom": 0}, "2025-07": {"ing": 3, "apro": 0, "ot": 0, "rec": 3, "tc": 0, "ta": 0.0, "prom": 0}, "2025-08": {"ing": 2, "apro": 0, "ot": 0, "rec": 2, "tc": 0, "ta": 0.0, "prom": 0}, "2025-09": {"ing": 30, "apro": 7, "ot": 0, "rec": 23, "tc": 0.0, "ta": 23.3, "prom": 0}, "2025-10": {"ing": 17, "apro": 5, "ot": 0, "rec": 12, "tc": 0.0, "ta": 29.4, "prom": 0}, "2025-11": {"ing": 23, "apro": 9, "ot": 1, "rec": 14, "tc": 11.1, "ta": 39.1, "prom": 5.4}, "2025-12": {"ing": 16, "apro": 12, "ot": 1, "rec": 4, "tc": 8.3, "ta": 75.0, "prom": 8.0}, "2026-01": {"ing": 30, "apro": 12, "ot": 1, "rec": 18, "tc": 8.3, "ta": 40.0, "prom": 2.9}, "2026-02": {"ing": 34, "apro": 16, "ot": 0, "rec": 18, "tc": 0.0, "ta": 47.1, "prom": 0}, "2026-03": {"ing": 22, "apro": 6, "ot": 1, "rec": 16, "tc": 16.7, "ta": 27.3, "prom": 4.99}}, "p12": {"ing": 18.5, "apro": 6.3, "ot": 0.3, "rec": 12.2, "tc": 5.3, "ta": 34.2, "prom": 5.32}, "p6": {"ing": 23.7, "apro": 10.0, "ot": 0.7, "rec": 13.7, "tc": 6.7, "ta": 42.3, "prom": 5.32}, "p3": {"ing": 28.7, "apro": 11.3, "ot": 0.7, "rec": 17.3, "tc": 5.9, "ta": 39.5, "prom": 3.94}}, {"nombre": "BUSTOS ROXANA", "nombre_corto": "Bustos Roxana", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 3, "apro": 3, "ot": 2, "rec": 0, "tc": 66.7, "ta": 100.0, "prom": 3.23}, "2025-05": {"ing": 30, "apro": 14, "ot": 2, "rec": 16, "tc": 14.3, "ta": 46.7, "prom": 7.45}, "2025-06": {"ing": 2, "apro": 0, "ot": 0, "rec": 2, "tc": 0, "ta": 0.0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 2.9, "apro": 1.4, "ot": 0.3, "rec": 1.5, "tc": 23.5, "ta": 48.6, "prom": 5.34}, "p6": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p3": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}}, {"nombre": "ADAD  VARGAS  NATALIA ANDREA", "nombre_corto": "Natalia Andrea", "meses": {"2025-01": {"ing": 127, "apro": 44, "ot": 4, "rec": 83, "tc": 9.1, "ta": 34.6, "prom": 4.79}, "2025-02": {"ing": 33, "apro": 8, "ot": 0, "rec": 25, "tc": 0.0, "ta": 24.2, "prom": 0}, "2025-03": {"ing": 3, "apro": 2, "ot": 0, "rec": 1, "tc": 0.0, "ta": 66.7, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p6": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p3": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}}, {"nombre": "LAMPREA JEAN", "nombre_corto": "Lamprea Jean", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 2, "apro": 1, "ot": 1, "rec": 1, "tc": 100.0, "ta": 50.0, "prom": 2.0}, "2025-07": {"ing": 51, "apro": 20, "ot": 1, "rec": 31, "tc": 5.0, "ta": 39.2, "prom": 5.0}, "2025-08": {"ing": 43, "apro": 22, "ot": 1, "rec": 21, "tc": 4.5, "ta": 51.2, "prom": 6.29}, "2025-09": {"ing": 7, "apro": 2, "ot": 0, "rec": 5, "tc": 0.0, "ta": 28.6, "prom": 0}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 8.6, "apro": 3.8, "ot": 0.2, "rec": 4.8, "tc": 6.7, "ta": 43.7, "prom": 4.43}, "p6": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p3": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}}, {"nombre": "CLAUDIA", "nombre_corto": "Claudia", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 2, "apro": 2, "ot": 2, "rec": 0, "tc": 100.0, "ta": 100.0, "prom": 3.83}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 0.2, "apro": 0.2, "ot": 0.2, "rec": 0.0, "tc": 100.0, "ta": 100.0, "prom": 3.83}, "p6": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p3": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}}, {"nombre": "ALVARO VARGAS VIELMA (AFA) 4953194", "nombre_corto": "(afa) 4953194", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 1, "apro": 1, "ot": 1, "rec": 0, "tc": 100.0, "ta": 100.0, "prom": 3.89}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 0.1, "apro": 0.1, "ot": 0.1, "rec": 0.0, "tc": 100.0, "ta": 100.0, "prom": 3.89}, "p6": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p3": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}}, {"nombre": "BAZAN FLORENCIA", "nombre_corto": "Bazan Florencia", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 1, "apro": 1, "ot": 1, "rec": 0, "tc": 100.0, "ta": 100.0, "prom": 6.49}}, "p12": {"ing": 0.1, "apro": 0.1, "ot": 0.1, "rec": 0.0, "tc": 100.0, "ta": 100.0, "prom": 6.49}, "p6": {"ing": 0.2, "apro": 0.2, "ot": 0.2, "rec": 0.0, "tc": 100.0, "ta": 100.0, "prom": 6.49}, "p3": {"ing": 0.3, "apro": 0.3, "ot": 0.3, "rec": 0.0, "tc": 100.0, "ta": 100.0, "prom": 6.49}}, {"nombre": "LARA  RAMIREZ  YARITZA ANDREA CRISTAL", "nombre_corto": "Andrea Cristal", "meses": {"2025-01": {"ing": 59, "apro": 37, "ot": 1, "rec": 22, "tc": 2.7, "ta": 62.7, "prom": 2.88}, "2025-02": {"ing": 9, "apro": 1, "ot": 0, "rec": 8, "tc": 0.0, "ta": 11.1, "prom": 0}, "2025-03": {"ing": 5, "apro": 2, "ot": 0, "rec": 3, "tc": 0.0, "ta": 40.0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p6": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p3": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}}, {"nombre": "VENTA DIRECTA AUTOFACIL", "nombre_corto": "Directa Autofacil", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 1, "apro": 1, "ot": 1, "rec": 0, "tc": 100.0, "ta": 100.0, "prom": 30.45}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 0.1, "apro": 0.1, "ot": 0.1, "rec": 0.0, "tc": 100.0, "ta": 100.0, "prom": 30.45}, "p6": {"ing": 0.2, "apro": 0.2, "ot": 0.2, "rec": 0.0, "tc": 100.0, "ta": 100.0, "prom": 30.45}, "p3": {"ing": 0.3, "apro": 0.3, "ot": 0.3, "rec": 0.0, "tc": 100.0, "ta": 100.0, "prom": 30.45}}, {"nombre": "NO ENCONTRADO", "nombre_corto": "No Encontrado", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-10": {"ing": 2, "apro": 1, "ot": 0, "rec": 1, "tc": 0.0, "ta": 50.0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 2, "apro": 1, "ot": 0, "rec": 1, "tc": 0.0, "ta": 50.0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 0.3, "apro": 0.2, "ot": 0.0, "rec": 0.2, "tc": 0.0, "ta": 50.0, "prom": 0}, "p6": {"ing": 0.7, "apro": 0.3, "ot": 0.0, "rec": 0.3, "tc": 0.0, "ta": 50.0, "prom": 0}, "p3": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}}, {"nombre": "GIACOBINO CARLOS", "nombre_corto": "Giacobino Carlos", "meses": {"2025-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-03": {"ing": 1, "apro": 1, "ot": 0, "rec": 0, "tc": 0.0, "ta": 100.0, "prom": 0}, "2025-04": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-05": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-06": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-07": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-08": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-09": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-10": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-11": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2025-12": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-01": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-02": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}, "2026-03": {"ing": 0, "apro": 0, "ot": 0, "rec": 0, "tc": 0, "ta": 0, "prom": 0}}, "p12": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p6": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}, "p3": {"ing": 0.0, "apro": 0.0, "ot": 0.0, "rec": 0.0, "tc": 0, "ta": 0, "prom": 0}}]};
let currentMetric = 'ot';
let currentCols = 'all';

function setMetric(m, el) {
  currentMetric = m;
  document.querySelectorAll('#pills-metric .pill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  buildV5();
}

function setCols(c, el) {
  currentCols = c;
  document.querySelectorAll('#pills-cols .pill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  buildV5();
}

function fmtNombreCompleto(n) {
  // "APELLIDO APELLIDO NOMBRE NOMBRE" -> "Nombre Apellido Apellido"
  if (!n) return n;
  const parts = n.trim().split(/\s+/);
  // Convención: 2 apellidos + 1-2 nombres -> mostrar todo en title case
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

function buildV5() {
  const meses_all = EJ_PERF.meses;
  const labels = EJ_PERF.meses_labels;

  // Filtrar meses según selección (orden inverso: más reciente primero)
  let meses;
  if (currentCols === '2026') meses = meses_all.filter(m=>m.startsWith('2026')).reverse();
  else if (currentCols === 'last6') meses = meses_all.slice(-6).reverse();
  else meses = [...meses_all].reverse();

  // Calcular valores para heatmap y percentiles de TC/TA
  const vals = [];
  EJ_PERF.ejecutivos.forEach(ej => {
    meses.forEach(m => {
      const d = ej.meses[m];
      if (d) vals.push(d[currentMetric]||0);
    });
  });
  const maxVal = Math.max(...vals, 0.01);

  // Percentiles para TC y TA (solo valores > 0)
  const percentile = (arr, p) => {
    const sorted = [...arr].filter(v=>v>0).sort((a,b)=>a-b);
    if (!sorted.length) return 0;
    const idx = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0,idx)];
  };
  const tcVals=[], taVals=[];
  EJ_PERF.ejecutivos.forEach(ej => {
    [...meses, 'p12','p6','p3'].forEach(k => {
      const d = ej.meses?.[k] || ej[k] || {};
      if (d.tc > 0) tcVals.push(d.tc);
      if (d.ta > 0) taVals.push(d.ta);
    });
  });
  const tcP = { p25: percentile(tcVals,25), p50: percentile(tcVals,50), p75: percentile(tcVals,75) };
  const taP = { p25: percentile(taVals,25), p50: percentile(taVals,50), p75: percentile(taVals,75) };

  // Color heatmap: de blanco a azul oscuro (para otorgados y prom)
  const heatColor = (v) => {
    if (!v) return '#f8faff';
    const pct = Math.min(v / maxVal, 1);
    const r = Math.round(255 - pct*180);
    const g = Math.round(255 - pct*160);
    const b = Math.round(255 - pct*60);
    return `rgb(${r},${g},${b})`;
  };
  const txtColor = (v) => {
    const pct = Math.min(v / maxVal, 1);
    return pct > 0.55 ? '#fff' : '#333';
  };

  // Color percentil para TC y TA
  const rateColor = (v, ps) => {
    if (!v) return { bg:'#f8faff', tc:'#aaa' };
    if (v <= ps.p25) return { bg:'#e53935', tc:'#fff' };        // rojo  ≤ p25
    if (v <= ps.p50) return { bg:'#fb8c00', tc:'#fff' };        // naranjo p25-p50
    if (v <= ps.p75) return { bg:'#fdd835', tc:'#555' };        // amarillo p50-p75
    return { bg:'#43a047', tc:'#fff' };                          // verde > p75
  };

  const fmtVal = (d, metric) => {
    if (!d || !d[metric]) return '—';
    const v = d[metric];
    if (metric === 'tc' || metric === 'ta') return v.toFixed(1)+'%';
    if (metric === 'prom') return v.toFixed(1)+'M';
    return v;
  };

  // Sub-cols por mes: ing, apro, ot, rec, tc, ta, prom
  const subCols = [
    {k:'ing',  lbl:'Ing',  w:28},
    {k:'apro', lbl:'Apro', w:30},
    {k:'ot',   lbl:'Ot',   w:28},
    {k:'rec',  lbl:'Rec',  w:28},
    {k:'tc',   lbl:'TC',   w:38},
    {k:'ta',   lbl:'TA',   w:36},
    {k:'prom', lbl:'Prom', w:40},
  ];
  const promCols = [
    {tag:'p12', lbl:'Prom 12m'},
    {tag:'p6',  lbl:'Prom 6m'},
    {tag:'p3',  lbl:'Prom 3m'},
  ];

  // THEAD — fila 1: meses fusionados
  const mesHeaders = meses.map(m =>
    `<th colspan="7" style="background:#1a3a6a;color:#fff;text-align:center;border-right:2px solid #fff;padding:5px 2px;font-size:10px;white-space:nowrap">${labels[m]||m}</th>`
  ).join('');
  const promHeaders = promCols.map(p =>
    `<th colspan="7" style="background:#00838f;color:#fff;text-align:center;border-right:2px solid #fff;padding:5px 2px;font-size:10px;white-space:nowrap">${p.lbl}</th>`
  ).join('');

  // THEAD — fila 2: sub-columnas
  const subHeader = sc => subCols.map(s =>
    `<th style="background:#2a4a7a;color:#cce;text-align:center;padding:3px 2px;font-size:9px;min-width:${s.w}px;white-space:nowrap">${s.lbl}</th>`
  ).join('');
  const subHeaders = meses.map(() => subHeader()).join('') +
    promCols.map(() => subHeader()).join('');

  document.getElementById('thead-ej-perf').innerHTML = `
    <tr>
      <th rowspan="2" style="background:#1a3a6a;color:#fff;text-align:left;padding:6px 8px;min-width:130px;font-size:11px;position:sticky;left:0;z-index:2">Ejecutivo</th>
      ${mesHeaders}${promHeaders}
    </tr>
    <tr>${subHeaders}</tr>`;

  // TBODY
  const rows = EJ_PERF.ejecutivos.map(ej => {
    ej.nombre_completo = fmtNombreCompleto(ej.nombre);
    const nameCell = `<td style="background:#f8faff;font-size:10px;font-weight:600;padding:4px 8px;white-space:nowrap;position:sticky;left:0;z-index:1;border-right:1px solid #dce3ed">${ej.nombre_completo}</td>`;

    const mesCells = meses.map(m => {
      const d = ej.meses[m] || {};
      return subCols.map(s => {
        const v = d[s.k] || 0;
        const isHeat = s.k === currentMetric;
        let bg, tc;
        if (s.k === 'tc' && currentMetric === 'tc') { const c = rateColor(v, tcP); bg=c.bg; tc=c.tc; }
        else if (s.k === 'ta' && currentMetric === 'ta') { const c = rateColor(v, taP); bg=c.bg; tc=c.tc; }
        else { bg = isHeat ? heatColor(v) : (v ? '#fff' : '#f8faff'); tc = isHeat ? txtColor(v) : '#333'; }
        const txt = fmtVal(d, s.k);
        return `<td style="text-align:center;padding:3px 2px;background:${bg};color:${tc};border-right:1px solid #f0f2f5;font-size:10px">${txt}</td>`;
      }).join('');
    }).join('');

    const promCells = promCols.map(p => {
      const d = ej[p.tag] || {};
      return subCols.map(s => {
        const v = d[s.k] || 0;
        const isHeat = s.k === currentMetric;
        let bg, tc;
        if (s.k === 'tc' && currentMetric === 'tc') { const c = rateColor(v, tcP); bg=c.bg; tc=c.tc; }
        else if (s.k === 'ta' && currentMetric === 'ta') { const c = rateColor(v, taP); bg=c.bg; tc=c.tc; }
        else { bg = isHeat ? heatColor(v) : '#f0f8f0'; tc = isHeat ? txtColor(v) : '#2e7d32'; }
        const txt = fmtVal(d, s.k);
        return `<td style="text-align:center;padding:3px 2px;background:${bg};color:${tc};border-right:1px solid #e0ece0;font-size:10px;font-weight:500">${txt}</td>`;
      }).join('');
    }).join('');

    return `<tr style="border-bottom:1px solid #f0f2f5">${nameCell}${mesCells}${promCells}</tr>`;
  }).join('');

  document.getElementById('tbody-ej-perf').innerHTML = rows;
}
// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 2416
// ──────────────────────────────────────────────────────────────

// ======== VISTA 6: ESTADO SALDO PRECIO ========
window._v6_fin   = null;      // null = todas, 'AUTOFIN', 'UNIDAD'
window._v6_grupo = 'dealer';  // 'dealer' | 'ejecutivo'

function toggleGrupoV6(g) {
  window._v6_grupo = g;
  var bD = document.getElementById('btn-grp-dealer');
  var bE = document.getElementById('btn-grp-ej');
  if (bD) { bD.style.background = g==='dealer'    ? '#4fc3f7' : 'transparent'; bD.style.color = g==='dealer'    ? '#0d1627' : '#4fc3f7'; }
  if (bE) { bE.style.background = g==='ejecutivo' ? '#4fc3f7' : 'transparent'; bE.style.color = g==='ejecutivo' ? '#0d1627' : '#4fc3f7'; }
  buildV6();
}

function toggleFinV6(fin) {
  window._v6_fin = fin;
  // Estilo botones
  var btnAll = document.getElementById('btn-fin-v6-all');
  var btnAF  = document.getElementById('btn-fin-v6-af');
  var btnUC  = document.getElementById('btn-fin-v6-uc');
  if (btnAll) { btnAll.style.background = fin===null ? '#4fc3f7' : 'transparent'; btnAll.style.color = fin===null ? '#0d1627' : '#4fc3f7'; }
  if (btnAF)  { btnAF.style.background  = fin==='AUTOFIN' ? '#2196F3' : 'transparent'; btnAF.style.color  = fin==='AUTOFIN' ? '#fff' : '#2196F3'; }
  if (btnUC)  { btnUC.style.background  = fin==='UNIDAD'  ? '#ff7043' : 'transparent'; btnUC.style.color  = fin==='UNIDAD'  ? '#fff' : '#ff7043'; }
  buildV6();
}

const ESTADOS_SP_COLS = ["FONDOS RECIBIDOS", "FUNDANTE EN PROCESO", "FUNDANTE PENDIENTE", "LIBERADO A PAGO", "PAGADO", "RETENIDO", "SUJETO A PRENDA", "ANULADO"];
const SP_COLOR = {
  'PAGADO':              { bg:'#C8E6C9', txt:'#1B5E20', dark:'#43a047' },
  'FONDOS RECIBIDOS':    { bg:'#BBDEFB', txt:'#0D47A1', dark:'#2196F3' },
  'FUNDANTE EN PROCESO': { bg:'#FFF9C4', txt:'#F57F17', dark:'#F9A825' },
  'FUNDANTE PENDIENTE':  { bg:'#FFE0B2', txt:'#E65100', dark:'#fb8c00' },
  'LIBERADO A PAGO':     { bg:'#E1BEE7', txt:'#4A148C', dark:'#8b5cf6' },
  'RETENIDO':            { bg:'#FFCDD2', txt:'#B71C1C', dark:'#e53935' },
  'SUJETO A PRENDA':     { bg:'#F8BBD9', txt:'#880E4F', dark:'#e91e63' },
  'ANULADO':             { bg:'#ECEFF1', txt:'#455A64', dark:'#90a4ae' },
};
const SP_DEF = { bg:'#F5F5F5', txt:'#777', dark:'#aaa' };

function buildV6() {
  const desde = document.getElementById('sel-desde')?.value || '';
  const hasta  = document.getElementById('sel-hasta')?.value  || '';
  const lbl = document.getElementById('periodo-label')?.textContent || '';
  document.getElementById('titulo-v6').textContent =
    'Estado Saldo Precio — Créditos Otorgados' + (lbl ? ' — ' + lbl : '');

  const finFiltro = window._v6_fin;
  const ot = window.RAW_DATA
    .filter(r => {
      if (r.estado_eval !== 'OTORGADO') return false;
      if (r.mes < desde || r.mes > hasta) return false;
      if (finFiltro === 'AUTOFIN'  && r.institucion !== 'AUTOFIN') return false;
      if (finFiltro === 'UNIDAD'   && r.institucion !== 'UNIDAD DE CREDITO') return false;
      return true;
    })
    .map(r => ({...r, estado_sp: r.estado_sp || 'SIN ESTADO'}));

  if (!ot.length) {
    document.getElementById('kpi6').innerHTML = '<div class="kpi-box"><div class="kpi-label">Sin datos</div><div class="kpi-val">—</div></div>';
    document.getElementById('t-sp').innerHTML = '<tr><td style="padding:20px;color:#888">Sin operaciones otorgadas en el período seleccionado</td></tr>';
    return;
  }

  // Columnas presentes
  const spPresentes = ESTADOS_SP_COLS.filter(sp => ot.some(r => r.estado_sp === sp));
  const otrosSP = [...new Set(ot.map(r=>r.estado_sp))].filter(sp => !ESTADOS_SP_COLS.includes(sp) && sp !== 'NO APLICA');
  const colsSP = [...spPresentes, ...otrosSP];

  // Totales por SP
  const bysp = {};
  colsSP.forEach(sp => {
    const rows = ot.filter(r => r.estado_sp === sp);
    bysp[sp] = { ops: rows.length, saldo: rows.reduce((a,r)=>a+r.saldo_precio,0) };
  });

  // KPIs con filtro toggle
  const totOps = ot.length;
  const totSaldo = ot.reduce((a,r)=>a+r.saldo_precio,0);

  // Filtro activo (variable global para v6)
  if (!window._v6_filtro) window._v6_filtro = null;

  window.toggleFiltroSP = function(sp) {
    window._v6_filtro = (window._v6_filtro === sp) ? null : sp;
    renderTablaV6(ot, colsSP, bysp, totOps, totSaldo);
  };

  document.getElementById('kpi6').innerHTML =
    `<div class="kpi-box" style="cursor:pointer" onclick="window._v6_filtro=null;renderTablaV6(ot,colsSP,bysp,totOps,totSaldo)">
       <div class="kpi-label">Total Otorgados</div>
       <div class="kpi-val big">${totOps}</div>
       <div class="kpi-sub">${fM(totSaldo)}</div>
     </div>` +
    colsSP.map(sp => {
      const c = SP_COLOR[sp]||SP_DEF;
      const activo = window._v6_filtro === sp;
      return `<div class="kpi-box" id="kpi-sp-${sp.replace(/ /g,'_')}"
        onclick="toggleFiltroSP('${sp}')"
        style="border-top:3px solid ${c.dark};cursor:pointer;transition:all .15s;
               ${activo ? `background:${c.bg};box-shadow:0 0 0 2px ${c.dark}` : ''}">
        <div class="kpi-label" style="color:${activo?c.txt:'inherit'}">${sp}</div>
        <div class="kpi-val" style="color:${activo?c.dark:'inherit'}">${bysp[sp].ops}</div>
        <div class="kpi-sub">${fM(bysp[sp].saldo)}</div>
        ${activo ? `<div style="font-size:9px;color:${c.dark};font-weight:700;margin-top:2px">✕ FILTRADO</div>` : ''}
      </div>`;
    }).join('');

  renderTablaV6(ot, colsSP, bysp, totOps, totSaldo);
}

function renderTablaV6(ot, colsSP, bysp, totOps, totSaldo) {
  const filtroActivo = window._v6_filtro;

  // Actualizar estilo de KPIs
  colsSP.forEach(sp => {
    const el = document.getElementById('kpi-sp-' + sp.replace(/ /g,'_'));
    if (!el) return;
    const c = SP_COLOR[sp]||SP_DEF;
    const activo = filtroActivo === sp;
    el.style.background = activo ? c.bg : '';
    el.style.boxShadow  = activo ? `0 0 0 2px ${c.dark}` : '';
    const lbl = el.querySelector('.kpi-label');
    const val = el.querySelector('.kpi-val');
    if (lbl) lbl.style.color = activo ? c.txt : '';
    if (val) val.style.color = activo ? c.dark : '';
    // Toggle badge
    let badge = el.querySelector('.sp-badge');
    if (activo && !badge) {
      badge = document.createElement('div');
      badge.className = 'sp-badge';
      badge.style.cssText = `font-size:9px;color:${c.dark};font-weight:700;margin-top:2px`;
      badge.textContent = '✕ FILTRADO';
      el.appendChild(badge);
    } else if (!activo && badge) {
      badge.remove();
    }
  });

  // Filtrar operaciones
  const otFiltrado = filtroActivo ? ot.filter(r => r.estado_sp === filtroActivo) : ot;
  const totF = otFiltrado.length;
  const salF = otFiltrado.reduce((a,r)=>a+r.saldo_precio,0);

  // Pivot — agrupación dinámica
  const porEj = window._v6_grupo === 'ejecutivo';
  const pivot = {};
  otFiltrado.forEach(r => {
    const key = porEj
      ? (r.ejecutivo ? r.ejecutivo.trim().split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ') : 'SIN EJECUTIVO')
      : (r.automotora || 'SIN AUTOMOTORA');
    if (!pivot[key]) pivot[key] = { ops:[], saldo:0, por_sp:{} };
    pivot[key].ops.push(r.op);
    pivot[key].saldo += r.saldo_precio;
    const sp = r.estado_sp;
    if (!pivot[key].por_sp[sp]) pivot[key].por_sp[sp] = { ops:[], saldo:0 };
    pivot[key].por_sp[sp].ops.push(r.op);
    pivot[key].por_sp[sp].saldo += r.saldo_precio;
  });

  const auts = Object.entries(pivot).sort((a,b) => b[1].saldo - a[1].saldo);
  const colsVis = filtroActivo ? [filtroActivo] : colsSP;

  const thSP = colsVis.map(sp => {
    const c = SP_COLOR[sp]||SP_DEF;
    return `<th style="background:${c.dark};color:#fff;text-align:center;padding:5px 8px;font-size:10px;white-space:nowrap;min-width:120px">${sp}</th>`;
  }).join('');

  const rows = auts.map(([aut, v]) => {
    const autCells = colsVis.map(sp => {
      const d = v.por_sp[sp];
      if (!d) return `<td style="background:#f8faff;border-right:1px solid #f0f2f5"></td>`;
      const c = SP_COLOR[sp]||SP_DEF;
      return `<td style="text-align:center;background:${c.bg};color:${c.txt};padding:4px 6px;border-right:1px solid #dce3ed;vertical-align:top">
        <div style="font-weight:700;font-size:12px">${d.ops.length}</div>
        <div style="font-size:10px">${fM(d.saldo)}</div>
      </td>`;
    }).join('');

    const opRows = v.ops.map(op => {
      const r = otFiltrado.find(x => x.op === op);
      if (!r) return '';
      const sp = r.estado_sp;
      const c = SP_COLOR[sp]||SP_DEF;
      const opCells = colsVis.map(col => {
        if (col !== sp) return `<td style="background:#fafafa;border-right:1px solid #f0f2f5"></td>`;
        return `<td style="text-align:center;background:${c.bg}55;color:${c.txt};padding:3px 6px;border-right:1px solid #f0f2f5;font-size:10px">${fN(r.saldo_precio)}</td>`;
      }).join('');
      const ejFmt = (r.ejecutivo||'').trim().split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
      const autFmt = r.automotora || '';
      const subLabel = porEj
        ? `${op} — ${autFmt.length>30?autFmt.substring(0,30)+'…':autFmt}`
        : `${op} — ${ejFmt}`;
      return `<tr style="border-bottom:1px solid #f5f5f5" data-op="${r.op}">
        <td style="padding:3px 6px 3px 16px;font-size:10px;color:#777;white-space:nowrap">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" class="chk-sp-op" data-op="${r.op}" style="cursor:pointer;accent-color:#1565C0;width:12px;height:12px"/>
            ${subLabel}
          </label>
        </td>
        ${opCells}
      </tr>`;
    }).join('');

    return `<tr style="background:#e8edf5;border-bottom:1px solid #dce3ed">
      <td style="padding:5px 6px;font-weight:700;font-size:11px;color:#1a3a6a;white-space:nowrap">
        ${aut.length>55?aut.substring(0,55)+'…':aut}
        <span style="font-weight:400;color:#888;font-size:10px;margin-left:6px">${v.ops.length} op${v.ops.length>1?'s':''} · ${fM(v.saldo)}</span>
      </td>${autCells}
    </tr>${opRows}`;
  }).join('');

  const totalCells = colsVis.map(sp => {
    const c = SP_COLOR[sp]||SP_DEF;
    const v = filtroActivo ? {ops:totF, saldo:salF} : bysp[sp];
    return `<td style="text-align:center;font-weight:700;background:${c.dark};color:#fff;padding:5px 6px;font-size:11px">${v.ops} · ${fM(v.saldo)}</td>`;
  }).join('');

  document.getElementById('t-sp').innerHTML = `
    <thead><tr>
      <th style="background:#1a3a6a;color:#fff;text-align:left;padding:6px 8px;min-width:150px;font-size:11px;position:sticky;left:0;z-index:2">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:500">
          <input type="checkbox" id="chk-sp-all" onchange="toggleTodosV6(this.checked)"
            style="cursor:pointer;accent-color:#4fc3f7;width:13px;height:13px"/>
          ${porEj ? 'Ejecutivo' : 'Dealer'} / N° Operación ${filtroActivo ? `<span style="font-size:9px;background:#fff2;padding:1px 6px;border-radius:3px;margin-left:6px">🔍 ${filtroActivo}</span>` : ''}
        </label>
      </th>
      ${thSP}
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr>
      <td style="background:#1a3a6a;color:#fff;font-weight:700;padding:6px 8px;font-size:11px;position:sticky;left:0">
        Total · ${totF} ops · ${fM(salF)}
      </td>
      ${totalCells}
    </tr></tfoot>`;

}

// Seleccionar / deseleccionar todos los checkboxes visibles
function toggleTodosV6(checked) {
  document.querySelectorAll('.chk-sp-op').forEach(chk => chk.checked = checked);
}

// Exportar operaciones seleccionadas como CSV descargable
function exportarDetalleV6() {
  const checks = Array.from(document.querySelectorAll('.chk-sp-op:checked'));
  const ops = checks.map(c => parseInt(c.dataset.op));

  if (!ops.length) {
    alert('Selecciona al menos una operación usando los checkboxes.');
    return;
  }

  const filas = ops.map(op => window.RAW_DATA.find(r => r.op === op)).filter(Boolean);

  const bom = '\uFEFF';
  const headers = [
    'OP','RUT','NOMBRE','EJ.COMERCIAL','PARQUE','AUTOMOTORA',
    'FINANCIERA','MES','ESTADO CREDITO','FECHA OTORGADO',
    'SALDO PRECIO','ALERTA PAGO SP','FECHA RECEPCION FEI','ALERTA RECEP FEI'
  ];

  const thCells = headers.map(h => `<th style="background:#1a3a6a;color:#fff;padding:6px 10px;border:1px solid #ccc;white-space:nowrap">${h}</th>`).join('');

  const trRows = filas.map(r => {
    const vals = [
      r.op, r.rut||'', r.nombre||'', r.ejecutivo||'',
      r.com_parque||'', r.automotora||'',
      r.financiera||r.institucion||'', r.mes||'',
      r.estado_credito||'', r.fecha_ot||'',
      r.saldo_precio||'', r.alerta_pago_sp||'',
      r.fecha_recepcion_fei||'', r.alerta_recep_fei||''
    ];
    const tds = vals.map(v => `<td style="padding:5px 10px;border:1px solid #dce3ed">${v}</td>`).join('');
    return `<tr>${tds}</tr>`;
  }).join('');

  const html = `${bom}<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Detalle SP</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
</head><body>
<table border="1" style="border-collapse:collapse;font-family:Arial;font-size:11px">
<thead><tr>${thCells}</tr></thead>
<tbody>${trRows}</tbody>
</table></body></html>`;

  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `detalle_sp_${new Date().toISOString().slice(0,10)}.xls`;
  a.click();
  URL.revokeObjectURL(url);
}


// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 2761
// ──────────────────────────────────────────────────────────────

// ======== VISTA 7: FUNNEL DE CONVERSIÓN ========
const SP_SANO = ['PAGADO','LIBERADO A PAGO','FONDOS RECIBIDOS','FUNDANTE EN PROCESO','FUNDANTE PENDIENTE'];

function fPct(n,d) { return d ? (n/d*100).toFixed(1)+'%' : '—'; }
function pctColor(p, thresholds) {
  // thresholds: [bad, warn, ok] valores de corte
  if (p >= thresholds[2]) return '#43a047';
  if (p >= thresholds[1]) return '#fb8c00';
  return '#e53935';
}

function buildV7() {
  const desde = document.getElementById('sel-desde')?.value || '';
  const hasta  = document.getElementById('sel-hasta')?.value  || '';
  const lbl = document.getElementById('periodo-label')?.textContent || '';
  document.getElementById('titulo-v7').textContent = 'Embudo por Ejecutivo — ' + lbl;

  // Calcular funnel por ejecutivo
  const rows = window.RAW_DATA.filter(r =>
    r.mes >= desde && r.mes <= hasta && r.ejecutivo
  );

  const ejMap = {};
  rows.forEach(r => {
    const ej = r.ejecutivo;
    if (!ejMap[ej]) ejMap[ej] = {ing:0,apro:0,ot:0,sp_sano:0,rec:0,saldo_ot:0};
    const d = ejMap[ej];
    d.ing++;
    const est = r.estado_eval || '';
    if (!['RECHAZADO','ANULADO'].includes(est)) d.apro++;
    if (est === 'OTORGADO') {
      d.ot++;
      d.saldo_ot += r.saldo_precio || 0;
      if (SP_SANO.includes(r.estado_sp || '')) d.sp_sano++;
    }
    if (est === 'RECHAZADO') d.rec++;
  });

  // Ordenar por otorgados desc
  const ejs = Object.entries(ejMap)
    .filter(([,v]) => v.ing > 0)
    .sort((a,b) => b[1].ot - a[1].ot);

  // KPIs equipo
  const totIng  = ejs.reduce((a,[,v])=>a+v.ing,0);
  const totApro = ejs.reduce((a,[,v])=>a+v.apro,0);
  const totOt   = ejs.reduce((a,[,v])=>a+v.ot,0);
  const totSP   = ejs.reduce((a,[,v])=>a+v.sp_sano,0);
  document.getElementById('kpi7').innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Ingresados</div><div class="kpi-val big">${totIng}</div></div>
    <div class="kpi-box"><div class="kpi-label">Aprobados</div><div class="kpi-val big">${totApro}</div><div class="kpi-sub">${fPct(totApro,totIng)} TA</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Otorgados</div><div class="kpi-val big">${totOt}</div><div class="kpi-sub">${fPct(totOt,totApro)} TC</div></div>
    <div class="kpi-box"><div class="kpi-label">Caída Aprobación</div><div class="kpi-val big" style="color:#e53935">${totIng-totApro}</div><div class="kpi-sub">${fPct(totIng-totApro,totIng)} rechazados</div></div>
    <div class="kpi-box"><div class="kpi-label">Caída Conversión</div><div class="kpi-val big" style="color:#fb8c00">${totApro-totOt}</div><div class="kpi-sub">${fPct(totApro-totOt,totApro)} apro no otorgados</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Tasa Global</div><div class="kpi-val big">${fPct(totOt,totIng)}</div><div class="kpi-sub">Ing → Otorgado</div></div>`;

  // Tabla funnel
  const taTeam  = totApro/totIng*100;
  const tcTeam  = totOt/totApro*100;
  const tspTeam = totSP/totOt*100;

  const thead = `<thead><tr style="background:#1a3a6a;color:#fff;font-size:10px">
    <th style="padding:6px 8px;text-align:left;position:sticky;left:0;background:#1a3a6a;min-width:160px">Ejecutivo</th>
    <th style="padding:6px;text-align:center;min-width:55px">Ing.</th>
    <th style="padding:6px;text-align:center;min-width:55px">Apro.</th>
    <th style="padding:6px;text-align:center;min-width:55px" title="Tasa Aprobación">TA%</th>
    <th style="padding:6px;text-align:center;min-width:55px">Ot.</th>
    <th style="padding:6px;text-align:center;min-width:55px" title="Tasa Conversión">TC%</th>
    <th style="padding:6px;text-align:center;min-width:55px">Rec.</th>
    <th style="padding:6px;text-align:center;min-width:120px">Barra de caída</th>
    <th style="padding:6px;text-align:center;min-width:70px">Prob. clave</th>
  </tr></thead>`;

  const tbRows = ejs.map(([ej, v]) => {
    const ta  = v.ing  ? v.apro/v.ing*100  : 0;
    const tc  = v.apro ? v.ot/v.apro*100   : 0;
    // Colores semáforo vs promedio equipo
    const taC  = ta  >= taTeam*0.9  ? '#43a047' : ta  >= taTeam*0.7  ? '#fb8c00' : '#e53935';
    const tcC  = tc  >= tcTeam*0.9  ? '#43a047' : tc  >= tcTeam*0.7  ? '#fb8c00' : '#e53935';

    // Barra visual del funnel (proporcional a ing=100%)
    const pApro = v.ing ? v.apro/v.ing*100 : 0;
    const pOt   = v.ing ? v.ot/v.ing*100   : 0;
    const pSP   = v.ing ? v.sp_sano/v.ing*100 : 0;

    // Diagnóstico principal
    let diag = '', diagC = '#666';
    if (ta < taTeam*0.7)       { diag = '⚠ Aprobación'; diagC = '#e53935'; }
    else if (tc < tcTeam*0.7)  { diag = '⚠ Conversión'; diagC = '#fb8c00'; }
    else                       { diag = '✓ OK';           diagC = '#43a047'; }

    const nombre = ej.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');

    return `<tr style="border-bottom:1px solid #f0f2f5">
      <td style="padding:5px 8px;font-weight:600;font-size:10px;position:sticky;left:0;background:#fff">${nombre}</td>
      <td style="text-align:center;padding:4px 6px">${v.ing}</td>
      <td style="text-align:center;padding:4px 6px">${v.apro}</td>
      <td style="text-align:center;padding:4px 6px;font-weight:700;color:${taC}">${ta.toFixed(1)}%</td>
      <td style="text-align:center;padding:4px 6px">${v.ot}</td>
      <td style="text-align:center;padding:4px 6px;font-weight:700;color:${tcC}">${tc.toFixed(1)}%</td>
      <td style="text-align:center;padding:4px 6px;color:#e53935">${v.rec}</td>
      <td style="padding:4px 8px">
        <div style="position:relative;height:14px;background:#f0f2f5;border-radius:3px;overflow:hidden">
          <div style="position:absolute;left:0;top:0;height:100%;width:100%;background:#e8edf5;border-radius:3px"></div>
          <div style="position:absolute;left:0;top:0;height:100%;width:${pApro.toFixed(1)}%;background:#2196F355;border-radius:3px"></div>
          <div style="position:absolute;left:0;top:0;height:100%;width:${pOt.toFixed(1)}%;background:#1565C0;border-radius:3px"></div>
        </div>
      </td>
      <td style="text-align:center;padding:4px 6px;font-weight:700;font-size:10px;color:${diagC}">${diag}</td>
    </tr>`;
  }).join('');

  const tfootRow = `<tfoot><tr style="background:#e8edf5;font-weight:700;font-size:10px;border-top:2px solid #1a3a6a">
    <td style="padding:5px 8px;position:sticky;left:0;background:#e8edf5">TOTAL EQUIPO</td>
    <td style="text-align:center;padding:4px 6px">${totIng}</td>
    <td style="text-align:center;padding:4px 6px">${totApro}</td>
    <td style="text-align:center;padding:4px 6px;color:#2196F3">${taTeam.toFixed(1)}%</td>
    <td style="text-align:center;padding:4px 6px">${totOt}</td>
    <td style="text-align:center;padding:4px 6px;color:#43a047">${tcTeam.toFixed(1)}%</td>
    <td style="text-align:center;padding:4px 6px;color:#e53935">${ejs.reduce((a,[,v])=>a+v.rec,0)}</td>
    <td></td><td></td>
  </tr></tfoot>`;

  document.getElementById('t-funnel').innerHTML = thead + '<tbody>' + tbRows + '</tbody>' + tfootRow;

  // Gráfico barras horizontales — caída en cada etapa
  const labels = ejs.slice(0,15).map(([ej])=>ej.split(' ').slice(0,2).map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' '));
  const dataTA  = ejs.slice(0,15).map(([,v])=>v.ing?+(v.apro/v.ing*100).toFixed(1):0);
  const dataTC  = ejs.slice(0,15).map(([,v])=>v.apro?+(v.ot/v.apro*100).toFixed(1):0);

  const existBar = Chart.getChart(document.getElementById('ch-funnel-bar'));
  if (existBar) existBar.destroy();
  new Chart(document.getElementById('ch-funnel-bar'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'TA% (Aprobación)', data: dataTA, backgroundColor: '#2196F3aa', borderRadius: 3 },
        { label: 'TC% (Conversión)', data: dataTC, backgroundColor: '#43a047aa', borderRadius: 3 },
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { font: { size: 10 } } }, tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}%` } } },
      scales: {
        x: { min: 0, max: 100, ticks: { callback: v => v+'%', font: { size: 9 } }, grid: { color: '#f0f2f5' } },
        y: { ticks: { font: { size: 9 } } }
      }
    }
  });

  // Gráfico TC% línea por ejecutivo
  const existTC = Chart.getChart(document.getElementById('ch-funnel-tc'));
  if (existTC) existTC.destroy();
  const tcVals = ejs.slice(0,15).map(([,v])=>v.apro?+(v.ot/v.apro*100).toFixed(1):0);
  const tcAvg  = tcTeam.toFixed(1);
  new Chart(document.getElementById('ch-funnel-tc'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'TC%', data: tcVals,
           backgroundColor: tcVals.map(v => v>=tcTeam ? '#43a047cc' : v>=tcTeam*0.7 ? '#fb8c00cc' : '#e53935cc'),
           borderRadius: 3 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` TC: ${ctx.raw}% (prom: ${tcAvg}%)` } } },
      scales: {
        x: { ticks: { font: { size: 8 } } },
        y: { min: 0, max: 100, ticks: { callback: v=>v+'%', font:{size:9} }, grid:{color:'#f0f2f5'} }
      }
    }
  });
}

// ======== PROYECCIÓN PRO ========
// Mejoras sobre la curva simple:
//  1. DÍAS HÁBILES (L-V) en vez de calendario — un mes que parte en fin de
//     semana no se lee como "atrasado".
//  2. MEDIANA de las fracciones históricas (robusta a meses raros) con banda
//     p25–p75 en vez de promedio ±σ.
//  3. MEZCLA CON TENDENCIA: regresión lineal de los últimos 3 cierres da una
//     proyección independiente del avance; el peso de la curva crece con el
//     mes (al inicio manda la tendencia, al final mandan los datos reales).
function buildVProy2() {
  const MESES_HIST = 6, MESES_TREND = 3;
  const rows = (window.RAW_DATA || []).filter(r => r.estado_eval === 'OTORGADO' && r.fecha_otorgado && r.mes);
  const hoy = new Date();
  const mesAct = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
  const MES_NOM = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
  document.getElementById('proy2-mes-label').textContent = MES_NOM[hoy.getMonth()] + ' ' + hoy.getFullYear();

  // Día hábil (L-V) dentro del mes de una fecha; y total de hábiles del mes.
  const habilIdx = (y, m, dia) => { let n = 0; for (let d = 1; d <= dia; d++) { const w = new Date(y, m, d).getDay(); if (w >= 1 && w <= 5) n++; } return Math.max(n, 1); };
  const habilesDelMes = (y, m) => habilIdx(y, m, new Date(y, m + 1, 0).getDate());
  const habilDe = f => { const [y, m, d] = String(f).slice(0, 10).split('-').map(Number); return habilIdx(y, m - 1, d); };

  const D = habilesDelMes(hoy.getFullYear(), hoy.getMonth());          // hábiles del mes actual
  const dHoy = habilIdx(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()); // hábil de hoy

  // ── Curvas históricas por día hábil (fracción acumulada 0-1, normalizada a 0-1 del mes) ──
  const mesesHist = [...new Set(rows.map(r => r.mes))].filter(m => m < mesAct).sort().slice(-MESES_HIST);
  const curvasQ = [], curvasM = [];
  for (const mh of mesesHist) {
    const [y, m] = mh.split('-').map(Number);
    const Dm = habilesDelMes(y, m - 1);
    const ops = rows.filter(r => r.mes === mh);
    const totQ = ops.length, totM = ops.reduce((a, r) => a + r.monto_financiado, 0);
    if (!totQ || !totM) continue;
    // acumulado sobre eje NORMALIZADO t = díaHábil/Dm (0-1), muestreado en 100 puntos
    const cq = Array(101).fill(0), cm = Array(101).fill(0);
    ops.forEach(r => { const t = Math.min(Math.round(habilDe(r.fecha_otorgado) / Dm * 100), 100); cq[t] += 1; cm[t] += r.monto_financiado; });
    for (let t = 1; t <= 100; t++) { cq[t] += cq[t - 1]; cm[t] += cm[t - 1]; }
    curvasQ.push(cq.map(v => v / totQ)); curvasM.push(cm.map(v => v / totM));
  }
  const cuantil = (vals, p) => { const s = [...vals].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
  const en = (curvas, t, p) => cuantil(curvas.map(c => c[Math.min(Math.max(Math.round(t), 0), 100)]), p);
  const tHoy = dHoy / D * 100;
  const medQ = en(curvasQ, tHoy, .5), medM = en(curvasM, tHoy, .5);
  const p25M = en(curvasM, tHoy, .25), p75M = en(curvasM, tHoy, .75);

  // ── Actual del mes por institución ──
  const act = { AUTOFIN: { q: 0, m: 0, f: 0 }, UNIDAD: { q: 0, m: 0, f: 0 } };
  rows.filter(r => r.mes === mesAct).forEach(r => {
    const k = (r.institucion || '').includes('UNIDAD') ? 'UNIDAD' : 'AUTOFIN';
    act[k].q += 1; act[k].m += r.monto_financiado; act[k].f += (r.rentab_afa || 0) + (r.com_seguros || 0);
  });
  const tot = { q: act.AUTOFIN.q + act.UNIDAD.q, m: act.AUTOFIN.m + act.UNIDAD.m, f: act.AUTOFIN.f + act.UNIDAD.f };

  // ── Método 1: curva (mediana) ──
  const projCurva = (actual, med) => med > 0.04 ? actual / med : null;

  // ── Método 2: tendencia (regresión lineal últimos 3 cierres) ──
  const trend = (metric) => {
    const ult = mesesHist.slice(-MESES_TREND).map(mh => {
      const ops = rows.filter(r => r.mes === mh);
      return metric === 'q' ? ops.length : ops.reduce((a, r) => a + (metric === 'm' ? r.monto_financiado : (r.rentab_afa || 0) + (r.com_seguros || 0)), 0);
    });
    const n = ult.length; if (!n) return 0;
    if (n === 1) return ult[0];
    const xm = (n - 1) / 2, ym = ult.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0; ult.forEach((v, i) => { num += (i - xm) * (v - ym); den += (i - xm) ** 2; });
    const b = den ? num / den : 0;
    return Math.max(ym + b * n, 0); // valor proyectado para el mes siguiente a la serie
  };

  // ── Mezcla: peso de la curva = avance esperado (al inicio manda la tendencia) ──
  const w = Math.min(Math.max(medM, 0), 1);
  const mezcla = (pc, pt) => pc == null ? pt : Math.round(w * pc + (1 - w) * pt);

  const pcQ = projCurva(tot.q, medQ), ptQ = trend('q');
  const pcM = projCurva(tot.m, medM), ptM = trend('m');
  const pcF = projCurva(tot.f, medM), ptF = trend('f');
  const mzQ = mezcla(pcQ, ptQ), mzM = mezcla(pcM, ptM), mzF = mezcla(pcF, ptF);
  // Banda del monto con p25/p75 de la curva (solo informativa)
  const rgM = medM > 0.04 ? [tot.m / Math.min(p75M, 1), tot.m / Math.max(p25M, 0.04)] : null;

  document.getElementById('kpi-proy2').innerHTML = `
    <div class="kpi-box"><div class="kpi-label">Día hábil</div><div class="kpi-val big">${dHoy} / ${D}</div><div class="kpi-sub">${(tHoy).toFixed(0)}% del mes transcurrido</div></div>
    <div class="kpi-box"><div class="kpi-label">Avance esperado (mediana)</div><div class="kpi-val big">${(medM * 100).toFixed(1)}%</div><div class="kpi-sub">p25 ${(p25M*100).toFixed(0)}% · p75 ${(p75M*100).toFixed(0)}%</div></div>
    <div class="kpi-box"><div class="kpi-label">Peso curva vs tendencia</div><div class="kpi-val big">${(w*100).toFixed(0)}% / ${((1-w)*100).toFixed(0)}%</div><div class="kpi-sub">la curva pesa más al avanzar el mes</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Q cierre (mezcla)</div><div class="kpi-val big">${mzQ ? Math.round(mzQ) : '—'}</div><div class="kpi-sub">hoy: ${tot.q} ops</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Monto cierre (mezcla)</div><div class="kpi-val big">${mzM ? fM(mzM) : '—'}</div><div class="kpi-sub">${rgM ? 'banda ' + fM(rgM[0]) + '–' + fM(rgM[1]) : ''}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Facturación cierre (mezcla)</div><div class="kpi-val big">${mzF ? fM(mzF) : '—'}</div><div class="kpi-sub">hoy: ${fM(tot.f)}</div></div>`;

  // ── Tabla por institución (mezcla, repartida proporcional al actual) ──
  const parte = (total, a, t) => t > 0 ? total * (a / t) : 0;
  const fila = (nom, a) => `<tr><td><b>${nom}</b></td>
    <td>${a.q}</td><td><b>${mzQ ? Math.round(parte(mzQ, a.q, tot.q)) : '—'}</b></td>
    <td>${fM(a.m)}</td><td><b>${mzM ? fM(parte(mzM, a.m, tot.m)) : '—'}</b></td>
    <td>${fM(a.f)}</td><td><b>${mzF ? fM(parte(mzF, a.f, tot.f)) : '—'}</b></td></tr>`;
  document.getElementById('t-proy2').innerHTML = `
    <thead><tr><th>Institución</th><th>Q hoy</th><th>Q cierre</th><th>Monto hoy</th><th>Monto cierre</th><th>Fact. hoy</th><th>Fact. cierre</th></tr></thead>
    <tbody>${fila('AUTOFIN', act.AUTOFIN)}${fila('UNIDAD', act.UNIDAD)}</tbody>
    <tfoot><tr><td><b>Total</b></td><td>${tot.q}</td><td><b>${mzQ ? Math.round(mzQ) : '—'}</b></td><td>${fM(tot.m)}</td><td><b>${mzM ? fM(mzM) : '—'}</b></td><td>${fM(tot.f)}</td><td><b>${mzF ? fM(mzF) : '—'}</b></td></tr></tfoot>`;
  document.getElementById('proy2-nota').innerHTML =
    `<i class="bi bi-info-circle me-1"></i>Mezcla = ${(w*100).toFixed(0)}% curva hábil (mediana de ${curvasM.length} meses) + ${((1-w)*100).toFixed(0)}% tendencia (regresión de los últimos ${MESES_TREND} cierres). La distribución por institución es proporcional al avance real de cada una.`;

  // ── Tabla comparativa de métodos (monto) ──
  document.getElementById('t-proy2-met').innerHTML = `
    <thead><tr><th>Método</th><th>Monto cierre</th><th>Q cierre</th><th>Facturación</th><th>Cómo funciona</th></tr></thead>
    <tbody>
      <tr><td>Curva hábil (mediana)</td><td>${pcM ? fM(pcM) : '—'}</td><td>${pcQ ? Math.round(pcQ) : '—'}</td><td>${pcF ? fM(pcF) : '—'}</td><td style="font-size:.74rem;color:#64748b">actual ÷ avance mediano histórico al día hábil ${dHoy}</td></tr>
      <tr><td>Tendencia (últimos ${MESES_TREND})</td><td>${fM(ptM)}</td><td>${Math.round(ptQ)}</td><td>${fM(ptF)}</td><td style="font-size:.74rem;color:#64748b">regresión lineal de los cierres previos, sin mirar el mes en curso</td></tr>
      <tr style="background:#eff6ff"><td><b>Mezcla (recomendada)</b></td><td><b>${mzM ? fM(mzM) : '—'}</b></td><td><b>${mzQ ? Math.round(mzQ) : '—'}</b></td><td><b>${mzF ? fM(mzF) : '—'}</b></td><td style="font-size:.74rem;color:#64748b">pondera ambas según cuánto mes ha transcurrido</td></tr>
    </tbody>`;

  // ── Gráfico: monto mensual histórico (12m) + mes actual real+proyección (mezcla) ──
  const meses12 = [...new Set(rows.map(r => r.mes))].sort().filter(m => m < mesAct).slice(-12);
  const histM = meses12.map(m => rows.filter(r => r.mes === m).reduce((a, r) => a + r.monto_financiado, 0));
  const labels1 = [...meses12, mesAct].map(m => { const [y, mm] = m.split('-'); return MES_NOM[+mm - 1].slice(0, 3) + ' ' + y.slice(2); });
  const cH = Chart.getChart(document.getElementById('ch-proy2-hist')); if (cH) cH.destroy();
  new Chart(document.getElementById('ch-proy2-hist'), {
    type: 'bar',
    data: { labels: labels1, datasets: [
      { label: 'Colocado', data: [...histM, tot.m], backgroundColor: '#0141A2cc', borderRadius: 3, stack: 's' },
      { label: 'Proyección restante (mezcla)', data: [...histM.map(() => 0), Math.max((mzM || tot.m) - tot.m, 0)], backgroundColor: '#90caf9aa', borderColor: '#0141A2', borderWidth: 1, borderDash: [4, 3], borderRadius: 3, stack: 's' },
    ]},
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { font: { size: 10 } } }, tooltip: { callbacks: { label: c => ' ' + c.dataset.label + ': ' + fM(c.raw) } } },
      scales: { x: { ticks: { font: { size: 9 } } }, y: { ticks: { callback: v => fM(v), font: { size: 9 } }, grid: { color: '#f0f2f5' } } } }
  });

  // ── Gráfico: acumulado por día hábil vs banda esperada ──
  const cmAct = Array(D + 1).fill(0);
  rows.filter(r => r.mes === mesAct).forEach(r => { cmAct[Math.min(habilDe(r.fecha_otorgado), D)] += r.monto_financiado; });
  for (let d = 1; d <= D; d++) cmAct[d] += cmAct[d - 1];
  const dias = Array.from({ length: D }, (_, i) => i + 1);
  const base = mzM || tot.m;
  const med = dias.map(d => en(curvasM, d / D * 100, .5) * base);
  const p25 = dias.map(d => en(curvasM, d / D * 100, .25) * base);
  const p75 = dias.map(d => en(curvasM, d / D * 100, .75) * base);
  const c2 = Chart.getChart(document.getElementById('ch-proy2-curva')); if (c2) c2.destroy();
  new Chart(document.getElementById('ch-proy2-curva'), {
    type: 'line',
    data: { labels: dias, datasets: [
      { label: 'p75', data: p75, borderColor: 'transparent', backgroundColor: '#90caf933', fill: '+1', pointRadius: 0 },
      { label: 'p25', data: p25, borderColor: 'transparent', pointRadius: 0, fill: false },
      { label: 'Esperado (mediana)', data: med, borderColor: '#94a3b8', borderDash: [3, 3], pointRadius: 0, borderWidth: 1.5 },
      { label: 'Real acumulado', data: dias.map(d => d <= dHoy ? cmAct[d] : null), borderColor: '#0141A2', backgroundColor: '#0141A222', fill: false, tension: .2, pointRadius: 0, borderWidth: 2.5 },
    ]},
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { font: { size: 10 }, filter: i => i.text !== 'p25' } }, tooltip: { callbacks: { label: c => ' ' + c.dataset.label + ': ' + fM(c.raw) } } },
      scales: { x: { title: { display: true, text: 'Día hábil del mes', font: { size: 10 } }, ticks: { font: { size: 9 } } }, y: { ticks: { callback: v => fM(v), font: { size: 9 } }, grid: { color: '#f0f2f5' } } } }
  });

  // Click en cualquiera de los dos gráficos → popup grande con copiar/descargar
  afChartZoom('ch-proy2-hist', 'Monto colocado mensual — histórico y proyectado');
  afChartZoom('ch-proy2-curva', 'Avance acumulado por día hábil — real vs esperado');
}

/* ── Popup de gráfico: agranda el canvas y permite copiarlo como imagen (PPT) ──
   Reutilizable: afChartZoom(idCanvas, titulo) tras crear el Chart. */
function afChartZoom(canvasId, titulo) {
  const cv = document.getElementById(canvasId);
  if (!cv || cv.dataset.zoomOn) return;
  cv.dataset.zoomOn = '1';
  cv.style.cursor = 'zoom-in';
  cv.title = 'Click para ampliar y copiar';
  cv.addEventListener('click', () => {
    // Alta resolución REAL: re-renderizar el gráfico (no estirar píxeles) en un
    // canvas offscreen grande con devicePixelRatio 2 → nítido en PPT/pantalla.
    const chart = Chart.getChart(document.getElementById(canvasId));
    if (!chart) return;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:1600px;height:760px';
    const cnv = document.createElement('canvas');
    holder.appendChild(cnv); document.body.appendChild(holder);
    const cfg = {
      type: chart.config.type,
      data: chart.config.data,
      options: { ...chart.config.options, responsive: false, animation: false, devicePixelRatio: 2,
        plugins: { ...chart.config.options.plugins, legend: { ...(chart.config.options.plugins?.legend || {}), labels: { ...(chart.config.options.plugins?.legend?.labels || {}), font: { size: 16 } } } } },
    };
    cnv.width = 1600; cnv.height = 760;
    const tmp = new Chart(cnv, cfg);
    // fondo blanco bajo el render
    const big = document.createElement('canvas');
    big.width = cnv.width * 2; big.height = cnv.height * 2; // dpr 2
    const ctx = big.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, big.width, big.height);
    ctx.drawImage(cnv, 0, 0, big.width, big.height);
    tmp.destroy(); holder.remove();
    const url = big.toDataURL('image/png');

    let dlg = document.getElementById('afChartDlg');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'afChartDlg';
      dlg.style.cssText = 'border:0;border-radius:14px;padding:0;max-width:92vw;width:1100px;box-shadow:0 24px 80px rgba(0,0,0,.4)';
      document.body.appendChild(dlg);
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    }
    dlg.innerHTML = `
      <div style="padding:14px 20px;display:flex;align-items:center;gap:10px;background:linear-gradient(90deg,#012d70,#0255c5);color:#fff">
        <b style="flex:1;font-size:.95rem">${titulo}</b>
        <button id="afChZCopy" style="border:none;background:#16a34a;color:#fff;border-radius:8px;padding:7px 16px;font-weight:700;cursor:pointer;font-size:.82rem"><i class="bi bi-clipboard me-1"></i>Copiar imagen</button>
        <a id="afChZDown" download="${canvasId}.png" href="${url}" style="border:none;background:rgba(255,255,255,.15);color:#fff;border-radius:8px;padding:7px 16px;font-weight:700;cursor:pointer;font-size:.82rem;text-decoration:none"><i class="bi bi-download me-1"></i>PNG</a>
        <button onclick="document.getElementById('afChartDlg').close()" style="border:none;background:rgba(255,255,255,.15);color:#fff;border-radius:8px;padding:7px 12px;cursor:pointer">✕</button>
      </div>
      <div style="padding:16px;background:#fff"><img src="${url}" style="width:100%;display:block;border-radius:8px"></div>`;
    dlg.querySelector('#afChZCopy').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      try {
        const blob = await new Promise(res => big.toBlob(res, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        btn.innerHTML = '<i class="bi bi-check2 me-1"></i>Copiado — pega con Ctrl+V';
      } catch (err) { btn.innerHTML = '<i class="bi bi-x me-1"></i>Usa el botón PNG'; }
      setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copiar imagen'; }, 2500);
    });
    dlg.showModal();
  });
}

// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 3044
// ──────────────────────────────────────────────────────────────
// ======== CONFIG DE PESTAÑAS ========
const TABS_NAV = [
  { id:'v1b',   label:'✅ Otorgados' },
  { id:'v1',    label:'📊 Aprobados' },
  { id:'v2',    label:'💰 Rentabilidades' },
  { id:'v3',    label:'📈 Tendencia' },
  { id:'v5',    label:'👤 Ejecutivos' },
  { id:'v7',    label:'🔻 Funnel' },
  { id:'v6',    label:'💳 Saldo Precio' },
  { id:'v8',    label:'📋 Comparativo' },
  { id:'vhist', label:'📅 Historia' },
  { id:'vppto', label:'🎯 Presupuesto' },
  { id:'vevol', label:'📊 Evolución' },
  { id:'v2pl',  label:'📋 P&L Operativo' },
  { id:'vseg',  label:'🛡️ Seguros' },
  { id:'vdealers', label:'🏪 Dealers' },
  { id:'vparques', label:'🅿️ Parques' },
  { id:'vproy2', label:'🔮 Proyección Pro' },
];
const PERFILES_DEFAULT = ['USUARIO', 'SUPERVISOR', 'GERENTE GENERAL', 'ADMINISTRADOR'];
let PERFILES_SISTEMA = PERFILES_DEFAULT.slice();

// Cargar perfiles guardados desde config
(function() {
  try {
    const cfg = JSON.parse(sessionStorage.getItem('af_tab_permisos') || '{}');
    if (Array.isArray(cfg._perfiles) && cfg._perfiles.length > 0) {
      PERFILES_SISTEMA = cfg._perfiles;
    }
  } catch(e) {}
})();

function aplicarOrdenNavTabs() {
  var tabsContainer = document.querySelector('.tabs');
  var adminTab = document.getElementById('tab-admin');
  if (!tabsContainer) return;
  TABS_NAV.forEach(function(tab) {
    var el = document.querySelector('.tab[data-viewid="' + tab.id + '"]');
    if (el) tabsContainer.insertBefore(el, adminTab);
  });
}

function aplicarPermisosNavTabs() {
  if (!sesionActual) return;
  const permisos = JSON.parse(sessionStorage.getItem('af_tab_permisos') || '{}');
  // Aplicar orden guardado
  if (Array.isArray(permisos._order)) {
    var ordered = permisos._order.filter(function(id) { return TABS_NAV.find(function(t){ return t.id===id; }); });
    ordered.forEach(function(id, i) {
      var idx = TABS_NAV.findIndex(function(t){ return t.id===id; });
      if (idx !== i) { var t = TABS_NAV.splice(idx,1)[0]; TABS_NAV.splice(i,0,t); }
    });
    aplicarOrdenNavTabs();
  }
  // Aplicar visibilidad
  const perfil = (sesionActual.perfil || '').toUpperCase();
  TABS_NAV.forEach(function(tab) {
    const el = document.querySelector('.tab[data-viewid="' + tab.id + '"]');
    if (!el) return;
    const permitidos = permisos[tab.id];
    // Mostrar si: sin restricción, array vacío, o el perfil está incluido (case-insensitive)
    const visible = !permitidos || permitidos.length === 0 ||
                    permitidos.some(function(p){ return p.toUpperCase() === perfil; });
    el.style.display = visible ? '' : 'none';
  });
}

// ======== ADMIN DE USUARIOS ========
async function buildVAdmin() {
  adminSubTab('permisos'); // solo mostramos permisos de pestañas
}

function adminSubTab(sec) {
  document.getElementById('adm-sec-usuarios').style.display  = sec === 'usuarios'  ? '' : 'none';
  document.getElementById('adm-sec-permisos').style.display  = sec === 'permisos'  ? '' : 'none';
  var btnU = document.getElementById('adm-tab-usuarios');
  var btnP = document.getElementById('adm-tab-permisos');
  if (btnU) { btnU.style.background = sec==='usuarios' ? '#1a3a6a' : '#0d1627'; btnU.style.color = sec==='usuarios' ? '#fff' : '#7bafd4'; }
  if (btnP) { btnP.style.background = sec==='permisos' ? '#1a3a6a' : '#0d1627'; btnP.style.color = sec==='permisos' ? '#fff' : '#7bafd4'; }
  if (sec === 'permisos') renderTablaPermisos();
}

function renderTablaPermisos() {
  const permisos = JSON.parse(sessionStorage.getItem('af_tab_permisos') || '{}');
  var html = '<thead><tr style="background:#1a3a6a;color:#fff;font-size:11px">' +
    '<th style="padding:10px 8px;text-align:center;width:30px"></th>' +
    '<th style="padding:10px 12px;text-align:left;width:220px">Pestaña</th>';
  PERFILES_SISTEMA.forEach(function(p) {
    html += '<th style="padding:6px 16px;text-align:center">' +
      '<div style="display:flex;flex-direction:column;align-items:center;gap:3px">' +
      '<span>' + p + '</span>' +
      '<button onclick="eliminarPerfilDash(\'' + p.replace(/'/g,"\\'") + '\')" title="Eliminar perfil" ' +
      'style="background:#e53935;color:#fff;border:none;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;line-height:1.4">✕ Eliminar</button>' +
      '</div></th>';
  });
  html += '<th style="padding:6px 8px;text-align:center">' +
    '<button onclick="agregarPerfilDash()" style="background:#43a047;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;white-space:nowrap">➕ Perfil</button>' +
    '</th>';
  html += '</tr></thead><tbody id="tbody-permisos-tabs">';
  TABS_NAV.forEach(function(tab) {
    var permitidos = permisos[tab.id] || PERFILES_SISTEMA.slice();
    html += '<tr draggable="true" data-tabid="' + tab.id + '" style="border-bottom:1px solid #e8ecf0;cursor:default">';
    html += '<td style="padding:9px 8px;text-align:center;color:#aaa;font-size:16px;cursor:grab" title="Arrastrar para reordenar">⠿</td>';
    html += '<td style="padding:9px 12px;font-weight:600;font-size:13px">' + tab.label + '</td>';
    PERFILES_SISTEMA.forEach(function(p) {
      var checked = permitidos.includes(p) ? 'checked' : '';
      html += '<td style="padding:9px 16px;text-align:center">' +
        '<input type="checkbox" data-tab="' + tab.id + '" data-perfil="' + p + '" ' + checked +
        ' style="width:16px;height:16px;cursor:pointer"/></td>';
    });
    html += '<td></td></tr>';
  });
  html += '</tbody>';
  document.getElementById('t-permisos-tabs').innerHTML = html;
  initDragTablas();
}

function initDragTablas() {
  var tbody = document.getElementById('tbody-permisos-tabs');
  if (!tbody) return;
  var dragSrc = null;
  tbody.querySelectorAll('tr').forEach(function(row) {
    row.addEventListener('dragstart', function(e) {
      dragSrc = row;
      e.dataTransfer.effectAllowed = 'move';
      row.style.opacity = '0.4';
    });
    row.addEventListener('dragend', function() {
      row.style.opacity = '';
      tbody.querySelectorAll('tr').forEach(function(r) { r.style.background = ''; });
    });
    row.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tbody.querySelectorAll('tr').forEach(function(r) { r.style.background = ''; });
      if (row !== dragSrc) row.style.background = '#e3f2fd';
    });
    row.addEventListener('drop', function(e) {
      e.preventDefault();
      if (!dragSrc || dragSrc === row) return;
      // Reorder TABS_NAV
      var srcId = dragSrc.dataset.tabid;
      var dstId = row.dataset.tabid;
      var srcIdx = TABS_NAV.findIndex(function(t) { return t.id === srcId; });
      var dstIdx = TABS_NAV.findIndex(function(t) { return t.id === dstId; });
      if (srcIdx === -1 || dstIdx === -1) return;
      var removed = TABS_NAV.splice(srcIdx, 1)[0];
      TABS_NAV.splice(dstIdx, 0, removed);
      aplicarOrdenNavTabs();
      renderTablaPermisos();
    });
  });
}

async function agregarPerfilDash() {
  // Cargar perfiles del sistema principal para sugerencias
  var sugerencias = [];
  try {
    const tk = sessionStorage.getItem('token') || sesionActual?.token || '';
    const r = await fetch('/api/perfiles', { headers: { Authorization: 'Bearer ' + tk } });
    const d = await r.json();
    if (d.success && Array.isArray(d.data)) {
      sugerencias = d.data.map(function(p){ return (p.nombre || '').toUpperCase(); })
        .filter(function(n){ return n && !PERFILES_SISTEMA.includes(n); });
    }
  } catch(e) {}

  var msg = 'Nombre del nuevo perfil:';
  if (sugerencias.length) msg += '\n(Disponibles: ' + sugerencias.join(', ') + ')';
  var nombre = prompt(msg);
  if (!nombre) return;
  nombre = nombre.trim().toUpperCase();
  if (!nombre) return;
  if (PERFILES_SISTEMA.includes(nombre)) { alert('Ese perfil ya existe.'); return; }
  PERFILES_SISTEMA.push(nombre);
  renderTablaPermisos();
}

function eliminarPerfilDash(nombre) {
  if (!confirm('¿Eliminar el perfil "' + nombre + '" de la tabla de permisos del dashboard?')) return;
  PERFILES_SISTEMA = PERFILES_SISTEMA.filter(function(p){ return p !== nombre; });
  renderTablaPermisos();
}

async function restaurarPermisosDefault() {
  if (!confirm('¿Restaurar el orden original y hacer visibles todas las pestañas para todos los perfiles?')) return;
  // Restaurar orden original hardcodeado
  const ORDER_DEFAULT = ['v1b','v1','v2','v3','v5','v7','v6','v8','vhist','vppto','vevol','v2pl'];
  ORDER_DEFAULT.forEach(function(id, i) {
    var idx = TABS_NAV.findIndex(function(t){ return t.id===id; });
    if (idx !== -1 && idx !== i) { var t = TABS_NAV.splice(idx,1)[0]; TABS_NAV.splice(i,0,t); }
  });
  // Permisos: todos los perfiles ven todas las pestañas, restaurar lista de perfiles al default
  PERFILES_SISTEMA = PERFILES_DEFAULT.slice();
  var permisos = { _order: ORDER_DEFAULT, _perfiles: PERFILES_SISTEMA.slice() };
  TABS_NAV.forEach(function(tab) { permisos[tab.id] = PERFILES_SISTEMA.slice(); });
  try {
    const resp = await apiDashboard('POST', 'permisos', { permisos });
    if (!resp.success) throw new Error(resp.error || 'Error');
    sessionStorage.setItem('af_tab_permisos', JSON.stringify(permisos));
    aplicarOrdenNavTabs();
    aplicarPermisosNavTabs();
    renderTablaPermisos();
    alert('✅ Permisos restaurados. Todas las pestañas son visibles.');
  } catch(e) {
    alert('❌ Error al restaurar: ' + e.message);
  }
}

async function guardarPermisosTabsAdmin() {
  var permisos = {};
  TABS_NAV.forEach(function(tab) { permisos[tab.id] = []; });
  document.querySelectorAll('#t-permisos-tabs input[type=checkbox]').forEach(function(cb) {
    if (cb.checked) permisos[cb.dataset.tab].push(cb.dataset.perfil);
  });
  permisos._order = TABS_NAV.map(function(t) { return t.id; });
  permisos._perfiles = PERFILES_SISTEMA.slice();
  var btn = document.querySelector('button[onclick="guardarPermisosTabsAdmin()"]');
  if (btn) { btn.textContent = '⏳ Guardando...'; btn.disabled = true; }
  try {
    const resp = await apiDashboard('POST', 'permisos', { permisos });
    if (!resp.success) throw new Error(resp.error || 'Error al guardar');
    sessionStorage.setItem('af_tab_permisos', JSON.stringify(permisos));
    aplicarPermisosNavTabs();
    if (btn) { btn.textContent = '✅ Guardado'; btn.style.background='#1565c0'; btn.disabled=false; setTimeout(function(){ btn.textContent='💾 Guardar Cambios'; btn.style.background='#43a047'; }, 2000); }
  } catch(e) {
    if (btn) { btn.textContent = '❌ Error'; btn.style.background='#e53935'; btn.disabled=false; setTimeout(function(){ btn.textContent='💾 Guardar Cambios'; btn.style.background='#43a047'; }, 2500); }
    console.error('Error guardando permisos:', e);
  }
}

function estadoBadge(estado) {
  const C = {
    'ACTIVO':          {bg:'#e8f5e9',txt:'#2e7d32'},
    'BLOQUEADO':       {bg:'#ffebee',txt:'#c62828'},
    'SUSPENDIDO':      {bg:'#fff3e0',txt:'#e65100'},
    'NUNCA INGRESADO': {bg:'#e3f2fd',txt:'#1565c0'},
  };
  const c = C[estado] || {bg:'#f5f5f5',txt:'#666'};
  return '<span style="background:'+c.bg+';color:'+c.txt+';padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">'+estado+'</span>';
}

// Cache local de usuarios para el admin (se recarga al abrir la vista)
window._usuariosAdmin = [];

async function renderTablaAdmin(filtro) {
  filtro = filtro || '';
  // Cargar desde API si no tenemos datos o es recarga forzada
  if (window._usuariosAdmin.length === 0) {
    const tbl = document.getElementById('t-admin-users');
    if (tbl) tbl.innerHTML = '<tr><td colspan="7" style="padding:20px;text-align:center;color:#7bafd4">Cargando...</td></tr>';
    try {
      const data = await apiUsuarios({ accion: 'listar' }, _sesionToken);
      if (data.ok) window._usuariosAdmin = data.usuarios;
    } catch(e) { console.error('Error cargando usuarios', e); }
  }

  const usuarios = window._usuariosAdmin;
  const q = filtro.toLowerCase();
  const filt = q ? usuarios.filter(function(u) {
    return u.nombre.toLowerCase().includes(q) || u.usuario.toLowerCase().includes(q) ||
           u.perfil.toLowerCase().includes(q)  || u.estado.toLowerCase().includes(q);
  }) : usuarios;

  var thead = '<thead><tr style="background:#1a3a6a;color:#fff;font-size:11px">' +
    '<th style="padding:8px;text-align:left">Nombre</th>' +
    '<th style="padding:8px;text-align:left">Usuario</th>' +
    '<th style="padding:8px;text-align:center">Perfil</th>' +
    '<th style="padding:8px;text-align:center">Estado</th>' +
    '<th style="padding:8px;text-align:center">Último Ingreso</th>' +
    '<th style="padding:8px;text-align:center">Acciones</th>' +
    '</tr></thead>';

  var tbody = filt.map(function(u) {
    var uEmail = encodeURIComponent(u.usuario);
    var ult = u.ultimoIngreso
      ? new Date(u.ultimoIngreso).toLocaleString('es-CL',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})
      : '—';
    var perfBg = u.perfil === 'ADMINISTRADOR' ? '#1a3a6a' : u.perfil === 'GERENTE GENERAL' ? '#4a1a6a' : u.perfil === 'SUPERVISOR' ? '#1a4a2a' : '#e3f2fd';
    var perfC  = u.perfil === 'ADMINISTRADOR' ? '#fff'   : u.perfil === 'GERENTE GENERAL' ? '#fff'   : u.perfil === 'SUPERVISOR' ? '#fff'   : '#1565c0';
    return '<tr style="border-bottom:1px solid #f0f2f5">' +
      '<td style="padding:7px 8px;font-weight:600">' + u.nombre + '</td>' +
      '<td style="padding:7px 8px;color:#555;font-size:11px">' + u.usuario + '</td>' +
      '<td style="padding:7px 8px;text-align:center"><span style="background:' + perfBg + ';color:' + perfC + ';padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">' + u.perfil + '</span></td>' +
      '<td style="padding:7px 8px;text-align:center">' + estadoBadge(u.estado) + '</td>' +
      '<td style="padding:7px 8px;text-align:center;font-size:11px;color:#888">' + ult + '</td>' +
      '<td style="padding:7px 8px;text-align:center;white-space:nowrap">' +
        '<button onclick="editarUsuario(\'' + u.usuario + '\')" style="background:#1565C0;color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;margin-right:3px">✏️ Editar</button>' +
        '<button onclick="resetClave(\'' + u.usuario + '\')" style="background:#fb8c00;color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;margin-right:3px">🔑 Reset</button>' +
        '<button onclick="eliminarUsuario(\'' + u.usuario + '\')" style="background:#e53935;color:#fff;border:none;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer">🗑</button>' +
      '</td></tr>';
  }).join('');

  var tots = {activo:0, bloqueado:0, suspendido:0, nunca:0};
  usuarios.forEach(function(u) {
    if (u.estado==='ACTIVO') tots.activo++;
    else if (u.estado==='BLOQUEADO') tots.bloqueado++;
    else if (u.estado==='SUSPENDIDO') tots.suspendido++;
    else tots.nunca++;
  });

  var tbl = document.getElementById('t-admin-users');
  if (tbl) tbl.innerHTML = thead + '<tbody>' + tbody + '</tbody>';

  var el = document.getElementById('admin-stats');
  if (!el) {
    el = document.createElement('div');
    el.id = 'admin-stats';
    var overflowDiv = tbl.parentElement;
    overflowDiv.parentElement.insertBefore(el, overflowDiv);
  }
  el.innerHTML = '<div style="display:flex;gap:12px;padding:8px 4px;font-size:11px">' +
    '<span style="color:#43a047">✅ ' + tots.activo + ' activos</span>' +
    '<span style="color:#1565c0">🆕 ' + tots.nunca + ' nunca ingresados</span>' +
    '<span style="color:#e53935">🔒 ' + tots.bloqueado + ' bloqueados</span>' +
    '<span style="color:#fb8c00">⏸ ' + tots.suspendido + ' suspendidos</span>' +
    '<span style="color:#888;margin-left:auto">Total: ' + usuarios.length + '</span></div>';
}

function filtrarUsuariosAdmin() {
  renderTablaAdmin(document.getElementById('admin-search') ? document.getElementById('admin-search').value : '');
}

function nuevoUsuario() {
  document.getElementById('modal-titulo').textContent = '➕ Nuevo Usuario';
  document.getElementById('edit-idx').value = '';
  document.getElementById('edit-nombre').value = '';
  document.getElementById('edit-usuario').value = '';
  document.getElementById('edit-clave').value = 'AF2026';
  document.getElementById('edit-perfil').value = 'USUARIO';
  document.getElementById('edit-estado').value = 'NUNCA INGRESADO';
  document.getElementById('lbl-clave').textContent = 'Contraseña inicial';
  document.getElementById('modal-usuario').style.display = 'flex';
  setTimeout(function() { document.getElementById('edit-nombre').focus(); }, 100);
}

function editarUsuario(email) {
  var u = window._usuariosAdmin.find(function(x) { return x.usuario === email; });
  if (!u) return;
  document.getElementById('modal-titulo').textContent = '✏️ Editar Usuario';
  document.getElementById('edit-idx').value = u.usuario;
  document.getElementById('edit-nombre').value = u.nombre;
  document.getElementById('edit-usuario').value = u.usuario;
  document.getElementById('edit-clave').value = '';
  document.getElementById('edit-perfil').value = u.perfil;
  document.getElementById('edit-estado').value = u.estado;
  document.getElementById('lbl-clave').textContent = 'Nueva contraseña (dejar vacío para no cambiar)';
  document.getElementById('modal-usuario').style.display = 'flex';
}

function cerrarModal() {
  document.getElementById('modal-usuario').style.display = 'none';
}

async function guardarUsuario() {
  var emailOriginal = document.getElementById('edit-idx').value;
  var nombre  = document.getElementById('edit-nombre').value.trim();
  var usuario = document.getElementById('edit-usuario').value.trim().toLowerCase();
  var clave   = document.getElementById('edit-clave').value.trim();
  var perfil  = document.getElementById('edit-perfil').value;
  var estado  = document.getElementById('edit-estado').value;

  if (!nombre || !usuario) { alert('Completa nombre y usuario.'); return; }
  if (!emailOriginal && !clave) { alert('Ingresa una contraseña inicial.'); return; }

  const body = { accion: 'guardar', usuario, nombre, perfil, estado };
  if (clave) body.clave = clave;

  try {
    const data = await apiUsuarios(body, _sesionToken);
    if (!data.ok) { alert('Error: ' + data.error); return; }
    alert(emailOriginal ? '✅ Usuario actualizado.' : '✅ Usuario "' + nombre + '" creado.');
    window._usuariosAdmin = []; // forzar recarga
    cerrarModal();
    await renderTablaAdmin();
  } catch(e) { alert('Error de conexión.'); }
}

async function resetClave(email) {
  if (!confirm('¿Resetear clave a AF2026 para ' + email + '?')) return;
  try {
    const data = await apiUsuarios({ accion: 'guardar', usuario: email, clave: 'AF2026', estado: 'NUNCA INGRESADO', primerIngreso: true }, _sesionToken);
    if (!data.ok) { alert('Error: ' + data.error); return; }
    alert('✅ Clave reseteada. El usuario deberá cambiarla al ingresar.');
    window._usuariosAdmin = [];
    await renderTablaAdmin();
  } catch(e) { alert('Error de conexión.'); }
}

async function eliminarUsuario(email) {
  var u = window._usuariosAdmin.find(function(x) { return x.usuario === email; });
  if (!confirm('¿Eliminar a "' + (u ? u.nombre : email) + '"? No se puede deshacer.')) return;
  try {
    const data = await apiUsuarios({ accion: 'eliminar', usuario: email }, _sesionToken);
    if (!data.ok) { alert('Error: ' + data.error); return; }
    window._usuariosAdmin = [];
    await renderTablaAdmin();
  } catch(e) { alert('Error de conexión.'); }
}

async function exportarUsuarios() {
  const data = await apiUsuarios({ accion: 'listar' }, _sesionToken);
  if (!data.ok) { alert('Error al exportar.'); return; }
  var csv = 'Nombre,Usuario,Perfil,Estado,Ultimo Ingreso\n' +
    data.usuarios.map(function(x) {
      return '"'+x.nombre+'","'+x.usuario+'","'+x.perfil+'","'+x.estado+'","'+(x.ultimoIngreso||'')+'"';
    }).join('\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = 'usuarios_autofacil.csv';
  a.click();
}

function mostrarModalCambioClave() {
  document.getElementById('modal-cambio-clave').style.display = 'flex';
  setTimeout(function() { document.getElementById('nueva-clave1').focus(); }, 100);
}

async function guardarNuevaClave() {
  var c1 = document.getElementById('nueva-clave1').value;
  var c2 = document.getElementById('nueva-clave2').value;
  var errEl = document.getElementById('cambio-error');
  if (c1.length < 6) { errEl.textContent = 'Mínimo 6 caracteres.'; errEl.style.display = 'block'; return; }
  if (c1 !== c2) { errEl.textContent = 'Las contraseñas no coinciden.'; errEl.style.display = 'block'; return; }

  try {
    const data = await apiUsuarios({ accion: 'cambiar-clave', usuario: sesionActual.usuario, nueva_clave: c1 });
    if (!data.ok) { errEl.textContent = data.error || 'Error al cambiar clave.'; errEl.style.display = 'block'; return; }
    document.getElementById('modal-cambio-clave').style.display = 'none';
    alert('✅ ¡Contraseña establecida correctamente!');
  } catch(e) {
    errEl.textContent = 'Error de conexión.';
    errEl.style.display = 'block';
  }
}
// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 3480
// ──────────────────────────────────────────────────────────────

// ======== VISTA 8: COMPARATIVO EJECUTIVOS ========
function buildV8() {
  const desde = document.getElementById('sel-desde')?.value || '';
  const hasta  = document.getElementById('sel-hasta')?.value  || '';

  // Calcular días faltantes y mes anterior
  const hoy = new Date();
  const diaHoy = hoy.getDate();
  const mesHoy = hoy.getMonth();
  const anioHoy = hoy.getFullYear();
  const ultimoDiaMesActual = new Date(anioHoy, mesHoy+1, 0).getDate();
  const diasFaltantes = ultimoDiaMesActual - diaHoy;
  const mesAnt = mesHoy === 0 ? 11 : mesHoy-1;
  const anioAnt = mesHoy === 0 ? anioHoy-1 : anioHoy;
  const ultimoDiaMesAnt = new Date(anioAnt, mesAnt+1, 0).getDate();
  const diaCorteAnt = ultimoDiaMesAnt - diasFaltantes;
  const mesAntKey = anioAnt+'-'+String(mesAnt+1).padStart(2,'0');
  const mesesN = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const fechaActStr = diaHoy+' '+mesesN[mesHoy]+' '+anioHoy;
  const fechaAntStr = diaCorteAnt+' '+mesesN[mesAnt]+' '+anioAnt;

  const infoEl = document.getElementById('v8-info-fecha');
  if (infoEl) infoEl.textContent =
    'Período actual: al '+fechaActStr+' | Mes anterior: al '+fechaAntStr+' ('+diasFaltantes+' días antes del cierre)';

  // Función para obtener el día de comparación de un registro
  // OTORGADOS → fecha_ot, resto → fecha_estado
  function getDia(r) {
    const est = r.estado_eval || '';
    const fecha = est === 'OTORGADO' ? r.fecha_ot : r.fecha_estado;
    if (!fecha || fecha === 'NO APLICA') return null;
    return parseInt(fecha.split('-')[2]);
  }

  // Filtrar período actual — solo el mes actual, con corte al día de hoy
  const mesActKey = anioHoy+'-'+String(mesHoy+1).padStart(2,'0');
  const tienenFechaAct = window.RAW_DATA.some(r => r.mes === mesActKey && r.fecha_estado && r.fecha_estado.length >= 10);
  const rowsAct = window.RAW_DATA.filter(r => {
    if (r.mes !== mesActKey) return false;
    if (!r.ejecutivo) return false;
    if (r.institucion !== 'AUTOFIN' && r.institucion !== 'UNIDAD DE CREDITO') return false;
    if (tienenFechaAct) {
      const dia = getDia(r);
      if (!dia) return false;
      return dia <= diaHoy;
    }
    return true;
  });

  // Filtrar mes anterior — usar fecha_ot para otorgados, fecha_estado para el resto
  const tienenFecha = window.RAW_DATA.some(r =>
    r.mes === mesAntKey && (r.fecha_estado || r.fecha_ot) && r.fecha_estado !== 'NO APLICA'
  );
  const rowsAnt = window.RAW_DATA.filter(r => {
    if (r.mes !== mesAntKey) return false;
    if (r.institucion !== 'AUTOFIN' && r.institucion !== 'UNIDAD DE CREDITO') return false;
    if (!r.ejecutivo) return false;
    if (tienenFecha) {
      const dia = getDia(r);
      if (!dia) return false;
      return dia <= diaCorteAnt;
    }
    return true;
  });

  // Poblar selector ejecutivos
  const ejSet = [...new Set(rowsAct.map(r => r.ejecutivo))].sort();
  const selEj = document.getElementById('v8-sel-ej');
  const selVal = selEj ? selEj.value : '';
  if (selEj) {
    selEj.innerHTML = '<option value="">Todos</option>' +
      ejSet.map(e => {
        const n = e.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
        return '<option value="'+e+'"'+(e===selVal?' selected':'')+'>'+n+'</option>';
      }).join('');
  }

  const ejFiltro = selEj ? selEj.value : '';
  const rAct = ejFiltro ? rowsAct.filter(r=>r.ejecutivo===ejFiltro) : rowsAct;
  const rAnt = ejFiltro ? rowsAnt.filter(r=>r.ejecutivo===ejFiltro) : rowsAnt;

  // Calcular métricas por institución
  // INGRESADAS = todos los estados
  // APROBADAS = APROBADO + OTORGADO
  // OTORGADAS = OTORGADO
  // PENDIENTE = PENDIENTE
  // RECHAZADAS = RECHAZADO
  function calcMetricas(rows) {
    const res = {};
    rows.forEach(r => {
      const inst = r.institucion === 'AUTOFIN' ? 'AUTOFIN' : 'UNIDAD';
      if (!res[inst]) res[inst] = {ing:0,apro:0,ot:0,pend:0,rec:0};
      const d = res[inst];
      const est = r.estado_eval || '';
      d.ing++;
      if (est === 'APROBADO' || est === 'OTORGADO') d.apro++;
      if (est === 'OTORGADO') d.ot++;
      if (est === 'PENDIENTE' || est === 'SOLICITUD EN EVALUACION') d.pend++;
      if (est === 'RECHAZADO') d.rec++;
    });
    return res;
  }

  const allEjs = [...new Set([...rAct.map(r=>r.ejecutivo), ...rAnt.map(r=>r.ejecutivo)])].sort();
  const ejsData = {};
  allEjs.forEach(ej => {
    ejsData[ej] = {
      act: calcMetricas(rAct.filter(r=>r.ejecutivo===ej)),
      ant: calcMetricas(rAnt.filter(r=>r.ejecutivo===ej))
    };
  });

  const insts = ['AUTOFIN','UNIDAD'];
  const diff = (a,b) => {
    const d = a-b;
    const c = d > 0 ? '#43a047' : d < 0 ? '#e53935' : '#888';
    return '<span style="color:'+c+';font-weight:600">'+(d>0?'+':'')+d+'</span>';
  };

  const thead = `<thead>
    <tr style="background:#1a3a6a;color:#fff;font-size:10px">
      <th rowspan="2" style="padding:6px 8px;text-align:left;min-width:180px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-right:1px solid #2a4070">Ejecutivo</th>
      <th rowspan="2" style="padding:6px 4px;text-align:center;border-right:1px solid #2a4070">Financiera</th>
      <th colspan="5" style="padding:6px;text-align:center;background:#1565C0;border-right:1px solid #2a4070">Al ${window._infoFechaJSON||fechaActStr}</th>
      <th colspan="5" style="padding:6px;text-align:center;background:#0d47a1;border-right:1px solid #2a4070">Al ${fechaAntStr}${!tienenFecha?' ⚠️':''}</th>
      <th colspan="5" style="padding:6px;text-align:center;background:#1a3a6a">Diferencia</th>
    </tr>
    <tr style="background:#1a3a6a;color:#aac4e8;font-size:10px">
      <th style="padding:4px 5px;background:#1565C0">Ing.</th>
      <th style="padding:4px 5px;background:#1565C0">Apro.</th>
      <th style="padding:4px 5px;background:#1565C0">Ot.</th>
      <th style="padding:4px 5px;background:#1565C0">Pend.</th>
      <th style="padding:4px 5px;background:#1565C0;border-right:1px solid #2a4070">Rec.</th>
      <th style="padding:4px 5px;background:#0d47a1">Ing.</th>
      <th style="padding:4px 5px;background:#0d47a1">Apro.</th>
      <th style="padding:4px 5px;background:#0d47a1">Ot.</th>
      <th style="padding:4px 5px;background:#0d47a1">Pend.</th>
      <th style="padding:4px 5px;background:#0d47a1;border-right:1px solid #2a4070">Rec.</th>
      <th style="padding:4px 5px">Ing.</th>
      <th style="padding:4px 5px">Apro.</th>
      <th style="padding:4px 5px">Ot.</th>
      <th style="padding:4px 5px">Pend.</th>
      <th style="padding:4px 5px">Rec.</th>
    </tr>
  </thead>`;

  let tbody = '';
  let tA = {ing:0,apro:0,ot:0,pend:0,rec:0};
  let tB = {ing:0,apro:0,ot:0,pend:0,rec:0};

  allEjs.forEach((ej, ejIdx) => {
    const d = ejsData[ej];
    const nombre = ej.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
    const bg = ejIdx%2===0 ? '#f8faff' : '#fff';

    insts.forEach((inst, instIdx) => {
      const a = d.act[inst]||{ing:0,apro:0,ot:0,pend:0,rec:0};
      const b = d.ant[inst]||{ing:0,apro:0,ot:0,pend:0,rec:0};
      if (instIdx===0) {
        tA.ing+=a.ing+((d.act['UNIDAD']||{}).ing||0);
        tA.apro+=a.apro+((d.act['UNIDAD']||{}).apro||0);
        tA.ot+=a.ot+((d.act['UNIDAD']||{}).ot||0);
        tA.pend+=a.pend+((d.act['UNIDAD']||{}).pend||0);
        tA.rec+=a.rec+((d.act['UNIDAD']||{}).rec||0);
        tB.ing+=b.ing+((d.ant['UNIDAD']||{}).ing||0);
        tB.apro+=b.apro+((d.ant['UNIDAD']||{}).apro||0);
        tB.ot+=b.ot+((d.ant['UNIDAD']||{}).ot||0);
        tB.pend+=b.pend+((d.ant['UNIDAD']||{}).pend||0);
        tB.rec+=b.rec+((d.ant['UNIDAD']||{}).rec||0);
      }
      const instC = inst==='AUTOFIN'?'#1565C0':'#ff7043';
      tbody += '<tr style="border-bottom:1px solid #f0f2f5;background:'+bg+'">';
      if (instIdx===0) {
        tbody += '<td rowspan="'+insts.length+'" style="padding:5px 8px;font-weight:700;font-size:11px;color:#1a3a6a;border-right:1px solid #e0e8f0;vertical-align:middle;max-width:180px;width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+nombre+'">'+nombre+'</td>';
      }
      tbody += '<td style="padding:4px 6px;text-align:center;border-right:1px solid #e0e8f0"><span style="background:'+instC+'22;color:'+instC+';padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">'+inst+'</span></td>';
      tbody += '<td style="text-align:center;padding:4px 5px">'+a.ing+'</td><td style="text-align:center;padding:4px 5px">'+a.apro+'</td><td style="text-align:center;padding:4px 5px;font-weight:700">'+a.ot+'</td><td style="text-align:center;padding:4px 5px">'+a.pend+'</td><td style="text-align:center;padding:4px 5px;border-right:1px solid #e0e8f0">'+a.rec+'</td>';
      tbody += '<td style="text-align:center;padding:4px 5px;color:#555">'+b.ing+'</td><td style="text-align:center;padding:4px 5px;color:#555">'+b.apro+'</td><td style="text-align:center;padding:4px 5px;font-weight:700;color:#555">'+b.ot+'</td><td style="text-align:center;padding:4px 5px;color:#555">'+b.pend+'</td><td style="text-align:center;padding:4px 5px;border-right:1px solid #e0e8f0;color:#555">'+b.rec+'</td>';
      tbody += '<td style="text-align:center;padding:4px 5px">'+diff(a.ing,b.ing)+'</td><td style="text-align:center;padding:4px 5px">'+diff(a.apro,b.apro)+'</td><td style="text-align:center;padding:4px 5px">'+diff(a.ot,b.ot)+'</td><td style="text-align:center;padding:4px 5px">'+diff(a.pend,b.pend)+'</td><td style="text-align:center;padding:4px 5px">'+diff(a.rec,b.rec)+'</td>';
      tbody += '</tr>';
    });
  });

  const tfootRow = '<tfoot><tr style="background:#1a3a6a;color:#fff;font-weight:700;font-size:11px">' +
    '<td colspan="2" style="padding:6px 8px">TOTAL</td>' +
    '<td style="text-align:center;padding:5px">'+tA.ing+'</td><td style="text-align:center;padding:5px">'+tA.apro+'</td><td style="text-align:center;padding:5px">'+tA.ot+'</td><td style="text-align:center;padding:5px">'+tA.pend+'</td><td style="text-align:center;padding:5px;border-right:1px solid #2a4070">'+tA.rec+'</td>' +
    '<td style="text-align:center;padding:5px">'+tB.ing+'</td><td style="text-align:center;padding:5px">'+tB.apro+'</td><td style="text-align:center;padding:5px">'+tB.ot+'</td><td style="text-align:center;padding:5px">'+tB.pend+'</td><td style="text-align:center;padding:5px;border-right:1px solid #2a4070">'+tB.rec+'</td>' +
    '<td style="text-align:center;padding:5px">'+diff(tA.ing,tB.ing)+'</td><td style="text-align:center;padding:5px">'+diff(tA.apro,tB.apro)+'</td><td style="text-align:center;padding:5px">'+diff(tA.ot,tB.ot)+'</td><td style="text-align:center;padding:5px">'+diff(tA.pend,tB.pend)+'</td><td style="text-align:center;padding:5px">'+diff(tA.rec,tB.rec)+'</td>' +
    '</tr></tfoot>';

  const tbl = document.getElementById('t-v8');
  if (tbl) tbl.innerHTML = thead + '<tbody>'+tbody+'</tbody>' + tfootRow;
}

// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 3689
// ──────────────────────────────────────────────────────────────

function mostrarListaOps() {
  const det = window._detOps || [];
  const lbl = document.getElementById('periodo-label')?.textContent || '';
  document.getElementById('modal-ops-titulo').textContent =
    'Operaciones Otorgadas — ' + lbl + ' (' + det.length + ' ops)';

  const thead = '<thead><tr style="background:#1a3a6a;color:#fff;font-size:11px">' +
    '<th style="padding:6px 8px;text-align:left">N° Operación</th>' +
    '<th style="padding:6px 8px">Institución</th>' +
    '<th style="padding:6px 8px">Dealer</th>' +
    '<th style="padding:6px 8px">Ejecutivo</th>' +
    '<th style="padding:6px 8px;text-align:right">Saldo Precio</th>' +
    '<th style="padding:6px 8px;text-align:center">Plazo</th>' +
    '<th style="padding:6px 8px;text-align:center">Tasa</th>' +
    '<th style="padding:6px 8px;text-align:right">Com. Dealer</th>' +
    '<th style="padding:6px 8px;text-align:center">Estado</th>' +
    '</tr></thead>';

  const rows = det.map((r,i) => {
    const ej = (r.ejecutivo||'').split(' ').slice(0,2).map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
    const ccs = (r.ccs||'').length > 25 ? (r.ccs||'').substring(0,25)+'…' : (r.ccs||'');
    const bg = i%2===0 ? '#f8faff' : '#fff';
    const instC = r.financiera==='AUTOFIN' ? '#1565C0' : '#ff7043';
    return '<tr style="border-bottom:1px solid #f0f2f5;background:'+bg+'">' +
      '<td style="padding:5px 8px;font-weight:700;color:#1a3a6a">' + r.op + '</td>' +
      '<td style="padding:5px 8px;text-align:center"><span style="background:'+instC+'22;color:'+instC+';padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">' + (r.financiera||'—') + '</span></td>' +
      '<td style="padding:5px 8px;font-size:11px">' + ccs + '</td>' +
      '<td style="padding:5px 8px;font-size:11px">' + ej + '</td>' +
      '<td style="padding:5px 8px;text-align:right">' + fN(r.saldo_precio) + '</td>' +
      '<td style="padding:5px 8px;text-align:center">' + (r.plazo||'—') + 'm</td>' +
      '<td style="padding:5px 8px;text-align:center">' + (r.tasa_cli ? (r.tasa_cli*100).toFixed(2)+'%' : '—') + '</td>' +
      '<td style="padding:5px 8px;text-align:right">$' + fN(r.com_dealer) + '</td>' +
      '<td style="padding:5px 8px;text-align:center"><span style="background:#e8f5e9;color:#2e7d32;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">OTORGADO</span></td>' +
      '</tr>';
  }).join('');

  const tfoot = '<tfoot><tr style="background:#1a3a6a;color:#fff;font-weight:700">' +
    '<td colspan="4" style="padding:6px 8px">Total</td>' +
    '<td style="padding:6px 8px;text-align:right">' + fN(det.reduce((a,r)=>a+r.saldo_precio,0)) + '</td>' +
    '<td colspan="2"></td>' +
    '<td style="padding:6px 8px;text-align:right">' + fN(det.reduce((a,r)=>a+r.com_dealer,0)) + '</td>' +
    '<td></td></tr></tfoot>';

  document.getElementById('t-modal-ops').innerHTML = thead + '<tbody>' + rows + '</tbody>' + tfoot;
  document.getElementById('modal-ops').style.display = 'flex';
}
// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 3821
// ──────────────────────────────────────────────────────────────

// ======== VISTA HISTORIA ========
function initVHist() {
  // Si RAW_DATA aún no está cargado, reintentar
  if (!window.RAW_DATA || window.RAW_DATA.length === 0) {
    setTimeout(initVHist, 300);
    return;
  }
  const mesesDisp = [...new Set(window.RAW_DATA.map(r=>r.mes))].sort();
  const mN = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const fmtM = k => { const [y,m]=k.split('-'); return mN[parseInt(m)-1]+' '+y; };

  ['hist-desde','hist-hasta'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    // Guardar valor actual antes de repoblar
    const prev = sel.value;
    sel.innerHTML = mesesDisp.map(m=>'<option value="'+m+'">'+fmtM(m)+'</option>').join('');
    if (prev && mesesDisp.includes(prev)) sel.value = prev;
  });

  // Default: 6 meses hasta el mes anterior
  const hoy = new Date();
  const hastaKey = new Date(hoy.getFullYear(), hoy.getMonth()-1, 1);
  const hastaStr = hastaKey.getFullYear()+'-'+String(hastaKey.getMonth()+1).padStart(2,'0');
  const desdeKey = new Date(hastaKey.getFullYear(), hastaKey.getMonth()-5, 1);
  const desdeStr = desdeKey.getFullYear()+'-'+String(desdeKey.getMonth()+1).padStart(2,'0');

  const sd = document.getElementById('hist-desde');
  const sh = document.getElementById('hist-hasta');
  if (sd) sd.value = mesesDisp.includes(desdeStr) ? desdeStr : mesesDisp[Math.max(0,mesesDisp.length-6)];
  if (sh) sh.value = mesesDisp.includes(hastaStr) ? hastaStr : mesesDisp[mesesDisp.length-1];

  buildVHist();
}

function buildVHist() {
  const desdeStr = document.getElementById('hist-desde').value;
  const hastaStr = document.getElementById('hist-hasta').value;
  if (!desdeStr || !hastaStr) return;

  // Filtrar por campo 'mes' (YYYY-MM) — siempre disponible
  const rows = window.RAW_DATA.filter(r => r.mes >= desdeStr && r.mes <= hastaStr);
  const nMeses = [...new Set(rows.map(r=>r.mes))].length;
  const infoEl = document.getElementById('hist-info');
  if (infoEl) infoEl.textContent = nMeses + ' meses — ' + rows.length + ' registros en el período';

  const rowsOt = rows.filter(r => r.estado_eval === 'OTORGADO');

  // Función para calcular semana del mes a partir del dia_mes
  function semana(dia) {
    const d = parseInt(dia);
    if (!d || isNaN(d) || d <= 0) return '4ª Semana (días 22+)';
    if (d <= 7)  return '1ª Semana (días 1-7)';
    if (d <= 14) return '2ª Semana (días 8-14)';
    if (d <= 21) return '3ª Semana (días 15-21)';
    return '4ª Semana (días 22+)';
  }

  // Orden días semana
  const DIAS_ORD = ['lunes','martes','miércoles','miercoles','jueves','viernes','sábado','sabado','domingo'];
  const DIAS_LABEL = {
    'lunes': 'Lunes', 'martes': 'Martes', 'miércoles': 'Miércoles',
    'miercoles': 'Miércoles', 'jueves': 'Jueves', 'viernes': 'Viernes',
    'sábado': 'Sábado', 'sabado': 'Sábado', 'domingo': 'Domingo'
  };
  const SEMS_ORD = ['1ª Semana (días 1-7)','2ª Semana (días 8-14)','3ª Semana (días 15-21)','4ª Semana (días 22+)'];

  function aggBy(arr, keyFn) {
    const res = {};
    arr.forEach(r => {
      const k = keyFn(r);
      if (!k) return;
      res[k] = (res[k] || 0) + 1;
    });
    return res;
  }

  function renderTableBar(tblId, data, ordered, labelFn, maxVal) {
    const tbl = document.getElementById(tblId);
    if (!tbl) return;
    const max = maxVal || Math.max(...Object.values(data), 1);
    const thead = '<thead><tr style="background:#1a3a6a;color:#fff;position:sticky;top:0;z-index:1">' +
      '<th style="padding:5px 8px;text-align:left;font-size:11px">Día</th>' +
      '<th style="padding:5px 8px;text-align:right;font-size:11px">Ops</th>' +
      '<th style="padding:5px 8px;text-align:right;font-size:11px">%</th>' +
      '<th style="padding:5px 8px;min-width:110px;font-size:11px">Barra</th>' +
      '</tr></thead>';
    const total = Object.values(data).reduce((a, b) => a + b, 0) || 1;
    const tbody = ordered
      .filter(k => data[k] !== undefined)
      .map((k, i) => {
        const v = data[k] || 0;
        const pct = (v / total * 100).toFixed(1);
        const barW = Math.round(parseFloat(pct) * 0.8); // proporcional al % real
        const bg = i % 2 === 0 ? '#f8faff' : '#fff';
        const isMax = v === max;
        return '<tr style="border-bottom:1px solid #f0f2f5;background:' + bg + '">' +
          '<td style="padding:4px 8px;font-size:11px;font-weight:600;color:#1a3a6a">' + (labelFn ? labelFn(k) : k) + '</td>' +
          '<td style="padding:4px 8px;text-align:right;font-size:12px;font-weight:700' + (isMax ? ';color:#1565C0' : '') + '">' + v + '</td>' +
          '<td style="padding:4px 8px;text-align:right;font-size:11px;color:#666">' + pct + '%</td>' +
          '<td style="padding:4px 8px">' +
            '<div style="width:100px;background:#e8edf5;border-radius:3px;height:10px">' +
              '<div style="background:#1565C0;height:10px;border-radius:3px;width:' + barW + 'px"></div>' +
            '</div>' +
          '</td>' +
          '</tr>';
      }).join('');
    const tfoot = '<tfoot><tr style="background:#1a3a6a;color:#fff;font-weight:700">' +
      '<td style="padding:5px 8px;font-size:11px">Total</td>' +
      '<td style="padding:5px 8px;text-align:right;font-size:11px">' + total + '</td>' +
      '<td colspan="2" style="padding:5px 8px;font-size:11px">100%</td>' +
      '</tr></tfoot>';
    tbl.innerHTML = thead + '<tbody>' + tbody + '</tbody>' + tfoot;
  }

  const nMesesSemana = nMeses;

  // ── Por día de la semana ──
  const diaSemanaNorm = r => {
    const d = (r.dia_semana || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (d === 'miercoles') return 'miércoles';
    if (d === 'sabado') return 'sábado';
    return r.dia_semana ? r.dia_semana.toLowerCase() : null;
  };
  const semanaDiasOrd = ['lunes','martes','miércoles','jueves','viernes','sábado','domingo'];

  const aggIngSemana = aggBy(rows, diaSemanaNorm);
  const aggOtSemana  = aggBy(rowsOt, diaSemanaNorm);
  const maxSemana = Math.max(...semanaDiasOrd.map(d => Math.max(aggIngSemana[d]||0, aggOtSemana[d]||0)), 1);

  renderTableBar('t-hist-semana-ing', aggIngSemana, semanaDiasOrd,
    k => DIAS_LABEL[k] || k, maxSemana);
  renderTableBar('t-hist-semana-ot', aggOtSemana, semanaDiasOrd,
    k => DIAS_LABEL[k] || k, maxSemana);

  // ── Por semana del mes ──
  const aggIngSem = aggBy(rows, r => semana(r.dia_mes));
  const aggOtSem  = aggBy(rowsOt, r => semana(r.dia_mes));
  const maxSem = Math.max(...SEMS_ORD.map(s => Math.max(aggIngSem[s]||0, aggOtSem[s]||0)), 1);

  renderTableBar('t-hist-sem-ing', aggIngSem, SEMS_ORD, null, maxSem);
  renderTableBar('t-hist-sem-ot',  aggOtSem,  SEMS_ORD, null, maxSem);

  // Cuadro resumen: 4 semanas en 2 tablas lado a lado (1ª+2ª izq, 3ª+4ª der)
  const semResumen = [
    {key:'1ª Semana (días 1-7)',   ing: aggIngSem['1ª Semana (días 1-7)']||0,   ot: aggOtSem['1ª Semana (días 1-7)']||0},
    {key:'2ª Semana (días 8-14)',  ing: aggIngSem['2ª Semana (días 8-14)']||0,  ot: aggOtSem['2ª Semana (días 8-14)']||0},
    {key:'3ª Semana (días 15-21)', ing: aggIngSem['3ª Semana (días 15-21)']||0, ot: aggOtSem['3ª Semana (días 15-21)']||0},
    {key:'4ª Semana (días 22+)',   ing: aggIngSem['4ª Semana (días 22+)']||0,   ot: aggOtSem['4ª Semana (días 22+)']||0},
  ];
  function renderSemProm(tblId, items, n) {
    const tbl = document.getElementById(tblId);
    if (!tbl) return;
    const th = '<thead><tr style="background:#1a3a6a;color:#fff;font-size:11px">' +
      '<th style="padding:5px 8px;text-align:left">Semana</th>' +
      '<th style="padding:5px 8px;text-align:center;color:#90caf9">Ingresados</th>' +
      '<th style="padding:5px 8px;text-align:center;color:#a5d6a7">Otorgados</th>' +
      '</tr></thead>';
    const promIng = items.map(r => r.ing/n);
    const promOt  = items.map(r => r.ot/n);
    const maxI = Math.max(...promIng);
    const maxO = Math.max(...promOt);
    const tb = items.map((r,i) => {
      const bg = i%2===0?'#f8faff':'#fff';
      const boldI = promIng[i]===maxI ? ';color:#1565C0' : '';
      const boldO = promOt[i]===maxO  ? ';color:#43a047' : '';
      return '<tr style="border-bottom:1px solid #f0f2f5;background:'+bg+'">' +
        '<td style="padding:4px 8px;font-size:11px;font-weight:600;color:#1a3a6a">'+r.key+'</td>' +
        '<td style="padding:4px 8px;text-align:center;font-size:12px;font-weight:700'+boldI+'">'+(r.ing/n).toFixed(1)+'</td>' +
        '<td style="padding:4px 8px;text-align:center;font-size:12px;font-weight:700'+boldO+'">'+(r.ot/n).toFixed(1)+'</td>' +
        '</tr>';
    }).join('');
    tbl.innerHTML = th + '<tbody>' + tb + '</tbody>';
  }
  renderSemProm('t-hist-sem-prom-izq', semResumen.slice(0,2), nMesesSemana);
  renderSemProm('t-hist-sem-prom-der', semResumen.slice(2,4), nMesesSemana);

  // ── Por día del mes (1–31) ──
  const diasMesOrd = Array.from({length: 31}, (_, i) => String(i + 1));
  const aggIngDia = aggBy(rows, r => r.dia_mes ? String(r.dia_mes) : null);
  const aggOtDia  = aggBy(rowsOt, r => r.dia_mes ? String(r.dia_mes) : null);
  const maxDia = Math.max(...diasMesOrd.map(d => Math.max(aggIngDia[d]||0, aggOtDia[d]||0)), 1);

  renderTableBar('t-hist-dia-ing', aggIngDia, diasMesOrd.filter(d => aggIngDia[d]),
    k => 'Día ' + k, maxDia);
  renderTableBar('t-hist-dia-ot',  aggOtDia,  diasMesOrd.filter(d => aggOtDia[d]),
    k => 'Día ' + k, maxDia);
}

// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 4049
// ──────────────────────────────────────────────────────────────
// ======== PRESUPUESTO ========

// Presupuesto: la fuente real vive en dashboard_config (GET /api/dashboard/presupuesto),
// editable sin tocar código. Este arreglo es solo respaldo si la API falla.
let PPTO_DATA = [
  {mes:"2026-01", ops:91,  monto:618.8},
  {mes:"2026-02", ops:91,  monto:618.8},
  {mes:"2026-03", ops:109, monto:741.2},
  {mes:"2026-04", ops:133, monto:904.4},
  {mes:"2026-05", ops:161, monto:1094.8},
  {mes:"2026-06", ops:169, monto:1149.2},
  {mes:"2026-07", ops:177, monto:1203.6},
  {mes:"2026-08", ops:181, monto:1230.8},
  {mes:"2026-09", ops:181, monto:1230.8},
  {mes:"2026-10", ops:181, monto:1230.8},
  {mes:"2026-11", ops:181, monto:1230.8},
  {mes:"2026-12", ops:181, monto:1230.8},
];

// Cargar presupuesto desde BD (sobrescribe el respaldo); re-renderiza si la pestaña ya está visible
(async function cargarPresupuesto() {
  try {
    const j = await apiDashboard('GET', 'presupuesto');
    if (j && j.success && Array.isArray(j.data) && j.data.length) {
      PPTO_DATA = j.data;
      if (window.RAW_DATA && window.RAW_DATA.length) buildVPpto();
    }
  } catch (e) { /* se mantiene el respaldo */ }
})();

const MES_LABELS_PPTO = {
  "2025-01":"Ene 25","2025-02":"Feb 25","2025-03":"Mar 25","2025-04":"Abr 25",
  "2025-05":"May 25","2025-06":"Jun 25","2025-07":"Jul 25","2025-08":"Ago 25",
  "2025-09":"Sep 25","2025-10":"Oct 25","2025-11":"Nov 25","2025-12":"Dic 25",
  "2026-01":"Ene 26","2026-02":"Feb 26","2026-03":"Mar 26","2026-04":"Abr 26",
  "2026-05":"May 26","2026-06":"Jun 26","2026-07":"Jul 26","2026-08":"Ago 26",
  "2026-09":"Sep 26","2026-10":"Oct 26","2026-11":"Nov 26","2026-12":"Dic 26",
};
// Label dinámico para cualquier año (fallback si no está en MES_LABELS_PPTO)
function lblPpto(mk){
  const p = String(mk).split('-'); if (p.length<2) return mk;
  const N = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return N[parseInt(p[1])-1] + ' ' + p[0].slice(2);
}
// Año del presupuesto a mostrar en el dashboard (editable: selector futuro). Default = año actual.
let PPTO_ANIO = null;

function buildVPpto() {
  if (!window.RAW_DATA || window.RAW_DATA.length === 0) {
    setTimeout(buildVPpto, 300); return;
  }

  const hoy = new Date();
  const mesActual = hoy.getFullYear() + '-' + String(hoy.getMonth()+1).padStart(2,'0');

  // Presupuesto: mostrar solo el año vigente (o PPTO_ANIO si se selecciona).
  // Si el año vigente no tiene presupuesto cargado, usar el último año disponible.
  const aniosPpto = [...new Set(PPTO_DATA.map(d => String(d.mes).slice(0,4)))].sort();
  const anioVista = PPTO_ANIO
    || (aniosPpto.includes(mesActual.slice(0,4)) ? mesActual.slice(0,4) : (aniosPpto[aniosPpto.length-1] || mesActual.slice(0,4)));
  const PPTO_DATA_VISTA = PPTO_DATA.filter(d => String(d.mes).slice(0,4) === anioVista);

  // Calcular reales desde RAW_DATA (solo OTORGADOS)
  const realesPorMes = {};
  window.RAW_DATA.filter(r => r.estado_eval === 'OTORGADO').forEach(r => {
    if (!realesPorMes[r.mes]) realesPorMes[r.mes] = {ops:0, monto:0};
    realesPorMes[r.mes].ops++;
    realesPorMes[r.mes].monto += (r.monto_financiado || 0) / 1e6; // a MM$
  });

  // Función color cumplimiento
  function colorCump(pct) {
    if (pct === null) return {bg:'#f0f2f5', txt:'#999', label:'—'};
    if (pct >= 1.0)   return {bg:'#e8f5e9', txt:'#2e7d32', label: (pct*100).toFixed(1)+'%'};
    if (pct >= 0.75)  return {bg:'#fff3e0', txt:'#e65100', label: (pct*100).toFixed(1)+'%'};
    return              {bg:'#ffebee', txt:'#c62828', label: (pct*100).toFixed(1)+'%'};
  }

  // ── Construir tabla genérica (ops o montos) ──
  function buildPptoTable(tblId, campo, fmtFn) {
    const tbl = document.getElementById(tblId);
    if (!tbl) return;

    // Solo meses con presupuesto
    const meses = PPTO_DATA_VISTA.map(d => d.mes);

    // Calcular acumulados
    let pptoAcum = 0, realAcum = 0;
    const rows_data = PPTO_DATA_VISTA.map(d => {
      const real = realesPorMes[d.mes] ? realesPorMes[d.mes][campo === 'ops' ? 'ops' : 'monto'] : null;
      const ppto = d[campo === 'ops' ? 'ops' : 'monto'];
      pptoAcum += ppto;
      if (real !== null && real !== undefined) realAcum += real;
      const tieneReal = real !== null && real !== undefined;
      const cump_mens = tieneReal ? real / ppto : null;
      const cump_acum = tieneReal ? realAcum / pptoAcum : null;
      const esMesActual = d.mes === mesActual;
      const esFuturo = d.mes > mesActual;
      return { mes: d.mes, ppto, real: tieneReal ? real : null, pptoAcum, realAcum: tieneReal ? realAcum : null, cump_mens, cump_acum, esMesActual, esFuturo };
    });

    // Totales
    // Total anual presupuesto (12 meses)
    const totalPptoAnio = PPTO_DATA_VISTA.reduce((a,d) => a + d[campo==='ops'?'ops':'monto'], 0);
    // Total real solo meses con datos
    const mesesConDatos = rows_data.filter(d => d.real !== null);
    const totalRealAcum = mesesConDatos.length > 0 ? mesesConDatos[mesesConDatos.length-1].realAcum : 0;
    const totalPptoAcum = mesesConDatos.length > 0 ? mesesConDatos[mesesConDatos.length-1].pptoAcum : 0;
    // Total Mensual = suma real solo meses con datos
    const totalMensualReal = mesesConDatos.reduce((a,d) => a + d.real, 0);
    const totalMensualPpto = mesesConDatos.reduce((a,d) => a + d.ppto, 0);
    const cumpMensualTotal = totalMensualPpto > 0 ? totalMensualReal / totalMensualPpto : null;
    const cumpAcumTotal    = totalPptoAnio   > 0 ? totalRealAcum    / totalPptoAnio    : null;

    // Header con nombres de meses
    let thead = '<thead>';
    // Fila 1: labels de meses
    thead += '<tr style="background:#1a3a6a;color:#fff;font-size:10px">';
    thead += '<th style="padding:5px 10px;text-align:left;min-width:120px;position:sticky;left:0;background:#1a3a6a;z-index:2">Período / Producto</th>';
    meses.forEach(m => {
      const isCurrent = m === mesActual;
      const bg = isCurrent ? '#1565C0' : '#1a3a6a';
      thead += `<th style="padding:5px 6px;text-align:center;min-width:70px;background:${bg};border-left:1px solid #2a4070">${MES_LABELS_PPTO[m]||lblPpto(m)}${isCurrent?' 📍':''}</th>`;
    });
    thead += '<th style="padding:5px 8px;text-align:center;min-width:80px;background:#0d47a1;border-left:2px solid #4fc3f7">TOTAL</th>';
    thead += '</tr></thead>';

    // Filas: Mensual Presupuesto / Real / Cumplimiento y Acumulado idem
    const sections = [
      { label: 'MENSUAL', rows: [
        { lbl: 'Brokerage — Presupuesto', key: 'ppto',     style: 'color:#90caf9;font-style:italic' },
        { lbl: 'Brokerage — Real',        key: 'real',     style: 'font-weight:700;color:#fff' },
        { lbl: 'Cumplimiento',            key: 'cump_mens',style: 'font-weight:700' },
      ]},
      { label: 'ACUMULADO', rows: [
        { lbl: 'Brokerage — Presupuesto', key: 'pptoAcum',  style: 'color:#90caf9;font-style:italic' },
        { lbl: 'Brokerage — Real',        key: 'realAcum',  style: 'font-weight:700;color:#fff' },
        { lbl: 'Cumplimiento',            key: 'cump_acum', style: 'font-weight:700' },
      ]},
    ];

    let tbody = '<tbody>';
    sections.forEach((sec, si) => {
      // Separador de sección
      tbody += `<tr style="background:#0d2140"><td colspan="${meses.length+2}" style="padding:4px 10px;font-size:10px;font-weight:700;color:#4fc3f7;letter-spacing:.5px;position:sticky;left:0">${sec.label}</td></tr>`;

      sec.rows.forEach(row => {
        const isCump = row.key === 'cump_mens' || row.key === 'cump_acum';
        tbody += `<tr style="border-bottom:1px solid #0d2140;background:#1a2a4a">`;
        tbody += `<td style="padding:4px 10px;font-size:11px;${row.style};position:sticky;left:0;background:#1a2a4a;z-index:1;border-right:1px solid #2a4070">${row.lbl}</td>`;

        meses.forEach((m, mi) => {
          const d = rows_data[mi];
          const isCurrent = m === mesActual;
          const bg = isCurrent ? '#0d2d5a' : '#1a2a4a';

          if (isCump) {
            const pct = d[row.key];
            if (pct === null) {
              tbody += `<td style="padding:4px 6px;text-align:center;background:${bg};border-left:1px solid #0d2140;color:#555">—</td>`;
            } else {
              const c = colorCump(pct);
              tbody += `<td style="padding:4px 6px;text-align:center;background:${bg};border-left:1px solid #0d2140">`;
              tbody += `<span style="background:${c.bg};color:${c.txt};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700">${c.label}</span>`;
              tbody += `</td>`;
            }
          } else {
            const val = d[row.key];
            const display = val === null ? (d.esFuturo ? '<span style="color:#444">—</span>' : '<span style="color:#e53935;font-size:11px">Sin datos</span>') : fmtFn(val);
            const color = row.key === 'real' || row.key === 'realAcum' ? '#fff' : '#90caf9';
            tbody += `<td style="padding:5px 6px;text-align:center;background:${bg};border-left:1px solid #0d2140;color:${color};font-size:13px;font-weight:600">${display}</td>`;
          }
        });

        // Columna total
        if (isCump) {
          const pct = si === 0 ? cumpMensualTotal : cumpAcumTotal;
          const c = colorCump(pct);
          tbody += `<td style="padding:4px 8px;text-align:center;background:#112060;border-left:2px solid #4fc3f7">`;
          if (pct !== null) tbody += `<span style="background:${c.bg};color:${c.txt};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700">${c.label}</span>`;
          else tbody += '—';
          tbody += `</td>`;
        } else {
          // Mensual: solo suma hasta meses con datos. Acumulado: último valor acumulado
          let val, color;
          if (row.key === 'ppto') {
            val = fmtFn(totalMensualPpto); color = '#90caf9';
          } else if (row.key === 'real') {
            val = fmtFn(totalMensualReal); color = '#fff';
          } else if (row.key === 'pptoAcum') {
            val = fmtFn(totalPptoAnio); color = '#90caf9';
          } else { // realAcum
            val = fmtFn(totalRealAcum); color = '#fff';
          }
          tbody += `<td style="padding:5px 8px;text-align:center;background:#112060;border-left:2px solid #4fc3f7;color:${color};font-size:13px;font-weight:700">${val}</td>`;
        }
        tbody += `</tr>`;
      });
    });

    // Fila LOGRADO / FALTA — usa diferencia acumulada por mes
    tbody += `<tr style="background:#0a1a38;border-top:2px solid #4fc3f7">`;
    tbody += `<td style="padding:5px 10px;font-size:11px;font-weight:700;color:#4fc3f7;position:sticky;left:0;background:#0a1a38;z-index:1" colspan="1">LOGRADO / FALTA</td>`;
    meses.forEach((m, mi) => {
      const d = rows_data[mi];
      const isCurrent = m === mesActual;
      const bg = isCurrent ? '#0a2050' : '#0a1a38';
      if (d.realAcum !== null) {
        const dif = d.realAcum - d.pptoAcum;
        const c = dif >= 0 ? '#43a047' : '#e53935';
        const lbl = fmtFn(Math.abs(dif));
        tbody += `<td style="padding:5px 6px;text-align:center;background:${bg};border-left:1px solid #0d2140">`;
        tbody += `<span style="color:${c};font-weight:700;font-size:13px">${dif>=0?'+':'-'}${lbl}</span>`;
        tbody += `</td>`;
      } else {
        tbody += `<td style="padding:5px 6px;background:${bg};border-left:1px solid #0d2140;color:#444;text-align:center">—</td>`;
      }
    });
    // Total: real acumulado vs presupuesto anual completo
    const difTotal = totalRealAcum - totalPptoAnio;
    const cDif = difTotal >= 0 ? '#43a047' : '#e53935';
    tbody += `<td style="padding:5px 8px;text-align:right;background:#0a1a38;border-left:2px solid #4fc3f7">`;
    tbody += `<span style="color:${cDif};font-weight:700;font-size:13px">${difTotal>=0?'+':'-'}${fmtFn(Math.abs(difTotal))}</span>`;
    tbody += `</td></tr>`;
    tbody += '</tbody>';

    tbl.innerHTML = thead + tbody;
  }

  // Formatear número entero
  const fmtOps = v => Math.round(v).toString();
  // Formatear MM$ con 1 decimal
  const fmtMM = v => v.toFixed(1);

  buildPptoTable('t-ppto-ops',    'ops',   fmtOps);
  buildPptoTable('t-ppto-montos', 'monto', fmtMM);

  // ── KPIs ──
  const mesesConReal = PPTO_DATA_VISTA.filter(d => realesPorMes[d.mes]);
  const totalPptoOps = PPTO_DATA_VISTA.reduce((a,d) => a+d.ops, 0);
  const totalRealOps = mesesConReal.reduce((a,d) => a+(realesPorMes[d.mes]?.ops||0), 0);
  const pptoAcumOps  = mesesConReal.reduce((a,d) => a+d.ops, 0);
  const cumpAcumOps  = pptoAcumOps > 0 ? totalRealOps / pptoAcumOps : 0;

  const totalPptoMonto = PPTO_DATA_VISTA.reduce((a,d) => a+d.monto, 0);
  const totalRealMonto = mesesConReal.reduce((a,d) => a+(realesPorMes[d.mes]?.monto||0), 0);
  const pptoAcumMonto  = mesesConReal.reduce((a,d) => a+d.monto, 0);
  const cumpAcumMonto  = pptoAcumMonto > 0 ? totalRealMonto / pptoAcumMonto : 0;

  const faltaOps   = totalPptoOps   - totalRealOps;
  const faltaMonto = totalPptoMonto - totalRealMonto;

  function kpiBox(label, val, sub, highlight) {
    return `<div class="kpi-box${highlight?' highlight':''}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-val big">${val}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;
  }
  function pctBadge(pct) {
    if (pct >= 1.0) return `<span class="pct-ok">${(pct*100).toFixed(1)}%</span>`;
    if (pct >= 0.75) return `<span class="pct-warn">${(pct*100).toFixed(1)}%</span>`;
    return `<span class="pct-bad">${(pct*100).toFixed(1)}%</span>`;
  }

  const kpisEl = document.getElementById('ppto-kpis');
  if (kpisEl) {
    kpisEl.innerHTML =
      kpiBox('Créditos Otorgados', totalRealOps, `Ppto año: ${totalPptoOps}`, true) +
      kpiBox('Cumplim. Acum. Ops', pctBadge(cumpAcumOps), `Logrado: ${totalRealOps} / Meta acum: ${pptoAcumOps}`, false) +
      kpiBox('Falta (Ops)', (faltaOps > 0 ? '-' : '+')+Math.abs(Math.round(faltaOps)), faltaOps > 0 ? 'Por lograr en el año' : '¡Meta superada!', false) +
      kpiBox('Monto Colocado', totalRealMonto.toFixed(1)+' MM$', `Ppto año: ${totalPptoMonto.toFixed(1)} MM$`, true) +
      kpiBox('Cumplim. Acum. Monto', pctBadge(cumpAcumMonto), `Logrado: ${totalRealMonto.toFixed(1)} / Meta acum: ${pptoAcumMonto.toFixed(1)}`, false) +
      kpiBox('Falta (Monto)', (faltaMonto > 0 ? '-' : '+')+Math.abs(faltaMonto).toFixed(1)+' MM$', faltaMonto > 0 ? 'Por colocar en el año' : '¡Meta superada!', false);
  }
}
// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 4321
// ──────────────────────────────────────────────────────────────
// ======== EVOLUCIÓN HISTÓRICA ========
let evolChart = null;

function buildVEvol() {
  if (!window.RAW_DATA || window.RAW_DATA.length === 0) { setTimeout(buildVEvol, 300); return; }

  // Agrupar otorgados por mes e institución
  const mesesSet = new Set();
  const porMes = {};

  window.RAW_DATA.filter(r => r.estado_eval === 'OTORGADO').forEach(r => {
    const m = r.mes;
    const inst = (r.institucion || '').includes('UNIDAD') ? 'UNIDAD' : 'AUTOFIN';
    if (!porMes[m]) porMes[m] = { AUTOFIN: 0, UNIDAD: 0, monto_AUTOFIN: 0, monto_UNIDAD: 0 };
    porMes[m][inst]++;
    porMes[m]['monto_' + inst] += (r.monto_financiado || 0);
    mesesSet.add(m);
  });

  const meses = Array.from(mesesSet).sort();
  const labels = meses.map(m => {
    const [y, mo] = m.split('-');
    const mNames = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    return mNames[parseInt(mo)] + ' ' + y.slice(2);
  });

  // ── Tabla ──
  const thead = `<thead>
    <tr style="background:#1a3a6a;color:#fff;font-size:11px">
      <th style="padding:7px 12px;text-align:left;position:sticky;left:0;background:#1a3a6a;z-index:2;min-width:110px">Mes</th>
      <th style="padding:7px 10px;text-align:center;border-left:1px solid #2a4070">AUTOFIN Ops</th>
      <th style="padding:7px 10px;text-align:center;border-left:1px solid #2a4070">UNIDAD Ops</th>
      <th style="padding:7px 10px;text-align:center;border-left:1px solid #2a4070;background:#0d47a1">TOTAL Ops</th>
      <th style="padding:7px 10px;text-align:right;border-left:2px solid #4fc3f7">AUTOFIN M$</th>
      <th style="padding:7px 10px;text-align:right;border-left:1px solid #2a4070">UNIDAD M$</th>
      <th style="padding:7px 10px;text-align:right;border-left:1px solid #2a4070;background:#0d47a1">TOTAL M$</th>
    </tr></thead>`;

  let tbody = '<tbody>';
  let totAF=0, totUN=0, totMAF=0, totMUN=0;
  meses.forEach((m, i) => {
    const d = porMes[m] || {AUTOFIN:0,UNIDAD:0,monto_AUTOFIN:0,monto_UNIDAD:0};
    const total = d.AUTOFIN + d.UNIDAD;
    const mTotal = d.monto_AUTOFIN + d.monto_UNIDAD;
    totAF += d.AUTOFIN; totUN += d.UNIDAD; totMAF += d.monto_AUTOFIN; totMUN += d.monto_UNIDAD;
    const bg = i % 2 === 0 ? '#1a2a4a' : '#162238';
    const fmtM = v => (v/1e6).toFixed(1);
    tbody += `<tr style="background:${bg};border-bottom:1px solid #0d2140">
      <td style="padding:6px 12px;font-weight:600;color:#4fc3f7;position:sticky;left:0;background:${bg};z-index:1">${labels[i]}</td>
      <td style="padding:6px 10px;text-align:center;color:#90caf9;border-left:1px solid #0d2140;font-size:13px">${d.AUTOFIN}</td>
      <td style="padding:6px 10px;text-align:center;color:#90caf9;border-left:1px solid #0d2140;font-size:13px">${d.UNIDAD||'—'}</td>
      <td style="padding:6px 10px;text-align:center;color:#fff;font-weight:700;border-left:1px solid #0d2140;background:#112060;font-size:14px">${total}</td>
      <td style="padding:6px 10px;text-align:right;color:#80cbc4;border-left:2px solid #4fc3f7;font-size:13px">${fmtM(d.monto_AUTOFIN)}</td>
      <td style="padding:6px 10px;text-align:right;color:#80cbc4;border-left:1px solid #0d2140;font-size:13px">${d.UNIDAD ? fmtM(d.monto_UNIDAD) : '—'}</td>
      <td style="padding:6px 10px;text-align:right;color:#fff;font-weight:700;border-left:1px solid #0d2140;background:#112060;font-size:13px">${fmtM(mTotal)}</td>
    </tr>`;
  });

  // Fila total
  const totOps = totAF + totUN;
  const totM = totMAF + totMUN;
  const fmtM = v => (v/1e6).toFixed(1);
  tbody += `<tr style="background:#0a1a38;border-top:2px solid #4fc3f7;font-weight:700">
    <td style="padding:7px 12px;color:#4fc3f7;position:sticky;left:0;background:#0a1a38;z-index:1">TOTAL</td>
    <td style="padding:7px 10px;text-align:center;color:#4fc3f7;border-left:1px solid #0d2140;font-size:14px">${totAF}</td>
    <td style="padding:7px 10px;text-align:center;color:#4fc3f7;border-left:1px solid #0d2140;font-size:14px">${totUN}</td>
    <td style="padding:7px 10px;text-align:center;color:#fff;border-left:1px solid #0d2140;background:#112060;font-size:15px">${totOps}</td>
    <td style="padding:7px 10px;text-align:right;color:#4fc3f7;border-left:2px solid #4fc3f7;font-size:13px">${fmtM(totMAF)}</td>
    <td style="padding:7px 10px;text-align:right;color:#4fc3f7;border-left:1px solid #0d2140;font-size:13px">${fmtM(totMUN)}</td>
    <td style="padding:7px 10px;text-align:right;color:#fff;border-left:1px solid #0d2140;background:#112060;font-size:14px">${fmtM(totM)}</td>
  </tr></tbody>`;

  document.getElementById('t-evol').innerHTML = thead + tbody;

  // ── KPIs ──
  const promOps = Math.round(totOps / meses.length);
  const maxMes = meses.reduce((a,m) => ((porMes[m]?.AUTOFIN||0)+(porMes[m]?.UNIDAD||0)) > ((porMes[a]?.AUTOFIN||0)+(porMes[a]?.UNIDAD||0)) ? m : a, meses[0]);
  const maxOps = (porMes[maxMes]?.AUTOFIN||0) + (porMes[maxMes]?.UNIDAD||0);
  const maxLabel = labels[meses.indexOf(maxMes)];
  const ultimoMes = meses[meses.length-1];
  const ultimoOps = (porMes[ultimoMes]?.AUTOFIN||0) + (porMes[ultimoMes]?.UNIDAD||0);
  const ultimoLabel = labels[labels.length-1];

  document.getElementById('evol-kpis').innerHTML = `
    <div class="kpi-box highlight"><div class="kpi-label">Total Histórico Ops</div><div class="kpi-val big">${totOps}</div><div class="kpi-sub">${meses.length} meses</div></div>
    <div class="kpi-box"><div class="kpi-label">Promedio Mensual</div><div class="kpi-val big">${promOps}</div><div class="kpi-sub">ops/mes</div></div>
    <div class="kpi-box"><div class="kpi-label">Mejor Mes</div><div class="kpi-val big">${maxOps}</div><div class="kpi-sub">${maxLabel}</div></div>
    <div class="kpi-box highlight"><div class="kpi-label">Monto Total Histórico</div><div class="kpi-val big">${fmtM(totM)} MM$</div><div class="kpi-sub">${meses.length} meses</div></div>
    <div class="kpi-box"><div class="kpi-label">Último Mes (${ultimoLabel})</div><div class="kpi-val big">${ultimoOps}</div><div class="kpi-sub">ops otorgadas</div></div>
  `;

  // ── Gráfico ──
  const totalOpsArr = meses.map(m => (porMes[m]?.AUTOFIN||0) + (porMes[m]?.UNIDAD||0));
  const totalMontoArr = meses.map(m => ((porMes[m]?.monto_AUTOFIN||0) + (porMes[m]?.monto_UNIDAD||0)) / 1e6);

  if (evolChart) { evolChart.destroy(); evolChart = null; }

  const ctx = document.getElementById('evol-chart').getContext('2d');
  evolChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Operaciones Otorgadas (Total)',
          data: totalOpsArr,
          borderColor: '#90a4ae',
          backgroundColor: 'rgba(144,164,174,0.1)',
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: '#90a4ae',
          tension: 0.3,
          yAxisID: 'y',
        },
        {
          label: 'Monto Financiado (MM$)',
          data: totalMontoArr,
          borderColor: '#4caf50',
          backgroundColor: 'rgba(76,175,80,0.1)',
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: '#4caf50',
          tension: 0.3,
          yAxisID: 'y2',
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#aac4e8', font: { size: 11 } } },
        tooltip: { backgroundColor: '#1a2a4a', titleColor: '#4fc3f7', bodyColor: '#fff' }
      },
      scales: {
        x: { ticks: { color: '#7bafd4', font: { size: 10 } }, grid: { color: '#1e3050' } },
        y: {
          position: 'left',
          title: { display: true, text: 'Operaciones', color: '#90a4ae' },
          ticks: { color: '#90a4ae' },
          grid: { color: '#1e3050' }
        },
        y2: {
          position: 'right',
          title: { display: true, text: 'Monto MM$', color: '#4caf50' },
          ticks: { color: '#4caf50', callback: v => v.toFixed(0) + ' MM$' },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });
}
// ──────────────────────────────────────────────────────────────
// BLOQUE ORIGINAL línea 4509
// ──────────────────────────────────────────────────────────────
// ======== MODAL DETALLE EJECUTIVO ========
let _modalData = { ops: [], titulo: '', totSaldo: 0, totFin: 0, totCD: 0, totIng: 0 };

function abrirDetalleEjecutivo(nombre, tipo) {
  const desde = document.getElementById('sel-desde')?.value || '';
  const hasta  = document.getElementById('sel-hasta')?.value  || '';

  // Filtrar RAW_DATA según tipo
  // Usar fecha_otorgado si existe (igual que comisiones), si no usar mes
  let ops = (window.RAW_DATA || []).filter(r => {
    const mesRef = (r.fecha_otorgado || r.fecha_ot) ? (r.fecha_otorgado || r.fecha_ot).slice(0,7) : r.mes;
    return r.ejecutivo === nombre && mesRef >= desde && mesRef <= hasta;
  });
  if (tipo === 'ot') {
    ops = ops.filter(r => r.estado_eval === 'OTORGADO');
  } else {
    // aprobados: todos menos rechazados y anulados
    ops = ops.filter(r => !['RECHAZADO','ANULADO'].includes(r.estado_eval));
  }

  const fM = n => {
    const v = parseFloat(n)||0;
    if (Math.abs(v) >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + Math.round(v/1e3) + 'K';
    return '$' + Math.round(v);
  };

  // KPIs resumen
  const totFin  = ops.reduce((a,r) => a + (parseFloat(r.monto_financiado)||0), 0);
  const totSaldo= ops.reduce((a,r) => a + (parseFloat(r.saldo_precio)||0), 0);
  const totCD   = ops.reduce((a,r) => a + (parseFloat(r.com_dealer)||0), 0);
  const totIng  = ops.reduce((a,r) => a + (parseFloat(r.rentab_afa)||0), 0);
  document.getElementById('modal-ejec-kpis').innerHTML = `
    <div class="mekpi"><div class="mekpi-lbl">Operaciones</div><div class="mekpi-val">${ops.length}</div></div>
    <div class="mekpi"><div class="mekpi-lbl">Total Financiado</div><div class="mekpi-val">${fM(totFin)}</div></div>
    <div class="mekpi"><div class="mekpi-lbl">Saldo Precio</div><div class="mekpi-val">${fM(totSaldo)}</div></div>
    <div class="mekpi"><div class="mekpi-lbl">Com. Dealer</div><div class="mekpi-val">${fM(totCD)}</div></div>
    <div class="mekpi"><div class="mekpi-lbl">Ing. x Colocaciones</div><div class="mekpi-val">${fM(totIng)}</div></div>`;

  // Filas de operaciones — ordenar por saldo desc
  ops.sort((a,b) => (parseFloat(b.saldo_precio)||0) - (parseFloat(a.saldo_precio)||0));
  const body = ops.map(r => {
    const ccs = (r.automotora||'—');
    const fin = r.financiera || '—';
    const nc  = r.id_financiera || '—';
    return `<tr>
      <td>${r.op||'—'}</td>
      <td>${nc}</td>
      <td><span class="${fin==='AUTOFIN'?'tag-men':'tag-may'}">${fin}</span></td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis">${ccs.length>26?ccs.substring(0,26)+'…':ccs}</td>
      <td><span class="${r.estado_eval==='OTORGADO'?'pct-ok':r.estado_eval==='APROBADO'?'pct-hi':'pct-warn'}">${r.estado_eval||'—'}</span></td>
      <td>${fM(r.saldo_precio)}</td>
      <td>${fM(r.monto_financiado)}</td>
      <td>${r.plazo||'—'}</td>
      <td>${fM(r.com_dealer)}</td>
      <td>${fM(r.rentab_afa)}</td>
    </tr>`;
  }).join('');
  document.getElementById('t-modal-ops-body').innerHTML = body || '<tr><td colspan="10" style="text-align:center;color:#888;padding:12px">Sin operaciones</td></tr>';
  document.getElementById('t-modal-ops-foot').innerHTML = `<tr>
    <td colspan="5">Total (${ops.length} ops)</td>
    <td>${fM(totSaldo)}</td><td>${fM(totFin)}</td><td>—</td>
    <td>${fM(totCD)}</td><td>${fM(totIng)}</td>
  </tr>`;

  const tipoLabel = tipo === 'ot' ? 'OTORGADOS' : 'APROBADOS';
  const titulo = nombre + ' — ' + tipoLabel + ' (' + desde + (desde !== hasta ? ' → ' + hasta : '') + ')';
  document.getElementById('modal-ejec-title').textContent = titulo;
  _modalData = { ops, titulo, totSaldo, totFin, totCD, totIng, fM };
  document.getElementById('modal-ejec-overlay').classList.add('open');
}

function cerrarModalEjec() {
  document.getElementById('modal-ejec-overlay').classList.remove('open');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarModalEjec(); });

function _buildModalContent() {
  const { ops, titulo, totSaldo, totFin, totCD, totIng, fM } = _modalData;
  const cols = ['N° Operación','ID Financiera','Financiera','Dealer','Estado','Saldo Precio','Total Financiado','Plazo','Com. Dealer','Ing. x Col.'];
  const dataRows = ops.map(r => [
    r.op||'—', r.id_financiera||'—', r.financiera||'—',
    r.automotora||'—', r.estado_eval||'—',
    fM(r.saldo_precio), fM(r.monto_financiado),
    r.plazo||'—', fM(r.com_dealer), fM(r.rentab_afa)
  ]);
  const footRow = ['Total ('+ops.length+' ops)','','','','',fM(totSaldo),fM(totFin),'—',fM(totCD),fM(totIng)];
  return { cols, dataRows, footRow, titulo };
}

function _tablaHtml() {
  const { cols, dataRows, footRow, titulo } = _buildModalContent();
  const { ops, totSaldo, totFin, totCD, totIng, fM } = _modalData;
  const kpisTxt = `<b>Operaciones:</b> ${ops.length} &nbsp;|&nbsp; <b>Total Financiado:</b> ${fM(totFin)} &nbsp;|&nbsp; <b>Saldo Precio:</b> ${fM(totSaldo)} &nbsp;|&nbsp; <b>Com. Dealer:</b> ${fM(totCD)} &nbsp;|&nbsp; <b>Ing. x Col.:</b> ${fM(totIng)}`;
  const thStyle = 'border:1px solid #ccc;padding:4px 8px;white-space:nowrap;background:#1a3a6a;color:#fff;font-weight:bold';
  const tdStyle = 'border:1px solid #ccc;padding:4px 8px;white-space:nowrap';
  const tfStyle = 'border:1px solid #ccc;padding:4px 8px;white-space:nowrap;background:#eef2fa;color:#1a3a6a;font-weight:bold';
  const headRow = `<tr>${cols.map(c=>`<th style="${thStyle}">${c}</th>`).join('')}</tr>`;
  const bodyRows = dataRows.map(row=>`<tr>${row.map(c=>`<td style="${tdStyle}">${c}</td>`).join('')}</tr>`).join('');
  const foot = `<tr>${footRow.map(c=>`<td style="${tfStyle}">${c}</td>`).join('')}</tr>`;
  return `<p style="font-family:Arial;font-size:13px;font-weight:bold;color:#1a3a6a;margin:0 0 4px">${titulo}</p>`
       + `<p style="font-family:Arial;font-size:11px;color:#555;margin:0 0 8px">${kpisTxt}</p>`
       + `<table style="border-collapse:collapse;font-family:Arial;font-size:11px">${headRow}${bodyRows}${foot}</table>`;
}

function copiarTablaModal() {
  const html  = _tablaHtml();
  const { cols, dataRows, footRow, titulo } = _buildModalContent();
  const plain = [cols, ...dataRows, footRow].map(r => r.join('\t')).join('\n');
  navigator.clipboard.write([new ClipboardItem({
    'text/html':  new Blob([html],  { type: 'text/html' }),
    'text/plain': new Blob([plain], { type: 'text/plain' })
  })]).then(() => {
    const btn = document.querySelector('#modal-ejec-head button[onclick="copiarTablaModal()"]');
    const orig = btn.textContent;
    btn.textContent = '✓ Copiado';
    btn.style.background = '#28a745';
    setTimeout(() => { btn.textContent = orig; btn.style.background = '#2d6abf'; }, 1800);
  });
}

function exportarExcelModal() {
  const { cols, dataRows, footRow, titulo } = _buildModalContent();
  const { ops, totSaldo, totFin, totCD, totIng, fM } = _modalData;
  const kpis = `Operaciones: ${ops.length}; Total Financiado: ${fM(totFin)}; Saldo Precio: ${fM(totSaldo)}; Com. Dealer: ${fM(totCD)}; Ing. x Col.: ${fM(totIng)}`;
  const esc = v => '"' + String(v).replace(/"/g,'""') + '"';
  const csv = esc(titulo) + '\r\n' + esc(kpis) + '\r\n\r\n'
    + [cols, ...dataRows, footRow].map(r => r.map(esc).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = titulo.replace(/[/\\:*?"<>|]/g, '_') + '.csv';
  a.click();
}

// ── Alerta y modal: Otorgados con datos incompletos ──────────────────────────
async function cargarAlertaIncompletos() {
  try {
    const token = sessionStorage.getItem('token');
    const r = await fetch('/api/creditos/otorgados-incompletos', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const d = await r.json();
    const lista = d.data || [];
    const el = document.getElementById('alerta-incompletos');
    if (!el) return;
    if (lista.length === 0) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    document.getElementById('alerta-incompletos-txt').textContent =
      `${lista.length} crédito${lista.length>1?'s':''} OTORGADO${lista.length>1?'S':''} sin plazo/tasa — ingreso colocación sin calcular`;
    window._incompletos = lista;
  } catch(e) { console.warn('[incompletos]', e.message); }
}

window.abrirModalIncompletos = function abrirModalIncompletos() {
  const lista = window._incompletos || [];
  if (!lista.length) return;
  const $m = v => v != null && v !== 0 ? '$' + Number(v).toLocaleString('es-CL') : '—';
  const inp = (campo, id, val, ph, w='90px', color='#d97706') =>
    `<input type="number" placeholder="${ph}" step="any" value="${val||''}"
      style="width:${w};padding:4px 6px;border:1.5px solid ${color};border-radius:6px;font-size:.78rem;display:block"
      data-campo="${campo}" data-id="${id}">`;

  const filas = lista.map(c => {
    const tipoDeal = c.parque ? 'PATIO' : 'CALLE';
    const tasaMen  = c.tascli_real ? (c.tascli_real * 100).toFixed(4) : '';
    return `
    <tr data-id="${c.id}" style="border-bottom:1px solid #e5e7eb;font-size:.78rem">
      <td style="padding:7px 8px;font-weight:700;white-space:nowrap">${c.num_op}</td>
      <td style="padding:7px 6px;color:#374151;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.ejecutivo||'—'}</td>
      <td style="padding:7px 6px;white-space:nowrap">${(c.mes||'').slice(0,7)}</td>
      <td style="padding:7px 6px;font-weight:600;white-space:nowrap">${$m(c.monto_financiado)}</td>
      <td style="padding:7px 6px;color:#6b7280;font-size:.72rem">
        <div>${c.financiera||'—'}</div>
        <div style="color:#9ca3af">${c.id_financiera||''}</div>
      </td>
      <td style="padding:5px 6px">
        <select data-campo="parque" data-id="${c.id}"
          style="width:80px;padding:4px 6px;border:1.5px solid #d97706;border-radius:6px;font-size:.78rem">
          <option value="" ${!c.parque?'selected':''}>CALLE</option>
          <option value="PARQUE" ${c.parque?'selected':''}>PATIO</option>
        </select>
      </td>
      <td style="padding:5px 6px">${inp('plazo', c.id, c.plazo||'', 'Cuotas', '70px')}</td>
      <td style="padding:5px 6px">${inp('tascli_pct', c.id, tasaMen, '% mens.', '80px')}</td>
      <td style="padding:5px 6px">${inp('seguro_rdh',       c.id, c.seguro_rdh||'',       'Prima $', '90px', '#0141A2')}</td>
      <td style="padding:5px 6px">${inp('seguro_cesantia',  c.id, c.seguro_cesantia||'',  'Prima $', '90px', '#0141A2')}</td>
      <td style="padding:5px 6px">${inp('seguro_rep_menor', c.id, c.seguro_rep_menor||'', 'Prima $', '90px', '#0141A2')}</td>
    </tr>`;
  }).join('');

  const dlg = document.createElement('dialog');
  dlg.id = 'modalIncompletos';
  dlg.style.cssText = 'border:none;border-radius:16px;padding:0;max-width:1100px;width:98vw;box-shadow:0 20px 60px rgba(0,0,0,0.25);overflow:hidden';
  dlg.innerHTML = `
    <div style="background:linear-gradient(135deg,#92400e,#d97706);color:#fff;padding:18px 24px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:1rem;font-weight:700">⚠️ Otorgados con datos faltantes (${lista.length})</div>
        <div style="font-size:.78rem;opacity:.85;margin-top:2px">Tasa en % mensual · Prima en $ por tipo de seguro · Tipo dealer afecta cálculo de comisión</div>
      </div>
      <button onclick="document.getElementById('modalIncompletos').close()" style="background:rgba(255,255,255,.2);border:none;color:#fff;border-radius:8px;padding:5px 12px;cursor:pointer">✕</button>
    </div>
    <div style="padding:16px 20px;overflow-x:auto;max-height:60vh;overflow-y:auto">
      <table style="width:100%;border-collapse:collapse;font-size:.78rem">
        <thead>
          <tr style="background:#fef3c7;font-size:.7rem;text-transform:uppercase;color:#78350f;letter-spacing:.4px;white-space:nowrap">
            <th style="padding:8px 8px;text-align:left">N° Operación</th>
            <th style="padding:8px 6px;text-align:left">Ejecutivo</th>
            <th style="padding:8px 6px">Mes</th>
            <th style="padding:8px 6px">Monto</th>
            <th style="padding:8px 6px">Financiera</th>
            <th style="padding:8px 6px">Tipo<br>Dealer</th>
            <th style="padding:8px 6px">Plazo</th>
            <th style="padding:8px 6px">Tasa<br>% Mens.</th>
            <th style="padding:8px 6px">Prima<br>Desgrav.</th>
            <th style="padding:8px 6px">Prima<br>Cesantía</th>
            <th style="padding:8px 6px">Prima<br>Rep. Men.</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>
    <div style="padding:14px 20px;border-top:1px solid #e5e7eb;display:flex;gap:10px;justify-content:flex-end;background:#fffbeb">
      <button onclick="document.getElementById('modalIncompletos').close()" style="padding:8px 18px;border-radius:8px;border:1.5px solid #d1d5db;background:#fff;color:#374151;font-weight:600;cursor:pointer;font-size:.85rem">Cerrar</button>
      <button onclick="guardarIncompletos()" id="btnGuardarIncompletos" style="padding:8px 20px;border-radius:8px;border:none;background:#d97706;color:#fff;font-weight:700;cursor:pointer;font-size:.85rem">
        💾 Guardar y recalcular
      </button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

window.guardarIncompletos = async function guardarIncompletos() {
  const btn = document.getElementById('btnGuardarIncompletos');
  btn.disabled = true; btn.textContent = 'Guardando...';
  const token = sessionStorage.getItem('token');
  const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

  const mapa = {};
  document.querySelectorAll('#modalIncompletos input[data-id], #modalIncompletos select[data-id]').forEach(el => {
    const id = el.dataset.id;
    if (!mapa[id]) mapa[id] = {};
    const val = el.value.trim();
    if (el.dataset.campo === 'parque') {
      mapa[id]['parque'] = val; // '' = CALLE, 'PARQUE' = PATIO
    } else if (val === '') {
      // skip empty numeric fields
    } else if (el.dataset.campo === 'tascli_pct') {
      mapa[id]['tascli_real'] = parseFloat(val) / 100; // % mensual → decimal
    } else {
      mapa[id][el.dataset.campo] = parseFloat(val);
    }
  });

  let ok = 0, err = 0;
  for (const [id, campos] of Object.entries(mapa)) {
    if (!Object.keys(campos).length) continue;
    try {
      const r = await fetch(`/api/creditos/${id}/datos-ingresos`, { method: 'PATCH', headers: H, body: JSON.stringify(campos) });
      const d = await r.json();
      if (d.success) ok++; else err++;
    } catch { err++; }
  }

  if (ok > 0) {
    try {
      // Solo recalcular los meses de las operaciones guardadas
      const mesesGuardados = [...new Set(
        (window._incompletos || [])
          .filter(c => mapa[c.id] && Object.keys(mapa[c.id]).length)
          .map(c => (c.mes || '').slice(0, 7))
          .filter(Boolean)
      )].sort();
      const body = mesesGuardados.length
        ? { mes_desde: mesesGuardados[0], mes_hasta: mesesGuardados[mesesGuardados.length - 1] }
        : {};
      await fetch('/api/operaciones/recalcular-comisiones', { method: 'POST', headers: H, body: JSON.stringify(body) });
    } catch {}
  }

  btn.disabled = false; btn.textContent = '💾 Guardar y recalcular';
  document.getElementById('modalIncompletos').close();
  // Recargar alerta
  await cargarAlertaIncompletos();
  alert(err === 0 ? `✓ ${ok} crédito${ok>1?'s':''} actualizados. Comisiones recalculadas.` : `⚠ ${ok} guardados, ${err} con error`);
}

/* ── 🛡️ Seguros AutoFin: histórico mensual (penetración, % comisión, ingresos) ── */
let _vsegCargado = false;
async function buildVSeg() {
  if (_vsegCargado) return;
  const t = document.getElementById('t-seguros');
  t.innerHTML = '<tr><td style="padding:14px;color:#7bafd4">Cargando…</td></tr>';
  try {
    const r = await fetch('/api/dashboard/seguros-historico', { headers: { Authorization: 'Bearer ' + (sessionStorage.getItem('token') || '') } });
    const j = await r.json();
    if (!j.success) { t.innerHTML = '<tr><td style="padding:14px;color:#ef9a9a">' + (j.error || 'Error') + '</td></tr>'; return; }
    const $ = v => '$' + Math.round(v || 0).toLocaleString('es-CL');
    const pF = v => Number(v || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
    // color según tramo: verde ≥ tope, amarillo intermedio, rojo bajo el primero
    const cell = (v, t1, t2, t3) => {
      const c = v >= t3 ? '#66bb6a' : v >= t1 ? '#ffd54f' : '#ef5350';
      return `<td style="text-align:center;color:${c};font-weight:700">${pF(v)}</td>`;
    };
    t.innerHTML =
      `<tr><th>Mes</th><th style="text-align:center">Ops</th>
       <th style="text-align:center">RDH</th><th style="text-align:center">Cesantía</th><th style="text-align:center">Reparac.</th>
       <th style="text-align:center">% Com.</th>
       <th style="text-align:right">Ing. RDH</th><th style="text-align:right">Ing. Cesantía</th><th style="text-align:right">Ing. Reparac.</th>
       <th style="text-align:right">Total</th></tr>` +
      j.data.map(x => {
        const tot = x.ing_rdh + x.ing_cesantia + x.ing_reparaciones;
        const pctColor = x.pct_comision >= 40 ? '#66bb6a' : x.pct_comision >= 30 ? '#ffd54f' : '#ef5350';
        const inf = x.pct_fuente === 'INFORMADO';
        return `<tr>
          <td style="font-weight:700">${x.mes}</td>
          <td style="text-align:center">${x.ops}</td>
          ${cell(x.pen_rdh, 92, 95, 98)}${cell(x.pen_cesantia, 30, 40, 50)}${cell(x.pen_reparaciones, 30, 40, 50)}
          <td style="text-align:center;font-weight:800;color:${pctColor}" title="${inf ? 'Informado por AutoFin (manda sobre el calculado)' : 'Calculado por tramos — clic en ✏️ para registrar el % informado por AutoFin'}">
            ${Number(x.pct_comision).toLocaleString('es-CL')}%${inf ? ' 📌' : ''}
            <span onclick="vsegOverride('${x.mes}', ${x.pct_comision})" style="cursor:pointer;opacity:.6" title="Registrar % informado por AutoFin">✏️</span>
          </td>
          <td style="text-align:right">${$(x.ing_rdh)}</td><td style="text-align:right">${$(x.ing_cesantia)}</td><td style="text-align:right">${$(x.ing_reparaciones)}</td>
          <td style="text-align:right;font-weight:800;color:#4fc3f7">${$(tot)}</td>
        </tr>`;
      }).join('') +
      `<tr><td colspan="10" style="padding:8px;color:#7bafd4;font-size:11px">📌 = % informado por AutoFin (manda sobre el calculado). El % calculado usa nuestra BD; el cierre oficial de AutoFin puede diferir (ops/primas re-informadas).</td></tr>`;
    _vsegCargado = true;
  } catch (e) { t.innerHTML = '<tr><td style="padding:14px;color:#ef9a9a">Error de conexión</td></tr>'; }
}

/* Registrar/quitar el % del mes informado por AutoFin (override del calculado) */
async function vsegOverride(mes, actual) {
  const v = prompt('% de comisión INFORMADO por AutoFin para ' + mes + ' (vacío = volver al calculado):', actual);
  if (v === null) return;
  try {
    const r = await fetch('/api/comisiones-seguro/pct-mes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (sessionStorage.getItem('token') || '') },
      body: JSON.stringify({ mes, pct: v.trim() === '' ? '' : parseFloat(v.replace(',', '.')) }),
    });
    const j = await r.json();
    if (!j.success) return alert(j.error || 'Error al guardar');
    _vsegCargado = false;
    buildVSeg();
  } catch (e) { alert('Error de conexión'); }
}

/* ═══ VISTAS DEALERS / PARQUES: colocaciones mensuales (cantidad + monto) ═══
   Filas = dealer (automotora) o parque; columnas = meses descendentes desde el
   más reciente. Orden: mayor cantidad de ventas del último mes, luego total. */
function buildColocMensual(vista) {
  const esDealers = vista === 'vdealers';
  const cont = document.getElementById(esDealers ? 'tbl-dealers-mes' : 'tbl-parques-mes');
  if (!cont) return;
  const rows = (window.RAW_DATA || []).filter(r => r.estado_eval === 'OTORGADO');
  // Parques: lo que no está en un parque es venta de CALLE
  const key = r => esDealers ? (r.automotora || '(sin dealer)')
    : (!r.parque || /^NO APLICA$/i.test(r.parque) ? 'CALLE' : r.parque);
  const meses = [...new Set(rows.map(r => r.mes))].filter(Boolean).sort().reverse();
  const M = {};   // nombre → { mes: {n, monto} }
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;                       // parques: solo ops con parque
    (M[k] = M[k] || {});
    const c = (M[k][r.mes] = M[k][r.mes] || { n: 0, monto: 0 });
    c.n++; c.monto += (+r.monto_financiado || 0);
  }
  const ult = meses[0];
  const tot = (m, campo) => Object.values(m).reduce((a, x) => a + x[campo], 0);
  const lista = Object.entries(M).sort((a, b) =>
    ((b[1][ult]?.n || 0) - (a[1][ult]?.n || 0)) || (tot(b[1], 'n') - tot(a[1], 'n')));

  const fMes = m => { const [a, mm] = m.split('-'); return mm + '-' + a; };   // 2026-06 → 06-2026
  const f$ = v => '$' + Math.round(v).toLocaleString('es-CL');
  const totMes = {};   // totales por mes para el footer
  meses.forEach(m => { totMes[m] = { n: 0, monto: 0 }; });
  lista.forEach(([, mm]) => meses.forEach(m => { if (mm[m]) { totMes[m].n += mm[m].n; totMes[m].monto += mm[m].monto; } }));

  cont.innerHTML = `<table id="t-coloc-${vista}" style="width:max-content;min-width:100%;border-collapse:collapse;font-size:11.5px">
    <thead>
      <tr>
        <th rowspan="2" style="position:sticky;left:0;background:#12213f;color:#fff;padding:6px 10px;text-align:left;z-index:2">${esDealers ? 'Dealer' : 'Parque'}</th>
        <th rowspan="2" style="background:#12213f;color:#4fc3f7;padding:6px 8px;text-align:right">Total<br>Cant.</th>
        <th rowspan="2" style="background:#12213f;color:#4fc3f7;padding:6px 8px;text-align:right;border-right:2px solid #2a4070">Total<br>Monto</th>
        ${meses.map(m => `<th colspan="2" style="background:#1a2a4a;color:#fff;padding:5px 8px;text-align:center;border-left:1px solid #2a4070">${fMes(m)}</th>`).join('')}
      </tr>
      <tr>${meses.map(() => `<th style="background:#1a2a4a;color:#8fb4dd;padding:3px 8px;text-align:right">Cant.</th>
        <th style="background:#1a2a4a;color:#8fb4dd;padding:3px 8px;text-align:right">Monto</th>`).join('')}</tr>
    </thead>
    <tbody>
      ${lista.map(([nombre, mm], i) => `<tr style="background:${i % 2 ? '#f6f9ff' : '#fff'}">
        <td style="position:sticky;left:0;background:${i % 2 ? '#eef3fb' : '#fff'};padding:4px 10px;font-weight:600;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid #e8eef7">${nombre}</td>
        <td style="text-align:right;padding:4px 8px;font-weight:800;color:#0d2f6b;border-bottom:1px solid #e8eef7">${tot(mm, 'n')}</td>
        <td style="text-align:right;padding:4px 8px;font-weight:700;color:#0d2f6b;border-right:2px solid #dbe3ee;border-bottom:1px solid #e8eef7">${f$(tot(mm, 'monto'))}</td>
        ${meses.map(m => mm[m]
          ? `<td style="text-align:right;padding:4px 8px;font-weight:700;color:#1a3a6a;border-left:1px solid #eef2f8;border-bottom:1px solid #e8eef7">${mm[m].n}</td>
             <td style="text-align:right;padding:4px 8px;color:#059669;border-bottom:1px solid #e8eef7">${f$(mm[m].monto)}</td>`
          : `<td style="text-align:right;padding:4px 8px;color:#cbd5e1;border-left:1px solid #eef2f8;border-bottom:1px solid #e8eef7">—</td>
             <td style="text-align:right;padding:4px 8px;color:#cbd5e1;border-bottom:1px solid #e8eef7">—</td>`).join('')}
      </tr>`).join('')}
    </tbody>
    <tfoot><tr style="background:#12213f;color:#fff;font-weight:800">
      <td style="position:sticky;left:0;background:#12213f;padding:5px 10px">Total (${lista.length})</td>
      <td style="text-align:right;padding:5px 8px">${lista.reduce((a, [, mm]) => a + tot(mm, 'n'), 0)}</td>
      <td style="text-align:right;padding:5px 8px;border-right:2px solid #2a4070">${f$(lista.reduce((a, [, mm]) => a + tot(mm, 'monto'), 0))}</td>
      ${meses.map(m => `<td style="text-align:right;padding:5px 8px;border-left:1px solid #2a4070">${totMes[m].n}</td>
        <td style="text-align:right;padding:5px 8px">${f$(totMes[m].monto)}</td>`).join('')}
    </tr></tfoot>
  </table>`;

  // ── Solo Parques: curva mensual de colocaciones por parque (incluye CALLE) ──
  if (!esDealers) {
    const box = document.getElementById('chart-parques-mes');
    if (box) {
      const asc = [...meses].reverse();
      const PAL = ['#4fc3f7', '#ffd54f', '#ef5350', '#66bb6a', '#ab47bc', '#ffa726', '#26c6da', '#ec407a', '#9ccc65', '#7e57c2', '#8d6e63', '#78909c'];
      const ex = Chart.getChart(document.getElementById('ch-parques-mes')); if (ex) ex.destroy();
      new Chart(document.getElementById('ch-parques-mes'), {
        type: 'line',
        data: { labels: asc.map(fMes), datasets: lista.map(([nombre, mm], i) => ({
          label: nombre, data: asc.map(m => mm[m]?.n || 0),
          borderColor: PAL[i % PAL.length], backgroundColor: PAL[i % PAL.length],
          borderWidth: nombre === 'CALLE' ? 3 : 2, tension: .3, pointRadius: 2.5, fill: false,
        })) },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { color: '#555', font: { size: 10 }, boxWidth: 12 } },
            tooltip: { mode: 'index', intersect: false } },
          scales: { x: { ticks: { color: '#666', font: { size: 10 } } },
            y: { beginAtZero: true, ticks: { color: '#666', font: { size: 10 } }, title: { display: true, text: 'Colocaciones (cant.)', color: '#888', font: { size: 10 } } } } }
      });
    }
  }
}

function exportColocMensual(vista) {
  const t = document.getElementById('t-coloc-' + vista);
  if (!t || !window.XLSX) return;
  const wb = XLSX.utils.table_to_book(t, { sheet: vista === 'vdealers' ? 'dealers' : 'parques' });
  XLSX.writeFile(wb, `colocaciones_${vista === 'vdealers' ? 'dealers' : 'parques'}.xlsx`);
}
