const router = require('express').Router();
const multer = require('multer');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/cuentas-corrientes.controller');

const puede  = requireFunc('tesoreria_cuentas_corrientes');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/cuentas',                verifyToken, puede, ctrl.cuentas);
router.get('/cuentas/:id/movimientos', verifyToken, puede, ctrl.movimientos);
router.get('/cuentas/:id/resumen-tipos', verifyToken, puede, ctrl.resumenTipos);
router.post('/cuentas/:id/cartola',    verifyToken, puede, upload.single('archivo'), ctrl.cargarCartola);

module.exports = router;
