'use strict';
const router = require('express').Router();
const multer = require('multer');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const liquidaciones = require('../controllers/liquidaciones.controller');
const informeDn = require('../controllers/informe-dealernet.controller');
const evalCredito = require('../controllers/evaluacion-credito.controller');
const consulta = require('../controllers/consulta.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 6 } });

router.post('/liquidaciones/evaluar', verifyToken, upload.array('archivos', 6), liquidaciones.evaluar);
router.post('/evaluacion/:id/recalcular', verifyToken, liquidaciones.recalcular);
router.post('/evaluacion/:id/guardar-cliente', verifyToken, liquidaciones.guardarCliente);
router.get('/evaluaciones', verifyToken, liquidaciones.historial);

router.post('/informe-dealernet', verifyToken, informeDn.analizar);
router.get('/informe-dealernet/historial', verifyToken, informeDn.historial);
router.get('/informe-dealernet/ruts', verifyToken, informeDn.rutsConReporte);
router.get('/informe-dealernet/por-rut/:rut', verifyToken, informeDn.porRut);

router.post('/consulta', verifyToken, requireFunc('ia_consulta'), consulta.preguntar);

router.post('/evaluacion-credito', verifyToken, evalCredito.evaluar);
router.get('/evaluacion-credito/detalle/:id', verifyToken, evalCredito.detalle);
router.get('/evaluacion-credito/:rut/historial', verifyToken, evalCredito.historial);
router.get('/evaluacion-credito/:rut', verifyToken, evalCredito.ultima);

module.exports = router;
