# -*- coding: utf-8 -*-
"""
Carga masiva: hoja DETALLE del Excel -> tabla operaciones_brokerage (TiDB Cloud)
Ejecutar: python -X utf8 scripts/importar_detalle.py
"""
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import math
import pandas as pd
import numpy as np
import pymysql
from datetime import datetime

# ── Conexion TiDB Cloud ───────────────────────────────────────────────────────
DB = dict(
    host='gateway01.us-east-1.prod.aws.tidbcloud.com',
    port=4000,
    user='2vKB4HuuftmmTwL.root',
    password='RiS8WgVqQTeILrlf',
    database='credit_system',
    charset='utf8mb4',
    ssl={'ca': None},
    ssl_verify_cert=False,
    ssl_verify_identity=False,
)

EXCEL = r'C:\Users\patri\Downloads\CONTROL CREDITOS INGRESADOS OPERACIONES EN LINEA (6).xlsx'

# ── Nuevas columnas (ALTER TABLE) ─────────────────────────────────────────────
NEW_COLS = [
    ('fecha_estado',            'DATE'),
    ('fecha_recep_fei',         'DATE'),
    ('fecha_pago_sp',           'DATE'),
    ('estado_sp',               'VARCHAR(80)'),
    ('comdea_pizarra',          'DECIMAL(15,2)'),
    ('comej',                   'DECIMAL(15,0)'),
    ('rentabilidad_af_directo', 'DECIMAL(15,2)'),
    ('fecha_estim_pago_comaf',  'DATE'),
    ('status_comaf',            'VARCHAR(80)'),
    ('estado_com_dealer',       'VARCHAR(80)'),
    ('estado_pago_com',         'VARCHAR(80)'),
    ('fecha_pago_com_dealer',   'DATE'),
    ('nro_factura_com_dea',     'VARCHAR(80)'),
    ('comision_seguro',         'DECIMAL(15,0)'),
    ('com_parque',              'DECIMAL(15,0)'),
    ('arriendo_parque',         'DECIMAL(15,0)'),
    ('ingreso_neto_total',      'DECIMAL(15,2)'),
    ('resultado_negocio',       'VARCHAR(30)'),
    ('pen_rdh',                 'DECIMAL(15,0)'),
    ('pen_cesantia',            'DECIMAL(15,0)'),
    ('pen_reparaciones',        'DECIMAL(15,0)'),
    ('com_rdh',                 'DECIMAL(15,0)'),
    ('com_cesantia',            'DECIMAL(15,0)'),
    ('com_reparaciones',        'DECIMAL(15,0)'),
    ('mayor_mm30',              'TINYINT(1) DEFAULT 0'),
    ('bono_base',               'DECIMAL(15,2)'),
    ('bono_seg_cesantia',       'DECIMAL(15,2)'),
    ('bono_seg_rep_menores',    'DECIMAL(15,2)'),
    ('bono_total',              'DECIMAL(15,2)'),
    ('rut_dealer',              'VARCHAR(30)'),
    ('con_fact_boleta',         'VARCHAR(5)'),
    ('comision_carta',          'DECIMAL(15,0)'),
    ('credito_vendido_a',       'VARCHAR(150)'),
    ('prepago',                 'VARCHAR(150)'),
    ('anulacion',               'VARCHAR(150)'),
]

