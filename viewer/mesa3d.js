// mesa3d.js — interactive 3-D view of a MESA site: CTX images draped on the 18 m DEM, with a morph to MOLA.
// Usage: const v = await createViewer(container, 'sites/jezero/', {quality: 'auto'});
//   v.setSurface('mesa' | 'mola')  animated morph between the two DEMs (same grid, same texture)
//   v.setDrape('ctx' | 'color')     CTX images, or colour elevation over a hillshade
//   v.setExaggeration(x)            vertical exaggeration
//   v.resetView(), v.setAutoRotate(bool), v.capture(w, h) -> PNG Blob, v.dispose()
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const DEG = Math.PI / 180;

async function loadHeights(url, zmin, zmax) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const n = bmp.width * bmp.height, out = new Float32Array(n), k = (zmax - zmin) / 65534;
  for (let i = 0; i < n; i++) {
    const v = px[4 * i] * 256 + px[4 * i + 1];
    out[i] = v ? zmin + (v - 1) * k : NaN;
  }
  return { w: bmp.width, h: bmp.height, z: out };
}

function loadTexture(url, renderer) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      resolve(t);
    }, undefined, reject);
  });
}

// Subsample a full-resolution height grid by `step` (box mean), filling NaN from the other surface.
function subsample(src, w, h, step) {
  if (step === 1) return { z: src, w, h };
  const W = Math.floor(w / step), H = Math.floor(h / step), z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    let s = 0, n = 0;
    for (let dr = 0; dr < step; dr++) for (let dc = 0; dc < step; dc++) {
      const v = src[(r * step + dr) * w + c * step + dc];
      if (v === v) { s += v; n++; }
    }
    z[r * W + c] = n ? s / n : NaN;
  }
  return { z, w: W, h: H };
}

