const mysql = require('mysql2');
const dotenv = require('dotenv');
const path = require('path');

// Load .env adjacent to Capstone root if present
dotenv.config({ path: path.join(__dirname, '../.env') });

// Resolve configuration with Railway fallbacks.
// Primary expected vars: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
// Railway automatic provisioning vars: MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE
const resolved = {
  host: process.env.DB_HOST || process.env.MYSQLHOST,
  port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 45330),
  user: process.env.DB_USER || process.env.MYSQLUSER,
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
  database: process.env.DB_NAME || process.env.MYSQLDATABASE,
};

// Basic validation / diagnostics (do NOT print full password)
const missing = Object.entries(resolved)
  .filter(([k, v]) => !v && k !== 'password')
  .map(([k]) => k);

if (missing.length) {
  console.warn('[db] Warning: missing database config keys:', missing.join(','));
  console.warn('[db] Provide either DB_* variables or Railway MYSQL* variables.');
}

// Optional TLS: Railway MySQL 9+ usually supports TLS; leave disabled unless required.
// Enable by setting DB_SSL=1 (or MYSQL_SSL=1) and we will set ssl: { rejectUnauthorized: false }
let ssl = undefined;
if (process.env.DB_SSL === '1' || process.env.MYSQL_SSL === '1') {
  ssl = { rejectUnauthorized: false };
  console.log('[db] SSL enabled (rejectUnauthorized: false).');
}

const pool = mysql.createPool({
  host: resolved.host,
  user: resolved.user,
  password: resolved.password,
  database: resolved.database,
  port: resolved.port,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONN_LIMIT || 30),
  queueLimit: 0,
  ssl,
});

// Connection test (one-time). Fail fast if clearly misconfigured.
pool.getConnection((err, connection) => {
  if (err) {
    console.error('[db] Database connection failed');
    console.error('  code:', err.code);
    console.error('  message:', err.message);
    // Show effective host/port/user for quick diagnosis (not password)
    console.error('  config:', {
      host: resolved.host,
      port: resolved.port,
      user: resolved.user,
      database: resolved.database,
    });
    // Exit so platform restarts and surfaces logs
    process.exit(1);
  }
  console.log('[db] Connected successfully:', {
    host: resolved.host,
    port: resolved.port,
    user: resolved.user,
    database: resolved.database,
  });
  connection.release();
});

module.exports = pool.promise();
