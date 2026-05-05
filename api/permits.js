// Vercel serverless function — proxies Minneapolis CCS Permits API
// Field names confirmed via live debug output:
// permitNumber, permitType, workType, issueDate, completeDate,
// fullName, applicantAddress1, applicantCity, value, occupancyType, status, Latitude, Longitude

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

    const params = new URLSearchParams({
      // workType contains the roof description, issueDate is the permit date, value is job size
      where: `upper(workType) LIKE '%ROOF%' AND issueDate >= DATE '1990-01-01' AND issueDate <= DATE '2020-12-31' AND value > 10000`,
      outFields: 'permitNumber,permitType,workType,issueDate,completeDate,fullName,applicantAddress1,applicantCity,value,totalFees,occupancyType,status,Latitude,Longitude',
      resultRecordCount: '500',
      orderByFields: 'issueDate ASC',
      f: 'json'
    });

    const response = await fetch(`${baseUrl}?${params}`);
    if (!response.ok) throw new Error(`Upstream API returned ${response.status}`);

    const data = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    res.status(200).json(data);

  } catch (err) {
    res.status(500).json({
      error: err.message,
      hint: 'Check Vercel function logs for full stack trace'
    });
  }
}
