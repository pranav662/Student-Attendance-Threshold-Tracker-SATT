CREATE DATABASE IF NOT EXISTS satt_db_v2;

USE satt_db_v2;

-- I. Identity & Core Users
CREATE TABLE users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255),
    role ENUM('admin', 'faculty', 'student') NOT NULL,
    status ENUM(
        'pending',
        'approved',
        'rejected'
    ) DEFAULT 'approved',
    profile_pic VARCHAR(255),
    sso_id VARCHAR(255) UNIQUE
);

CREATE TABLE departments (
    dept_id INT AUTO_INCREMENT PRIMARY KEY,
    dept_name VARCHAR(255) NOT NULL,
    dept_code VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE students (
    student_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    roll_number VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    batch_year INT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE TABLE faculty (
    faculty_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    employee_id VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    designation VARCHAR(100),
    FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
);

-- II. Academic Structure & Mappings
CREATE TABLE courses (
    course_id INT AUTO_INCREMENT PRIMARY KEY,
    dept_id INT NOT NULL,
    course_code VARCHAR(50) NOT NULL UNIQUE,
    course_name VARCHAR(255) NOT NULL,
    FOREIGN KEY (dept_id) REFERENCES departments (dept_id) ON DELETE CASCADE
);

CREATE TABLE faculty_assignments (
    assignment_id INT AUTO_INCREMENT PRIMARY KEY,
    faculty_id INT NOT NULL,
    course_id INT NOT NULL,
    semester VARCHAR(50) NOT NULL,
    FOREIGN KEY (faculty_id) REFERENCES faculty (faculty_id) ON DELETE CASCADE,
    FOREIGN KEY (course_id) REFERENCES courses (course_id) ON DELETE CASCADE
);

CREATE TABLE enrollments (
    enrollment_id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    course_id INT NOT NULL,
    semester VARCHAR(50) NOT NULL,
    FOREIGN KEY (student_id) REFERENCES students (student_id) ON DELETE CASCADE,
    FOREIGN KEY (course_id) REFERENCES courses (course_id) ON DELETE CASCADE
);

-- III. Core Attendance Engine
CREATE TABLE sessions (
    session_id INT AUTO_INCREMENT PRIMARY KEY,
    course_id INT NOT NULL,
    faculty_id INT NOT NULL,
    session_date DATE NOT NULL,
    start_time TIME NOT NULL,
    FOREIGN KEY (course_id) REFERENCES courses (course_id) ON DELETE CASCADE,
    FOREIGN KEY (faculty_id) REFERENCES faculty (faculty_id) ON DELETE CASCADE
);

CREATE TABLE qr_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    token VARCHAR(50) NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions (session_id) ON DELETE CASCADE
);

CREATE TABLE attendance_records (
    record_id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    student_id INT NOT NULL,
    status ENUM(
        'Present',
        'Absent',
        'Excused'
    ) NOT NULL,
    marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions (session_id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students (student_id) ON DELETE CASCADE,
    UNIQUE (session_id, student_id)
);

CREATE TABLE leave_requests (
    request_id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT,
    document_url VARCHAR(255),
    status ENUM(
        'Pending',
        'Approved',
        'Rejected'
    ) DEFAULT 'Pending',
    FOREIGN KEY (student_id) REFERENCES students (student_id) ON DELETE CASCADE
);

-- ==========================================
-- DUMMY DATA SEEDING (For immediate testing)
-- ==========================================

-- Note: All passwords are hashed versions of 'admin123'

INSERT INTO
    departments (dept_name, dept_code)
VALUES ('Computer Science', 'CSE');

INSERT INTO
    courses (
        dept_id,
        course_code,
        course_name
    )
VALUES (
        1,
        'CS101',
        'Intro to Programming'
    );

-- Insert an Admin
INSERT INTO
    users (email, password_hash, role)
VALUES (
        'admin@university.edu',
        '$2b$12$kcV4YXTiraCPDTxMUbbvROWi28QvVOP.MMJc8tyAIGA0SiFJ7L2Ue',
        'admin'
    );

-- Insert a Faculty
INSERT INTO
    users (email, password_hash, role)
VALUES (
        'prof.smith@university.edu',
        '$2b$12$kcV4YXTiraCPDTxMUbbvROWi28QvVOP.MMJc8tyAIGA0SiFJ7L2Ue',
        'faculty'
    );

INSERT INTO
    faculty (
        user_id,
        employee_id,
        name,
        designation
    )
VALUES (
        2,
        'EMP001',
        'Dr. Smith',
        'Professor'
    );

INSERT INTO
    faculty_assignments (
        faculty_id,
        course_id,
        semester
    )
VALUES (1, 1, 'Fall 2026');

-- Insert a Student
INSERT INTO
    users (email, password_hash, role)
VALUES (
        'student@university.edu',
        '$2b$12$kcV4YXTiraCPDTxMUbbvROWi28QvVOP.MMJc8tyAIGA0SiFJ7L2Ue',
        'student'
    );

INSERT INTO
    students (
        user_id,
        roll_number,
        name,
        batch_year
    )
VALUES (3, 'STU001', 'John Doe', 2026);

INSERT INTO
    enrollments (
        student_id,
        course_id,
        semester
    )
VALUES (1, 1, 'Fall 2026');

-- IV. Audit Logging
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
);

-- V. System Settings (key-value store for admin-configurable values)
CREATE TABLE IF NOT EXISTS system_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value VARCHAR(255) NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Default system settings
INSERT INTO
    system_settings (setting_key, setting_value)
VALUES ('attendance_threshold', '75'),
    ('academic_year', '2026'),
    (
        'current_semester',
        'Fall 2026'
    ),
    ('qr_max_duration', '60')
ON DUPLICATE KEY UPDATE
    setting_value = VALUES(setting_value);