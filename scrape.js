const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
    'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
    'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
    'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
];

const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const OUTPUT_FILE = path.join(__dirname, 'states.json');
const LOGIN_URL = 'https://bizee.tech/login';
const BASE_URL = 'https://bizee.tech/resources-guide/?state=';

const USERNAME = process.env.BIZEE_USERNAME || '';
const PASSWORD = process.env.BIZEE_PASSWORD || '';

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function saveCookies(page) {
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    console.log(`Saved ${cookies.length} cookies to ${COOKIES_FILE}`);
}

async function loadCookies(page) {
    if (!fs.existsSync(COOKIES_FILE)) return false;
    try {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
        await page.setCookie(...cookies);
        console.log(`Loaded ${cookies.length} cookies`);
        return true;
    } catch (e) {
        console.log('Failed to load cookies:', e.message);
        return false;
    }
}

async function login(page, interactive = false) {
    console.log('Navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Check if already logged in (redirected away from login)
    if (!page.url().includes('/login')) {
        console.log('Already logged in');
        return true;
    }

    // Fill login form
    await page.waitForSelector('input[name="username"]', { timeout: 10000 });
    console.log('Found username field, filling form...');
    await page.type('input[name="username"]', USERNAME);
    await page.type('input[name="password"]', PASSWORD);

    // Debug: check what's on the page
    const formDebug = await page.$$eval('button, input[type="submit"]', els => els.map(e => ({ tag: e.tagName, type: e.type, text: e.textContent.trim(), visible: e.offsetParent !== null })));
    console.log('Buttons found:', JSON.stringify(formDebug));

    // Click submit - try multiple selectors
    const submitBtn = await page.$('button[type="submit"]') || await page.$('button.btn-success') || await page.$('button.btn');
    if (!submitBtn) {
        console.log('No submit button found, pressing Enter...');
        await page.keyboard.press('Enter');
    } else {
        await submitBtn.click();
    }
    // Wait for page to change
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    // Extra settle time
    await new Promise(r => setTimeout(r, 2000));

    // Check for verification code page
    const pageContent = await page.content();
    const needsVerification = pageContent.includes('verification') || pageContent.includes('Verification') || pageContent.includes('verify');

    if (needsVerification) {
        if (!interactive) {
            console.log('ERROR: Verification code required. Run with --login flag for interactive mode.');
            return false;
        }

        console.log('\n⚠️  Verification code required!');
        console.log('Check email for code from no-reply@incfile.com');
        console.log('Current URL:', page.url());

        let code;
        const isTTY = process.stdin.isTTY;
        if (process.env.VERIFICATION_CODE) {
            code = process.env.VERIFICATION_CODE;
            console.log('Using verification code from environment variable');
        } else if (!interactive || !isTTY) {
            // In automated mode, wait up to 3 minutes checking for a code file
            console.log('Waiting for verification code... Write it to verification-code.txt');
            const codeFile = path.join(__dirname, 'verification-code.txt');
            // Clean up any old code file
            if (fs.existsSync(codeFile)) fs.unlinkSync(codeFile);
            const maxWait = 180000; // 3 minutes
            const start = Date.now();
            while (Date.now() - start < maxWait) {
                if (fs.existsSync(codeFile)) {
                    code = fs.readFileSync(codeFile, 'utf8').trim();
                    fs.unlinkSync(codeFile);
                    break;
                }
                await new Promise(r => setTimeout(r, 2000));
            }
            if (!code) {
                console.log('Timed out waiting for verification code');
                return false;
            }
        } else {
            code = await prompt('Enter verification code: ');
        }

        // Find the code input — could be various names
        const codeInput = await page.$('input[name="2fa"], input[name="code"], input[name="verification_code"], input[name="otp"], input[type="text"]:not([name="username"]), input[type="number"]');
        if (codeInput) {
            await codeInput.click({ clickCount: 3 });
            await codeInput.type(code.trim());
        } else {
            console.log('Could not find code input, trying all text inputs...');
            const allInputs = await page.$$('input[type="text"]');
            if (allInputs.length > 0) {
                await allInputs[0].click({ clickCount: 3 });
                await allInputs[0].type(code.trim());
            }
        }

        // Click submit — try multiple selectors
        const submitBtn = await page.$('button[type="submit"], input[type="submit"], button.btn, .btn-success, .btn-primary');
        if (submitBtn) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
                submitBtn.click()
            ]);
        } else {
            console.log('Could not find submit button — pressing Enter');
            await page.keyboard.press('Enter');
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        }
    }

    // Check if login succeeded
    const finalUrl = page.url();
    if (finalUrl.includes('/login') || finalUrl.includes('verif')) {
        console.log('Login failed — still on login/verification page:', finalUrl);
        return false;
    }

    console.log('Login successful');
    await saveCookies(page);
    return true;
}

