// Diagnostic: find ALL unique workTypes across entire dataset
// Use pagination to sample broadly

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const baseUrl = 'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/CCS_Permits/FeatureServer/0/query';

  try {
    // Pull 4 pages from different offsets to get a broad sample of workTypes
    const offsets = [0, 2000, 5000, 10000, 20000, 30000];
    const allWorkTypes = new Map(); // workType -> sample record

    for (const offset of offsets) {
      const qs = [
        `where=1%3D1`,
        `outFields=workType,permitType,issueDate,applicantAddress1,value,occupancyType`,
        `resultRecordCount=500`,
        `resultOffset=${offset}`,
        `f=json`
      ].join('&');

      const res2 = await fetch(`${baseUrl}?${qs}`);
      const data = await res2.json();
      if (data.error || !data.features?.length) continue;

      data.features.forEach(f => {
        const p = f.attributes;
        const wt = p.workType;
        if (!wt) return;
        if (!allWorkTypes.has(wt)) {
          allWorkTypes.set(wt, {
            workType: wt,
            permitType: p.permitType,
            sampleAddress: p.applicantAddress1,
            sampleValue: p.value,
            sampleOccupancy: p.occupancyType,
            sampleDate: p.issueDate ? new Date(p.issueDate).toISOString().slice(0,10) : null
          });
        }
      });
    }

    // Sort by workType name
    const sorted = Array.from(allWorkTypes.values())
      .sort((a,b) => a.workType.localeCompare(b.workType));

    return res.status(200).json({
      totalUniqueWorkTypes: sorted.length,
      workTypes: sorted
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
