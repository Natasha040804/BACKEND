const mysql = require('mysql2');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });
//connetion pool

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 30,
    queueLimit: 0

});
// Test connection
pool.getConnection((err, connection) => {
  if (err) {
    console.error("Database Connection Failed:");
    console.error("- Error Code:", err.code);
    console.error("- Error Message:", err.message);
    console.error("- Stack Trace:", err.stack);
    process.exit(1);
  }
  console.log("Server Deployed: Database Connected Successfully");
  connection.release();
});

//pool export
module.exports = pool.promise();
