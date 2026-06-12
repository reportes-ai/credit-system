'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/desempeno.controller');

// Captura (cualquier usuario logueado)
router.post('/ping',           verifyToken, c.ping);
router.post('/logout',         verifyToken, c.logout);
router.post('/carta-apertura', verifyToken, c.logApertura);
router.post('/comentario-aprob/:id', verifyToken, requireFunc('aprob_revisar'), c.setComentarioAprob);

// Informe (permiso del submódulo)
router.get('/cartas',         verifyToken, requireFunc('aprob_desempeno'), c.reporteDiario);
router.get('/cartas/resumen', verifyToken, requireFunc('aprob_desempeno'), c.reporteResumen);
router.get('/cartas/dia',   verifyToken, requireFunc('aprob_desempeno'), c.reporteDia);
router.get('/cartas/lista', verifyToken, requireFunc('aprob_desempeno'), c.reporteCasos);

module.exports = router;
