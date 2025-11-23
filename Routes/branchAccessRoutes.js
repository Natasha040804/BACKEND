const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection'); 
const { authenticate } = require('../middleware/authmiddleware');

// Apply JWT-based auth only to routes under /branch-access to avoid intercepting unrelated /api paths
router.use('/branch-access', authenticate);


router.post('/branch-access/request', async (req, res) => {
  try {
    const { branchId } = req.body;
    const account_executive_id = req.user?.userId;

    if (!account_executive_id) {
      console.warn('BranchAccess request: req.user missing. hdr:', !!(req.headers['authorization']||req.headers['Authorization']), 'accCookie:', !!(req.cookies && req.cookies.accessToken), 'refCookie:', !!(req.cookies && req.cookies.refreshToken));
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!branchId) {
      return res.status(400).json({ error: 'Branch ID is required' });
    }

    console.log('Creating access request:', { account_executive_id, branchId });

    // Check for existing pending request
    const [existing] = await db.execute(
      'SELECT id FROM access_requests WHERE account_executive_id = ? AND status = "pending"',
      [account_executive_id]
    );

    if (existing.length > 0) {
      // Update existing request
      await db.execute(
        'UPDATE access_requests SET branch_id = ?, requested_at = NOW() WHERE account_executive_id = ? AND status = "pending"',
        [branchId, account_executive_id]
      );
      console.log('Updated existing pending request');
    } else {
      // Create new request
      await db.execute(
        'INSERT INTO access_requests (account_executive_id, branch_id) VALUES (?, ?)',
        [account_executive_id, branchId]
      );
      console.log('Created new access request');
    }

    res.json({ message: 'Request submitted successfully' });
  } catch (error) {
    console.error('Request submission error:', error);
    res.status(500).json({ error: 'Failed to submit request', details: error && (error.sqlMessage || error.message) });
  }
});

// Get pending requests - UPDATED for new table structure
router.get('/branch-access/pending', async (req, res) => {
  try {
    console.log('Fetching pending requests...');
    
  const [requests] = await db.execute(`
      SELECT 
        ar.id,
        ar.account_executive_id,
        ar.branch_id,
        ar.status,
        ar.requested_at,
        a.Username as username,
        a.Fullname as fullname,
        a.Email as account_executive_email,
        b.BranchName,
        b.BranchCode
  FROM access_requests ar
  JOIN tbl_accounts a ON ar.account_executive_id = a.Account_Id
  JOIN tbl_branches b ON ar.branch_id = b.BranchID
      WHERE ar.status = 'pending'
      ORDER BY ar.requested_at DESC
    `);

    console.log(`Found ${requests.length} pending requests`);
    res.json(requests);
  } catch (error) {
    console.error('Error fetching pending requests:', error);
    res.status(500).json({ error: 'Failed to load pending requests', details: error && (error.sqlMessage || error.message) });
  }
});

// Get active sessions - UPDATED for new table structure
router.get('/branch-access/active-sessions', async (req, res) => {
  try {
    console.log('Fetching active sessions...');
    
    const [sessions] = await db.execute(`
      SELECT 
        ar.id,
        ar.account_executive_id,
        ar.branch_id,
        ar.status,
        ar.requested_at,
        ar.approved_until as active_until,
        a.Username as username,
        a.Fullname as fullname,
        a.Email as account_executive_email,
        b.BranchName,
        b.BranchCode
  FROM access_requests ar
  JOIN tbl_accounts a ON ar.account_executive_id = a.Account_Id
  JOIN tbl_branches b ON ar.branch_id = b.BranchID
      WHERE ar.status = 'approved' 
        AND ar.approved_until > NOW()
      ORDER BY ar.approved_until DESC
    `);

    console.log(`Found ${sessions.length} active sessions`);
    res.json(sessions);
  } catch (error) {
    console.error('Error fetching active sessions:', error);
    res.status(500).json({ error: 'Failed to load active sessions', details: error && (error.sqlMessage || error.message) });
  }
});

