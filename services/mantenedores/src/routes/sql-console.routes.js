'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/sql-console.controller');

// Nivel Dios: solo Admin (mantenedores_solo_dios). Solo lectura — el guard del controller no escribe.
router.post('/', verifyToken, requireFunc('mantenedores_solo_dios'), ctrl.ejecutar);

module.exports = router;
