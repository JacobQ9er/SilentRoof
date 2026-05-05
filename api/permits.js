// Vercel serverless function — Minneapolis CCS Permits proxy
// Now with ?debug=1 mode to inspect raw data

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const debug = req.query.debug === '1';

  try {
    const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

    if (debug) {
      // Debug mode: grab 20 records with NO filters — show us exactly what's in the data
      const params = new URLSearchParams({
        where: '1=1',
        outFields: 'permitNumber,permitType,workType,issueDate,applicantAddress1,applicantCity,value,occupancyType,status',
        resultRecordCount: '20',
        f: 'json'
      });
      const response = await fetch(`${baseUrl}?${params}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      
      // Return sample of raw values so we can see what workType actually contains
      const samples = (data.features || []).map(f => ({
        permitNumber: f.attributes.permitNumber,
        permitType:   f.attributes.permitType,
        workType:     f.attributes.workType,
        issueDate:    f.attributes.issueDate ? new Date(f.attributes.issueDate).toISOString().slice(0,10) : null,
        address:      f.attributes.applicantAddress1,
        city:         f.attributes.applicantCity,
        value:        f.attributes.value,
        occupancy:    f.attributes.occupancyType,
        status:       f.attributes.status,
      }));

      return res.status(200).json({ debug: true, samples, totalReturned: data.features?.length });
    }

    // PRODUCTION MODE — broad roofing query
    // Using OR across multiple possible workType values
    const params = new URLSearchParams({
      where: `(upper(workType) LIKE '%ROOF%' OR upper(permitType) LIKE '%ROOF%' OR upper(workType) LIKE '%RE-ROOF%' OR upper(workType) LIKE '%REROOF%') AND issueDate >= DATE '1990-01-01' AND issueDate <= DATE '2020-12-31'`,
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
    res.status(500).json({ error: err.message });
  }
}
