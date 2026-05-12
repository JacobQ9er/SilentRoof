// Force Node.js runtime — required for fetch to external APIs on Vercel free tier
export const config = { runtime: 'nodejs' };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const token = process.env.REGRID_API_KEY;
  if (!token) {
    return res.status(200).json({ error: 'REGRID_API_KEY not set' });
  }

  // Ping test — /api/permits?ping=1
  if (req.query && req.query.ping === '1') {
    try {
      const url = `https://app.regrid.com/api/v1/search.json?query=office&path=/us/mn/hennepin&limit=2&token=${token}`;
      const r = await fetch(url);
      const text = await r.text();
      return res.status(200).json({
        ping: true,
        httpStatus: r.status,
        preview: text.slice(0, 400)
      });
    } catch(e) {
      return res.status(200).json({ ping: true, error: e.message });
    }
  }

  try {
    // Query Regrid for commercial parcels in Twin Cities counties
    // yearbuilt 1985-2000 = buildings hitting 30yr roof cycle 2015-2030
    const searches = [
      { path: '/us/mn/hennepin', query: 'commercial office industrial' },
      { path: '/us/mn/ramsey',   query: 'commercial office industrial' },
      { path: '/us/mn/dakota',   query: 'commercial office industrial' },
      { path: '/us/mn/anoka',    query: 'commercial office industrial' },
    ];

    const allParcels = [];

    for (const s of searches) {
      try {
        const params = new URLSearchParams({
          token,
          path:  s.path,
          query: s.query,
          limit: '100',
        });

        const url = `https://app.regrid.com/api/v1/search.json?${params}`;
        const r = await fetch(url);
        if (!r.ok) continue;

        const data = await r.json();
        if (data.results?.length) {
          allParcels.push(...data.results);
        }
      } catch(e) {
        continue;
      }
    }

    const NOW_YEAR = new Date().getFullYear();
    const CYCLE = 30;

    const leads = allParcels
      .map((f, i) => {
        const fields = f.properties?.fields || {};
        const yb = parseInt(fields.yearbuilt);
        if (!yb || yb < 1985 || yb > 2005) return null;

        const yearsLeft = (yb + CYCLE) - NOW_YEAR;

        return {
          id: i + 1,
          name: fields.owner || fields.address || 'Commercial Property',
          addr: fields.address || f.properties?.headline || '—',
          city: fields.city2 || fields.scity || '—',
          zip: fields.zip || '',
          type: fields.structstyle || fields.usedesc || 'Commercial',
          yearBuilt: yb,
          yearsLeft,
          permitDate: `${yb}-01-01`,
          permitNum: fields.parcelnumb || '—',
          estVal: fields.parval || 0,
          lat: fields.lat || null,
          lng: fields.lon || null,
          source: 'live'
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.yearsLeft - b.yearsLeft);

    return res.status(200).json({
      features: leads,
      totalFiltered: leads.length,
      totalFromAPI: allParcels.length,
      message: leads.length === 0 ? 'No parcels matched yearbuilt filter — check debug endpoint' : 'ok'
    });

  } catch(err) {
    return res.status(200).json({
      error: err.message,
      stack: err.stack?.slice(0, 400)
    });
  }
};
