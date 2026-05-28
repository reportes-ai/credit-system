# -*- coding: utf-8 -*-
import pymysql

DB = dict(host='gateway01.us-east-1.prod.aws.tidbcloud.com',port=4000,
          user='2vKB4HuuftmmTwL.root',password='RiS8WgVqQTeILrlf',
          database='credit_system',charset='utf8mb4',
          ssl={'ca':None},ssl_verify_cert=False,ssl_verify_identity=False)
conn = pymysql.connect(**DB)
cur = conn.cursor()

cur.execute("""
SELECT
  financiera,
  COUNT(*) as ops,
  ROUND(SUM(rentabilidad_af_directo)/1e6,1)                       AS rentab_af_M,
  ROUND(SUM(ingreso_neto_total)/1e6,1)                            AS ingreso_neto_M,
  ROUND(SUM(monto_comision_fin)/1e6,1)                            AS com_fin_M,
  ROUND(SUM(comdea_real)/1e6,1)                                   AS comdea_real_M,
  ROUND((SUM(rentabilidad_af_directo)+SUM(comdea_real))/1e6,1)    AS rentab_plus_comdea
FROM operaciones_brokerage
WHERE mes >= '2026-04-01' AND mes < '2026-05-01'
  AND estado_eval = 'OTORGADO'
  AND financiera IN ('AUTOFIN','UNIDAD DE CREDITO')
GROUP BY financiera WITH ROLLUP
""")

print(f"{'Financiera':<22} {'Ops':>4} {'RentabAF M':>12} {'IngresoNeto M':>14} {'ComFin M':>10} {'ComdeaReal M':>13} {'Rent+Comdea M':>14}")
print('-'*95)
for r in cur.fetchall():
    fin = str(r[0]) if r[0] else 'TOTAL'
    print(f"{fin:<22} {str(r[1]):>4} {str(r[2]):>12} {str(r[3]):>14} {str(r[4]):>10} {str(r[5]):>13} {str(r[6]):>14}")

print()
print("Dashboard screenshot muestra 'Ing. x Colocaciones' = AUTOFIN:47.5M | UNIDAD:17.2M | TOTAL:64.7M")
conn.close()
