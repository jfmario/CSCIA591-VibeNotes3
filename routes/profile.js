const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename: userId-timestamp-originalname
    const userId = req.session.userId;
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `avatar-${userId}-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    // Accept only image files
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Middleware to check if user is authenticated
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Get current user's profile
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, description, avatar_path, created_at FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        username: user.username,
        description: user.description || '',
        avatar_path: user.avatar_path || null,
        created_at: user.created_at
      }
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update profile (description and/or avatar)
router.put('/me', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    const { description } = req.body;
    const userId = req.session.userId;

    // Get current avatar path
    const currentUser = await pool.query(
      'SELECT avatar_path FROM users WHERE id = $1',
      [userId]
    );

    let avatarPath = currentUser.rows[0]?.avatar_path;

    // If new avatar uploaded, delete old one and update path
    if (req.file) {
      // Delete old avatar if it exists (with path traversal protection)
      if (avatarPath) {
        const sanitizedPath = path.normalize(avatarPath).replace(/^(\.\.(\/|\\|$))+/, '');
        const oldAvatarPath = path.join(__dirname, '..', 'public', sanitizedPath);
        
        // Ensure the file path is within the public directory
        const publicDir = path.join(__dirname, '..', 'public');
        const resolvedPath = path.resolve(oldAvatarPath);
        const resolvedPublicDir = path.resolve(publicDir);
        
        if (resolvedPath.startsWith(resolvedPublicDir) && fs.existsSync(oldAvatarPath)) {
          fs.unlinkSync(oldAvatarPath);
        }
      }
      // Set new avatar path (relative to public directory)
      avatarPath = `/uploads/${req.file.filename}`;
    }

    // Validate and sanitize description
    if (description !== undefined && description !== null) {
      if (typeof description !== 'string') {
        return res.status(400).json({ error: 'Description must be a string' });
      }
      // Limit description length (e.g., 1000 characters)
      if (description.length > 1000) {
        return res.status(400).json({ error: 'Description must be 1000 characters or less' });
      }
    }

    // Update user profile
    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;

    // Only allow specific fields to be updated (whitelist approach)
    if (description !== undefined && description !== null) {
      updateFields.push(`description = $${paramCount}`);
      updateValues.push(description.trim());
      paramCount++;
    }

    if (avatarPath !== undefined && avatarPath !== null) {
      updateFields.push(`avatar_path = $${paramCount}`);
      updateValues.push(avatarPath);
      paramCount++;
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updateValues.push(userId);
    // Use parameterized query with safe field names (whitelisted)
    const query = `
      UPDATE users 
      SET ${updateFields.join(', ')} 
      WHERE id = $${paramCount}
      RETURNING id, username, description, avatar_path, created_at
    `;

    const result = await pool.query(query, updateValues);

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: result.rows[0].id,
        username: result.rows[0].username,
        description: result.rows[0].description || '',
        avatar_path: result.rows[0].avatar_path || null,
        created_at: result.rows[0].created_at
      }
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all users
router.get('/users', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, description, avatar_path, created_at FROM users ORDER BY username ASC'
    );

    res.json({
      users: result.rows.map(user => ({
        id: user.id,
        username: user.username,
        description: user.description || '',
        avatar_path: user.avatar_path || null,
        created_at: user.created_at
      }))
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get a specific user's profile (for viewing other users)
router.get('/user/:userId', requireAuth, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);

    if (isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const result = await pool.query(
      'SELECT id, username, description, avatar_path, created_at FROM users WHERE id = $1',
      [targetUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: result.rows[0].id,
        username: result.rows[0].username,
        description: result.rows[0].description || '',
        avatar_path: result.rows[0].avatar_path || null,
        created_at: result.rows[0].created_at
      }
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

