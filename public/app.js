/* ============================================================
   SAMS — Shared client utilities
   Auth guard · Fetch wrapper · Toast · Theme toggle · Escape
   ============================================================ */
(function () {
    'use strict';

    const TOKEN_KEY = 'sams_token';
    const THEME_KEY = 'sams_theme';
    const FLASH_KEY = 'sams_flash';

    /* ── Token helpers ──────────────────────────────────────── */
    function getToken()       { return localStorage.getItem(TOKEN_KEY); }
    function setToken(token)  { localStorage.setItem(TOKEN_KEY, token); }

    function requireAuth() {
        const t = getToken();
        if (!t) { window.location.replace('/'); return null; }
        return t;
    }

    function logout(message) {
        localStorage.removeItem(TOKEN_KEY);
        if (message) sessionStorage.setItem(FLASH_KEY, message);
        window.location.replace('/');
    }

    function consumeFlash() {
        const msg = sessionStorage.getItem(FLASH_KEY);
        if (msg) { sessionStorage.removeItem(FLASH_KEY); toast(msg, 'error'); }
    }

    /* ── Toast ─────────────────────────────────────────────── */
    function ensureRegion() {
        let r = document.getElementById('sams-toast-region');
        if (!r) {
            r = document.createElement('div');
            r.id = 'sams-toast-region';
            r.className = 'toast-region';
            r.setAttribute('aria-live', 'polite');
            document.body.appendChild(r);
        }
        return r;
    }

    function toast(msg, type, duration) {
        type     = type     || 'info';
        duration = duration || 4200;
        const region = ensureRegion();
        const el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.textContent = msg;
        region.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 240);
        }, duration);
    }

    /* ── Fetch wrapper ─────────────────────────────────────── */
    async function apiFetch(url, options) {
        options = options || {};
        const token   = getToken();
        const headers = Object.assign({}, options.headers || {});
        if (token)          headers['Authorization']  = 'Bearer ' + token;
        // Auto content-type when sending a JSON string body
        if (typeof options.body === 'string' && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        let res;
        try {
            res = await fetch(url, Object.assign({}, options, { headers }));
        } catch (err) {
            toast('Network error — check your connection.', 'error');
            throw err;
        }
        if (!res.ok) {
            console.error(`API Error: ${options.method || 'GET'} ${url} returned ${res.status} ${res.statusText}`);
        }
        if (res.status === 401) {
            toast(`Session expired (${res.status}). Signing you out…`, 'error');
            setTimeout(() => logout(), 1200);
            throw new Error('unauthorized');
        }
        if (res.status === 403) {
            toast(`Access denied (${res.status}).`, 'error');
            throw new Error('forbidden');
        }
        if (!res.ok && res.status >= 500) {
            toast(`Server error (${res.status}). Please try again later.`, 'error');
        }
        return res;
    }

    /* ── Theme ─────────────────────────────────────────────── */
    function applyTheme(theme) {
        const effective = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', effective);
        const isDark = effective === 'dark';

        document.querySelectorAll('#themeToggle').forEach(btn => {
            btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
            btn.setAttribute('title', isDark ? 'Switch to light mode' : 'Switch to dark mode');
            btn.innerHTML = isDark
                ? '<i data-lucide="sun"></i>'
                : '<i data-lucide="moon"></i>';
        });
        if (window.lucide && typeof lucide.createIcons === 'function') {
            lucide.createIcons();
        }
    }

    function initTheme() {
        const saved = localStorage.getItem(THEME_KEY);
        applyTheme(saved || 'light');

        document.querySelectorAll('#themeToggle').forEach(btn => {
            if (btn.dataset.themeBound === '1') return;
            btn.dataset.themeBound = '1';
            btn.addEventListener('click', () => {
                const current = document.documentElement.getAttribute('data-theme') || 'light';
                const next    = current === 'dark' ? 'light' : 'dark';
                localStorage.setItem(THEME_KEY, next);
                applyTheme(next);
            });
        });
    }

    /* ── Attendance threshold math (mirrors server calcThreshold) ── */
    function calcThreshold(attended, total, threshold) {
        attended = Math.max(0, Number(attended) || 0);
        total    = Math.max(0, Number(total) || 0);
        threshold = Number(threshold);
        if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) threshold = 75;
        const pct = total === 0 ? 0 : Number(((Math.min(attended, total) / total) * 100).toFixed(2));
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
        return { percentage: pct, status, threshold, canMiss, needToAttend, attended, total };
    }

    /* ── Escape HTML ───────────────────────────────────────── */
    function escapeHTML(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /* ── Decode JWT payload (no verification — server does that) */
    function decodeJWT(token) {
        try {
            const payload = token.split('.')[1];
            const padded  = payload + '=='.slice((payload.length + 2) % 4 === 0 ? 0 : (payload.length + 2) % 4);
            return JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
        } catch (e) { return null; }
    }

    /* ── Export ─────────────────────────────────────────────── */
    window.SAMS = {
        getToken, setToken, requireAuth, logout,
        toast, apiFetch, initTheme, consumeFlash,
        escapeHTML, decodeJWT, calcThreshold
    };
})();
