// Routes/accessRequestRoutes.js
const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection'); // This imports as 'db', not 'pool'

// Get pending requests - FIXED: using db instead of pool
router.get('/access-requests/pending', async (req, res) => {
  console.log('=== DEBUG: GET /access-requests/pending called ===');
  try {
    console.log('Attempting to execute SQL query...');
    
    const [requests] = await db.execute(`
      SELECT 
        ar.id,
        ar.account_executive_id,
        ar.branch_id,
        ar.status,
        ar.requested_at,
        a.Fullname as account_executive_name,
        a.Email as account_executive_email,
        b.BranchName,
        b.BranchCode
      FROM access_requests ar
      JOIN tbl_accounts a ON ar.account_executive_id = a.Account_id
      JOIN tbl_branches b ON ar.branch_id = b.BranchID
      WHERE ar.status = 'pending'
      ORDER BY ar.requested_at DESC
    `);

    console.log('SQL query successful, found requests:', requests.length);
    res.json(requests);
  } catch (error) {
    console.error('❌ ERROR in /access-requests/pending:', error.message);
    console.error('Full error:', error);
    res.status(500).json({ 
      error: 'Failed to load pending requests',
      details: error.message 
    });
  }
});

// Get active sessions - FIXED: using db instead of pool
router.get('/access-requests/active-sessions', async (req, res) => {
  console.log('=== DEBUG: GET /access-requests/active-sessions called ===');
  try {
    console.log('Attempting to execute active sessions query...');
    
    const [sessions] = await db.execute(`
      SELECT 
        ar.id,
        ar.account_executive_id,
        ar.branch_id,
        ar.status,
        ar.requested_at,
        ar.approved_until,
        a.Fullname as account_executive_name,
        a.Email as account_executive_email,
        b.BranchName,
        b.BranchCode
      FROM access_requests ar
      JOIN tbl_accounts a ON ar.account_executive_id = a.Account_id
      JOIN tbl_branches b ON ar.branch_id = b.BranchID
      WHERE ar.status = 'approved' 
        AND ar.approved_until > NOW()
      ORDER BY ar.approved_until DESC
    `);

    console.log('Active sessions query successful, found:', sessions.length);
    res.json(sessions);
  } catch (error) {
    console.error('❌ ERROR in /access-requests/active-sessions:', error.message);
    console.error('Full error:', error);
    res.status(500).json({ 
      error: 'Failed to load active sessions',
      details: error.message 
    });
  }
});

