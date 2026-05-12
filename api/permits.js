// Vercel serverless function — Regrid v2 Query API
// Uses confirmed field filter syntax: fields[yearbuilt][between]
// Twin Cities counties: Hennepin=27053, Ramsey=27123, Dakota=27037, Anoka=27003

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const token = process.env.REGRID_API_KEY;
  if (!token) return res.status(200).json({ error: 'REGRID_API_KEY not set' });

  // Ping test
  if (req.query?.ping === '1') {
    try {
      const url = `https://app.regrid.com/api/v2/parcels/query?fields[geoid][eq]=27053&fields[yearbuilt][between]=[1990,1995]&limit=2&token=${token}`;
      const r = await fetch(url);
      const text = await r.text();
      return res.status(200).json({ ping: true, httpStatus: r.status, preview: text.slice(0, 600) });
    } catch(e) {
      return res.status(200).json({ ping: true, error: e.message });
    }
  }

  try {
    const NOW_YEAR = new Date().getFullYear();
    const CYCLE = 30;

    // Commercial LBCS activity codes 2000-2999 = shopping/business/trade
    // We query by yearbuilt range across 4 Twin Cities counties
    const counties = [
      { name: 'Hennepin', geoid: '27053' },
      { name: 'Ramsey',   geoid: '27123' },
      { name: 'Dakota',   geoid: '27037' },
      { name: 'Anoka',    geoid: '27003' },
    ];

    const allParcels = [];

    for (const county of counties) {
      // yearbuilt 1985-2000 = roof cycle hits 2015-2030 = hot and warm leads
      const params = new URLSearchParams({
        token,
        'fields[geoid][eq]':           county.geoid,
        'fields[yearbuilt][between]':  '[1985,2000]',
        'fields[struct][eq]':          'true',
        limit:                         '200',
        return_custom:                 'false',
      });

      const url = `https://app.regrid.com/api/v2/parcels/query?${params}`;
      const r = await fetch(url);

      if (!r.ok) continue;

      const data = await r.json();
      if (data.parcels?.features?.length) {
        allParcels.push(...data.parcels.features);
      }
    }

    // Filter for commercial/non-residential only
    const commercialLbcs = [2000, 2999]; // shopping, business, trade
    const skipUsedesc = ['RESIDENTIAL', 'SINGLE FAMILY', 'CONDO', 'TOWNHOUSE', 'DUPLEX', 'VACANT'];

    const leads = allParcels
      .map((f, i) => {
        const fields = f.properties?.fields || {};
        const yb = parseInt(fields.yearbuilt);
        if (!yb) return null;

        // Skip pure residential
        const usedesc = (fields.usedesc || '').toUpperCase();
        const isResidential = skipUsedesc.some(s => usedesc.includes(s));
        if (isResidential) return null;

        const yearsLeft = (yb + CYCLE) - NOW_YEAR;

        return {
          id: i + 1,
          name: fields.owner || fields.address || 'Commercial Property',
          addr: fields.address || f.properties?.headline || '—',
          city: fields.scity || fields.city || '—',
          zip: fields.szip5 || fields.zip || '',
          type: fields.structstyle || fields.usedesc || fields.lbcs_activity_desc || 'Commercial',
          yearBuilt: yb,
          yearsLeft,
          permitDate: `${yb}-01-01`,
          permitNum: fields.parcelnumb || '—',
          estVal: fields.parval || fields.improvval || 0,
          sqft: fields.ll_bldg_footprint_sqft || null,
          lat: parseFloat(fields.lat) || null,
          lng: parseFloat(fields.lon) || null,
          source: 'live'
        };
      })
      .filter(Boolean)
      .filter(l => l.yearsLeft <= 15) // only leads within 15yr window
      .sort((a, b) => a.yearsLeft - b.yearsLeft);

    return res.status(200).json({
      features: leads,
      totalFiltered: leads.length,
      totalFromAPI: allParcels.length
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
