'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/arana.controller');

// Avisos de Araña (AutoFin) — públicos: AutoFin los llama con el token ARANA_AVISOS_TOKEN, no con nuestro JWT
router.post('/avisos/evaluacion', ctrl.exigirToken, ctrl.avisoEvaluacion);
router.post('/avisos/estado',     ctrl.exigirToken, ctrl.avisoEstado);

module.exports = router;