// Extraction function — runs in the browser context (mirrors background.js logic)
async function extractStateData(page) {
    return await page.evaluate(async () => {
        // Wait for dynamic content
        await new Promise(r => setTimeout(r, 3000));

        // Extract formation filing fees
        const feeTable = document.querySelector('#state-filings-content table');
        const formationFees = {};
        if (feeTable) {
            feeTable.querySelectorAll('tr').forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 3) {
                    const entityType = cells[0].textContent.trim();
                    if (entityType && entityType !== 'Formation Filing Fees') {
                        formationFees[entityType] = {
                            stateFee: cells[1].textContent.trim(),
                            expeditedFee: cells[2].textContent.trim()
                        };
                    }
                }
            });
        }

        // Extract formation filing times
        const timeTables = document.querySelectorAll('#state-filings-content table');
        const formationTimes = {};
        if (timeTables.length > 1) {
            timeTables[1].querySelectorAll('tr').forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 3) {
                    const entityType = cells[0].textContent.trim();
                    if (entityType && entityType !== 'Formation Filing Times') {
                        formationTimes[entityType] = {
                            normal: cells[1].textContent.trim(),
                            expedited: cells[2].textContent.trim()
                        };
                    }
                }
            });
        }

        // Extract company address requirements
        const companyAddress = {};
        let processingNestedTable = false;
        if (timeTables.length > 2) {
            const addressTable = timeTables[2];
            addressTable.querySelectorAll('tr').forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 2) {
                    const requirement = cells[0].textContent.trim();
                    if (requirement === 'Company Address required?' || requirement === 'Automatic Articles launch' || requirement === 'NAICS code required?') {
                        const nestedTable = cells[1].querySelector('table');
                        if (nestedTable) {
                            processingNestedTable = true;
                            nestedTable.querySelectorAll('tr').forEach(nestedRow => {
                                const nestedCells = nestedRow.querySelectorAll('td');
                                if (nestedCells.length >= 3) {
                                    const llcText = nestedCells[0].textContent.replace(/\s+/g, ' ').trim();
                                    const corpText = nestedCells[1].textContent.replace(/\s+/g, ' ').trim();
                                    const npcText = nestedCells[2].textContent.replace(/\s+/g, ' ').trim();
                                    const llcValue = nestedCells[0].querySelector('a')?.textContent.trim() || '';
                                    const corpValue = nestedCells[1].querySelector('a')?.textContent.trim() || '';
                                    const npcValue = nestedCells[2].querySelector('a')?.textContent.trim() || '';
                                    companyAddress[requirement] = `${llcText} ${llcValue}: ${corpText} ${corpValue}: ${npcText} ${npcValue}`;
                                }
                            });
                            processingNestedTable = false;
                        }
                    } else if (!processingNestedTable) {
                        const value = cells[1].textContent.trim();
                        const excludedItems = ['Company Address', 'Entities authorized to use a copy of Company Address:', 'Order flows to enable the County validation'];
                        const isDuplicateEntry = (value.includes('LLC') && value.includes('CORPS') && !requirement.includes('launch')) ||
                            (value.includes('LLC') && value.includes('YES') && !requirement.includes('required') && !requirement.includes('launch')) ||
                            (value.includes('LLC YES') && value.includes('CORPS YES') && !requirement.includes('launch')) ||
                            (value.includes('LLC') && value.includes('CORPS') && value.includes('=')) ||
                            (value.includes('LLC') && value.includes('YES') && value.includes('='));
                        if (requirement && !excludedItems.includes(requirement) && !isDuplicateEntry) {
                            companyAddress[requirement] = value;
                        }
                    }
                }
            });
        }

        // Extract misc filing fees
        const miscFilingFees = {};
        const allTables = document.querySelectorAll('table');
        for (let table of allTables) {
            const headerRow = table.querySelector('tr');
            if (headerRow && headerRow.textContent.includes('Misc Filing Fees')) {
                table.querySelectorAll('tr').forEach((row, index) => {
                    if (index === 0) return;
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 5) {
                        const service = cells[0].textContent.trim();
                        if (service) {
                            miscFilingFees[service] = {
                                bizee: cells[1].textContent.trim(),
                                llc: cells[2].textContent.trim(),
                                corp: cells[3].textContent.trim(),
                                npc: cells[4].textContent.trim()
                            };
                        }
                    }
                });
                break;
            }
        }

        // Extract misc filing services
        const miscFilingServices = {};
        for (let table of allTables) {
            const headerRow = table.querySelector('tr');
            if (headerRow && headerRow.textContent.includes('Misc Filing Services')) {
                table.querySelectorAll('tr').forEach((row, index) => {
                    if (index === 0) return;
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 4) {
                        const service = cells[0].textContent.trim();
                        if (service) {
                            miscFilingServices[service] = {
                                llc: cells[1].textContent.trim(),
                                corp: cells[2].textContent.trim(),
                                npc: cells[3].textContent.trim()
                            };
                        }
                    }
                });
                break;
            }
        }

        // Extract ongoing filing requirements
        const ongoingFilingRequirements = {};
        const ongoingForm = document.querySelector('#frmEditOngoingRequirement');
        if (ongoingForm) {
            const ongoingTable = ongoingForm.querySelector('table');
            if (ongoingTable) {
                ongoingTable.querySelectorAll('tr').forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 2) {
                        const entityType = cells[0].textContent.trim();
                        const contentDiv = cells[1].querySelector('.form-control-static .inc_requirement');
                        if (entityType && contentDiv) {
                            const title = contentDiv.querySelector('h3');
                            const paragraphs = contentDiv.querySelectorAll('p');
                            let requirementInfo = { title: title ? title.textContent.trim() : '', frequency: '', dueDate: '', stateFee: '', filingFee: '' };
                            paragraphs.forEach(p => {
                                const text = p.textContent.trim();
                                if (text.includes('Frequency:')) requirementInfo.frequency = text.replace('Frequency:', '').trim();
                                else if (text.includes('Due Date:')) requirementInfo.dueDate = text.replace('Due Date:', '').trim();
                                else if (text.includes('State Fee:')) requirementInfo.stateFee = text.replace('State Fee:', '').trim();
                                else if (text.includes('Filing Fee:')) requirementInfo.filingFee = text.replace('Filing Fee:', '').trim();
                            });
                            ongoingFilingRequirements[entityType] = requirementInfo;
                        }
                    }
                });
            }
        }

        // Extract Members / Directors / Officers
        const membersDirectorsOfficers = { Members: {}, Directors: {}, Officers: {} };
        const allH3s = document.querySelectorAll('h3');
        let mdoHeading = null;
        for (const h of allH3s) {
            if (h.textContent.trim().includes('Members / Directors / Officers')) {
                mdoHeading = h;
                break;
            }
        }
        if (mdoHeading) {
            const headingRow = mdoHeading.closest('tr');
            const mdoTable = headingRow ? headingRow.closest('table') : null;
            if (mdoTable) {
                const allRows = Array.from(mdoTable.querySelectorAll('tr'));
                const startIdx = allRows.indexOf(headingRow);
                let currentCategory = null;
                for (let i = startIdx + 1; i < allRows.length; i++) {
                    const row = allRows[i];
                    if (row.querySelector('h3')) break;
                    const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
                    if (cells.length === 1 && (cells[0] === 'Members' || cells[0] === 'Directors' || cells[0] === 'Officers')) {
                        currentCategory = cells[0];
                    } else if (cells.length === 2 && cells[0] && currentCategory) {
                        membersDirectorsOfficers[currentCategory][cells[0]] = cells[1];
                    }
                }
            }
        }

        return {
            formationFees,
            formationTimes,
            companyAddress,
            miscFilingFees,
            miscFilingServices,
            ongoingFilingRequirements,
            membersDirectorsOfficers
        };
    });
}