# ── Mapeo exacto (nombre Excel -> campo DB) ───────────────────────────────────
# Los nombres de columna se obtuvieron con: df.columns.tolist() sobre el Excel real
COL_MAP = {
    'OP':                               'num_op',
    'MES':                              'mes',
    'FINANCIERA':                       'financiera',
    'FECHA ESTADO':                     'fecha_estado',
    'RUT':                              'rut_cliente',
    'NOMBRE':                           'nombre_cliente',
    'EJ.COMERCIAL':                     'ejecutivo',
    'AUTOMOTORA':                       'automotora',
    'NOMBRE LOCAL':                     'nombre_local',
    'ESTADO EVAL. RIESGO':              'estado_eval',
    'ESTADO CREDITO':                   'estado_credito',
    'FECHA OTORGADO':                   'fecha_otorgado',
    'PRODUCTO':                         'producto',
    'ID FINANCIERA':                    'id_financiera',
    'VALOR VEHICULO':                   'valor_vehiculo',
    'PIE':                              'pie',
    'SALDO PRECIO':                     'saldo_precio',
    '% FINANCIADO':                     'pct_financiado',
    'IMPUESTO':                         'impuesto',
    'ESTADO IMPTO':                     'estado_impuesto',
    'LIMITACION':                       'limitacion',
    'MONTO FINANCIADO INDEXA':          'monto_financiado',
    'PLAZO':                            'plazo',
    'FECHA PRIMERA CUOTA':              'fecha_primera_cuota',
    'MAYOR/MENOR':                      'mayor_menor',
    'TASCLI REAL':                      'tascli_real',
    'TASCLI PIZARRA':                   'tascli_pizarra',
    'TASFIN PIZARRA':                   'tasfin_pizarra',
    'COMDEA $ REAL':                    'comdea_real',
    'COMDEA PIZARRA $':                 'comdea_pizarra',
    'COMEJ $':                          'comej',
    'MONTO DE PAGO COMISION FINAN.':    'monto_comision_fin',
    'MONTO CAPITALIZADO':               'monto_capitalizado',
    'RENTABILIDAD AUTOFACIL DIRECTO':   'rentabilidad_af_directo',
    'FECHA ESTIM. DE PAGO COMAF':       'fecha_estim_pago_comaf',
    'STATUS COMAF':                     'status_comaf',
    'ESTADO DE COM DEALER':             'estado_com_dealer',
    'ESTADO PAGO COM':                  'estado_pago_com',
    'FECHA DE PAGO COMISION DEALER':    'fecha_pago_com_dealer',
    'N° FACTURA COM DEA.':         'nro_factura_com_dea',
    'GASTOS':                           'gastos',
    'GPS':                              'gps',
    'SEGURO RDH+E':                     'seguro_rdh',
    'SEG.CESANTIA':                     'seguro_cesantia',
    'SEG. REP MENOR':                   'seguro_rep_menor',
    'COMISION SEGURO':                  'comision_seguro',
    'PARQUE':                           'parque',
    'COM PARQUE':                       'com_parque',
    'ARRIENDO PARQUE':                  'arriendo_parque',
    'INGRESO NETO TOTAL AF':            'ingreso_neto_total',
    'RESULTADO NEGOCIO':                'resultado_negocio',
    'PEN. RDH':                         'pen_rdh',
    'PEN. CESANTIA':                    'pen_cesantia',
    'PEN. REPARACIONES':                'pen_reparaciones',
    'COM.RDH':                          'com_rdh',
    'COM.CESANTIA':                     'com_cesantia',
    'COM.REPARACIONES':                 'com_reparaciones',
    'MAYOR A MM$30':                    'mayor_mm30',
    'Bono Base':                        'bono_base',
    'Bono Seguro Cesantia':             'bono_seg_cesantia',
    'Bono Seguro Rep Menores':          'bono_seg_rep_menores',
    'BONO TOTAL':                       'bono_total',
    'FECHA RECEPCION FEI':              'fecha_recep_fei',
    'FECHA DE PAGO SALDO PRECIO':       'fecha_pago_sp',
    'ESTADO SP':                        'estado_sp',
    'RUT DEALER':                       'rut_dealer',
    'CON FACT O BOLETA':                'con_fact_boleta',
    'BOLETA \nFACTURA':                 'boleta_factura',
    'CANTIDAD DE DOCUMENTOS':           'cantidad_docs',
    'DOCUMENTOS AUTORIZADOS':           'docs_autorizados',
    'FECHA RECEPCION DOCUMENTO':        'fecha_recep_doc',
    'COMISION CARTA':                   'comision_carta',
    'CRÉDITO VENDIDO A':           'credito_vendido_a',
    'PREPAGO':                          'prepago',
    'ANULACIÓN':                   'anulacion',
    'COMENTARIOS':                      'comentarios',
}

