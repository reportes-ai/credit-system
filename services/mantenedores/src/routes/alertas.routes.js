'use strict';
const express    = require('express');
const router     = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl       = require('../controllers/alertas.controller');

router.get('/vencimientos', verifyToken, ctrl.getVencimientos);

module.exports = router;
