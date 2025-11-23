const bcrypt = require('bcryptjs');

(async () => {
  try {
    const isMatch = await bcrypt.compare("admin123", '$2b$10$TYeTx1NJQ3L6LC41.gtHQu7B/v1G1JzSNZnnMtAagbzK9DwQDB8lm');
    console.log('Password match:', isMatch); // Should output "true"
  } catch (error) {
    console.error('Error:', error);
  }
})();