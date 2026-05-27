'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/ejecutivos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/',      verifyToken, ctrl.getAll);
router.post('/',     verifyToken, ctrl.create);
router.put('/:id',   verifyToken, ctrl.update);
router.delete('/:id',verifyToken, ctrl.remove);

module.exports = router;
