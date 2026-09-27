const puppeteer = require('puppeteer');
const fs = require('fs');

async function captureScreenshots() {
    if (!fs.existsSync('docs/screenshots')) {
        fs.mkdirSync('docs/screenshots', { recursive: true });
    }

    const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1280, height: 800 } });
    const page = await browser.newPage();
    
    // Login Page
    await page.goto('http://localhost:3000/');
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: 'docs/screenshots/login.png' });

    // --- Admin ---
    await page.type('#loginEmail', 'admin@satt.test');
    await page.type('#loginPassword', 'admin123');
    await page.click('#loginBtn');
    await page.waitForNavigation();
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'docs/screenshots/admin-dashboard.png' });

    await page.evaluate(() => document.querySelector('button[data-section="students"]').click());
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'docs/screenshots/admin-student-management.png' });

    await page.evaluate(() => document.querySelector('button[data-section="auditlogs"]').click());
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'docs/screenshots/admin-audit-logs.png' });
    
    await page.evaluate(() => SAMS.logout());
    await page.waitForNavigation();
    
    // --- Faculty ---
    await page.type('#loginEmail', 'amit.kulkarni@satt.test');
    await page.type('#loginPassword', 'admin123');
    await page.click('#loginBtn');
    await page.waitForNavigation();
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'docs/screenshots/faculty-live-session.png' });
    
    await page.evaluate(() => document.querySelector('button[data-section="manual"]').click());
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'docs/screenshots/faculty-manual-attendance.png' });
    
    await page.evaluate(() => document.querySelector('button[data-section="courses"]').click());
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'docs/screenshots/faculty-dashboard.png' });
    
    await page.evaluate(() => document.querySelector('button[data-section="sessions"]').click());
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'docs/screenshots/faculty-past-sessions.png' });

    await page.evaluate(() => SAMS.logout());
    await page.waitForNavigation();

    // --- Student ---
    await page.type('#loginEmail', '25btce001@satt.test');
    await page.type('#loginPassword', 'admin123');
    await page.click('#loginBtn');
    await page.waitForNavigation();
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'docs/screenshots/student-dashboard.png' });

    await page.evaluate(() => document.querySelector('button[data-section="history"]').click());
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'docs/screenshots/student-attendance.png' });

    await page.evaluate(() => document.querySelector('button[data-section="threshold"]').click());
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: 'docs/screenshots/student-what-if.png' });

    await browser.close();
    console.log("Screenshots captured!");
}

captureScreenshots().catch(console.error);
