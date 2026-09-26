// OX81 package builder: turns one real XrayResult into an IC package.
// Owner: art-director. site-builder copies this into site/src/scene/chip.js; brand-kit imports it as-is.
//
//   import { buildPackage } from './chip.js';
//   const chip = buildPackage(THREE, xray, { markFont: 'Archivo', monoFont: 'Atkinson Hyperlegible Mono' });
//   scene.add(chip.group);                   // units are millimetres; y is up; the seating plane is y = 0
//   chip.pins[i]  -> { pin, range, side, tip: Vector3 (local), base: Vector3 (local) }
//
// Data rules (these are what make it this coin's object and not "a chip"):
//   - one lead per ByteRange, in offset order, counter-clockwise from pin 1 (top-left in top view);
//   - pin 1 is always offset 0; only for v1 is that the 0x81 byte, and only then does it glow (heat).
//     v0's 0x80 sits at offset 1+64n and legacy has no prefix: both stay cold tin;
//   - body area is proportional to tx size: side = 14 mm * sqrt(size / 4096);
//   - v1 and v0 are QFPs (4 sides); legacy is an SOIC (2 sides), because it is the old breed;
//   - the laser marking carries the part number, size, config mask, slot and the byte strip.

export const PALETTE = {
  sheet: '#EDEEEB', sheet2: '#E1E3DF', ink: '#121315', graphite: '#5B5F63', tin: '#A9AEB2',
  epoxy: '#16171A', heat: '#FF4B12', gold: '#C8A04A', laser: '#8C9094',
};

// The mark as 8 bytes (rows top to bottom). Row 0 is 0x81: the horn tips.
export const MARK_ROWS = [0x81, 0x81, 0xff, 0xdb, 0x7e, 0x3c, 0x3c, 0x18];

export function packageSpec(xray) {
  const n = xray.ranges.length;
  const sides = xray.version === 'legacy' ? 2 : 4;
  const S = 14 * Math.sqrt(Math.max(xray.size, 64) / 4096); // body side, mm
  const T = 1.4;                                             // body thickness (LQFP 1.4)
  const counts = [];
  for (let s = 0; s < sides; s++) counts.push(Math.floor(n / sides) + (s < n % sides ? 1 : 0));
  const maxPer = Math.max(...counts);
  const pitch = (S * 0.9) / maxPer;
  const leadW = Math.min(0.3, pitch * 0.46);
  return { n, sides, S, T, counts, pitch, leadW, standoff: 0.1, leadT: 0.15, reach: 1.05 };
}

