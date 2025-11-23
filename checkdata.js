const fs = require('fs');
const filePath = path.join(__dirname, 'Views/admin_dashboard.html');
console.log('File exists:', fs.existsSync(filePath));