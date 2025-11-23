// In your backend API routes
app.get('/api/redeems', async (req, res) => {
  try {
    const [rows] = await connection.execute(`
      SELECT 
        RedeemID,
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
        CreatedDate
      FROM Redeems 
      ORDER BY CreatedDate DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching redeems:', error);
    res.status(500).json({ error: 'Failed to fetch redeems' });
  }
});