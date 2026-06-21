'use strict';
const router = require('express').Router();
const multer = require('multer');
const { verifyToken } = require('../../../../shared/middleware/auth');
const liquidaciones = require('../controllers/liquidaciones.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 6 } });

router.post('/liquidaciones/evaluar', verifyToken, upload.array('archivos', 6), liquidaciones.evaluar);
router.post('/evaluacion/:id/recalcular', verifyToken, liquidaciones.recalcular);
router.post('/evaluacion/:id/guardar-cliente', verifyToken, liquidaciones.guardarCliente);
router.get('/evaluaciones', verifyToken, liquidaciones.historial);

module.exports = router;
