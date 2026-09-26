// Decap: the mould compound dissolves (noise threshold, heat burn edge) and shows the leadframe, the die and one
// gold bond wire per pin. The die top is a treemap of the byte map: area ∝ bytes, groups as the first split.
//   const d = createDecap(THREE, pkg, xray); d.update(t, progress)   // progress 0..1
import dissolveChunk from '../shaders/dissolve.glsl';

const GROUP_ORDER = ['version', 'header', 'config', 'lifetime', 'count', 'address', 'instruction', 'lookup', 'signature'];

function pattern(g, group, x, y, w, h, heatVersion) {
  const ink = '#121315';
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#E4E6E2'; g.fillRect(x, y, w, h);
  g.strokeStyle = ink; g.fillStyle = ink;
  const s = Math.max(1, w / 400);
  if (group === 'version') { g.fillStyle = heatVersion ? '#FF4B12' : ink; g.fillRect(x, y, w, h); }
  else if (group === 'header') g.fillRect(x, y, w, h);
  else if (group === 'lifetime') { g.fillStyle = '#5B5F63'; g.fillRect(x, y, w, h); }
  else if (group === 'address') { g.fillStyle = '#A9AEB2'; g.fillRect(x, y, w, h); }
  else if (group === 'config') { g.lineWidth = 2; for (let k = -h; k < w; k += 5) { g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + h, y); g.stroke(); } }
  else if (group === 'count') { for (let yy = y + 2; yy < y + h; yy += 5) for (let xx = x + 2; xx < x + w; xx += 5) g.fillRect(xx, yy, 2, 2); }
  else if (group === 'instruction') { g.lineWidth = 1.5; for (let k = x + 2; k < x + w; k += 4) { g.beginPath(); g.moveTo(k, y); g.lineTo(k, y + h); g.stroke(); } }
  else if (group === 'lookup') { g.lineWidth = 1; for (let k = -h; k < w; k += 6) { g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + h, y); g.stroke(); g.beginPath(); g.moveTo(x + k, y); g.lineTo(x + k + h, y + h); g.stroke(); } }
  else if (group === 'signature') { g.lineWidth = 2; for (let k = y + 2; k < y + h; k += 4) { g.beginPath(); g.moveTo(x, k); g.lineTo(x + w, k); g.stroke(); } }
  g.restore();
  g.strokeStyle = '#121315'; g.lineWidth = 2 * s; g.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

export function dieTexture(THREE, xray, px = 1024) {
  const cv = document.createElement('canvas'); cv.width = cv.height = px; const g = cv.getContext('2d');
  g.fillStyle = '#2B2F36'; g.fillRect(0, 0, px, px);
  const pad = px * 0.08, W = px - pad * 2;
  const bytes = {}; for (const r of xray.ranges) bytes[r.group] = (bytes[r.group] || 0) + (r.end - r.start);
  const groups = GROUP_ORDER.filter((k) => bytes[k]);
  const total = groups.reduce((a, k) => a + bytes[k], 0);
  // slice-and-dice: groups as vertical slices (area ∝ bytes), each slice split into its ranges horizontally
  let x = pad;
  for (const k of groups) {
    const w = (bytes[k] / total) * W;
    const rs = xray.ranges.filter((r) => r.group === k);
    let y = pad;
    for (const r of rs) {
      const h = ((r.end - r.start) / bytes[k]) * W;
      pattern(g, k, x, y, Math.max(1, w), Math.max(1, h), xray.version === 'v1');
      y += h;
    }
    x += w;
  }
  // bond pads ring
  g.fillStyle = '#C8A04A';
  const n = xray.ranges.length, ring = pad * 0.5;
  for (let i = 0; i < n; i++) {
    const u = i / n, per = u * 4, side = Math.floor(per), f = per - side;
    const L = px - ring * 2; let bx, by;
    if (side === 0) { bx = ring; by = ring + f * L; } else if (side === 1) { bx = ring + f * L; by = px - ring; } else if (side === 2) { bx = px - ring; by = px - ring - f * L; } else { bx = px - ring - f * L; by = ring; }
    g.fillRect(bx - 6, by - 6, 12, 12);
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export function patchDissolve(THREE, material, uniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uProgress = uniforms.uProgress;
    shader.uniforms.uHeat = uniforms.uHeat;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDisPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDisPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDisPos;\nuniform float uProgress;\nuniform vec3 uHeat;\n' + dissolveChunk)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nfloat dn = oxNoise(vDisPos * 1.8) * 0.72 + oxNoise(vDisPos * 5.1) * 0.28;\nfloat dcut = uProgress * 1.12 - 0.06;\nif (dn < dcut) discard;\nfloat burn = 1.0 - smoothstep(0.0, 0.06, dn - dcut);\nif (uProgress > 0.001) totalEmissiveRadiance += uHeat * burn * 3.0;');
  };
  material.customProgramCacheKey = () => 'ox81-dissolve';
  material.needsUpdate = true;
}

