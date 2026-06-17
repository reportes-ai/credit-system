const router = require('express').Router();
const ctrl   = require('../controllers/cajas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Acceso por matriz (Perfiles y Permisos), no por nombre de perfil. Admin pasa por bypass.
const gestionar = [verifyToken, requireFunc('tesoreria_cajas')];                       // crear/editar/borrar cajas y asignaciones
const lectura   = [verifyToken, requireFunc('tesoreria_cajas', 'teso-caja-operativa')]; // ver cajas (incluye Tesorero con acceso a Caja)

// Caja del usuario autenticado (cajero)
router.get('/mi-caja', verifyToken, ctrl.miCaja);

// Usuarios disponibles (para el select del modal)
router.get('/todos-usuarios', ...gestionar, ctrl.todosUsuarios);

// CRUD Cajas
router.get('/',       ...lectura,  ctrl.list);
router.post('/',      ...gestionar, ctrl.create);
router.put('/:id',    ...gestionar, ctrl.update);
router.delete('/:id', ...gestionar, ctrl.remove);

// Asignaciones de usuarios a caja
router.get('/:id/usuarios',           ...gestionar, ctrl.listUsuarios);
router.post('/:id/usuarios',          ...gestionar, ctrl.upsertUsuario);
router.delete('/:id/usuarios/:uid',   ...gestionar, ctrl.removeUsuario);

module.exports = router;
