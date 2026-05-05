// Vercel serverless function — Minneapolis CCS Permits proxy
// workType confirmed as 'RoofWind' for roofing permits
// issueDate is a timestamp in milliseconds — use numeric comparison not DATE syntax

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

    // Convert date range to milliseconds (how ArcGIS stores timestamps)
    const dateStart = new Date('1990-01-01').getTime(); // 631152000000
    const dateEnd   = new Date('2021-01-01').getTime(); // 1609459200000

    const params = new URLSearchParams({
      where: `workType = 'RoofWind' AND issueDate >= ${dateStart} AND issueDate <= ${dateEnd} AND (occupancyType = 'Comm' OR occupancyType = 'MFD' OR occupancyType = 'Ind')`,
      outFields: 'permitNumber,permitType,workType,issueDate,fullName,applicantAddress1,applicantCity,value,occupancyType,status,Latitude,Longitude',
      resultRecordCount: '1000',
      orderByFields: 'issueDate ASC',
      f: 'json'
    });

    const response = await fetch(`${baseUrl}?${params}`);
    if (!response.ok) throw new Error(`Upstream API returned ${response.status}`);

    const data = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    res.status(200).json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
