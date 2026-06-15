const router = require('express').Router();
const ctrl = require('../controllers/dealers.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/ccs',       verifyToken, ctrl.getCcsList);
router.get('/importar',  verifyToken, (req, res) => res.status(405).json({ error: 'Use POST' }));
router.post('/importar', verifyToken, requireFunc('mantenedores_dealers'), ctrl.importar);
router.get('/',          verifyToken, ctrl.getDealers);
router.get('/:id',       verifyToken, ctrl.getDealer);
router.post('/',         verifyToken, requireFunc('mantenedores_dealers'), ctrl.createDealer);
router.put('/:id',       verifyToken, requireFunc('mantenedores_dealers'), ctrl.updateDealer);
router.delete('/:id',    verifyToken, requireFunc('mantenedores_dealers'), ctrl.deleteDealer);

module.exports = router;
