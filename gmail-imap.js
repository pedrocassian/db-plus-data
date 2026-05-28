// Reads the latest Bizee/Incfile 2FA verification code from Gmail over IMAP.
//
// Auth uses a Google "App Password" (requires 2-Step Verification on the Google
// account) — no OAuth, no Cloud project, no token expiry. Configure via either:
//   - env vars GMAIL_USER + GMAIL_APP_PASSWORD, or
//   - a gitignored gmail-config.json: { "user": "you@gmail.com", "appPassword": "abcd efgh ijkl mnop" }
//
// App Password setup: https://myaccount.google.com/apppasswords

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// imap.gmail.com has IPv6 addresses that may be unreachable on some networks,
// causing Node.js to aggregate-fail the connection. Force IPv4 resolution.
dns.setDefaultResultOrder('ipv4first');

const CONFIG_FILE = path.join(__dirname, 'gmail-config.json');

// Returns config object or null if not configured.
// Supports two strategies:
//   - Apps Script web app: { webAppUrl, webAppToken } (preferred; works even when IMAP is disabled)
//   - Direct IMAP:         { user, appPassword }
function getGmailConfig() {
    // Check env vars first
    const webAppUrl = process.env.GMAIL_WEBAPP_URL;
    if (webAppUrl) {
        return { webAppUrl, webAppToken: process.env.GMAIL_WEBAPP_TOKEN || '' };
    }
    const envUser = process.env.GMAIL_USER;
    const envPass = process.env.GMAIL_APP_PASSWORD;
    if (envUser && envPass) {
        return { user: envUser.trim(), appPassword: envPass.replace(/\s+/g, '') };
    }
    // Fall back to config file
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            if (cfg.webAppUrl) {
                return { webAppUrl: cfg.webAppUrl, webAppToken: cfg.webAppToken || 'dbplus-code-fetcher-2026' };
            }
            if (cfg.user && cfg.appPassword) {
                return { user: String(cfg.user).trim(), appPassword: String(cfg.appPassword).replace(/\s+/g, '') };
            }
        } catch (e) {
            console.log('Failed to read gmail-config.json:', e.message);
        }
    }
    return null;
}

// Pull an N-digit code out of subject/body text. Prefer a digit run that sits
// next to a verification-ish keyword; fall back to the first standalone run.
function extractCode(text, length = 6) {
    if (!text) return null;
    // Incfile body: "...this is your login verification code. Any previously
    // issued codes have been invalidated. 309443". Prefer a digit run that sits
    // close to a verification keyword; fall back to the first standalone run.
    const reNear = new RegExp(
        `(?:verification|verify|security|one[-\\s]?time|access|login|code|invalidated|your)\\D{0,40}(\\d{${length}})`,
        'i'
    );
    const near = text.match(reNear);
    if (near) return near[1];
    const any = text.match(new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`));
    return any ? any[1] : null;
}

async function fetchOnce({ user, appPassword, fromContains, sinceTs, codeLength }) {
    const client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user, pass: appPassword },
        logger: false
    });

    await client.connect();
    let lock;
    try {
        lock = await client.getMailboxLock('INBOX');

        // IMAP SINCE is date-granular, so search a day back then filter by time.
        const sinceDate = new Date(sinceTs - 24 * 3600 * 1000);
        const criteria = { since: sinceDate };
        if (fromContains) criteria.from = fromContains;

        const uids = await client.search(criteria, { uid: true });
        if (!uids || uids.length === 0) return null;

        // Collect candidates (newest first) without downloading full bodies yet.
        const candidates = [];
        for await (const msg of client.fetch(uids.slice(-50), { uid: true, envelope: true, internalDate: true }, { uid: true })) {
            const from = ((msg.envelope && msg.envelope.from) || [])
                .map(a => (a.address || '').toLowerCase()).join(',');
            if (fromContains && !from.includes(fromContains.toLowerCase())) continue;
            const received = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
            if (received < sinceTs - 60 * 1000) continue; // must belong to this login attempt
            candidates.push({ uid: msg.uid, received });
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.received - a.received);

        // Parse newest candidates until we find a code.
        for (const cand of candidates) {
            const full = await client.fetchOne(cand.uid, { source: true }, { uid: true });
            if (!full || !full.source) continue;
            const parsed = await simpleParser(full.source);
            const haystack = `${parsed.subject || ''}\n${parsed.text || ''}`;
            const code = extractCode(haystack, codeLength);
            if (code) return code;
        }
        return null;
    } finally {
        if (lock) lock.release();
        await client.logout().catch(() => {});
    }
}

// Fetch a verification code via a Google Apps Script web app endpoint.
// The endpoint is a doGet() function deployed in the user's own Google account
// (runs as the account owner, so IMAP restrictions don't apply).
async function fetchOnceViaWebApp({ webAppUrl, webAppToken, sinceTs, codeLength }) {
    const url = `${webAppUrl}?token=${encodeURIComponent(webAppToken || '')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.code) return null;
    // Validate the code is fresh (sent after this login attempt)
    if (data.ts && data.ts < sinceTs - 60 * 1000) return null;
    const code = String(data.code);
    return code.length === codeLength ? code : null;
}

// Poll Gmail for a verification code that arrived at/after sinceTs.
// Prefers the Apps Script web app strategy when configured (works even when the
// Workspace admin has disabled IMAP). Falls back to direct IMAP.
async function fetchLatestVerificationCode(opts = {}) {
    const cfg = getGmailConfig();
    if (!cfg) return null;
    const {
        fromContains = 'incfile.com',
        sinceTs = Date.now() - 5 * 60 * 1000,
        timeoutMs = 120000,
        pollIntervalMs = 6000,
        codeLength = 6
    } = opts;

    const useWebApp = !!(cfg.webAppUrl);
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
        attempt++;
        try {
            let code;
            if (useWebApp) {
                code = await fetchOnceViaWebApp({ webAppUrl: cfg.webAppUrl, webAppToken: cfg.webAppToken, sinceTs, codeLength });
            } else {
                code = await fetchOnce({ user: cfg.user, appPassword: cfg.appPassword, fromContains, sinceTs, codeLength });
            }
            if (code) return code;
        } catch (e) {
            console.log(`Gmail check attempt ${attempt} failed: ${e.message}`);
        }
        if (Date.now() < deadline) await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    return null;
}

module.exports = { getGmailConfig, fetchLatestVerificationCode, extractCode };
