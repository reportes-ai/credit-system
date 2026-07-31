'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/anulaciones.controller');

router.get('/buscar',        verifyToken, requireFunc('operacion_anular_solicitar'), c.buscar);
router.post('/',             verifyToken, requireFunc('operacion_anular_solicitar'), c.solicitar);
router.get('/',              verifyToken, requireFunc('operacion_anular_solicitar', 'operacion_anular_aprobar'), c.listar);
router.post('/:id/resolver', verifyToken, requireFunc('operacion_anular_aprobar'), c.resolver);

module.exports = router;
