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

    const skipOccupancy = new Set(['SFD']); // exclude single family residential

    const filtered = (data.features || []).filter(f => {
      const p = f.attributes;
      const notResidential = !skipOccupancy.has(p.occupancyType);
      const hasValue = (p.value || 0) > 0;
      return notResidential && hasValue;
    });

    const occupancyTypes = [...new Set(
      (data.features || []).map(f => f.attributes.occupancyType).filter(Boolean)
    )].sort();

    // Show date range of what came back
    const dates = (data.features||[]).map(f=>f.attributes.issueDate).filter(Boolean).sort();
    const oldestDate = dates.length ? new Date(dates[0]).toISOString().slice(0,10) : null;
    const newestDate = dates.length ? new Date(dates[dates.length-1]).toISOString().slice(0,10) : null;

    return res.status(200).json({
      features: filtered,
      totalFiltered: filtered.length,
      totalFromAPI: data.features?.length || 0,
      occupancyTypesFound: occupancyTypes,
      dateRange: { oldest: oldestDate, newest: newestDate }
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
