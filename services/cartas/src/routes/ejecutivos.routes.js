'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/ejecutivos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/',      verifyToken, ctrl.getAll);
router.post('/',     verifyToken, requireFunc('cartas_manten_usuarios'), ctrl.create);
router.put('/:id',   verifyToken, requireFunc('cartas_manten_usuarios'), ctrl.update);
router.delete('/:id',verifyToken, requireFunc('cartas_manten_usuarios'), ctrl.remove);

module.exports = router;
