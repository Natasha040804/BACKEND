// server.js - route setup with early diagnostics
require('dotenv').config();

// EARLY patch BEFORE express loads Router so we actually wrap Layer constructor.
// Temporary: remove once offending path identified.
try {
  const layerPath = require.resolve('router/lib/layer.js');
  const LayerOrig = require(layerPath);
  if (!LayerOrig.__patched_for_diag_ctor) {
    function logPattern(p) {
      try {
        const raw = String(p);
        const hex = raw.split('').map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join(' ');
        console.log(`[layer-ctor] raw="${raw}" length=${raw.length} hex=${hex}`);
      } catch (_) {}
    }
    const WrappedLayer = function(path, options, fn) {
      if (Array.isArray(path)) {
        path.forEach(logPattern);
      } else {
        logPattern(path);
      }
      return LayerOrig.call(this, path, options, fn);
    };
    Object.keys(LayerOrig).forEach(k => { WrappedLayer[k] = LayerOrig[k]; });
    WrappedLayer.prototype = LayerOrig.prototype;
    WrappedLayer.__patched_for_diag_ctor = true;
    require.cache[layerPath].exports = WrappedLayer;
    console.log('[debug] Early Router Layer constructor patch active');
  }
} catch (e) {
  console.warn('[debug] Early Layer patch failed:', e && e.message);
}

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const cors = require('cors');
const session = require('express-session');

