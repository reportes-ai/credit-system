'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/carga-diferencias.controller');

// Cola de diferencias entre la carga masiva y nuestros datos.
router.get ('/conteo',    verifyToken, requireFunc('carga_diferencias'), ctrl.conteo);
router.get ('/lista',     verifyToken, requireFunc('carga_diferencias'), ctrl.lista);
router.get ('/historial', verifyToken, requireFunc('carga_diferencias'), ctrl.historial);
router.post('/resolver',  verifyToken, requireFunc('carga_diferencias'), ctrl.resolver);

module.exports = router;