export function createDecap(THREE, pkg, xray, opts = {}) {
  const group = new THREE.Group(); group.name = 'decap';
  const { S, T, standoff } = pkg.spec;
  const uniforms = { uProgress: { value: 0 }, uHeat: { value: new THREE.Color(0xff4b12) } };
  // dissolve the body, the marking and the mould details
  pkg.body.material.side = THREE.DoubleSide;
  patchDissolve(THREE, pkg.body.material, uniforms);
  const extras = pkg.group.children.filter((o) => o.isMesh && o !== pkg.body && o.name !== 'leads' && o.name !== 'pin1');
  // leadframe paddle
  const tin = new THREE.MeshPhysicalMaterial({ color: '#B9BEC2', metalness: 1, roughness: 0.35 });
  const paddle = new THREE.Mesh(new THREE.BoxGeometry(S * 0.7, 0.12, S * 0.7), tin);
  paddle.position.y = standoff + T * 0.3; group.add(paddle);
  // die
  const dieS = S * 0.55;
  const dieTop = new THREE.MeshPhysicalMaterial({ map: dieTexture(THREE, xray), metalness: 0.35, roughness: 0.2, iridescence: 0.45, iridescenceIOR: 1.9, iridescenceThicknessRange: [180, 420] });
  const dieSide = new THREE.MeshPhysicalMaterial({ color: '#2B2F36', metalness: 0.6, roughness: 0.12, iridescence: 0.55, iridescenceIOR: 1.9, iridescenceThicknessRange: [180, 420] });
  const die = new THREE.Mesh(new THREE.BoxGeometry(dieS, 0.18, dieS), [dieSide, dieSide, dieTop, dieSide, dieSide, dieSide]);
  const dieY = standoff + T * 0.3 + 0.06 + 0.09;
  die.position.y = dieY; die.castShadow = true; group.add(die);
  // bond wires: lead inner end -> die bond pad, same order as the pins (and the pads ring on the die)
  const n = pkg.pins.length, ring = dieS * 0.04, L = dieS - ring * 2;
  const wireMat = new THREE.MeshPhysicalMaterial({ color: '#C8A04A', metalness: 1, roughness: 0.25, emissive: '#FF4B12', emissiveIntensity: 0 });
  const hotMat = new THREE.MeshStandardMaterial({ color: '#4A1405', emissive: '#FF4B12', emissiveIntensity: 2.2 });
  const tubes = [];
  // pads ring on the texture runs: side0 = left (top->bottom in texture v) ... match to 3D: texture v maps to -z..+z
  for (let i = 0; i < n; i++) {
    const p = pkg.pins[i];
    const u = i / n, per = u * 4, side = Math.floor(per), f = per - side;
    let tx, ty; // texture space 0..1 (x right, y down)
    const r0 = 0.04, l0 = 1 - r0 * 2;
    if (side === 0) { tx = r0; ty = r0 + f * l0; } else if (side === 1) { tx = r0 + f * l0; ty = 1 - r0; } else if (side === 2) { tx = 1 - r0; ty = 1 - r0 - f * l0; } else { tx = 1 - r0 - f * l0; ty = r0; }
    // die top face (BoxGeometry +y face): u along +x, v along -z  -> texture y down maps to +z
    const end = new THREE.Vector3((tx - 0.5) * dieS, dieY + 0.09, (ty - 0.5) * dieS);
    const start = p.base.clone(); start.y = standoff + T * 0.44;
    const inward = new THREE.Vector3(-(p.tip.x - p.base.x), 0, -(p.tip.z - p.base.z)).normalize();
    start.addScaledVector(inward, 0.35);
    const mid = start.clone().lerp(end, 0.4); mid.y = Math.max(start.y, end.y) + 0.55;
    const curve = new THREE.CatmullRomCurve3([start, mid, end]);
    const g = new THREE.TubeGeometry(curve, 12, 0.02, 5, false);
    const mesh = new THREE.Mesh(g, i === 0 && xray.version === 'v1' ? hotMat : wireMat.clone());
    mesh.visible = true; group.add(mesh); tubes.push(mesh);
  }
  void L; void ring;
  group.visible = false;
  pkg.group.add(group);

  function update(t, progress) {
    const dissolve = Math.min(1, progress / 0.6);
    uniforms.uProgress.value = dissolve;
    group.visible = progress > 0.001;
    for (const o of extras) o.visible = dissolve < 0.35;
    // wires highlight in offset order while progress passes 0.6 -> 1.0
    const w = Math.max(0, (progress - 0.6) / 0.4);
    const k = Math.floor(w * n);
    for (let i = 0; i < n; i++) {
      const m = tubes[i].material; if (m === hotMat) continue;
      m.emissiveIntensity = i < k ? (i === k - 1 ? 1.6 : 0.0) : 0;
      m.emissive.set(i === k - 1 ? '#FFE2B0' : '#FF4B12');
    }
    return { dissolve, wire: k };
  }
  function dispose() { pkg.group.remove(group); }
  return { group, update, dispose, uniforms };
}
