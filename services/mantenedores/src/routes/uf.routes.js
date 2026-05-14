const router = require('express').Router();
const ctrl = require('../controllers/uf.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/', verifyToken, ctrl.getAll);
router.get('/vigente', verifyToken, ctrl.getVigente);
router.post('/importar', verifyToken, ctrl.importarCSV);
router.post('/', verifyToken, ctrl.create);
router.put('/:id', verifyToken, ctrl.update);
router.delete('/:id', verifyToken, ctrl.remove);

module.exports = router;
