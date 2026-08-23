'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/dashboard-tesoreria.controller');

router.get('/dashboard', verifyToken, requireFunc('tes_dashboard'), c.dashboardTes);

module.exports = router;
