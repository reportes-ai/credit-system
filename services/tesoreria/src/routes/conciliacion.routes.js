const router = require('express').Router();
const multer = require('multer');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/conciliacion.controller');

const puede = requireFunc('conciliacion_bancaria');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Lectura
router.get('/cuentas',                 verifyToken, ctrl.cuentas);
router.get('/cuentas/:id/pendientes',  verifyToken, ctrl.pendientes);
router.get('/cuentas/:id/conciliados', verifyToken, ctrl.conciliados);
router.get('/cuentas/:id/resumen',     verifyToken, ctrl.resumen);

// Escritura (requiere permiso)
router.post('/cuentas-manuales',              verifyToken, puede, ctrl.crearCuentaManual);
router.post('/cuentas/:id/cartola/preview',   verifyToken, puede, upload.single('archivo'), ctrl.previewCartola);
router.post('/cuentas/:id/cartola/importar',  verifyToken, puede, upload.single('archivo'), ctrl.importarCartola);
router.post('/conciliar',                     verifyToken, puede, ctrl.conciliar);
router.post('/desconciliar',                  verifyToken, puede, ctrl.desconciliar);

module.exports = router;
