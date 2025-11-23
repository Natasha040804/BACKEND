const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection');
const { authenticate } = require('../middleware/authmiddleware');

// Require authentication for all inventory endpoints
router.use(authenticate);

// GET all items
router.get('/items', async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    let branchFilter = null;
    const statusFilter = req.query.status || null;
    // Optional: exclude a comma-separated list of statuses, e.g. exclude=Sold,Redeemed
    // Applies only when no explicit status filter is provided
    const excludeParam = (req.query.exclude || '').toString().trim();
    const excludeStatuses = (!statusFilter && excludeParam)
      ? excludeParam.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    if (role === 'accountexecutive' || role === 'ae') {
      // Determine the AE's currently approved branch access
      const userId = req.user.userId;
      const [access] = await db.query(
        `SELECT branch_id FROM access_requests
         WHERE account_executive_id = ?
           AND status = 'approved'
           AND approved_until > NOW()
         ORDER BY approved_until DESC
         LIMIT 1`,
        [userId]
      );

      if (!access.length) {
        // For Account Executives without an active branch access session, avoid a hard 403
        // to prevent frontend fetch failures. Return an empty list instead and add a hint header.
        res.set('X-Branch-Access', 'none');
        return res.json([]);
      }
      branchFilter = access[0].branch_id;
    } else if (req.query.branchId) {
      // Allow admins/auditors to filter by branch via query param
      const b = parseInt(req.query.branchId, 10);
      if (Number.isFinite(b)) branchFilter = b;
    }

    const baseSelect = `
      SELECT 
        i.Items_id,
        i.BranchID,
        b.BranchName AS BranchName,
        b.BranchCode AS BranchCode,
        b.City AS BranchCity,
        b.Region AS BranchRegion,
        i.LoanAgreementNumber,
        i.ItemSerialNumber,
        i.BatChargeSerialNumber AS BatchargeSerialNumber,
        i.Classification,
        i.ItemStatus,
        i.ModelNumber, 
        i.Brand,
        i.SaleAmount,
        i.Model,
        i.Processor,
        i.WifiAddress,
        i.Amount,
        i.InterestRate,
        i.InterestAmount,
        i.LoanDate,
        i.DueDate,
        i.Customer,
        i.CustomerAddress,
        i.CustomerContact,
        i.LastPawnBranch,
        i.LastPawnAmount,
        i.LastPawnDate,
        i.ClaimSoldDate,
        i.AccountExecutive
      FROM tbl_itemsinventory i
      LEFT JOIN tbl_branches b ON b.BranchID = i.BranchID`;

    // Build dynamic WHERE clause based on branch and status filters
    const whereParts = [];
    const values = [];
    if (branchFilter != null) {
      whereParts.push('i.BranchID = ?');
      values.push(branchFilter);
    }
    if (statusFilter != null) {
      whereParts.push('i.ItemStatus = ?');
      values.push(statusFilter);
    } else if (excludeStatuses.length > 0) {
      // Exclude provided statuses only when not using a specific status filter
      whereParts.push(`i.ItemStatus NOT IN (${excludeStatuses.map(() => '?').join(',')})`);
      values.push(...excludeStatuses);
    }

    let rows;
    if (whereParts.length > 0) {
      const sql = `${baseSelect} WHERE ${whereParts.join(' AND ')} ORDER BY i.Items_id DESC`;
      const [filtered] = await db.query(sql, values);
      rows = filtered;
    } else {
      const [all] = await db.query(`${baseSelect} ORDER BY i.Items_id DESC`);
      rows = all;
    }

    res.json(rows);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// POST add new item
router.post('/items', async (req, res) => {
  const item = req.body || {};

  // basic required fields check (adjust as needed)
  if (!item.ItemSerialNumber || !item.Branch) {
    return res.status(400).json({ error: 'Missing required fields: ItemSerialNumber or Branch' });
  }

  try {
    const [result] = await db.query(
      `INSERT INTO tbl_itemsinventory (
        BranchID,
        LoanAgreementNumber,
        ItemSerialNumber,
        BatChargeSerialNumber,
        Classification,
        ItemStatus,
        ModelNumber,
        Brand,
        Model,
        Processor,
        WifiAddress,
        Amount,
        InterestRate,
        InterestAmount,
        LoanDate,
        DueDate,
        Customer,
        CustomerAddress,
        CustomerContact,
        LastPawnBranch,
        LastPawnAmount,
        LastPawnDate,
        ClaimSoldDate,
        AccountExecutive
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        item.BranchID || null,
        item.LoanAgreementNumber || null,
        item.ItemSerialNumber || null,
        item.BatChargeSerialNumber || item.BatchargeSerialNumber || null,
        item.Classification || null,
        (item.ItemStatus || 'Vault'),
        item.ModelNumber || null,
        item.Brand || null,
        item.Model || null,
        item.Processor || null,
        item.WifiAddress || null,
        item.Amount || null,
        item.InterestRate || null,
        item.InterestAmount || null,
        item.LoanDate || null,
        item.DueDate || null,
        item.Customer || null,
        item.CustomerAddress || null,
        item.CustomerContact || null,
        item.LastPawnBranch || null,
        item.LastPawnAmount || null,
        item.LastPawnDate || null,
        item.ClaimSoldDate || null,
        item.AccountExecutive || null,
      ]
    );

    // result.insertId may vary depending on DB driver
    res.status(201).json({ insertedId: result.insertId || null });
  } catch (error) {
    console.error('Database insert error:', error);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// GET display items for a branch (ItemStatus = 'Display')
router.get('/items/display', async (req, res) => {
  try {
    const branchId = req.query.branchId || null;
    if (!branchId) return res.status(400).json({ error: 'branchId query parameter required' });

    const [rows] = await db.query(
      `SELECT 
        i.Items_id,
        i.BranchID,
        b.BranchName AS BranchName,
        b.BranchCode AS BranchCode,
        b.City AS BranchCity,
        b.Region AS BranchRegion,
        i.LoanAgreementNumber,
        i.ItemSerialNumber,
        i.BatChargeSerialNumber AS BatChargeSerialNumber,
        i.Classification,
        i.ItemStatus,
        i.ModelNumber,
        i.Brand,
        i.SaleAmount,
        i.Amount,
        i.InterestRate AS InterestRate,
        i.InterestAmount,
        i.Model,
        i.Processor,
        i.WifiAddress,
        i.LoanDate,
        i.DueDate,
        i.Customer,
        i.CustomerAddress,
        i.CustomerContact,
        i.LastPawnBranch,
        i.LastPawnAmount,
        i.LastPawnDate,
        i.ClaimSoldDate,
        i.AccountExecutive
      FROM tbl_itemsinventory i
      LEFT JOIN tbl_branches b ON b.BranchID = i.BranchID
      WHERE i.ItemStatus = 'Display' AND i.BranchID = ?
      ORDER BY i.Items_id DESC`,
      [branchId]
    );

    res.json(rows);
  } catch (error) {
    console.error('Error fetching display items:', error);
    res.status(500).json({ error: 'Failed to fetch display items' });
  }
});

// PUT mark item as sold (transactional)
router.put('/items/:id/sell', async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const itemId = req.params.id;
    const {
      salePrice,        // Sale Amount (from item) - goes to SalePrice in tbl_sales
      payment,          // Payment provided by customer - goes to Payment in tbl_sales
      changeAmount,     // Auto-calculated change - goes to ChangeAmount in tbl_sales
      saleDate,
      customerName,
      buyerContact,
      paymentMethod,
      accountExecutive,
      accountId
    } = req.body || {};

    // Basic validation
    if (salePrice == null || payment == null) {
      await connection.rollback();
      return res.status(400).json({ error: 'salePrice and payment are required' });
    }

    // Normalize date to YYYY-MM-DD for DATE columns
    const resolvedSaleDate = saleDate
      ? new Date(saleDate)
      : new Date();
    const yyyy = resolvedSaleDate.getFullYear();
    const mm = String(resolvedSaleDate.getMonth() + 1).padStart(2, '0');
    const dd = String(resolvedSaleDate.getDate()).padStart(2, '0');
    const saleDateStr = `${yyyy}-${mm}-${dd}`;

    // 1) Get item details needed for sales record
    const [items] = await connection.query(
      `SELECT BranchID, LoanAgreementNumber FROM tbl_itemsinventory WHERE Items_id = ?`,
      [itemId]
    );

    if (!items.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = items[0];
    // Coerce LoanAgreementNumber to integer if possible (tbl_sales.LoanID is INT)
    const loanId = item.LoanAgreementNumber && /^\d+$/.test(String(item.LoanAgreementNumber))
      ? parseInt(item.LoanAgreementNumber, 10)
      : null;

    // 2) Update inventory record to mark as Sold and persist sale info on the item
    await connection.query(
      `UPDATE tbl_itemsinventory 
       SET ItemStatus = 'Sold',
           SaleAmount = ?,
           SaleDate = ?,
           ClaimSoldDate = ?,
           AccountExecutive = COALESCE(?, AccountExecutive),
           updated_at = CURRENT_TIMESTAMP
       WHERE Items_id = ?`,
      [salePrice, saleDateStr, saleDateStr, accountExecutive || null, itemId]
    );

    // 3) Insert into tbl_sales with the new structure
    await connection.query(
      `INSERT INTO tbl_sales (
         Items_id,
         LoanID,
         BranchID,
         SalePrice,
         Payment,
         ChangeAmount,
         SaleDate,
         CustomerName,
         BuyerContact,
         BuyerAddress,
         PaymentMethod,
         AccountExecutive,
         Account_id
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        itemId,                       // Items_id
        loanId,                       // LoanID (nullable if not numeric)
        item.BranchID,                // BranchID
        salePrice,                    // SalePrice
        payment,                      // Payment
        changeAmount || 0,            // ChangeAmount
        saleDateStr,                  // SaleDate (DATE)
        customerName || null,         // CustomerName
        buyerContact || null,         // BuyerContact
        null,                         // BuyerAddress (disregarded)
        paymentMethod || null,        // PaymentMethod
        accountExecutive || null,     // AccountExecutive
        accountId || null             // Account_id
      ]
    );

    await connection.commit();
    return res.json({ message: 'Item sold successfully', itemId, saleRecorded: true });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    console.error('Error processing sale:', error);
    return res.status(500).json({ error: 'Failed to process sale: ' + error.message });
  } finally {
    try { connection.release(); } catch (_) {}
  }
});

// POST process redemption: insert into tbl_redeem, update item status, update loan status
router.post('/redeems', async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const {
      LoanID,
      BranchID,
      RedeemType,
      PaymentAmount,
      InterestAmount,
      PenaltyRate,
      PenaltyAmount,
      PenaltyTotal,
      LoanAmount,
      LoanDate,
      DueDate,
      PaymentDate,
      Items_id
    } = req.body || {};

    if (!Items_id) {
      await connection.rollback();
      return res.status(400).json({ error: 'Items_id is required' });
    }

    // Resolve LoanID to satisfy FK to tbl_loan
    let resolvedLoanId = LoanID ?? null;
    // Fetch inventory row to help lookup and validate existence
    const [invRows] = await connection.query(
      `SELECT LoanAgreementNumber, BranchID AS invBranchID, ItemSerialNumber FROM tbl_itemsinventory WHERE Items_id = ?`,
      [Items_id]
    );
    if (!invRows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Item not found' });
    }
    const inv = invRows[0];

    // If client supplied a LoanID, verify it exists (FK-safe). If not, treat as null to re-infer.
    if (resolvedLoanId != null) {
      const [existsRows] = await connection.query(
        `SELECT LoanID FROM tbl_loan WHERE LoanID = ? LIMIT 1`,
        [resolvedLoanId]
      );
      if (!existsRows.length) {
        resolvedLoanId = null; // will try to infer from item
      }
    }

    if (resolvedLoanId == null) {
      // Look up by ItemSerialNumber + BranchID (prefer branch from body, fallback to item's branch)
      const branchForLoan = BranchID || inv.invBranchID || null;
      const [loanRows] = await connection.query(
        `SELECT LoanID 
         FROM tbl_loan 
         WHERE ItemSerialNumber = ? AND ( ? IS NULL OR BranchID = ? )
         ORDER BY LoanDate DESC 
         LIMIT 1`,
        [inv.ItemSerialNumber || null, branchForLoan, branchForLoan]
      );
      if (loanRows.length) {
        resolvedLoanId = loanRows[0].LoanID;
      }
    }

    // If table enforces NOT NULL on LoanID and still null, abort with a clear 400
    if (resolvedLoanId == null) {
      await connection.rollback();
      return res.status(400).json({ error: 'LoanID is required and could not be inferred for this item. Ensure a matching loan exists for the item serial and branch.' });
    }

    // 1) Insert redemption record
    const [redeemResult] = await connection.query(
      `INSERT INTO tbl_redeem (
        LoanID, BranchID, RedeemType, PaymentAmount, InterestAmount,
        PenaltyRate, PenaltyAmount, PenaltyTotal, LoanAmount,
        LoanDate, DueDate, PaymentDate
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        resolvedLoanId,
        BranchID ?? null,
        RedeemType ?? 'REDEMPTION',
        PaymentAmount ?? 0,
        InterestAmount ?? 0,
        PenaltyRate ?? 0,
        PenaltyAmount ?? 0,
        PenaltyTotal ?? 0,
        LoanAmount ?? 0,
        LoanDate ?? null,
        DueDate ?? null,
        PaymentDate ?? null
      ]
    );

    // 2) Update inventory item status and claim date (assumes 'Redeemed' exists in enum)
    const [updateItem] = await connection.query(
      `UPDATE tbl_itemsinventory 
       SET ItemStatus = 'Redeemed', ClaimSoldDate = COALESCE(?, ClaimSoldDate), updated_at = CURRENT_TIMESTAMP
       WHERE Items_id = ?`,
      [PaymentDate ?? null, Items_id]
    );

    // 3) Update loan status to REDEEMED if applicable
    if (resolvedLoanId != null) {
      await connection.query(
        `UPDATE tbl_loan SET Status = 'REDEEMED' WHERE LoanID = ?`,
        [resolvedLoanId]
      );
    }

    await connection.commit();
    return res.json({
      success: true,
      message: 'Redemption processed successfully',
      redeemId: redeemResult.insertId,
      itemsUpdated: updateItem.affectedRows || 0
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    console.error('Error processing redemption:', error);
    return res.status(500).json({ error: 'Failed to process redemption', details: error.message });
  } finally {
    try { connection.release(); } catch (_) {}
  }
});

// POST create a loan and its inventory item in a single transaction
router.post('/loan/create-with-inventory', async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const { itemsInventory = {}, loan = {} } = req.body || {};

    if (!itemsInventory.ItemSerialNumber || !loan.CustomerName) {
      await connection.rollback();
      return res.status(400).json({ error: 'Missing required fields (ItemSerialNumber, CustomerName)' });
    }

    const mappedBatChargeSerial = itemsInventory.BatChargeSerialNumber ?? itemsInventory.BatchargeSerialNumber ?? null;

    const [itemsResult] = await connection.query(
      `INSERT INTO tbl_itemsinventory (
        BranchID,
        LoanAgreementNumber,
        ItemSerialNumber,
        BatChargeSerialNumber,
        Classification,
        ItemStatus,
        ModelNumber,
        Brand,
        Amount,
        SaleAmount,
        SaleDate,
        InterestRate,
        InterestAmount,
        Model,
        Processor,
        WifiAddress,
        LoanDate,
        DueDate,
        Customer,
        CustomerAddress,
        CustomerContact,
        LastPawnBranch,
        LastPawnAmount,
        LastPawnDate,
        ClaimSoldDate,
        AccountExecutive
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        itemsInventory.BranchID ?? null,
        itemsInventory.LoanAgreementNumber ?? null,
        itemsInventory.ItemSerialNumber ?? null,
        mappedBatChargeSerial,
        itemsInventory.Classification ?? null,
        itemsInventory.ItemStatus ?? 'Vault',
        itemsInventory.ModelNumber ?? null,
        itemsInventory.Brand ?? null,
        itemsInventory.Amount ?? null,
        itemsInventory.SaleAmount ?? null,
        itemsInventory.SaleDate ?? null,
        itemsInventory.InterestRate ?? null,
        itemsInventory.InterestAmount ?? null,
        itemsInventory.Model ?? null,
        itemsInventory.Processor ?? null,
        itemsInventory.WifiAddress ?? null,
        itemsInventory.LoanDate ?? null,
        itemsInventory.DueDate ?? null,
        itemsInventory.Customer ?? null,
        itemsInventory.CustomerAddress ?? null,
        itemsInventory.CustomerContact ?? null,
        itemsInventory.LastPawnBranch ?? null,
        itemsInventory.LastPawnAmount ?? null,
        itemsInventory.LastPawnDate ?? null,
        itemsInventory.ClaimSoldDate ?? null,
        itemsInventory.AccountExecutive ?? null
      ]
    );

    const [loanResult] = await connection.query(
      `INSERT INTO tbl_loan (
        BranchID,
        CustomerName,
        CustomerContact,
        Brand,
        Model,
        ItemSerialNumber,
        LoanAmount,
        LoanDate,
        DueDate,
        ExtensionDueDate,
        Status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        loan.BranchID ?? itemsInventory.BranchID ?? null,
        loan.CustomerName ?? itemsInventory.Customer ?? null,
        loan.CustomerContact ?? itemsInventory.CustomerContact ?? null,
        loan.Brand ?? itemsInventory.Brand ?? null,
        loan.Model ?? itemsInventory.Model ?? null,
        loan.ItemSerialNumber ?? itemsInventory.ItemSerialNumber ?? null,
        loan.LoanAmount ?? itemsInventory.Amount ?? null,
        loan.LoanDate ?? null,
        loan.DueDate ?? null,
        loan.ExtensionDueDate ?? null,
        loan.Status ?? 'ACTIVE'
      ]
    );

    // CAPITAL TRACKING
    const branchID = loan.BranchID ?? itemsInventory.BranchID ?? null;
    const loanAmount = parseFloat(loan.LoanAmount ?? itemsInventory.Amount ?? 0) || 0;
    let capitalRecord = null;
    if (branchID && loanAmount > 0) {
      // Fetch last current capital
      const [capitalRows] = await connection.query(
        `SELECT Current_Capital FROM tbl_capital
         WHERE BranchID = ?
         ORDER BY CreatedDate DESC, CapitalID DESC
         LIMIT 1`,
        [branchID]
      );
      let currentCapital = 0;
      if (capitalRows.length) {
        currentCapital = parseFloat(capitalRows[0].Current_Capital) || 0;
      }
      const newCurrentCapital = currentCapital - loanAmount;
      // Format TransactionDate (DATE column) as YYYY-MM-DD
      const txDate = itemsInventory.LoanDate
        ? new Date(itemsInventory.LoanDate).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];
      const description = `Loan disbursement for item ${itemsInventory.ItemSerialNumber}`;
      const [capitalResult] = await connection.query(
        `INSERT INTO tbl_capital (
          BranchID,
          LoanID,
          TransactionType,
          Amount,
          AuditorID,
          Description,
          ReceivedBy,
          DeliveredBy,
          TransactionDate,
          CreatedDate,
          Current_Capital
        ) VALUES (?,?,?,?,?,?,?,?,?,NOW(),?)`,
        [
          branchID,
          loanResult.insertId,
          'Loan',
          loanAmount,
          null,
          description,
          null,
          itemsInventory.AccountExecutive || null,
          txDate,
          newCurrentCapital
        ]
      );
      capitalRecord = { CapitalID: capitalResult.insertId, Current_Capital: newCurrentCapital };
    }

    await connection.commit();
    return res.json({
      success: true,
      message: 'Loan created in both systems' + (capitalRecord ? ' with capital tracking' : ''),
      itemsInventoryId: itemsResult.insertId,
      loanId: loanResult.insertId,
      ...(capitalRecord ? { capitalRecord } : {})
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    console.error('Error creating loan with inventory:', error);
    return res.status(500).json({ error: 'Failed to create loan' });
  } finally {
    try { connection.release(); } catch (_) {}
  }
});

module.exports = router;

// Update an item by id (partial update)
router.put('/items/:id', async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};

  // Allowed fields that can be updated via API
  const allowed = [
    'ItemStatus',
    'SaleAmount',
    'SaleDate',
    'Amount',
    'InterestRate',
    'InterestAmount',
    'ClaimSoldDate'
  ];

  const setParts = [];
  const values = [];

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      setParts.push(`\`${key}\` = ?`);
      values.push(body[key]);
    }
  }

  if (!setParts.length) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  // Add updated_at timestamp if exists in table
  setParts.push('updated_at = ?');
  values.push(new Date());

  values.push(id);

  const sql = `UPDATE tbl_itemsinventory SET ${setParts.join(', ')} WHERE Items_id = ?`;

  try {
    const [result] = await db.query(sql, values);
    if (result && result.affectedRows && result.affectedRows > 0) {
      return res.json({ success: true, affectedRows: result.affectedRows });
    }
    return res.status(404).json({ error: 'Item not found' });
  } catch (error) {
    console.error('Failed to update item:', error);
    return res.status(500).json({ error: 'Failed to update item' });
  }
});
