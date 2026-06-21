'use strict';
const router = require('express').Router();
const multer = require('multer');
const { verifyToken } = require('../../../../shared/middleware/auth');
const liquidaciones = require('../controllers/liquidaciones.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

router.post('/liquidacion', verifyToken, upload.single('archivo'), liquidaciones.analizar);
router.post('/liquidacion/:id/guardar-cliente', verifyToken, liquidaciones.guardarCliente);
router.get('/liquidaciones', verifyToken, liquidaciones.historial);

module.exports = router;