DATE_FIELDS = {
    'mes','fecha_otorgado','fecha_primera_cuota','fecha_recep_doc',
    'fecha_estado','fecha_recep_fei','fecha_pago_sp',
    'fecha_estim_pago_comaf','fecha_pago_com_dealer',
}
NUM_FIELDS = {
    'num_op','valor_vehiculo','pie','saldo_precio','pct_financiado',
    'impuesto','gastos','gps','seguro_rdh','seguro_cesantia',
    'seguro_rep_menor','monto_financiado','plazo','tascli_real',
    'tascli_pizarra','tasfin_pizarra','comdea_real','comdea_pizarra',
    'comej','monto_comision_fin','monto_capitalizado',
    'rentabilidad_af_directo','comision_seguro','com_parque',
    'arriendo_parque','ingreso_neto_total','pen_rdh','pen_cesantia',
    'pen_reparaciones','com_rdh','com_cesantia','com_reparaciones',
    'bono_base','bono_seg_cesantia','bono_seg_rep_menores','bono_total',
    'comision_carta','cantidad_docs','docs_autorizados',
}
BOOL_FIELDS = {'mayor_mm30'}
NOAPL = {'N/A','','NONE','NAN','VACIA','#N/A'}
# Campos donde "NO APLICA" es un valor de negocio valido (no se convierte a NULL)
PRESERVE_NO_APLICA = {'financiera', 'parque', 'mayor_menor', 'estado_impuesto',
                      'estado_credito', 'estado_eval', 'resultado_negocio',
                      'estado_sp', 'status_comaf', 'estado_com_dealer',
                      'estado_pago_com', 'con_fact_boleta'}

def nan_to_none(v):
    """Convierte cualquier variante de NaN/NaT/inf a None para pymysql."""
    if v is None:
        return None
    if v is pd.NaT:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, np.floating) and (np.isnan(v) or np.isinf(v)):
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v

def limpia_fecha(v):
    s = str(v).strip() if not (pd.isna(v) if not isinstance(v, str) else False) else ''
    if s.upper() in NOAPL or not s: return None
    try:
        ts = pd.to_datetime(v, errors='coerce', dayfirst=False)
        return None if pd.isna(ts) else ts.date()
    except: return None

def limpia_num(v):
    if v is None: return None
    try:
        if pd.isna(v): return None
    except: pass
    s = str(v).strip().replace(' ','').replace('$','')
    # numero con puntos de miles y coma decimal (CL) o viceversa
    if s.upper().replace(' ','') in {n.replace(' ','') for n in NOAPL}: return None
    # Detectar formato: si hay punto y coma, es europeo (punto=miles, coma=decimal)
    if ',' in s and '.' in s:
        # si el punto esta antes de la coma: formato europeo 1.234,56
        if s.index('.') < s.index(','):
            s = s.replace('.','').replace(',','.')
        else:
            # 1,234.56 formato anglosajón
            s = s.replace(',','')
    elif ',' in s and '.' not in s:
        s = s.replace(',','.')
    # si solo tiene puntos y el ultimo bloque tiene != 3 digitos, es decimal
    elif '.' in s:
        parts = s.split('.')
        if len(parts) == 2 and len(parts[1]) == 3 and parts[0].isdigit():
            s = s.replace('.','')  # era separador de miles
    try: return float(s)
    except: return None

def limpia_str(v, mx=255, preserve_na=False):
    if v is None: return None
    try:
        if pd.isna(v): return None
    except: pass
    s = str(v).strip()
    if not s: return None
    su = s.upper()
    if preserve_na:
        # Solo limpiar valores realmente vacios
        if su in NOAPL: return None
        return s[:mx]
    if su in NOAPL or su == 'NO APLICA': return None
    return s[:mx]

def limpia_bool(v):
    if v is None: return None
    try:
        if pd.isna(v): return None
    except: pass
    s = str(v).strip().upper()
    return 1 if s in ('SI','1','TRUE','YES','S','SÍ') else (0 if s in ('NO','0','FALSE') else None)

# ── Paso 1: agregar columnas ──────────────────────────────────────────────────
def agregar_columnas(conn):
    cur = conn.cursor()
    cur.execute('SHOW COLUMNS FROM operaciones_brokerage')
    existentes = {row[0].lower() for row in cur.fetchall()}
    agregadas = []
    for col, tipo in NEW_COLS:
        if col.lower() not in existentes:
            try:
                cur.execute(f'ALTER TABLE operaciones_brokerage ADD COLUMN `{col}` {tipo}')
                agregadas.append(col)
            except Exception as e:
                print(f'  WARN {col}: {e}')
    conn.commit()
    cur.close()
    if agregadas:
        print(f'  +{len(agregadas)} columnas: {", ".join(agregadas)}')
    else:
        print('  Todas las columnas ya existian')

