'use strict';
const express  = require('express');
const router   = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c        = require('../controllers/bitacora.controller');

// Bitácora de un Crédito — timeline read-only. Restringido por funcionalidad.
router.get('/', verifyToken, requireFunc('rep_bitacora'), c.buscar);

module.exports = router;
