const db = require('./Config/db_connection');

(async () => {
  try {
    const [rows] = await db.query('SELECT 1 + 1 AS solution');
    console.log('Database connection successful:', rows);
  } catch (error) {
    console.error('Database connection failed:', error);
  }
})();