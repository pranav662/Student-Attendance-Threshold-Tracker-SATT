<<<<<<< HEAD
# Smart Attendance Management System (SAMS)

SAMS is a modern, enterprise-grade web application designed for universities to securely and efficiently track student attendance using real-time QR sessions. 

## 🛠️ Current Technology Stack (MVP)
- **Backend:** Node.js, Express.js
- **Database:** MySQL (using `mysql2` connection pooling)
- **Frontend:** Vanilla HTML, CSS, JavaScript 
- **Security:** bcrypt (password hashing), jsonwebtoken (JWT for session state)

---

## 🏗️ Future Architecture Blueprint (V2)

To handle university-level data with thousands of students, multiple departments, and audit trails, the system is designed to scale into the following architecture:

### Proposed Tech Stack (V2)
- **Frontend:** React.js / Next.js with Tailwind CSS and Framer Motion for a seamless, app-like experience.
- **Mobile:** React Native or Flutter for utilizing native camera (QR scanning) and GPS (Geofencing).
- **Backend API:** Node.js + Express rewritten in **TypeScript** for enterprise stability.
- **Caching:** **Redis** for handling high-throughput 30-second QR tokens preventing database locks.
- **Auth & Security:** **Firebase Auth** or Auth0 for enterprise-grade security and SSO.

---

## 🗄️ Full-Scale Database Architecture (Relational Tables)

The highly normalized MySQL database blueprint supports complete academic tracking:

### 1. Identity & Core Users
| Table Name | Primary Purpose | Key Columns |
| --- | --- | --- |
| **`users`** | Central authentication. | `user_id`, `email`, `password_hash`, `role` (admin/faculty/student), `sso_id` |
| **`students`** | Academic profiles. | `student_id`, `user_id` (FK), `roll_number`, `name`, `batch_year` |
| **`faculty`** | Profiles for teaching staff. | `faculty_id`, `user_id` (FK), `employee_id`, `name`, `designation` |
| **`departments`** | University structure. | `dept_id`, `dept_name`, `dept_code` (e.g., CSE) |

### 2. Academic Structure & Mappings
| Table Name | Primary Purpose | Key Columns |
| --- | --- | --- |
| **`courses`** | Subjects being taught. | `course_id`, `dept_id` (FK), `course_code`, `course_name` |
| **`faculty_assignments`** | Teacher-course mapping. | `assignment_id`, `faculty_id` (FK), `course_id` (FK), `semester` |
| **`enrollments`** | Student-course mapping. | `enrollment_id`, `student_id` (FK), `course_id` (FK), `semester` |

### 3. Core Attendance Engine
| Table Name | Primary Purpose | Key Columns |
| --- | --- | --- |
| **`sessions`** | Records every class instance. | `session_id`, `course_id` (FK), `faculty_id` (FK), `date`, `start_time` |
| **`qr_tokens`** | Live, 30-second expiring codes. | `id`, `session_id` (FK), `token`, `created_at`, `expires_at` |
| **`attendance_records`** | Actual presence status. | `record_id`, `session_id` (FK), `student_id` (FK), `status`, `timestamp` |
| **`leave_requests`** | Medical/official absences. | `request_id`, `student_id` (FK), `start_date`, `end_date`, `reason`, `status` |

---

## 💻 Role-Based Portals (Frontend Web)

To ensure strict separation of concerns, the frontend is divided into distinct portals:

### 1. Public Portal
- **`landing.html`**: University-branded entry page.
- **`login.html`**: Unified login supporting University ID and Google/Microsoft SSO.
- **`reset_password.html`**: Secure password recovery via email.

### 2. Administrator Portal (HODs & IT Dept)
- **`admin_dashboard.html`**: High-level university analytics.
- **`manage_users.html`**: Bulk-upload interface for students and faculty via CSV.
- **`manage_courses.html`**: Course creation and faculty assignment.
- **`audit_reports.html`**: PDF/Excel generation for examination departments.

### 3. Faculty Portal (Professors)
- **`faculty_dashboard.html`**: Daily schedule and low-attendance alerts.
- **`live_session.html`**: Projects regenerating QR code on the classroom screen.
- **`course_roster.html`**: Detailed attendance view per course.
- **`manual_override.html`**: Grid interface for manual attendance marking.
- **`leave_approvals.html`**: Inbox to review and approve student medical certificates.

### 4. Student Portal (Learners)
- **`student_dashboard.html`**: Current standing, subject breakdowns, and Safe/Danger indicators.
- **`submit_attendance.html`**: Mobile-optimized scanner for Faculty QR codes.
- **`impact_simulator.html`**: Predictive calculator testing hypothetical absence scenarios.
- **`apply_leave.html`**: Upload portal for medical/official leave documents.
- **`attendance_history.html`**: Calendar view of all past attendance statuses.

---

## 🚀 MVP Setup Instructions

*(To run the current Version 1 prototype)*

1. Create a `.env` file with `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=satt_db`, and `JWT_SECRET`.
2. Execute `schema.sql` in MySQL.
3. Run `npm install` and `node server.js`.
4. Visit `http://localhost:3000`.