async function scrapeAllStates(page) {
    const allData = {};
    const failed = [];

    for (let i = 0; i < STATES.length; i++) {
        const state = STATES[i];
        const progress = `[${i + 1}/${STATES.length}]`;
        console.log(`${progress} Scraping ${state}...`);

        try {
            await page.goto(`${BASE_URL}${state}`, { waitUntil: 'networkidle2', timeout: 30000 });

            // Check if we got redirected to login
            if (page.url().includes('/login')) {
                console.log(`${progress} Session expired — attempting re-login...`);
                const loggedIn = await login(page, false);
                if (!loggedIn) {
                    console.log('Re-login failed. Saving partial data.');
                    break;
                }
                await saveCookies(page);
                await page.goto(`${BASE_URL}${state}`, { waitUntil: 'networkidle2', timeout: 30000 });
            }

            // Check page has content
            const bodyLength = await page.evaluate(() => document.body.textContent.length);
            if (bodyLength < 1000) {
                console.log(`${progress} ${state}: Insufficient content (${bodyLength} chars), skipping`);
                failed.push(state);
                continue;
            }

            const data = await extractStateData(page);
            const sectionCount = Object.values(data).filter(v => Object.keys(v).length > 0).length;
            console.log(`${progress} ${state}: OK (${sectionCount} sections with data)`);
            allData[state] = data;

        } catch (err) {
            console.log(`${progress} ${state}: ERROR — ${err.message}`);
            failed.push(state);
        }
    }

    return { allData, failed };
}

