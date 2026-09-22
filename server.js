require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const PDFDocument = require('pdfkit');

// ── Uploads directory ──────────────────────────────────────
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.user.sub}_${Date.now()}${ext}`);
  }
});
const ALLOWED_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.includes(ext)) return cb(new Error('Only image files are allowed.'));
    cb(null, true);
  }
});

// ── Environment validation ─────────────────────────────────
const requiredEnvironment = ['DB_HOST', 'DB_USER', 'DB_NAME', 'JWT_SECRET'];
for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const app  = express();
const port = Number(process.env.PORT || 3000);
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.use(express.json({ limit: '16kb' }));
app.get('/faculty.html', (req, res) => res.redirect('/faculty/faculty_dashboard.html'));
app.get('/student.html', (req, res) => res.redirect('/student/student_dashboard.html'));
// Serve static files with no-cache headers during development
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// ── Small helpers ──────────────────────────────────────────
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(res, status, error) { return res.status(status).json({ error }); }
function stringValue(value) { return typeof value === 'string' ? value.trim() : ''; }
function integerValue(value, label, min = 0, max = 1_000_000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
  return number;
}
function issueToken(user) {
  return jwt.sign(
    { sub: user.user_id, role: user.role, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '8h', issuer: 'sams', audience: 'sams-web' }
  );
}
function authenticate(req, res, next) {
  let token = req.query.token;
  if (!token) {
    const authHeader = String(req.headers.authorization || '');
    if (authHeader.startsWith('Bearer ')) token = authHeader.split(' ')[1];
  }
  if (!token) return fail(res, 401, 'Authentication is required.');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'sams', audience: 'sams-web' });
    return next();
  } catch { return fail(res, 401, 'Your session is invalid or expired. Please sign in again.'); }
}
function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role) ? next() : fail(res, 403, 'You do not have access to this resource.');
}
function makeRollNumber() {
  return `STU-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// ── Audit logger (fire-and-forget) ────────────────────────
