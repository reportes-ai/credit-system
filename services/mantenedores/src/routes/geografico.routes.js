const router = require('express').Router();
const ctrl = require('../controllers/geografico.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/regiones', verifyToken, ctrl.getRegiones);
router.post('/regiones', verifyToken, requireFunc('mantenedores_comunas'), ctrl.createRegion);
router.put('/regiones/:id', verifyToken, requireFunc('mantenedores_comunas'), ctrl.updateRegion);
router.delete('/regiones/:id', verifyToken, requireFunc('mantenedores_comunas'), ctrl.deleteRegion);

router.get('/provincias', verifyToken, ctrl.getProvincias);
router.post('/provincias', verifyToken, requireFunc('mantenedores_comunas'), ctrl.createProvincia);
router.put('/provincias/:id', verifyToken, requireFunc('mantenedores_comunas'), ctrl.updateProvincia);
router.delete('/provincias/:id', verifyToken, requireFunc('mantenedores_comunas'), ctrl.deleteProvincia);

router.get('/comunas', verifyToken, ctrl.getComunas);
router.post('/comunas', verifyToken, requireFunc('mantenedores_comunas'), ctrl.createComuna);
router.put('/comunas/:id', verifyToken, requireFunc('mantenedores_comunas'), ctrl.updateComuna);
router.delete('/comunas/:id', verifyToken, requireFunc('mantenedores_comunas'), ctrl.deleteComuna);

module.exports = router;
