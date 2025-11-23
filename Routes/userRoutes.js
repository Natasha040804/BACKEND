const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection');
const { authenticate, authorize } = require('../middleware/authmiddleware');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (_) {}

// Multer storage for user photos (optional)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `user_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

router.get('/users', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        a.Account_id,
        a.Fullname,
        a.Username,
        a.EmployeeID,
        a.Email,
        a.Contact,
        a.Address,
        a.Photo,
        a.Role,
        b.BranchName AS Branch
      FROM tbl_accounts a
      LEFT JOIN tbl_branches b ON b.BranchID = a.BranchID
      ORDER BY a.Account_id DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create user (Admin only). Accepts JSON or multipart/form-data (with 'image' file)
router.post(
  '/users',
  authenticate,
  authorize(['admin']),
  function conditionalUpload(req, res, next) {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) {
      return upload.single('image')(req, res, function (err) {
        if (err) {
          console.error('Upload error:', err);
          return res.status(400).json({ error: 'Image upload failed' });
        }
        next();
      });
    }
    next();
  },
  async (req, res) => {
    try {
      const body = req.body || {};
      const username = (body.username || '').trim();
      const password = (body.password || '').trim();
      const role = (body.role || '').trim();
      const fullName = (body.fullName || '').trim();
      const email = (body.email || '').trim();
      const contact = (body.contact || '').trim();
      const employeeId = (body.employeeId || '').trim();
      const address = (body.address || '').trim();
      const photo = req.file ? req.file.filename : null;

      if (!username || !password || !role) {
        return res.status(400).json({ error: 'username, password and role are required' });
      }

      // Ensure unique username
      const [existing] = await db.query('SELECT 1 FROM tbl_Accounts WHERE Username = ? LIMIT 1', [username]);
      if (existing && existing.length) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      // Hash password
      const hashed = await bcrypt.hash(password, 10);

      // Insert user
      const [result] = await db.query(
        'INSERT INTO tbl_Accounts (Fullname, Username, Password, EmployeeID, Email, Contact, Address, Photo, Role, BranchID) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [fullName, username, hashed, employeeId || null, email || null, contact || null, address || null, photo, role, null]
      );

      // Return created user minimal info
      res.status(201).json({
        Account_id: result.insertId,
        Fullname: fullName,
        Username: username,
        Email: email,
        Contact: contact,
        Address: address,
        Photo: photo,
        Role: role
      });
    } catch (e) {
      console.error('Create user error:', e);
      res.status(500).json({ error: 'Failed to create user' });
    }
  }
);

module.exports = router;
// GET /api/users/role/:role - Get users by role
router.get('/users/role/:role', async (req, res) => {
  try {
    const { role } = req.params;
    const [rows] = await db.query(
      `
      SELECT 
        a.Account_id,
        a.Fullname,
        a.Username,
        a.EmployeeID,
        a.Email,
        a.Contact,
        a.Address,
        a.Photo,
        a.Role,
        a.BranchID,
        a.logistics_status,
        a.auditor_logistics_status,
        a.AccountExecutive_logistics_status,
        b.BranchName AS Branch
      FROM tbl_accounts a
      LEFT JOIN tbl_branches b ON b.BranchID = a.BranchID
      WHERE a.Role = ?
      ORDER BY a.Fullname ASC
      `,
      [role]
    );
    res.json({ success: true, data: rows, count: rows.length });
  } catch (e) {
    console.error('Error fetching users by role:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch users', message: e.message });
  }
});

// Update a user's logistics status field based on caller's intent
router.put('/users/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body || {};

    // Accept only one of these fields per request
    const validFields = ['logistics_status', 'auditor_logistics_status', 'AccountExecutive_logistics_status'];
    const keys = Object.keys(updateData).filter(k => validFields.includes(k));
    if (keys.length !== 1) {
      return res.status(400).json({ success: false, message: 'Invalid status field. Provide exactly one valid status field.' });
    }
    const field = keys[0];
    const value = String(updateData[field] || '').toUpperCase();
    if (!value) {
      return res.status(400).json({ success: false, message: 'Status value is required' });
    }

    // Enforce enum values (most role-specific logistics statuses are ENUM('STANDBY','ASSIGNED'))
    const allowed = ['STANDBY', 'ASSIGNED'];
    if (!allowed.includes(value)) {
      return res.status(400).json({ success: false, message: `Invalid status value '${value}'. Allowed: ${allowed.join(', ')}` });
    }

    // Whitelist column name and interpolate safely
    const columnMap = {
      logistics_status: 'logistics_status',
      auditor_logistics_status: 'auditor_logistics_status',
      AccountExecutive_logistics_status: 'AccountExecutive_logistics_status',
    };
    const column = columnMap[field];
    if (!column) {
      return res.status(400).json({ success: false, message: 'Unsupported status field' });
    }

    const sql = `UPDATE tbl_accounts SET ${column} = ? WHERE Account_id = ?`;
    const [result] = await db.query(sql, [value, id]);
    if ((result.affectedRows || 0) === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, message: 'Status updated successfully', field, value });
  } catch (error) {
    console.error('Error updating user status:', error);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// Get all active branches for dropdowns (scoped under /users for frontend compatibility)
router.get('/users/branches', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        BranchID, 
        BranchCode,
        BranchName, 
        Address,
        City, 
        Region, 
        ContactNumber
      FROM tbl_branches 
      WHERE Active = 1
      ORDER BY BranchName ASC
    `);
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('Error fetching branches:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch branches' });
  }
});

// Get logistics personnel with their current active assignments count
router.get('/users/logistics-personnel', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        a.Account_id,
        a.Fullname,
        a.Username,
        a.EmployeeID,
        a.Email,
        a.Contact,
        a.Address,
        a.Photo,
        a.Role,
        a.logistics_status,
        b.BranchName,
        b.City,
        b.Region,
        COUNT(da.assignment_id) as active_assignments
      FROM tbl_accounts a
      LEFT JOIN tbl_branches b ON b.BranchID = a.BranchID
      LEFT JOIN tbl_delivery_assignments da ON (
        da.assigned_to = a.Account_id 
        AND da.status IN ('ASSIGNED', 'IN_PROGRESS')
      )
      WHERE a.Role = 'Logistics'
      GROUP BY a.Account_id
      ORDER BY a.Fullname ASC
    `);
    res.json({ success: true, data: rows, count: rows.length });
  } catch (e) {
    console.error('Error fetching logistics personnel:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch logistics personnel' });
  }
});