async function auditLog(userId, role, action, entityType = null, entityId = null, detail = null) {
  try {
    await pool.execute(
      `INSERT INTO audit_log (user_id, role, action, entity_type, entity_id, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, role, action, entityType, entityId, detail ? JSON.stringify(detail) : null]
    ).catch(() => {}); // table may not exist on old installs — silently ignore
  } catch {}
}

// ==========================================
// Attendance Threshold Engine
// ==========================================
const ATTENDANCE_THRESHOLD = 75;
let thresholdCache = { value: ATTENDANCE_THRESHOLD, at: 0 };

async function getAttendanceThreshold() {
  if (Date.now() - thresholdCache.at < 15_000) return thresholdCache.value;
  try {
    const [rows] = await pool.execute(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'attendance_threshold' LIMIT 1"
    );
    const n = Number(rows[0]?.setting_value);
    if (Number.isFinite(n) && n > 0 && n <= 100) {
      thresholdCache = { value: n, at: Date.now() };
      return n;
    }
  } catch {}
  thresholdCache = { value: ATTENDANCE_THRESHOLD, at: Date.now() };
  return ATTENDANCE_THRESHOLD;
}

function calcThreshold(attended, total, threshold = ATTENDANCE_THRESHOLD) {
  attended = Number(attended) || 0;
  total = Number(total) || 0;
  threshold = Number(threshold);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) threshold = ATTENDANCE_THRESHOLD;
  const pct = total === 0 ? 0 : Number(((attended / total) * 100).toFixed(2));
  const t = threshold / 100;
  let status = 'no_classes', canMiss = 0, needToAttend = 0;
  if (total > 0) {
    if (pct >= threshold) {
      status = pct >= Math.min(100, threshold + 10) ? 'safe' : 'near_threshold';
      canMiss = Math.max(0, Math.floor((attended - t * total) / t));
    } else {
      status = pct >= Math.max(0, threshold - 15) ? 'at_risk' : 'critical';
      needToAttend = t >= 1 ? 0 : Math.max(0, Math.ceil((t * total - attended) / (1 - t)));
    }
  }
  return { percentage: pct, status, threshold, canMiss, needToAttend };
}

// ── User creation helpers ──────────────────────────────────
async function createStudent({ email, password, name, batchYear = new Date().getFullYear() }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [user] = await connection.execute(
      `INSERT INTO users (email, password_hash, role, status) VALUES (?, ?, 'student', 'approved')`,
      [email, await bcrypt.hash(password, 12)]
    );
    await connection.execute(
      'INSERT INTO students (user_id, roll_number, name, batch_year) VALUES (?, ?, ?, ?)',
      [user.insertId, makeRollNumber(), name, batchYear]
    );
    await connection.commit();
    return { userId: user.insertId };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function createFaculty({ email, password, name, employeeId }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [user] = await connection.execute(
      `INSERT INTO users (email, password_hash, role, status) VALUES (?, ?, 'faculty', 'pending')`,
      [email, await bcrypt.hash(password, 12)]
    );
    await connection.execute(
      'INSERT INTO faculty (user_id, employee_id, name, designation) VALUES (?, ?, ?, ?)',
      [user.insertId, employeeId, name, 'Teacher']
    );
    await connection.commit();
    return { userId: user.insertId };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

// ==========================================
// AUTH ROUTES
// ==========================================
app.post('/register', async (req, res, next) => {
  try {
    const email    = stringValue(req.body.email || req.body.username).toLowerCase();
    const password = String(req.body.password || '');
    const name     = stringValue(req.body.name);
    const role     = req.body.role === 'faculty' ? 'faculty' : 'student';

    if (!EMAIL_PATTERN.test(email))              return fail(res, 400, 'Enter a valid email address.');
    if (password.length < 8 || password.length > 128) return fail(res, 400, 'Password must be 8–128 characters.');
    if (name.length < 2 || name.length > 255)   return fail(res, 400, 'Name must be 2–255 characters.');

    if (role === 'faculty') {
      const employeeId = 'EMP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      await createFaculty({ email, password, name, employeeId });
      return res.status(201).json({ message: 'Faculty account created. Please wait for admin approval.' });
    } else {
      await createStudent({ email, password, name });
      return res.status(201).json({ message: 'Your student account has been created. Please sign in.' });
    }
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return fail(res, 409, 'An account with that email already exists.');
    return next(error);
  }
});

app.post('/login', async (req, res, next) => {
  try {
    const email    = stringValue(req.body.email || req.body.username).toLowerCase();
    const password = String(req.body.password || '');
    if (!EMAIL_PATTERN.test(email) || !password) return fail(res, 400, 'Email and password are required.');

    // Single clean query — always use u.user_id to avoid ambiguity
    const [userRows] = await pool.execute(
      `SELECT u.user_id, u.email, u.password_hash, u.role, u.status,
              COALESCE(s.name, f.name) AS name
       FROM users u
       LEFT JOIN students s ON s.user_id = u.user_id
       LEFT JOIN faculty  f ON f.user_id = u.user_id
       WHERE u.email = ?`,
      [email]
    );
    const user = userRows[0];
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash)))
      return fail(res, 401, 'Invalid email or password.');
    if (user.status === 'pending')  return fail(res, 403, 'Your account is pending admin approval.');
    if (user.status === 'rejected') return fail(res, 403, 'Your account has been rejected. Contact the administrator.');

    user.name = user.name || user.email;
    auditLog(user.user_id, user.role, 'LOGIN', 'user', user.user_id);
    return res.json({ token: issueToken(user), role: user.role });
  } catch (error) { return next(error); }
});


// ==========================================
// ADMIN APIs
// ==========================================

/* ── Stats ── */
app.get('/api/admin/stats', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const [[students]]  = await pool.execute('SELECT COUNT(*) AS count FROM students');
    const [[faculty]]   = await pool.execute(`SELECT COUNT(*) AS count FROM faculty f JOIN users u ON u.user_id = f.user_id WHERE u.status = 'approved'`);
    const [[courses]]   = await pool.execute('SELECT COUNT(*) AS count FROM courses');
    const [[depts]]     = await pool.execute('SELECT COUNT(*) AS count FROM departments');
    const [[pending]]   = await pool.execute(`SELECT COUNT(*) AS count FROM users WHERE role = 'faculty' AND status = 'pending'`);
    const [[sessions]]  = await pool.execute('SELECT COUNT(*) AS count FROM sessions');
    const [[todaySess]] = await pool.execute('SELECT COUNT(*) AS count FROM sessions WHERE session_date = CURDATE()');

    // At-risk: students where overall attendance < 75%
    const [atRiskRows] = await pool.execute(`
      SELECT s.student_id,
        COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN ar.record_id END) AS attended,
        (SELECT COUNT(DISTINCT se.session_id) FROM sessions se
         JOIN enrollments e ON e.course_id = se.course_id WHERE e.student_id = s.student_id) AS total
      FROM students s
      LEFT JOIN attendance_records ar ON ar.student_id = s.student_id
      GROUP BY s.student_id
      HAVING total > 0 AND (attended / total * 100) < 75
    `);

    return res.json({
      students:   students.count,
      faculty:    faculty.count,
      courses:    courses.count,
      departments: depts.count,
      pending:    pending.count,
      at_risk:    atRiskRows.length,
      sessions:   sessions.count,
      today_sessions: todaySess.count
    });
  } catch (error) { return next(error); }
});

/* ── Pending faculty approvals ── */
app.get('/api/admin/pending-teachers', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const [teachers] = await pool.execute(`
      SELECT u.user_id, u.email, f.name, f.employee_id, f.designation, u.status
      FROM users u JOIN faculty f ON u.user_id = f.user_id
      WHERE u.role = 'faculty' AND u.status = 'pending'
      ORDER BY u.user_id DESC
    `);
    return res.json(teachers);
  } catch (error) { return next(error); }
});

/* ── Approve / reject faculty ── */
app.put('/api/admin/approve-teacher/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) return fail(res, 400, 'Invalid status.');
    const [result] = await pool.execute(
      `UPDATE users SET status = ? WHERE user_id = ? AND role = 'faculty'`,
      [status, userId]
    );
    if (!result.affectedRows) return fail(res, 404, 'Faculty member not found.');
    auditLog(req.user.sub, 'admin', status === 'approved' ? 'APPROVE_FACULTY' : 'REJECT_FACULTY', 'faculty', userId);
    return res.json({ message: `Faculty account ${status} successfully.` });
  } catch (error) { return next(error); }
});

/* ── All students ── */
app.get('/api/admin/students', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const search = stringValue(req.query.search);
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(10, parseInt(req.query.limit) || 30));
    const offset = (page - 1) * limit;

    const whereClause = search
      ? `WHERE (s.name LIKE ? OR s.roll_number LIKE ? OR u.email LIKE ?)`
      : '';
    const params = search
      ? [`%${search}%`, `%${search}%`, `%${search}%`]
      : [];

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM students s JOIN users u ON u.user_id = s.user_id ${whereClause}`,
      params
    );
    const [rows] = await pool.execute(
      `SELECT s.student_id, s.name, s.roll_number, s.batch_year, u.email, u.status, u.user_id,
              (SELECT COUNT(*) FROM enrollments e WHERE e.student_id = s.student_id) AS enrolled_courses,
              (SELECT COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN ar.record_id END)
               FROM attendance_records ar WHERE ar.student_id = s.student_id) AS attended_classes,
              (SELECT COUNT(DISTINCT se.session_id) FROM sessions se
               JOIN enrollments e ON e.course_id = se.course_id WHERE e.student_id = s.student_id) AS total_classes
       FROM students s JOIN users u ON u.user_id = s.user_id
       ${whereClause}
       ORDER BY s.name LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return res.json({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (error) { return next(error); }
});

/* ── All faculty ── */
app.get('/api/admin/faculty', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const search = stringValue(req.query.search);
    const whereClause = search
      ? `WHERE (f.name LIKE ? OR f.employee_id LIKE ? OR u.email LIKE ?)`
      : '';
    const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

    const [rows] = await pool.execute(
      `SELECT f.faculty_id, f.name, f.employee_id, f.designation, u.email, u.status, u.user_id,
              (SELECT COUNT(*) FROM faculty_assignments fa WHERE fa.faculty_id = f.faculty_id) AS assigned_courses
       FROM faculty f JOIN users u ON u.user_id = f.user_id
       ${whereClause}
       ORDER BY u.status, f.name`,
      params
    );
    return res.json(rows);
  } catch (error) { return next(error); }
});

/* ── Suspend / activate a user ── */
app.put('/api/admin/users/:id/status', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) return fail(res, 400, 'Invalid status value.');
    if (userId === req.user.sub) return fail(res, 400, 'You cannot change your own account status.');
    const [result] = await pool.execute('UPDATE users SET status = ? WHERE user_id = ?', [status, userId]);
    if (!result.affectedRows) return fail(res, 404, 'User not found.');
    auditLog(req.user.sub, 'admin', status === 'approved' ? 'ACTIVATE_USER' : 'SUSPEND_USER', 'user', userId);
    return res.json({ message: `User account ${status} successfully.` });
  } catch (error) { return next(error); }
});

/* ── Edit Student ── */
app.put('/api/admin/students/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const studentId = parseInt(req.params.id);
    const { name, roll_number, batch_year } = req.body;
    if (!name || !roll_number || !batch_year) return fail(res, 400, 'Missing required fields.');
    
    const [existing] = await pool.execute('SELECT student_id FROM students WHERE roll_number = ? AND student_id != ?', [roll_number, studentId]);
    if (existing.length > 0) return fail(res, 409, 'Roll number already in use by another student.');

    const [result] = await pool.execute(
      'UPDATE students SET name = ?, roll_number = ?, batch_year = ? WHERE student_id = ?',
      [name, roll_number, batch_year, studentId]
    );
    if (!result.affectedRows) return fail(res, 404, 'Student not found.');
    auditLog(req.user.sub, 'admin', 'UPDATE_STUDENT', 'student', studentId);
    return res.json({ message: 'Student updated successfully.' });
  } catch (error) { return next(error); }
});

/* ── Edit Faculty ── */
app.put('/api/admin/faculty/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const facultyId = parseInt(req.params.id);
    const { name, employee_id, designation } = req.body;
    if (!name || !employee_id || !designation) return fail(res, 400, 'Missing required fields.');

    const [existing] = await pool.execute('SELECT faculty_id FROM faculty WHERE employee_id = ? AND faculty_id != ?', [employee_id, facultyId]);
    if (existing.length > 0) return fail(res, 409, 'Employee ID already in use by another faculty.');

    const [result] = await pool.execute(
      'UPDATE faculty SET name = ?, employee_id = ?, designation = ? WHERE faculty_id = ?',
      [name, employee_id, designation, facultyId]
    );
    if (!result.affectedRows) return fail(res, 404, 'Faculty not found.');
    auditLog(req.user.sub, 'admin', 'UPDATE_FACULTY', 'faculty', facultyId);
    return res.json({ message: 'Faculty updated successfully.' });
  } catch (error) { return next(error); }
});

/* ── Departments ── */
app.get('/api/admin/departments', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT d.dept_id, d.dept_name, d.dept_code,
        (SELECT COUNT(*) FROM courses c WHERE c.dept_id = d.dept_id) AS course_count,
        (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e
         JOIN courses c ON c.course_id = e.course_id WHERE c.dept_id = d.dept_id) AS student_count
      FROM departments d ORDER BY d.dept_name
    `);
    return res.json(rows);
  } catch (error) { return next(error); }
});

app.post('/api/admin/departments', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const dept_name = stringValue(req.body.dept_name);
    const dept_code = stringValue(req.body.dept_code).toUpperCase();
    if (!dept_name || dept_name.length < 2) return fail(res, 400, 'Department name is required.');
    if (!dept_code || dept_code.length < 2) return fail(res, 400, 'Department code is required.');
    const [result] = await pool.execute('INSERT INTO departments (dept_name, dept_code) VALUES (?, ?)', [dept_name, dept_code]);
    auditLog(req.user.sub, 'admin', 'CREATE_DEPT', 'department', result.insertId, { dept_name, dept_code });
    return res.status(201).json({ dept_id: result.insertId, message: 'Department created.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return fail(res, 409, 'A department with that code already exists.');
    return next(error);
  }
});

/* ── Courses ── */
app.get('/api/admin/courses', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const search = stringValue(req.query.search);
    const whereClause = search ? `WHERE (c.course_code LIKE ? OR c.course_name LIKE ?)` : '';
    const params = search ? [`%${search}%`, `%${search}%`] : [];
    const [rows] = await pool.execute(
      `SELECT c.course_id, c.course_code, c.course_name, d.dept_name, d.dept_code, d.dept_id,
              (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.course_id) AS student_count,
              (SELECT COUNT(*) FROM faculty_assignments fa WHERE fa.course_id = c.course_id) AS faculty_count,
              (SELECT COUNT(*) FROM sessions s WHERE s.course_id = c.course_id) AS session_count
       FROM courses c JOIN departments d ON d.dept_id = c.dept_id
       ${whereClause}
       ORDER BY c.course_code`, params
    );
    return res.json(rows);
  } catch (error) { return next(error); }
});

