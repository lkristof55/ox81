// "Seat it": six reader sockets under one package. Each socket plays what ox81.misread() says that reader does.
//   const row = createSocketRow(THREE, scene, { pkg, xray, monoFont, onEvent });
//   row.seat(i) / row.lift() / row.dragTo(x, z) / row.endDrag() / row.hover(i)
//   row.update(t, dt, { panRate }) -> { chip: {x, y, z, rx, rz}, rowX }   (panRate: how fast the row centres the working socket)
// Units are millimetres. The seating plane is y = 0. No page DOM here (canvas textures only).
import { buildSocket } from './chip.js';

export const READERS = [
  { id: 'v1-reader', label: 'Reader · v1', note: 'maxSupportedTransactionVersion 1' },
  { id: 'pre-v1-parser', label: 'Pre-v1 parser', note: 'sig count first' },
  { id: 'legacy-only-parser', label: 'Legacy-only parser', note: 'pre-2022' },
  { id: 'rpc-no-version-param', label: 'RPC · no version param', note: 'getTransaction(sig)' },
  { id: 'rpc-max-version-0', label: 'RPC · max version 0', note: 'maxSupportedTransactionVersion 0' },
  { id: 'geyser-versioned-first', label: 'Geyser · versioned-first', note: 'checks versioned before config' },
];

const fmt = (n) => Number(n).toLocaleString('en-US');

// What this reader does to these bytes. Straight from xray.misread (the library), never invented.
export function outcome(xray, i) {
  const n = xray.ranges.length, size = xray.size;
  if (i === 0) return { kind: 'seat', ok: true, main: `seated · ${n} ranges · ${fmt(size)} B · no gaps`, sub: `a v1 reader walks all ${fmt(size)} bytes from offset 0 to the tail.` };
  const m = (xray.misread || []).find((p) => p.reader === READERS[i].id);
  if (!m) return { kind: 'seat', ok: true, main: 'seated', sub: '' };
  if (m.ok) return { kind: 'seat', ok: true, main: `seated · ${m.result}`, sub: m.name };
  const d = m.detail || {};
  if (d.errorCode != null) return { kind: 'reject', code: d.errorCode, block: m.reader === 'rpc-max-version-0', main: m.result, sub: m.name };
  if (d.claimedSignatures) return { kind: 'rail', claimed: d.claimedSignatures, needed: d.bytesNeeded, main: `counted ${fmt(d.claimedSignatures)} signatures · needs ${fmt(d.bytesNeeded)} B · has ${fmt(size)} B`, sub: m.result };
  if (m.reader === 'geyser-versioned-first') return { kind: 'misfile', main: `filed as v0 · versioned is true for both`, sub: m.result };
  return { kind: 'misread', main: m.result, sub: m.name };
}

