'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/rrhh.controller');

router.get('/pendientes', verifyToken, requireFunc('rh_ver', 'rh_vacaciones', 'rh_antiguedad', 'rh_aprobar'), ctrl.pendientes);

// Vacaciones
router.get('/vacaciones',          verifyToken, requireFunc('rh_vacaciones', 'rh_aprobar'), ctrl.listarVacaciones);
router.post('/vacaciones',         verifyToken, requireFunc('rh_vacaciones'), ctrl.crearVacaciones);
router.post('/vacaciones/:id/resolver', verifyToken, requireFunc('rh_aprobar'), ctrl.resolverVacaciones);

// Antigüedad
router.get('/antiguedad',          verifyToken, requireFunc('rh_antiguedad', 'rh_aprobar'), ctrl.listarAntiguedad);
router.post('/antiguedad',         verifyToken, requireFunc('rh_antiguedad'), ctrl.crearAntiguedad);
router.post('/antiguedad/:id/resolver', verifyToken, requireFunc('rh_aprobar'), ctrl.resolverAntiguedad);

// Certificado de antigüedad self-service (QR verificable)
router.get('/antiguedad/cert/estado',  verifyToken, requireFunc('rh_antiguedad', 'rh_aprobar'), ctrl.certEstado);
router.post('/antiguedad/cert/emitir', verifyToken, requireFunc('rh_antiguedad', 'rh_aprobar'), ctrl.certEmitir);
router.get('/empleados',               verifyToken, requireFunc('rh_aprobar'), ctrl.listarEmpleados);

// Cumpleaños (popup del cumpleañero + banner a compañeros; cualquier usuario logueado)
router.get('/cumple/estado', verifyToken, ctrl.cumpleEstado);
router.get('/cumple/hoy',    verifyToken, ctrl.cumpleHoy);

// Remuneraciones (Fase 3 módulo RRHH) — solo RRHH salvo la liquidación propia
const rem = require('../controllers/remuneraciones.controller');
router.get('/remuneraciones',                 verifyToken, requireFunc('rh_remuneraciones'), rem.getMes);
router.post('/remuneraciones/guardar',        verifyToken, requireFunc('rh_remuneraciones'), rem.guardar);
router.post('/remuneraciones/emitir',         verifyToken, requireFunc('rh_remuneraciones'), rem.emitir);
router.get('/remuneraciones/mias',            verifyToken, rem.misLiquidaciones);
router.get('/remuneraciones/previred',        verifyToken, requireFunc('rh_remuneraciones'), rem.getPrevired);
const con = require('../controllers/contratos.controller');
router.get('/contratos/cargos',        verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.getCargos);
router.post('/contratos/cargos',       verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.guardarCargo);
router.delete('/contratos/cargos/:id', verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.eliminarCargo);
router.get('/contratos/beneficios',    verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.getBeneficios);
router.post('/contratos/beneficios',   verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.guardarBeneficio);
router.get('/contratos/cartas',        verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.getCartas);
router.post('/contratos/cartas',       verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.guardarCarta);
router.put('/contratos/cartas/:id/estado', verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.cambiarEstadoCarta);
router.post('/contratos/cartas/:id/contratar', verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.contratarDesdeCarta);
router.get('/contratos',               verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.getContratos);
router.get('/finiquitos/colaboradores', verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.finiquitoColaboradores);
router.get('/finiquitos/calcular',      verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.finiquitoCalcular);
router.post('/finiquitos',              verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.finiquitoGuardar);
router.get('/finiquitos',               verifyToken, requireFunc('rh_contratos', 'rh_colaboradores'), con.finiquitoLista);
const vc = require('../controllers/vac-cuenta.controller');
router.get('/vacaciones/cuenta',        verifyToken, vc.getCuenta);
router.post('/vacaciones/cuenta/ajuste', verifyToken, requireFunc('rh_aprobar', 'rh_colaboradores'), vc.ajuste);
router.get('/vacaciones/saldos',         verifyToken, requireFunc('rh_aprobar', 'rh_colaboradores'), vc.getSaldos);
router.put('/remuneraciones/previred-config', verifyToken, requireFunc('rh_remuneraciones'), rem.putPreviredConfig);
router.get('/remuneraciones/adicionales',        verifyToken, requireFunc('rh_remuneraciones'), rem.getAdicionales);
router.post('/remuneraciones/adicionales',       verifyToken, requireFunc('rh_remuneraciones'), rem.crearAdicional);
router.delete('/remuneraciones/adicionales/:id', verifyToken, requireFunc('rh_remuneraciones'), rem.eliminarAdicional);
router.get('/remuneraciones/descuentos',         verifyToken, requireFunc('rh_remuneraciones'), rem.getDescuentos);
router.post('/remuneraciones/descuentos',        verifyToken, requireFunc('rh_remuneraciones'), rem.crearDescuento);
router.post('/remuneraciones/descuentos/:id/anular', verifyToken, requireFunc('rh_remuneraciones'), rem.anularDescuento);
router.get('/remuneraciones/indicadores',     verifyToken, requireFunc('mant_remuneraciones', 'rh_remuneraciones'), rem.getIndicadores);
router.put('/remuneraciones/indicadores',     verifyToken, requireFunc('mant_remuneraciones'), rem.putIndicadores);
router.post('/remuneraciones/indicadores/revisar', verifyToken, requireFunc('mant_remuneraciones'), rem.revisarAhora);
router.get('/remuneraciones/indicadores/propuesta', verifyToken, requireFunc('mant_remuneraciones', 'rh_remuneraciones'), rem.getPropuesta);
router.post('/remuneraciones/indicadores/propuesta/:id/resolver', verifyToken, requireFunc('mant_remuneraciones'), rem.resolverPropuesta);
router.get('/remuneraciones/liquidacion/:id', verifyToken, rem.getLiquidacion); // valida dueño/RRHH adentro

