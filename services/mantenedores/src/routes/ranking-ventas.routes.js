'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/ranking-ventas.controller');

// Popup del podio: cualquier usuario logueado (el ?test=1 lo usa el mantenedor, sin efecto persistente)
router.get('/popup', verifyToken, ctrl.popup);

// Mantenedor
router.get('/config', verifyToken, requireFunc('mant_ranking_ventas'), ctrl.getConfigApi);
router.put('/config', verifyToken, requireFunc('mant_ranking_ventas'), ctrl.setConfigApi);

module.exports = router;
