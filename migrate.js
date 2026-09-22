require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  });

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS audit_log (
      log_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      role VARCHAR(20),
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(50),
      entity_id INT,
      detail JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_user (user_id),
      INDEX idx_audit_action (action),
      INDEX idx_audit_time (created_at)
    )
  `);

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value VARCHAR(255) NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await conn.execute(`
    INSERT INTO system_settings (setting_key, setting_value) VALUES
      ('attendance_threshold', '75'),
      ('academic_year', '2026'),
      ('current_semester', 'Fall 2026'),
      ('qr_max_duration', '60')
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
  `);

  await conn.end();
  console.log('Migration complete.');
}

migrate().catch(e => { console.error('Migration error:', e.message); process.exit(1); });
