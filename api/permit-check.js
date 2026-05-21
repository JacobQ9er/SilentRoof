// Vercel serverless function — Roof Permit Verification
// GET /api/permit-check?address=3453+NICOLLET+AVE&city=MINNEAPOLIS&zip=55408
//
// CLEAR   = no roof-related permits found in last 20 years → lead stays HOT
// FLAGGED = roof permit found → roof may have been replaced → pull back from outreach
// UNKNOWN = city not in our supported list yet → manual review needed

const ROOF_KEYWORDS = [
  'roof', 'reroof', 're-roof', 'reroofing',
  'membrane', 'tpo', 'epdm', 'pvc roofing',
  'built-up roof', 'bur ', 'shingle',
  'flashing', 'skylight', 'roof deck',
  'roofing', 'roof replacement', 'roof repair',
  'roof recover'
];

const LOOKBACK_YEARS = 20;

function routeCity(city) {
  const c = (city || '').toUpperCase().trim();
  if (c === 'MINNEAPOLIS') return checkMinneapolis;
  if (c === 'BLOOMINGTON') return checkBloomington;
  // Hennepin County GIS does not expose a public permits service.
  // Suburban cities return UNKNOWN until individual city APIs are wired up.
  return null;
}

function isRoofPermit(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return ROOF_KEYWORDS.some(kw => lower.includes(kw));
}

function cutoffYear() {
  return new Date().getFullYear() - LOOKBACK_YEARS;
}

async function checkMinneapolis(address) {
  const normalized = address.replace(/\b(AVE|ST|BLVD|DR|RD|LN|CT|PL|WAY|PKWY|HWY)\b.*/i, '').trim();
  const cutoff = cutoffYear();
  const where = encodeURIComponent(`address like '%${normalized}%' AND issue_year >= ${cutoff}`);
  const fields = 'address,permit_type,work_type,description,issue_date,issue_year,permit_number,status';
  const url = `https://opendata.minneapolismn.gov/api/explore/v2.1/catalog/datasets/building-permits/records?where=${where}&limit=50&select=${fields}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`Minneapolis API: HTTP ${resp.status}`);
  const data = await resp.json();
  const roofPermits = (data.results || []).filter(r =>
    isRoofPermit(r.description) || isRoofPermit(r.work_type) || isRoofPermit(r.permit_type)
  );
  return roofPermits.map(r => ({
    permitNumber: r.permit_number || '—',
    description: r.description || r.work_type || '—',
    issueDate: r.issue_date || r.issue_year || '—',
    source: 'Minneapolis Open Data'
  }));
}

async function checkBloomington(address) {
  const cutoff = cutoffYear();
  const streetNum = address.split(' ')[0];
  const where = encodeURIComponent(`upper(address) like '%${streetNum}%' AND year >= ${cutoff}`);
  const url = `https://data.bloomingtonmn.gov/resource/permits.json?$where=${where}&$limit=50`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`Bloomington API: HTTP ${resp.status}`);
  const records = await resp.json();
  const roofPermits = records.filter(r =>
    isRoofPermit(r.description) || isRoofPermit(r.type) || isRoofPermit(r.subtype)
  );
  return roofPermits.map(r => ({
    permitNumber: r.permit_number || r.id || '—',
    description: r.description || r.type || '—',
    issueDate: r.issued_date || r.year || '—',
    source: 'City of Bloomington'
  }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { address, city, zip } = req.query || {};
  if (!address || !city) return res.status(400).json({ error: 'address and city are required' });

  const checker = routeCity(city);
  if (!checker) {
    return res.status(200).json({
      status: 'UNKNOWN', city, address, permits: [],
      message: `Permit API not yet configured for ${city}. Manual review recommended.`,
      checked: new Date().toISOString()
    });
  }

  try {
    const roofPermits = await checker(address, city);
    const status = roofPermits.length > 0 ? 'FLAGGED' : 'CLEAR';
    return res.status(200).json({
      status, city, address, permits: roofPermits, permitCount: roofPermits.length,
      message: status === 'FLAGGED'
        ? `${roofPermits.length} roof-related permit(s) found in last ${LOOKBACK_YEARS} years — verify before outreach.`
        : `No roof permits found in last ${LOOKBACK_YEARS} years. Lead confirmed HOT.`,
      checked: new Date().toISOString()
    });
  } catch (err) {
    return res.status(200).json({
      status: 'UNKNOWN', city, address, permits: [],
      message: `Permit lookup failed: ${err.message}`,
      checked: new Date().toISOString()
    });
  }
};