app.post('/api/admin/courses', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const course_code = stringValue(req.body.course_code).toUpperCase();
    const course_name = stringValue(req.body.course_name);
    const dept_id     = integerValue(req.body.dept_id, 'Department', 1);
    if (!course_code) return fail(res, 400, 'Course code is required.');
    if (!course_name) return fail(res, 400, 'Course name is required.');
    const [[dept]] = await pool.execute('SELECT dept_id FROM departments WHERE dept_id = ?', [dept_id]);
    if (!dept) return fail(res, 400, 'Selected department does not exist.');
    const [result] = await pool.execute(
      'INSERT INTO courses (dept_id, course_code, course_name) VALUES (?, ?, ?)',
      [dept_id, course_code, course_name]
    );
    auditLog(req.user.sub, 'admin', 'CREATE_COURSE', 'course', result.insertId, { course_code, course_name });
    return res.status(201).json({ course_id: result.insertId, message: 'Course created successfully.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return fail(res, 409, 'A course with that code already exists.');
    return next(error);
  }
});

app.put('/api/admin/courses/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const courseId    = parseInt(req.params.id);
    const course_code = stringValue(req.body.course_code).toUpperCase();
    const course_name = stringValue(req.body.course_name);
    const dept_id     = integerValue(req.body.dept_id, 'Department', 1);
    if (!course_code) return fail(res, 400, 'Course code is required.');
    if (!course_name) return fail(res, 400, 'Course name is required.');
    const [result] = await pool.execute(
      'UPDATE courses SET course_code = ?, course_name = ?, dept_id = ? WHERE course_id = ?',
      [course_code, course_name, dept_id, courseId]
    );
    if (!result.affectedRows) return fail(res, 404, 'Course not found.');
    auditLog(req.user.sub, 'admin', 'UPDATE_COURSE', 'course', courseId, { course_code, course_name });
    return res.json({ message: 'Course updated successfully.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return fail(res, 409, 'A course with that code already exists.');
    return next(error);
  }
});

app.delete('/api/admin/courses/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const courseId = parseInt(req.params.id);
    // Safety check — warn if academic history exists
    const [[{ enrollments }]] = await pool.execute('SELECT COUNT(*) AS enrollments FROM enrollments WHERE course_id = ?', [courseId]);
    const [[{ sessions }]]    = await pool.execute('SELECT COUNT(*) AS sessions    FROM sessions    WHERE course_id = ?', [courseId]);
    if (Number(enrollments) > 0 || Number(sessions) > 0) {
      return fail(res, 409, `Cannot delete course: it has ${enrollments} enrollment(s) and ${sessions} session(s). Remove those records first or contact the database administrator.`);
    }
    const [result] = await pool.execute('DELETE FROM courses WHERE course_id = ?', [courseId]);
    if (!result.affectedRows) return fail(res, 404, 'Course not found.');
    auditLog(req.user.sub, 'admin', 'DELETE_COURSE', 'course', courseId);
    return res.json({ message: 'Course deleted successfully.' });
  } catch (error) { return next(error); }
});

/* ── At-risk students (below 75% overall) ── */
app.get('/api/admin/at-risk-students', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const threshold = await getAttendanceThreshold();
    const [rows] = await pool.execute(`
      SELECT s.student_id, s.name, s.roll_number, s.batch_year, u.email,
        COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN ar.record_id END) AS attended,
        (SELECT COUNT(DISTINCT se.session_id) FROM sessions se
         JOIN enrollments e2 ON e2.course_id = se.course_id WHERE e2.student_id = s.student_id) AS total
      FROM students s
      JOIN users u ON u.user_id = s.user_id
      LEFT JOIN attendance_records ar ON ar.student_id = s.student_id
      GROUP BY s.student_id, s.name, s.roll_number, s.batch_year, u.email
      HAVING total > 0
      ORDER BY (attended / total) ASC
    `);
    const withCalc = rows.map(r => {
      const t = Number(r.total), a = Number(r.attended);
      const calc = calcThreshold(a, t, threshold);
      return { ...r, percentage: calc.percentage, status: calc.status, needToAttend: calc.needToAttend };
    }).filter(r => r.percentage < threshold);
    return res.json(withCalc);
  } catch (error) { return next(error); }
});

/* ── Attendance monitoring ── */
app.get('/api/admin/attendance-monitoring', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const search    = stringValue(req.query.search);
    const courseId  = parseInt(req.query.course_id) || null;
    const page      = Math.max(1, parseInt(req.query.page) || 1);
    const limit     = Math.min(100, Math.max(10, parseInt(req.query.limit) || 30));
    const offset    = (page - 1) * limit;

    let where = [];
    let params = [];
    if (search) { where.push(`(s.name LIKE ? OR s.roll_number LIKE ?)`); params.push(`%${search}%`, `%${search}%`); }
    if (courseId) { where.push(`c.course_id = ?`); params.push(courseId); }
    const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM students s
       JOIN enrollments e ON e.student_id = s.student_id
       JOIN courses c ON c.course_id = e.course_id
       ${whereStr}`, params
    );
    const [rows] = await pool.execute(
      `SELECT s.student_id, s.name, s.roll_number, c.course_id, c.course_code, c.course_name,
              COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN ar.record_id END) AS attended,
              COUNT(DISTINCT se.session_id) AS total_sessions
       FROM students s
       JOIN enrollments e ON e.student_id = s.student_id
       JOIN courses c ON c.course_id = e.course_id
       LEFT JOIN sessions se ON se.course_id = c.course_id
       LEFT JOIN attendance_records ar ON ar.session_id = se.session_id AND ar.student_id = s.student_id
       ${whereStr}
       GROUP BY s.student_id, s.name, s.roll_number, c.course_id, c.course_code, c.course_name
       ORDER BY s.name, c.course_code LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const threshold = await getAttendanceThreshold();
    const withCalc = rows.map(r => {
      const calc = calcThreshold(Number(r.attended), Number(r.total_sessions), threshold);
      return { ...r, percentage: calc.percentage, status: calc.status, canMiss: calc.canMiss, needToAttend: calc.needToAttend };
    });
    return res.json({ data: withCalc, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (error) { return next(error); }
});

/* ── Audit logs ── */
app.get('/api/admin/audit-logs', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = stringValue(req.query.search);
    const where  = search ? `WHERE al.action LIKE ? OR al.role LIKE ?` : '';
    const params = search ? [`%${search}%`, `%${search}%`] : [];

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM audit_log al ${where}`, params
    ).catch(() => [[{ total: 0 }]]);

    const [rows] = await pool.execute(
      `SELECT al.log_id, al.user_id, al.role, al.action, al.entity_type, al.entity_id, al.detail, al.created_at,
              COALESCE(s.name, f.name) AS user_name, u.email
       FROM audit_log al
       LEFT JOIN users u ON u.user_id = al.user_id
       LEFT JOIN students s ON s.user_id = al.user_id
       LEFT JOIN faculty f ON f.user_id = al.user_id
       ${where}
       ORDER BY al.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    ).catch(() => [[]]);

    return res.json({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (error) { return next(error); }
});

/* ── Settings ── */
app.get('/api/admin/settings', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT setting_key, setting_value FROM system_settings').catch(() => [[]]);
    const settings = {};
    rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
    // Defaults
    return res.json({
      attendance_threshold: Number(settings.attendance_threshold ?? 75),
      academic_year:        settings.academic_year ?? new Date().getFullYear().toString(),
      current_semester:     settings.current_semester ?? 'Current',
      qr_max_duration:      Number(settings.qr_max_duration ?? 60),
      ...settings
    });
  } catch (error) { return next(error); }
});

app.put('/api/admin/settings', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const allowed = ['attendance_threshold', 'academic_year', 'current_semester', 'qr_max_duration'];
    for (const [key, val] of Object.entries(req.body)) {
      if (!allowed.includes(key)) continue;
      const v = String(val).trim();
      if (!v) continue;
      await pool.execute(
        `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = ?`,
        [key, v, v]
      ).catch(() => {}); // table may not exist
    }
    auditLog(req.user.sub, 'admin', 'UPDATE_SETTINGS', null, null, req.body);
    thresholdCache.at = 0;
    return res.json({ message: 'Settings updated.' });
  } catch (error) { return next(error); }
});

