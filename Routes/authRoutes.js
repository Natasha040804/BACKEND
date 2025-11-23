const express = require('express');
const router = express.Router();
const authController = require('../Controllers/authcontroller');
const { authenticate, authorize } = require('../middleware/authmiddleware');

// API Routes
router.post('/login', authController.login);
router.post('/refresh-token', authController.refreshToken);
router.post('/logout', authenticate, authController.logout);

// Return current authenticated user
router.get('/me', authenticate, authController.me);
// Alias profile route for mobile client
router.get('/profile', authenticate, authController.me);

// Lightweight auth check endpoint used by frontend to validate existing session.
// Returns same payload as /me if authenticated; 401 otherwise.
router.get('/check', authenticate, authController.me);

module.exports = router;