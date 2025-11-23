const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection');

// Activity logs composed from transactional tables only (no inventory overlap)
// GET /api/activity/logs?branchId=...&limit=...
router.get('/activity/logs', async (req, res) => {
	try {
		const branchId = req.query.branchId ? parseInt(req.query.branchId, 10) : null;
		const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 200) : 50;

		const params = [];
		const branchFilterClause = branchId != null ? 'WHERE x.BranchID = ?' : '';
		if (branchId != null) params.push(branchId);
		params.push(limit);

		// UNION of loans, redeems, sales into a normalized shape for the frontend
		const sql = `
			SELECT 
				x.id,
				b.BranchName AS branch,
				x.amount,
				x.datetime,
				x.accountExecutive,
				x.assigned,
				x.purpose,
				x.status
			FROM (
				-- Loans
				SELECT 
					CONCAT('LN-', l.LoanID) AS id,
					l.BranchID,
					l.LoanAmount AS amount,
					l.LoanDate AS datetime,
					NULL AS accountExecutive,
					NULL AS assigned,
					'Loan' AS purpose,
					l.Status AS status
				FROM tbl_loan l

				UNION ALL

				-- Redeems
				SELECT 
					CONCAT('RD-', r.RedeemID) AS id,
					r.BranchID,
					r.PaymentAmount AS amount,
					r.PaymentDate AS datetime,
					NULL AS accountExecutive,
					NULL AS assigned,
					'Redeem' AS purpose,
					'Completed' AS status
				FROM tbl_redeem r

				UNION ALL

				-- Sales
				SELECT 
					CONCAT('SL-', s.SaleID) AS id,
					s.BranchID,
					s.SalePrice AS amount,
					s.SaleDate AS datetime,
					s.AccountExecutive AS accountExecutive,
					NULL AS assigned,
					'Sale' AS purpose,
					'Completed' AS status
				FROM tbl_sales s
			) x
			LEFT JOIN tbl_branches b ON b.BranchID = x.BranchID
			${branchFilterClause}
			ORDER BY x.datetime DESC
			LIMIT ?`;

		const [rows] = await db.query(sql, params);

		const data = (rows || []).map(r => ({
			id: r.id,
			branch: r.branch || '—',
			amount: r.amount != null ? Number(r.amount) : 0,
			datetime: r.datetime,
			accountExecutive: r.accountExecutive || '—',
			assigned: r.assigned || '—',
			purpose: r.purpose,
			status: r.status || '—',
		}));

		res.json({ success: true, data });
	} catch (error) {
		// If some tables don't exist in certain environments, return an empty list rather than 500
		if (error && (error.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(error.message))) {
			return res.json({ success: true, data: [] });
		}
		console.error('Error fetching activity logs:', error);
		res.status(500).json({ success: false, error: 'Failed to fetch activity logs' });
	}
});

module.exports = router;
