const router = require('express').Router();
const ctrl   = require('../controllers/cuentas-transitorias.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/',                         verifyToken, ctrl.list);
router.get('/por-credito/:id_credito',  verifyToken, ctrl.porCredito);
router.get('/cartola/:id_credito',      verifyToken, ctrl.cartola);

module.exports = router;
