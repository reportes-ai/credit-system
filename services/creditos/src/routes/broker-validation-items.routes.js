const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/broker-validaciones.controller');

router.get('/',       verifyToken, ctrl.getItems);
router.post('/',      verifyToken, ctrl.createItem);
router.put('/:id',    verifyToken, ctrl.updateItem);
router.delete('/:id', verifyToken, ctrl.deleteItem);

module.exports = router;