// ==========================================
// QR ATTENDANCE
// ==========================================
app.post('/api/qr/generate', authenticate, requireRole('faculty'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const courseId = integerValue(req.body.course_id, 'Course ID', 1);

    // Duration: default 10 minutes, min 10s (0.167min), max 60 minutes
    const rawMinutes = parseFloat(req.body.duration_minutes) || 10;
    const durationMs = Math.min(
      60 * 60_000,              // 60 minutes max
      Math.max(10_000, rawMinutes * 60_000)  // 10 seconds min
    );

    await connection.beginTransaction();
    const [assignments] = await connection.execute(
      `SELECT f.faculty_id FROM faculty f
       JOIN faculty_assignments fa ON fa.faculty_id = f.faculty_id
       WHERE f.user_id = ? AND fa.course_id = ?`,
      [req.user.sub, courseId]
    );
    if (!assignments[0]) { await connection.rollback(); return fail(res, 403, 'You are not assigned to this course.'); }

    await connection.execute('DELETE FROM qr_tokens WHERE expires_at <= NOW()');
    const [session] = await connection.execute(
      'INSERT INTO sessions (course_id, faculty_id, session_date, start_time) VALUES (?, ?, CURDATE(), CURTIME())',
      [courseId, assignments[0].faculty_id]
    );
    const token     = crypto.randomBytes(6).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + durationMs);
    await connection.execute(
      'INSERT INTO qr_tokens (session_id, token, expires_at) VALUES (?, ?, ?)',
      [session.insertId, token, expiresAt]
    );
    await connection.commit();

    auditLog(req.user.sub, 'faculty', 'GENERATE_QR', 'session', session.insertId, { courseId, durationMs });
    return res.status(201).json({ token, session_id: session.insertId, expires_at: expiresAt.toISOString() });
  } catch (error) {
    await connection.rollback();
    return error.message ? fail(res, 400, error.message) : next(error);
  } finally { connection.release(); }
});

app.post('/api/qr/scan', authenticate, requireRole('student'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const token = stringValue(req.body.token).toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(token)) return fail(res, 400, 'Enter a valid 12-character session token.');
    await connection.beginTransaction();
    const [students] = await connection.execute('SELECT student_id FROM students WHERE user_id = ? FOR UPDATE', [req.user.sub]);
    if (!students[0]) { await connection.rollback(); return fail(res, 404, 'Student profile not found.'); }
    const [tokens] = await connection.execute('SELECT session_id FROM qr_tokens WHERE token = ? AND expires_at > NOW() FOR UPDATE', [token]);
    if (!tokens[0]) { await connection.rollback(); return fail(res, 400, 'This token is invalid or has expired.'); }
    const [sessions] = await connection.execute('SELECT course_id FROM sessions WHERE session_id = ?', [tokens[0].session_id]);
    const [enrollments] = await connection.execute('SELECT enrollment_id FROM enrollments WHERE student_id = ? AND course_id = ?', [students[0].student_id, sessions[0].course_id]);
    if (!enrollments[0]) { await connection.rollback(); return fail(res, 403, 'You are not enrolled in this course.'); }
    await connection.execute(
      `INSERT INTO attendance_records (session_id, student_id, status) VALUES (?, ?, 'Present')`,
      [tokens[0].session_id, students[0].student_id]
    );
    await connection.commit();
    auditLog(req.user.sub, 'student', 'SCAN_QR', 'session', tokens[0].session_id);
    return res.json({ message: 'Attendance marked successfully.' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return fail(res, 409, 'Attendance has already been recorded for this session.');
    return next(error);
  } finally { connection.release(); }
});

// ==========================================
// STUDENT APIs
// ==========================================
/* ── Centralized calculation API ── */
app.get('/api/calculate-attendance', authenticate, async (req, res, next) => {
  try {
    let attended = parseInt(req.query.attended);
    let total = parseInt(req.query.total);
    if (isNaN(attended) || isNaN(total) || attended < 0 || total < 0 || attended > total) {
      return fail(res, 400, 'Invalid attendance parameters.');
    }
    const threshold = await getAttendanceThreshold();
    const result = calcThreshold(attended, total, threshold);
    return res.json({ attended, total, ...result });
  } catch (error) { return next(error); }
});


