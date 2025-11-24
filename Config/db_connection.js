
let bcrypt;
try { bcrypt = require('bcrypt'); } catch (_) { bcrypt = require('bcryptjs'); }
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });
const db = require('./Config/db_connection');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true; // flag style (not used here but kept generic)
      }
    }
  }
  return out;
}

async function main() {
  const { username, email, password, role = 'Admin', fullname = '' } = parseArgs();
  if (!username || !email || !password) {
    console.error('Missing required arguments.');
    console.error('Example: node createUser.js --username AdminTest --email admin@test.local --password PlainText123 --role Admin --fullname "Admin Test"');
    process.exit(1);
  }
  try {
    console.log('Creating user...', { username, email, role });
    const saltRounds = 10;
    const hashed = await bcrypt.hash(password, saltRounds);
    // Ensure user does not already exist
    const [existing] = await db.query('SELECT Account_id FROM tbl_accounts WHERE Username = ? OR Email = ? LIMIT 1', [username, email]);
    if (existing.length) {
      console.error('User already exists with that username or email. Aborting.');
      process.exit(2);
    }
    const [result] = await db.query(
      'INSERT INTO tbl_accounts (Username, Email, Password, Role, Fullname) VALUES (?,?,?,?,?)',
      [username, email, hashed, role, fullname]
    );
    console.log('User inserted successfully.', { insertedId: result.insertId });
    // Fetch back to show stored data (excluding password)
    const [rows] = await db.query('SELECT Account_id, Username, Email, Role, Fullname FROM tbl_accounts WHERE Account_id = ?', [result.insertId]);
    console.log('Inserted row:', rows[0]);
  } catch (e) {
    console.error('Creation failed:', e && e.stack ? e.stack : e);
    process.exit(3);
  } finally {
    process.exit(0);
  }
}

main();