export async function createViewer(container, base, opts = {}) {
  base = base.endsWith('/') ? base : base + '/';
  const url = (name) => (opts.files && opts.files[name]) || base + name;   // opts.files: embedded copies (standalone page)
  const meta = await (await fetch(url('meta.json'))).json();
  const mobile = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
  const quality = opts.quality || 'auto';
  const step = quality === 'high' ? 1 : quality === 'low' ? 2 : (mobile ? 2 : 1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!opts.capture });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'none';

  const ctxUrl = opts.fullTexture ? 'ctx_full.jpg' : 'ctx.jpg';
  const [hm, hl, texCtx, texCm, texCl] = await Promise.all([
    loadHeights(url('height_mesa.png'), meta.zmin, meta.zmax),
    loadHeights(url('height_mola.png'), meta.zmin, meta.zmax),
    loadTexture(url(ctxUrl), renderer),
    loadTexture(url('color_mesa.jpg'), renderer),
    loadTexture(url('color_mola.jpg'), renderer),
  ]);
  const A = subsample(hm.z, hm.w, hm.h, step), B = subsample(hl.z, hl.w, hl.h, step);
  const cols = A.w, rows = A.h;
  const Wkm = meta.width_km * (cols * step) / hm.w, Hkm = meta.height_km * (rows * step) / hm.h;
  for (let i = 0; i < A.z.length; i++) { if (A.z[i] !== A.z[i]) A.z[i] = B.z[i]; if (B.z[i] !== B.z[i]) B.z[i] = A.z[i]; }
  const zref = meta.zmin, zbase = -(meta.zmax - meta.zmin) * 0.06 / 1000 - 0.15;   // km, below the lowest point

  // ---- terrain: positions in km (x east, y up, z south), MOLA as a morph target ----
  const n = cols * rows;
  const posA = new Float32Array(3 * n), posB = new Float32Array(3 * n), uv = new Float32Array(2 * n);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, x = ((c + 0.5) / cols - 0.5) * Wkm, z = ((r + 0.5) / rows - 0.5) * Hkm;
    posA[3 * i] = posB[3 * i] = x; posA[3 * i + 2] = posB[3 * i + 2] = z;
    posA[3 * i + 1] = (A.z[i] - zref) / 1000; posB[3 * i + 1] = (B.z[i] - zref) / 1000;
    uv[2 * i] = (c + 0.5) / cols; uv[2 * i + 1] = 1 - (r + 0.5) / rows;
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
    idx[k++] = a; idx[k++] = d; idx[k++] = b; idx[k++] = b; idx[k++] = d; idx[k++] = e;
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('position', new THREE.BufferAttribute(posB, 3));
  geo.computeVertexNormals();
  const nrmB = geo.getAttribute('normal').array.slice();
  geo.setAttribute('position', new THREE.BufferAttribute(posA, 3));
  geo.computeVertexNormals();
  geo.morphAttributes.position = [new THREE.BufferAttribute(posB, 3)];
  geo.morphAttributes.normal = [new THREE.BufferAttribute(nrmB, 3)];
  geo.computeBoundingSphere();

  const mat = new THREE.MeshLambertMaterial({ map: texCtx });
  const terrain = new THREE.Mesh(geo, mat);
  terrain.morphTargetInfluences = [0];

  // ---- skirt: four walls from the terrain edge down to a flat base, morphing with the terrain ----
  const edge = [];
  for (let c = 0; c < cols; c++) edge.push([0, c]);
  for (let r = 1; r < rows; r++) edge.push([r, cols - 1]);
  for (let c = cols - 2; c >= 0; c--) edge.push([rows - 1, c]);
  for (let r = rows - 2; r >= 1; r--) edge.push([r, 0]);
  edge.push([0, 0]);
  const m = edge.length, sA = new Float32Array(6 * m), sB = new Float32Array(6 * m);
  edge.forEach(([r, c], j) => {
    const i = r * cols + c;
    for (const [P, src] of [[sA, posA], [sB, posB]]) {
      P[6 * j] = P[6 * j + 3] = src[3 * i]; P[6 * j + 2] = P[6 * j + 5] = src[3 * i + 2];
      P[6 * j + 1] = src[3 * i + 1]; P[6 * j + 4] = zbase;
    }
  });
  const sidx = [];
  for (let j = 0; j < m - 1; j++) { const a = 2 * j, b = a + 1, c2 = a + 2, d = a + 3; sidx.push(a, b, c2, c2, b, d); }
  const sgeo = new THREE.BufferGeometry();
  sgeo.setIndex(sidx);
  sgeo.setAttribute('position', new THREE.BufferAttribute(sA, 3));
  sgeo.morphAttributes.position = [new THREE.BufferAttribute(sB, 3)];
  const skirt = new THREE.Mesh(sgeo, new THREE.MeshBasicMaterial({ color: 0x2a221d, side: THREE.DoubleSide }));
  skirt.morphTargetInfluences = [0];
  const bottom = new THREE.Mesh(new THREE.PlaneGeometry(Wkm, Hkm), new THREE.MeshBasicMaterial({ color: 0x1d1814, side: THREE.DoubleSide }));
  bottom.rotation.x = -Math.PI / 2; bottom.position.y = zbase;

  const block = new THREE.Group();
  block.add(terrain, skirt, bottom);
  const scene = new THREE.Scene();
  scene.add(block);

  // ---- light: the Sun of the CTX images (azimuth fitted to the texture's shading), plus a strong ambient term so
  //      the image's own shading dominates and the DEM's shading only adds depth ----
  const az = (meta.checks?.sun_az ?? 270) * DEG, alt = Math.max(15, meta.checks?.sun_alt ?? 35) * DEG;
  const sunDir = (el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(100);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  const amb = new THREE.AmbientLight(0xffffff, 1.6);
  const fill = new THREE.DirectionalLight(0xffffff, 0);           // relief mode only: keeps shaded faces readable
  fill.position.set(-Math.sin(az) * 0.5, 1, Math.cos(az) * 0.5).multiplyScalar(100);
  scene.add(sun, amb, fill);
  // Per drape: [sun elevation, sun intensity, ambient, fill]. Image drapes keep flat ground equally bright whatever the
  // Sun's height (intensity ~ 1 / sin(elevation)); relief uses a low Sun from the images' azimuth to show shape.
  const LIGHT = {
    ctx: [alt, opts.sun ?? meta.view?.sun ?? 0.55 / Math.sin(alt), opts.ambient ?? meta.view?.amb ?? 1.6, 0],
    color: [alt, opts.sun ?? meta.view?.sun ?? 0.55 / Math.sin(alt), opts.ambient ?? meta.view?.amb ?? 1.6, 0],
    relief: [28 * DEG, 2.0, 0.42, 0.28],
  };
  function light(mode) {
    const [el, si, ai, fi] = LIGHT[mode];
    sun.position.copy(sunDir(el)); sun.intensity = si; amb.intensity = ai; fill.intensity = fi;
  }
  light('ctx');

  // ---- camera ----
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 32, 1, 0.01, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.maxPolarAngle = 88 * DEG;
  controls.minDistance = Math.max(Wkm, Hkm) * 0.08; controls.maxDistance = Math.max(Wkm, Hkm) * 4;
  controls.zoomToCursor = true;
  controls.autoRotateSpeed = 0.6;

  let ve = opts.exaggeration ?? meta.view?.ve ?? 3;
  function applyVE() {
    block.scale.y = ve;
    const span = (meta.zmax - meta.zmin) / 1000 * ve;
    controls.target.set(0, span * 0.35, 0);
  }
  // Height (km, before exaggeration) of the MESA surface at map position (east, north) in km from the centre.
  function heightAt(e, nth) {
    const c = Math.min(cols - 1, Math.max(0, Math.round((e / Wkm + 0.5) * cols - 0.5)));
    const r = Math.min(rows - 1, Math.max(0, Math.round((-nth / Hkm + 0.5) * rows - 0.5)));
    return posA[3 * (r * cols + c) + 1];
  }
  // View: az = azimuth of the camera seen from the target (deg clockwise from north), el = elevation (deg),
  // dist = distance in units of the block diagonal, te/tn = target east/north of the centre (km, on the surface).
  function resetView(v = meta.view || {}) {
    ve = v.ve ?? ve; applyVE();
    if (v.te !== undefined || v.tn !== undefined) {
      const te = v.te ?? 0, tn = v.tn ?? 0;
      controls.target.set(te, heightAt(te, tn) * ve, -tn);
    }
    if (v.fov) { camera.fov = v.fov; camera.updateProjectionMatrix(); }
    const vaz = (v.az ?? 200) * DEG, vel = (v.el ?? 32) * DEG, dist = (v.dist ?? 1.25) * Math.hypot(Wkm, Hkm);
    camera.position.set(Math.sin(vaz) * Math.cos(vel), Math.sin(vel), -Math.cos(vaz) * Math.cos(vel))
      .multiplyScalar(dist).add(controls.target);
    controls.update();
  }
  function currentView() {
    const d = camera.position.clone().sub(controls.target), L = d.length();
    return { az: +((Math.atan2(d.x, -d.z) / DEG + 360) % 360).toFixed(1), el: +(Math.asin(d.y / L) / DEG).toFixed(1),
      dist: +(L / Math.hypot(Wkm, Hkm)).toFixed(3), te: +controls.target.x.toFixed(2), tn: +(-controls.target.z).toFixed(2), ve, fov: camera.fov };
  }

  function resize() {
    const w = container.clientWidth || 800, h = container.clientHeight || 500;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize(); resetView();

  // ---- morph animation ----
  let surface = 'mesa', anim = null, drape = 'ctx';
  function setSurface(s, ms = 900) {
    surface = s;
    const from = terrain.morphTargetInfluences[0], to = s === 'mola' ? 1 : 0, t0 = performance.now();
    anim = (now) => {
      const t = Math.min(1, (now - t0) / ms), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const v = from + (to - from) * e;
      terrain.morphTargetInfluences[0] = skirt.morphTargetInfluences[0] = v;
      if (t >= 1) anim = null;
    };
    if (drape === 'color') { mat.map = s === 'mola' ? texCl : texCm; mat.needsUpdate = true; }
  }
  // 'ctx' = CTX images, 'color' = colour elevation over a hillshade, 'relief' = the DEM's own shading only (no image):
  // the honest way to compare two DEMs, since an image drape lends any surface its detail.
  function setDrape(d) {
    drape = d;
    mat.map = d === 'ctx' ? texCtx : d === 'color' ? (surface === 'mola' ? texCl : texCm) : null;
    mat.color.set(d === 'relief' ? 0xd9d0c4 : 0xffffff);
    light(d);
    mat.needsUpdate = true;
  }

  let running = true;
  renderer.setAnimationLoop((now) => {
    if (!running) return;
    if (anim) anim(now);
    controls.update();
    renderer.render(scene, camera);
  });

  async function capture(w, h) {
    const W0 = renderer.domElement.width, H0 = renderer.domElement.height, pr = renderer.getPixelRatio();
    renderer.setPixelRatio(1); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const blob = await new Promise((res) => renderer.domElement.toBlob(res, 'image/png'));
    renderer.setPixelRatio(pr); resize();
    return blob;
  }

  return {
    meta, scene, camera, controls, renderer, terrain,
    setSurface, setDrape, resetView, currentView, heightAt,
    setSurfaceNow(x) { anim = null; terrain.morphTargetInfluences[0] = skirt.morphTargetInfluences[0] = x; },
    setExaggeration(x) { const t = controls.target.clone(); ve = x; applyVE(); camera.position.add(controls.target.clone().sub(t)); },
    get exaggeration() { return ve; },
    setAutoRotate(b) { controls.autoRotate = b; },
    setLight(sunI, ambI) { sun.intensity = sunI; amb.intensity = ambI; },
    capture,
    dispose() { running = false; ro.disconnect(); renderer.setAnimationLoop(null); renderer.dispose(); geo.dispose(); sgeo.dispose();
      [texCtx, texCm, texCl].forEach((t) => t.dispose()); renderer.domElement.remove(); },
  };
}
