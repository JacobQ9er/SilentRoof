// Vercel serverless function — Hennepin County LAND_PROPERTY
// Full pagination — fetches ALL commercial parcels built 1985-2000
// Combines year-range splitting + offset pagination for complete coverage

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const BASE = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1/query';
  const NOW_YEAR = new Date().getFullYear();
  const CYCLE = 30;
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 6; // safety cap — 6000 records per year range

  const FIELDS = [
    'PID','BUILD_YR','PR_TYP_CD1','PR_TYP_NM1',
    'OWNER_NM','HOUSE_NO','STREET_NM',
    'MAILING_MUNIC_NM','ZIP_CD',
    'BLDG_MV1','MKT_VAL_TOT','LAT','LON'
  ].join(',');

  // Split into 4 year ranges to keep each query manageable
  // Then paginate within each range until exhausted
  const YEAR_RANGES = [
    { from: 1985, to: 1988 },
    { from: 1989, to: 1993 },
    { from: 1994, to: 1997 },
    { from: 1998, to: 2000 },
  ];

  async function fetchRange(from, to) {
    const where = `BUILD_YR >= '${from}' AND BUILD_YR <= '${to}' AND BLDG_MV1 > 100000 AND PR_TYP_CD1 <> 'R'`;
    const allFeatures = [];
    let offset = 0;

    while (true) {
      const params = new URLSearchParams({
        where,
        outFields: FIELDS,
        resultRecordCount: PAGE_SIZE,
        resultOffset: offset,
        orderByFields: 'BUILD_YR ASC',
        f: 'json'
      });

      const r = await fetch(`${BASE}?${params}`);
      if (!r.ok) break;

      const data = await r.json();
      if (data.error || !data.features?.length) break;

      allFeatures.push(...data.features);

      // If we got fewer than a full page, we've hit the end
      if (data.features.length < PAGE_SIZE) break;

      offset += PAGE_SIZE;

      // Safety cap
      if (offset >= PAGE_SIZE * MAX_PAGES) break;
    }

    return allFeatures;
  }

  try {
    // Fetch all year ranges in parallel
    const results = await Promise.all(
      YEAR_RANGES.map(r => fetchRange(r.from, r.to))
    );

    const allFeatures = results.flat();

    // Dedupe by PID
    const seen = new Set();
    const unique = allFeatures.filter(f => {
      const pid = f.attributes?.PID;
      if (!pid || seen.has(pid)) return false;
      seen.add(pid);
      return true;
    });

    const leads = unique
      .map((f, i) => {
        const p = f.attributes;
        const yb = parseInt(p.BUILD_YR);
        if (!yb || isNaN(yb)) return null;

        const yearsLeft = (yb + CYCLE) - NOW_YEAR;
        const addr = `${String(p.HOUSE_NO || '').trim()} ${String(p.STREET_NM || '').trim()}`.trim();

        return {
          id: i + 1,
          name: String(p.OWNER_NM || addr || 'Commercial Property').trim(),
          addr: addr || '—',
          city: String(p.MAILING_MUNIC_NM || '').trim(),
          zip: String(p.ZIP_CD || '').trim(),
          type: String(p.PR_TYP_NM1 || 'Commercial').trim(),
          yearBuilt: yb,
          yearsLeft,
          permitDate: `${yb}-01-01`,
          permitNum: String(p.PID || '—'),
          estVal: p.BLDG_MV1 || p.MKT_VAL_TOT || 0,
          lat: p.LAT || null,
          lng: p.LON || null,
          source: 'live'
        };
      })
      .filter(Boolean)
      .filter(l => l.yearsLeft <= 15)
      .sort((a, b) => a.yearsLeft - b.yearsLeft);

    return res.status(200).json({
      features: leads,
      totalFiltered: leads.length,
      totalFromAPI: unique.length,
      breakdown: YEAR_RANGES.map((r, i) => ({
        range: `${r.from}-${r.to}`,
        count: results[i].length
      }))
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
