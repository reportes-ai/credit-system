'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/edicion.controller');

router.get ('/',          verifyToken, ctrl.getCreditos);
router.put ('/:id',       verifyToken, requireFunc('edicion_creditos_editar'), ctrl.updateCredito);
router.get ('/:id/log',   verifyToken, ctrl.getLog);

module.exports = router;
