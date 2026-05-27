const fs = require('fs');
const path = require('path');

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia'
};

const INPUT_FILE = path.join(__dirname, 'states.json');
const OBSIDIAN_DIR = path.join(
  process.env.HOME,
  'Library/Mobile Documents/iCloud~md~obsidian/Documents/Cassianmx/10-Work/Resource Guide'
);

function cleanValue(val) {
  if (typeof val !== 'string') return String(val);
  return val.replace(/\n\s*/g, ' ').trim();
}

function formatFormationFees(data) {
  if (!data) return '';
  const entries = Object.entries(data).filter(([key]) => key !== 'Formation');
  if (entries.length === 0) return '';

  let md = '## Formation Fees\n\n';
  md += '| Entity Type | State Fee | Expedited Fee |\n';
  md += '|-------------|-----------|---------------|\n';
  for (const [type, fees] of entries) {
    md += `| ${type} | ${cleanValue(fees.stateFee)} | ${cleanValue(fees.expeditedFee)} |\n`;
  }
  return md;
}

function formatFormationTimes(data) {
  if (!data) return '';
  let md = '## Formation Times\n\n';
  md += '| Entity Type | Normal | Expedited |\n';
  md += '|-------------|--------|----------|\n';
  for (const [type, times] of Object.entries(data)) {
    md += `| ${type} | ${cleanValue(times.normal)} | ${cleanValue(times.expedited)} |\n`;
  }
  return md;
}

function formatCompanyAddress(data) {
  if (!data) return '';
  let md = '## Company Address Requirements\n\n';
  for (const [question, answer] of Object.entries(data)) {
    const cleanQ = cleanValue(question);
    const cleanA = cleanValue(answer);
    if (cleanQ.includes('LLC') && cleanQ.includes('YES')) continue;
    if (cleanQ.includes('LLC') && cleanQ.includes('NO')) continue;
    md += `- **${cleanQ}**: ${cleanA}\n`;
  }
  return md;
}

function formatMiscFilingFees(data) {
  if (!data) return '';
  let md = '## Miscellaneous Filing Fees\n\n';
  md += '| Service | Bizee | LLC | Corp | Nonprofit |\n';
  md += '|---------|-------|-----|------|-----------|\n';
  for (const [service, fees] of Object.entries(data)) {
    md += `| ${service} | ${cleanValue(fees.bizee)} | ${cleanValue(fees.llc)} | ${cleanValue(fees.corp)} | ${cleanValue(fees.npc)} |\n`;
  }
  return md;
}

function formatMiscFilingServices(data) {
  if (!data) return '';
  let md = '## Miscellaneous Filing Services\n\n';
  md += '| Service | LLC | Corp | Nonprofit |\n';
  md += '|---------|-----|------|-----------|\n';
  for (const [service, avail] of Object.entries(data)) {
    md += `| ${service} | ${cleanValue(avail.llc)} | ${cleanValue(avail.corp)} | ${cleanValue(avail.npc)} |\n`;
  }
  return md;
}

function formatOngoingRequirements(data) {
  if (!data) return '';
  let md = '## Ongoing Filing Requirements\n\n';
  for (const [reqType, info] of Object.entries(data)) {
    if (!info.title) continue;
    md += `### ${reqType}\n`;
    md += `- **Requirement**: ${cleanValue(info.title)}\n`;
    if (info.frequency) md += `- **Frequency**: ${cleanValue(info.frequency)}\n`;
    if (info.dueDate) md += `- **Due Date**: ${cleanValue(info.dueDate)}\n`;
    if (info.stateFee) md += `- **State Fee**: ${cleanValue(info.stateFee)}\n`;
    if (info.filingFee) md += `- **Filing Fee**: ${cleanValue(info.filingFee)}\n`;
    md += '\n';
  }
  return md;
}

function formatMembersDirectorsOfficers(data) {
  if (!data) return '';
  let md = '## Members, Directors & Officers\n\n';
  for (const [role, info] of Object.entries(data)) {
    md += `### ${role}\n`;
    for (const [question, answer] of Object.entries(info)) {
      md += `- **${cleanValue(question)}**: ${cleanValue(answer)}\n`;
    }
    md += '\n';
  }
  return md;
}

function generateStateMd(stateCode, stateData, lastUpdated) {
  const name = STATE_NAMES[stateCode] || stateCode;
  let md = `---\ntags:\n  - resource-guide\n  - state/${stateCode}\nstate: ${stateCode}\nstate_name: ${name}\nlast_updated: ${lastUpdated}\n---\n\n`;
  md += `# ${name} (${stateCode}) — Resource Guide\n\n`;

  md += formatFormationFees(stateData.formationFees) + '\n';
  md += formatFormationTimes(stateData.formationTimes) + '\n';
  md += formatCompanyAddress(stateData.companyAddress) + '\n';
  md += formatMiscFilingFees(stateData.miscFilingFees) + '\n';
  md += formatMiscFilingServices(stateData.miscFilingServices) + '\n';
  md += formatOngoingRequirements(stateData.ongoingFilingRequirements) + '\n';
  md += formatMembersDirectorsOfficers(stateData.membersDirectorsOfficers);

  return md;
}

function generateOverviewMd(stateCount, lastUpdated) {
  let md = `---\ntags:\n  - resource-guide\n  - overview\nlast_updated: ${lastUpdated}\n---\n\n`;
  md += `# Resource Guide Overview\n\n`;
  md += `**Last Updated**: ${new Date(lastUpdated).toLocaleString()}\n`;
  md += `**States Covered**: ${stateCount}\n\n`;
  md += `## States\n\n`;

  const sorted = Object.entries(STATE_NAMES).sort((a, b) => a[1].localeCompare(b[1]));
  for (const [code, name] of sorted) {
    md += `- [[${name}|${name} (${code})]]\n`;
  }
  return md;
}

function syncToObsidian() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error('states.json not found');
    process.exit(1);
  }

  if (!fs.existsSync(OBSIDIAN_DIR)) {
    console.log(`Obsidian directory not found at ${OBSIDIAN_DIR}, skipping sync`);
    return false;
  }

  const data = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8'));
  const { lastUpdated, stateCount, states } = data;

  let written = 0;
  for (const [code, stateData] of Object.entries(states)) {
    const name = STATE_NAMES[code] || code;
    const filePath = path.join(OBSIDIAN_DIR, `${name}.md`);
    const content = generateStateMd(code, stateData, lastUpdated);
    fs.writeFileSync(filePath, content, 'utf-8');
    written++;
  }

  const overviewPath = path.join(OBSIDIAN_DIR, 'Resource Guide Overview.md');
  fs.writeFileSync(overviewPath, generateOverviewMd(stateCount, lastUpdated), 'utf-8');
  written++;

  console.log(`Synced ${written} files to Obsidian Resource Guide`);
  return true;
}

if (require.main === module) {
  syncToObsidian();
}

module.exports = { syncToObsidian, OBSIDIAN_DIR };
