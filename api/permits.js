// Diagnostic — find correct layer index in Hennepin County FeatureServer

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // Check the FeatureServer root — lists all available layers
    const urls = [
      'https://gis.hennepin.us/arcgis/rest/services/HennepinData/COUNTY_PARCELS_TEST/FeatureServer?f=json',
      'https://gis.hennepin.us/arcgis/rest/services/HennepinData/COUNTY_PARCELS_TEST/FeatureServer/0?f=json',
      'https://gis.hennepin.us/arcgis/rest/services/HennepinData/COUNTY_PARCELS_TEST/MapServer?f=json',
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
          layers: data.layers?.map(l => ({ id: l.id, name: l.name })) || null,
          fields: data.fields?.map(f => f.name) || null,
          error: data.error?.message || null,
          maxRecordCount: data.maxRecordCount || null,
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
