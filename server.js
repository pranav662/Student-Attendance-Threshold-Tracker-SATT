require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${req.user.sub}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const requiredEnvironment = ['DB_HOST', 'DB_USER', 'DB_NAME', 'JWT_SECRET'];
for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const app = express();
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
app.use(express.static(path.join(__dirname, 'public')));

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(res, status, error) { return res.status(status).json({ error }); }
function stringValue(value) { return typeof value === 'string' ? value.trim() : ''; }
function integerValue(value, label, min = 0, max = 1_000_000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
  return number;
}
function issueToken(user) {
  return jwt.sign({ sub: user.user_id, role: user.role, email: user.email, name: user.name }, process.env.JWT_SECRET, { expiresIn: '8h', issuer: 'sams', audience: 'sams-web' });
}
function authenticate(req, res, next) {
  let token = req.query.token;
  if (!token) {
    const authHeader = String(req.headers.authorization || '');
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }
  if (!token) return fail(res, 401, 'Authentication is required.');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'sams', audience: 'sams-web' });
    return next();
  } catch { return fail(res, 401, 'Your session is invalid or expired. Please sign in again.'); }
}
function requireRole(role) {
  return (req, res, next) => req.user.role === role ? next() : fail(res, 403, 'You do not have access to this resource.');
}
function makeRollNumber() { return `STU-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }

// ==========================================
// Attendance Threshold Engine
// ==========================================
const ATTENDANCE_THRESHOLD = 75; // Minimum required attendance %

function calcThreshold(attended, total) {
  const pct = total === 0 ? 0 : Number(((attended / total) * 100).toFixed(2));
  const t = ATTENDANCE_THRESHOLD / 100;
  let status = 'no_classes', canMiss = 0, needToAttend = 0;
  if (total > 0) {
    if (pct >= ATTENDANCE_THRESHOLD) {
      status = pct >= 85 ? 'safe' : 'near_threshold';
      canMiss = Math.max(0, Math.floor((attended - t * total) / t));
    } else {
      status = pct >= 60 ? 'at_risk' : 'critical';
      needToAttend = Math.max(0, Math.ceil((t * total - attended) / (1 - t)));
    }
  }
  return { percentage: pct, status, threshold: ATTENDANCE_THRESHOLD, canMiss, needToAttend };
}

async function createStudent({ email, password, name, batchYear = new Date().getFullYear() }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [user] = await connection.execute('INSERT INTO users (email, password_hash, role, status) VALUES (?, ?, \'student\', \'approved\')', [email, await bcrypt.hash(password, 12)]);
    const [student] = await connection.execute('INSERT INTO students (user_id, roll_number, name, batch_year) VALUES (?, ?, ?, ?)', [user.insertId, makeRollNumber(), name, batchYear]);
    await connection.commit();
    return { userId: user.insertId, studentId: student.insertId };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function createFaculty({ email, password, name, employeeId }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [user] = await connection.execute('INSERT INTO users (email, password_hash, role, status) VALUES (?, ?, \'faculty\', \'pending\')', [email, await bcrypt.hash(password, 12)]);
    const [faculty] = await connection.execute('INSERT INTO faculty (user_id, employee_id, name, designation) VALUES (?, ?, ?, ?)', [user.insertId, employeeId, name, 'Teacher']);
    await connection.commit();
    return { userId: user.insertId, facultyId: faculty.insertId };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

app.post('/register', async (req, res, next) => {
  try {
    const email = stringValue(req.body.email || req.body.username).toLowerCase();
    const password = String(req.body.password || '');
    const name = stringValue(req.body.name);
    const role = req.body.role === 'faculty' ? 'faculty' : 'student';

    if (!EMAIL_PATTERN.test(email)) return fail(res, 400, 'Enter a valid email address.');
    if (password.length < 8 || password.length > 128) return fail(res, 400, 'Password must be 8-128 characters.');
    if (name.length < 2 || name.length > 255) return fail(res, 400, 'Name must be 2-255 characters.');
    
    if (role === 'faculty') {
      const employeeId = 'EMP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      await createFaculty({ email, password, name, employeeId });
      return res.status(201).json({ message: 'Teacher account created. Please wait for admin approval.' });
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
    const email = stringValue(req.body.email || req.body.username).toLowerCase();
    const password = String(req.body.password || '');
    if (!EMAIL_PATTERN.test(email) || !password) return fail(res, 400, 'Email and password are required.');
    const [rows] = await pool.execute('SELECT user_id, email, password_hash, role, status FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) return fail(res, 401, 'Invalid email or password.');
    if (user.status === 'pending') return fail(res, 403, 'Your account is pending admin approval.');
    if (user.status === 'rejected') return fail(res, 403, 'Your account has been rejected.');
    return res.json({ token: issueToken(user), role: user.role });
  } catch (error) { return next(error); }
});

app.get('/api/admin/stats', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const [[students]] = await pool.execute('SELECT COUNT(*) AS count FROM students');
    const [[faculty]] = await pool.execute('SELECT COUNT(*) AS count FROM faculty');
    const [[courses]] = await pool.execute('SELECT COUNT(*) AS count FROM courses');
    return res.json({ students: students.count, faculty: faculty.count, courses: courses.count });
  } catch (error) { return next(error); }
});

app.get('/api/admin/pending-teachers', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const [teachers] = await pool.execute(
      `SELECT u.user_id, u.email, f.name, f.employee_id, u.status 
       FROM users u JOIN faculty f ON u.user_id = f.user_id 
       WHERE u.role = 'faculty' AND u.status = 'pending'`
    );
    return res.json(teachers);
  } catch (error) { return next(error); }
});

app.put('/api/admin/approve-teacher/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) return fail(res, 400, 'Invalid status.');
    await pool.execute('UPDATE users SET status = ? WHERE user_id = ? AND role = \'faculty\'', [status, userId]);
    return res.json({ message: `Teacher account ${status} successfully.` });
  } catch (error) { return next(error); }
});

app.get('/api/faculty/courses', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const [courses] = await pool.execute(
      `SELECT c.course_id, c.course_code, c.course_name, fa.semester
       FROM faculty f JOIN faculty_assignments fa ON fa.faculty_id = f.faculty_id
       JOIN courses c ON c.course_id = fa.course_id WHERE f.user_id = ? ORDER BY c.course_code`,
      [req.user.sub]
    );
    return res.json(courses);
  } catch (error) { return next(error); }
});

app.post('/api/qr/generate', authenticate, requireRole('faculty'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const courseId = integerValue(req.body.course_id, 'Course ID', 1);
    await connection.beginTransaction();
    const [assignments] = await connection.execute(
      `SELECT f.faculty_id FROM faculty f JOIN faculty_assignments fa ON fa.faculty_id = f.faculty_id
       WHERE f.user_id = ? AND fa.course_id = ?`, [req.user.sub, courseId]
    );
    if (!assignments[0]) { await connection.rollback(); return fail(res, 403, 'You are not assigned to this course.'); }
    await connection.execute('DELETE FROM qr_tokens WHERE expires_at <= NOW()');
    const [session] = await connection.execute('INSERT INTO sessions (course_id, faculty_id, session_date, start_time) VALUES (?, ?, CURDATE(), CURTIME())', [courseId, assignments[0].faculty_id]);
    const token = crypto.randomBytes(6).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 30_000);
    await connection.execute('INSERT INTO qr_tokens (session_id, token, expires_at) VALUES (?, ?, ?)', [session.insertId, token, expiresAt]);
    await connection.commit();
    return res.status(201).json({ token, session_id: session.insertId, expires_at: expiresAt.toISOString() });
  } catch (error) {
    await connection.rollback();
    return error.message ? fail(res, 400, error.message) : next(error);
  } finally { connection.release(); }
});

app.get('/api/my-attendance', authenticate, requireRole('student'), async (req, res, next) => {
  try {
    // Overall attendance across all enrolled courses
    const [rows] = await pool.execute(
      `SELECT s.student_id, s.name,
              COUNT(DISTINCT CASE WHEN ar.status = 'Present' THEN ar.record_id END) AS attended_classes,
              (SELECT COUNT(DISTINCT se.session_id) FROM sessions se
               JOIN enrollments e ON e.course_id = se.course_id
               WHERE e.student_id = s.student_id) AS total_classes
       FROM students s
       LEFT JOIN attendance_records ar ON ar.student_id = s.student_id
       WHERE s.user_id = ?
       GROUP BY s.student_id, s.name`,
      [req.user.sub]
    );
    const student = rows[0];
    if (!student) return fail(res, 404, 'Student profile not found.');
    const total = Number(student.total_classes), attended = Number(student.attended_classes);
    const overall = calcThreshold(attended, total);

    // Per-course breakdown with individual threshold calculations
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
      const thr = calcThreshold(ca, ct);
      return {
        course_id: c.course_id, course_code: c.course_code, course_name: c.course_name,
        total: ct, attended: ca, absent: ct - ca,
        percentage: thr.percentage, status: thr.status,
        canMiss: thr.canMiss, needToAttend: thr.needToAttend
      };
    });

    return res.json({
      student_id: student.student_id,
      name: student.name,
      total_classes: total,
      attended_classes: attended,
      absent_classes: total - attended,
      percentage: overall.percentage,
      status: overall.status,
      threshold: ATTENDANCE_THRESHOLD,
      can_miss: overall.canMiss,
      need_to_attend: overall.needToAttend,
      courses
    });
  } catch (error) { return next(error); }
});

app.post('/api/qr/scan', authenticate, requireRole('student'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const token = stringValue(req.body.token).toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(token)) return fail(res, 400, 'Enter a valid live session token.');
    await connection.beginTransaction();
    const [students] = await connection.execute('SELECT student_id FROM students WHERE user_id = ? FOR UPDATE', [req.user.sub]);
    if (!students[0]) { await connection.rollback(); return fail(res, 404, 'Student profile not found.'); }
    const [tokens] = await connection.execute('SELECT session_id FROM qr_tokens WHERE token = ? AND expires_at > NOW() FOR UPDATE', [token]);
    if (!tokens[0]) { await connection.rollback(); return fail(res, 400, 'This token is invalid or expired.'); }
    const [sessions] = await connection.execute('SELECT course_id FROM sessions WHERE session_id = ?', [tokens[0].session_id]);
    const [enrollments] = await connection.execute('SELECT enrollment_id FROM enrollments WHERE student_id = ? AND course_id = ?', [students[0].student_id, sessions[0].course_id]);
    if (!enrollments[0]) { await connection.rollback(); return fail(res, 403, 'You are not enrolled in this course.'); }
    await connection.execute('INSERT INTO attendance_records (session_id, student_id, status) VALUES (?, ?, \'Present\')', [tokens[0].session_id, students[0].student_id]);
    await connection.commit();
    return res.json({ message: 'Attendance marked successfully.' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return fail(res, 409, 'Attendance has already been recorded for this session.');
    return next(error);
  } finally { connection.release(); }
});

// ==========================================
// Profile Management
// ==========================================
// PUT /api/profile is defined below (see profile management section)

app.put('/api/profile/password', authenticate, async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
    const hashedPassword = await bcrypt.hash(password, 12);
    await pool.execute('UPDATE users SET password_hash = ? WHERE user_id = ?', [hashedPassword, req.user.sub]);
    return res.json({ message: 'Password updated successfully.' });
  } catch (error) { return next(error); }
});

app.post('/api/profile/upload-pic', authenticate, upload.single('profile_pic'), async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 400, 'Please provide an image file.');
    const picUrl = `/uploads/${req.file.filename}`;
    await pool.execute('UPDATE users SET profile_pic = ? WHERE user_id = ?', [picUrl, req.user.sub]);
    return res.json({ message: 'Profile picture uploaded.', profile_pic: picUrl });
  } catch (error) { return next(error); }
});

// ==========================================
// Student Course Enrollment
// ==========================================
app.get('/api/student/available-courses', authenticate, requireRole('student'), async (req, res, next) => {
  try {
    const [courses] = await pool.execute(
      `SELECT c.course_id, c.course_code, c.course_name FROM courses c 
       WHERE c.course_id NOT IN (SELECT course_id FROM enrollments e JOIN students s ON s.student_id = e.student_id WHERE s.user_id = ?)`
    , [req.user.sub]);
    return res.json(courses);
  } catch(e) { return next(e); }
});

app.post('/api/student/enroll-course', authenticate, requireRole('student'), async (req, res, next) => {
  try {
    const { course_id, semester } = req.body;
    const [students] = await pool.execute('SELECT student_id FROM students WHERE user_id = ?', [req.user.sub]);
    if (!students[0]) return fail(res, 404, 'Student not found.');
    await pool.execute('INSERT INTO enrollments (student_id, course_id, semester) VALUES (?, ?, ?)', [students[0].student_id, course_id, semester || 'Current']);
    return res.json({ message: 'Enrolled successfully.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return fail(res, 409, 'Already enrolled in this course.');
    return next(error);
  }
});

// ==========================================
// Faculty Course Assignment & Attendance
// ==========================================
app.get('/api/faculty/available-courses', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const [courses] = await pool.execute(
      `SELECT c.course_id, c.course_code, c.course_name FROM courses c 
       WHERE c.course_id NOT IN (SELECT course_id FROM faculty_assignments fa JOIN faculty f ON f.faculty_id = fa.faculty_id WHERE f.user_id = ?)`
    , [req.user.sub]);
    return res.json(courses);
  } catch(e) { return next(e); }
});

app.post('/api/faculty/assign-course', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const { course_id, semester } = req.body;
    const [faculties] = await pool.execute('SELECT faculty_id FROM faculty WHERE user_id = ?', [req.user.sub]);
    if (!faculties[0]) return fail(res, 404, 'Faculty not found.');
    await pool.execute('INSERT INTO faculty_assignments (faculty_id, course_id, semester) VALUES (?, ?, ?)', [faculties[0].faculty_id, course_id, semester || 'Current']);
    return res.json({ message: 'Course assigned successfully.' });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/faculty/students', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const courseId = parseInt(req.query.course_id);
    if (!courseId) return fail(res, 400, 'Course ID required.');
    const [students] = await pool.execute(
      `SELECT s.student_id, s.name, s.roll_number 
       FROM students s JOIN enrollments e ON s.student_id = e.student_id 
       WHERE e.course_id = ?`, [courseId]
    );
    return res.json(students);
  } catch (error) { return next(error); }
});

app.post('/api/faculty/mark-attendance', authenticate, requireRole('faculty'), async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { course_id, student_ids, date } = req.body; // student_ids array of IDs present
    if (!course_id || !student_ids || !Array.isArray(student_ids)) return fail(res, 400, 'Invalid data format.');
    
    const [faculties] = await connection.execute('SELECT faculty_id FROM faculty WHERE user_id = ?', [req.user.sub]);
    if (!faculties[0]) return fail(res, 404, 'Faculty not found.');
    
    await connection.beginTransaction();
    // Create a session for this manual marking
    const [session] = await connection.execute(
      'INSERT INTO sessions (course_id, faculty_id, session_date, start_time) VALUES (?, ?, ?, CURTIME())', 
      [course_id, faculties[0].faculty_id, date || new Date()]
    );
    
    // Mark present for all students in array
    for (const stId of student_ids) {
      await connection.execute('INSERT INTO attendance_records (session_id, student_id, status) VALUES (?, ?, \'Present\')', [session.insertId, stId]);
    }
    
    await connection.commit();
    return res.json({ message: 'Attendance recorded successfully.' });
  } catch (error) {
    await connection.rollback();
    return next(error);
  } finally { connection.release(); }
});

// ==========================================
// PDF Report Generation
// ==========================================
const PDFDocument = require('pdfkit');

app.get('/api/faculty/report/pdf', authenticate, requireRole('faculty'), async (req, res, next) => {
  try {
    const courseId = parseInt(req.query.course_id);
    if (!courseId) return fail(res, 400, 'Course ID required.');
    
    const [courseInfo] = await pool.execute('SELECT course_code, course_name FROM courses WHERE course_id = ?', [courseId]);
    if (!courseInfo[0]) return fail(res, 404, 'Course not found.');

    const [students] = await pool.execute(
      `SELECT s.name, s.roll_number, COUNT(ar.record_id) AS attended, 
       (SELECT COUNT(*) FROM sessions WHERE course_id = ?) AS total
       FROM students s JOIN enrollments e ON s.student_id = e.student_id
       LEFT JOIN attendance_records ar ON ar.student_id = s.student_id AND ar.status = 'Present'
       WHERE e.course_id = ? GROUP BY s.student_id, s.name, s.roll_number`, [courseId, courseId]
    );

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_report_${courseInfo[0].course_code}.pdf"`);
    doc.pipe(res);

    doc.fontSize(20).text(`Attendance Report: ${courseInfo[0].course_name}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('Generated on: ' + new Date().toLocaleDateString(), { align: 'right' });
    doc.moveDown();

    students.forEach(s => {
      const total = Number(s.total);
      const percent = total > 0 ? ((Number(s.attended) / total) * 100).toFixed(1) : 0;
      doc.text(`Roll No: ${s.roll_number} | Name: ${s.name} | Attended: ${s.attended}/${s.total} (${percent}%)`);
      doc.moveDown(0.5);
    });

    doc.end();
  } catch (error) { return next(error); }
});

app.get('/api/student/report/pdf', authenticate, requireRole('student'), async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.student_id, s.name, s.roll_number, COUNT(ar.record_id) AS attended_classes,
       (SELECT COUNT(*) FROM sessions se JOIN enrollments e ON e.course_id = se.course_id WHERE e.student_id = s.student_id) AS total_classes
       FROM students s LEFT JOIN attendance_records ar ON ar.student_id = s.student_id AND ar.status = 'Present'
       WHERE s.user_id = ? GROUP BY s.student_id, s.name, s.roll_number`, [req.user.sub]
    );
    const student = rows[0];
    if (!student) return fail(res, 404, 'Student profile not found.');

    const total = Number(student.total_classes);
    const percent = total > 0 ? ((Number(student.attended_classes) / total) * 100).toFixed(1) : 0;

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="my_attendance_report.pdf"');
    doc.pipe(res);

    doc.fontSize(20).text('Student Attendance Report', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Name: ${student.name}`);
    doc.text(`Roll Number: ${student.roll_number}`);
    doc.moveDown();
    doc.fontSize(16).text(`Total Classes: ${total}`);
    doc.text(`Attended: ${student.attended_classes}`);
    doc.text(`Percentage: ${percent}%`);
    doc.end();
  } catch (error) { return next(error); }
});

// ==========================================
// PROFILE ROUTES
// ==========================================

// GET current user info (name lives in students/faculty, not users)
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
  } catch(e) { return next(e); }
});

// PUT update name/email
app.put('/api/profile', authenticate, async (req, res, next) => {
  try {
    const name  = stringValue(req.body.name);
    const email = stringValue(req.body.email).toLowerCase();
    if (!name || name.length < 2)    return fail(res, 400, 'Name must be at least 2 characters.');
    if (!EMAIL_PATTERN.test(email))  return fail(res, 400, 'Please enter a valid email address.');
    const [existing] = await pool.execute('SELECT user_id FROM users WHERE email = ? AND user_id != ?', [email, req.user.sub]);
    if (existing.length)             return fail(res, 409, 'That email is already in use.');
    // Update email in users; name lives in students/faculty tables
    await pool.execute('UPDATE users SET email = ? WHERE user_id = ?', [email, req.user.sub]);
    if (req.user.role === 'student') await pool.execute('UPDATE students SET name = ? WHERE user_id = ?', [name, req.user.sub]).catch(() => {});
    if (req.user.role === 'faculty') await pool.execute('UPDATE faculty  SET name = ? WHERE user_id = ?', [name, req.user.sub]).catch(() => {});
    res.json({ message: 'Profile updated successfully.' });
  } catch(e) { return next(e); }
});

// PUT change password
app.put('/api/profile/password', authenticate, async (req, res, next) => {
  try {
    const pw = stringValue(req.body.password);
    if (!pw || pw.length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
    const hash = await bcrypt.hash(pw, 12);
    await pool.execute('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, req.user.sub]);
    res.json({ message: 'Password updated successfully.' });
  } catch(e) { return next(e); }
});

// POST upload profile picture
app.post('/api/profile/upload-pic', authenticate, upload.single('profile_pic'), async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 400, 'No image file received.');
    const picUrl = '/uploads/' + req.file.filename;
    await pool.execute('UPDATE users SET profile_pic = ? WHERE user_id = ?', [picUrl, req.user.sub]);
    res.json({ message: 'Profile picture updated.', profile_pic: picUrl });
  } catch(e) { return next(e); }
});

app.use((req, res) => fail(res, 404, 'Resource not found.'));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  return fail(res, 500, 'An unexpected server error occurred.');
});

pool.getConnection()
  .then((connection) => { connection.release(); app.listen(port, () => console.log(`SAMS listening on http://localhost:${port}`)); })
  .catch((error) => { console.error(`Database connection failed: ${error.message}`); process.exit(1); });
