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

// Ficha del Colaborador + Carpeta Digital + Directorio (Fase 1 módulo RRHH)
const ficha = require('../controllers/ficha.controller');
router.get('/directorio',          verifyToken, requireFunc('rh_directorio', 'rh_ver', 'rh_aprobar'), ficha.directorio);
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
