const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');

const router = express.Router();

// Configure multer for file uploads
const attachmentsDir = path.join(__dirname, '..', 'public', 'attachments');
if (!fs.existsSync(attachmentsDir)) {
  fs.mkdirSync(attachmentsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, attachmentsDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename: noteId-timestamp-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext);
    const sanitizedBaseName = baseName.replace(/[^a-zA-Z0-9]/g, '_');
    cb(null, `note-${uniqueSuffix}-${sanitizedBaseName}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// Middleware to check if user is authenticated
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Create a new note
router.post('/', requireAuth, upload.array('attachments', 10), async (req, res) => {
  try {
    const { title, content, is_public } = req.body;
    const userId = req.session.userId;
    const files = req.files || [];
    const isPublic = is_public === 'true' || is_public === true;

    // Validate input
    if (!title || !content) {
      // Clean up uploaded files if validation fails
      files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
      return res.status(400).json({ error: 'Title and content are required' });
    }

    if (title.trim().length === 0) {
      files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
      return res.status(400).json({ error: 'Title cannot be empty' });
    }

    if (content.trim().length === 0) {
      files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
      return res.status(400).json({ error: 'Content cannot be empty' });
    }

    // Insert new note
    const result = await pool.query(
      'INSERT INTO notes (user_id, title, content, is_public) VALUES ($1, $2, $3, $4) RETURNING id, title, content, is_public, created_at, updated_at',
      [userId, title.trim(), content.trim(), isPublic]
    );

    const noteId = result.rows[0].id;
    const attachments = [];

    // Save file attachments
    for (const file of files) {
      const filePath = `/attachments/${file.filename}`;
      const attachmentResult = await pool.query(
        'INSERT INTO note_attachments (note_id, original_filename, stored_filename, file_path, file_size, mime_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, original_filename, stored_filename, file_path, file_size, mime_type, created_at',
        [noteId, file.originalname, file.filename, filePath, file.size, file.mimetype]
      );
      attachments.push(attachmentResult.rows[0]);
    }

    res.status(201).json({
      message: 'Note created successfully',
      note: result.rows[0],
      attachments: attachments
    });
  } catch (error) {
    console.error('Error creating note:', error);
    // Clean up uploaded files on error
    if (req.files) {
      req.files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all notes for the current user
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    const result = await pool.query(
      'SELECT id, title, content, is_public, created_at, updated_at FROM notes WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId]
    );

    res.json({
      notes: result.rows
    });
  } catch (error) {
    console.error('Error fetching notes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get public notes for a specific user
router.get('/user/:userId/public', requireAuth, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);

    if (isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const result = await pool.query(
      'SELECT id, title, content, is_public, created_at, updated_at FROM notes WHERE user_id = $1 AND is_public = true ORDER BY updated_at DESC',
      [targetUserId]
    );

    res.json({
      notes: result.rows
    });
  } catch (error) {
    console.error('Error fetching public notes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get a specific note by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const noteId = parseInt(req.params.id);
    const userId = req.session.userId;

    if (isNaN(noteId)) {
      return res.status(400).json({ error: 'Invalid note ID' });
    }

    // Get note - allow if user owns it OR if it's public
    const result = await pool.query(
      'SELECT id, title, content, is_public, user_id, created_at, updated_at FROM notes WHERE id = $1 AND (user_id = $2 OR is_public = true)',
      [noteId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    const note = result.rows[0];
    const isOwner = note.user_id === userId;

    // Get attachments for this note
    const attachmentsResult = await pool.query(
      'SELECT id, original_filename, stored_filename, file_path, file_size, mime_type, created_at FROM note_attachments WHERE note_id = $1 ORDER BY created_at ASC',
      [noteId]
    );

    res.json({
      note: {
        id: note.id,
        title: note.title,
        content: note.content,
        is_public: note.is_public,
        user_id: note.user_id,
        created_at: note.created_at,
        updated_at: note.updated_at
      },
      attachments: attachmentsResult.rows,
      is_owner: isOwner
    });
  } catch (error) {
    console.error('Error fetching note:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update a specific note by ID
router.put('/:id', requireAuth, upload.array('attachments', 10), async (req, res) => {
  try {
    const noteId = parseInt(req.params.id);
    const userId = req.session.userId;
    const { title, content } = req.body;
    const files = req.files || [];

    if (isNaN(noteId)) {
      // Clean up uploaded files if validation fails
      files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
      return res.status(400).json({ error: 'Invalid note ID' });
    }

    // Validate input
    if (!title || !content) {
      files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
      return res.status(400).json({ error: 'Title and content are required' });
    }

    if (title.trim().length === 0) {
      files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
      return res.status(400).json({ error: 'Title cannot be empty' });
    }

    if (content.trim().length === 0) {
      files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
      return res.status(400).json({ error: 'Content cannot be empty' });
    }

    // Check if note exists and belongs to user
    const checkResult = await pool.query(
      'SELECT id FROM notes WHERE id = $1 AND user_id = $2',
      [noteId, userId]
    );

    if (checkResult.rows.length === 0) {
      files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
      return res.status(404).json({ error: 'Note not found' });
    }

    // Get is_public from body
    const { is_public } = req.body;
    const isPublic = is_public === 'true' || is_public === true;

    // Update note
    const result = await pool.query(
      'UPDATE notes SET title = $1, content = $2, is_public = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 AND user_id = $5 RETURNING id, title, content, is_public, created_at, updated_at',
      [title.trim(), content.trim(), isPublic, noteId, userId]
    );

    // Save new file attachments
    const attachments = [];
    for (const file of files) {
      const filePath = `/attachments/${file.filename}`;
      const attachmentResult = await pool.query(
        'INSERT INTO note_attachments (note_id, original_filename, stored_filename, file_path, file_size, mime_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, original_filename, stored_filename, file_path, file_size, mime_type, created_at',
        [noteId, file.originalname, file.filename, filePath, file.size, file.mimetype]
      );
      attachments.push(attachmentResult.rows[0]);
    }

    res.json({
      message: 'Note updated successfully',
      note: result.rows[0],
      attachments: attachments
    });
  } catch (error) {
    console.error('Error updating note:', error);
    // Clean up uploaded files on error
    if (req.files) {
      req.files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a specific note by ID
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const noteId = parseInt(req.params.id);
    const userId = req.session.userId;

    if (isNaN(noteId)) {
      return res.status(400).json({ error: 'Invalid note ID' });
    }

    // Check if note exists and belongs to user
    const checkResult = await pool.query(
      'SELECT id FROM notes WHERE id = $1 AND user_id = $2',
      [noteId, userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    // Get all attachments for this note to delete files
    const attachmentsResult = await pool.query(
      'SELECT file_path FROM note_attachments WHERE note_id = $1',
      [noteId]
    );

    // Delete physical files
    attachmentsResult.rows.forEach(attachment => {
      const filePath = path.join(__dirname, '..', 'public', attachment.file_path);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    // Delete note (cascade will delete attachments from DB)
    await pool.query(
      'DELETE FROM notes WHERE id = $1 AND user_id = $2',
      [noteId, userId]
    );

    res.json({
      message: 'Note deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a specific attachment
router.delete('/:id/attachments/:attachmentId', requireAuth, async (req, res) => {
  try {
    const noteId = parseInt(req.params.id);
    const attachmentId = parseInt(req.params.attachmentId);
    const userId = req.session.userId;

    if (isNaN(noteId) || isNaN(attachmentId)) {
      return res.status(400).json({ error: 'Invalid note or attachment ID' });
    }

    // Verify note belongs to user
    const noteCheck = await pool.query(
      'SELECT id FROM notes WHERE id = $1 AND user_id = $2',
      [noteId, userId]
    );

    if (noteCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    // Get attachment info
    const attachmentResult = await pool.query(
      'SELECT file_path FROM note_attachments WHERE id = $1 AND note_id = $2',
      [attachmentId, noteId]
    );

    if (attachmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    // Delete physical file
    const filePath = path.join(__dirname, '..', 'public', attachmentResult.rows[0].file_path);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Delete attachment from database
    await pool.query(
      'DELETE FROM note_attachments WHERE id = $1 AND note_id = $2',
      [attachmentId, noteId]
    );

    res.json({
      message: 'Attachment deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting attachment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

