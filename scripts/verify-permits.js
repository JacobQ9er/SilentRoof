#!/usr/bin/env node
/**
 * SilentRoof — LOGIS ePermits Scraper
 *
 * Reads leads from the Hennepin County GIS API (same source as the dashboard),
 * routes each lead to the correct LOGIS city portal, submits an address search,
 * detects reroof/roof replacement permits, and writes permit-results.json.
 *
 * LOGIS participating cities covered:
 *   Apple Valley, Crystal, Eden Prairie, Edina, Farmington, Golden Valley,
 *   Le Sueur, Maple Grove, Minnetonka, Ramsey, Savage, South St. Paul,
 *   St. Louis Park, Waconia, White Bear Lake
 *
 * Run:
 *   node scripts/verify-permits.js                        # all leads
 *   node scripts/verify-permits.js --city "EDEN PRAIRIE"  # one city
 *   node scripts/verify-permits.js --limit 10             # first N leads
 *   node scripts/verify-permits.js --resume               # skip already-checked
 *
 * Output: scripts/permit-results.json
 *
 * No npm packages required — uses Node.js built-ins only.
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const REROOF_LOOKBACK_YEARS = 10;

// Keywords in Description or Sub Type that indicate a roof replacement
const REROOF_KEYWORDS = [
  'reroof', 're-roof', 'roof replacement', 'tear off', 'tearoff',
  'new roof', 'roof recover', 'roofing',
];

const REQUEST_DELAY_MS = 2000; // be polite — 2s between requests

const OUTPUT_FILE = path.join(__dirname, 'permit-results.json');

// Hennepin County GIS — same query the dashboard uses
const GIS_URL = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1/query';
const GIS_PARAMS = {
  where: "BUILD_YR >= '1985' AND BUILD_YR <= '2000' AND BLDG_MV1 > 100000 AND PR_TYP_CD1 <> 'R'",
  outFields: 'OWNER_NM,SITUS_ADDR,SITUS_CITY,SITUS_ZIP,BUILD_YR,PR_TYP_CD1,BLDG_MV1,PID',
  f: 'json',
  resultRecordCount: 2000,
  resultOffset: 0,
};

// ─── LOGIS city routing ───────────────────────────────────────────────────────
//
// Each LOGIS city gets a unique URL path. The pattern is:
//   https://epermits.logis.org/ePermits/{CityPath}/Permits/BuildingPermits.aspx
//
// City paths were identified from the LOGIS home page city list.
// To find the exact path for a city: visit epermits.logis.org, click the city link,
// and note the URL. They typically match the city name with no spaces.
//
// If a city path below is wrong, run:
//   node scripts/verify-permits.js --probe "EDEN PRAIRIE"
// and it will print the redirect URL so you can correct it.

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
  const key = (city || '').toUpperCase().trim();
  const cityPath = LOGIS_CITIES[key];
  if (!cityPath) return null;
  return `https://epermits.logis.org/ePermits/${cityPath}/Permits/BuildingPermits.aspx`;
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filterCity  = args.includes('--city')  ? args[args.indexOf('--city')  + 1] : null;
const limitCount  = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const resumeMode  = args.includes('--resume');
const probeCity   = args.includes('--probe') ? args[args.indexOf('--probe') + 1] : null;

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function parseAddress(fullAddr) {
  // "2170 RIDGE DR" → { houseNum: "2170", streetName: "RIDGE DR" }
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

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

// ─── HTTP helpers (no dependencies) ──────────────────────────────────────────

function request(method, url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const bodyStr = options.body || '';
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
      ...(options.headers || {}),
    };

    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers,
    };

    const req = lib.request(reqOptions, (res) => {
      // Follow redirects (up to 5)
      const redirectCount = (options._redirectCount || 0);
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) && res.headers.location && redirectCount < 5) {
        const loc = res.headers.location;
        const redirectUrl = loc.startsWith('http') ? loc : `${parsed.protocol}//${parsed.hostname}${loc.startsWith('/') ? '' : '/'}${loc}`;
        // After redirect, GET only
        return request('GET', redirectUrl, {
          ...options,
          body: undefined,
          _redirectCount: redirectCount + 1,
        }).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data,
      }));
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timeout')); });

    if (method === 'POST' && bodyStr) req.write(bodyStr);
    req.end();
  });
}

function get(url, headers = {}) {
  return request('GET', url, { headers });
}

function post(url, formFields, headers = {}) {
  const body = Object.entries(formFields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v || '')}`)
    .join('&');
  return request('POST', url, { body, headers });
}

// ─── ASP.NET hidden fields extractor ─────────────────────────────────────────

function extractHiddenFields(html) {
  const fields = {};
  // Match all hidden inputs
  const re = /<input[^>]+type=["']hidden["'][^>]*>/gi;
  const nameRe = /name=["']([^"']+)["']/i;
  const valueRe = /value=["']([^"']*)["']/i;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const nameM = nameRe.exec(tag);
    const valueM = valueRe.exec(tag);
    if (nameM) fields[nameM[1]] = valueM ? valueM[1] : '';
  }
  return fields;
}

// ─── HTML table parser ────────────────────────────────────────────────────────

function parsePermitTable(html) {
  const permits = [];

  // Find the grid/results table — look for rows with permit numbers
  // Permit numbers on LOGIS look like SL######, BL######, etc.
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  const rowRe   = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const stripRe = /<[^>]+>/g;

  let tableMatch;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tableMatch[1];

    // Does this table look like a permit results table?
    if (!/<td/i.test(tableHtml)) continue;

    // Extract rows
    const rows = [];
    let rowMatch;
    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      if (/<th/i.test(rowHtml)) continue; // skip header rows

      const cells = [];
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
        const raw = cellMatch[1].replace(stripRe, '').trim();
        cells.push(decodeHtmlEntities(raw));
      }
      if (cells.length >= 5) rows.push(cells);
    }

    for (const cells of rows) {
      // Column order from LOGIS screenshot:
      // 0: Permit#  1: Permit Type  2: Sub Type  3: Work Type  4: Description
      // 5: Address  6: Contractor   7: Issued Date  8: Applied Date
      // 9: Final Date  10: Expiration Date  11: Cancelled Date  12: ePermit
      const permitNum = cells[0];
      if (!permitNum || !/^[A-Z]{1,4}\d{4,}/.test(permitNum)) continue;

      permits.push({
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

    if (permits.length > 0) break; // found the results table
  }

  return permits;
}

// ─── Extract cookies from response headers ────────────────────────────────────

function extractCookies(headers) {
  const raw = headers['set-cookie'] || [];
  const jar = {};
  for (const c of Array.isArray(raw) ? raw : [raw]) {
    const [pair] = c.split(';');
    const [name, ...rest] = pair.split('=');
    jar[name.trim()] = rest.join('=').trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ─── Query LOGIS for one address ──────────────────────────────────────────────

async function queryLogisAddress(address, city, zip) {
  const searchUrl = getLogisUrl(city);
  if (!searchUrl) {
    return { status: 'SKIP', reason: `City not on LOGIS: ${city}`, permits: [] };
  }

  const { houseNum, streetName } = parseAddress(address);

  try {
    // Step 1: GET page → grab ViewState + ASP.NET session cookie
    const getResp = await get(searchUrl);

    if (getResp.status === 404) {
      return { status: 'ERROR', error: `LOGIS page not found for ${city} — check city path in LOGIS_CITIES map`, permits: [] };
    }
    if (getResp.status !== 200) {
      return { status: 'ERROR', error: `HTTP ${getResp.status} on GET`, permits: [] };
    }

    const cookieJar = extractCookies(getResp.headers);
    const hiddenFields = extractHiddenFields(getResp.body);

    // Step 2: Find the correct form field names
    // LOGIS uses ASP.NET WebForms — field IDs vary slightly by city instance.
    // We look for input fields whose ID contains keywords.
    const houseNumField = findFieldName(getResp.body, ['HouseNum', 'housenum', 'HouseNumber']);
    const streetField   = findFieldName(getResp.body, ['StreetName', 'streetname', 'Street']);
    const permitTypeField = findFieldName(getResp.body, ['PermitType', 'permittype', 'ddlPermit']);
    const searchBtnField  = findFieldName(getResp.body, ['btnSearch', 'Search', 'search']);

    if (!houseNumField || !streetField) {
      return { status: 'ERROR', error: `Could not find form fields on LOGIS page for ${city}. Page may have changed.`, permits: [] };
    }

    // Step 3: POST search
    const formData = {
      ...hiddenFields,
      [houseNumField]: houseNum,
      [streetField]: streetName,
      '__EVENTTARGET': '',
      '__EVENTARGUMENT': '',
    };

    // Add permit type if found
    if (permitTypeField) formData[permitTypeField] = 'Building';
    // Add search button
    if (searchBtnField) formData[searchBtnField] = 'Search';

    const postResp = await post(searchUrl, formData, {
      'Cookie': cookieHeader(cookieJar),
      'Referer': searchUrl,
    });

    if (postResp.status !== 200) {
      return { status: 'ERROR', error: `HTTP ${postResp.status} on POST`, permits: [] };
    }

    // Step 4: Check for "no records" message
    const bodyLower = postResp.body.toLowerCase();
    if (bodyLower.includes('no records found') || bodyLower.includes('0 record') || bodyLower.includes('no permits found')) {
      return { status: 'CLEAR', permits: [] };
    }

    // Step 5: Parse permit table
    const permits = parsePermitTable(postResp.body);

    if (permits.length === 0) {
      // Could be "no results" or a parse failure — save HTML snippet for debug
      const snippet = postResp.body.slice(0, 500);
      return { status: 'UNKNOWN', error: 'No permits parsed — possible form field mismatch or truly no permits', debugSnippet: snippet, permits: [] };
    }

    // Step 6: Evaluate for disqualifying reroof permits
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
        reason: `${p.subType || p.description} — issued ${p.issuedDate || p.appliedDate}`,
        permits,
        reroofPermits: recentReroof,
      };
    }

    if (reroofPermits.length > 0) {
      const p = reroofPermits[0];
      return {
        status: 'CLEAR',
        note: `Old reroof outside ${REROOF_LOOKBACK_YEARS}yr window: ${p.description} (${p.issuedDate})`,
        permits,
      };
    }

    return { status: 'CLEAR', permits };

  } catch (err) {
    return { status: 'ERROR', error: err.message, permits: [] };
  }
}

// Find a form field name by looking for input whose name contains one of the keywords
function findFieldName(html, keywords) {
  const inputRe = /<input[^>]+>/gi;
  const nameRe  = /name=["']([^"']+)["']/i;
  const idRe    = /id=["']([^"']+)["']/i;
  let m;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    const nameM = nameRe.exec(tag);
    const idM   = idRe.exec(tag);
    const nameVal = nameM ? nameM[1] : '';
    const idVal   = idM   ? idM[1]   : '';
    for (const kw of keywords) {
      if (nameVal.toLowerCase().includes(kw.toLowerCase()) || idVal.toLowerCase().includes(kw.toLowerCase())) {
        return nameVal; // return the name attribute (used in form POST)
      }
    }
  }
  return null;
}

// ─── Fetch leads from Hennepin County GIS ────────────────────────────────────

async function fetchLeads() {
  log('Fetching leads from Hennepin County GIS...');
  const params = new URLSearchParams(GIS_PARAMS);
  const url = `${GIS_URL}?${params.toString()}`;

  const resp = await get(url);
  if (resp.status !== 200) throw new Error(`GIS API returned HTTP ${resp.status}`);

  const data = JSON.parse(resp.body);
  if (!data.features) throw new Error('No features in GIS response');

  return data.features.map(f => {
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
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('SilentRoof LOGIS Permit Scraper');
  log(`Lookback window: ${REROOF_LOOKBACK_YEARS} years`);

  // --probe mode: just show the URL for a city (to verify routing)
  if (probeCity) {
    const url = getLogisUrl(probeCity);
    if (url) {
      log(`Probe: ${probeCity} → ${url}`);
      const resp = await get(url);
      log(`HTTP status: ${resp.status}`);
      if (resp.status === 200) {
        const fields = extractHiddenFields(resp.body);
        log('Hidden fields found: ' + Object.keys(fields).join(', '));
        const houseField = findFieldName(resp.body, ['HouseNum', 'housenum', 'HouseNumber']);
        const streetField = findFieldName(resp.body, ['StreetName', 'streetname', 'Street']);
        log(`House number field: ${houseField}`);
        log(`Street name field:  ${streetField}`);
      }
    } else {
      log(`City "${probeCity}" is not in the LOGIS_CITIES map.`);
    }
    return;
  }

  // Load existing results for resume mode
  let existing = {};
  if (resumeMode && fs.existsSync(OUTPUT_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      for (const r of (prev.results || [])) {
        if (r.status !== 'ERROR') existing[`${r.address}|${r.city}`] = r;
      }
      log(`Resume: ${Object.keys(existing).length} leads already verified`);
    } catch (e) {
      log(`Could not load existing results: ${e.message}`);
    }
  }

  // Fetch all leads
  let leads = await fetchLeads();
  log(`Total leads from GIS: ${leads.length}`);

  // Filter by city if requested
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
  log(`Unique addresses: ${leads.length}`);

  // Apply limit
  if (limitCount) leads = leads.slice(0, limitCount);

  // Show city breakdown and LOGIS coverage
  const byCityCount = {};
  for (const l of leads) byCityCount[l.city] = (byCityCount[l.city] || 0) + 1;
  log('\nLeads by city:');
  for (const [city, count] of Object.entries(byCityCount).sort((a, b) => b[1] - a[1])) {
    const onLogis = getLogisUrl(city) ? '✓ LOGIS' : '✗ no API';
    log(`  ${city.padEnd(20)} ${count} leads   ${onLogis}`);
  }
  console.log('');

  // Run checks
  const results = [];
  let done = 0, flagged = 0, clear = 0, skipped = 0, noApi = 0;

  for (const lead of leads) {
    const key = `${lead.address}|${lead.city}`;

    // Resume: reuse existing result
    if (resumeMode && existing[key]) {
      results.push(existing[key]);
      skipped++;
      continue;
    }

    done++;
    const progress = `[${done + skipped}/${leads.length}]`;

    const logisUrl = getLogisUrl(lead.city);
    if (!logisUrl) {
      log(`${progress} SKIP  ${lead.address}, ${lead.city} — city not on LOGIS`);
      results.push({ ...lead, checkedAt: new Date().toISOString(), status: 'SKIP', reason: 'City not on LOGIS', permits: [] });
      noApi++;
      continue;
    }

    log(`${progress} CHECK ${lead.address}, ${lead.city} ${lead.zip}`);

    const result = await queryLogisAddress(lead.address, lead.city, lead.zip);

    const record = {
      pid:          lead.pid,
      owner:        lead.owner,
      address:      lead.address,
      city:         lead.city,
      zip:          lead.zip,
      yearBuilt:    lead.yearBuilt,
      checkedAt:    new Date().toISOString(),
      ...result,
    };

    results.push(record);

    if (result.status === 'FLAGGED') {
      flagged++;
      log(`  ⛔ FLAGGED — ${result.reason}`);
    } else if (result.status === 'CLEAR') {
      clear++;
      log(`  ✓ CLEAR${result.note ? '  note: ' + result.note : ''}`);
    } else if (result.status === 'UNKNOWN') {
      log(`  ? UNKNOWN — ${result.error}`);
    } else if (result.status === 'ERROR') {
      log(`  ✗ ERROR — ${result.error}`);
    }

    // Persist after every record (crash-safe)
    writeOutput(results);

    if (done < leads.length - skipped - noApi) await sleep(REQUEST_DELAY_MS);
  }

  // Final summary
  console.log('\n' + '═'.repeat(60));
  log('COMPLETE');
  log(`Checked:  ${done}`);
  log(`Skipped:  ${skipped} (resumed)`);
  log(`No API:   ${noApi} (city not on LOGIS)`);
  log(`FLAGGED:  ${flagged}  ← move these to Cold`);
  log(`CLEAR:    ${clear}`);
  log(`UNKNOWN:  ${results.filter(r => r.status === 'UNKNOWN').length}`);
  log(`ERROR:    ${results.filter(r => r.status === 'ERROR').length}`);
  log(`Output:   ${OUTPUT_FILE}`);

  if (flagged > 0) {
    console.log('\n⛔ Leads to move to COLD:');
    for (const r of results.filter(r => r.status === 'FLAGGED')) {
      console.log(`   ${r.address}, ${r.city} — ${r.reason}`);
    }
  }
}

function writeOutput(results) {
  const out = {
    generatedAt:    new Date().toISOString(),
    lookbackYears:  REROOF_LOOKBACK_YEARS,
    totalChecked:   results.length,
    flagged:        results.filter(r => r.status === 'FLAGGED').length,
    clear:          results.filter(r => r.status === 'CLEAR').length,
    unknown:        results.filter(r => r.status === 'UNKNOWN').length,
    skip:           results.filter(r => r.status === 'SKIP').length,
    errors:         results.filter(r => r.status === 'ERROR').length,
    results,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
