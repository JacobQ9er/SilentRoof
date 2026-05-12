// Diagnostic — list all available services on Hennepin County ArcGIS server

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const urls = [
      'https://gis.hennepin.us/arcgis/rest/services?f=json',
      'https://gis.hennepin.us/arcgis/rest/services/HennepinData?f=json',
      'https://gis.hennepin.us/arcgis/rest/services/Geoprocessing?f=json',
    ];

    const results = [];
    for (const url of urls) {
      try {
        const r = await fetch(url);
        const text = await r.text();
        const data = JSON.parse(text);
        results.push({
          url,
          status: r.status,
          folders: data.folders || null,
          services: data.services?.map(s => `${s.name} (${s.type})`) || null,
          error: data.error?.message || null
        });
      } catch(e) {
        results.push({ url, error: e.message });
      }
    }

    return res.status(200).json({ diagnostic: true, results });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
