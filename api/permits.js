// Vercel serverless function — step-by-step query builder
// Use ?q=1 through ?q=5 to test progressively complex queries

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

  const step = (req.query && req.query.q) ? req.query.q : 'prod';

  // Each step tests one more piece of the query
  const queries = {
    '1': `workType = 'RoofWind'`,
    '2': `workType = 'RoofWind' AND value > 0`,
    '3': `workType = 'RoofWind' AND occupancyType = 'Comm'`,
    '4': `workType = 'RoofWind' AND issueDate <= TIMESTAMP '2021-01-01 00:00:00'`,
    '5': `workType = 'RoofWind' AND issueDate >= TIMESTAMP '1990-01-01 00:00:00' AND issueDate <= TIMESTAMP '2021-01-01 00:00:00'`,
    'prod': `workType = 'RoofWind' AND issueDate >= TIMESTAMP '1990-01-01 00:00:00' AND issueDate <= TIMESTAMP '2021-01-01 00:00:00' AND occupancyType IN ('Comm', 'MFD', 'Ind')`
  };

  const where = queries[step] || queries['1'];

  try {
    const queryString = [
      `where=${encodeURIComponent(where)}`,
      `outFields=permitNumber,workType,issueDate,applicantAddress1,applicantCity,value,occupancyType,fullName,Latitude,Longitude`,
      `resultRecordCount=500`,
      `f=json`
    ].join('&');

    const response = await fetch(`${baseUrl}?${queryString}`);
    const text = await response.text();
    const data = JSON.parse(text);

    if (data.error) {
      return res.status(200).json({
        step,
        where,
        error: data.error.message,
        code: data.error.code
      });
    }

    return res.status(200).json({
      step,
      where,
      count: data.features?.length || 0,
      sample: data.features?.slice(0,3).map(f => f.attributes) || []
    });

  } catch(err) {
    return res.status(200).json({ step, where, error: err.message });
  }
};
