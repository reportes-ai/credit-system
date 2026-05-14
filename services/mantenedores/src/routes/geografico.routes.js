const router = require('express').Router();
const ctrl = require('../controllers/geografico.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/regiones', verifyToken, ctrl.getRegiones);
router.post('/regiones', verifyToken, ctrl.createRegion);
router.put('/regiones/:id', verifyToken, ctrl.updateRegion);
router.delete('/regiones/:id', verifyToken, ctrl.deleteRegion);

router.get('/provincias', verifyToken, ctrl.getProvincias);
router.post('/provincias', verifyToken, ctrl.createProvincia);
router.put('/provincias/:id', verifyToken, ctrl.updateProvincia);
router.delete('/provincias/:id', verifyToken, ctrl.deleteProvincia);

router.get('/comunas', verifyToken, ctrl.getComunas);
router.post('/comunas', verifyToken, ctrl.createComuna);
router.put('/comunas/:id', verifyToken, ctrl.updateComuna);
router.delete('/comunas/:id', verifyToken, ctrl.deleteComuna);

module.exports = router;
