// Vercel serverless function — Hennepin County LAND_PROPERTY MapServer
// Layer 1: County Parcels
// Confirmed fields: BUILD_YR, PR_TYP_NM1, OWNER_NM, HOUSE_NO, STREET_NM,
//                   MAILING_MUNIC_NM, ZIP_CD, BLDG_MV1, LAT, LON

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const BASE = 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1/query';
  const NOW_YEAR = new Date().getFullYear();
  const CYCLE = 30;

  // Ping test
  if (req.query?.ping === '1') {
    try {
      const url = `${BASE}?where=BUILD_YR%3D'1990'&outFields=BUILD_YR,PR_TYP_NM1,OWNER_NM,HOUSE_NO,STREET_NM,MAILING_MUNIC_NM,ZIP_CD,BLDG_MV1,LAT,LON&resultRecordCount=2&f=json`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json({
        ping: true,
        count: data.features?.length || 0,
        sample: data.features?.[0]?.attributes || null,
        error: data.error?.message || null
      });
    } catch(e) {
      return res.status(200).json({ ping: true, error: e.message });
    }
  }

  try {
    // Commercial/Industrial property type codes in Hennepin County:
    // COMMERCIAL, INDUSTRIAL, APARTMENT, OFFICE — skip RESIDENTIAL and AGRICULTURAL
    // BUILD_YR is a string field based on sample ("1965")
    // Query buildings built 1985-2000 with building value > $100K (filters out small sheds)
    const where = `BUILD_YR >= '1985' AND BUILD_YR <= '2000' AND BLDG_MV1 > 100000 AND PR_TYP_CD1 <> 'R'`;

    const fields = [
      'PID','BUILD_YR','PR_TYP_CD1','PR_TYP_NM1',
      'OWNER_NM','HOUSE_NO','STREET_NM',
      'MAILING_MUNIC_NM','ZIP_CD',
      'BLDG_MV1','MKT_VAL_TOT',
      'LAT','LON'
    ].join(',');

    const params = new URLSearchParams({
      where,
      outFields: fields,
      resultRecordCount: '1000',
      orderByFields: 'BUILD_YR ASC',
      f: 'json'
    });

    const response = await fetch(`${BASE}?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();

    if (data.error) {
      return res.status(200).json({
        error: data.error.message,
        query: where
      });
    }

    const leads = (data.features || [])
      .map((f, i) => {
        const p = f.attributes;
        const yb = parseInt(p.BUILD_YR);
        if (!yb || isNaN(yb)) return null;

        const yearsLeft = (yb + CYCLE) - NOW_YEAR;
        const addr = `${String(p.HOUSE_NO || '').trim()} ${String(p.STREET_NM || '').trim()}`.trim();
        const city = String(p.MAILING_MUNIC_NM || '').trim();

        return {
          id: i + 1,
          name: String(p.OWNER_NM || addr || 'Commercial Property').trim(),
          addr: addr || '—',
          city: city || 'Hennepin County',
          zip: String(p.ZIP_CD || '').trim(),
          type: String(p.PR_TYP_NM1 || 'Commercial').trim(),
          yearBuilt: yb,
          yearsLeft,
          permitDate: `${yb}-01-01`,
          permitNum: String(p.PID || '—'),
          estVal: p.BLDG_MV1 || p.MKT_VAL_TOT || 0,
          lat: p.LAT || null,
          lng: p.LON || null,
          source: 'live'
        };
      })
      .filter(Boolean)
      .filter(l => l.yearsLeft <= 15)
      .sort((a, b) => a.yearsLeft - b.yearsLeft);

    return res.status(200).json({
      features: leads,
      totalFiltered: leads.length,
      totalFromAPI: data.features?.length || 0
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