const app = express();

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Middleware
const corsOptions = {
  // Reflect the request origin in development to avoid hard-coding hosts/ports
  origin: (origin, callback) => callback(null, true),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id']
};
app.use(cors(corsOptions));
// Let the cors middleware handle preflight automatically; remove explicit app.options to avoid path-to-regexp issues
// Increase body limits for base64 images/signatures
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
// Multer setup for multipart uploads
// 1) Memory storage (kept for existing endpoints expecting base64 in-memory)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// 2) Disk storage for saving files to /uploads (used by simplified pickup verification)
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '.jpg';
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${ext}`);
  }
});
const diskUpload = multer({ storage: diskStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// DB and Auth
const db = require('./Config/db_connection');
const { authenticate } = require('./middleware/authmiddleware');

// Public health check BEFORE any /api routers that may enforce auth
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Diagnostic helper to isolate path-to-regexp crash: wraps app.use
function safeMount(basePath, router) {
  try {
    app.use(basePath, router);
    console.log(`[mount-ok] ${basePath}`);
  } catch (e) {
    console.error(`[mount-fail] ${basePath}:`, e && e.message);
    // Re-throw so deployment still fails (we want full stack) but with extra context
    throw e;
  }
}

// API Routes
const authRoutes = require('./Routes/authRoutes');
// mount auth routes at both /api and /api/auth so clients can use either shape
safeMount('/api', authRoutes);
safeMount('/api/auth', authRoutes);

const branchAccessRoutes = require('./Routes/branchAccessRoutes');
safeMount('/api', branchAccessRoutes);

const branchRoutes = require('./Routes/branchRoutes');
safeMount('/api', branchRoutes);

// Auditor routes (broad access read APIs)
const auditorRoutes = require('./Routes/auditorRoutes');
safeMount('/api', auditorRoutes);

// Additional API routes
const inventoryRoutes = require('./Routes/inventoryRoutes');
// Mount at both /api and /api/inventory for backward compatibility with older clients
safeMount('/api', inventoryRoutes);
safeMount('/api/inventory', inventoryRoutes);

const userRoutes = require('./Routes/userRoutes');
safeMount('/api', userRoutes);

// Transactions and activity logs
const transactionsRoutes = require('./Routes/transactionsRoutes');
safeMount('/api', transactionsRoutes);

const messageRoutes = require('./Routes/messageRoutes');
safeMount('/api', messageRoutes);

// Dashboard summary metrics
const dashboardRoutes = require('./Routes/dashboardRoutes');
safeMount('/api/dashboard', dashboardRoutes);

// Capital routes (current capital endpoints)
const capitalRoutes = require('./Routes/capitalRoutes');
safeMount('/api/capital', capitalRoutes);

// Delivery locations (mobile GPS ingest + latest fetch)
const deliveryLocationsRoutes = require('./Routes/deliveryLocations');
safeMount('/api/delivery-locations', deliveryLocationsRoutes);

// User-scoped delivery assignments using X-User-Id header
// Define these specific paths BEFORE mounting the generic '/:assignmentId' routes to avoid conflicts
// Get current user's assignments (ASSIGNED and IN_PROGRESS only)
app.get('/api/delivery-assignments/my-assignments', authenticate, async (req, res) => {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    console.log(`Fetching assignments for user ${userId}`);

    const [rows] = await db.execute(
      `SELECT 
         da.*,
         from_branch.BranchName as from_branch_name,
         to_branch.BranchName as to_branch_name,
         assigned_by.Username as assigned_by_username,
         assigned_by.Fullname as assigned_by_name
       FROM tbl_delivery_assignments da
       LEFT JOIN tbl_branches from_branch ON da.from_branch_id = from_branch.BranchID
       LEFT JOIN tbl_branches to_branch ON da.to_branch_id = to_branch.BranchID
       LEFT JOIN tbl_accounts assigned_by ON da.assigned_by = assigned_by.Account_id
       WHERE da.assigned_to = ?
         AND da.status IN ('ASSIGNED', 'IN_PROGRESS')
       ORDER BY da.created_at DESC`,
      [userId]
    );

    console.log(`Found ${rows.length} assignments for user ${userId}`);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching user assignments:', error);
    res.status(500).json({ error: 'Failed to load assignments' });
  }
});

// Get current user's completed deliveries
app.get('/api/delivery-assignments/my-completed', authenticate, async (req, res) => {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    console.log(`Fetching completed deliveries for user ${userId}`);

    const [rows] = await db.execute(
      `SELECT 
         da.*,
         from_branch.BranchName as from_branch_name,
         to_branch.BranchName as to_branch_name
       FROM tbl_delivery_assignments da
       LEFT JOIN tbl_branches from_branch ON da.from_branch_id = from_branch.BranchID
       LEFT JOIN tbl_branches to_branch ON da.to_branch_id = to_branch.BranchID
       WHERE da.assigned_to = ?
         AND da.status = 'COMPLETED'
       ORDER BY da.delivered_at DESC`,
      [userId]
    );

    console.log(`Found ${rows.length} completed deliveries for user ${userId}`);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching user completed deliveries:', error);
    res.status(500).json({ error: 'Failed to load completed deliveries' });
  }
});

// Get completed deliveries (public endpoint; adjust to add auth if needed)
app.get('/api/delivery-assignments/completed', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT 
         da.*, 
         da.created_at AS assignment_date,
         assigned_to.Fullname AS driver_name,
         assigned_to.Contact AS driver_phone,
         NULL AS vehicle_number,
         NULL AS vehicle_type
       FROM tbl_delivery_assignments da
       LEFT JOIN tbl_accounts assigned_to ON da.assigned_to = assigned_to.Account_id
       WHERE da.status = 'COMPLETED'
       ORDER BY da.delivered_at DESC`
    );

    res.json(rows);
  } catch (error) {
    console.error('Error fetching completed deliveries:', error);
    res.status(500).json({ error: 'Database error: ' + error.message });
  }
});