async function main() {
    const isLoginMode = process.argv.includes('--login');
    const isHeadless = !isLoginMode && !process.argv.includes('--headed');

    console.log(`DB+ Data Scraper — ${isLoginMode ? 'Login Mode' : 'Scrape Mode'} (${isHeadless ? 'headless' : 'headed'})`);

    const browser = await puppeteer.launch({
        headless: isHeadless,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: { width: 1280, height: 800 }
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    try {
        // Try loading saved cookies
        const hasCookies = await loadCookies(page);

        if (hasCookies) {
            // Test if cookies are still valid
            console.log('Testing saved session...');
            await page.goto(`${BASE_URL}CA`, { waitUntil: 'networkidle2', timeout: 30000 });

            if (page.url().includes('/login')) {
                console.log('Saved cookies expired — need to login');
                const loggedIn = await login(page, isLoginMode);
                if (!loggedIn) {
                    console.log('Login failed. Exiting.');
                    process.exit(1);
                }
            } else {
                console.log('Saved session is valid');
            }
        } else {
            // No cookies — must login
            const loggedIn = await login(page, isLoginMode);
            if (!loggedIn) {
                console.log('Login failed. Exiting.');
                process.exit(1);
            }
        }

        // Save cookies after successful auth
        await saveCookies(page);

        if (isLoginMode) {
            console.log('\nLogin successful! Cookies saved.');
            console.log('You can now run: npm run scrape');
            await browser.close();
            return;
        }

        // Scrape all states
        const startTime = Date.now();
        const { allData, failed } = await scrapeAllStates(page);
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

        // Build output
        const output = {
            lastUpdated: new Date().toISOString(),
            stateCount: Object.keys(allData).length,
            states: allData
        };

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
        console.log(`\nDone in ${elapsed} minutes`);
        console.log(`States scraped: ${Object.keys(allData).length}/${STATES.length}`);
        if (failed.length > 0) {
            console.log(`Failed: ${failed.join(', ')}`);
        }
        console.log(`Output: ${OUTPUT_FILE}`);

    } catch (err) {
        console.error('Fatal error:', err);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

main();
