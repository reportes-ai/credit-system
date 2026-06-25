'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/fundantes-seg.controller');

router.get('/',                         verifyToken, c.listar);
router.get('/doc/:docId/download',      verifyToken, c.descargar);
router.post('/:id/doc',                 verifyToken, c.subirDoc);
router.delete('/:id/doc/:codigo',       verifyToken, c.eliminarDoc);
router.post('/:id/enviar',              verifyToken, c.enviar);
router.post('/:id/validar',             verifyToken, requireFunc('fundantes_validar'), c.validar);

module.exports = router;
