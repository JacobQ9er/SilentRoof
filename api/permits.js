// Vercel serverless function — Hennepin County LAND_PROPERTY
// Supports ?page=0 (0-999), ?page=1 (1000-1999), etc.
// Default page=0

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const BASE = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1/query';
  const NOW_YEAR = new Date().getFullYear();
  const CYCLE = 30;
  const PAGE_SIZE = 500; // smaller pages = faster load

  const page = parseInt(req.query?.page || '0');
  const offset = page * PAGE_SIZE;

  const FIELDS = [
    'PID','BUILD_YR','PR_TYP_CD1','PR_TYP_NM1',
    'OWNER_NM','HOUSE_NO','STREET_NM',
    'MAILING_MUNIC_NM','ZIP_CD',
    'BLDG_MV1','MKT_VAL_TOT',
    'PARCEL_AREA',
    'LAT','LON'
  ].join(',');

  // Ping — get total count so UI knows how many pages exist
  if (req.query?.count === '1') {
    try {
      const params = new URLSearchParams({
        where: `BUILD_YR >= '1985' AND BUILD_YR <= '2000' AND BLDG_MV1 > 100000 AND PR_TYP_CD1 <> 'R'`,
        returnCountOnly: 'true',
        f: 'json'
      });
      const r = await fetch(`${BASE}?${params}`);
      const data = await r.json();
      const total = data.count || 0;
      const totalPages = Math.ceil(total / PAGE_SIZE);
      return res.status(200).json({ total, totalPages, pageSize: PAGE_SIZE });
    } catch(e) {
      return res.status(200).json({ error: e.message });
    }
  }

  try {
    const where = `BUILD_YR >= '1985' AND BUILD_YR <= '2000' AND BLDG_MV1 > 100000 AND PR_TYP_CD1 <> 'R'`;

    const params = new URLSearchParams({
      where,
      outFields: FIELDS,
      resultRecordCount: PAGE_SIZE,
      resultOffset: offset,
      orderByFields: 'BUILD_YR ASC',
      f: 'json'
    });

    const response = await fetch(`${BASE}?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const leads = (data.features || [])
      .map((f, i) => {
        const p = f.attributes;
        const yb = parseInt(p.BUILD_YR);
        if (!yb || isNaN(yb)) return null;
        const yearsLeft = (yb + CYCLE) - NOW_YEAR;
        const addr = `${String(p.HOUSE_NO||'').trim()} ${String(p.STREET_NM||'').trim()}`.trim();
        // PARCEL_AREA is in sq ft — use as building footprint proxy
        const sqft = p.PARCEL_AREA ? Math.round(p.PARCEL_AREA) : null;
        // Est contract: $4–8/sqft for commercial reroofing
        const estLow = sqft ? Math.round(sqft * 4) : null;
        const estHigh = sqft ? Math.round(sqft * 8) : null;

        return {
          id: offset + i + 1,
          name: String(p.OWNER_NM || addr || 'Commercial Property').trim(),
          addr: addr || '—',
          city: String(p.MAILING_MUNIC_NM||'').trim(),
          zip: String(p.ZIP_CD||'').trim(),
          type: String(p.PR_TYP_NM1||'Commercial').trim(),
          yearBuilt: yb,
          yearsLeft,
          permitDate: `${yb}-01-01`,
          permitNum: String(p.PID||'—'),
          estVal: p.BLDG_MV1 || p.MKT_VAL_TOT || 0,
          sqft,
          estLow,
          estHigh,
          lat: p.LAT || null,
          lng: p.LON || null,
          source: 'live'
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.yearsLeft - b.yearsLeft);

    return res.status(200).json({
      features: leads,
      page,
      pageSize: PAGE_SIZE,
      offset,
      returned: leads.length,
      hasMore: data.features?.length === PAGE_SIZE
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
