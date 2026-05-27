'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/cartas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/',  verifyToken, ctrl.getAll);
router.post('/', verifyToken, ctrl.upsert);   // create o update según body.id

module.exports = router;
