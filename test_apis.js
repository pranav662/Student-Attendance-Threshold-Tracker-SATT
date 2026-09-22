require('dotenv').config();
const http = require('http');

function req(path, body, method, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3000,
      path, method: method || (body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function run() {
  let pass = 0, fail = 0;
  function check(name, cond, detail) {
    if (cond) { console.log(`  ✓ ${name}`); pass++; }
    else       { console.log(`  ✗ ${name}` + (detail ? ` — ${detail}` : '')); fail++; }
  }

  console.log('\n── AUTH ──────────────────────────────────────────');

  // 1. Admin login
  const adminLogin = await req('/login', { email: 'admin@university.edu', password: 'admin123' });
  check('Admin login (200)', adminLogin.status === 200, JSON.stringify(adminLogin.body));
  const adminToken = adminLogin.body.token;
  check('Admin role', adminLogin.body.role === 'admin');

  // 2. Student login
  const stuLogin = await req('/login', { email: 'student@university.edu', password: 'admin123' });
  check('Student login (200)', stuLogin.status === 200, JSON.stringify(stuLogin.body));
  const stuToken = stuLogin.body.token;

  // 3. Faculty login
  const facLogin = await req('/login', { email: 'prof.smith@university.edu', password: 'admin123' });
  check('Faculty login (200)', facLogin.status === 200, JSON.stringify(facLogin.body));
  const facToken = facLogin.body.token;

  console.log('\n── ADMIN APIs ────────────────────────────────────');

  // 4. Stats
  const stats = await req('/api/admin/stats', null, 'GET', adminToken);
  check('Admin /stats (200)', stats.status === 200, JSON.stringify(stats.body));
  check('Stats has students field', typeof stats.body.students !== 'undefined');

  // 5. Students list
  const students = await req('/api/admin/students', null, 'GET', adminToken);
  check('Admin /students (200)', students.status === 200, JSON.stringify(students.body));
  check('Students pagination', typeof students.body.total !== 'undefined');

  // 6. Faculty list
  const faculty = await req('/api/admin/faculty', null, 'GET', adminToken);
  check('Admin /faculty (200)', faculty.status === 200, JSON.stringify(faculty.body));

  // 7. Departments
  const depts = await req('/api/admin/departments', null, 'GET', adminToken);
  check('Admin /departments (200)', depts.status === 200, JSON.stringify(depts.body));

  // 8. Courses
  const courses = await req('/api/admin/courses', null, 'GET', adminToken);
  check('Admin /courses (200)', courses.status === 200, JSON.stringify(courses.body));

  // 9. Settings
  const settings = await req('/api/admin/settings', null, 'GET', adminToken);
  check('Admin /settings (200)', settings.status === 200, JSON.stringify(settings.body));
  check('Settings has threshold', typeof settings.body.attendance_threshold !== 'undefined');

  // 10. At-risk
  const atRisk = await req('/api/admin/at-risk-students', null, 'GET', adminToken);
  check('Admin /at-risk-students (200)', atRisk.status === 200);

  // 11. Audit logs
  const audit = await req('/api/admin/audit-logs', null, 'GET', adminToken);
  check('Admin /audit-logs (200)', audit.status === 200);

  // 12. Monitoring
  const monitor = await req('/api/admin/attendance-monitoring', null, 'GET', adminToken);
  check('Admin /attendance-monitoring (200)', monitor.status === 200);

  // 13. Pending teachers
  const pending = await req('/api/admin/pending-teachers', null, 'GET', adminToken);
  check('Admin /pending-teachers (200)', pending.status === 200);

  // 14. Unauthorized test
  const unauth = await req('/api/admin/stats', null, 'GET', stuToken);
  check('Student blocked from admin stats (403)', unauth.status === 403);

  console.log('\n── STUDENT APIs ──────────────────────────────────');

  // 15. My attendance
  const attn = await req('/api/my-attendance', null, 'GET', stuToken);
  check('Student /my-attendance (200)', attn.status === 200, JSON.stringify(attn.body));
  check('Attendance has courses array', Array.isArray(attn.body.courses));

  // 16. Attendance history
  const hist = await req('/api/student/attendance-history', null, 'GET', stuToken);
  check('Student /attendance-history (200)', hist.status === 200);

  // 17. Available courses
  const avail = await req('/api/student/available-courses', null, 'GET', stuToken);
  check('Student /available-courses (200)', avail.status === 200);

  // 18. Profile
  const me = await req('/api/me', null, 'GET', stuToken);
  check('Student /api/me (200)', me.status === 200);

  console.log('\n── FACULTY APIs ──────────────────────────────────');

  // 19. Faculty courses
  const facCourses = await req('/api/faculty/courses', null, 'GET', facToken);
  check('Faculty /courses (200)', facCourses.status === 200);

  // 20. Faculty available courses
  const facAvail = await req('/api/faculty/available-courses', null, 'GET', facToken);
  check('Faculty /available-courses (200)', facAvail.status === 200);

  console.log('\n── PDF ───────────────────────────────────────────');

  // 21. Student PDF (status code only, skip body)
  const pdf = await new Promise((resolve) => {
    const r = http.get({ hostname:'localhost', port:3000, path:'/api/student/report/pdf?token=' + stuToken }, res => {
      const ct = res.headers['content-type'] || '';
      resolve({ status: res.statusCode, ct });
      res.destroy();
    });
    r.on('error', e => resolve({ status: -1, ct: e.message }));
  });
  check('Student PDF (200)', pdf.status === 200, `content-type: ${pdf.ct}`);
  check('Student PDF content-type', pdf.ct.includes('application/pdf'));

  console.log(`\n────────────────────────────────────────────────`);
  console.log(`RESULTS: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