// Aumento de Renta (calculadora sobre el motor único de liquidaciones)
router.get('/remuneraciones/aumento-renta/personas', verifyToken, requireFunc('rh_aumento_renta', 'rh_remuneraciones'), rem.aumentoPersonas);
router.post('/remuneraciones/aumento-renta',         verifyToken, requireFunc('rh_aumento_renta', 'rh_remuneraciones'), rem.aumentoRenta);

// Ausencias y Permisos + Saldo de Vacaciones (Fase 2 módulo RRHH)
const aus = require('../controllers/ausencias.controller');
router.get('/ausencias/hoy',          verifyToken, aus.ausentesHoy);
router.get('/ausencias/licencias-resumen', verifyToken, requireFunc('rh_ausencias', 'rh_aprobar'), aus.licenciasResumen); // valida RRHH/jefe adentro
router.get('/ausencias/adjunto/:id',  verifyToken, aus.adjunto);
router.get('/ausencias',              verifyToken, requireFunc('rh_ausencias', 'rh_aprobar'), aus.listar);
router.post('/ausencias',             verifyToken, requireFunc('rh_ausencias'), aus.crear);
router.post('/ausencias/:id/resolver', verifyToken, aus.resolver); // valida jefatura/RRHH adentro
router.get('/vacaciones/saldo',       verifyToken, aus.saldoVacaciones);

// Ficha del Colaborador + Carpeta Digital + Directorio (Fase 1 módulo RRHH)
const ficha = require('../controllers/ficha.controller');
router.get('/directorio',          verifyToken, requireFunc('rh_directorio', 'rh_ver', 'rh_aprobar'), ficha.directorio);
router.get('/organigrama',         verifyToken, requireFunc('rh_directorio', 'rh_ver', 'rh_aprobar'), ficha.organigrama);
router.get('/directorio/config',   verifyToken, requireFunc('rh_directorio_config'), ficha.directorioConfig);
router.put('/directorio/config',   verifyToken, requireFunc('rh_directorio_config'), ficha.guardarDirectorioConfig);
router.get('/colaboradores',       verifyToken, requireFunc('rh_colaboradores', 'rh_aprobar'), ficha.listarColaboradores);
router.get('/ficha',               verifyToken, ficha.getFicha);
router.get('/ficha/:id',           verifyToken, ficha.getFicha);
router.put('/ficha/:id',           verifyToken, ficha.putFicha);
router.get('/docs/archivo/:docId', verifyToken, ficha.descargarDoc);
router.post('/docs/:idUsuario',    verifyToken, requireFunc('rh_aprobar'), ficha.subirDoc);
router.delete('/docs/:docId',      verifyToken, requireFunc('rh_aprobar'), ficha.eliminarDoc);

// Config del mantenedor Saludos y Certificados RRHH
router.get('/config', verifyToken, requireFunc('mant_rrhh_saludos', 'rh_aprobar'), ctrl.getConfigApi);
router.put('/config', verifyToken, requireFunc('mant_rrhh_saludos', 'rh_aprobar'), ctrl.setConfigApi);

module.exports = router;
