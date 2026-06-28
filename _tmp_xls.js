const XLSX=require('xlsx');
const wb=XLSX.readFile('C:/Users/patri/OneDrive/Documentos/01 AUTOFACIL/AREA COMERCIAL/rentabilidad por financiera.xlsx',{cellDates:false});
const aoa=sn=>XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1,raw:true,defval:null});
console.log('===== Hoja2 ====='); aoa('Hoja2').forEach((r,i)=>console.log(i+1,JSON.stringify(r)));
console.log('\n===== Detalle1 (primeras 12 filas) ====='); aoa('Detalle1').slice(0,12).forEach((r,i)=>console.log(i+1,JSON.stringify(r)));
console.log('\n===== CUADRO (primeras 10 filas) ====='); aoa('CUADRO').slice(0,10).forEach((r,i)=>console.log(i+1,JSON.stringify(r)));
// menor 200UF: buscar un saldo chico, ver tasa + comision autofin a 12 y 24
const base=aoa('BASE'); const H=base[0]; const ix={}; H.forEach((h,i)=>ix[h]=i);
console.log('\n===== BASE menor200UF: Saldo 4M Pie20%, plazos 12/19/20/24 =====');
for(let i=1;i<base.length;i++){const r=base[i];
  if(r[ix['Saldo Precio']]===4000000 && r[ix['Pie %']]===0.2 && [12,19,20,24,36,48].includes(r[ix['plazo']])){
    console.log('plazo',r[ix['plazo']],'200UF=',r[ix['200 UF']],'tasa',r[ix['Tasa']],'ComAF',Math.round(r[ix['Comision Autofin']]),'segAF',Math.round(r[ix['seguros Autofin']]),'TotAF',Math.round(r[ix['Total Autofin']]),'UCA',r[ix['Total UCA']],'NetaAF',Math.round(r[ix[' Neta Autofin']]),'NetaUCA',Math.round(r[ix['Neta UCA']]),'cursar',r[ix['CURSAR POR']]);
  }
}
