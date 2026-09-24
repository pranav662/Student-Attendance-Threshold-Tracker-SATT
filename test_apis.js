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
  const adminLogin = await req('/login', { email: 'admin@satt.test', password: 'admin123' });
  check('Admin login (200)', adminLogin.status === 200, JSON.stringify(adminLogin.body));
  const adminToken = adminLogin.body.token;
  check('Admin role', adminLogin.body.role === 'admin');

  // 2. Student login
  const stuLogin = await req('/login', { email: '25btce001@satt.test', password: 'admin123' });
  check('Student login (200)', stuLogin.status === 200, JSON.stringify(stuLogin.body));
  const stuToken = stuLogin.body.token;

  // 3. Faculty login
  const facLogin = await req('/login', { email: 'amit.kulkarni@satt.test', password: 'admin123' });
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

  console.log('\n── DEPARTMENT CRUD TEST ──────────────────────────');
  const deptCreate = await req('/api/admin/departments', { dept_code: 'TESTDEPT', dept_name: 'Test Dept' }, 'POST', adminToken);
  check('Admin POST /departments (201)', deptCreate.status === 201 || deptCreate.status === 409, JSON.stringify(deptCreate.body));
  if (deptCreate.status === 201) {
    const deptId = deptCreate.body.dept_id;
    const deptEdit = await req(`/api/admin/departments/${deptId}`, { dept_code: 'TEST2', dept_name: 'Test Dept 2' }, 'PUT', adminToken);
    check('Admin PUT /departments/:id (200)', deptEdit.status === 200, JSON.stringify(deptEdit.body));

    const deptDelete = await req(`/api/admin/departments/${deptId}`, null, 'DELETE', adminToken);
    check('Admin DELETE /departments/:id (200)', deptDelete.status === 200, JSON.stringify(deptDelete.body));
  }

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

  // 13a. Edit Student (Test endpoint existence/auth)
  const editStu = await req('/api/admin/students/99999', { name: 'Test', roll_number: 'T999', batch_year: 2024 }, 'PUT', adminToken);
  check('Admin PUT /students/:id (404/200)', editStu.status === 404 || editStu.status === 200);

  // 13b. Edit Faculty (Test endpoint existence/auth)
  const editFac = await req('/api/admin/faculty/99999', { name: 'Test', employee_id: 'F999', designation: 'Prof' }, 'PUT', adminToken);
  check('Admin PUT /faculty/:id (404/200)', editFac.status === 404 || editFac.status === 200);

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

  // 18a. Dynamic Threshold Test
  await req('/api/admin/settings', { attendance_threshold: 80 }, 'PUT', adminToken);
  const me2 = await req('/api/me', null, 'GET', stuToken);
  check('Threshold dynamically updates to 80', me2.body.threshold === 80);
  await req('/api/admin/settings', { attendance_threshold: 75 }, 'PUT', adminToken);

  console.log('\n── FACULTY APIs ──────────────────────────────────');

  // 19. Faculty courses
  const facCourses = await req('/api/faculty/courses', null, 'GET', facToken);
  check('Faculty /courses (200)', facCourses.status === 200);

  // 20. Faculty available courses
  const facAvail = await req('/api/faculty/available-courses', null, 'GET', facToken);
  check('Faculty /available-courses (200)', facAvail.status === 200);

  // 20a. Faculty students
  const facStudents = await req('/api/faculty/students?course_id=99999', null, 'GET', facToken);
  check('Faculty /students (403/200)', facStudents.status === 403 || facStudents.status === 200);

  // 20b. Faculty sessions
  const facSessions = await req('/api/faculty/sessions?course_id=99999', null, 'GET', facToken);
  check('Faculty /sessions (403/200)', facSessions.status === 403 || facSessions.status === 200);

  // 20c. Faculty session attendance
  const facSessAttn = await req('/api/faculty/sessions/99999/attendance', null, 'GET', facToken);
  check('Faculty /sessions/:id/attendance (403/200)', facSessAttn.status === 403 || facSessAttn.status === 200);

  // 20d. Unauthorized faculty access (Negative Test)
  const unauthFac = await req('/api/faculty/students?course_id=99999', null, 'GET', facToken);
  check('Faculty unauthorized course access (403)', unauthFac.status === 403);
  
  const editUnauthStu = await req('/api/faculty/students/99999', { name: 'Test', roll_number: '123', batch_year: 2024 }, 'PUT', facToken);
  check('Faculty cross-course/semester student edit blocked (403)', editUnauthStu.status === 403 || editUnauthStu.status === 404);

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

  // 22. Faculty PDF (Unauthorized Test)
  const facPdf = await new Promise((resolve) => {
    const r = http.get({ hostname:'localhost', port:3000, path:'/api/faculty/report/pdf?course_id=99999&token=' + facToken }, res => {
      resolve({ status: res.statusCode });
      res.destroy();
    });
    r.on('error', e => resolve({ status: -1 }));
  });
  check('Faculty PDF Unauthorized (403)', facPdf.status === 403);

  console.log('\n── SECURITY VALIDATION ───────────────────────────');
  
  async function testUpload(filename, buffer) {
    return new Promise((resolve) => {
      const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="profile_pic"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`),
        buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);
      const opts = {
        hostname: 'localhost', port: 3000, path: '/api/profile/upload-pic', method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Authorization': 'Bearer ' + stuToken, 'Content-Length': body.length }
      };
      const r = http.request(opts, res => resolve(res.statusCode));
      r.on('error', () => resolve(-1));
      r.write(body);
      r.end();
    });
  }

  // WEBP Test
  const jpegBuf = Buffer.from('FFD8FFE000104A4649460001', 'hex');
  check('Upload valid JPEG (200)', await testUpload('test.jpg', jpegBuf) === 200);
  
  const pngBuf = Buffer.from('89504E470D0A1A0A', 'hex');
  check('Upload valid PNG (200)', await testUpload('test.png', pngBuf) === 200);
  
  const gifBuf = Buffer.from('474946383961', 'hex'); // GIF89a
  check('Upload valid GIF (200)', await testUpload('test.gif', gifBuf) === 200);
  
  const webpBuf = Buffer.from('524946460000000057454250', 'hex'); // RIFF....WEBP
  check('Upload valid WEBP (200)', await testUpload('test.webp', webpBuf) === 200);
  
  const fakeWebpBuf = Buffer.from('524946460000000046414B45', 'hex'); // RIFF....FAKE
  check('Upload fake WEBP (rejected 400)', await testUpload('test.webp', fakeWebpBuf) === 400);
  
  const invalidBuf = Buffer.from('0000000000000000', 'hex');
  check('Upload invalid image (rejected 400)', await testUpload('test.jpg', invalidBuf) === 400);

  console.log(`\n────────────────────────────────────────────────`);
  console.log(`RESULTS: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
