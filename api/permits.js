// Vercel serverless function — FINAL PRODUCTION VERSION
// workType = 'RoofWind' confirmed returns 500 records (step 1 test)
// All date/occupancy filtering done in JavaScript

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

  try {
    // This exact query confirmed working — returns 500 records
    const queryString = [
      `where=${encodeURIComponent("workType = 'RoofWind'")}`,
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

    // All smart filtering done here in JS — no ArcGIS syntax issues
    const dateStart = new Date('1990-01-01').getTime();
    const dateEnd   = new Date('2021-01-01').getTime();
    const skipOccupancy = new Set(['SFD']); // exclude single family residential

    const filtered = (data.features || []).filter(f => {
      const p = f.attributes;
      const inDateRange = p.issueDate >= dateStart && p.issueDate <= dateEnd;
      const notResidential = !skipOccupancy.has(p.occupancyType);
      const hasValue = (p.value || 0) > 0;
      return inDateRange && notResidential && hasValue;
    });

    // Show unique occupancy types found — for our reference
    const occupancyTypes = [...new Set(
      (data.features || []).map(f => f.attributes.occupancyType).filter(Boolean)
    )].sort();

    return res.status(200).json({
      features: filtered,
      totalFiltered: filtered.length,
      totalFromAPI: data.features?.length || 0,
      occupancyTypesFound: occupancyTypes
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
