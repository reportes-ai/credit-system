'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/linea-credito.controller');

const ver = requireFunc('linea_credito', 'linea_credito_gestionar');
const gestionar = requireFunc('linea_credito_gestionar');

router.get('/',                             verifyToken, ver, c.resumen);
router.get('/:id/movimientos',              verifyToken, ver, c.movimientos);
router.get('/certificado/:idMov/pdf',       verifyToken, ver, c.pdf);
router.put('/:id/config',                   verifyToken, gestionar, c.guardarConfig);
router.post('/:id/preview/certificado',      verifyToken, ver, c.previewPdf);
router.post('/:id/preview/correo',           verifyToken, ver, c.previewCorreo);
router.post('/:id/giros',                   verifyToken, gestionar, c.registrarGiro);
router.post('/:id/pagos',                   verifyToken, gestionar, c.registrarPago);
router.post('/procesar',                    verifyToken, gestionar, c.procesarAhora);
router.post('/movimiento/:idMov/anular',    verifyToken, gestionar, c.anularMov);
router.post('/certificado/:idMov/respuesta', verifyToken, gestionar, c.responder);
router.post('/certificado/:idMov/reemitir', verifyToken, gestionar, c.reemitir);
router.post('/certificado/:idMov/enviar',   verifyToken, gestionar, c.enviar);

module.exports = router;
