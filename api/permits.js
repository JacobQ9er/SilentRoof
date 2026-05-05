// Vercel serverless function — proxies Minneapolis CCS Permits API
// This runs server-side so CORS is never an issue
export default async function handler(req, res) {
  // Allow requests from your Vercel domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // Minneapolis CCS Permits — ArcGIS FeatureServer
    // Field names confirmed from the open data portal schema
    const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

    const params = new URLSearchParams({
      where: `upper(PERMITTYPE) LIKE '%ROOF%' AND ISSUEDDATE >= '1990-01-01' AND ISSUEDDATE <= '2020-12-31'`,
      outFields: 'PERMITNUM,PERMITTYPE,ISSUEDDATE,ORIGINALADDRESS1,ORIGINALCITY,ORIGINALSTATE,ORIGINALZIP,ESTATEVAL,WORKTYPE',
      resultRecordCount: '500',
      orderByFields: 'ISSUEDDATE ASC',
      f: 'json'
    });

    const response = await fetch(`${baseUrl}?${params}`);
    if (!response.ok) {
      throw new Error(`Upstream API returned ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      // Try fallback with simpler query if fields differ
      const fallbackParams = new URLSearchParams({
        where: `1=1`,
        outFields: '*',
        resultRecordCount: '10',
        f: 'json'
      });
      const fallback = await fetch(`${baseUrl}?${fallbackParams}`);
      const fallbackData = await fallback.json();

      // Return field names so we can debug
      if (fallbackData.fields) {
        return res.status(200).json({
          debug: true,
          availableFields: fallbackData.fields.map(f => f.name),
          error: data.error
        });
      }
      throw new Error(data.error.message || 'API error from city portal');
    }

    res.status(200).json(data);

  } catch (err) {
    res.status(500).json({ 
      error: err.message,
      hint: 'Check Vercel function logs for details'
    });
  }
}