// Approve request - UPDATED for new table structure
router.post('/branch-access/approve/:id', async (req, res) => {
  try {
    const requestId = req.params.id;
    let { durationHours = 12 } = req.body;
    durationHours = parseInt(durationHours, 10);
    if (!Number.isFinite(durationHours) || durationHours <= 0) durationHours = 12;
  const approved_by = req.user?.userId;

    // Validate approver identity and role early to avoid SQL errors and return clearer messages
    if (!req.user || !approved_by) {
      return res.status(401).json({ error: 'Not authenticated as approver' });
    }
    const approverRole = (req.user.role || '').toString().toLowerCase();
    if (!['admin', 'auditor'].includes(approverRole)) {
      // Only Admin or Auditor can approve; adjust list if business rules differ
      return res.status(403).json({ error: 'Forbidden: insufficient role to approve requests' });
    }

    if (!requestId) {
      return res.status(400).json({ error: 'Request ID is required' });
    }

    console.log(`Approving request ${requestId} for ${durationHours} hours`);

    // Get the request first to ensure it exists
    const [requests] = await db.execute(
      'SELECT account_executive_id FROM access_requests WHERE id = ? AND status = "pending"',
      [requestId]
    );

    if (requests.length === 0) {
      return res.status(404).json({ error: 'Request not found or already processed' });
    }

    const account_executive_id = requests[0].account_executive_id;

    // Calculate approved_until timestamp
  const approved_until = new Date();
  approved_until.setHours(approved_until.getHours() + durationHours);

    // Update the request
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

    console.log(`Request ${requestId} approved successfully`);
    res.json({ message: 'Request approved successfully' });
  } catch (error) {
    console.error('Approve request error:', error);
    res.status(500).json({ error: 'Failed to approve request', details: error && (error.sqlMessage || error.message) });
  }
});

// Deny request - UPDATED for new table structure
router.post('/branch-access/deny/:id', async (req, res) => {
  try {
    const requestId = req.params.id;
    const { reason = 'Not specified' } = req.body;
  const denied_by = req.user?.userId;

    if (!requestId) {
      return res.status(400).json({ error: 'Request ID is required' });
    }

    console.log(`Denying request ${requestId}, reason: ${reason}`);

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

    console.log(`Request ${requestId} denied successfully`);
    res.json({ message: 'Request denied successfully' });
  } catch (error) {
    console.error('Deny request error:', error);
    res.status(500).json({ error: 'Failed to deny request', details: error && (error.sqlMessage || error.message) });
  }
});

// End session - UPDATED for new table structure
router.post('/branch-access/end-session/:id', async (req, res) => {
  try {
    const requestId = req.params.id;

    console.log(`Ending session for request ${requestId}`);

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

    console.log(`Session ended for request ${requestId}`);
    res.json({ message: 'Session ended successfully' });
  } catch (error) {
    console.error('End session error:', error);
    res.status(500).json({ error: 'Failed to end session', details: error && (error.sqlMessage || error.message) });
  }
});

// Get user's access request status - NEW ENDPOINT
router.get('/branch-access/my-status', async (req, res) => {
  try {
    const account_executive_id = req.user?.userId;
    if (!account_executive_id) {
      console.warn('BranchAccess my-status: req.user missing. hdr:', !!(req.headers['authorization']||req.headers['Authorization']), 'accCookie:', !!(req.cookies && req.cookies.accessToken), 'refCookie:', !!(req.cookies && req.cookies.refreshToken));
      return res.status(401).json({ error: 'Not authenticated' });
    }

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
  JOIN tbl_accounts a ON ar.account_executive_id = a.Account_Id
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
    // Mark expired if approved_until is past
    const now = new Date();
    let effectiveStatus = request.status;
    if (request.approved_until && new Date(request.approved_until) <= now && request.status === 'approved') {
      effectiveStatus = 'expired';
    }
    res.json({
      status: effectiveStatus,
      branchId: request.branch_id,
      branchName: request.BranchName,
      requestedAt: request.requested_at,
      approvedUntil: request.approved_until,
      accountExecutiveName: request.account_executive_name
    });
  } catch (error) {
    console.error('Error fetching user status:', error);
    res.status(500).json({ 
      error: 'Failed to load user status',
      details: (error && (error.sqlMessage || error.message)) || 'Unknown error'
    });
  }
});

module.exports = router;