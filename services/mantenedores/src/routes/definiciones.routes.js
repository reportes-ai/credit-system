'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const c = require('../controllers/definiciones.controller');

router.get('/',        verifyToken, c.getAll);
router.post('/',       verifyToken, requireFunc('mant_definiciones'), c.crear);
router.put('/:id',     verifyToken, requireFunc('mant_definiciones'), c.actualizar);
router.delete('/:id',  verifyToken, requireFunc('mant_definiciones'), c.eliminar);

module.exports = router;
