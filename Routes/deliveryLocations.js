const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection');

// Ensure table exists (this is best-effort; existing tables won't be altered)
async function ensureTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tbl_delivery_locations (
      assignment_id INT NOT NULL,
      latitude DECIMAL(10,7) NOT NULL,
      longitude DECIMAL(10,7) NOT NULL,
      accuracy FLOAT NULL,
      recorded_at DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

// POST /api/delivery-locations
router.post('/', async (req, res) => {
  try {
    const { assignment_id, latitude, longitude, accuracy, recorded_at } = req.body || {};
    if (
      typeof assignment_id === 'undefined' || typeof latitude === 'undefined' || typeof longitude === 'undefined'
    ) {
      return res.status(400).json({ error: 'assignment_id, latitude and longitude are required' });
    }

    await ensureTable();

    const reportedAt = recorded_at ? new Date(recorded_at) : new Date();
    let insertOk = false;
    try {
      // Try inserting into recorded_at column (most likely in existing schema)
      await db.execute(
        `INSERT INTO tbl_delivery_locations 
          (assignment_id, latitude, longitude, accuracy, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
        [Number(assignment_id), Number(latitude), Number(longitude),
         accuracy != null ? Number(accuracy) : null,
         reportedAt]
      );
      insertOk = true;
    } catch (err) {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        // Fallback: try reported_at if recorded_at doesn't exist in schema
        await db.execute(
          `INSERT INTO tbl_delivery_locations 
            (assignment_id, latitude, longitude, accuracy, reported_at)
           VALUES (?, ?, ?, ?, ?)`,
          [Number(assignment_id), Number(latitude), Number(longitude),
           accuracy != null ? Number(accuracy) : null,
           reportedAt]
        );
        insertOk = true;
      } else {
        throw err;
      }
    }

    res.json({ success: true, message: 'Location recorded' });
  } catch (error) {
    console.error('Error saving location:', error);
    res.status(500).json({ error: 'Failed to save location' });
  }
});

// GET /api/delivery-locations/latest/:assignmentId
router.get('/latest/:assignmentId', async (req, res) => {
  try {
    const { assignmentId } = req.params;
    await ensureTable();

    let row = null;
    // Try common timestamp columns in order without breaking when some are missing
    const tryQueries = [
      'SELECT * FROM tbl_delivery_locations WHERE assignment_id = ? ORDER BY recorded_at DESC LIMIT 1',
      'SELECT * FROM tbl_delivery_locations WHERE assignment_id = ? ORDER BY reported_at DESC LIMIT 1',
      'SELECT * FROM tbl_delivery_locations WHERE assignment_id = ? ORDER BY created_at DESC LIMIT 1',
      'SELECT * FROM tbl_delivery_locations WHERE assignment_id = ? LIMIT 1',
    ];
    for (const q of tryQueries) {
      try {
        const [resRows] = await db.execute(q, [assignmentId]);
        if (Array.isArray(resRows) && resRows.length) { row = resRows[0]; break; }
      } catch (err) {
        if (err && err.code === 'ER_BAD_FIELD_ERROR') {
          // Try next variant
          continue;
        } else {
          throw err;
        }
      }
    }

    if (!row) return res.status(404).json({ error: 'No location data found' });

    // Normalize response shape
    const payload = {
      assignment_id: row.assignment_id,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      accuracy: row.accuracy != null ? Number(row.accuracy) : null,
      recorded_at: row.recorded_at || row.reported_at || row.created_at || null,
    };
    res.json(payload);
  } catch (error) {
    console.error('Error fetching location:', error);
    res.status(500).json({ error: 'Failed to fetch location' });
  }
});

module.exports = router;
