// Vercel serverless function — PRODUCTION
// Pulls ALL Commercial permitType records, filters for any roof-related workType in JS
// Avoids ArcGIS LIKE/date syntax issues entirely

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

  try {
    // Pull all Commercial permits — confirmed safe simple query
    // We do ALL the smart filtering in JavaScript below
    const queryString = [
      `where=${encodeURIComponent("permitType = 'Commercial'")}`,
      `outFields=permitNumber,workType,issueDate,applicantAddress1,applicantCity,value,occupancyType,fullName,Latitude,Longitude`,
      `resultRecordCount=2000`,
      `orderByFields=issueDate ASC`,
      `f=json`
    ].join('&');

    const response = await fetch(`${baseUrl}?${queryString}`);
    const text = await response.text();
    const data = JSON.parse(text);

    if (data.error) {
      return res.status(200).json({
        error: data.error.message,
        arcgisError: data.error
      });
    }

    const dateStart = new Date('1990-01-01').getTime();
    const dateEnd   = new Date('2021-01-01').getTime();

    // Catch any workType that sounds roof-related
    const isRoofing = (workType) => {
      if (!workType) return false;
      const w = workType.toLowerCase();
      return w.includes('roof') || w.includes('reroof') || w.includes('re-roof');
    };

    const filtered = (data.features || []).filter(f => {
      const p = f.attributes;
      const inDateRange = p.issueDate >= dateStart && p.issueDate <= dateEnd;
      const hasRoof = isRoofing(p.workType);
      const hasValue = p.value > 5000; // filter out $0 permits (inspections, amendments)
      return inDateRange && hasRoof && hasValue;
    });

    // Also return a unique list of workTypes we found — useful for debugging
    const workTypes = [...new Set(
      (data.features || []).map(f => f.attributes.workType).filter(Boolean)
    )].sort();

    return res.status(200).json({
      features: filtered,
      totalFiltered: filtered.length,
      totalFromAPI: data.features?.length || 0,
      workTypesFound: workTypes // shows us every workType in Commercial permits
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
