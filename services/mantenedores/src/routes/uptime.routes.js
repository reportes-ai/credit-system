'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/uptime.controller');

router.get('/historia', verifyToken, requireFunc('uptime_mant'), c.historia);
router.get('/costos', verifyToken, requireFunc('uptime_mant'), c.costosGet);
router.put('/costos/:codigo', verifyToken, requireFunc('uptime_mant'), c.costosSet);

module.exports = router;
