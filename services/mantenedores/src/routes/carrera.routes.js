'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/carrera.controller');

router.get('/popup', verifyToken, ctrl.popup);
router.get('/config', verifyToken, requireFunc('mant_carrera'), ctrl.getConfigApi);
router.put('/config', verifyToken, requireFunc('mant_carrera'), ctrl.setConfigApi);

module.exports = router;