function leadGeometry(THREE, spec) {
  // Gull-wing lead: centreline in (u outward, v up), thickened by leadT, extruded along the width.
  const t = spec.leadT, vTop = spec.standoff + spec.T * 0.44, vFoot = t / 2, R = spec.reach;
  const c = [[-0.4, vTop], [0.12, vTop]];
  const P0 = [0.12, vTop], P1 = [0.3, vTop], P2 = [0.3, vFoot], P3 = [0.5, vFoot];
  for (let i = 1; i <= 14; i++) {
    const s = i / 14, a = (1 - s) ** 3, b = 3 * (1 - s) ** 2 * s, d = 3 * (1 - s) * s * s, e = s ** 3;
    c.push([a * P0[0] + b * P1[0] + d * P2[0] + e * P3[0], a * P0[1] + b * P1[1] + d * P2[1] + e * P3[1]]);
  }
  c.push([R, vFoot]);
  const top = [], bot = [];
  for (let i = 0; i < c.length; i++) {
    const p = c[Math.max(0, i - 1)], q = c[Math.min(c.length - 1, i + 1)];
    let tx = q[0] - p[0], ty = q[1] - p[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const nx = -ty, ny = tx;
    top.push([c[i][0] + nx * t / 2, c[i][1] + ny * t / 2]);
    bot.push([c[i][0] - nx * t / 2, c[i][1] - ny * t / 2]);
  }
  const shape = new THREE.Shape();
  shape.moveTo(top[0][0], top[0][1]);
  for (let i = 1; i < top.length; i++) shape.lineTo(top[i][0], top[i][1]);
  for (let i = bot.length - 1; i >= 0; i--) shape.lineTo(bot[i][0], bot[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: spec.leadW, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1, steps: 1 });
  g.translate(0, 0, -spec.leadW / 2);
  g.computeVertexNormals();
  return g;
}

// Side frames in top view (x right, z toward the viewer). Pin 1 sits at the top-left (x-, z-).
function sideFrame(side, sides, S) {
  const h = S / 2;
  if (sides === 2) {
    // SOIC: left column top->bottom, right column bottom->top
    return side === 0
      ? { origin: [-h, -h], dir: [0, 1], out: [-1, 0], rotY: Math.PI }
      : { origin: [h, h], dir: [0, -1], out: [1, 0], rotY: 0 };
  }
  return [
    { origin: [-h, -h], dir: [0, 1], out: [-1, 0], rotY: Math.PI },       // left, top -> bottom
    { origin: [-h, h], dir: [1, 0], out: [0, 1], rotY: -Math.PI / 2 },   // bottom, left -> right
    { origin: [h, h], dir: [0, -1], out: [1, 0], rotY: 0 },               // right, bottom -> top
    { origin: [h, -h], dir: [-1, 0], out: [0, -1], rotY: Math.PI / 2 },   // top, right -> left
  ][side];
}

function noiseNormalTexture(THREE, size = 256) {
  // Fine sand-blasted mould-compound surface: blurred random height -> normals.
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = Math.random();
  const b = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += h[((y + dy + size) % size) * size + ((x + dx + size) % size)];
    b[y * size + x] = s / 9;
  }
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = b[y * size + ((x + 1) % size)] - b[y * size + ((x - 1 + size) % size)];
    const dy = b[((y + 1) % size) * size + x] - b[((y - 1 + size) % size) * size + x];
    const i = (y * size + x) * 4;
    d[i] = 128 + dx * 90; d[i + 1] = 128 + dy * 90; d[i + 2] = 255; d[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.needsUpdate = true;
  return tex;
}

const GROUP_ALPHA = { version: 1, header: 0.95, config: 0.95, lifetime: 0.7, count: 0.95, address: 0.32, instruction: 0.8, lookup: 0.6, signature: 0.95 };

export function drawMarking(xray, spec, opts = {}) {
  const px = opts.px || 2048, S = spec.S, k = px / S; // px per mm
  const cv = document.createElement('canvas'); cv.width = cv.height = px;
  const g = cv.getContext('2d');
  const laser = opts.laser || PALETTE.laser;
  const disp = opts.markFont || 'Archivo', mono = opts.monoFont || 'Atkinson Hyperlegible Mono';
  g.fillStyle = laser; g.textBaseline = 'alphabetic';
  // everything scales with the body; the block is centred with a 14% margin
  const u = S / 10.72;                     // 1 at the reference v1 size
  const x0 = S * 0.16, w = S - x0 * 2;
  const cell = 0.2 * u * k;
  let y = S * 0.3 * k;
  // mark (8x8 bits) + part number on one line
  MARK_ROWS.forEach((row, r) => { for (let c = 0; c < 8; c++) if (row & (0x80 >> c)) g.fillRect(x0 * k + c * cell, y - 8 * cell + r * cell, cell + 0.5, cell + 0.5); });
  const part = xray.version === 'v1' ? 'OX81-V1' : xray.version === 'v0' ? 'OX80-V0' : 'OX00-LGC';
  const fit = (txt, font, maxW) => { g.font = font; const m = g.measureText(txt).width; return m > maxW ? maxW / m : 1; };
  let f = `extra-condensed 800 ${1.9 * u * k}px "${disp}"`;
  const avail = w * k - cell * 8 - 0.5 * u * k;
  const sc = fit(part, f, avail);
  g.font = `extra-condensed 800 ${1.9 * u * k * sc}px "${disp}"`;
  g.fillText(part, x0 * k + cell * 8 + 0.5 * u * k, y);
  // lines
  const cfg = xray.config ? xray.config.maskHex : xray.discriminator ? xray.discriminator.hex + ' @ ' + xray.discriminator.offset : 'no prefix';
  const lines = [`${xray.size.toLocaleString('en-US')} B · ${cfg}`, `SLOT ${xray.meta ? xray.meta.slot : '-'}`];
  y += 1.25 * u * k;
  for (const l of lines) {
    const fs = 0.62 * u * k; const s2 = fit(l, `600 ${fs}px "${mono}"`, w * k);
    g.font = `600 ${fs * s2}px "${mono}"`; g.fillText(l, x0 * k, y); y += 0.95 * u * k;
  }
  // byte strip: every range as a segment, width by bytes (the chip's own "barcode")
  const bh = 0.5 * u * k, by = y - 0.3 * u * k;
  for (const r of xray.ranges) {
    const a = x0 * k + (r.start / xray.size) * w * k, b = x0 * k + (r.end / xray.size) * w * k;
    g.globalAlpha = GROUP_ALPHA[r.group] ?? 0.6;
    g.fillRect(a, by, Math.max(2, b - a - 2), bh);
  }
  g.globalAlpha = 1;
  y = by + bh + 0.85 * u * k;
  const last = `${spec.sides === 2 ? 'SOIC' : 'TQFP'}-${spec.n} · ${xray.version === 'v1' ? 'SIMD-0385' : xray.version.toUpperCase()}`;
  g.font = `600 ${0.48 * u * k}px "${mono}"`; g.fillText(last, x0 * k, y);
  return cv;
}

export function buildPackage(THREE, xray, opts = {}) {
  const spec = packageSpec(xray);
  const { S, T, standoff } = spec;
  const group = new THREE.Group(); group.name = 'ox81-package';

  // body
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: opts.epoxy || PALETTE.epoxy, roughness: 0.58, metalness: 0, clearcoat: 0.08, clearcoatRoughness: 0.6,
    normalMap: noiseNormalTexture(THREE), normalScale: new THREE.Vector2(0.18, 0.18),
  });
  bodyMat.normalMap.repeat.set(S * 1.6, S * 1.6);
  const RB = opts.RoundedBoxGeometry;
  const bodyGeo = RB ? new RB(S, T, S, 3, 0.14) : new THREE.BoxGeometry(S, T, S);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = standoff + T / 2; body.castShadow = true; body.receiveShadow = true; body.name = 'body';
  group.add(body);

  // marking decal (laser)
  const markCanvas = drawMarking(xray, spec, opts);
  const markTex = new THREE.CanvasTexture(markCanvas);
  markTex.colorSpace = THREE.SRGBColorSpace; markTex.anisotropy = 8;
  const mark = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshStandardMaterial({
    map: markTex, transparent: true, roughness: 0.86, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  mark.rotation.x = -Math.PI / 2; mark.position.y = standoff + T + 0.001; mark.name = 'marking';
  group.add(mark);

  // pin-1 dimple + ejector mark: slightly glossier discs, flush with the top
  const glossy = new THREE.MeshStandardMaterial({ color: '#0E0F11', roughness: 0.22, metalness: 0 });
  const satin = new THREE.MeshStandardMaterial({ color: '#131417', roughness: 0.42, metalness: 0, transparent: true, opacity: 0.7 });
  const dimple = new THREE.Mesh(new THREE.CircleGeometry(S * 0.036, 40), glossy);
  dimple.rotation.x = -Math.PI / 2; dimple.position.set(-S / 2 + S * 0.075, standoff + T + 0.002, -S / 2 + S * 0.075); group.add(dimple);
  const ej = new THREE.Mesh(new THREE.CircleGeometry(S * 0.05, 48), satin);
  ej.rotation.x = -Math.PI / 2; ej.position.set(S / 2 - S * 0.1, standoff + T + 0.002, S / 2 - S * 0.1); group.add(ej);

  // leads
  const leadGeo = leadGeometry(THREE, spec);
  const tinMat = new THREE.MeshPhysicalMaterial({ color: opts.tin || '#C3C8CC', metalness: 1, roughness: 0.3 });
  const heatMat = new THREE.MeshStandardMaterial({ color: '#4A1405', metalness: 0.2, roughness: 0.35, emissive: opts.heat || PALETTE.heat, emissiveIntensity: 2.2 });
  const inst = new THREE.InstancedMesh(leadGeo, tinMat, spec.n);
  inst.castShadow = true; inst.receiveShadow = true; inst.name = 'leads';
  const pins = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  let idx = 0;
  let pin1 = null;
  for (let s = 0; s < spec.sides; s++) {
    const f = sideFrame(s, spec.sides, S), count = spec.counts[s];
    const span = spec.pitch * (count - 1), start = (S - span) / 2;
    for (let j = 0; j < count; j++, idx++) {
      const d = start + j * spec.pitch;
      const bx = f.origin[0] + f.dir[0] * d, bz = f.origin[1] + f.dir[1] * d;
      q.setFromAxisAngle(up, f.rotY);
      m.compose(new THREE.Vector3(bx, 0, bz), q, one);
      const range = xray.ranges[idx];
      if (idx === 0 && xray.version === 'v1') { // only 0x81 is hot: v0 (0x80 at 1+64n) and legacy stay cold iron
        pin1 = new THREE.Mesh(leadGeo, heatMat); pin1.applyMatrix4(m); pin1.castShadow = true; pin1.name = 'pin1';
        group.add(pin1);
        m.makeScale(0, 0, 0); // hide instance 0
      }
      inst.setMatrixAt(idx, m);
      pins.push({
        pin: idx + 1, range, side: s,
        base: new THREE.Vector3(bx, standoff + T * 0.44, bz),
        tip: new THREE.Vector3(bx + f.out[0] * spec.reach, 0.08, bz + f.out[1] * spec.reach),
      });
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  group.add(inst);

  return { group, spec, pins, body, pin1, markCanvas, materials: { bodyMat, tinMat, heatMat } };
}

// ---------------------------------------------------------------------------------------------
// Test socket for the signature move ("Seat it"). One socket per reader profile.
// The pocket is cut to the part's own lead span, and a gold contact pad sits under every lead foot.
// y = 0 is the seating plane (pad tops), so a seated package has group.position.y = 0.
export function buildSocket(THREE, pkg, opts = {}) {
  const { spec, pins } = pkg;
  const span = spec.S + 2 * spec.reach;              // lead tip to lead tip
  const inner = span + 0.7, rim = opts.rim ?? 3.2, outer = inner + rim * 2, H = 1.25;
  const group = new THREE.Group(); group.name = 'ox81-socket';
  const alu = new THREE.MeshPhysicalMaterial({ color: '#B4B9BD', metalness: 1, roughness: 0.42 });
  // frame: outer square minus pocket, extruded upward
  const sh = new THREE.Shape([[-outer / 2, -outer / 2], [outer / 2, -outer / 2], [outer / 2, outer / 2], [-outer / 2, outer / 2]].map(([x, y]) => new THREE.Vector2(x, y)));
  sh.holes.push(new THREE.Path([[-inner / 2, -inner / 2], [-inner / 2, inner / 2], [inner / 2, inner / 2], [inner / 2, -inner / 2]].map(([x, y]) => new THREE.Vector2(x, y))));
  const fg = new THREE.ExtrudeGeometry(sh, { depth: H, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2 });
  fg.rotateX(-Math.PI / 2);
  const frame = new THREE.Mesh(fg, alu); frame.castShadow = frame.receiveShadow = true; group.add(frame);
  // pocket floor (dark insulator, PEEK-black), slightly below the pads
  const floor = new THREE.Mesh(new THREE.BoxGeometry(inner, 0.6, inner), new THREE.MeshStandardMaterial({ color: '#1B1C1F', roughness: 0.7 }));
  floor.position.y = -0.34; floor.receiveShadow = true; group.add(floor);
  // gold pads under each lead foot (gold = contact, everywhere in this world)
  const gold = new THREE.MeshPhysicalMaterial({ color: opts.gold || '#C8A04A', metalness: 1, roughness: 0.25 });
  const padG = new THREE.BoxGeometry(0.62, 0.06, spec.leadW * 1.25);
  const pads = new THREE.InstancedMesh(padG, gold, pins.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  pins.forEach((p, i) => {
    const out = new THREE.Vector3(p.tip.x - p.base.x, 0, p.tip.z - p.base.z).normalize();
    const pos = new THREE.Vector3(p.base.x, -0.03, p.base.z).addScaledVector(out, spec.reach - 0.3);
    q.setFromAxisAngle(up, Math.atan2(-out.z, out.x));
    m.compose(pos, q, new THREE.Vector3(1, 1, 1)); pads.setMatrixAt(i, m);
  });
  pads.instanceMatrix.needsUpdate = true; pads.name = 'contacts'; group.add(pads);
  // engraved rim label (reader profile)
  if (opts.label) {
    const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 128; const g = cv.getContext('2d');
    g.fillStyle = '#4A4E52'; g.font = `700 64px "${opts.monoFont || 'Atkinson Hyperlegible Mono'}"`; g.textBaseline = 'middle';
    g.fillText(opts.label.toUpperCase(), 8, 66);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(outer - 1.2, (outer - 1.2) / 16), new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.6, metalness: 0.4, depthWrite: false }));
    lab.rotation.x = -Math.PI / 2; lab.position.set(0, H + 0.09, inner / 2 + rim / 2); group.add(lab);
  }
  return { group, inner, outer, height: H, pads };
}

// The mark, extruded (for 3D renders and the brand kit). Cell = 1 unit; 8x8 units; depth in units.
// Body = rows 1-7 as one clean outline with two eye holes (no internal faces); the 0x81 row = two heat blocks.
const MARK_BODY = [[0, 1], [1, 1], [1, 2], [7, 2], [7, 1], [8, 1], [8, 4], [7, 4], [7, 5], [6, 5], [6, 7], [5, 7], [5, 8], [3, 8], [3, 7], [2, 7], [2, 5], [1, 5], [1, 4], [0, 4]];
const MARK_EYES = [[[3, 3], [2, 3], [2, 4], [3, 4]], [[6, 3], [5, 3], [5, 4], [6, 4]]];
export function buildMark(THREE, opts = {}) {
  const depth = opts.depth ?? 1.6, bevel = opts.bevel ?? 0.06, group = new THREE.Group(); group.name = 'ox81-mark';
  // opts.epoxy: the package's own moulded epoxy (grain normal map + clearcoat) instead of the flat ink default
  const ink = opts.epoxy
    ? new THREE.MeshPhysicalMaterial({ color: opts.color || '#1D1F23', roughness: 0.46, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.28, normalMap: noiseNormalTexture(THREE), normalScale: new THREE.Vector2(0.22, 0.22) })
    : new THREE.MeshPhysicalMaterial({ color: opts.color || '#16171A', roughness: 0.5, metalness: 0, clearcoat: 0.2 });
  if (opts.epoxy) ink.normalMap.repeat.set(1.6, 1.6);  // extrude UVs are shape units: same grain density as the package top
  const heat = new THREE.MeshStandardMaterial({ color: '#4A1405', emissive: opts.heat || '#FF4B12', emissiveIntensity: opts.heatIntensity ?? 1.8, roughness: 0.4 });
  const P = ([x, y]) => new THREE.Vector2(x - 4, 4 - y);           // y up, centred
  const shape = new THREE.Shape(MARK_BODY.map(P));
  for (const e of MARK_EYES) shape.holes.push(new THREE.Path(e.map(P)));
  const bodyGeo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: opts.bevelSegments ?? 2 });
  bodyGeo.translate(0, 0, -depth / 2);
  const body = new THREE.Mesh(bodyGeo, ink); body.name = 'mark-body'; body.castShadow = body.receiveShadow = true; group.add(body);
  if (opts.laser) {
    // laser marking on the front face, like the package top: part name on the full row (0xff), the 8 bytes on
    // row 4 (0x7e), a pin-1 dimple on the left stem. Canvas maps the face's -4..4 units at 128 px per unit.
    const cv = document.createElement('canvas'); cv.width = cv.height = 1024; const g = cv.getContext('2d');
    const U = 128, X = (x) => (x + 4) * U, Y = (y) => (4 - y) * U;
    const laser = 'rgba(140,144,148,0.92)';
    g.fillStyle = laser; g.textBaseline = 'middle';
    g.font = `800 ${0.62 * U}px "${opts.markFont || 'Archivo'}"`; if ('fontStretch' in g) g.fontStretch = 'extra-condensed';
    g.fillText('OX81-V1', X(-2.7), Y(1.5), 6.4 * U);
    g.font = `600 ${0.3 * U}px "${opts.monoFont || 'Atkinson Hyperlegible Mono'}"`; if ('fontStretch' in g) g.fontStretch = 'normal';
    g.textAlign = 'center';
    g.fillText('81 81 FF DB 7E 3C 3C 18', X(0), Y(-0.5), 5.6 * U);
    g.fillText('8 B · SIMD-0385', X(0), Y(-1.6), 3.6 * U);
    g.strokeStyle = laser; g.lineWidth = 0.05 * U; g.beginPath(); g.arc(X(-3.5), Y(1.5), 0.24 * U, 0, Math.PI * 2); g.stroke();
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.7, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    decal.position.z = depth / 2 + bevel + 0.004; decal.name = 'mark-laser'; group.add(decal);
  }
  const tipGeo = new THREE.BoxGeometry(1 - bevel * 0.5, 1, depth + bevel * 2);
  for (const c of [0, 7]) {
    const t = new THREE.Mesh(tipGeo, heat); t.name = 'mark-bit-' + (c === 0 ? 7 : 0);
    t.position.set(c - 3.5, 3.5, 0); t.castShadow = true; group.add(t);
  }
  return group;
}
