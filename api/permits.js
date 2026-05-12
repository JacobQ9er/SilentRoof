// Diagnostic — explore LAND_PROPERTY MapServer layers and fields

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    // Get all layers in LAND_PROPERTY
    const rootUrl = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer?f=json';
    const rootRes = await fetch(rootUrl);
    const root = await rootRes.json();

    const layers = root.layers?.map(l => ({ id: l.id, name: l.name })) || [];

    // For each layer, grab field names and a sample record
    const layerDetails = [];
    for (const layer of layers.slice(0, 6)) { // check first 6 layers
      try {
        const url = `https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/${layer.id}/query?where=1%3D1&outFields=*&resultRecordCount=1&f=json`;
        const r = await fetch(url);
        const data = await r.json();
        layerDetails.push({
          id: layer.id,
          name: layer.name,
          fields: data.fields?.map(f => f.name) || [],
          sample: data.features?.[0]?.attributes || null,
          error: data.error?.message || null
        });
      } catch(e) {
        layerDetails.push({ id: layer.id, name: layer.name, error: e.message });
      }
    }

    return res.status(200).json({ layers, layerDetails });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
