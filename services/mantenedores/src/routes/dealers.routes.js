const router = require('express').Router();
const ctrl = require('../controllers/dealers.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/ccs',       verifyToken, ctrl.getCcsList);
router.get('/importar',  verifyToken, (req, res) => res.status(405).json({ error: 'Use POST' }));
router.post('/importar', verifyToken, requireFunc('mantenedores_dealers'), ctrl.importar);
// Mapa de Dealers (geocodificación Google → lat/lng cacheadas). Antes de '/:id'.
router.get('/mapa',          verifyToken, requireFunc('mantenedores_dealers', 'dealer_inc_ver', 'dealer_ficha_revisar'), ctrl.getMapa);
router.post('/geocodificar', verifyToken, requireFunc('mantenedores_dealers'), ctrl.geocodificar);
router.get('/',          verifyToken, ctrl.getDealers);
router.get('/:id',       verifyToken, ctrl.getDealer);
router.post('/',         verifyToken, requireFunc('mantenedores_dealers', 'dealer_mantener'), ctrl.createDealer);
// Editar dealer: solo Analista de Operaciones (dealer_ficha_revisar) + Admin (bypass). Las
// comisiones pactadas NO se editan aquí — solo vía ficha aprobada o BD. (Crear = solo vía ficha.)
router.put('/:id',       verifyToken, requireFunc('dealer_ficha_revisar'), ctrl.updateDealer);
router.delete('/:id',    verifyToken, requireFunc('mantenedores_dealers'), ctrl.deleteDealer);

module.exports = router;
