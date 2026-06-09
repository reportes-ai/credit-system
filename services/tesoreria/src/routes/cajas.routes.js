const router = require('express').Router();
const ctrl   = require('../controllers/cajas.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin   = [verifyToken, requirePerfil('Administrador', 'Gerente')];
const conLectura  = [verifyToken, requirePerfil('Administrador', 'Gerente', 'Tesorero')];

// Caja del usuario autenticado (cajero)
router.get('/mi-caja', verifyToken, ctrl.miCaja);

// Usuarios disponibles (para el select del modal)
router.get('/todos-usuarios', ...soloAdmin, ctrl.todosUsuarios);

// CRUD Cajas
router.get('/',       ...conLectura,  ctrl.list);
router.post('/',      ...soloAdmin,   ctrl.create);
router.put('/:id',    ...soloAdmin,   ctrl.update);
router.delete('/:id', ...soloAdmin,   ctrl.remove);

// Asignaciones de usuarios a caja
router.get('/:id/usuarios',           ...soloAdmin, ctrl.listUsuarios);
router.post('/:id/usuarios',          ...soloAdmin, ctrl.upsertUsuario);
router.delete('/:id/usuarios/:uid',   ...soloAdmin, ctrl.removeUsuario);

module.exports = router;
