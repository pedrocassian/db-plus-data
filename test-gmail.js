// Diagnostic: verify Gmail IMAP auth + verification-code extraction work.
// Looks at the last 30 minutes of Incfile emails and prints the extracted code.
//
//   node test-gmail.js
//
// Requires gmail-config.json or GMAIL_USER/GMAIL_APP_PASSWORD to be set.

const { fetchLatestVerificationCode, getGmailConfig } = require('./gmail-imap');

(async () => {
    const cfg = getGmailConfig();
    if (!cfg) {
        console.error('No Gmail config found. Create gmail-config.json or set GMAIL_USER + GMAIL_APP_PASSWORD.');
        process.exit(1);
    }
    console.log(cfg.webAppUrl ? `Calling Apps Script web app...` : `Connecting to Gmail as ${cfg.user} ...`);
    const code = await fetchLatestVerificationCode({
        fromContains: 'incfile.com',
        sinceTs: Date.now() - 30 * 60 * 1000, // last 30 minutes
        timeoutMs: 25000,
        pollIntervalMs: 5000
    });
    if (code) {
        console.log(`✅ Extracted verification code: ${code}`);
        process.exit(0);
    } else {
        console.log('⚠️  No Incfile verification code found in the last 30 minutes.');
        console.log('   (IMAP auth worked if there was no error above — try after triggering a fresh code.)');
        process.exit(2);
    }
})().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
