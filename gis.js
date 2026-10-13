// gis.js — "Download for GIS": cut a lon/lat box out of the MESA COGs in the browser and save a ZIP with
//   <name>_mesa_dem.tif (+ .tfw, .prj)   float32 meters, nodata -9999, the source's own GeoKeys (Mars equirectangular)
//   <name>_mesa_mask.tif (+ .tfw, .prj)  uint8, 0 = predicted from CTX, 1 = infilled, 255 = nodata
//   README.txt
// Needs geotiff.js (window.GeoTIFF) and JSZip (window.JSZip). Only the COG tiles that intersect the box are read
// (HTTP range requests; the data host must send CORS headers that allow Range and expose Content-Range).
(function () {
  'use strict';
  const R = 3396190, D2R = Math.PI / 180;

  // GeoKey names (as geotiff.js reports them) -> ids, and which keys are SHORT or ASCII; all others are DOUBLE.
  const KEY_IDS = { GTModelTypeGeoKey: 1024, GTRasterTypeGeoKey: 1025, GTCitationGeoKey: 1026, GeographicTypeGeoKey: 2048,
    GeogCitationGeoKey: 2049, GeogGeodeticDatumGeoKey: 2050, GeogPrimeMeridianGeoKey: 2051, GeogLinearUnitsGeoKey: 2052,
    GeogLinearUnitSizeGeoKey: 2053, GeogAngularUnitsGeoKey: 2054, GeogAngularUnitSizeGeoKey: 2055, GeogEllipsoidGeoKey: 2056,
    GeogSemiMajorAxisGeoKey: 2057, GeogSemiMinorAxisGeoKey: 2058, GeogInvFlatteningGeoKey: 2059, GeogAzimuthUnitsGeoKey: 2060,
    GeogPrimeMeridianLongGeoKey: 2061, ProjectedCSTypeGeoKey: 3072, PCSCitationGeoKey: 3073, ProjectionGeoKey: 3074,
    ProjCoordTransGeoKey: 3075, ProjLinearUnitsGeoKey: 3076, ProjLinearUnitSizeGeoKey: 3077, ProjStdParallel1GeoKey: 3078,
    ProjStdParallel2GeoKey: 3079, ProjNatOriginLongGeoKey: 3080, ProjNatOriginLatGeoKey: 3081, ProjFalseEastingGeoKey: 3082,
    ProjFalseNorthingGeoKey: 3083, ProjFalseOriginLongGeoKey: 3084, ProjFalseOriginLatGeoKey: 3085, ProjFalseOriginEastingGeoKey: 3086,
    ProjFalseOriginNorthingGeoKey: 3087, ProjCenterLongGeoKey: 3088, ProjCenterLatGeoKey: 3089, ProjCenterEastingGeoKey: 3090,
    ProjCenterNorthingGeoKey: 3091, ProjScaleAtNatOriginGeoKey: 3092, ProjScaleAtCenterGeoKey: 3093, ProjAzimuthAngleGeoKey: 3094,
    ProjStraightVertPoleLongGeoKey: 3095, VerticalCSTypeGeoKey: 4096, VerticalCitationGeoKey: 4097, VerticalDatumGeoKey: 4098,
    VerticalUnitsGeoKey: 4099 };
  const SHORT = new Set([1024, 1025, 2048, 2050, 2051, 2052, 2054, 2056, 2060, 3072, 3074, 3075, 3076, 4096, 4098, 4099]);

  const PRJ = 'PROJCS["Mars_Equidistant_Cylindrical",GEOGCS["GCS_Mars_2000_Sphere",DATUM["D_Mars_2000_Sphere",' +
    'SPHEROID["Mars_2000_Sphere_IAU_IAG",3396190.0,0.0]],PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]],' +
    'PROJECTION["Equidistant_Cylindrical"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],' +
    'PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],UNIT["Meter",1.0]]';

  function encodeGeoKeys(keys) {
    const entries = Object.entries(keys).map(([n, v]) => [KEY_IDS[n], v]).filter(([id, v]) => id && v !== undefined && v !== null)
      .sort((a, b) => a[0] - b[0]);
    const dir = [1, 1, 0, entries.length], doubles = [];
    let ascii = '';
    for (const [id, v] of entries) {
      if (typeof v === 'string') { const s = v.replace(/\|$/, '') + '|'; dir.push(id, 34737, s.length, ascii.length); ascii += s; }
      else if (SHORT.has(id)) dir.push(id, 0, 1, Array.isArray(v) ? v[0] : v);
      else { const a = Array.isArray(v) ? v : [v]; dir.push(id, 34736, a.length, doubles.length); doubles.push(...a); }
    }
    return { dir, doubles, ascii };
  }

  // Minimal little-endian, uncompressed, stripped GeoTIFF writer (one band).
  function writeGeoTiff(w, h, data, bits, sampleFormat, geo, nodata) {
    const rowBytes = w * bits / 8, rps = Math.max(1, Math.min(h, Math.floor(262144 / rowBytes))), ns = Math.ceil(h / rps);
    const offs = new Array(ns).fill(0), counts = new Array(ns).fill(0);
    const tags = [[256, 4, [w]], [257, 4, [h]], [258, 3, [bits]], [259, 3, [1]], [262, 3, [1]], [273, 4, offs], [277, 3, [1]],
      [278, 4, [rps]], [279, 4, counts], [284, 3, [1]], [339, 3, [sampleFormat]], [33550, 12, geo.scale], [33922, 12, geo.tie],
      [34735, 3, geo.keys.dir]];
    if (geo.keys.doubles.length) tags.push([34736, 12, geo.keys.doubles]);
    if (geo.keys.ascii.length) tags.push([34737, 2, geo.keys.ascii]);
    if (nodata !== null) tags.push([42113, 2, String(nodata)]);
    const SZ = { 2: 1, 3: 2, 4: 4, 12: 8 }, ifdSize = 2 + tags.length * 12 + 4;
    let extra = 0;
    const lay = tags.map(([tag, type, vals]) => {
      const count = type === 2 ? vals.length + 1 : vals.length, size = count * SZ[type];
      const r = { tag, type, vals, count, off: null };
      if (size > 4) { r.off = 8 + ifdSize + extra; extra += size + (size & 1); }
      return r;
    });
    const start = 8 + ifdSize + extra;
    for (let i = 0; i < ns; i++) { offs[i] = start + i * rps * rowBytes; counts[i] = Math.min(rps, h - i * rps) * rowBytes; }
    const buf = new ArrayBuffer(start + h * rowBytes), dv = new DataView(buf);
    dv.setUint16(0, 0x4949, true); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, tags.length, true);
    const put = (r, at) => {
      if (r.type === 2) { for (let i = 0; i < r.vals.length; i++) dv.setUint8(at + i, r.vals.charCodeAt(i)); dv.setUint8(at + r.vals.length, 0); }
      else r.vals.forEach((v, i) => (r.type === 3 ? dv.setUint16(at + 2 * i, v, true) : r.type === 4 ? dv.setUint32(at + 4 * i, v, true) : dv.setFloat64(at + 8 * i, v, true)));
    };
    lay.forEach((r, i) => {
      const p = 10 + i * 12;
      dv.setUint16(p, r.tag, true); dv.setUint16(p + 2, r.type, true); dv.setUint32(p + 4, r.count, true);
      if (r.off === null) put(r, p + 8); else { dv.setUint32(p + 8, r.off, true); put(r, r.off); }
    });
    dv.setUint32(10 + tags.length * 12, 0, true);
    new Uint8Array(buf, start).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return buf;
  }

  async function open(url) {
    const tiff = await window.GeoTIFF.fromUrl(url, { allowFullFile: false });
    const n = await tiff.getImageCount(), images = [];
    for (let i = 0; i < n; i++) images.push(await tiff.getImage(i));
    return images;
  }

  // Pixel window (on overview `level`, 0 = full resolution) for a lon/lat box on the global eqc grid.
  function windowFor(images, level, b) {
    const im0 = images[0], [x0, y0] = im0.getOrigin(), [sx0, sy0] = im0.getResolution();
    const im = images[level], f = im0.getWidth() / im.getWidth(), sx = sx0 * f, sy = Math.abs(sy0) * f;
    const xW = R * b.w * D2R, xE = R * b.e * D2R, yN = R * b.n * D2R, yS = R * b.s * D2R;
    const c0 = Math.max(0, Math.floor((xW - x0) / sx)), c1 = Math.min(im.getWidth(), Math.ceil((xE - x0) / sx));
    const r0 = Math.max(0, Math.floor((y0 - yN) / sy)), r1 = Math.min(im.getHeight(), Math.ceil((y0 - yS) / sy));
    return { c0, c1, r0, r1, w: c1 - c0, h: r1 - r0, sx, sy, ulx: x0 + c0 * sx, uly: y0 - r0 * sy };
  }

  function worldFile(win) {
    return [win.sx, 0, 0, -win.sy, win.ulx + win.sx / 2, win.uly - win.sy / 2].map((v) => v.toFixed(10)).join('\r\n') + '\r\n';
  }

  async function cut(url, level, b, kind, onProgress) {
    const images = await open(url);
    if (level >= images.length) level = images.length - 1;
    const win = windowFor(images, level, b);
    if (win.w <= 0 || win.h <= 0) throw new Error('The area lies outside the grid.');
    onProgress && onProgress(`Reading ${kind} (${win.w.toLocaleString()} × ${win.h.toLocaleString()} pixels)…`);
    const [band] = await images[level].readRasters({ window: [win.c0, win.r0, win.c1, win.r1] });
    const keys = encodeGeoKeys(images[0].getGeoKeys());
    const geo = { scale: [win.sx, win.sy, 0], tie: [0, 0, 0, win.ulx, win.uly, 0], keys };
    const isFloat = band instanceof Float32Array;
    const tif = writeGeoTiff(win.w, win.h, band, isFloat ? 32 : 8, isFloat ? 3 : 1, geo, isFloat ? -9999 : 255);
    return { tif, win };
  }

  // b = {w, e, s, n, slug, label}; level = overview level (0 = 18 m); urls = {dem, mask}
  async function download(urls, b, level, onProgress) {
    const name = `${b.slug}_mesa`;
    const dem = await cut(urls.dem, level, b, 'elevation', onProgress);
    const mask = urls.mask ? await cut(urls.mask, level, b, 'mask', onProgress) : null;
    onProgress && onProgress('Packing the ZIP…');
    const zip = new window.JSZip(), px = (dem.win.sx).toFixed(1);
    zip.file(`${name}_dem.tif`, dem.tif); zip.file(`${name}_dem.tfw`, worldFile(dem.win)); zip.file(`${name}_dem.prj`, PRJ);
    if (mask) { zip.file(`${name}_mask.tif`, mask.tif); zip.file(`${name}_mask.tfw`, worldFile(mask.win)); zip.file(`${name}_mask.prj`, PRJ); }
    zip.file('README.txt', [
      `MESA (Mars Elevation from Shading and Altimetry), subset "${b.label}"`,
      `Longitude ${b.w} to ${b.e} °E, latitude ${b.s} to ${b.n} °N`,
      `Pixel size ${px} m on the global grid (simple cylindrical, Mars sphere R = 3,396,190 m, central meridian 0°)`,
      `${dem.win.w} × ${dem.win.h} pixels`,
      '',
      `${name}_dem.tif   elevation in meters above the MOLA areoid, float32, nodata -9999`,
      mask ? `${name}_mask.tif  0 = predicted from CTX, 1 = infilled, 255 = nodata` : '',
      '.tfw = world file, .prj = projection (ESRI WKT). The GeoTIFFs also carry the coordinate system internally.',
      '',
      'Source: https://planetarydems.org', ''].join('\r\n'));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
    const file = `${name}.zip`;
    if (window.__onDownload) await window.__onDownload(file, blob);      // test hook
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
    return { file, bytes: blob.size, w: dem.win.w, h: dem.win.h, px: dem.win.sx };
  }

  window.MESAGis = { download, windowFor, encodeGeoKeys, writeGeoTiff };
})();
