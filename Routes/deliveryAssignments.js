const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection');
const { authenticate } = require('../middleware/authmiddleware');

// ALL assignments (admin/auditor only) - placed BEFORE any parameter routes to avoid being captured as :assignmentId
router.get('/all', authenticate, async (req, res) => {
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Branch-scoped assignment history (admin/auditor/approved AE)
router.get('/branch/:branchId', authenticate, async (req, res) => {
  try {
    const { branchId } = req.params;
    const branchNumeric = Number(branchId);
    if (!branchNumeric) {
      return res.status(400).json({ error: 'Invalid branch id' });
    }

    const role = String(req.user?.role || '').toLowerCase();
    if (role === 'accountexecutive' || role === 'ae') {
      const accountExecutiveId = req.user?.userId;
      if (!accountExecutiveId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      // Verify AE has active approval for this branch
      const [sessions] = await db.execute(
        `SELECT branch_id
         FROM access_requests
         WHERE account_executive_id = ?
           AND status = 'approved'
           AND approved_until > NOW()
         ORDER BY approved_until DESC
         LIMIT 1`,
        [accountExecutiveId]
      );
      if (!sessions.length || Number(sessions[0].branch_id) !== branchNumeric) {
        return res.status(403).json({ error: 'Forbidden: branch session not approved' });
      }
    } else if (!['admin', 'auditor'].includes(role)) {
      return res.status(403).json({ error: 'Forbidden' });
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
      WHERE da.from_branch_id = ? OR da.to_branch_id = ?
      ORDER BY da.created_at DESC
    `, [branchNumeric, branchNumeric]);

    const data = rows.map(r => ({
      ...r,
      items: r.items ? (() => { try { return JSON.parse(r.items); } catch { return null; } })() : null,
    }));
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    console.error('Error fetching branch assignments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET active assignment for personnel
router.get('/personnel/:id/active', async (req, res) => {
  try {
    const personnelId = req.params.id;
    const userRoleRaw = (req.query.role || '').toString();
    const normalizedRole = userRoleRaw.toLowerCase().replace(/[\s_]+/g, '');

    // Only enforce role filtering if role provided AND not admin
    const roleClause = (normalizedRole && normalizedRole !== 'admin')
      ? " AND REPLACE(REPLACE(LOWER(assigned_by.Role),' ',''),'_','') = ?"
      : '';

    const sql =
    `SELECT 
         da.assignment_id,
         da.assigned_to,
         da.assignment_type,
         da.from_location_type,
         da.from_branch_id,
         da.to_location_type,
         da.to_branch_id,
         da.status,
         da.items,
         da.amount,
         da.notes,
         da.due_date,
         da.created_at,
         da.updated_at,
         from_branch.BranchName as from_branch_name,
         from_branch.Address as from_branch_address,
         from_branch.City as from_branch_city,
         from_branch.Region as from_branch_region,
         from_branch.ContactNumber as from_branch_contact,
         from_branch.latitude as from_branch_lat,
         from_branch.longitude as from_branch_lng,
         to_branch.BranchName as to_branch_name,
         to_branch.Address as to_branch_address,
         to_branch.City as to_branch_city,
         to_branch.Region as to_branch_region,
         to_branch.ContactNumber as to_branch_contact,
         to_branch.latitude as to_branch_lat,
         to_branch.longitude as to_branch_lng,
         assigned_by.Fullname as assigned_by_name,
         assigned_by.Role as assigned_by_role,
         assigned_to_acc.Fullname as driver_name,
         assigned_to_acc.EmployeeID as driver_employee_id,
         assigned_to_acc.Contact as driver_contact,
         assigned_to_acc.Photo as driver_photo
       FROM tbl_delivery_assignments da
       LEFT JOIN tbl_branches from_branch ON da.from_branch_id = from_branch.BranchID
       LEFT JOIN tbl_branches to_branch ON da.to_branch_id = to_branch.BranchID
       LEFT JOIN tbl_accounts assigned_by ON da.assigned_by = assigned_by.Account_id
       LEFT JOIN tbl_accounts assigned_to_acc ON da.assigned_to = assigned_to_acc.Account_id
       WHERE da.assigned_to = ?
         AND da.status IN ('ASSIGNED', 'IN_PROGRESS')
         ${roleClause}
       ORDER BY 
         CASE 
           WHEN da.status = 'ASSIGNED' THEN 1
           WHEN da.status = 'IN_PROGRESS' THEN 2
           ELSE 3
         END,
         da.created_at DESC
       LIMIT 1`;
    const params = (normalizedRole && normalizedRole !== 'admin') ? [personnelId, normalizedRole] : [personnelId];
    const [rows] = await db.execute(sql, params);

    if (!rows.length) {
      return res.status(404).json({ error: 'No active delivery assignment found', personnelId });
    }

    const a = rows[0];
    let parsedItems = null;
    if (a.items) {
      try { parsedItems = typeof a.items === 'string' ? JSON.parse(a.items) : a.items; } catch (_) { parsedItems = null; }
    }

    const assignment = {
      assignment_id: a.assignment_id,
      assigned_to: a.assigned_to,
      assignment_type: a.assignment_type,
      from_location_type: a.from_location_type,
      from_branch_id: a.from_branch_id,
      to_location_type: a.to_location_type,
      to_branch_id: a.to_branch_id,
      status: a.status,
      items: parsedItems,
      amount: a.amount,
      notes: a.notes,
      due_date: a.due_date,
      created_at: a.created_at,
      updated_at: a.updated_at,
      from_branch_name: a.from_branch_name,
      from_branch_address: a.from_branch_address,
      from_branch_city: a.from_branch_city,
      from_branch_region: a.from_branch_region,
      from_branch_contact: a.from_branch_contact,
      to_branch_name: a.to_branch_name,
      to_branch_address: a.to_branch_address,
      to_branch_city: a.to_branch_city,
      to_branch_region: a.to_branch_region,
      to_branch_contact: a.to_branch_contact,
      from_branch_lat: a.from_branch_lat,
      from_branch_lng: a.from_branch_lng,
      to_branch_lat: a.to_branch_lat,
      to_branch_lng: a.to_branch_lng,
      assigned_by_name: a.assigned_by_name,
      assigned_by_role: a.assigned_by_role,
      driver_name: a.driver_name,
      driver_employee_id: a.driver_employee_id,
      driver_contact: a.driver_contact,
      driver_photo: a.driver_photo,
    };

    // Convenience coords for frontend map pins
    if (a.from_branch_lat != null && a.from_branch_lng != null) {
      assignment.from_location_coords = {
        lat: Number(a.from_branch_lat),
        lng: Number(a.from_branch_lng),
      };
    }
    if (a.to_branch_lat != null && a.to_branch_lng != null) {
      assignment.to_location_coords = {
        lat: Number(a.to_branch_lat),
        lng: Number(a.to_branch_lng),
      };
    }

    res.json({ success: true, data: assignment });
  } catch (error) {
    console.error('Error fetching active assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET all assignments (history) for personnel
router.get('/personnel/:id', async (req, res) => {
  try {
    const personnelId = req.params.id;
    const userRoleRaw = (req.query.role || '').toString();
    const normalizedRole = userRoleRaw.toLowerCase().replace(/[\s_]+/g, '');

    const roleClause = (normalizedRole && normalizedRole !== 'admin')
      ? " AND REPLACE(REPLACE(LOWER(assigned_by.Role),' ',''),'_','') = ?"
      : '';

    const sql =
      `SELECT 
         da.assignment_id,
         da.assignment_type,
         da.status,
         da.from_branch_id,
         da.to_branch_id,
         da.created_at,
         da.due_date,
         da.delivered_at,
         assigned_by.Role as assigned_by_role
       FROM tbl_delivery_assignments da
       LEFT JOIN tbl_accounts assigned_by ON da.assigned_by = assigned_by.Account_id
       WHERE da.assigned_to = ?
         ${roleClause}
       ORDER BY da.created_at DESC
       LIMIT 50`;
    const params = (normalizedRole && normalizedRole !== 'admin') ? [personnelId, normalizedRole] : [personnelId];
    const [rows] = await db.execute(sql, params);

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching assignments history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET assignment by ID - WITH ROLE FILTERING
router.get('/:assignmentId', async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const userRoleRaw = (req.query.role || '').toString();
    const normalizedRole = userRoleRaw.toLowerCase().replace(/[\s_]+/g, '');

    const roleClause = (normalizedRole && normalizedRole !== 'admin')
      ? " AND REPLACE(REPLACE(LOWER(assigned_by.Role),' ',''),'_','') = ?"
      : '';

    const sql =
      `SELECT 
         da.assignment_id,
         da.assigned_to,
         da.assigned_by,
         da.assignment_type,
         da.from_location_type,
         da.from_branch_id,
         da.to_location_type,
         da.to_branch_id,
         da.status,
         da.items,
         da.amount,
         da.notes,
         da.due_date,
         da.created_at,
         da.updated_at,
         from_branch.BranchName as from_branch_name,
         from_branch.latitude as from_branch_lat,
         from_branch.longitude as from_branch_lng,
         to_branch.BranchName as to_branch_name,
         to_branch.latitude as to_branch_lat,
         to_branch.longitude as to_branch_lng,
         assigned_by.Role as assigned_by_role
       FROM tbl_delivery_assignments da
       LEFT JOIN tbl_branches from_branch ON da.from_branch_id = from_branch.BranchID
       LEFT JOIN tbl_branches to_branch ON da.to_branch_id = to_branch.BranchID
       LEFT JOIN tbl_accounts assigned_by ON da.assigned_by = assigned_by.Account_id
       WHERE da.assignment_id = ?
         ${roleClause}
       LIMIT 1`;
    const params = (normalizedRole && normalizedRole !== 'admin') ? [assignmentId, normalizedRole] : [assignmentId];
    const [rows] = await db.execute(sql, params);

    if (!rows.length) {
      return res.status(404).json({ 
        error: 'Assignment not found or not accessible from your role',
        assignmentId
      });
    }

    const a = rows[0];
    let parsedItems = null;
    if (a.items) {
      try { parsedItems = typeof a.items === 'string' ? JSON.parse(a.items) : a.items; } catch (_) { parsedItems = null; }
    }

    const assignment = {
      assignment_id: a.assignment_id,
      assigned_to: a.assigned_to,
      assigned_by: a.assigned_by,
      assignment_type: a.assignment_type,
      from_location_type: a.from_location_type,
      from_branch_id: a.from_branch_id,
      to_location_type: a.to_location_type,
      to_branch_id: a.to_branch_id,
      status: a.status,
      items: parsedItems,
      amount: a.amount,
      notes: a.notes,
      due_date: a.due_date,
      created_at: a.created_at,
      updated_at: a.updated_at,
      from_branch_name: a.from_branch_name,
      to_branch_name: a.to_branch_name,
      from_branch_lat: a.from_branch_lat,
      from_branch_lng: a.from_branch_lng,
      to_branch_lat: a.to_branch_lat,
      to_branch_lng: a.to_branch_lng,
      assigned_by_role: a.assigned_by_role,
    };

    // Convenience coords for frontend map pins
    if (a.from_branch_lat != null && a.from_branch_lng != null) {
      assignment.from_location_coords = {
        lat: Number(a.from_branch_lat),
        lng: Number(a.from_branch_lng),
      };
    }
    if (a.to_branch_lat != null && a.to_branch_lng != null) {
      assignment.to_location_coords = {
        lat: Number(a.to_branch_lat),
        lng: Number(a.to_branch_lng),
      };
    }

    res.json({ success: true, data: assignment });
  } catch (error) {
    console.error('Error fetching assignment by ID:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// UPDATE assignment status (simple variant)
router.put('/:assignmentId', async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const { status, dropoff_image, notes } = req.body || {};
    if (!status) return res.status(400).json({ error: 'Status is required' });

    let query = `UPDATE tbl_delivery_assignments SET status = ?, updated_at = NOW()`;
    const params = [status];

    if (status === 'COMPLETED') {
      query += `, delivered_at = NOW(), dropoff_image = ?`;
      params.push(dropoff_image || null);
    }

    if (notes) {
      query += `, notes = CONCAT(COALESCE(notes, ''), ?) `;
      params.push(`\n${new Date().toISOString()}: ${notes}`);
    }

    query += ` WHERE assignment_id = ?`;
    params.push(assignmentId);

    const [result] = await db.execute(query, params);
    if ((result.affectedRows || 0) === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    if (status === 'COMPLETED') {
      // Set assigned driver's logistics_status back to STANDBY
      // Determine which role assigned the delivery to reset the corresponding status field
      try {
        const [[assignRow]] = await db.execute(
          `SELECT a.assigned_to, ab.Role AS assigner_role
           FROM tbl_delivery_assignments a
           LEFT JOIN tbl_accounts ab ON a.assigned_by = ab.Account_id
           WHERE a.assignment_id = ?
           LIMIT 1`,
          [assignmentId]
        );

        if (assignRow) {
          const roleNorm = String(assignRow.assigner_role || '').toLowerCase().replace(/[\s_]+/g, '');
          let column = 'logistics_status';
          if (roleNorm === 'auditor') column = 'auditor_logistics_status';
          else if (roleNorm === 'accountexecutive') column = 'AccountExecutive_logistics_status';

          // Whitelist and update
          const sql = `UPDATE tbl_accounts SET ${column} = 'STANDBY' WHERE Account_id = ?`;
          await db.execute(sql, [assignRow.assigned_to]);
        }
      } catch (e) {
        // do not fail the request if best-effort sync fails
        console.warn('Failed to reset role-specific logistics status on completion:', e?.message || e);
      }
    }

    res.json({ success: true, message: 'Assignment updated successfully' });
  } catch (error) {
    console.error('Error updating assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
