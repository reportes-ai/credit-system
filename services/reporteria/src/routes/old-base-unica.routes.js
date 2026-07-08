'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/old-base-unica.controller');

// Old Base Única — dataset read-only. Restringido por funcionalidad.
router.get('/', verifyToken, requireFunc('old_base_unica_ver'), c.getDatos);

module.exports = router;
