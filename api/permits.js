// Vercel serverless function — Regrid Parcel API
// Queries commercial parcels in Twin Cities metro by yearbuilt
// yearbuilt 1985-2000 = roofs hitting 25-40yr cycle = hot/warm leads

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const token = process.env.REGRID_API_KEY;
  if (!token) {
    return res.status(200).json({ error: 'REGRID_API_KEY not set in environment variables' });
  }

  try {
    // Regrid v1 typeahead/parcel query
    // Search commercial parcels in Hennepin County MN by use type + year built range
    // usedesc filters for commercial/office/industrial/retail building types
    // We make multiple queries to cover different commercial use codes

    const commercialQueries = [
      { path: '/us/mn/hennepin', query: 'office' },
      { path: '/us/mn/hennepin', query: 'commercial' },
      { path: '/us/mn/ramsey',   query: 'office' },
      { path: '/us/mn/ramsey',   query: 'commercial' },
    ];

    // Use Regrid's parcel query API with yearbuilt filter
    // GET /api/v1/query.json — filter by path (county), yearbuilt range, struct=true
    const allParcels = [];

    for (const cq of commercialQueries) {
      const params = new URLSearchParams({
        token,
        path:       cq.path,
        query:      cq.query,
        strict:     '0',
        limit:      '100',
        fields:     'yearbuilt,usedesc,structstyle,owner,address,city,state,zip,ll_uuid,parval,lat,lon',
      });

      const url = `https://app.regrid.com/api/v1/search.json?${params}`;
      const response = await fetch(url);
      const text = await response.text();

      let data;
      try { data = JSON.parse(text); } catch(e) {
        continue;
      }

      if (data.results && Array.isArray(data.results)) {
        allParcels.push(...data.results);
      }
    }

    if (allParcels.length === 0) {
      // Try a direct parcel query by county path to see what's available
      const testUrl = `https://app.regrid.com/api/v1/parcel.json?path=/us/mn/hennepin&limit=5&token=${token}`;
      const testRes = await fetch(testUrl);
      const testData = await testRes.json();
      return res.status(200).json({
        debug: true,
        message: 'No results from search queries — showing raw parcel test',
        testResponse: testData
      });
    }

    // Filter and score parcels
    const NOW_YEAR = new Date().getFullYear();
    const CYCLE = 30;

    const leads = allParcels
      .filter(f => {
        const fields = f.properties?.fields || {};
        const yb = parseInt(fields.yearbuilt);
        const hasStruct = fields.struct !== false;
        return yb >= 1985 && yb <= 2005 && hasStruct;
      })
      .map((f, i) => {
        const fields = f.properties?.fields || {};
        const yb = parseInt(fields.yearbuilt);
        const cycleYear = yb + CYCLE;
        const yearsLeft = cycleYear - NOW_YEAR;

        return {
          id: i + 1,
          name: fields.owner || fields.address || 'Commercial Property',
          addr: fields.address || f.properties?.headline || '—',
          city: fields.city || '—',
          zip: fields.zip || '',
          type: fields.structstyle || fields.usedesc || 'Commercial',
          yearBuilt: yb,
          cycleYear,
          yearsLeft,
          estVal: fields.parval || 0,
          lat: fields.lat || null,
          lng: fields.lon || null,
          permitDate: `${yb}-01-01`, // use year built as proxy
          permitNum: fields.ll_uuid || '—',
          source: 'live'
        };
      })
      .sort((a, b) => a.yearsLeft - b.yearsLeft);

    return res.status(200).json({
      features: leads,
      totalFiltered: leads.length,
      totalFromAPI: allParcels.length
    });

  } catch(err) {
    return res.status(200).json({ error: err.message, stack: err.stack?.slice(0,300) });
  }
};
