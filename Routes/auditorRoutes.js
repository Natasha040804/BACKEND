// Routes/auditorRoutes.js - Auditor-specific, broad access endpoints
const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection');

// Get all capital data for all branches (aggregated)
router.get('/capital/all', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT 
         BranchID,
         COALESCE(SUM(CASE WHEN TransactionType = 'DELIVERY_IN' THEN Amount ELSE -Amount END), 0) AS capital,
         70000 AS target
       FROM tbl_capital
       GROUP BY BranchID`
    );
    res.json(rows);
  } catch (error) {
    console.error('Error fetching all capital data:', error);
    res.status(500).json({ error: 'Failed to fetch capital data' });
  }
});

// Get ALL loans for a branch (auditor view)
router.get('/auditor/branches/:id/loans', async (req, res) => {
  try {
    const branchId = req.params.id;
    const [rows] = await db.execute(
      `SELECT LoanID, LoanAmount, LoanDate, Status, CustomerName
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
    console.error('Error fetching auditor loans:', error);
    res.status(500).json({ error: 'Failed to fetch loans' });
  }
});

// Get ALL redeems for a branch (auditor view)
router.get('/auditor/branches/:id/redeems', async (req, res) => {
  try {
    const branchId = req.params.id;
    const [rows] = await db.execute(
      `SELECT RedeemID, PaymentAmount, PaymentDate
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
    console.error('Error fetching auditor redeems:', error);
    res.status(500).json({ error: 'Failed to fetch redeems' });
  }
});

// Get ALL sales for a branch (auditor view)
router.get('/auditor/branches/:id/sales', async (req, res) => {
  try {
    const branchId = req.params.id;
    const [rows] = await db.execute(
      `SELECT SaleID, SalePrice, SaleDate, Items_id, CustomerName
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
    console.error('Error fetching auditor sales:', error);
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

// Get capital details for auditor for a specific branch
router.get('/auditor/branches/:id/capital', async (req, res) => {
  try {
    const branchId = req.params.id;
    const [rows] = await db.execute(
      `SELECT 
         COALESCE(SUM(CASE WHEN TransactionType = 'DELIVERY_IN' THEN Amount ELSE -Amount END), 0) AS currentCapital
       FROM tbl_capital
       WHERE BranchID = ?`,
      [branchId]
    );
    const currentCapital = (rows && rows[0] && rows[0].currentCapital) ? Number(rows[0].currentCapital) : 0;
    res.json({ currentCapital });
  } catch (error) {
    if (error && (error.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(error.message))) {
      return res.json({ currentCapital: 0 });
    }
    console.error('Error fetching auditor capital details:', error);
    res.status(500).json({ error: 'Failed to fetch capital details' });
  }
});

// Auditor dashboard widget data (single query for efficiency)
router.get('/auditor/widget-data', async (req, res) => {
  try {
    const query = `
      SELECT 
        (SELECT COALESCE(SUM(Amount), 0) FROM tbl_itemsinventory WHERE ItemStatus IN ('VAULT','DISPLAY')) AS totalInventory,
        (SELECT COALESCE(SUM(Current_Capital), 0) FROM (
          SELECT c1.BranchID, c1.Current_Capital
          FROM tbl_capital c1
          INNER JOIN (
            SELECT BranchID, MAX(CreatedDate) AS LatestDate
            FROM tbl_capital
            GROUP BY BranchID
          ) c2 ON c1.BranchID = c2.BranchID AND c1.CreatedDate = c2.LatestDate
        ) latest_capital) AS totalCapital,
        (SELECT COALESCE(SUM(PenaltyAmount), 0) FROM tbl_redeem) AS totalRedeems,
        (SELECT COALESCE(SUM(SalePrice), 0) FROM tbl_sales) AS totalSales
    `;
    const [results] = await db.execute(query);
    const row = results[0] || {};
    const totalInventory = parseFloat(row.totalInventory) || 0;
    const totalCapital = parseFloat(row.totalCapital) || 0;
    const totalRedeems = parseFloat(row.totalRedeems) || 0;
    const totalSales = parseFloat(row.totalSales) || 0;
    const totalBalance = totalCapital + totalSales + totalRedeems;

    const widgetData = {
      totalInventory: { amount: totalInventory, diff: 0 },
      totalCapital: { amount: totalCapital, diff: 0 },
      totalBalance: { amount: totalBalance, diff: 0 },
      totalRedeems: { amount: totalRedeems, diff: 0 }
    };
    res.json(widgetData);
  } catch (error) {
    console.error('Error fetching auditor widget data:', error);
    res.status(500).json({ error: 'Failed to fetch auditor widget data' });
  }
});

module.exports = router;
