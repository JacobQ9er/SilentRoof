#!/usr/bin/env node
/**
 * SilentRoof — LOGIS ePermits Scraper (Puppeteer / headless Chrome)
 *
 * Reads leads from the Hennepin County GIS API, routes each lead to the
 * correct LOGIS city portal, fills the permit search form in a real browser,
 * detects reroof/roof replacement permits, and writes permit-results.json.
 *
 * SETUP (one time):
 *   npm install puppeteer
 *
 * RUN:
 *   node scripts/verify-permits.js                         # all LOGIS-covered leads
 *   node scripts/verify-permits.js --city "EDEN PRAIRIE"   # one city only
 *   node scripts/verify-permits.js --limit 10              # first N leads (good for testing)
 *   node scripts/verify-permits.js --resume                # skip already-checked addresses
 *   node scripts/verify-permits.js --probe "ST. LOUIS PARK" # debug one address interactively
 *   node scripts/verify-permits.js --headed                # show the browser window (debug)
 *
 * OUTPUT:
 *   scripts/permit-results.json  (written after every address, crash-safe)
 *
 * Then click "Load Permit Results" in the SilentRoof dashboard and pick that file.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http  = require('http');
const https = require('https');

// ─── Config ──────────────────────────────────────────────────────────────────

const REROOF_LOOKBACK_YEARS = 10;

const REROOF_KEYWORDS = [
  'reroof', 're-roof', 'roof replacement', 'tear off', 'tearoff',
  'new roof', 'roof recover', 'roofing',
];

const REQUEST_DELAY_MS = 1500; // pause between addresses (ms)
const PAGE_TIMEOUT_MS  = 20000;

const OUTPUT_FILE = path.join(__dirname, 'permit-results.json');

// Hennepin County GIS — same query the dashboard uses
const GIS_URL    = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1/query';
const GIS_PARAMS = "where=BUILD_YR+%3E%3D+'1985'+AND+BUILD_YR+%3C%3D+'2000'+AND+BLDG_MV1+%3E+100000+AND+PR_TYP_CD1+%3C%3E+'R'&outFields=OWNER_NM%2CSITUS_ADDR%2CSITUS_CITY%2CSITUS_ZIP%2CBUILD_YR%2CPR_TYP_CD1%2CBLDG_MV1%2CPID&f=json&resultRecordCount=2000&resultOffset=0";

// ─── LOGIS city routing ───────────────────────────────────────────────────────

// All city codes confirmed directly from LOGIS home page (https://epermits.logis.org/home.aspx)
// Pattern: https://epermits.logis.org/Permits/BuildingPermits.aspx?city=XX
const LOGIS_CITIES = {
  'APPLE VALLEY':   'av',  // confirmed
  'CRYSTAL':        'cy',  // confirmed
  'EDEN PRAIRIE':   'ep',  // confirmed
  'EDINA':          'ed',  // confirmed
  'FARMINGTON':     'fa',  // confirmed
  'GOLDEN VALLEY':  'gv',  // confirmed
  'LE SUEUR':       'ls',  // confirmed
  'MAPLE GROVE':    'mg',  // confirmed
  'MINNETONKA':     'mi',  // confirmed
  'RAMSEY':         'ra',  // confirmed
  'SAVAGE':         'sa',  // confirmed
  'SOUTH ST. PAUL': 'ss',  // confirmed
  'SOUTH ST PAUL':  'ss',  // confirmed
  'ST. LOUIS PARK': 'sl',  // confirmed
  'ST LOUIS PARK':  'sl',  // confirmed
  'WACONIA':        'wa',  // confirmed
  'WHITE BEAR LAKE':'wb',  // confirmed
};

function getLogisUrl(city) {
  const code = LOGIS_CITIES[(city || '').toUpperCase().trim()];
  if (!code) return null;
  return `https://epermits.logis.org/search.aspx?city=${code}`;
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const filterCity = args.includes('--city')  ? args[args.indexOf('--city')  + 1] : null;
const limitCount = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const resumeMode = args.includes('--resume');
const headedMode = args.includes('--headed');
const probeCity  = args.includes('--probe') ? args[args.indexOf('--probe') + 1] : null;

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function parseAddress(fullAddr) {
  const m = fullAddr.trim().match(/^(\d+[A-Za-z]?)\s+(.+)$/);
  if (!m) return { houseNum: '', streetName: fullAddr.trim() };
  return { houseNum: m[1], streetName: m[2].trim() };
}

function isReroofPermit(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return REROOF_KEYWORDS.some(kw => lower.includes(kw));
}

function isWithinLookback(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - REROOF_LOOKBACK_YEARS);
  return d >= cutoff;
}

// ─── Simple HTTP GET (no deps, for GIS API only) ──────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Fetch leads from Hennepin County GIS ────────────────────────────────────

async function fetchLeads() {
  log('Fetching leads from Hennepin County GIS...');
  const raw = await httpGet(`${GIS_URL}?${GIS_PARAMS}`);
  let data;
  try {
    data = JSON.parse(raw);
  } catch(e) {
    throw new Error(`GIS response was not valid JSON. Got: ${raw.slice(0, 200)}`);
  }
  if (data.error) {
    throw new Error(`GIS API error: ${JSON.stringify(data.error)}`);
  }
  if (!data.features) {
    throw new Error(`No features in GIS response. Keys returned: ${Object.keys(data).join(', ')}. Response: ${raw.slice(0, 300)}`);
  }
  const leads = data.features.map(f => {
    const a = f.attributes;
    return {
      pid:           a.PID,
      owner:         a.OWNER_NM,
      address:       (a.SITUS_ADDR || '').trim(),
      city:          (a.SITUS_CITY || '').trim().toUpperCase(),
      zip:           a.SITUS_ZIP,
      yearBuilt:     a.BUILD_YR,
      propertyType:  a.PR_TYP_CD1,
      buildingValue: a.BLDG_MV1,
    };
  });
  log(`Fetched ${leads.length} leads`);
  return leads;
}

// ─── LOGIS permit check via Puppeteer ────────────────────────────────────────

async function checkPermitsForAddress(page, address, city) {
  const url = getLogisUrl(city);
  if (!url) return { status: 'SKIP', reason: `City not on LOGIS: ${city}`, permits: [] };

  const { houseNum, streetName } = parseAddress(address);

  // Confirmed field IDs from LOGIS search.aspx (probed 2026-05-22)
  const HOUSE_ID   = '#b_b_address_txtHouse';
  const STREET_ID  = '#m_m_b_b_address_cboStreet_Input';  // combo box — type to filter
  const SEARCH_ID  = '#b_b_btnSearch';

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT_MS });

    // Fill house number
    await page.waitForSelector(HOUSE_ID, { timeout: 10000 });
    await page.click(HOUSE_ID, { clickCount: 3 });
    await page.type(HOUSE_ID, houseNum);

    // Fill street — it's a Telerik combo box (type-ahead autocomplete)
    // Type the street name, wait for dropdown to appear, then pick the first match
    await page.click(STREET_ID, { clickCount: 3 });
    await page.type(STREET_ID, streetName, { delay: 50 });

    // Wait for autocomplete dropdown to appear (li items in the suggestion list)
    // Telerik combo list typically appears as ul.rcbList > li
    const dropdownAppeared = await page.waitForSelector(
      'ul.rcbList li, .rcbSlide li, [id*="cboStreet_DropDown"] li',
      { timeout: 3000, visible: true }
    ).catch(() => null);

    if (dropdownAppeared) {
      // Click the first suggestion
      await page.click('ul.rcbList li:first-child, .rcbSlide li:first-child, [id*="cboStreet_DropDown"] li:first-child');
      await sleep(300);
    } else {
      // No autocomplete appeared — street may not exist in this city, or field accepts free text
      // Just leave what we typed and proceed
    }

    // Click Search and wait for results
    await page.click(SEARCH_ID);
    await page.waitForNetworkIdle({ timeout: PAGE_TIMEOUT_MS }).catch(() => {});
    await sleep(800); // buffer for JS rendering

    // Check for "no records" text
    const bodyText = await page.evaluate(() => document.body.innerText);
    const bodyLower = bodyText.toLowerCase();
    if (
      bodyLower.includes('no records found') ||
      bodyLower.includes('0 record') ||
      bodyLower.includes('no permits found') ||
      bodyLower.includes('no results')
    ) {
      return { status: 'CLEAR', permits: [] };
    }

    // Parse the results table
    const permits = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const results = [];
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        if (cells.length < 5) continue;
        // Permit numbers look like SL######, BL######, etc.
        if (!/^[A-Z]{1,4}\d{4,}/.test(cells[0])) continue;
        results.push({
          permitNum:   cells[0] || '',
          permitType:  cells[1] || '',
          subType:     cells[2] || '',
          workType:    cells[3] || '',
          description: cells[4] || '',
          address:     cells[5] || '',
          contractor:  cells[6] || '',
          issuedDate:  cells[7] || '',
          appliedDate: cells[8] || '',
        });
      }
      return results;
    });

    if (permits.length === 0) {
      return { status: 'CLEAR', permits: [] };
    }

    // Check for disqualifying reroof permits within lookback window
    const reroofPermits = permits.filter(p =>
      isReroofPermit(p.description) || isReroofPermit(p.subType) || isReroofPermit(p.workType)
    );
    const recentReroof = reroofPermits.filter(p =>
      isWithinLookback(p.issuedDate) || isWithinLookback(p.appliedDate)
    );

    if (recentReroof.length > 0) {
      const p = recentReroof[0];
      return {
        status: 'FLAGGED',
        reason: `${p.subType || p.workType || p.description} — issued ${p.issuedDate || p.appliedDate}`,
        permits,
        reroofPermits: recentReroof,
      };
    }

    if (reroofPermits.length > 0) {
      return {
        status: 'CLEAR',
        note: `Old reroof outside ${REROOF_LOOKBACK_YEARS}yr window: ${reroofPermits[0].description} (${reroofPermits[0].issuedDate})`,
        permits,
      };
    }

    return { status: 'CLEAR', permits };

  } catch (err) {
    return { status: 'ERROR', error: err.message, permits: [] };
  }
}

// ─── Write output ─────────────────────────────────────────────────────────────

function writeOutput(results) {
  const out = {
    generatedAt:   new Date().toISOString(),
    lookbackYears: REROOF_LOOKBACK_YEARS,
    totalChecked:  results.length,
    flagged:       results.filter(r => r.status === 'FLAGGED').length,
    clear:         results.filter(r => r.status === 'CLEAR').length,
    unknown:       results.filter(r => r.status === 'UNKNOWN').length,
    skip:          results.filter(r => r.status === 'SKIP').length,
    errors:        results.filter(r => r.status === 'ERROR').length,
    results,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Check puppeteer is installed
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    console.error('\n❌ Puppeteer not installed. Run this first:\n\n   npm install puppeteer\n');
    process.exit(1);
  }

  log('SilentRoof LOGIS Permit Scraper (Puppeteer)');
  log(`Lookback window: ${REROOF_LOOKBACK_YEARS} years`);
  log(headedMode ? 'Mode: headed (browser visible)' : 'Mode: headless');

  const browser = await puppeteer.launch({
    headless: !headedMode,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // ── Probe mode ──────────────────────────────────────────────────────────────
  if (probeCity) {
    const url = getLogisUrl(probeCity);
    if (!url) {
      log(`"${probeCity}" is not in the LOGIS_CITIES map.`);
      await browser.close();
      return;
    }
    log(`Probe: ${probeCity} → ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT_MS });

    // Check main frame first
    let fields = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input, select, textarea'))
        .filter(el => el.type !== 'hidden')
        .map(el => ({ tag: el.tagName, type: el.type || el.tagName, name: el.name, id: el.id, frame: 'main' }));
    });

    // Also check iframes — LOGIS sometimes embeds the form in an iframe
    const iframes = page.frames();
    for (const frame of iframes) {
      if (frame === page.mainFrame()) continue;
      try {
        const iframeFields = await frame.evaluate(() => {
          return Array.from(document.querySelectorAll('input, select, textarea'))
            .filter(el => el.type !== 'hidden')
            .map(el => ({ tag: el.tagName, type: el.type || el.tagName, name: el.name, id: el.id, frame: 'iframe:' + (document.location.href || '?') }));
        });
        fields = fields.concat(iframeFields);
      } catch(e) { /* cross-origin iframe, skip */ }
    }

    // Also dump page title and URL to confirm we landed on the right page
    const pageTitle = await page.title();
    const pageUrl   = page.url();
    log(`Page title: "${pageTitle}"`);
    log(`Final URL:  ${pageUrl}`);
    log(`\nAll visible form fields (main frame + iframes):`);
    if (fields.length === 0) {
      log('  (none found — page may require login or uses a different structure)');
      // Dump raw HTML snippet for diagnosis
      const snippet = await page.evaluate(() => document.body.innerHTML.slice(0, 2000));
      log('\nPage HTML snippet (first 2000 chars):');
      console.log(snippet);
    }
    for (const f of fields) {
      log(`  [${f.frame}] ${f.tag.padEnd(7)} type=${String(f.type).padEnd(10)} name="${f.name}"   id="${f.id}"`);
    }

    if (headedMode) {
      log('\nBrowser open — press Ctrl+C when done inspecting.');
      await new Promise(() => {}); // keep open
    } else {
      await browser.close();
    }
    return;
  }

  // ── Full run ─────────────────────────────────────────────────────────────────

  // Load existing results if resuming
  let existing = {};
  if (resumeMode && fs.existsSync(OUTPUT_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      for (const r of (prev.results || [])) {
        if (r.status !== 'ERROR') existing[`${r.address}|${r.city}`] = r;
      }
      log(`Resume: ${Object.keys(existing).length} already verified`);
    } catch (e) { log(`Could not load existing results: ${e.message}`); }
  }

  // Fetch leads
  let leads = await fetchLeads();

  if (filterCity) {
    leads = leads.filter(l => l.city === filterCity.toUpperCase().trim());
    log(`Filtered to "${filterCity}": ${leads.length} leads`);
  }

  // Deduplicate by address
  const seen = new Set();
  leads = leads.filter(l => {
    const key = `${l.address}|${l.city}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (limitCount) leads = leads.slice(0, limitCount);

  // Show city breakdown
  const byCityCounts = {};
  for (const l of leads) byCityCounts[l.city] = (byCityCounts[l.city] || 0) + 1;
  log('\nLeads by city:');
  for (const [city, count] of Object.entries(byCityCounts).sort((a, b) => b[1] - a[1])) {
    const onLogis = getLogisUrl(city) ? '✓ LOGIS' : '✗ no API';
    log(`  ${city.padEnd(22)} ${String(count).padStart(3)} leads   ${onLogis}`);
  }
  console.log('');

  const results = [];
  let done = 0, flagged = 0, clear = 0, skipped = 0, noApi = 0;

  for (const lead of leads) {
    const key = `${lead.address}|${lead.city}`;

    if (resumeMode && existing[key]) {
      results.push(existing[key]);
      skipped++;
      continue;
    }

    if (!getLogisUrl(lead.city)) {
      log(`[${done + skipped + noApi + 1}/${leads.length}] SKIP  ${lead.address}, ${lead.city} — not on LOGIS`);
      results.push({ ...lead, checkedAt: new Date().toISOString(), status: 'SKIP', reason: 'City not on LOGIS', permits: [] });
      noApi++;
      writeOutput(results);
      continue;
    }

    done++;
    log(`[${done + skipped + noApi}/${leads.length}] CHECK ${lead.address}, ${lead.city} ${lead.zip || ''}`);

    const result = await checkPermitsForAddress(page, lead.address, lead.city);
    const record = {
      pid: lead.pid, owner: lead.owner, address: lead.address,
      city: lead.city, zip: lead.zip, yearBuilt: lead.yearBuilt,
      checkedAt: new Date().toISOString(),
      ...result,
    };
    results.push(record);

    if (result.status === 'FLAGGED')      { flagged++; log(`  ⛔ FLAGGED — ${result.reason}`); }
    else if (result.status === 'CLEAR')   { clear++;   log(`  ✓ CLEAR${result.note ? ' — ' + result.note : ''}`); }
    else if (result.status === 'UNKNOWN') { log(`  ? UNKNOWN — ${result.error}`); }
    else                                  { log(`  ✗ ERROR — ${result.error}`); }

    writeOutput(results);

    if (done < leads.length - skipped - noApi) await sleep(REQUEST_DELAY_MS);
  }

  await browser.close();

  console.log('\n' + '═'.repeat(60));
  log('COMPLETE');
  log(`Checked:  ${done}`);
  log(`Skipped:  ${skipped} (resumed)`);
  log(`No API:   ${noApi} (city not on LOGIS)`);
  log(`FLAGGED:  ${flagged}  ← move these to Cold`);
  log(`CLEAR:    ${clear}`);
  log(`UNKNOWN:  ${results.filter(r => r.status === 'UNKNOWN').length}`);
  log(`ERROR:    ${results.filter(r => r.status === 'ERROR').length}`);
  log(`\nOutput: ${OUTPUT_FILE}`);
  log('Load that file in the dashboard using "Load Permit Results".');

  if (flagged > 0) {
    console.log('\n⛔ Leads to move to Cold:');
    results.filter(r => r.status === 'FLAGGED').forEach(r =>
      console.log(`   ${r.address}, ${r.city} — ${r.reason}`)
    );
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
