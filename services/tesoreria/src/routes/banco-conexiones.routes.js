const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/banco-conexiones.controller');

const puede = requireFunc('banco_conexiones');

// Lectura
router.get('/config',                    verifyToken, ctrl.getConfig);
router.get('/conexiones',                verifyToken, ctrl.listar);
router.get('/conexiones/:id/movimientos', verifyToken, ctrl.movimientos);

// Escritura (requiere permiso del mantenedor)
router.put('/config',                    verifyToken, puede, ctrl.setConfig);
router.post('/conexiones',               verifyToken, puede, ctrl.crear);
router.delete('/conexiones/:id',         verifyToken, puede, ctrl.eliminar);
router.post('/conexiones/:id/sync',      verifyToken, puede, ctrl.sincronizar);
router.post('/sync-todo',                verifyToken, puede, ctrl.sincronizarTodo);

module.exports = router;