// Create access request (AE submits) - FIXED: using db instead of pool
router.post('/access-requests/request', async (req, res) => {
  console.log('=== DEBUG: POST /access-requests/request called ===');
  try {
    const { branch_id } = req.body;
    const account_executive_id = req.userId || 1; // TODO: Replace with actual auth

    console.log('Request data:', { branch_id, account_executive_id });

    if (!branch_id) {
      return res.status(400).json({ error: 'Branch ID is required' });
    }

    // Check for existing pending request
    const [existing] = await db.execute(
      'SELECT id FROM access_requests WHERE account_executive_id = ? AND status = "pending"',
      [account_executive_id]
    );

    if (existing.length > 0) {
      // Update existing request
      await db.execute(
        'UPDATE access_requests SET branch_id = ?, requested_at = NOW() WHERE account_executive_id = ? AND status = "pending"',
        [branch_id, account_executive_id]
      );
      console.log('Updated existing pending request');
    } else {
      // Create new request
      await db.execute(
        'INSERT INTO access_requests (account_executive_id, branch_id) VALUES (?, ?)',
        [account_executive_id, branch_id]
      );
      console.log('Created new access request');
    }

    res.json({ message: 'Request submitted successfully' });
  } catch (error) {
    console.error('❌ Request submission error:', error.message);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// Approve request (Admin) - FIXED: using db instead of pool
router.post('/access-requests/:id/approve', async (req, res) => {
  console.log('=== DEBUG: POST /access-requests/approve called ===');
  try {
    const requestId = req.params.id;
    const { duration_hours = 12 } = req.body;
    const approved_by = req.userId || 1; // TODO: Replace with actual auth

    console.log('Approve request:', { requestId, duration_hours, approved_by });

    if (!requestId) {
      return res.status(400).json({ error: 'Request ID is required' });
    }

    // Calculate approved_until timestamp
    const approved_until = new Date();
    approved_until.setHours(approved_until.getHours() + parseInt(duration_hours));

    const [result] = await db.execute(`
      UPDATE access_requests 
      SET 
        status = 'approved',
        approved_by = ?,
        approved_at = NOW(),
        approved_until = ?
      WHERE id = ? AND status = 'pending'
    `, [approved_by, approved_until, requestId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Request not found or already processed' });
    }

    console.log('Request approved successfully');
    res.json({ message: 'Request approved successfully' });
  } catch (error) {
    console.error('❌ Approve request error:', error.message);
    res.status(500).json({ error: 'Failed to approve request' });
  }
});

// Deny request (Admin) - FIXED: using db instead of pool
router.post('/access-requests/:id/deny', async (req, res) => {
  console.log('=== DEBUG: POST /access-requests/deny called ===');
  try {
    const requestId = req.params.id;
    const { reason = 'Not specified' } = req.body;
    const denied_by = req.userId || 1; // TODO: Replace with actual auth

    console.log('Deny request:', { requestId, reason, denied_by });

    if (!requestId) {
      return res.status(400).json({ error: 'Request ID is required' });
    }

    const [result] = await db.execute(`
      UPDATE access_requests 
      SET 
        status = 'denied',
        denied_by = ?,
        denied_at = NOW(),
        denial_reason = ?
      WHERE id = ? AND status = 'pending'
    `, [denied_by, reason, requestId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Request not found or already processed' });
    }

    console.log('Request denied successfully');
    res.json({ message: 'Request denied successfully' });
  } catch (error) {
    console.error('❌ Deny request error:', error.message);
    res.status(500).json({ error: 'Failed to deny request' });
  }
});

// End session early - FIXED: using db instead of pool
router.post('/access-requests/:id/end-session', async (req, res) => {
  console.log('=== DEBUG: POST /access-requests/end-session called ===');
  try {
    const requestId = req.params.id;
    console.log('Ending session for request:', requestId);

    const [result] = await db.execute(`
      UPDATE access_requests 
      SET 
        approved_until = NOW(),
        status = 'expired'
      WHERE id = ? AND status = 'approved' AND approved_until > NOW()
    `, [requestId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Active session not found' });
    }

    console.log('Session ended successfully');
    res.json({ message: 'Session ended successfully' });
  } catch (error) {
    console.error('❌ End session error:', error.message);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// Create table if needed (optional - for initial setup) - FIXED: using db instead of pool
router.post('/access-requests/create-table', async (req, res) => {
  console.log('=== DEBUG: Creating access_requests table ===');
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS access_requests (
        id INT PRIMARY KEY AUTO_INCREMENT,
        account_executive_id INT NOT NULL,
        branch_id INT NOT NULL,
        status ENUM('pending', 'approved', 'denied', 'expired') DEFAULT 'pending',
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_by INT NULL,
        approved_at TIMESTAMP NULL,
        approved_until TIMESTAMP NULL,
        denied_by INT NULL,
        denied_at TIMESTAMP NULL,
        denial_reason TEXT NULL,
        FOREIGN KEY (account_executive_id) REFERENCES tbl_accounts(Account_id),
        FOREIGN KEY (branch_id) REFERENCES tbl_branches(BranchID),
        FOREIGN KEY (approved_by) REFERENCES tbl_accounts(Account_id),
        FOREIGN KEY (denied_by) REFERENCES tbl_accounts(Account_id)
      )
    `);
    console.log('✅ access_requests table created/verified');
    res.json({ message: 'Table created successfully' });
  } catch (error) {
    console.error('❌ ERROR creating table:', error.message);
    res.status(500).json({ 
      error: 'Failed to create table',
      details: error.message 
    });
  }
});
// Get current user's access request status
router.get('/access-requests/my-status', async (req, res) => {
  console.log('=== DEBUG: GET /access-requests/my-status called ===');
  try {
    const account_executive_id = req.userId || 1; // TODO: Replace with actual auth

    console.log('Getting status for user:', account_executive_id);

    const [requests] = await db.execute(`
      SELECT 
        ar.id,
        ar.account_executive_id,
        ar.branch_id,
        ar.status,
        ar.requested_at,
        ar.approved_until,
        a.Fullname as account_executive_name,
        b.BranchName,
        b.BranchCode
      FROM access_requests ar
      JOIN tbl_accounts a ON ar.account_executive_id = a.Account_id
      JOIN tbl_branches b ON ar.branch_id = b.BranchID
      WHERE ar.account_executive_id = ?
      ORDER BY ar.requested_at DESC
      LIMIT 1
    `, [account_executive_id]);

    if (requests.length === 0) {
      return res.json({ 
        status: 'none',
        message: 'No access requests found'
      });
    }

    const request = requests[0];
    res.json({
      status: request.status,
      branchId: request.branch_id,
      branchName: request.BranchName,
      requestedAt: request.requested_at,
      approvedUntil: request.approved_until,
      accountExecutiveName: request.account_executive_name
    });
  } catch (error) {
    console.error('❌ Error fetching user status:', error);
    res.status(500).json({ 
      error: 'Failed to load user status',
      details: error.message 
    });
  }
});
module.exports = router;