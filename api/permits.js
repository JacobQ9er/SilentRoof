// Vercel serverless function — FINAL
// Problem: API returns newest 500 permits, we need OLDEST
// Solution: Use resultOffset to paginate through ALL records and collect old ones
// OR: Use a date ceiling so ArcGIS only returns pre-2021 permits

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

  try {
    // Paginate through results to find older permits
    // Fetch up to 4 pages of 500 records each = 2000 total
    // Use resultOffset to skip past recent records
    const allFeatures = [];
    const pageSize = 500;
    const maxPages = 4;

    for (let page = 0; page < maxPages; page++) {
      const queryString = [
        `where=${encodeURIComponent("workType = 'RoofWind'")}`,
        `outFields=permitNumber,workType,issueDate,applicantAddress1,applicantCity,value,occupancyType,fullName,Latitude,Longitude`,
        `resultRecordCount=${pageSize}`,
        `resultOffset=${page * pageSize}`,
        `orderByFields=issueDate ASC`,
        `f=json`
      ].join('&');

      const response = await fetch(`${baseUrl}?${queryString}`);
      const text = await response.text();
      const data = JSON.parse(text);

      if (data.error || !data.features || data.features.length === 0) break;

      allFeatures.push(...data.features);

      // Stop early if we got fewer than a full page — no more records
      if (data.features.length < pageSize) break;
    }

    // Now filter in JS — keep only pre-2021 non-SFD permits with value > 0
    const dateEnd = new Date('2021-01-01').getTime();
    const skipOccupancy = new Set(['SFD']);

    // Dedupe by address — keep oldest permit per address (most relevant for cycle tracking)
    const byAddr = new Map();
    allFeatures.forEach(f => {
      const p = f.attributes;
      if (!p.applicantAddress1 || !p.issueDate) return;
      const key = p.applicantAddress1.toLowerCase().trim();
      if (!byAddr.has(key) || p.issueDate < byAddr.get(key).issueDate) {
        byAddr.set(key, p);
      }
    });

    const filtered = Array.from(byAddr.values()).filter(p => {
      return p.issueDate <= dateEnd &&
             !skipOccupancy.has(p.occupancyType) &&
             (p.value || 0) > 0;
    });

    // Date range for debugging
    const dates = filtered.map(p => p.issueDate).sort();
    const oldest = dates.length ? new Date(dates[0]).toISOString().slice(0,10) : null;
    const newest = dates.length ? new Date(dates[dates.length-1]).toISOString().slice(0,10) : null;

    return res.status(200).json({
      features: filtered.map(p => ({ attributes: p })),
      totalFiltered: filtered.length,
      totalFetched: allFeatures.length,
      dateRange: { oldest, newest }
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
