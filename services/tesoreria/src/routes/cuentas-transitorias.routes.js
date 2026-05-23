const router  = require('express').Router();
const ctrl    = require('../controllers/cuentas-transitorias.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = requirePerfil('Administrador', 'Gerente');

router.get('/',                              verifyToken,            ctrl.list);
router.get('/por-credito/:id_credito',       verifyToken,            ctrl.porCredito);
router.get('/cartola/:id_credito',           verifyToken,            ctrl.cartola);
router.post('/admin/fix-transitoria',        verifyToken, soloAdmin, ctrl.adminFixTransitoria);
router.delete('/transitoria/:id',            verifyToken, soloAdmin, ctrl.deleteTransitoria);

module.exports = router;