# ── Paso 2: leer y transformar ────────────────────────────────────────────────
def leer_excel():
    print('Leyendo Excel (puede tomar ~30s)...')
    df = pd.read_excel(EXCEL, sheet_name='DETALLE', dtype=str)
    df.columns = [str(c).strip() for c in df.columns]
    print(f'  {df.shape[0]} filas x {df.shape[1]} columnas')

    # Verificar columnas mapeadas
    enc  = {ec: db for ec, db in COL_MAP.items() if ec in df.columns}
    miss = [ec for ec in COL_MAP if ec not in df.columns]
    if miss:
        print(f'  AVISO - no encontradas en Excel: {miss}')
    print(f'  Columnas a importar: {len(enc)}')

    df2 = df[[c for c in enc]].rename(columns=enc).copy()

    for col in df2.columns:
        if col in DATE_FIELDS:
            df2[col] = df2[col].apply(limpia_fecha)
        elif col in NUM_FIELDS:
            df2[col] = df2[col].apply(limpia_num)
        elif col in BOOL_FIELDS:
            df2[col] = df2[col].apply(limpia_bool)
        else:
            preserve = col in PRESERVE_NO_APLICA
            df2[col] = df2[col].apply(lambda v: limpia_str(v, preserve_na=preserve))

    df2 = df2.where(pd.notnull(df2), None)
    print(f'  Limpieza OK')
    return df2

# ── Paso 3: insertar ──────────────────────────────────────────────────────────
def insertar(conn, df):
    cols = list(df.columns)
    ph   = ', '.join(['%s'] * len(cols))
    cn   = ', '.join([f'`{c}`' for c in cols])
    upd  = ', '.join([f'`{c}`=VALUES(`{c}`)' for c in cols
                      if c not in ('num_op', 'mes', 'financiera')])
    sql  = (f'INSERT INTO operaciones_brokerage ({cn}) VALUES ({ph}) '
            f'ON DUPLICATE KEY UPDATE {upd}')

    cur   = conn.cursor()
    BATCH = 300
    total = len(df)
    ok    = err = 0
    t0    = datetime.now()

    for i in range(0, total, BATCH):
        chunk   = df.iloc[i:i+BATCH]
        records = chunk.to_dict('records')
        rows    = []
        for rec in records:
            rows.append(tuple(nan_to_none(rec[c]) for c in cols))
        try:
            cur.executemany(sql, rows)
            conn.commit()
            ok += len(rows)
        except Exception as e:
            conn.rollback()
            for j, row in enumerate(rows):
                try:
                    cur.execute(sql, row)
                    conn.commit()
                    ok += 1
                except Exception as e2:
                    conn.rollback()
                    err += 1
                    if err <= 5:
                        op = row[cols.index('num_op')] if 'num_op' in cols else '?'
                        print(f'  ERR fila OP={op}: {str(e2)[:80]}')
        done = min(i+BATCH, total)
        sys.stdout.write(f'  {done}/{total} ({100*done//total}%)...\r')
        sys.stdout.flush()

    elapsed = (datetime.now()-t0).total_seconds()
    cur.execute('SELECT COUNT(*), financiera FROM operaciones_brokerage GROUP BY financiera')
    rows_db = cur.fetchall()
    total_db = sum(r[0] for r in rows_db)
    cur.close()
    print(f'\n  Insertadas/actualizadas: {ok} | Errores: {err} | Tiempo: {elapsed:.1f}s')
    print(f'  Total en tabla ahora: {total_db}')
    print(f'  Por financiera: { {r[1]: r[0] for r in rows_db} }')

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print('='*60)
    print('CARGA MASIVA: DETALLE Excel -> operaciones_brokerage')
    print('='*60)

    print('\n[1/3] Conectando a TiDB Cloud...')
    conn = pymysql.connect(**DB)
    print('  Conexion OK')

    print('\n[2/3] Verificando / agregando columnas...')
    agregar_columnas(conn)

    print('\n[3/3] Leyendo Excel e insertando...')
    df = leer_excel()
    insertar(conn, df)

    conn.close()
    print('\nListo!')

if __name__ == '__main__':
    main()
