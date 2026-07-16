'use strict';
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/concurso.controller');

router.get('/preguntas', verifyToken, ctrl.getPreguntas);
router.post('/preguntas', verifyToken, ctrl.guardarPregunta);
router.delete('/preguntas/:id', verifyToken, ctrl.eliminarPregunta);

module.exports = router;
