const router  = require('express').Router();
const ctrl    = require('../controllers/cuentas-transitorias.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Acceso por matriz (Perfiles y Permisos), no por nombre de perfil. Admin pasa por bypass.
const gestionar = requireFunc('tesoreria_cuentas_transitorias');

router.get('/',                              verifyToken,            ctrl.list);
router.get('/por-credito/:id_credito',       verifyToken,            ctrl.porCredito);
router.get('/cartola/:id_credito',           verifyToken,            ctrl.cartola);
router.post('/admin/fix-transitoria',        verifyToken, gestionar, ctrl.adminFixTransitoria);
router.delete('/transitoria/:id',            verifyToken, gestionar, ctrl.deleteTransitoria);

module.exports = router;
