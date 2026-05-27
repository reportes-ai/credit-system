'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/parametros.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/:key',  verifyToken, ctrl.getParam);
router.post('/:key', verifyToken, ctrl.setParam);

module.exports = router;
