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
const GIS_PARAMS = new URLSearchParams({
  where: "BUILD_YR >= '1985' AND BUILD_YR <= '2000' AND BLDG_MV1 > 100000 AND PR_TYP_CD1 <> 'R'",
  outFields: 'OWNER_NM,SITUS_ADDR,SITUS_CITY,SITUS_ZIP,BUILD_YR,PR_TYP_CD1,BLDG_MV1,PID',
  f: 'json',
  resultRecordCount: 2000,
  resultOffset: 0,
}).toString();

// ─── LOGIS city routing ───────────────────────────────────────────────────────

const LOGIS_CITIES = {
  'APPLE VALLEY':   'AppleValley',
  'CRYSTAL':        'Crystal',
  'EDEN PRAIRIE':   'EdenPrairie',
  'EDINA':          'Edina',
  'FARMINGTON':     'Farmington',
  'GOLDEN VALLEY':  'GoldenValley',
  'LE SUEUR':       'LeSueur',
  'MAPLE GROVE':    'MapleGrove',
  'MINNETONKA':     'Minnetonka',
  'RAMSEY':         'Ramsey',
  'SAVAGE':         'Savage',
  'SOUTH ST. PAUL': 'SouthStPaul',
  'SOUTH ST PAUL':  'SouthStPaul',
  'ST. LOUIS PARK': 'StLouisPark',
  'ST LOUIS PARK':  'StLouisPark',
  'WACONIA':        'Waconia',
  'WHITE BEAR LAKE':'WhiteBearLake',
};

function getLogisUrl(city) {
  const cityPath = LOGIS_CITIES[(city || '').toUpperCase().trim()];
  if (!cityPath) return null;
  return `https://epermits.logis.org/ePermits/${cityPath}/Permits/BuildingPermits.aspx`;
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
  const data = JSON.parse(await httpGet(`${GIS_URL}?${GIS_PARAMS}`));
  if (!data.features) throw new Error('No features in GIS response');
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

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT_MS });

    // Find and fill the house number field
    // LOGIS uses ASP.NET WebForms — try common field selectors
    const houseSelectors = [
      'input[name*="HouseNum"]', 'input[id*="HouseNum"]',
      'input[name*="houseNum"]', 'input[id*="houseNum"]',
      'input[name*="HouseNumber"]', 'input[id*="HouseNumber"]',
      'input[name*="Addr"]', 'input[id*="Addr"]',
      'input[name*="txtHouse"]', 'input[id*="txtHouse"]',
    ];
    const streetSelectors = [
      'input[name*="StreetName"]', 'input[id*="StreetName"]',
      'input[name*="streetName"]', 'input[id*="streetName"]',
      'input[name*="Street"]', 'input[id*="Street"]',
      'input[name*="txtStreet"]', 'input[id*="txtStreet"]',
      'select[name*="Street"]', 'select[id*="Street"]',
      'select[name*="StreetName"]', 'select[id*="StreetName"]',
    ];

    // Try each selector until one is found
    let houseField = null;
    for (const sel of houseSelectors) {
      const el = await page.$(sel);
      if (el) { houseField = sel; break; }
    }

    let streetField = null;
    for (const sel of streetSelectors) {
      const el = await page.$(sel);
      if (el) { streetField = sel; break; }
    }

    // If we still can't find fields, dump all inputs for debugging
    if (!houseField || !streetField) {
      const allFields = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input, select, textarea'))
          .filter(el => el.type !== 'hidden')
          .map(el => ({ tag: el.tagName, type: el.type, name: el.name, id: el.id }));
      });
      return {
        status: 'ERROR',
        error: `Could not find form fields. Fields on page: ${JSON.stringify(allFields)}`,
        permits: [],
      };
    }

    // Clear and fill house number
    await page.click(houseField, { clickCount: 3 });
    await page.type(houseField, houseNum);

    // Street name — handle both text input and dropdown
    const streetTag = await page.$eval(streetField, el => el.tagName.toLowerCase());
    if (streetTag === 'select') {
      // Try to select matching option (partial match)
      const selected = await page.evaluate((sel, street) => {
        const el = document.querySelector(sel);
        const options = Array.from(el.options);
        const match = options.find(o => o.text.toUpperCase().includes(street.toUpperCase()));
        if (match) { el.value = match.value; el.dispatchEvent(new Event('change')); return true; }
        return false;
      }, streetField, streetName);
      if (!selected) {
        return { status: 'UNKNOWN', error: `Street "${streetName}" not found in dropdown`, permits: [] };
      }
    } else {
      await page.click(streetField, { clickCount: 3 });
      await page.type(streetField, streetName);
    }

    // Set permit type to Building if dropdown exists
    const permitTypeSelectors = [
      'select[name*="PermitType"]', 'select[id*="PermitType"]',
      'select[name*="permitType"]', 'select[id*="permitType"]',
      'select[name*="ddlPermit"]', 'select[id*="ddlPermit"]',
    ];
    for (const sel of permitTypeSelectors) {
      const el = await page.$(sel);
      if (el) {
        await page.select(sel, 'Building').catch(() => {}); // ignore if "Building" not an option value
        break;
      }
    }

    // Click Search button
    const searchSelectors = [
      'input[value="Search"]', 'button[id*="Search"]', 'input[id*="Search"]',
      'input[value*="Search"]', 'button[value*="Search"]',
      'input[id*="btnSearch"]', 'button[id*="btnSearch"]',
    ];
    let clicked = false;
    for (const sel of searchSelectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); clicked = true; break; }
    }
    if (!clicked) {
      return { status: 'ERROR', error: 'Could not find Search button', permits: [] };
    }

    // Wait for results to load
    await page.waitForNetworkIdle({ timeout: PAGE_TIMEOUT_MS }).catch(() => {});
    await sleep(500); // small buffer for JS rendering

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

    const fields = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input, select, textarea'))
        .filter(el => el.type !== 'hidden')
        .map(el => ({ tag: el.tagName, type: el.type || el.tagName, name: el.name, id: el.id }));
    });

    log(`\nAll visible form fields on "${probeCity}" LOGIS page:`);
    for (const f of fields) {
      log(`  ${f.tag.padEnd(7)} type=${String(f.type).padEnd(10)} name="${f.name}"   id="${f.id}"`);
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
