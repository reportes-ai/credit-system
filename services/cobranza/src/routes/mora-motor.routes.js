'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/mora-motor.controller');

router.get('/',          verifyToken, c.getTodo);
router.put('/plantilla', verifyToken, requireFunc('mant_cobranza_mora'), c.guardarPlantilla);
router.put('/config',    verifyToken, requireFunc('mant_cobranza_mora'), c.guardarConfig);
router.post('/preview',  verifyToken, c.preview);
router.post('/correr',   verifyToken, requireFunc('mant_cobranza_mora'), c.correrAhora);

module.exports = router;
