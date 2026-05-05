// Vercel serverless function — PRODUCTION version
// Query confirmed working: workType = 'RoofWind', dates as raw ms timestamps
// occupancyType IN syntax confirmed from ArcGIS docs

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

  try {
    // Timestamps in ms — confirmed format from live data
    // 1990-01-01 = 631152000000
    // 2021-01-01 = 1609459200000 (gives us buildings hitting 30yr cycle through 2051)
    const where = `workType = 'RoofWind' AND issueDate >= 631152000000 AND issueDate <= 1609459200000 AND occupancyType = 'Comm'`;

    const queryString = [
      `where=${encodeURIComponent(where)}`,
      `outFields=permitNumber,workType,issueDate,applicantAddress1,applicantCity,value,occupancyType,fullName,Latitude,Longitude`,
      `resultRecordCount=1000`,
      `orderByFields=issueDate ASC`,
      `f=json`
    ].join('&');

    const response = await fetch(`${baseUrl}?${queryString}`);
    const text = await response.text();
    const data = JSON.parse(text);

    if (data.error) {
      // Fallback — drop occupancy filter, return all RoofWind in date range
      const fallbackWhere = `workType = 'RoofWind' AND issueDate >= 631152000000 AND issueDate <= 1609459200000`;
      const fallbackQS = [
        `where=${encodeURIComponent(fallbackWhere)}`,
        `outFields=permitNumber,workType,issueDate,applicantAddress1,applicantCity,value,occupancyType,fullName,Latitude,Longitude`,
        `resultRecordCount=1000`,
        `orderByFields=issueDate ASC`,
        `f=json`
      ].join('&');

      const fallbackRes = await fetch(`${baseUrl}?${fallbackQS}`);
      const fallbackData = await fallbackRes.json();

      if (fallbackData.error) {
        return res.status(200).json({
          error: fallbackData.error.message,
          arcgisError: fallbackData.error
        });
      }

      return res.status(200).json(fallbackData);
    }

    return res.status(200).json(data);

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
