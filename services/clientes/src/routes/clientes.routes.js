const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/clientes.controller');

router.get('/reporteria', verifyToken, ctrl.getReporteria);
router.get('/rut/:rut',  verifyToken, ctrl.getByRut);
router.get('/',         verifyToken, ctrl.getAll);
router.get('/:id',      verifyToken, ctrl.getById);
router.post('/',        verifyToken, requireFunc('clientes.crear'),  ctrl.create);
router.put('/:id',      verifyToken, requireFunc('clientes.editar'), ctrl.update);

module.exports = router;
