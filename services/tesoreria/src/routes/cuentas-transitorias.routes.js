const router  = require('express').Router();
const ctrl    = require('../controllers/cuentas-transitorias.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Acceso por matriz (Perfiles y Permisos), no por nombre de perfil. Admin pasa por bypass.
const gestionar = requireFunc('tesoreria_cuentas_transitorias');

// Listado de la página principal de Tesorería: exige Ver Tesorería (auditoría
// 2026-08-08). Los lookups por id_credito quedan abiertos: los usa la ficha del
// crédito desde otros módulos.
router.get('/',                              verifyToken, requireFunc('tesorería_ver'), ctrl.list);
router.get('/por-credito/:id_credito',       verifyToken,            ctrl.porCredito);
router.get('/cartola/:id_credito',           verifyToken,            ctrl.cartola);
router.post('/admin/fix-transitoria',        verifyToken, gestionar, ctrl.adminFixTransitoria);
router.delete('/transitoria/:id',            verifyToken, gestionar, ctrl.deleteTransitoria);

module.exports = router;
