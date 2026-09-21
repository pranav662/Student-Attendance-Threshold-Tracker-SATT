require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

async function updatePasswords() {
    try {
        const pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME
        });
        
        const hash = await bcrypt.hash('admin123', 12);
        await pool.execute(
            'UPDATE users SET password_hash = ? WHERE email IN (?, ?, ?)',
            [hash, 'admin@university.edu', 'prof.smith@university.edu', 'student@university.edu']
        );
        await pool.end();
        console.log('Sample account passwords were reset successfully.');
        process.exitCode = 0;
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    }
}
updatePasswords();
