// Vercel serverless function — Hennepin County direct ArcGIS REST server
// gis.hennepin.us — official county server, no API key needed

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // Ping — check field names first
  if (req.query?.ping === '1') {
    try {
      const url = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/COUNTY_PARCELS_TEST/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=2&f=json';
      const r = await fetch(url);
      const text = await r.text();
      const data = JSON.parse(text);
      const fields = data.fields?.map(f => f.name) || [];
      const sample = data.features?.[0]?.attributes || null;
      return res.status(200).json({ ping: true, httpStatus: r.status, fields, sample });
    } catch(e) {
      return res.status(200).json({ ping: true, error: e.message });
    }
  }

  try {
    const NOW_YEAR = new Date().getFullYear();
    const CYCLE = 30;

    const baseUrl = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/COUNTY_PARCELS_TEST/FeatureServer/0/query';

    // First ping to get real field names if we don't know them yet
    const fieldCheckRes = await fetch(`${baseUrl}?where=1%3D1&outFields=*&resultRecordCount=1&f=json`);
    const fieldCheck = await fieldCheckRes.json();
    const availableFields = fieldCheck.fields?.map(f => f.name) || [];

    // Find year built field — could be named several ways
    const yearField = availableFields.find(f =>
      f.toLowerCase().includes('year') || f.toLowerCase().includes('yr_built') || f.toLowerCase() === 'yearbuilt'
    ) || 'YEAR_BUILT';

    const useField = availableFields.find(f =>
      f.toLowerCase().includes('use') && (f.toLowerCase().includes('class') || f.toLowerCase().includes('code') || f.toLowerCase().includes('type'))
    ) || 'USE_CLASS';

    // Now query with discovered field names
    const params = new URLSearchParams({
      where: `${yearField} >= 1985 AND ${yearField} <= 2000`,
      outFields: availableFields.slice(0, 15).join(','),
      resultRecordCount: '500',
      f: 'json'
    });

    const response = await fetch(`${baseUrl}?${params}`);
    const data = await response.json();

    if (data.error) {
      return res.status(200).json({
        error: data.error.message,
        availableFields,
        yearFieldGuess: yearField
      });
    }

    const leads = (data.features || [])
      .map((f, i) => {
        const p = f.attributes;
        const yb = parseInt(p[yearField] || p.YEAR_BUILT || p.YR_BUILT || p.YEARBUILT);
        if (!yb || yb < 1985 || yb > 2000) return null;
        const yearsLeft = (yb + CYCLE) - NOW_YEAR;

        // Find address/owner fields dynamically
        const addr = p.SITUS_ADD || p.SITUSADD || p.ADDRESS || p.SITUS_STREET || Object.values(p).find(v => typeof v === 'string' && v.match(/\d+.*\s(ST|AVE|BLVD|RD|DR|LN|WAY|CT)/i)) || '—';
        const owner = p.OWNER_NAME || p.OWNERNAME || p.TAXPAYER_NM || p.TAXPAYER || '—';
        const city = p.CITY || p.SITUS_CITY || p.MAIL_CITY || '—';
        const zip = p.ZIP || p.SITUS_ZIP || p.ZIP5 || '';
        const useClass = p[useField] || p.USE_CLASS || p.USECODE || p.USECLASS || 'Commercial';
        const val = p.EMV_BLDG || p.BLDG_MV || p.IMPROVVAL || p.TOTAL_MV || 0;

        return {
          id: i + 1,
          name: owner,
          addr,
          city,
          zip,
          type: String(useClass),
          yearBuilt: yb,
          yearsLeft,
          permitDate: `${yb}-01-01`,
          permitNum: p.PID || p.PARCELID || '—',
          estVal: val,
          source: 'live'
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.yearsLeft - b.yearsLeft);

    return res.status(200).json({
      features: leads,
      totalFiltered: leads.length,
      totalFromAPI: data.features?.length || 0,
      fieldsUsed: { yearField, useField }
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
