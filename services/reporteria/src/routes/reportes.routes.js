'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const c = require('../controllers/reportes.controller');

router.get('/cartera',       verifyToken, c.cartera);
router.get('/cobranza-mora', verifyToken, c.cobranzaMora);

module.exports = router;
