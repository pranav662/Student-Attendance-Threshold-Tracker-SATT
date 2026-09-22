# SATT (Student Attendance Threshold Tracker)

SATT is a centralized, role-based application for tracking and managing university student attendance. It is designed to ensure students meet required attendance thresholds, while empowering faculty with live QR-based attendance tracking and providing administrators with system-wide analytics.

## Technology Stack
- **Backend:** Node.js, Express, MySQL
- **Frontend:** Vanilla HTML, CSS, JavaScript (No heavy frameworks)
- **Security:** JWT authentication, bcrypt password hashing
- **Features:** QRCode.js for live token generation, PDFKit for report generation

## Roles
- **Admin**: Can view system-wide stats, manage students/faculty, configure global settings.
- **Faculty**: Can view their assigned courses, generate live QR sessions for attendance, mark attendance manually, and edit student details within their scope.
- **Student**: Can view their attendance breakdown, calculate what-if scenarios, and scan QR codes to mark themselves present.

## Project Structure
```text
SATT/
├── server.js               # Main Express backend application
├── package.json            # Node.js dependencies
├── schema_v2.sql           # Core database schema
├── database/
│   └── seed.sql            # Realistic synthetic Indian university test dataset
├── test_apis.js            # Automated test suite
├── .env.template           # Template for environment variables
└── public/                 # Frontend assets
    ├── index.html          # Landing / Login page
    ├── app.js              # Global frontend utilities
    ├── styles.css          # Centralized theme and design system
    ├── admin/              # Admin dashboard
    ├── faculty/            # Faculty dashboard
    └── student/            # Student dashboard
```

## Running Locally

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment:**
   Copy `.env.template` to `.env` and fill in your MySQL credentials.
   ```bash
   cp .env.template .env
   ```

3. **Database Setup:**
   Ensure MySQL is running, then create the schema and seed the data:
   ```bash
   mysql -u your_user -p < schema_v2.sql
   mysql -u your_user -p satt_db_v2 < database/seed.sql
   ```

4. **Start the Application:**
   ```bash
   npm start
   ```

## Development Accounts
The `database/seed.sql` script provides synthetic test accounts. **All passwords are `admin123`**.

- **Admin:** `admin@satt.test`
- **Faculty:** `amit.kulkarni@satt.test` (and other synthetic faculty)
- **Student:** `25btce001@satt.test` (and other synthetic students up to `25btce040@satt.test`)

## Running Tests
Ensure the database is seeded and running, then execute:
```bash
npm run check
node test_apis.js
```