// Get active assignments (ASSIGNED and IN_PROGRESS)
app.get('/api/delivery-assignments/active', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT 
         da.*,
         da.created_at AS assignment_date,
         assigned_to.Fullname AS driver_name,
         assigned_to.Contact AS driver_phone,
         assigned_by.Username AS assigned_by_username,
         assigned_by.Fullname AS assigned_by_name,
         to_branch.BranchName as to_branch_name,
         from_branch.BranchName as from_branch_name,
         NULL AS vehicle_number,
         NULL AS vehicle_type
       FROM tbl_delivery_assignments da
       LEFT JOIN tbl_accounts assigned_to ON da.assigned_to = assigned_to.Account_id
       LEFT JOIN tbl_accounts assigned_by ON da.assigned_by = assigned_by.Account_id
       LEFT JOIN tbl_branches to_branch ON da.to_branch_id = to_branch.BranchID
       LEFT JOIN tbl_branches from_branch ON da.from_branch_id = from_branch.BranchID
       WHERE da.status IN ('ASSIGNED', 'IN_PROGRESS')
       ORDER BY 
         CASE 
           WHEN da.status = 'ASSIGNED' THEN 1
           WHEN da.status = 'IN_PROGRESS' THEN 2
           ELSE 3
         END,
         da.created_at DESC`
    );

    res.json(rows);
  } catch (error) {
    console.error('Error fetching active assignments:', error);
    res.status(500).json({ error: 'Database error: ' + error.message });
  }
});

// Branch-scoped assignment history for admins/auditors and approved account executives
app.get('/api/delivery-assignments/branch/:branchId', authenticate, async (req, res) => {
  try {
    const branchNumeric = Number(req.params.branchId);
    if (!branchNumeric) {
      return res.status(400).json({ error: 'Invalid branch id' });
    }

    const normalizedRole = String(req.user?.role || '').toLowerCase();
    if (normalizedRole === 'accountexecutive' || normalizedRole === 'ae') {
      const aeId = req.user?.userId;
      if (!aeId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const [sessions] = await db.execute(
        `SELECT branch_id
         FROM access_requests
         WHERE account_executive_id = ?
           AND status = 'approved'
           AND approved_until > NOW()
         ORDER BY approved_until DESC
         LIMIT 1`,
        [aeId]
      );

      if (!sessions.length || Number(sessions[0].branch_id) !== branchNumeric) {
        return res.status(403).json({ error: 'Forbidden: branch session not approved' });
      }
    } else if (!['admin', 'auditor'].includes(normalizedRole)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const [rows] = await db.execute(
      `SELECT 
         da.assignment_id,
         da.assignment_type,
         da.from_location_type,
         da.from_branch_id,
         da.to_location_type,
         da.to_branch_id,
         da.items,
         da.amount,
         da.status,
         da.notes,
         da.due_date,
         da.created_at,
         da.updated_at,
         da.delivered_at,
         da.item_image,
         da.dropoff_image,
         da.pickup_verified_at,
         from_branch.BranchName as from_branch_name,
         to_branch.BranchName as to_branch_name,
         assigned_by.Fullname as assigned_by_name,
         assigned_by.Username as assigned_by_username,
         assigned_to.Fullname as driver_name,
         assigned_to.Username as driver_username
       FROM tbl_delivery_assignments da
       LEFT JOIN tbl_branches from_branch ON da.from_branch_id = from_branch.BranchID
       LEFT JOIN tbl_branches to_branch ON da.to_branch_id = to_branch.BranchID
       LEFT JOIN tbl_accounts assigned_by ON da.assigned_by = assigned_by.Account_id
       LEFT JOIN tbl_accounts assigned_to ON da.assigned_to = assigned_to.Account_id
       WHERE da.from_branch_id = ? OR da.to_branch_id = ?
       ORDER BY da.created_at DESC`,
      [branchNumeric, branchNumeric]
    );

    const data = rows.map(row => ({
      ...row,
      items: row.items ? (() => { try { return JSON.parse(row.items); } catch { return null; } })() : null,
    }));

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    console.error('Error fetching branch assignments:', error);
    res.status(500).json({ error: 'Failed to load branch assignments' });
  }
});

// Delivery assignments (personnel active/history and status update)
const deliveryAssignmentsRoutes = require('./Routes/deliveryAssignments');
safeMount('/api/delivery-assignments', deliveryAssignmentsRoutes);

// Profile endpoint for mobile/web clients
app.get('/api/profile', authenticate, async (req, res) => {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const [users] = await db.execute(`
      SELECT 
        a.Account_id,
        a.Username,
        a.Fullname,
        a.Email,
        a.Role,
        a.EmployeeID,
        a.Contact,
        a.Address,
        a.Photo,
        a.BranchID,
        b.BranchName,
        b.BranchCode
      FROM tbl_accounts a
      LEFT JOIN tbl_branches b ON a.BranchID = b.BranchID
      WHERE a.Account_id = ?
    `, [userId]);

    if (!users.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const u = users[0];
    const profileData = {
      id: u.Account_id,
      username: u.Username,
      fullname: u.Fullname,
      email: u.Email,
      role: u.Role,
      employeeId: u.EmployeeID,
      contact: u.Contact,
      address: u.Address,
      photo: u.Photo,
      branchId: u.BranchID,
      branchName: u.BranchName,
      branchCode: u.BranchCode,
    };

    res.json(profileData);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delivery assignments endpoints for internal logistics (mobile)
// GET all delivery assignments for the logged-in user
app.get('/api/delivery-assignments', authenticate, async (req, res) => {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const [assignments] = await db.execute(`
      SELECT 
        da.assignment_id,
        da.assignment_type,
        da.from_location_type,
        da.from_branch_id,
        da.to_location_type,
        da.to_branch_id,
        da.items,
        da.amount,
        da.status,
        da.notes,
        da.due_date,
        da.created_at,
        da.updated_at,
        from_branch.BranchName as from_branch_name,
        to_branch.BranchName as to_branch_name,
        assigned_by.Fullname as assigned_by_name,
        assigned_by.Username as assigned_by_username,
        assigned_to.Fullname as driver_name
      FROM tbl_delivery_assignments da
      LEFT JOIN tbl_branches from_branch ON da.from_branch_id = from_branch.BranchID
      LEFT JOIN tbl_branches to_branch ON da.to_branch_id = to_branch.BranchID
      LEFT JOIN tbl_accounts assigned_by ON da.assigned_by = assigned_by.Account_id
      LEFT JOIN tbl_accounts assigned_to ON da.assigned_to = assigned_to.Account_id
      WHERE da.assigned_to = ?
      ORDER BY 
        CASE 
          WHEN da.status = 'PENDING' THEN 1
          WHEN da.status = 'ASSIGNED' THEN 2
          WHEN da.status = 'IN_PROGRESS' THEN 3
          WHEN da.status = 'COMPLETED' THEN 4
          ELSE 5
        END,
        da.due_date ASC
    `, [userId]);

    const assignmentsWithParsedItems = assignments.map(a => ({
      ...a,
      items: a.items ? (() => { try { return JSON.parse(a.items); } catch { return null; } })() : null,
    }));

    res.json(assignmentsWithParsedItems);
  } catch (error) {
    console.error('Delivery assignments error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify pickup (simplified): store uploaded file name, update columns that exist
app.post('/api/delivery-assignments/:id/verify-pickup', authenticate, diskUpload.single('itemImage'), async (req, res) => {
  try {
    const { id } = req.params;
    const itemImage = req.file ? req.file.filename : null;

    console.log(`Verifying pickup for assignment ${id} with image: ${itemImage}`);

    // Update the delivery assignment with status, image file name and pickup timestamp
    const [updateResult] = await db.execute(
      `UPDATE tbl_delivery_assignments 
       SET status = 'IN_PROGRESS', 
           item_image = ?,
           pickup_verified_at = NOW(),
           updated_at = NOW()
       WHERE assignment_id = ?`,
      [itemImage, id]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: 'Delivery assignment not found' });
    }

    console.log(`Successfully verified pickup for assignment ${id}`);

    // Ensure the driver's logistics_status reflects active work
    try {
      const [rows] = await db.execute('SELECT assigned_to FROM tbl_delivery_assignments WHERE assignment_id = ?', [id]);
      const assignedTo = rows?.[0]?.assigned_to;
      if (assignedTo) {
        await db.execute(`UPDATE tbl_accounts SET logistics_status = 'ASSIGNED' WHERE Account_id = ?`, [assignedTo]);
      }
    } catch (e) {
      console.warn('Warning: failed to set logistics_status to ASSIGNED on pickup:', e?.message);
    }

    res.json({ 
      success: true, 
      message: 'Pickup verified successfully',
      assignmentId: id
    });

  } catch (error) {
    console.error('Verify pickup error:', error);
    res.status(500).json({ error: 'Database error: ' + error.message });
  }
});

// Verify dropoff (simplified): save image filename, update status and delivered timestamp
app.post('/api/delivery-assignments/:id/verify-dropoff', authenticate, diskUpload.single('itemImage'), async (req, res) => {
  try {
    const { id } = req.params;
    const itemImage = req.file ? req.file.filename : null;

    console.log(`Dropoff - Assignment ${id}, Image: ${itemImage}`);

    // 1) Get assignment details for destination branch and items
    const [assignment] = await db.execute(
      `SELECT assignment_type, amount, to_branch_id, items, assigned_to 
       FROM tbl_delivery_assignments 
       WHERE assignment_id = ?`,
      [id]
    );

    if (!assignment.length) {
      return res.status(404).json({ error: 'Delivery assignment not found' });
    }

  const toBranchId = assignment[0].to_branch_id;
  const itemsData = assignment[0].items; // may arrive as string or object depending on column type/config
  console.log('Raw items data:', itemsData);
  console.log('Type of items data:', typeof itemsData);
  console.log('Destination branch ID:', toBranchId);

    // 2) Update delivery assignment (status/image/timestamps)
    const [updateResult] = await db.execute(
      `UPDATE tbl_delivery_assignments 
       SET status = 'COMPLETED', 
           dropoff_image = ?,
           delivered_at = NOW(),
           updated_at = NOW()
       WHERE assignment_id = ?`,
      [itemImage, id]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: 'Failed to update delivery assignment' });
    }

    // 3) Update ONLY BranchID for items listed in the assignment (if any)
    let itemsUpdated = 0;
    let updatedItems = [];
    if (itemsData && toBranchId) {
      try {
        let itemsArray;
        if (typeof itemsData === 'object' && itemsData !== null) {
          console.log('Items data is already an object, no parsing needed');
          itemsArray = itemsData;
        } else if (typeof itemsData === 'string') {
          console.log('Items data is a string, parsing JSON');
          itemsArray = JSON.parse(itemsData);
        } else {
          console.log('Unexpected items data type:', typeof itemsData);
          itemsArray = [];
        }

        let itemIds = [];
        if (Array.isArray(itemsArray)) {
          // Prefer object array with item_id
          if (itemsArray.length && typeof itemsArray[0] === 'object') {
            itemIds = itemsArray.map(item => item?.item_id).filter(Boolean);
          } else {
            // Raw list of ids
            itemIds = itemsArray.filter(v => typeof v === 'number' || typeof v === 'string');
          }
        } else if (itemsArray && typeof itemsArray === 'object' && Array.isArray(itemsArray.itemIds)) {
          itemIds = itemsArray.itemIds.filter(v => typeof v === 'number' || typeof v === 'string');
        }

        console.log('Processed items array:', itemsArray);
        console.log('Extracted item IDs:', itemIds);

        if (Array.isArray(itemIds) && itemIds.length > 0) {
          const placeholders = itemIds.map(() => '?').join(',');
          const params = [toBranchId, ...itemIds];
          const [itemUpdate] = await db.execute(
            `UPDATE tbl_itemsinventory 
             SET BranchID = ?, updated_at = NOW()
             WHERE Items_id IN (${placeholders})`,
            params
          );
          itemsUpdated = itemUpdate.affectedRows || 0;
          updatedItems = itemIds;
          console.log(`✅ Updated BranchID for ${itemsUpdated} items to branch ${toBranchId}`);
          console.log('Updated item IDs:', itemIds);
        }
      } catch (parseError) {
        console.error('Error parsing items JSON:', parseError);
        // Continue even if items parsing fails; assignment was updated successfully
      }
    }

    // 4) Set assigned driver's logistics_status back to STANDBY
    try {
      const assignedTo = assignment[0]?.assigned_to;
      if (assignedTo) {
        await db.execute(
          `UPDATE tbl_accounts SET logistics_status = 'STANDBY' WHERE Account_id = ?`,
          [assignedTo]
        );
      }
    } catch (e) {
      console.warn('Warning: failed to update driver logistics_status to STANDBY:', e?.message);
    }

    // Capital transfer completion logic: add amount to destination for CAPITAL_DELIVERY & BALANCE_DELIVERY
    try {
      const a = assignment[0];
      if (['CAPITAL_DELIVERY','BALANCE_DELIVERY'].includes(a.assignment_type) && a.amount && toBranchId) {
        const amt = Number(a.amount);
        if (amt > 0) {
          // Fetch latest capital for destination
          const [capRows] = await db.execute(
            `SELECT Current_Capital FROM tbl_capital WHERE BranchID = ? ORDER BY CreatedDate DESC, CapitalID DESC LIMIT 1`,
            [toBranchId]
          );
          const currentCap = capRows.length ? Number(capRows[0].Current_Capital) : 0;
          const newCap = currentCap + amt;
          // Enum only supports ('Delivery_In','Loan'); use 'Delivery_In' for inbound capital
          await db.execute(
            `INSERT INTO tbl_capital (BranchID, LoanID, TransactionType, Amount, AuditorID, Description, ReceivedBy, DeliveredBy, TransactionDate, CreatedDate, Current_Capital)
             VALUES (?, NULL, 'Delivery_In', ?, NULL, ?, NULL, NULL, CURDATE(), NOW(), ?)`,
            [toBranchId, Math.abs(amt), `Assignment #${id} destination addition (${a.assignment_type})`, newCap]
          );
        }
      }
    } catch (capErr) {
      console.warn('Capital destination addition failed:', capErr && capErr.message);
    }

    res.json({
      success: true,
      message: 'Delivery completed successfully! Items moved to new branch.',
      assignmentId: id,
      itemsUpdated,
      newBranchId: toBranchId || null,
      updatedItems,
    });
  } catch (error) {
    console.error('Dropoff error:', error);
    res.status(500).json({ error: 'Failed to update dropoff: ' + error.message });
  }
});
// Update driver current GPS location for an assignment (from mobile app)
app.post('/api/delivery-assignments/:id/location', authenticate, async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { latitude, longitude, accuracy, heading, speed, timestamp } = req.body || {};
    if (
      typeof latitude === 'undefined' || typeof longitude === 'undefined' ||
      latitude === null || longitude === null
    ) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    // Ensure the assignment belongs to the authenticated user
    const [rows] = await db.execute(
      'SELECT assignment_id FROM tbl_delivery_assignments WHERE assignment_id = ? AND assigned_to = ?',
      [assignmentId, userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Delivery assignment not found or not assigned to user' });
    }

    // Best-effort create (won't alter existing schema). We keep this for fresh setups only.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS tbl_delivery_locations (
        assignment_id INT NOT NULL,
        latitude DECIMAL(10,7) NOT NULL,
        longitude DECIMAL(10,7) NOT NULL,
        accuracy FLOAT NULL,
        recorded_at DATETIME NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const reportedAt = timestamp ? new Date(timestamp) : new Date();

    // Try insert using recorded_at, fallback to reported_at if needed. Ignore heading/speed to match lean schemas.
    let insertId = null;
    try {
      const [r1] = await db.execute(
        `INSERT INTO tbl_delivery_locations 
          (assignment_id, latitude, longitude, accuracy, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
        [assignmentId, Number(latitude), Number(longitude),
         accuracy != null ? Number(accuracy) : null,
         reportedAt]
      );
      insertId = r1.insertId || null;
    } catch (err) {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        const [r2] = await db.execute(
          `INSERT INTO tbl_delivery_locations 
            (assignment_id, latitude, longitude, accuracy, reported_at)
           VALUES (?, ?, ?, ?, ?)`,
          [assignmentId, Number(latitude), Number(longitude),
           accuracy != null ? Number(accuracy) : null,
           reportedAt]
        );
        insertId = r2.insertId || null;
      } else {
        throw err;
      }
    }

    res.json({
      success: true,
  id: insertId,
      assignmentId: Number(assignmentId),
      coords: { latitude: Number(latitude), longitude: Number(longitude) },
      accuracy: accuracy != null ? Number(accuracy) : null,
      heading: heading != null ? Number(heading) : null,
      speed: speed != null ? Number(speed) : null,
      reported_at: reportedAt,
    });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location: ' + error.message });
  }
});

// Get latest known driver GPS location for an assignment
app.get('/api/delivery-assignments/:id/location/latest', authenticate, async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Ensure the assignment belongs to the authenticated user or, if needed, relax this to authorized roles
    const [rows] = await db.execute(
      'SELECT assignment_id FROM tbl_delivery_assignments WHERE assignment_id = ? AND assigned_to = ?',
      [assignmentId, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Delivery assignment not found' });

    // Return latest from locations table if it exists
    try {
      const [latest] = await db.execute(
        `SELECT id, latitude, longitude, accuracy, heading, speed, reported_at, created_at 
         FROM tbl_delivery_locations 
         WHERE assignment_id = ? 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [assignmentId]
      );
      if (!latest.length) return res.json(null);
      res.json(latest[0]);
    } catch (e) {
      // Table may not exist yet
      return res.json(null);
    }
  } catch (error) {
    console.error('Get latest location error:', error);
    res.status(500).json({ error: 'Failed to fetch latest location: ' + error.message });
  }
});
// GET single delivery assignment details
app.get('/api/delivery-assignments/:id', authenticate, async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const [assignments] = await db.execute(`
      SELECT 
        da.*,
        from_branch.BranchName as from_branch_name,
        from_branch.Address as from_branch_address,
        from_branch.ContactNumber as from_branch_contact,
        from_branch.latitude as from_branch_lat,
        from_branch.longitude as from_branch_lng,
        to_branch.BranchName as to_branch_name,
        to_branch.Address as to_branch_address,
        to_branch.ContactNumber as to_branch_contact,
        to_branch.latitude as to_branch_lat,
        to_branch.longitude as to_branch_lng,
        assigned_by.Fullname as assigned_by_name,
        assigned_by.Email as assigned_by_email,
        assigned_to.Fullname as driver_name,
        assigned_to.Contact as driver_contact
      FROM tbl_delivery_assignments da
      LEFT JOIN tbl_branches from_branch ON da.from_branch_id = from_branch.BranchID
      LEFT JOIN tbl_branches to_branch ON da.to_branch_id = to_branch.BranchID
      LEFT JOIN tbl_accounts assigned_by ON da.assigned_by = assigned_by.Account_id
      LEFT JOIN tbl_accounts assigned_to ON da.assigned_to = assigned_to.Account_id
      WHERE da.assignment_id = ? AND da.assigned_to = ?
    `, [assignmentId, userId]);

    if (!assignments.length) {
      return res.status(404).json({ error: 'Delivery assignment not found' });
    }

    const assignment = assignments[0];
    assignment.items = assignment.items ? (() => { try { return JSON.parse(assignment.items); } catch { return null; } })() : null;
    // Derived coords from joined branches if present
    if (assignment.from_branch_lat != null && assignment.from_branch_lng != null) {
      assignment.from_location_coords = {
        lat: Number(assignment.from_branch_lat),
        lng: Number(assignment.from_branch_lng),
      };
    }
    if (assignment.to_branch_lat != null && assignment.to_branch_lng != null) {
      assignment.to_location_coords = {
        lat: Number(assignment.to_branch_lat),
        lng: Number(assignment.to_branch_lng),
      };
    }

    res.json(assignment);
  } catch (error) {
    console.error('Delivery assignment details error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// UPDATE delivery assignment status
app.put('/api/delivery-assignments/:id/status', authenticate, async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const userId = req.user && req.user.userId;
    const { status, notes } = req.body || {};
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!status) return res.status(400).json({ error: 'Status is required' });

    const [rows] = await db.execute(
      'SELECT * FROM tbl_delivery_assignments WHERE assignment_id = ? AND assigned_to = ?',
      [assignmentId, userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Delivery assignment not found' });
    }

    await db.execute(
      'UPDATE tbl_delivery_assignments SET status = ?, notes = CONCAT(IFNULL(notes, ""), ?, " - ", NOW(), "\\n"), updated_at = NOW() WHERE assignment_id = ?',
      [status, notes ? `${status}: ${notes}` : `${status}`, assignmentId]
    );

    // Maintain tbl_accounts.logistics_status in sync with assignment lifecycle
    try {
      const [rows2] = await db.execute('SELECT assigned_to FROM tbl_delivery_assignments WHERE assignment_id = ?', [assignmentId]);
      const assignedTo = rows2?.[0]?.assigned_to;
      if (assignedTo) {
        const s = String(status || '').toUpperCase();
        // Treat ASSIGNED and IN_PROGRESS equivalently for card display
        if (s === 'ASSIGNED' || s === 'IN_PROGRESS') {
          await db.execute(`UPDATE tbl_accounts SET logistics_status = 'ASSIGNED' WHERE Account_id = ?`, [assignedTo]);
        } else if (s === 'COMPLETED' || s === 'CANCELLED' || s === 'FAILED') {
          await db.execute(`UPDATE tbl_accounts SET logistics_status = 'STANDBY' WHERE Account_id = ?`, [assignedTo]);
        }
      }
    } catch (e) {
      console.warn('Warning: failed to update logistics_status for status change:', e?.message);
    }

    res.json({ message: 'Status updated successfully', newStatus: status });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve uploads statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve static files from React in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dlms-frontend/build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dlms-frontend/build', 'index.html'));
  });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://localhost:${PORT} (listening on 0.0.0.0)`));
// Add this to server.js for testing
app.get('/api/debug/test-db', async (req, res) => {
  try {
    const db = require('./Config/db_connection');
    const [result] = await db.execute('SELECT 1 as test');
    res.json({ 
      status: 'Database connection OK',
      test: result 
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'Database connection FAILED',
      error: error.message 
    });
  }
});

// Health endpoint for connectivity tests (RN/emulators/browsers)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});
// Get all delivery assignments (admin/auditor only). Place BEFORE :id route to avoid capture.
app.get('/api/delivery-assignments/all', authenticate, async (req, res) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    if (!['admin','auditor'].includes(role)) {
      return res.status(403).json({ error: 'Forbidden: requires admin or auditor role' });
    }
    const [rows] = await db.execute(`
      SELECT 
        da.assignment_id,
        da.assignment_type,
        da.from_location_type,
        da.from_branch_id,
        da.to_location_type,
        da.to_branch_id,
        da.items,
        da.amount,
        da.status,
        da.notes,
        da.due_date,
        da.created_at,
        da.updated_at,
        da.delivered_at,
        da.item_image,
        da.dropoff_image,
        da.pickup_verified_at,
        from_branch.BranchName as from_branch_name,
        to_branch.BranchName as to_branch_name,
        assigned_by.Fullname as assigned_by_name,
        assigned_by.Username as assigned_by_username,
        assigned_to.Fullname as driver_name,
        assigned_to.Username as driver_username
      FROM tbl_delivery_assignments da
      LEFT JOIN tbl_branches from_branch ON da.from_branch_id = from_branch.BranchID
      LEFT JOIN tbl_branches to_branch ON da.to_branch_id = to_branch.BranchID
      LEFT JOIN tbl_accounts assigned_by ON da.assigned_by = assigned_by.Account_id
      LEFT JOIN tbl_accounts assigned_to ON da.assigned_to = assigned_to.Account_id
      ORDER BY da.created_at DESC
    `);
    const data = rows.map(r => ({
      ...r,
      items: r.items ? (() => { try { return JSON.parse(r.items); } catch { return null; } })() : null,
    }));
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    console.error('Error fetching all assignments:', error);
    res.status(500).json({ error: 'Failed to load assignments' });
  }
});