app.get('/api/my-attendance', authenticate, requireRole('student'), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.student_id, s.name,
              COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN se.session_id END) AS attended_classes,
              COUNT(DISTINCT se.session_id) AS total_classes
       FROM students s
       LEFT JOIN enrollments e ON e.student_id = s.student_id
       LEFT JOIN sessions se ON se.course_id = e.course_id
       LEFT JOIN attendance_records ar ON ar.session_id = se.session_id AND ar.student_id = s.student_id
       WHERE s.user_id = ?
       GROUP BY s.student_id, s.name`,
      [req.user.sub]
    );
    const student = rows[0];
    if (!student) return fail(res, 404, 'Student profile not found.');
    const threshold = await getAttendanceThreshold();
    const total = Number(student.total_classes) || 0;
    const attended = Number(student.attended_classes) || 0;
    const overall = calcThreshold(attended, total, threshold);

    const [courseRows] = await pool.execute(
      `SELECT c.course_id, c.course_code, c.course_name,
              COUNT(DISTINCT se.session_id) AS total_classes,
              COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN ar.record_id END) AS attended_classes
       FROM students s
       JOIN enrollments e ON e.student_id = s.student_id
       JOIN courses c ON c.course_id = e.course_id
       LEFT JOIN sessions se ON se.course_id = c.course_id
       LEFT JOIN attendance_records ar ON ar.session_id = se.session_id AND ar.student_id = s.student_id
       WHERE s.user_id = ?
       GROUP BY c.course_id, c.course_code, c.course_name
       ORDER BY c.course_code`,
      [req.user.sub]
    );

    const courses = courseRows.map(c => {
      const ct = Number(c.total_classes), ca = Number(c.attended_classes);
      const thr = calcThreshold(ca, ct, threshold);
      return {
        course_id: c.course_id, course_code: c.course_code, course_name: c.course_name,
        total: ct, attended: ca, absent: ct - ca,
        percentage: thr.percentage, status: thr.status,
        canMiss: thr.canMiss, needToAttend: thr.needToAttend
      };
    });

    return res.json({
      student_id:       student.student_id,
      name:             student.name,
      total_classes:    total,
      attended_classes: attended,
      absent_classes:   total - attended,
      percentage:       overall.percentage,
      status:           overall.status,
      threshold:        threshold,
      can_miss:         overall.canMiss,
      need_to_attend:   overall.needToAttend,
      courses
    });
  } catch (error) { return next(error); }
});

/* ── Student attendance history ── */
app.get('/api/student/attendance-history', authenticate, requireRole('student'), async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(10, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM attendance_records ar
       JOIN students s ON s.student_id = ar.student_id WHERE s.user_id = ?`,
      [req.user.sub]
    );
    const [rows] = await pool.execute(
      `SELECT ar.record_id, ar.status, ar.marked_at,
              se.session_date, se.start_time, se.session_id,
              c.course_code, c.course_name,
              COALESCE(f.name, 'Unknown') AS faculty_name
       FROM attendance_records ar
       JOIN sessions se ON se.session_id = ar.session_id
       JOIN courses c ON c.course_id = se.course_id
       JOIN students s ON s.student_id = ar.student_id
       LEFT JOIN faculty f ON f.faculty_id = se.faculty_id
       WHERE s.user_id = ?
       ORDER BY se.session_date DESC, se.start_time DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [req.user.sub]
    );
    return res.json({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (error) { return next(error); }
});

/* ── Available courses for enrollment ── */
app.get('/api/student/available-courses', authenticate, requireRole('student'), async (req, res, next) => {
  try {
    const [courses] = await pool.execute(
      `SELECT c.course_id, c.course_code, c.course_name FROM courses c
       WHERE c.course_id NOT IN (
         SELECT course_id FROM enrollments e
         JOIN students s ON s.student_id = e.student_id WHERE s.user_id = ?
       )`,
      [req.user.sub]
    );
    return res.json(courses);
  } catch (e) { return next(e); }
});

app.post('/api/student/enroll-course', authenticate, requireRole('student'), async (req, res, next) => {
  try {
    const { course_id, semester } = req.body;
    const [students] = await pool.execute('SELECT student_id FROM students WHERE user_id = ?', [req.user.sub]);
    if (!students[0]) return fail(res, 404, 'Student not found.');
    await pool.execute(
      'INSERT INTO enrollments (student_id, course_id, semester) VALUES (?, ?, ?)',
      [students[0].student_id, course_id, semester || 'Current']
    );
    return res.json({ message: 'Enrolled successfully.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return fail(res, 409, 'Already enrolled in this course.');
    return next(error);
  }
});

// ==========================================
// FACULTY APIs
// ==========================================
app.get('/api/faculty/courses', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const [courses] = await pool.execute(
      `SELECT c.course_id, c.course_code, c.course_name, fa.semester
       FROM faculty f
       JOIN faculty_assignments fa ON fa.faculty_id = f.faculty_id
       JOIN courses c ON c.course_id = fa.course_id
       WHERE f.user_id = ? ORDER BY c.course_code`,
      [req.user.sub]
    );
    return res.json(courses);
  } catch (error) { return next(error); }
});

app.get('/api/faculty/available-courses', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const [courses] = await pool.execute(
      `SELECT c.course_id, c.course_code, c.course_name FROM courses c
       WHERE c.course_id NOT IN (
         SELECT course_id FROM faculty_assignments fa
         JOIN faculty f ON f.faculty_id = fa.faculty_id WHERE f.user_id = ?
       )`,
      [req.user.sub]
    );
    return res.json(courses);
  } catch (e) { return next(e); }
});

app.post('/api/faculty/assign-course', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const { course_id, semester } = req.body;
    const [faculties] = await pool.execute('SELECT faculty_id FROM faculty WHERE user_id = ?', [req.user.sub]);
    if (!faculties[0]) return fail(res, 404, 'Faculty not found.');
    await pool.execute(
      'INSERT INTO faculty_assignments (faculty_id, course_id, semester) VALUES (?, ?, ?)',
      [faculties[0].faculty_id, course_id, semester || 'Current']
    );
    return res.json({ message: 'Course assigned successfully.' });
  } catch (error) { return next(error); }
});

app.get('/api/faculty/students', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const courseId = parseInt(req.query.course_id);
    const [faculties] = await pool.execute('SELECT faculty_id FROM faculty WHERE user_id = ?', [req.user.sub]);
    if (!faculties[0]) return fail(res, 404, 'Faculty not found.');
    const facultyId = faculties[0].faculty_id;

    if (courseId) {
      const [assignment] = await pool.execute('SELECT * FROM faculty_assignments WHERE faculty_id = ? AND course_id = ?', [facultyId, courseId]);
      if (!assignment.length) return fail(res, 403, 'Unauthorized. Not assigned to this course.');

      const [students] = await pool.execute(
        `SELECT s.student_id, s.name, s.roll_number, s.batch_year, u.email, c.course_id, c.course_code, c.course_name,
         (SELECT COUNT(*) FROM attendance_records ar JOIN sessions ss ON ar.session_id = ss.session_id WHERE ar.student_id = s.student_id AND ss.course_id = e.course_id AND ar.status = 'Present') as present_count,
         (SELECT COUNT(*) FROM sessions ss WHERE ss.course_id = e.course_id) as total_sessions
         FROM students s
         JOIN users u ON s.user_id = u.user_id
         JOIN enrollments e ON s.student_id = e.student_id
         JOIN courses c ON e.course_id = c.course_id
         WHERE e.course_id = ? ORDER BY s.name`,
        [courseId]
      );
      return res.json(students);
    } else {
      const [students] = await pool.execute(
        `SELECT s.student_id, s.name, s.roll_number, s.batch_year, u.email, c.course_id, c.course_code, c.course_name,
         (SELECT COUNT(*) FROM attendance_records ar JOIN sessions ss ON ar.session_id = ss.session_id WHERE ar.student_id = s.student_id AND ss.course_id = e.course_id AND ar.status = 'Present') as present_count,
         (SELECT COUNT(*) FROM sessions ss WHERE ss.course_id = e.course_id) as total_sessions
         FROM students s
         JOIN users u ON s.user_id = u.user_id
         JOIN enrollments e ON s.student_id = e.student_id
         JOIN courses c ON e.course_id = c.course_id
         JOIN faculty_assignments fa ON c.course_id = fa.course_id
         WHERE fa.faculty_id = ? ORDER BY s.name, c.course_code`,
        [facultyId]
      );
      return res.json(students);
    }
  } catch (error) { return next(error); }
});

app.get('/api/faculty/students/:id/details', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const studentId = parseInt(req.params.id);
    const [faculties] = await pool.execute('SELECT faculty_id FROM faculty WHERE user_id = ?', [req.user.sub]);
    if (!faculties[0]) return fail(res, 404, 'Faculty not found.');
    const facultyId = faculties[0].faculty_id;

    // Verify faculty teaches the student in at least one course
    const [authCheck] = await pool.execute(
      `SELECT 1 FROM enrollments e
       JOIN faculty_assignments fa ON e.course_id = fa.course_id
       WHERE e.student_id = ? AND fa.faculty_id = ? LIMIT 1`,
      [studentId, facultyId]
    );
    if (!authCheck.length) return fail(res, 403, 'Unauthorized. Student is not in any of your courses.');

    const [info] = await pool.execute(
      `SELECT s.student_id, s.name, s.roll_number, s.batch_year, u.email
       FROM students s JOIN users u ON s.user_id = u.user_id WHERE s.student_id = ?`,
      [studentId]
    );
    if (!info[0]) return fail(res, 404, 'Student not found.');

    const [courses] = await pool.execute(
      `SELECT c.course_id, c.course_code, c.course_name,
       (SELECT COUNT(*) FROM attendance_records ar JOIN sessions ss ON ar.session_id = ss.session_id WHERE ar.student_id = ? AND ss.course_id = c.course_id AND ar.status = 'Present') as present_count,
       (SELECT COUNT(*) FROM sessions ss WHERE ss.course_id = c.course_id) as total_sessions
       FROM courses c
       JOIN enrollments e ON c.course_id = e.course_id
       JOIN faculty_assignments fa ON c.course_id = fa.course_id
       WHERE e.student_id = ? AND fa.faculty_id = ?`,
      [studentId, studentId, facultyId]
    );

    const [history] = await pool.execute(
      `SELECT ss.session_id, ss.session_date, ss.start_time, c.course_code, ar.status, ar.marked_at, ar.record_id
       FROM attendance_records ar
       JOIN sessions ss ON ar.session_id = ss.session_id
       JOIN courses c ON ss.course_id = c.course_id
       JOIN faculty_assignments fa ON c.course_id = fa.course_id
       WHERE ar.student_id = ? AND fa.faculty_id = ?
       ORDER BY ss.session_date DESC, ss.start_time DESC LIMIT 20`,
      [studentId, facultyId]
    );

    return res.json({ student: info[0], courses, history });
  } catch (error) { return next(error); }
});

app.put('/api/faculty/students/:id', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const studentId = parseInt(req.params.id);
    const { name, roll_number, batch_year } = req.body;
    
    if (!name || !roll_number || !batch_year) return fail(res, 400, 'Name, roll_number, and batch_year are required.');

    const [faculties] = await pool.execute('SELECT faculty_id FROM faculty WHERE user_id = ?', [req.user.sub]);
    if (!faculties[0]) return fail(res, 404, 'Faculty not found.');
    const facultyId = faculties[0].faculty_id;

    // Verify faculty teaches the student
    const [authCheck] = await pool.execute(
      `SELECT 1 FROM enrollments e
       JOIN faculty_assignments fa ON e.course_id = fa.course_id
       WHERE e.student_id = ? AND fa.faculty_id = ? LIMIT 1`,
      [studentId, facultyId]
    );
    if (!authCheck.length) return fail(res, 403, 'Unauthorized to edit this student.');

    // Check duplicate roll number
    const [dup] = await pool.execute('SELECT student_id FROM students WHERE roll_number = ? AND student_id != ?', [roll_number, studentId]);
    if (dup.length) return fail(res, 400, 'Roll number already exists.');

    await pool.execute(
      'UPDATE students SET name = ?, roll_number = ?, batch_year = ? WHERE student_id = ?',
      [name, roll_number, batch_year, studentId]
    );
    
    auditLog(req.user.sub, 'faculty', 'UPDATE_STUDENT', 'student', studentId, { name, roll_number, batch_year });
    return res.json({ message: 'Student updated successfully.' });
  } catch (error) { return next(error); }
});

app.post('/api/faculty/mark-attendance', authenticate, requireRole('faculty'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { course_id, records, date } = req.body;
    if (!course_id || !records || !Array.isArray(records)) return fail(res, 400, 'Invalid data format.');
    const [faculties] = await connection.execute('SELECT faculty_id FROM faculty WHERE user_id = ?', [req.user.sub]);
    if (!faculties[0]) return fail(res, 404, 'Faculty not found.');
    const facultyId = faculties[0].faculty_id;
    
    const [assignment] = await connection.execute('SELECT * FROM faculty_assignments WHERE faculty_id = ? AND course_id = ?', [facultyId, course_id]);
    if (!assignment.length) return fail(res, 403, 'Unauthorized. Not assigned to this course.');

    await connection.beginTransaction();
    const [session] = await connection.execute(
      'INSERT INTO sessions (course_id, faculty_id, session_date, start_time) VALUES (?, ?, ?, CURTIME())',
      [course_id, facultyId, date || new Date().toISOString().split('T')[0]]
    );
    for (const record of records) {
      if (!record.student_id) continue;
      
      const [enroll] = await connection.execute('SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?', [record.student_id, course_id]);
      if (!enroll.length) continue;

      const status = record.status === 'Absent' ? 'Absent' : 'Present';
      await connection.execute(
        'INSERT INTO attendance_records (session_id, student_id, status) VALUES (?, ?, ?)',
        [session.insertId, record.student_id, status]
      );
    }
    await connection.commit();
    return res.json({ message: 'Attendance recorded successfully.' });
  } catch (error) {
    await connection.rollback();
    return next(error);
  } finally { connection.release(); }
});

/* ── View Past Sessions ── */
app.get('/api/faculty/sessions', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const courseId = parseInt(req.query.course_id);
    if (!courseId) return fail(res, 400, 'Course ID required.');
    
    const [faculties] = await pool.execute('SELECT faculty_id FROM faculty WHERE user_id = ?', [req.user.sub]);
    if (!faculties[0]) return fail(res, 404, 'Faculty not found.');
    const facultyId = faculties[0].faculty_id;

    const [assignment] = await pool.execute('SELECT * FROM faculty_assignments WHERE faculty_id = ? AND course_id = ?', [facultyId, courseId]);
    if (!assignment.length) return fail(res, 403, 'Unauthorized. Not assigned to this course.');

    const [sessions] = await pool.execute(
      `SELECT session_id, session_date, start_time 
       FROM sessions WHERE course_id = ? AND faculty_id = ? ORDER BY session_date DESC, start_time DESC`,
      [courseId, facultyId]
    );
    return res.json(sessions);
  } catch (error) { return next(error); }
});

/* ── View Session Attendance ── */
app.get('/api/faculty/sessions/:session_id/attendance', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.session_id);
    const [faculties] = await pool.execute('SELECT faculty_id FROM faculty WHERE user_id = ?', [req.user.sub]);
    if (!faculties[0]) return fail(res, 404, 'Faculty not found.');
    const facultyId = faculties[0].faculty_id;

    const [sessions] = await pool.execute('SELECT course_id FROM sessions WHERE session_id = ? AND faculty_id = ?', [sessionId, facultyId]);
    if (!sessions.length) return fail(res, 403, 'Unauthorized or session not found.');
    
    const courseId = sessions[0].course_id;
    const [assignment] = await pool.execute('SELECT * FROM faculty_assignments WHERE faculty_id = ? AND course_id = ?', [facultyId, courseId]);
    if (!assignment.length) return fail(res, 403, 'Unauthorized. Not assigned to this course.');

    const [records] = await pool.execute(
      `SELECT s.student_id, s.name, s.roll_number, ar.status 
       FROM attendance_records ar
       JOIN students s ON s.student_id = ar.student_id
       WHERE ar.session_id = ? ORDER BY s.name`,
      [sessionId]
    );
    return res.json(records);
  } catch (error) { return next(error); }
});

/* ── Modify Session Attendance ── */
app.put('/api/faculty/sessions/:session_id/attendance', authenticate, requireRole('faculty'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const sessionId = parseInt(req.params.session_id);
    const { records, reason } = req.body;
    if (!records || !Array.isArray(records)) return fail(res, 400, 'Invalid data format.');

    const [faculties] = await connection.execute('SELECT faculty_id FROM faculty WHERE user_id = ?', [req.user.sub]);
    if (!faculties[0]) return fail(res, 404, 'Faculty not found.');
    const facultyId = faculties[0].faculty_id;

    const [sessions] = await connection.execute('SELECT course_id FROM sessions WHERE session_id = ? AND faculty_id = ? FOR UPDATE', [sessionId, facultyId]);
    if (!sessions.length) return fail(res, 403, 'Unauthorized or session not found.');
    const courseId = sessions[0].course_id;
    
    const [assignment] = await connection.execute('SELECT * FROM faculty_assignments WHERE faculty_id = ? AND course_id = ?', [facultyId, courseId]);
    if (!assignment.length) return fail(res, 403, 'Unauthorized. Not assigned to this course.');

    await connection.beginTransaction();
    for (const record of records) {
      if (!record.student_id) continue;
      
      const [enroll] = await connection.execute('SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?', [record.student_id, courseId]);
      if (!enroll.length) continue;

      const status = record.status === 'Absent' ? 'Absent' : 'Present';
      
      // Fetch old status if reason is provided
      let oldStatus = null;
      if (reason) {
        const [oldRec] = await connection.execute('SELECT status FROM attendance_records WHERE session_id = ? AND student_id = ?', [sessionId, record.student_id]);
        if (oldRec.length) oldStatus = oldRec[0].status;
      }
      
      await connection.execute(
        'UPDATE attendance_records SET status = ? WHERE session_id = ? AND student_id = ?',
        [status, sessionId, record.student_id]
      );
      
      if (reason && oldStatus !== status) {
        auditLog(req.user.sub, 'faculty', 'CORRECT_ATTENDANCE', 'attendance', record.student_id, {
          session_id: sessionId,
          course_id: courseId,
          student_id: record.student_id,
          old_status: oldStatus,
          new_status: status,
          reason
        });
      }
    }
    await connection.commit();
    return res.json({ message: 'Attendance updated successfully.' });
  } catch (error) {
    await connection.rollback();
    return next(error);
  } finally { connection.release(); }
});


// ==========================================
// PDF REPORT — Professional A4 University Report
// ==========================================

/* ── Faculty report ── */
app.get('/api/faculty/report/pdf', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const courseId = parseInt(req.query.course_id);
    if (!courseId) return fail(res, 400, 'Course ID required.');
    const [courseInfo] = await pool.execute('SELECT course_code, course_name FROM courses WHERE course_id = ?', [courseId]);
    if (!courseInfo[0]) return fail(res, 404, 'Course not found.');
    const [students] = await pool.execute(
      `SELECT s.name, s.roll_number,
              COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN ar.record_id END) AS attended,
              (SELECT COUNT(*) FROM sessions WHERE course_id = ?) AS total
       FROM students s
       JOIN enrollments e ON s.student_id = e.student_id
       LEFT JOIN attendance_records ar ON ar.student_id = s.student_id AND ar.status = 'Present'
       WHERE e.course_id = ?
       GROUP BY s.student_id, s.name, s.roll_number
       ORDER BY s.name`,
      [courseId, courseId]
    );

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="SATT_Course_${courseInfo[0].course_code}.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#1E3A5F')
       .text('SATT — Student Attendance Threshold Tracker', { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#475569')
       .text('University Attendance Management Portal', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1A2332')
       .text(`COURSE ATTENDANCE REPORT: ${courseInfo[0].course_code}`, { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#475569')
       .text(courseInfo[0].course_name, { align: 'center' });
    doc.moveDown(0.25);
    doc.fontSize(9).fillColor('#94A3B8').text(`Generated: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, { align: 'right' });
    doc.moveTo(50, doc.y + 8).lineTo(545, doc.y + 8).strokeColor('#E2E8F0').stroke();
    doc.moveDown(1);

    // Table header
    const cols = { roll: 50, name: 130, total: 60, attended: 70, absent: 60, pct: 65, status: 80 };
    const startX = 50;
    let y = doc.y;

    const drawRow = (data, isHeader) => {
      const rowH = 20;
      if (isHeader) {
        doc.rect(startX, y, 495, rowH).fill('#1E3A5F');
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#FFFFFF');
      } else {
        if ((data._row % 2) === 0) doc.rect(startX, y, 495, rowH).fill('#F8FAFC');
        doc.fontSize(8).font('Helvetica').fillColor('#1A2332');
      }
      let x = startX + 4;
      [
        [isHeader ? 'ROLL NO' : data.roll, cols.roll],
        [isHeader ? 'STUDENT NAME' : data.name, cols.name],
        [isHeader ? 'TOTAL' : data.total, cols.total],
        [isHeader ? 'ATTENDED' : data.attended, cols.attended],
        [isHeader ? 'ABSENT' : data.absent, cols.absent],
        [isHeader ? 'ATTENDANCE' : data.pct + '%', cols.pct],
        [isHeader ? 'STATUS' : data.status, cols.status],
      ].forEach(([text, w]) => {
        doc.text(String(text), x, y + 6, { width: w - 4, ellipsis: true });
        x += w;
      });
      y += rowH;
    };

    drawRow({}, true);
    students.forEach((s, i) => {
      if (y > 750) {
        doc.addPage();
        y = 50;
        drawRow({}, true);
      }
      const total = Number(s.total), att = Number(s.attended);
      const pct = total > 0 ? ((att / total) * 100).toFixed(1) : 0;
      const status = pct >= 85 ? 'Safe' : pct >= 75 ? 'Near Threshold' : pct >= 60 ? 'At Risk' : total === 0 ? 'No Data' : 'Critical';
      drawRow({ roll: s.roll_number, name: s.name, total, attended: att, absent: total - att, pct, status, _row: i }, false);
    });

    // Footer
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor('#94A3B8')
         .text(`SATT — Student Attendance Threshold Tracker  ·  Page ${i + 1} of ${range.count}`, 50, 805, { align: 'center', width: 495 });
    }
    doc.end();
  } catch (error) { return next(error); }
});

