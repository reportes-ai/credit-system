const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/broker-validaciones.controller');

router.get('/',       verifyToken, ctrl.getItems);
router.post('/',      verifyToken, requireFunc('mantenedores_broker_validaciones'), ctrl.createItem);
router.put('/:id',    verifyToken, requireFunc('mantenedores_broker_validaciones'), ctrl.updateItem);
router.delete('/:id', verifyToken, requireFunc('mantenedores_broker_validaciones'), ctrl.deleteItem);

module.exports = router;