// Create new delivery assignment
router.post('/users/delivery-assignments', authenticate, async (req, res) => {
  try {
    const {
      assigned_to,
      assignment_type,
      from_location_type,
      from_branch_id,
      to_location_type,
      to_branch_id,
      items,
      amount,
      notes,
      due_date
    } = req.body || {};

    const assigned_by = req.user?.userId; // from auth middleware token payload
    const requesterRole = (req.user?.role || '').toLowerCase();

    if (!assigned_by) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Basic validation
    if (!assigned_to || !assignment_type || !from_location_type || !to_location_type) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Validate branch access based on user role
    if (requesterRole === 'auditor') {
      if (!['CAPITAL_DELIVERY', 'BALANCE_DELIVERY'].includes(assignment_type)) {
        return res.status(403).json({ success: false, error: 'Auditors can only create capital or balance deliveries' });
      }
    }

    // Insert assignment
    const [result] = await db.query(
      `INSERT INTO tbl_delivery_assignments 
      (assigned_to, assigned_by, assignment_type, from_location_type, from_branch_id, 
       to_location_type, to_branch_id, items, amount, notes, due_date, status) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ASSIGNED')`,
      [
        assigned_to,
        assigned_by,
        assignment_type,
        from_location_type,
        from_branch_id || null,
        to_location_type,
        to_branch_id || null,
        JSON.stringify(items || []),
        amount || null,
        notes || null,
        due_date || null,
      ]
    );

      // Capital / Balance transfer logic: deduct source capital immediately for both CAPITAL_DELIVERY and BALANCE_DELIVERY
      if (['CAPITAL_DELIVERY', 'BALANCE_DELIVERY'].includes(assignment_type) && from_branch_id && amount && Number(amount) > 0) {
        try {
          const amt = Number(amount);
          // Fetch latest Current_Capital for source branch
          const [capRows] = await db.query(
            `SELECT Current_Capital
             FROM tbl_capital
             WHERE BranchID = ?
             ORDER BY CreatedDate DESC, CapitalID DESC
             LIMIT 1`,
            [from_branch_id]
          );
          const currentCap = capRows.length ? Number(capRows[0].Current_Capital) : 0;
          const newCap = Math.max(0, currentCap - amt);
          // Enum TransactionType only supports ('Delivery_In','Loan'), use 'Delivery_In' and negative Amount to indicate outflow
          await db.query(
            `INSERT INTO tbl_capital (BranchID, LoanID, TransactionType, Amount, AuditorID, Description, ReceivedBy, DeliveredBy, TransactionDate, CreatedDate, Current_Capital)
             VALUES (?, NULL, 'Delivery_In', ?, NULL, ?, NULL, NULL, CURDATE(), NOW(), ?)`,
            [from_branch_id, -Math.abs(amt), `Assignment #${result.insertId} source deduction (${assignment_type})`, newCap]
          );
        } catch (capErr) {
          console.warn('Capital source deduction failed:', capErr && capErr.message);
        }
    }

    // Update personnel status for the viewer's role (best-effort)
    try {
      const normalized = requesterRole.replace(/[\s_]+/g, '');
      let statusColumn = 'logistics_status';
      if (normalized === 'auditor') statusColumn = 'auditor_logistics_status';
      else if (normalized === 'accountexecutive') statusColumn = 'AccountExecutive_logistics_status';
      await db.query(`UPDATE tbl_accounts SET ${statusColumn} = 'ASSIGNED' WHERE Account_id = ?`, [assigned_to]);
    } catch (_) {}

    res.status(201).json({ success: true, assignment_id: result.insertId, message: 'Assignment created successfully' });
  } catch (e) {
    console.error('Error creating assignment:', e);
    res.status(500).json({ success: false, error: 'Failed to create assignment' });
  }
});

// Get assignments for a logistics personnel
router.get('/users/delivery-assignments/:personnelId', async (req, res) => {
  try {
    const { personnelId } = req.params;
    const [rows] = await db.query(
      `
      SELECT 
        da.*, 
        from_branch.BranchName as from_branch_name,
        from_branch.BranchCode as from_branch_code,
        from_branch.City as from_branch_city,
        from_branch.Region as from_branch_region,
        to_branch.BranchName as to_branch_name,
        to_branch.BranchCode as to_branch_code,
        to_branch.City as to_branch_city,
        to_branch.Region as to_branch_region,
        assigned_by_user.Fullname as assigned_by_name
      FROM tbl_delivery_assignments da
      LEFT JOIN tbl_branches from_branch ON from_branch.BranchID = da.from_branch_id
      LEFT JOIN tbl_branches to_branch ON to_branch.BranchID = da.to_branch_id
      LEFT JOIN tbl_accounts assigned_by_user ON assigned_by_user.Account_id = da.assigned_by
      WHERE da.assigned_to = ?
      ORDER BY da.created_at DESC
      `,
      [personnelId]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('Error fetching assignments:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch assignments' });
  }
});