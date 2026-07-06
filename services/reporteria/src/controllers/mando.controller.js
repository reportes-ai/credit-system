'use strict';
/* ── Cuadro de Mando (TV de la oficina) ───────────────────────────────────
   Un solo endpoint agregado que alimenta /mando/ — todo son lecturas
   (COUNT/SUM) sobre las fuentes únicas: creditos, cartas_aprobacion, uf,
   tasas, presupuesto del dashboard, pagos y gestiones del día. */
const pool = require('../../../../shared/config/database');
const { conectadosIds } = require('../../../../shared/presencia');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg) => res.status(500).json({ success: false, data: null, error: msg });

exports.mando = async (req, res) => {
  try {
    const [
      [[uf]], [[tasa]], ejecutivos,
      [[cartasHoy]], cartasHora, [[otHoy]],
      [[mtd]], [[prevMismo]], [[prevTotal]], [[anioMismo]], [[anioTotal]],
      [[pagosHoy]], [[gestHoy]], [[wspHoy]], pptoRow,
    ] = await Promise.all([
      pool.query('SELECT valor, DATE_FORMAT(fecha,"%Y-%m-%d") fecha FROM uf WHERE fecha <= CURDATE() ORDER BY fecha DESC LIMIT 1'),
      pool.query('SELECT tasa_mensual_menor, tasa_mensual_mayor FROM tasas WHERE fecha_desde <= CURDATE() ORDER BY fecha_desde DESC LIMIT 1'),
      // MISMA fuente que el selector de Ejecutivo (cartas/ejecutivos.controller):
      // usuarios ACTIVOS con perfil Ejecutivo/Ejecutivo Comercial o permiso de crear carta/crédito
      pool.query(`
        SELECT u.id_usuario,
               TRIM(CONCAT(SUBSTRING_INDEX(TRIM(u.nombre),' ',1), ' ', SUBSTRING_INDEX(TRIM(COALESCE(u.apellido,'')),' ',1))) AS nombre
        FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
        WHERE u.estado = 'activo' AND p.nombre <> 'Administrador'
          AND (
            p.nombre IN ('Ejecutivo','Ejecutivo Comercial')
            OR EXISTS (SELECT 1 FROM permisos_perfil pp JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
                       WHERE pp.id_perfil = u.id_perfil AND pp.habilitado = 1 AND f.codigo IN ('aprob_crear','creditos.crear'))
            OR EXISTS (SELECT 1 FROM permisos_usuario puu JOIN funcionalidades f2 ON f2.id_funcionalidad = puu.id_funcionalidad
                       WHERE puu.id_usuario = u.id_usuario AND puu.habilitado = 1 AND f2.codigo IN ('aprob_crear','creditos.crear'))
          )
        ORDER BY nombre`).then(r => r[0]),
      pool.query("SELECT COUNT(*) n FROM cartas_aprobacion WHERE DATE(fecha_creacion)=CURDATE() AND COALESCE(status,'') NOT IN ('ELIMINADA')"),
      pool.query("SELECT HOUR(fecha_creacion) h, COUNT(*) n FROM cartas_aprobacion WHERE DATE(fecha_creacion)=CURDATE() GROUP BY 1 ORDER BY 1").then(r => r[0]),
      pool.query("SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos WHERE estado_credito='OTORGADO' AND fecha_otorgado=CURDATE()"),
      // Mes actual a la fecha
      pool.query(`SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO' AND fecha_otorgado BETWEEN DATE_FORMAT(CURDATE(),'%Y-%m-01') AND CURDATE()`),
      // Mes anterior, mismos días (1..D)
      pool.query(`SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO'
          AND fecha_otorgado BETWEEN DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH),'%Y-%m-01')
          AND DATE_SUB(CURDATE(), INTERVAL 1 MONTH)`),
      pool.query(`SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO'
          AND fecha_otorgado BETWEEN DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH),'%Y-%m-01')
          AND LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))`),
      // Mismo mes año anterior, mismos días y total
      pool.query(`SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO'
          AND fecha_otorgado BETWEEN DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR),'%Y-%m-01')
          AND DATE_SUB(CURDATE(), INTERVAL 1 YEAR)`),
      pool.query(`SELECT COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE estado_credito='OTORGADO'
          AND fecha_otorgado BETWEEN DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 YEAR),'%Y-%m-01')
          AND LAST_DAY(DATE_SUB(CURDATE(), INTERVAL 1 YEAR))`),
      // Ticker del día
      pool.query("SELECT COUNT(*) n, COALESCE(SUM(total_pagado),0) monto FROM pagos_credito WHERE DATE(COALESCE(fecha_pago, created_at))=CURDATE() AND fecha_reverso IS NULL"),
      pool.query('SELECT COUNT(*) n FROM cobranza_gestiones WHERE DATE(created_at)=CURDATE()'),
      pool.query('SELECT COUNT(*) n FROM wsp_mensajes WHERE DATE(created_at)=CURDATE()').catch(() => [[{ n: null }]]),
      pool.query("SELECT config_value FROM dashboard_config WHERE config_key='presupuesto'").then(r => r[0][0] || null),
    ]);

    // Stats del MES por ejecutivo, sobre el campo `mes` de la base única:
    // APROBADOS = APROBADO + OTORGADO (todo otorgado fue aprobado antes) — clave para
    // la tasa de conversión (otorgados / aprobados)
    const [cartasEj] = await pool.query(`
      SELECT TRIM(ejecutivo) nombre, COUNT(*) n FROM creditos
      WHERE estado_credito IN ('APROBADO','OTORGADO') AND mes = DATE_FORMAT(CURDATE(),'%Y-%m-01')
      GROUP BY 1`);
    const [otsEj] = await pool.query(`
      SELECT TRIM(ejecutivo) nombre, COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto FROM creditos
      WHERE estado_credito='OTORGADO' AND mes = DATE_FORMAT(CURDATE(),'%Y-%m-01')
      GROUP BY 1`);
    // Normaliza (minúsculas, sin tildes/ñ) y matchea con tolerancia: en cartas/creditos
    // el nombre puede venir en MAYÚSCULAS o con variantes ("CATHERINE" vs "Catherinne")
    const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
    // ACUMULAR (no pisar): el mismo ejecutivo aparece con variantes de escritura
    // ("KAREN FARIAS" / "KAREN FARÍAS" / "Karen Farías") que normalizan a la misma llave
    const mapCartas = {}, mapOts = {};
    cartasEj.forEach(r => { const k = norm(r.nombre); mapCartas[k] = (mapCartas[k] || 0) + Number(r.n); });
    otsEj.forEach(r => {
      const k = norm(r.nombre);
      if (!mapOts[k]) mapOts[k] = { n: 0, monto: 0 };
      mapOts[k].n += Number(r.n); mapOts[k].monto += Math.round(Number(r.monto));
    });
    // Devuelve TODAS las llaves compatibles con el nombre (exacta + variantes con el
    // mismo apellido y nombre que comparte prefijo: "catherine"≈"catherinne")
    function llaves(map, nombre) {
      const k = norm(nombre);
      const [nom, ape] = k.split(' ');
      return Object.keys(map).filter(x => {
        if (x === k) return true;
        if (!ape) return false;
        const [xn, xa] = x.split(' ');
        return xa === ape && xn && nom && (xn.startsWith(nom.slice(0, 5)) || nom.startsWith(xn.slice(0, 5)));
      });
    }
    const sumCartas = nombre => llaves(mapCartas, nombre).reduce((s, k) => s + mapCartas[k], 0);
    const sumOts = nombre => llaves(mapOts, nombre).reduce((s, k) => ({ n: s.n + mapOts[k].n, monto: s.monto + mapOts[k].monto }), { n: 0, monto: 0 });

    /* ── Analistas de Crédito (incluye Supervisor de Crédito) ── */
    const [analistasBase] = await pool.query(`
      SELECT u.id_usuario,
             TRIM(CONCAT(SUBSTRING_INDEX(TRIM(u.nombre),' ',1), ' ', SUBSTRING_INDEX(TRIM(COALESCE(u.apellido,'')),' ',1))) AS nombre,
             p.nombre perfil
      FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
      WHERE u.estado = 'activo'
        AND p.nombre IN ('Analista de Crédito','Analista de Operaciones','Supervisor de Crédito')
      ORDER BY p.nombre = 'Supervisor de Crédito' DESC, nombre`);
    const idsAna = analistasBase.map(a => a.id_usuario);

    // Cartas aprobadas del mes por aprobador + tiempo creación→aprobación
    const [cartasAprob] = await pool.query(`
      SELECT TRIM(aprobado_por_nombre) nombre, COUNT(*) n
      FROM cartas_aprobacion
      WHERE fecha_aprobacion >= DATE_FORMAT(CURDATE(),'%Y-%m-01') AND aprobado_por_nombre IS NOT NULL
      GROUP BY 1`);
    const [[totAprob]] = await pool.query(`
      SELECT COUNT(*) n FROM cartas_aprobacion WHERE fecha_aprobacion >= DATE_FORMAT(CURDATE(),'%Y-%m-01')`);
    const [durs] = await pool.query(`
      SELECT TIMESTAMPDIFF(MINUTE, fecha_creacion, fecha_aprobacion) m
      FROM cartas_aprobacion
      WHERE fecha_aprobacion >= DATE_FORMAT(CURDATE(),'%Y-%m-01') AND fecha_creacion IS NOT NULL`);
    // Corrección tz conocida: algunas fecha_creacion quedaron +4h (gotcha mysql2) → diffs negativos
    const dursOk = durs.map(r => { let m = Number(r.m); if (m < 0) m += 240; return m; })
      .filter(m => m >= 0 && m <= 43200); // descarta outliers > 30 días
    const tPromMin = dursOk.length ? Math.round(dursOk.reduce((s, m) => s + m, 0) / dursOk.length) : null;

    // Créditos digitados del mes por usuario creador
    const [digit] = await pool.query(`
      SELECT id_usuario, COUNT(*) n FROM creditos
      WHERE created_at >= DATE_FORMAT(CURDATE(),'%Y-%m-01') AND id_usuario IS NOT NULL
      GROUP BY 1`);
    const [[totDigit]] = await pool.query(`
      SELECT COUNT(*) n FROM creditos WHERE created_at >= DATE_FORMAT(CURDATE(),'%Y-%m-01') AND id_usuario IS NOT NULL`);
    const mapDigit = {}; digit.forEach(r => { mapDigit[r.id_usuario] = Number(r.n); });

    // Horas de conexión del mes (bloques de 5 min) + servicio de HOY (primera/última actividad)
    let horasMes = {}, servicio = { inicio: null, cierre: null };
    if (idsAna.length) {
      const [hb] = await pool.query(`
        SELECT id_usuario, COUNT(*) b FROM presencia_bloques
        WHERE id_usuario IN (?) AND bloque >= DATE_FORMAT(CURDATE(),'%Y-%m-01')
        GROUP BY 1`, [idsAna]);
      hb.forEach(r => { horasMes[r.id_usuario] = Math.round(Number(r.b) * 5 / 60 * 10) / 10; });
      const [[svc]] = await pool.query(`
        SELECT DATE_FORMAT(MIN(bloque),'%H:%i') inicio, DATE_FORMAT(MAX(bloque),'%H:%i') cierre
        FROM presencia_bloques WHERE id_usuario IN (?) AND DATE(bloque) = CURDATE()`, [idsAna]);
      servicio = { inicio: svc.inicio, cierre: svc.cierre };
    }

    const vivos = conectadosIds();
    const lista = ejecutivos.map(e => {
      const ot = sumOts(e.nombre);
      return { nombre: e.nombre.trim(), conectado: vivos.has(Number(e.id_usuario)),
               aprobados_mes: sumCartas(e.nombre), otorgados_mes: ot.n, monto_mes: ot.monto };
    });

    // Presupuesto del mes en curso ({mes:'YYYY-MM', ops, monto} — monto en MM$)
    let ppto = null;
    try {
      const arr = JSON.parse(pptoRow?.config_value || '[]');
      const mesActual = new Date().toISOString().slice(0, 7);
      ppto = arr.find(x => x.mes === mesActual) || null;
    } catch (e) { ppto = null; }

    const mapAprob = {}; cartasAprob.forEach(r => { const k = norm(r.nombre); mapAprob[k] = (mapAprob[k] || 0) + Number(r.n); });
    const sumAprobPor = nombre => llaves(mapAprob, nombre).reduce((s, k) => s + mapAprob[k], 0);
    const analistas = analistasBase.map(a => ({
      nombre: a.nombre, perfil: a.perfil, conectado: vivos.has(Number(a.id_usuario)),
      cartas_aprobadas_mes: sumAprobPor(a.nombre),
      digitados_mes: mapDigit[a.id_usuario] || 0,
      horas_mes: horasMes[a.id_usuario] || 0,
    }));

    ok(res, {
      ahora: new Date().toISOString(),
      analistas: {
        lista: analistas,
        total_cartas_aprobadas_mes: Number(totAprob.n) || 0,
        total_digitados_mes: Number(totDigit.n) || 0,
        t_prom_aprobacion_min: tPromMin,
        servicio_hoy: servicio,
      },
      indicadores: {
        uf: uf ? Number(uf.valor) : null, uf_fecha: uf?.fecha || null,
        tmc_menor: tasa ? Number(tasa.tasa_mensual_menor) : null,
        tmc_mayor: tasa ? Number(tasa.tasa_mensual_mayor) : null,
      },
      ejecutivos: { total: lista.length, conectados: lista.filter(e => e.conectado).length, lista },
      hoy: {
        cartas: Number(cartasHoy.n) || 0,
        cartasPorHora: cartasHora.map(r => ({ h: Number(r.h), n: Number(r.n) })),
        otorgados: Number(otHoy.n) || 0,
        monto_otorgado: Math.round(Number(otHoy.monto) || 0),
        pagos: Number(pagosHoy.n) || 0, monto_pagos: Math.round(Number(pagosHoy.monto) || 0),
        gestiones_cobranza: Number(gestHoy.n) || 0,
        mensajes_wsp: wspHoy.n == null ? null : Number(wspHoy.n),
      },
      mes: {
        mtd_n: Number(mtd.n) || 0, mtd_monto: Math.round(Number(mtd.monto) || 0),
        prev_mismo_n: Number(prevMismo.n) || 0, prev_mismo_monto: Math.round(Number(prevMismo.monto) || 0),
        prev_total_n: Number(prevTotal.n) || 0,
        anio_mismo_n: Number(anioMismo.n) || 0, anio_mismo_monto: Math.round(Number(anioMismo.monto) || 0),
        anio_total_n: Number(anioTotal.n) || 0,
        presupuesto: ppto,   // { mes, ops, monto (MM$) } o null
      },
    });
  } catch (e) { console.error('[mando]', e.message); fail(res, e.message); }
};
