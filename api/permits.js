// Vercel serverless function — CommonJS format for maximum compatibility

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

  // Ping test — visit /api/permits?ping=1 to verify Vercel can reach the city API
  if (req.query && req.query.ping === '1') {
    try {
      const r = await fetch(`${baseUrl}?where=1%3D1&outFields=permitNumber&resultRecordCount=1&f=json`);
      const text = await r.text();
      return res.status(200).json({ ping: true, httpStatus: r.status, preview: text.slice(0, 300) });
    } catch(e) {
      return res.status(200).json({ ping: true, fetchError: e.message });
    }
  }

  try {
    const dateStart = 631152000000;  // 1990-01-01
    const dateEnd   = 1609459200000; // 2021-01-01

    const where = `workType = 'RoofWind' AND issueDate >= ${dateStart} AND issueDate <= ${dateEnd} AND (occupancyType = 'Comm' OR occupancyType = 'MFD' OR occupancyType = 'Ind')`;

    const queryString = [
      `where=${encodeURIComponent(where)}`,
      `outFields=permitNumber,permitType,workType,issueDate,fullName,applicantAddress1,applicantCity,value,occupancyType,status,Latitude,Longitude`,
      `resultRecordCount=1000`,
      `orderByFields=issueDate ASC`,
      `f=json`
    ].join('&');

    const fullUrl = `${baseUrl}?${queryString}`;

    const response = await fetch(fullUrl);
    const text = await response.text();

    if (!response.ok) {
      return res.status(200).json({
        error: `HTTP ${response.status}`,
        preview: text.slice(0, 500)
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch(e) {
      return res.status(200).json({
        error: 'Could not parse JSON from city API',
        preview: text.slice(0, 500)
      });
    }

    if (data.error) {
      return res.status(200).json({
        error: data.error.message || 'ArcGIS returned an error',
        arcgisError: data.error,
        queryUsed: where
      });
    }

    return res.status(200).json(data);

  } catch(err) {
    return res.status(200).json({
      error: err.message,
      type: err.constructor.name
    });
  }
};
