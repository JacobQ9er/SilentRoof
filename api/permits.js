// Diagnostic: pull raw parcels with NO field filters to see what fields exist

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const token = process.env.REGRID_API_KEY;
  if (!token) return res.status(200).json({ error: 'REGRID_API_KEY not set' });

  try {
    // Pull 3 raw parcels from Hennepin County — no filters, just show us what fields exist
    const tests = [
      // Test 1: raw parcels no filter
      `https://app.regrid.com/api/v2/parcels/query?fields[geoid][eq]=27053&limit=3&token=${token}`,
      // Test 2: try path-based query
      `https://app.regrid.com/api/v1/search.json?path=/us/mn/hennepin&limit=3&token=${token}`,
      // Test 3: lat/lon of downtown Minneapolis
      `https://app.regrid.com/api/v1/search.json?lat=44.9778&lon=-93.2650&radius=500&limit=3&token=${token}`,
    ];

    const results = [];

    for (const url of tests) {
      try {
        const r = await fetch(url);
        const text = await r.text();
        let data;
        try { data = JSON.parse(text); } catch(e) { data = { raw: text.slice(0,300) }; }
        
        // Extract field names from first result
        let fields = null;
        const feature = data?.parcels?.features?.[0] || data?.results?.[0];
        if (feature?.properties?.fields) {
          fields = Object.keys(feature.properties.fields);
        }

        results.push({
          url: url.replace(token, 'TOKEN'),
          httpStatus: r.status,
          count: data?.parcels?.features?.length ?? data?.results?.length ?? 0,
          fields: fields,
          firstRecord: feature?.properties?.fields || null
        });
      } catch(e) {
        results.push({ url: url.replace(token, 'TOKEN'), error: e.message });
      }
    }

    return res.status(200).json({ diagnostic: true, results });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
