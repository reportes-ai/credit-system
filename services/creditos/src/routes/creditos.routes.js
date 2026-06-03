const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/creditos.controller');

router.get('/reporteria', verifyToken, ctrl.getReporteria);
router.get('/',           verifyToken, ctrl.getAll);
router.get('/:id', verifyToken, ctrl.getById);
router.post('/',   verifyToken, ctrl.create);
router.put('/:id', verifyToken, ctrl.update);

module.exports = router;
