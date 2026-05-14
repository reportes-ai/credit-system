const router = require('express').Router();
const ctrl = require('../controllers/dealers.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/ccs',       verifyToken, ctrl.getCcsList);
router.get('/importar',  verifyToken, (req, res) => res.status(405).json({ error: 'Use POST' }));
router.post('/importar', verifyToken, ctrl.importar);
router.get('/',          verifyToken, ctrl.getDealers);
router.get('/:id',       verifyToken, ctrl.getDealer);
router.post('/',         verifyToken, ctrl.createDealer);
router.put('/:id',       verifyToken, ctrl.updateDealer);
router.delete('/:id',    verifyToken, ctrl.deleteDealer);

module.exports = router;
