'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/desempeno.controller');

// Captura (cualquier usuario logueado)
router.post('/ping',           verifyToken, c.ping);
router.post('/logout',         verifyToken, c.logout);
router.post('/carta-apertura', verifyToken, c.logApertura);

// Informe (permiso del submódulo)
router.get('/cartas',     verifyToken, requireFunc('aprob_desempeno'), c.reporteDiario);
router.get('/cartas/dia', verifyToken, requireFunc('aprob_desempeno'), c.reporteDia);

module.exports = router;
