// Vercel serverless function — Regrid Parcel API
// Queries commercial buildings by yearbuilt in Hennepin + Ramsey counties (Twin Cities)
// yearbuilt is our roof age proxy — commercial building built 1985-1994 = roof due now

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const token = process.env.REGRID_API_KEY;
  if (!token) {
    return res.status(200).json({ error: 'REGRID_API_KEY environment variable not set in Vercel' });
  }

  try {
    // Regrid v1 typeahead/parcel query API
    // Query commercial parcels in Hennepin County MN with yearbuilt 1985-2000
    // These buildings are 25-40 years old — prime roofing leads
    const baseUrl = 'https://app.regrid.com/api/v1/parcels/search';

    // Use Regrid's parcel search with filters
    // context = /us/mn/hennepin for Hennepin County
    const queries = [
      { context: '/us/mn/hennepin', label: 'Hennepin County' },
      { context: '/us/mn/ramsey',   label: 'Ramsey County'   },
      { context: '/us/mn/dakota',   label: 'Dakota County'   },
      { context: '/us/mn/anoka',    label: 'Anoka County'    },
    ];

    const allParcels = [];

    for (const q of queries) {
      // Regrid v1 parcel search by path + filters
      const url = `https://app.regrid.com/api/v1/search.json?` + [
        `context=${encodeURIComponent(q.context)}`,
        `token=${token}`,
        `return_custom_id=false`,
        `limit=100`,
        `page=1`
      ].join('&');

      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        allParcels.push({ county: q.label, error: `HTTP ${response.status}` });
        continue;
      }

      const data = await response.json();
      if (data.results) {
        allParcels.push({ county: q.label, count: data.results.length, sample: data.results[0]?.properties?.fields });
      } else {
        allParcels.push({ county: q.label, response: JSON.stringify(data).slice(0, 200) });
      }
    }

    return res.status(200).json({
      message: 'Regrid connection test',
      results: allParcels
    });

  } catch(err) {
    return res.status(200).json({ error: err.message, stack: err.stack?.slice(0,300) });
  }
};
