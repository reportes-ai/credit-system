'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/mando.controller');

router.get('/', verifyToken, ctrl.mando);

module.exports = router;