/* ── Student personal PDF report ── */
app.get('/api/student/report/pdf', authenticate, requireRole('student'), async (req, res, next) => {
  try {
    // Fetch student profile
    const [profileRows] = await pool.execute(
      `SELECT s.student_id, s.name, s.roll_number, s.batch_year, u.email
       FROM students s JOIN users u ON u.user_id = s.user_id WHERE s.user_id = ?`,
      [req.user.sub]
    );
    if (!profileRows[0]) return fail(res, 404, 'Student profile not found.');
    const profile = profileRows[0];

    // Overall attendance
    const threshold = await getAttendanceThreshold();
    const [[overallRow]] = await pool.execute(
      `SELECT
         COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN se.session_id END) AS attended,
         COUNT(DISTINCT se.session_id) AS total
       FROM students s
       LEFT JOIN enrollments e ON e.student_id = s.student_id
       LEFT JOIN sessions se ON se.course_id = e.course_id
       LEFT JOIN attendance_records ar ON ar.session_id = se.session_id AND ar.student_id = s.student_id
       WHERE s.student_id = ?`,
      [profile.student_id]
    );
    const totalClasses   = Number(overallRow.total) || 0;
    const attendedClasses = Number(overallRow.attended) || 0;
    const absentClasses  = Math.max(0, totalClasses - attendedClasses);
    const overall        = calcThreshold(attendedClasses, totalClasses, threshold);

    // Course-wise breakdown
    const [courseRows] = await pool.execute(
      `SELECT c.course_id, c.course_code, c.course_name,
              COUNT(DISTINCT se.session_id) AS total_sessions,
              COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN ar.record_id END) AS attended_count
       FROM enrollments e
       JOIN courses c ON c.course_id = e.course_id
       LEFT JOIN sessions se ON se.course_id = c.course_id
       LEFT JOIN attendance_records ar ON ar.session_id = se.session_id AND ar.student_id = e.student_id
       WHERE e.student_id = ?
       GROUP BY c.course_id, c.course_code, c.course_name
       ORDER BY c.course_code`,
      [profile.student_id]
    );

    const coursesData = courseRows.map(c => {
      const t = Number(c.total_sessions), a = Number(c.attended_count);
      const calc = calcThreshold(a, t, threshold);
      return { ...c, total: t, attended: a, absent: t - a, ...calc };
    });

    // ── Build PDF ──────────────────────────────────────────
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const rollNum = profile.roll_number || 'UNKNOWN';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="SATT_Attendance_Report_${rollNum}.pdf"`);
    doc.pipe(res);

    const PAGE_W   = 595 - 100; // usable width
    const NAVY     = '#1E3A5F';
    const SLATE    = '#475569';
    const LIGHT    = '#94A3B8';
    const BORDER   = '#E2E8F0';
    const BG_LIGHT = '#F8FAFC';
    const SUCCESS  = '#16A34A';
    const WARNING  = '#D97706';
    const DANGER   = '#DC2626';

    // ── PAGE 1 ──────────────────────────────────────────────

    // Header banner
    doc.rect(0, 0, 595, 100).fill(NAVY);
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#FFFFFF')
       .text('SATT', 50, 20);
    doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.75)')
       .text('Student Attendance Threshold Tracker', 50, 46);
    doc.fontSize(8).fillColor('rgba(255,255,255,0.55)')
       .text('University Attendance Management Portal', 50, 62);
    // S Logo placeholder
    doc.circle(535, 50, 28).fill('rgba(255,255,255,0.1)').stroke('rgba(255,255,255,0.2)');
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#FFFFFF')
       .text('S', 526, 38, { width: 18, align: 'center' });

    // Report title
    let y = 115;
    doc.fontSize(14).font('Helvetica-Bold').fillColor(NAVY)
       .text('STUDENT ATTENDANCE REPORT', 50, y, { align: 'center', width: PAGE_W });
    y += 20;
    doc.fontSize(9).font('Helvetica').fillColor(LIGHT)
       .text('Academic Attendance Summary', 50, y, { align: 'center', width: PAGE_W });
    y += 20;
    doc.moveTo(50, y).lineTo(545, y).strokeColor(BORDER).lineWidth(1).stroke();
    y += 16;

    // Student information card
    doc.rect(50, y, PAGE_W, 90).fill(BG_LIGHT).stroke(BORDER);
    const infoY = y + 10;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(NAVY).text('STUDENT INFORMATION', 62, infoY);
    const info = [
      ['Student Name', profile.name],
      ['Roll Number',  rollNum],
      ['Email',        profile.email],
      ['Batch / Year', profile.batch_year ? `${profile.batch_year}` : '—'],
      ['Report Generated', new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })],
    ];
    const midX = 50 + PAGE_W / 2;
    info.forEach((pair, i) => {
      const col  = i < 3 ? 0 : 1;
      const row  = i < 3 ? i : i - 3;
      const cx   = col === 0 ? 62 : midX + 8;
      const cy   = infoY + 16 + row * 18;
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(SLATE).text(pair[0] + ':', cx, cy, { width: 90 });
      doc.fontSize(7.5).font('Helvetica').fillColor('#1A2332').text(pair[1], cx + 90, cy, { width: 140, ellipsis: true });
    });
    y += 100;

    // ── Stat boxes (2×2) ────────────────────────────────────
    const boxW = (PAGE_W - 12) / 4;
    const boxH = 60;
    const statData = [
      { label: 'TOTAL CLASSES', value: totalClasses,    color: '#2563EB', bg: '#EFF6FF' },
      { label: 'ATTENDED',      value: attendedClasses, color: SUCCESS,   bg: '#F0FDF4' },
      { label: 'ABSENT',        value: absentClasses,   color: DANGER,    bg: '#FEF2F2' },
      { label: 'ATTENDANCE %',  value: totalClasses === 0 ? '—' : overall.percentage + '%', color: overall.percentage >= threshold ? SUCCESS : DANGER, bg: overall.percentage >= threshold ? '#F0FDF4' : '#FEF2F2' },
    ];
    y += 8;
    statData.forEach((s, i) => {
      const bx = 50 + i * (boxW + 4);
      doc.rect(bx, y, boxW, boxH).fill(s.bg).stroke(BORDER);
      doc.fontSize(7).font('Helvetica-Bold').fillColor(SLATE)
         .text(s.label, bx + 6, y + 8, { width: boxW - 12 });
      doc.fontSize(20).font('Helvetica-Bold').fillColor(s.color)
         .text(String(s.value), bx + 6, y + 22, { width: boxW - 12, align: 'center' });
    });
    y += boxH + 16;

    // ── Attendance Status & Progress Bar ────────────────────
    doc.fontSize(10).font('Helvetica-Bold').fillColor(NAVY).text('ATTENDANCE THRESHOLD ANALYSIS', 50, y);
    y += 16;

    if (totalClasses === 0) {
      doc.rect(50, y, PAGE_W, 50).fill('#FFFBEB').stroke('#FDE68A');
      doc.fontSize(9).font('Helvetica').fillColor(WARNING)
         .text('No attendance records are currently available. Attendance calculation will become available after sessions are recorded.', 62, y + 10, { width: PAGE_W - 24 });
      y += 60;
    } else {
      const statusLabel = { safe: 'SAFE', near_threshold: 'NEAR THRESHOLD', at_risk: 'AT RISK', critical: 'CRITICAL', no_classes: 'NO DATA' }[overall.status] || overall.status;
      const statusColor = overall.status === 'safe' ? SUCCESS : overall.status === 'near_threshold' ? WARNING : DANGER;

      // Status row
      doc.rect(50, y, PAGE_W, 32).fill(BG_LIGHT).stroke(BORDER);
      doc.fontSize(8).font('Helvetica').fillColor(SLATE).text('Required Threshold:', 62, y + 6);
      doc.fontSize(8).font('Helvetica-Bold').fillColor(NAVY).text(threshold + '%', 180, y + 6);
      doc.fontSize(8).font('Helvetica').fillColor(SLATE).text('Current Attendance:', 62, y + 18);
      doc.fontSize(8).font('Helvetica-Bold').fillColor(statusColor).text(overall.percentage + '%', 180, y + 18);
      doc.fontSize(8).font('Helvetica').fillColor(SLATE).text('Status:', 280, y + 6);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(statusColor).text(statusLabel, 340, y + 6);
      y += 40;

      // Progress bar
      const barW = PAGE_W;
      const barH = 14;
      doc.rect(50, y, barW, barH).fill('#E2E8F0').stroke(BORDER);
      const fillW = Math.min(barW, (overall.percentage / 100) * barW);
      doc.rect(50, y, fillW, barH).fill(statusColor);
      // Threshold marker
      const markerX = 50 + (threshold / 100) * barW;
      doc.moveTo(markerX, y - 4).lineTo(markerX, y + barH + 4).strokeColor(NAVY).lineWidth(1.5).stroke();
      doc.fontSize(7).font('Helvetica-Bold').fillColor(NAVY).text(threshold + '%', markerX - 10, y + barH + 6);
      doc.fontSize(7).font('Helvetica').fillColor(LIGHT).text('0%', 50, y + barH + 6);
      doc.fontSize(7).font('Helvetica').fillColor(LIGHT).text('100%', 50 + barW - 22, y + barH + 6);
      y += barH + 22;

      // Recommendation message
      const msgBg  = overall.status === 'safe' ? '#F0FDF4' : overall.status === 'near_threshold' ? '#FFFBEB' : '#FEF2F2';
      const msgBdr = overall.status === 'safe' ? '#BBF7D0' : overall.status === 'near_threshold' ? '#FDE68A' : '#FECACA';
      let msgText;
      if (overall.status === 'safe')
        msgText = `Your attendance is above the required threshold. You can afford to miss up to ${overall.canMiss} more class${overall.canMiss === 1 ? '' : 'es'} while staying above ${threshold}%.`;
      else if (overall.status === 'near_threshold')
        msgText = `Your attendance is just above ${threshold}%. You can miss at most ${overall.canMiss} more class${overall.canMiss === 1 ? '' : 'es'}. Stay cautious.`;
      else
        msgText = `Your attendance is below the required threshold. You must attend ${overall.needToAttend} consecutive class${overall.needToAttend === 1 ? '' : 'es'} to reach ${threshold}%.`;

      doc.rect(50, y, PAGE_W, 30).fill(msgBg).stroke(msgBdr);
      doc.fontSize(8).font('Helvetica').fillColor('#1A2332').text(msgText, 62, y + 9, { width: PAGE_W - 24 });
      y += 38;
    }

    // ── Course-wise table ───────────────────────────────────
    y += 10;
    doc.fontSize(10).font('Helvetica-Bold').fillColor(NAVY).text('COURSE-WISE ATTENDANCE', 50, y);
    y += 14;

    // Table header
    const colDefs = [
      { label: 'CODE',       w: 55 },
      { label: 'COURSE NAME',w: 150 },
      { label: 'TOTAL',      w: 45 },
      { label: 'PRESENT',    w: 50 },
      { label: 'ABSENT',     w: 45 },
      { label: 'ATTENDANCE', w: 65 },
      { label: 'STATUS',     w: 85 },
    ];
    const rowH = 18;
    const headerH = 20;

    const drawTableHeader = (yPos) => {
      doc.rect(50, yPos, PAGE_W, headerH).fill(NAVY);
      let cx = 54;
      colDefs.forEach(col => {
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#FFFFFF')
           .text(col.label, cx, yPos + 6, { width: col.w - 4 });
        cx += col.w;
      });
      return yPos + headerH;
    };

    y = drawTableHeader(y);

    if (!coursesData.length) {
      doc.rect(50, y, PAGE_W, 30).fill(BG_LIGHT);
      doc.fontSize(9).font('Helvetica').fillColor(LIGHT)
         .text('No courses enrolled.', 50, y + 10, { align: 'center', width: PAGE_W });
      y += 30;
    } else {
      coursesData.forEach((c, i) => {
        if (y > 740) {
          doc.addPage();
          y = 50;
          y = drawTableHeader(y);
        }
        if (i % 2 === 0) doc.rect(50, y, PAGE_W, rowH).fill(BG_LIGHT);
        const pctColor = c.percentage >= threshold ? SUCCESS : DANGER;
        const statusLabel = { safe: 'Safe', near_threshold: 'Near Threshold', at_risk: 'At Risk', critical: 'Critical', no_classes: 'No Data' }[c.status] || c.status;
        let cx = 54;
        const cells = [
          [c.course_code, colDefs[0].w, '#1A2332'],
          [c.course_name, colDefs[1].w, '#1A2332'],
          [c.total,       colDefs[2].w, SLATE],
          [c.attended,    colDefs[3].w, SUCCESS],
          [c.absent,      colDefs[4].w, c.absent > 0 ? DANGER : SLATE],
          [c.percentage + '%', colDefs[5].w, pctColor],
          [statusLabel,   colDefs[6].w, pctColor],
        ];
        doc.fontSize(8);
        cells.forEach(([text, w, color]) => {
          doc.font('Helvetica').fillColor(color).text(String(text), cx, y + 5, { width: w - 4, ellipsis: true });
          cx += w;
        });
        // Row border
        doc.moveTo(50, y + rowH).lineTo(545, y + rowH).strokeColor(BORDER).lineWidth(0.5).stroke();
        y += rowH;
      });
    }

    // ── Footer on all pages ─────────────────────────────────
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.moveTo(50, 810).lineTo(545, 810).strokeColor(BORDER).lineWidth(0.5).stroke();
      doc.fontSize(7.5).font('Helvetica').fillColor(LIGHT)
         .text(
           `SATT — Student Attendance Threshold Tracker  ·  Generated electronically  ·  Page ${i + 1} of ${pageCount}`,
           50, 816, { align: 'center', width: PAGE_W }
         );
    }

    doc.end();
  } catch (error) {
    console.error('[PDF Error]', error);
    if (!res.headersSent) return fail(res, 500, 'Unable to generate report. Please try again.');
  }
});

// ==========================================
// PROFILE ROUTES
// ==========================================
app.get('/api/me', authenticate, async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.user_id, u.email, u.role, u.profile_pic, u.status,
              COALESCE(s.name, f.name) AS name,
              s.roll_number, s.batch_year,
              f.employee_id, f.designation
       FROM users u
       LEFT JOIN students s ON s.user_id = u.user_id
       LEFT JOIN faculty  f ON f.user_id = u.user_id
       WHERE u.user_id = ?`,
      [req.user.sub]
    );
    if (!rows[0]) return fail(res, 404, 'User not found.');
    res.json(rows[0]);
  } catch (e) { return next(e); }
});

