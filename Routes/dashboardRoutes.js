const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection');

// Total Inventory Amount (items in Vault or Display)
router.get('/total-inventory', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT SUM(Amount) AS totalInventory
      FROM tbl_itemsinventory
      WHERE ItemStatus IN ('Vault','Display')
    `);
    const amount = rows?.[0]?.totalInventory || 0;
    res.json({ amount, diff: 0 });
  } catch (e) {
    console.error('Error total-inventory:', e);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Internal server error' : (e.sqlMessage || e.message || 'Internal server error') });
  }
});

// Items Sold Today
router.get('/items-sold-today', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT COUNT(*) AS count, COALESCE(SUM(SaleAmount),0) AS totalAmount
      FROM tbl_itemsinventory
      WHERE ItemStatus='Sold' AND DATE(SaleDate) = CURDATE()
    `);
    const row = rows?.[0] || {}; 
    res.json({ count: row.count || 0, amount: row.totalAmount || 0, diff: 0 });
  } catch (e) {
    console.error('Error items-sold-today:', e);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Internal server error' : (e.sqlMessage || e.message || 'Internal server error') });
  }
});

// Total Earnings (all sold items)
router.get('/total-earnings', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT COALESCE(SUM(SaleAmount),0) AS totalEarnings
      FROM tbl_itemsinventory
      WHERE ItemStatus='Sold'
    `);
    const amount = rows?.[0]?.totalEarnings || 0;
    res.json({ amount, diff: 0 });
  } catch (e) {
    console.error('Error total-earnings:', e);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Internal server error' : (e.sqlMessage || e.message || 'Internal server error') });
  }
});

// Pending Deliveries (ITEM_TRANSFER assignments still active)
router.get('/pending-deliveries', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT COUNT(*) AS pendingCount
      FROM tbl_delivery_assignments
      WHERE assignment_type='ITEM_TRANSFER' AND status IN ('ASSIGNED','IN_PROGRESS')
    `);
    const count = rows?.[0]?.pendingCount || 0;
    res.json({ count, diff: 0 });
  } catch (e) {
    console.error('Error pending-deliveries:', e);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Internal server error' : (e.sqlMessage || e.message || 'Internal server error') });
  }
});

// Sold items grouped by Brand (top 10)
router.get('/sold-items-by-brand', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        Brand, COUNT(*) AS item_count
      FROM tbl_itemsinventory
      WHERE ItemStatus='Sold'
      GROUP BY Brand
      ORDER BY item_count DESC
      LIMIT 10
    `);
    const brandData = {};
    rows.forEach(r => { brandData[r.Brand || 'Unknown'] = r.item_count; });
    res.json(brandData);
  } catch (e) {
    console.error('Error sold-items-by-brand:', e);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Internal server error' : (e.sqlMessage || e.message || 'Internal server error') });
  }
});

// Daily sales for current month (each day with total sale amount)
router.get('/daily-sales-current-month', async (req, res) => {
  try {
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1; // JS months 0-indexed
    const currentYear = currentDate.getFullYear();

    // Explicitly group by both date and day for ONLY_FULL_GROUP_BY compatibility
    const query = `
      SELECT 
        DATE(SaleDate) AS sale_date,
        DAY(SaleDate) AS day_number,
        COALESCE(SUM(SaleAmount),0) AS total_sales
      FROM tbl_itemsinventory
      WHERE ItemStatus='Sold'
        AND MONTH(SaleDate)=?
        AND YEAR(SaleDate)=?
      GROUP BY DATE(SaleDate), DAY(SaleDate)
      ORDER BY sale_date
    `;
    const [results] = await db.execute(query, [currentMonth, currentYear]);

    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
    const dailySales = {};
    for (let day = 1; day <= daysInMonth; day++) {
      const dateObj = new Date(currentYear, currentMonth - 1, day);
      dailySales[day] = {
        date: dateObj.toISOString().split('T')[0],
        displayDate: day.toString(),
        fullDate: dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        Total: 0
      };
    }

    results.forEach(row => {
      const day = row.day_number;
      if (day && day <= daysInMonth) {
        dailySales[day] = {
          date: row.sale_date,
          displayDate: String(day),
          fullDate: new Date(row.sale_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          Total: parseFloat(row.total_sales) || 0
        };
      }
    });

    res.json(Object.values(dailySales));
  } catch (e) {
    console.error('Error daily-sales-current-month:', e);
    // Fallback: supply zeroed current month so chart renders
    try {
      const now = new Date();
      const m = now.getMonth();
      const y = now.getFullYear();
      const dim = new Date(y, m + 1, 0).getDate();
      const fallback = [];
      for (let d = 1; d <= dim; d++) {
        const dateObj = new Date(y, m, d);
        fallback.push({
          date: dateObj.toISOString().split('T')[0],
          displayDate: String(d),
          fullDate: dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          Total: 0
        });
      }
      return res.json(fallback);
    } catch (nested) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
});

module.exports = router;