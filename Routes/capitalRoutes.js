const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection');

// Get current capital for all branches (latest Current_Capital per branch)
router.get('/current-capital', async (req, res) => {
  try {
    const query = `
      SELECT c1.BranchID, c1.Current_Capital
      FROM tbl_capital c1
      INNER JOIN (
        SELECT BranchID, MAX(CreatedDate) AS LatestDate
        FROM tbl_capital
        GROUP BY BranchID
      ) c2 ON c1.BranchID = c2.BranchID AND c1.CreatedDate = c2.LatestDate
    `;
    const [results] = await db.execute(query);
    res.json(results);
  } catch (error) {
    console.error('Error fetching current capital (all branches):', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current capital for a specific branch (returns number)
router.get('/branches/:branchId/current-capital', async (req, res) => {
  try {
    const { branchId } = req.params;
    const query = `
      SELECT Current_Capital
      FROM tbl_capital
      WHERE BranchID = ?
      ORDER BY CreatedDate DESC, CapitalID DESC
      LIMIT 1
    `;
    const [results] = await db.execute(query, [branchId]);
    if (results.length) {
      res.json(results[0].Current_Capital);
    } else {
      res.json(0); // no record yet, treat as zero
    }
  } catch (error) {
    console.error('Error fetching current capital (single branch):', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;