app.put('/api/profile', authenticate, async (req, res, next) => {
  try {
    const name  = stringValue(req.body.name);
    const email = stringValue(req.body.email).toLowerCase();
    if (!name || name.length < 2)   return fail(res, 400, 'Name must be at least 2 characters.');
    if (!EMAIL_PATTERN.test(email)) return fail(res, 400, 'Please enter a valid email address.');
    const [existing] = await pool.execute('SELECT user_id FROM users WHERE email = ? AND user_id != ?', [email, req.user.sub]);
    if (existing.length) return fail(res, 409, 'That email is already in use.');
    await pool.execute('UPDATE users SET email = ? WHERE user_id = ?', [email, req.user.sub]);
    if (req.user.role === 'student') await pool.execute('UPDATE students SET name = ? WHERE user_id = ?', [name, req.user.sub]).catch(() => {});
    if (req.user.role === 'faculty') await pool.execute('UPDATE faculty  SET name = ? WHERE user_id = ?', [name, req.user.sub]).catch(() => {});
    res.json({ message: 'Profile updated successfully.' });
  } catch (e) { return next(e); }
});

app.put('/api/profile/password', authenticate, async (req, res, next) => {
  try {
    const pw = stringValue(req.body.password);
    if (!pw || pw.length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
    if (pw.length > 128)      return fail(res, 400, 'Password must not exceed 128 characters.');
    const hash = await bcrypt.hash(pw, 12);
    await pool.execute('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, req.user.sub]);
    res.json({ message: 'Password updated successfully.' });
  } catch (e) { return next(e); }
});

app.post('/api/profile/upload-pic', authenticate, upload.single('profile_pic'), async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 400, 'No image file received.');
    const picUrl = '/uploads/' + req.file.filename;
    await pool.execute('UPDATE users SET profile_pic = ? WHERE user_id = ?', [picUrl, req.user.sub]);
    res.json({ message: 'Profile picture updated.', profile_pic: picUrl });
  } catch (e) { return next(e); }
});

// ── Catch-all & error handler ──────────────────────────────
app.use((req, res) => fail(res, 404, 'Resource not found.'));

app.use((error, req, res, next) => {
  console.error('[Server Error]', error.message || error);
  if (res.headersSent) return next(error);
  if (error.message?.includes('Only image files')) return fail(res, 400, error.message);
  return fail(res, 500, 'An unexpected server error occurred.');
});

// ── Start ──────────────────────────────────────────────────
pool.getConnection()
  .then(connection => {
    connection.release();
    app.listen(port, () => console.log(`SAMS listening on http://localhost:${port}`));
  })
  .catch(error => {
    console.error(`Database connection failed: ${error.message}`);
    process.exit(1);
  });
