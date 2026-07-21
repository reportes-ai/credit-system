require('dotenv').config();
const pool = require('./shared/config/database');
const rows = require('C:/Users/patri/AppData/Local/Temp/claude/fund.json');
const DRY = process.argv[2] !== 'WRITE';

const CHAIN = {
  'PAGADO':          [['FUNDANTES RECIBIDOS','fH'],['LIBERADO A PAGO','fG'],['FONDOS RECIBIDOS','fG'],['SALDO PRECIO PAGADO','fG']],
  'FONDOS RECIBIDOS':[['FUNDANTES RECIBIDOS','fH'],['LIBERADO A PAGO','fG'],['FONDOS RECIBIDOS','fG']],
  'LIBERADO A PAGO': [['FUNDANTES RECIBIDOS','fH'],['LIBERADO A PAGO','fG']],
  'FUNDANTE EN PROCESO':[['FUNDANTES ENVIADOS','fH']],
  'FUNDANTE PENDIENTE': [],
};
const OMITIR = new Set(['ANULADO','RETENIDO','RENEGOCIADO','NO APLICA','SUJETO A PRENDA']);

(async()=>{
 try{
  // mapa num_op -> id_seguimiento
  const [segs]=await pool.query('SELECT id, num_op FROM postventa_seguimiento');
  const segByOp={}; segs.forEach(s=>{ if(!segByOp[s.num_op]) segByOp[s.num_op]=s.id; });
  // etapas ya existentes (para idempotencia): set "segid|etapa"
  const [ex]=await pool.query("SELECT id_seguimiento, etapa FROM postventa_etapas WHERE track='SALDO'");
  const existe=new Set(ex.map(e=>e.id_seguimiento+'|'+e.etapa));

  const stats={inserts:{}, opsAfectadas:new Set(), sinSeg:[], omitidas:[], sinFechaG:0, saltEtapa:0, estadoDesconocido:{}};
  const aInsertar=[];
  for(const r of rows){
    if(OMITIR.has(r.estado)){ stats.omitidas.push(r.op); continue; }
    const chain = CHAIN[r.estado];
    if(chain===undefined){ stats.estadoDesconocido[r.estado]=(stats.estadoDesconocido[r.estado]||0)+1; continue; }
    const segid = segByOp[r.op];
    if(!segid){ stats.sinSeg.push(r.op); continue; }
    for(const [etapa,campoF] of chain){
      let fecha = r[campoF] || r.fG || r.fH || r.fA;
      if(campoF==='fG' && !r.fG) stats.sinFechaG++;
      if(!fecha){ stats.saltEtapa++; continue; }
      if(existe.has(segid+'|'+etapa)) continue;        // idempotente
      aInsertar.push([segid, 'SALDO', etapa, 'Carga histórica', fecha+' 12:00:00']);
      existe.add(segid+'|'+etapa);
      stats.inserts[etapa]=(stats.inserts[etapa]||0)+1;
      stats.opsAfectadas.add(r.op);
    }
  }
  console.log('=== '+(DRY?'DRY-RUN (no escribe)':'ESCRITURA')+' ===');
  console.log('Etapas a insertar:', JSON.stringify(stats.inserts,null,0));
  console.log('OPs afectadas:', stats.opsAfectadas.size);
  console.log('Total inserts:', aInsertar.length);
  console.log('OPs omitidas (raras):', stats.omitidas.length);
  console.log('OPs sin seguimiento (no en base):', stats.sinSeg.length);
  console.log('Estados sin mapeo:', JSON.stringify(stats.estadoDesconocido));
  console.log('Etapas saltadas por falta de fecha:', stats.saltEtapa, '| filas PAGADO sin fecha pago (usa H):', stats.sinFechaG);

  if(!DRY && aInsertar.length){
    let done=0;
    for(let i=0;i<aInsertar.length;i+=500){
      const lote=aInsertar.slice(i,i+500);
      const ph=lote.map(()=>'(?,?,?,?,?)').join(',');
      await pool.query(`INSERT INTO postventa_etapas (id_seguimiento,track,etapa,usuario,fecha) VALUES ${ph}`, lote.flat());
      done+=lote.length; process.stdout.write(`\r  insertadas ${done}/${aInsertar.length}`);
    }
    console.log('\n✓ ESCRITO.');
    // guardar listas para el usuario
    require('fs').writeFileSync('C:/Users/patri/Downloads/fundantes_omitidas.txt',
      'OMITIDAS (estado raro):\n'+stats.omitidas.join(',')+'\n\nSIN SEGUIMIENTO (no en base):\n'+stats.sinSeg.join(','));
    console.log('Listas guardadas en Downloads/fundantes_omitidas.txt');
  }
  process.exit(0);
 }catch(e){console.error('ERR',e.message);process.exit(1);}
})();