const ease = {
  in3: (t) => t * t * t,
  out3: (t) => 1 - (1 - t) ** 3,
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOut2: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function binTexture(THREE, text, mono) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 96;
  const g = cv.getContext('2d');
  g.fillStyle = '#2A2D31'; g.fillRect(0, 0, 256, 96);
  g.strokeStyle = '#8C9094'; g.lineWidth = 4; g.strokeRect(6, 6, 244, 84);
  g.fillStyle = '#D5D8DA'; g.font = `700 52px "${mono}"`; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillText(text, 128, 52);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export function createSocketRow(THREE, scene, opts) {
  const mono = opts.monoFont || 'Atkinson Hyperlegible Mono';
  const root = new THREE.Group(); root.name = 'socket-row'; scene.add(root);
  const row = new THREE.Group(); root.add(row);
  let pkg = opts.pkg, xray = opts.xray;
  let sockets = [], pitch = 0;
  const onEvent = opts.onEvent || (() => {});

  // ghost rail (shared, re-parented to the socket that needs it)
  const rail = new THREE.Group(); rail.visible = false;
  // The rail is drawn like a ruler on the tick row, at its real length in world units: a solid strip over the
  // real bytes (the socket), then evenly spaced dashes out to the imagined end, with an end bar at both ends.
  // railBox stays as an invisible length marker (scale.x = rail length) for renders that read it.
  const railMat = new THREE.LineDashedMaterial({ color: 0x121315, dashSize: 0.5, gapSize: 0.35 });
  const railBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 0.4, 1)), railMat);
  railBox.visible = false; rail.add(railBox);
  const RAIL_MAX = 400, DASH = 1.1, GAP = 0.7;
  const railInk = new THREE.MeshBasicMaterial({ color: 0x121315, toneMapped: false });
  const railStrips = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.03, 0.22), railInk, RAIL_MAX);
  railStrips.name = 'ghost-rail'; railStrips.frustumCulled = false; railStrips.count = 0; rail.add(railStrips);
  const rm = new THREE.Matrix4(), rp = new THREE.Vector3(), rs = new THREE.Vector3(), rq = new THREE.Quaternion();
  function drawRail(s, L, Lnow) {
    const zt = s.inner / 2 + 1.0, zl = zt - 0.45 - 0.11, y0 = 0.15;
    const z0 = zl - 1.1, z1 = zt + 0.45 + 0.9;
    let k = 0;
    const strip = (x0, x1, z = zl, depth = 0.22) => { if (k >= RAIL_MAX || x1 <= x0) return; rp.set((x0 + x1) / 2, y0, z); rs.set(x1 - x0, 1, depth / 0.22); rm.compose(rp, rq, rs); railStrips.setMatrixAt(k++, rm); };
    strip(-s.outer, 0);                                    // real bytes: solid
    strip(-0.09, 0.09, (z0 + z1) / 2, z1 - z0);            // real end
    if (L > 0.01) {
      const n = Math.max(1, Math.round((L + GAP) / (DASH + GAP)));
      const d = L / (n + (GAP / DASH) * (n - 1)), g = d * GAP / DASH;   // n dashes, n-1 gaps, ends land on 0 and L
      for (let i = 0; i < n; i++) { const a = i * (d + g); if (a >= Lnow) break; strip(a, Math.min(a + d, Lnow)); }
      if (Lnow >= L - 1e-3) strip(L - 0.09, L + 0.09, (z0 + z1) / 2, z1 - z0);   // imagined end
    }
    railStrips.count = k; railStrips.instanceMatrix.needsUpdate = true;
  }
  const tickMat = new THREE.MeshBasicMaterial({ color: 0xff4b12, toneMapped: false });
  const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 0.03, 0.9), tickMat, 1024);
  ticks.count = 0; rail.add(ticks);

  let binShared = null;
  function build() {
    for (const s of sockets) { row.remove(s.group); s.group.traverse((o) => { o.geometry?.dispose?.(); }); }
    sockets = [];
    // three bin plates shared by the six sockets (was one set per socket)
    if (binShared) binShared.forEach((tx) => tx.dispose());
    binShared = [binTexture(THREE, 'BIN V1', mono), binTexture(THREE, 'BIN V0', mono), binTexture(THREE, xray.version === 'legacy' ? 'BIN LGC' : 'BIN V0', mono)];
    READERS.forEach((r, i) => {
      const s = buildSocket(THREE, pkg, { label: r.label, monoFont: mono });
      const [frame, floor, pads, label] = s.group.children;
      // glow pads: additive overlay, lit in offset order
      const glow = new THREE.InstancedMesh(pads.geometry, new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }), pads.count);
      glow.instanceMatrix.array.set(pads.instanceMatrix.array); glow.instanceMatrix.needsUpdate = true;
      glow.position.y = 0.02; glow.scale.set(1, 1.2, 1);
      const black = new THREE.Color(0, 0, 0);
      for (let k = 0; k < pads.count; k++) glow.setColorAt(k, black);
      glow.instanceColor.needsUpdate = true; glow.frustumCulled = false;
      s.group.add(glow);
      if (label) { label.material.emissive = new THREE.Color(0xff4b12); label.material.emissiveMap = label.material.map; label.material.emissiveIntensity = 0; }
      // bin label plate on the front rim
      const binTex = binShared;
      const bin = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.2), new THREE.MeshStandardMaterial({ map: xray.version === 'v1' ? binTex[0] : binTex[2], roughness: 0.5, metalness: 0.3 }));
      bin.rotation.x = -Math.PI / 2 + 0.0; bin.position.set(s.outer / 2 - 2.4, s.height + 0.1, -s.outer / 2 + 1.3);
      s.group.add(bin);
      const mats = [frame.material, floor.material, pads.material];
      s.group.traverse((o) => { if (o.isMesh) { o.castShadow = o.castShadow; } });
      sockets.push({ ...s, i, frame, floor, pads, label, glow, bin, binTex, mats, x: 0, litAt: -1, rejectAt: -1, flipAt: -1, dim: 0, hover: 0 });
    });
    pitch = sockets[0].outer + 4;
    sockets.forEach((s, i) => { s.x = i * pitch; s.group.position.x = s.x; row.add(s.group); });
  }
  build();

  const st = {
    mode: 'idle', target: -1, t0: 0, from: { x: 0, y: 6, z: 0 }, pos: { x: 0, y: 6, z: 0 }, tilt: { x: 0, z: 0 },
    kind: null, railAt: -1, railLen: 0, claimed: 0, needed: 0, dimAll: 0, rowX: null, drag: null, vel: { x: 0, z: 0 },
  };
  let now = 0;
  const HOVER = 6;

  function socketWorldX(i) { return root.position.x + row.position.x + sockets[i].x; }

  function resetEffects() {
    for (const s of sockets) {
      s.litAt = -1; s.rejectAt = -1;
      if (s.flipAt >= 0) { s.flipAt = -1; s.bin.material.map = xray.version === 'v1' ? s.binTex[0] : s.binTex[2]; s.bin.scale.set(1, 1, 1); }
    }
    st.railAt = -1; rail.visible = false; st.dimAll = 0;
  }

  function seat(i, { instant = false } = {}) {
    if (i < 0 || i >= sockets.length) return;
    resetEffects();
    const o = outcome(xray, i);
    st.mode = 'seating'; st.target = i; st.t0 = now; st.kind = o.kind; st.outcome = o; st.instant = instant;
    st.from = { ...st.pos };
    onEvent({ type: 'seat', index: i, outcome: o });
  }
  function lift() {
    resetEffects();
    st.mode = 'lifting'; st.t0 = now; st.from = { ...st.pos }; st.target = -1;
    onEvent({ type: 'lift' });
  }
  function hover(i) { sockets.forEach((s, k) => { s.hoverTarget = k === i ? 1 : 0; }); }
  function dragTo(x, z) {
    if (st.mode !== 'drag') { resetEffects(); st.mode = 'drag'; st.target = -1; onEvent({ type: 'drag' }); }
    const px = st.pos.x, pz = st.pos.z;
    st.drag = { x, z };
    st.vel.x = x - px; st.vel.z = z - pz;
  }
  function nearest(x) {
    let best = -1, bd = Infinity;
    sockets.forEach((s, i) => { const d = Math.abs(socketWorldX(i) - x); if (d < bd) { bd = d; best = i; } });
    return bd < sockets[0].outer * 0.6 ? best : -1;
  }
  function endDrag() {
    if (st.mode !== 'drag') return -1;
    const i = nearest(st.pos.x);
    if (i >= 0) seat(i); else lift();
    return i;
  }

  function setPackage(newPkg, newXray) {
    pkg = newPkg; xray = newXray; resetEffects(); build();
    st.mode = 'idle'; st.target = -1;
  }

  const col = new THREE.Color();
  function update(t, dt, { rowTargetX = null, active = true, panRate = 3.2 } = {}) {
    now = t;
    // chip pose
    const inst = st.instant;
    if (st.mode === 'idle') {
      st.pos.x += (0 - st.pos.x) * Math.min(1, dt * 6);
      st.pos.z += (0 - st.pos.z) * Math.min(1, dt * 6);
      st.pos.y = HOVER + Math.sin(t * Math.PI * 2 / 2.4) * 0.3;
      st.tilt.x *= 0.9; st.tilt.z *= 0.9;
    } else if (st.mode === 'drag' && st.drag) {
      st.pos.x += (st.drag.x - st.pos.x) * Math.min(1, dt * 14);
      st.pos.z += (st.drag.z - st.pos.z) * Math.min(1, dt * 14);
      st.pos.y += (4 - st.pos.y) * Math.min(1, dt * 10);
      const k = 0.1;
      st.tilt.z = Math.max(-0.1, Math.min(0.1, -st.vel.x * k)); st.tilt.x = Math.max(-0.1, Math.min(0.1, st.vel.z * k));
      st.vel.x *= 0.8; st.vel.z *= 0.8;
      const n = nearest(st.pos.x); hover(n);
    } else if (st.mode === 'lifting') {
      const p = inst ? 1 : clamp01((t - st.t0) / 0.4), e = ease.out3(p);
      st.pos.x = st.from.x + (0 - st.from.x) * e; st.pos.z = st.from.z + (0 - st.from.z) * e;
      st.pos.y = st.from.y + (HOVER - st.from.y) * e;
      st.tilt.x *= 0.85; st.tilt.z *= 0.85;
      if (p >= 1) st.mode = 'idle';
    } else if (st.mode === 'seating' || st.mode === 'seated') {
      const i = st.target, sx = socketWorldX(i);
      const el = t - st.t0;
      const travel = inst ? 0 : Math.min(0.35, Math.abs(st.from.x - sx) / 60 + 0.12);
      const dropStart = travel, dropEnd = dropStart + (inst ? 0 : 0.26), settleEnd = dropEnd + (inst ? 0 : 0.22);
      const restY = st.kind === 'reject' ? 1.2 : 0;
      st.tilt.x *= 0.8; st.tilt.z *= 0.8;
      if (el < dropStart) {
        const e = ease.inOut2(el / travel);
        st.pos.x = st.from.x + (sx - st.from.x) * e; st.pos.z = st.from.z * (1 - e);
        st.pos.y = st.from.y + (HOVER - st.from.y) * e;
      } else {
        st.pos.x = sx; st.pos.z = 0;
        if (el < dropEnd) {
          const e = ease.in3((el - dropStart) / (dropEnd - dropStart));
          st.pos.y = HOVER + (restY - HOVER) * e;
        } else if (el < settleEnd) {
          const p = (el - dropEnd) / (settleEnd - dropEnd);
          st.pos.y = restY - 0.04 * Math.sin(p * Math.PI) * (1 - ease.outExpo(p));
        } else {
          st.pos.y = restY;
          if (st.kind === 'reject') {
            const j = el - settleEnd; // two 40 ms judders of 0.15 mm
            if (j < 0.16 && !inst) st.pos.y = restY + (Math.floor(j / 0.04) % 2 === 0 ? 0.15 : 0);
          }
        }
        if (el >= settleEnd && st.mode === 'seating') {
          st.mode = 'seated';
          const s = sockets[i];
          if (st.kind === 'seat' || st.kind === 'rail' || st.kind === 'misfile' || st.kind === 'misread') s.litAt = t;
          if (st.kind === 'reject') { s.rejectAt = t; if (st.outcome.block) st.dimAll = 1; }
          if (st.kind === 'misfile') s.flipAt = t + 0.3;
          if (st.kind === 'rail') {
            st.railAt = t + 0.25; st.claimed = st.outcome.claimed; st.needed = st.outcome.needed; st.railDrawn = -1;
            const ratio = st.needed / xray.size;
            st.railLen = Math.max(0, (ratio - 1)) * s.outer;
            s.group.add(rail); rail.visible = true;
            rail.position.set(s.outer / 2, s.height + 0.35, 0);
            // ticks along the whole claimed span, starting at the socket's left edge
            const total = ratio * s.outer; const m = new THREE.Matrix4();
            ticks.count = Math.min(1024, st.claimed);
            for (let k = 0; k < ticks.count; k++) {
              const x = -s.outer + ((2 + 64 * k) / st.needed) * total;
              m.makeTranslation(x, 0.15, s.inner / 2 + 1.0); ticks.setMatrixAt(k, m);
            }
            ticks.instanceMatrix.needsUpdate = true;
          }
          onEvent({ type: 'seated', index: i, outcome: st.outcome, instant: inst });
        }
      }
    }

    // row pan: keep the working socket under the camera target
    let want;
    if (rowTargetX != null) want = rowTargetX;
    else if (st.target >= 0) want = -sockets[st.target].x - (st.railAt >= 0 ? st.railLen * 0.2 : 0);
    else want = -pitch * 1.0;
    if (st.rowX == null) st.rowX = want;
    st.rowX += (want - st.rowX) * Math.min(1, dt * panRate);
    row.position.x = st.rowX;

    // per-socket effects
    for (const s of sockets) {
      s.hover += ((s.hoverTarget || 0) - s.hover) * Math.min(1, dt * 12);
      const dimT = st.dimAll && s.i !== st.target ? 1 : 0;
      s.dim += (dimT - s.dim) * Math.min(1, dt * 8);
      const dark = s.hover * 0.75;
      s.frame.material.color.setRGB(0.706 * (1 - dark) + 0.07 * dark, 0.725 * (1 - dark) + 0.075 * dark, 0.741 * (1 - dark) + 0.08 * dark);
      for (const m of s.mats) { m.transparent = s.dim > 0.01; m.opacity = 1 - s.dim * 0.65; }
      if (s.label) s.label.material.emissiveIntensity = s.rejectAt >= 0 ? 1.4 : 0;
      if (s.label) s.label.material.opacity = 1 - s.dim * 0.65;
      // pads light in offset order: 8 ms per pin, fade over 600 ms
      if (s.litAt >= 0) {
        const n = s.pads.count, per = inst ? 0 : Math.min(0.008, 1.2 / n);
        let any = false;
        for (let k = 0; k < n; k++) {
          const e = t - s.litAt - k * per;
          const v = e < 0 ? 0 : inst ? 0.35 : Math.max(0, 1 - e / 0.6) * 0.9 + 0.12;
          if (e < 0.6) any = true;
          col.setRGB(1.0 * v, 0.886 * v, 0.69 * v); s.glow.setColorAt(k, col);
        }
        s.glow.instanceColor.needsUpdate = true;
        if (!any && !inst) { /* keep a faint seated glow */ }
      } else if (s.glowDirty !== false) {
        col.setRGB(0, 0, 0); for (let k = 0; k < s.pads.count; k++) s.glow.setColorAt(k, col);
        s.glow.instanceColor.needsUpdate = true; s.glowDirty = false;
      }
      if (s.litAt >= 0) s.glowDirty = true;
      // bin label flip V1 -> V0 (120 ms vertical clip swap)
      if (s.flipAt >= 0) {
        const e = t - s.flipAt;
        if (e < 0) s.bin.scale.y = 1;
        else if (e < 0.06) s.bin.scale.y = 1 - e / 0.06;
        else { s.bin.material.map = s.binTex[1]; s.bin.scale.y = Math.min(1, (e - 0.06) / 0.06); }
      }
    }
    // rail growth
    if (st.railAt >= 0) {
      const p = inst ? 1 : clamp01((t - st.railAt) / 0.7), e = ease.inOut2(p);
      const L = Math.max(0.001, st.railLen * e);
      railBox.scale.set(st.railLen, 1, sockets[0].inner); railBox.position.x = st.railLen / 2;
      if (L !== st.railDrawn) { drawRail(sockets[st.target], st.railLen, L); st.railDrawn = L; }
      // reveal ticks as the rail passes them
      const s = sockets[st.target]; const total = (st.needed / xray.size) * s.outer;
      const shown = Math.floor(st.claimed * clamp01((L + s.outer) / total));
      ticks.count = Math.max(0, Math.min(st.claimed, shown));
    }
    return { chip: { x: st.pos.x, y: st.pos.y, z: st.pos.z, rx: st.tilt.x, rz: st.tilt.z }, rowX: row.position.x };
  }

  function socketCenters() { return sockets.map((s, i) => ({ i, x: socketWorldX(i), y: s.height, z: 0, outer: s.outer })); }

  return {
    group: root, row, seat, lift, hover, dragTo, endDrag, setPackage, update, socketCenters, nearest,
    get state() { return st; }, get sockets() { return sockets; },
    dispose() { scene.remove(root); },
  };
}
