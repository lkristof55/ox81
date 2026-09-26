// Census wafer: one die per transaction of the snapshot block, binned by class from real counts
// (the API gives counts, not a per-tx list, so sites fill by class in serpentine probe order, not block order).
// Ink dots mark v1 dies that still carry dead ComputeBudget instructions.
//   const w = createWafer(THREE, scene, census, { maxDies }); w.update(t, progress); w.setCensus(census)
// The instanced meshes are allocated once at full capacity (children: [disc, dies, dots]) so a new census only
// rewrites instance data: no geometry, material or shader program is created after construction.
export function createWafer(THREE, scene, census, opts = {}) {
  const R = 60, group = new THREE.Group(); group.name = 'wafer';
  const cap = opts.maxDies || 6000;
  // disc with a notch at the bottom
  const sh = new THREE.Shape();
  const notch = 0.05;
  sh.absarc(0, 0, R, -Math.PI / 2 + notch, Math.PI * 1.5 - notch, false);
  sh.lineTo(Math.cos(-Math.PI / 2 + notch) * R, Math.sin(-Math.PI / 2 + notch) * R);
  sh.lineTo(0, -R + 2.2);
  const disc = new THREE.ExtrudeGeometry(sh, { depth: 0.4, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.2, bevelSegments: 2, curveSegments: 96 });
  disc.rotateX(-Math.PI / 2); disc.translate(0, -0.4, 0);
  // polished silicon read as graphite on the sheet (tokens: epoxy #16171A → graphite #5B5F63), no thin-film tint
  const silicon = new THREE.MeshPhysicalMaterial({ color: '#3A3E43', metalness: 0.55, roughness: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.25 });
  const wafer = new THREE.Mesh(disc, silicon); wafer.receiveShadow = true; wafer.name = 'wafer-disc'; group.add(wafer);

  const dieMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.05 });
  const inkMat = new THREE.MeshStandardMaterial({ color: '#121315', roughness: 0.4 });
  const cols = { v1: new THREE.Color('#FF4B12'), v0: new THREE.Color('#5B5F63'), legacy: new THREE.Color('#A9AEB2'), vote: new THREE.Color('#D9DBD7') };
  // unit die / unit dot, scaled per instance by the pitch
  const dies = new THREE.InstancedMesh(new THREE.BoxGeometry(0.86, 0.12, 0.86), dieMat, cap);
  dies.name = 'wafer-dies'; dies.receiveShadow = true; dies.frustumCulled = false;
  const dots = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.26, 0.26, 0.1, 20), inkMat, cap);
  dots.name = 'wafer-dots'; dots.frustumCulled = false;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let k = 0; k < cap; k++) { dies.setMatrixAt(k, zero); dies.setColorAt(k, cols.vote); dots.setMatrixAt(k, zero); }
  dies.instanceColor.needsUpdate = true; dies.count = 0; dots.count = 0;
  group.add(dies); group.add(dots);

  let order = [], classes = [], dotIdx = [], pitch = 1;
  // the disc's bevelled top is at y = 0.1; dies sit clear of it so the long census camera never depth-fights them
  const DIE_Y = 0.22;

  function layout(total) {
    // largest square grid of dies that fits inside r = R - 3
    const r = R - 3;
    let lo = 0.5, hi = 20, cells = [];
    for (let it = 0; it < 30; it++) {
      const p = (lo + hi) / 2; const c = [];
      const k = Math.floor(r / p);
      for (let j = -k; j <= k; j++) for (let i = -k; i <= k; i++) {
        const x0 = i * p - p / 2, z0 = j * p - p / 2;
        const ok = [[x0, z0], [x0 + p, z0], [x0, z0 + p], [x0 + p, z0 + p]].every(([x, z]) => x * x + z * z <= r * r);
        if (ok) c.push([i, j]);
      }
      if (c.length >= total) { lo = p; cells = c; } else hi = p;
    }
    const p = lo;
    // serpentine probe order: rows top to bottom, alternating direction
    cells.sort((a, b) => (a[1] - b[1]) || (a[1] % 2 === 0 ? a[0] - b[0] : b[0] - a[0]));
    return { p, cells: cells.slice(0, total) };
  }

  function setCensus(c) {
    classes = []; order = []; dotIdx = []; lastShown = -1; lastDots = -1;
    dies.count = 0; dots.count = 0;
    if (!c) return;
    const v = c.versions, vote = c.txs.vote;
    // vote txs are legacy on the wire; classes: v1, v0, legacy (non-vote), vote
    const lnv = c.versionsNonVote ? c.versionsNonVote.legacy : Math.max(0, v.legacy - vote);
    const seq = [['v1', v.v1], ['v0', v.v0], ['legacy', lnv], ['vote', Math.max(0, c.txs.total - v.v1 - v.v0 - lnv)]];
    const n = c.txs.total;
    const scale = n > cap ? cap / n : 1;
    const m = Math.min(cap, Math.round(n * scale));
    const { p, cells } = layout(m);
    pitch = p;
    for (const [k, cnt] of seq) for (let i = 0; i < Math.round(cnt * scale); i++) classes.push(k);
    classes.length = Math.min(classes.length, cells.length, cap);
    order = cells.map(([i, j]) => [i * p, j * p]);
    for (let k = 0; k < classes.length; k++) { dies.setMatrixAt(k, zero); dies.setColorAt(k, cols[classes[k]]); }
    dies.instanceColor.needsUpdate = true; dies.instanceMatrix.needsUpdate = true;
    dies.count = classes.length;
    // ink dots on N evenly spread v1 dies (dead-harness txs)
    const dead = Math.round((c.v1 && c.v1.deadComputeBudget ? c.v1.deadComputeBudget.txs : 0) * scale);
    const v1n = classes.filter((x) => x === 'v1').length; // v1 dies are the first v1n sites
    for (let i = 0; i < Math.min(dead, v1n); i++) dotIdx.push(Math.floor((i + 0.5) * v1n / dead));
    group.userData.pitch = p; group.userData.scale = scale;
  }

  const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  let lastShown = -1, lastDots = -1;
  function update(t, progress) {
    group.rotation.y = -progress * 0.35;
    if (!classes.length) return;
    // dies fill in probe order over the first 55% of the beat, ink dots drop last; only the changed span is rewritten
    const fill = Math.min(1, progress / 0.55);
    const shown = Math.floor(fill * classes.length);
    if (shown !== lastShown) {
      const a = lastShown < 0 ? 0 : Math.min(shown, lastShown), b = lastShown < 0 ? classes.length : Math.max(shown, lastShown);
      sc.set(pitch, 1, pitch);
      for (let k = a; k < b; k++) {
        if (k < shown) { pos.set(order[k][0], DIE_Y, order[k][1]); mat.compose(pos, q, sc); dies.setMatrixAt(k, mat); }
        else dies.setMatrixAt(k, zero);
      }
      dies.instanceMatrix.needsUpdate = true; lastShown = shown;
    }
    const nd = progress > 0.6 ? Math.min(dotIdx.length, Math.ceil(((progress - 0.6) / 0.15) * dotIdx.length)) : 0;
    if (nd !== lastDots) {
      sc.set(pitch, 1, pitch);
      for (let k = 0; k < nd; k++) { const o = order[dotIdx[k]]; pos.set(o[0], DIE_Y + 0.12, o[1]); mat.compose(pos, q, sc); dots.setMatrixAt(k, mat); }
      dots.count = nd; dots.instanceMatrix.needsUpdate = true; lastDots = nd;
    }
  }
  setCensus(census);
  scene.add(group);
  return { group, update, setCensus, radius: R, dispose() { scene.remove(group); } };
}
