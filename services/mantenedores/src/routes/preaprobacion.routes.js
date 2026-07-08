'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/preaprobacion.controller');

// Políticas de Preaprobación (portal dealer + WhatsApp) — mantenedor
router.get('/', verifyToken, requireFunc('mant_preaprobacion'), c.getAll);
router.put('/', verifyToken, requireFunc('mant_preaprobacion'), c.update);

module.exports = router;
