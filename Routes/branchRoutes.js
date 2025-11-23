// Routes/branchRoutes.js
const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection'); // This imports as 'db', not 'pool'

// Get all branches (active and inactive)
router.get('/branches', async (req, res) => {
  console.log('=== DEBUG: GET /branches called ===');
  try {
    console.log('Attempting to fetch branches...');
    
    const [branches] = await db.execute(`
      SELECT 
        BranchID,
        BranchCode,
        BranchName,
        Address,
        City,
        Region,
        ContactNumber,
        Active
      FROM tbl_branches 
      ORDER BY BranchName
    `);

    console.log('Branches query successful, found:', branches.length);
    res.json(branches);
  } catch (error) {
    console.error('❌ ERROR in /branches:', error.message);
    console.error('Full error:', error);
    res.status(500).json({ 
      error: 'Failed to load branches',
      details: error.message 
    });
  }
});

module.exports = router;
 
// Additional endpoints mounted by server.js will still work after this export statement
// Define them before exporting in typical patterns; kept here for minimal diff.

// POST /api/branches/capital - aggregated capital per branch
router.post('/branches/capital', async (req, res) => {
  try {
    const body = req.body || {};
    const branchIds = Array.isArray(body.branchIds) ? body.branchIds : null;
    if (!branchIds || !branchIds.length) {
      return res.status(400).json({ error: 'Branch IDs required' });
    }

    // Build placeholders and query tbl_capital; default target = 70000 if not provided by schema
    const placeholders = branchIds.map(() => '?').join(',');
    try {
      const [rows] = await db.query(
        `SELECT BranchID, COALESCE(SUM(Amount), 0) AS capital
         FROM tbl_capital
         WHERE BranchID IN (${placeholders})
         GROUP BY BranchID`,
        branchIds
      );

      // Ensure all requested branches are returned, even if zero
      const byId = new Map(rows.map(r => [r.BranchID, r]));
      const result = branchIds.map(id => ({
        BranchID: id,
        capital: Number((byId.get(id) && byId.get(id).capital) || 0),
        target: 70000,
      }));
      return res.json(result);
    } catch (innerErr) {
      // If tbl_capital doesn't exist or any error, gracefully fallback to zeros
      console.warn('branches/capital fallback:', innerErr && innerErr.message);
      const fallback = branchIds.map(id => ({ BranchID: id, capital: 0, target: 70000 }));
      return res.json(fallback);
    }
  } catch (error) {
    console.error('Error fetching capital data:', error);
    res.status(500).json({ error: 'Failed to fetch capital data' });
  }
});

// GET /api/branches/:id/capital - list capital transactions for a branch
router.get('/branches/:id/capital', async (req, res) => {
  try {
    const branchId = req.params.id;
    const [rows] = await db.execute(
      `SELECT CapitalID, TransactionType, Amount, Description, TransactionDate
       FROM tbl_capital
       WHERE BranchID = ?
       ORDER BY TransactionDate DESC`,
      [branchId]
    );
    res.json(rows);
  } catch (error) {
    // Graceful fallback if table missing
    if (error && (error.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(error.message))) {
      return res.json([]);
    }
    console.error('Error fetching capital transactions:', error);
    res.status(500).json({ error: 'Failed to fetch capital data' });
  }
});

// GET /api/branches/:id/loans - list loans for a branch
router.get('/branches/:id/loans', async (req, res) => {
  try {
    const branchId = req.params.id;
    const [rows] = await db.execute(
      `SELECT LoanID, LoanAmount, Status, LoanDate
       FROM tbl_loan
       WHERE BranchID = ?
       ORDER BY LoanDate DESC`,
      [branchId]
    );
    res.json(rows);
  } catch (error) {
    if (error && (error.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(error.message))) {
      return res.json([]);
    }
    console.error('Error fetching loan data:', error);
    res.status(500).json({ error: 'Failed to fetch loan data' });
  }
});

// GET /api/branches/:id/redeems - list redeem transactions for a branch
router.get('/branches/:id/redeems', async (req, res) => {
  try {
    const branchId = req.params.id;
    const [rows] = await db.execute(
      `SELECT RedeemID, RedeemType, PaymentAmount, PaymentDate
       FROM tbl_redeem
       WHERE BranchID = ?
       ORDER BY PaymentDate DESC`,
      [branchId]
    );
    res.json(rows);
  } catch (error) {
    if (error && (error.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(error.message))) {
      return res.json([]);
    }
    console.error('Error fetching redeem data:', error);
    res.status(500).json({ error: 'Failed to fetch redeem data' });
  }
});

// GET /api/branches/:id/sales - list sales for a branch
router.get('/branches/:id/sales', async (req, res) => {
  try {
    const branchId = req.params.id;
    const [rows] = await db.execute(
      `SELECT SaleID, SalePrice, SaleDate
       FROM tbl_sales
       WHERE BranchID = ?
       ORDER BY SaleDate DESC`,
      [branchId]
    );
    res.json(rows);
  } catch (error) {
    if (error && (error.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(error.message))) {
      return res.json([]);
    }
    console.error('Error fetching sales data:', error);
    res.status(500).json({ error: 'Failed to fetch sales data' });
  }
});