// Ox81 site boot: stage (one renderer), Lenis + ScrollTrigger choreography, the sockets, the bench, the census.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { createStage, createPinHeat, contactShadow, lerpRig } from './scene/stage.js';
import { buildPackage, buildMark } from './scene/chip.js';
import { createSocketRow, READERS, outcome } from './scene/sockets.js';
import { createDecap } from './scene/decap.js';
import { createWafer } from './scene/wafer.js';
import { featured as apiFeatured, fmt, short, esc, v1Misread } from './function/api.js';
import { createBench, pinName } from './function/bench.js';
import { buildTiming } from './sections/timing.js';
import { createCensus } from './sections/census.js';
import { setupRepo } from './sections/repo.js';
import recorded from './data/recorded.json';
import listing from './data/listing.json';

gsap.registerPlugin(ScrollTrigger);
window.gsap = gsap;

const $ = (s) => document.querySelector(s);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = () => innerWidth <= 768;
const isMobile = mobile();
if (reduced) document.documentElement.classList.add('rm');
const easeIO = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ---------------------------------------------------------------- toast
const toastEl = $('#toast'); let toastT;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), 2600); }

// ---------------------------------------------------------------- menu
$('#menu').addEventListener('click', () => { const n = $('#nav'); const o = n.classList.toggle('open'); $('#menu').setAttribute('aria-expanded', String(o)); });
$('#nav').addEventListener('click', () => { $('#nav').classList.remove('open'); $('#menu').setAttribute('aria-expanded', 'false'); });

// ---------------------------------------------------------------- data
const featuredP = apiFeatured().catch((e) => { console.info('featured unavailable:', e.code || e.message); return null; });
let featuredData = null;

// ---------------------------------------------------------------- rigs (camera per beat)
const RIGS = {
  // hero framing is normalised to the part's body size, so any live tx sits in the styleframe's composition
  hero: () => { const k = sizeK(); return mobile() ? { tx: 0, ty: 0.4, tz: 0, dist: 84 * k, el: 50, az: 22, fov: 25, sx: 0.53, sy: 196 / 844 } : { tx: 0, ty: 0.4, tz: 0, dist: 70 * k, el: 38, az: 31, fov: 16.2, sx: 1112 / 1440, sy: 0.53 }; },
  sockets: () => (mobile() ? { tx: 0, ty: 2, tz: 0, dist: 150, el: 34, az: 0, fov: 24, sx: 0.5, sy: 0.6 } : { tx: 0, ty: 2, tz: 0, dist: 150, el: 30, az: 0, fov: 20, sx: 0.7, sy: 0.54 }),
  // top-down pinout sits low enough that the top row's vertical labels clear the headline
  pinout: () => (mobile() ? { tx: 0, ty: 0, tz: 0, dist: 380 * sizeK(), el: 88, az: 0, fov: 9, sx: 0.58, sy: 0.45 } : { tx: 0, ty: 0, tz: 0, dist: 214, el: 88, az: 0, fov: 9, sx: 0.3, sy: 0.595 }),
  decap0: () => (mobile() ? decapBandRig(55, 31, 1) : { tx: 0, ty: 0.6, tz: 0, dist: 74 * sizeK(), el: 55, az: 31, fov: 16.2, sx: 0.72, sy: 0.54 }),
  decap1: () => (mobile() ? decapBandRig(60, 43, 0.9) : { tx: 0, ty: 0.6, tz: 0, dist: 62 * sizeK(), el: 58, az: 43, fov: 16.2, sx: 0.72, sy: 0.54 }),
  wafer0: () => waferRig(62),
  wafer1: () => waferRig(70),
  mark0: () => markRig(22, 0),
  mark1: () => markRig(10, -20),
};
// camera distance scale for the part's body size (S = 10.52 mm for the 2,315 B styleframe part)
function sizeK() { return pkg ? Math.max(0.8, Math.min(1.45, pkg.spec.S / 10.52)) : 1; }
// Reserved slots (DOM boxes the 3D is fitted into, so it never sits on copy). Measured on refresh, in the
// coordinates the page has while the beat is on screen; the loop offsets them by scroll.
const SL = { wafer: null, mark: null, band: null, form: null };
const fitDist = (units, px, fov) => (units * innerHeight) / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2) * Math.max(60, px));
function waferRig(el) {
  const s = SL.wafer, fov = 26;
  if (!s) return { tx: 0, ty: 0, tz: 0, dist: 380, el, az: 0, fov, sx: 0.28, sy: 0.5 };
  const fit = Math.min(s.w, s.h / Math.sin(THREE.MathUtils.degToRad(70))) * 0.9;   // same size for both elevations
  return { tx: 0, ty: 0, tz: 0, dist: fitDist(124, fit, fov), el, az: 0, fov, sx: s.cx / innerWidth, sy: s.cy / innerHeight };
}
function markRig(el, az) {
  const s = SL.mark, fov = 20;
  if (!s) return { tx: 0, ty: 12, tz: 0, dist: 150, el, az, fov, sx: 0.76, sy: 0.46 };
  return { tx: 0, ty: 12, tz: 0, dist: fitDist(27, Math.min(s.w, s.h) * 0.74, fov), el, az, fov, sx: s.cx / innerWidth, sy: 0.5 };
}
function decapBandRig(el, az, k) {
  const b = SL.band, fov = 20;
  if (!b) return { tx: 0, ty: 0.6, tz: 0, dist: 110, el, az, fov, sx: 0.5, sy: 0.85 };
  const units = pkg ? (pkg.spec.S + 2 * pkg.spec.reach) * 1.42 : 18;               // footprint diagonal (diamond view)
  const fit = Math.min(innerWidth * 0.94, b.h / Math.sin(THREE.MathUtils.degToRad(el)) * 0.9);
  return { tx: 0, ty: 0.6, tz: 0, dist: fitDist(units, fit, fov) * k, el, az, fov, sx: 0.5, sy: b.cy / innerHeight };
}

// ---------------------------------------------------------------- boot
const canvas = $('#stage');
let stage, holder, pkg = null, pinHeat, contact, sockets, decap = null, wafer, mark, markFill, timing;
let current = null; // the xray drawn as the package

async function loadFonts() {
  const f = [document.fonts.load('extra-condensed 800 40px "Archivo"'), document.fonts.load('800 40px "Archivo"'), document.fonts.load('600 20px "Atkinson Hyperlegible Mono"'), document.fonts.load('700 20px "Atkinson Hyperlegible Mono"')];
  await Promise.race([Promise.all(f), new Promise((r) => setTimeout(r, 2500))]);
}

function setPackage(xr) {
  if (pkg) { holder.remove(pkg.group); pkg.group.traverse((o) => { o.geometry?.dispose?.(); }); if (decap) decap.dispose(); }
  if (contact) holder.remove(contact);
  current = xr;
  pkg = buildPackage(THREE, xr, { RoundedBoxGeometry, markFont: 'Archivo', monoFont: 'Atkinson Hyperlegible Mono' });
  holder.add(pkg.group);
  contact = contactShadow(THREE, pkg.spec.S); holder.add(contact);
  const hot = xr.version === 'v1';
  pinHeat.light.intensity = hot ? 1.6 : 0; pinHeat.glow.visible = hot;   // intensity, not visibility: the light count stays fixed
  pinHeat.light.position.copy(pkg.pins[0].tip).add(new THREE.Vector3(-0.2, 0.4, 0));
  pinHeat.glow.position.copy(pkg.pins[0].tip).setY(0.003);
  decap = createDecap(THREE, pkg, xr);
  if (sockets) sockets.setPackage(pkg, xr);
  primeTextures(pkg.group); if (sockets) primeTextures(sockets.group);
  $('#roPart').textContent = xr.version === 'v1' ? 'OX81-V1' : xr.version === 'v0' ? 'OX80-V0' : 'OX00-LGC';
  buildHeroCopy();
  buildPinLabels();
  timing = buildTiming($('#timing'), xr, { width: isMobile ? 520 : Math.round($('#timing').parentElement.clientWidth) || 640 });
  timing.set(reduced ? 1 : lastP3 * 2.6);
  $('#fig2').textContent = `${xr.ranges.length} pins = ${xr.ranges.length} byte ranges, counter-clockwise from pin 1 in offset order. pin 1 is offset 0${xr.version === 'v1' ? ': 0x81' : ''}. pin ${xr.ranges.length} is the tail.`;
  const mr = xr.version === 'v1' ? v1Misread(xr) : null;
  $('#fig3').textContent = mr ? `the same ${fmt(xr.size)} bytes read three ways. a pre-v1 parser reads 0x81 ${mr.b1hex} as ${fmt(mr.claimed)} signatures and runs off the end.` : `${xr.version} fields in offset order.`;
  $('#fig4').textContent = `decapsulated: one gold bond wire per pin (${xr.ranges.length}). the die is a treemap of the byte map: area ∝ bytes, one slice per field group.`;
}

// Figure 1 names the transaction actually on the stage: the recorded or live featured pick by its kind,
// otherwise the visitor's own tx (by signature, or as a raw paste).
const KIND_LABEL = { 'v1-largest': 'Largest v1 tx', 'v1-dead-cb': 'v1 tx still carrying ComputeBudget ixs', 'v0-lookups': 'v0 tx with lookup tables', legacy: 'Legacy tx' };
let featuredState = 'loading';   // 'loading' | 'ok' | 'none'
function txLabel(xr) {
  const same = (p) => p.xray === xr || (xr.signature && p.signature === xr.signature);
  const rec = recorded.picks.find(same);
  if (rec && !featuredData) return { src: 'Recorded: ', what: KIND_LABEL[rec.kind] || `${xr.version} tx`, recorded: true };
  const f = featuredData && featuredData.picks.find(same);
  if (f) return { src: '', what: KIND_LABEL[f.kind] || `${xr.version} tx` };
  if (rec) return { src: 'Recorded: ', what: KIND_LABEL[rec.kind] || `${xr.version} tx`, recorded: true };
  return { src: '', what: xr.signature ? `Your ${xr.version} tx ${esc(short(xr.signature))}` : `Your pasted ${xr.version} tx (raw bytes)`, own: true };
}
function buildHeroCopy() {
  const xr = current; const slot = xr.meta ? xr.meta.slot : null;
  const L = txLabel(xr);
  const mr = xr.version === 'v1' ? v1Misread(xr) : null;
  const tail = L.recorded ? (featuredState === 'loading' ? '<br>live block loading…' : featuredState === 'none' ? '<br>live block unavailable right now.' : '') : '';
  $('#fig1').innerHTML = `<b>Figure 1.</b> ${L.src}${L.what}${slot ? ` in slot ${fmt(slot)}` : ''}, drawn as a package.<br>${xr.ranges.length} pins = its ${xr.ranges.length} byte ranges, in offset order. Body area ∝ ${fmt(xr.size)} B.${mr ? `<br>Pins 1–2 read <b>0x81 ${mr.b1hex}</b>. An old parser counts ${fmt(mr.claimed)} signatures.` : ''}${tail}`;
}

// ---------------------------------------------------------------- hero callouts (DOM + SVG leaders from projected lead tips)
const leaders = $('#leaders'), labels = $('#labels');
let calloutEls = [];
const cv = (r) => { const v = r.value == null ? '' : String(r.value); return v.length > 12 && !v.startsWith('0x') ? v.slice(0, 6) + '…' : v; };
function heroCallouts(visible, y = 0) {
  const [W, H] = stage.size; leaders.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!visible || !pkg) { leaders.innerHTML = ''; calloutEls.forEach((d) => (d.style.display = 'none')); return; }
  const R = current.ranges; const proj = (n) => stage.project(pkg.pins[n - 1].tip.clone().applyMatrix4(pkg.group.matrixWorld));
  const items = isMobile
    ? [[1, `<span class="n">PIN 1</span> · [${R[0].start}, ${R[0].end}) <span class="v">${esc(R[0].label.replace(' byte', ''))}</span> ${esc(cv(R[0]))}`, current.version === 'v1']]
    : [0, 1, 4, 5].filter((i) => R[i]).map((i) => [i + 1, `<span class="n">PIN ${i + 1}</span> · [${R[i].start}, ${R[i].end})<br><span class="v">${esc(R[i].label.replace(' (blockhash)', '').replace(' byte', ''))}</span> ${esc(cv(R[i]))}`, i === 0 && current.version === 'v1']);
  while (calloutEls.length < items.length) { const d = document.createElement('div'); labels.appendChild(d); calloutEls.push(d); }
  calloutEls.forEach((d, i) => (d.style.display = i < items.length ? '' : 'none'));
  let svg = '';
  if (isMobile) {
    const [x, y] = proj(1);
    svg = `<path d="M${x} ${y} L${x} 82" stroke="#121315" stroke-width="1" fill="none"/><rect x="${x - 3}" y="${y - 3}" width="6" height="6" fill="${items[0][2] ? '#FF4B12' : '#121315'}"/>`;
    const d = calloutEls[0]; d.className = 'pinlab' + (items[0][2] ? ' hot' : ''); if (d.dataset.h !== items[0][1]) { d.innerHTML = items[0][1]; d.dataset.h = items[0][1]; }
    d.style.left = Math.max(12, x - 6) + 'px'; d.style.top = '64px';
  } else {
    const leftX = Math.min(...pkg.pins.slice(0, Math.min(20, pkg.pins.length)).map((p) => stage.project(p.tip.clone().applyMatrix4(pkg.group.matrixWorld))[0])) - 34 - 12;
    const t1 = proj(1);
    // write content, then measure all at once (one layout), then place
    items.forEach(([, html, hot], i) => {
      const d = calloutEls[i]; const cls = 'pinlab r' + (hot ? ' hot' : ''); if (d.className !== cls) d.className = cls;
      if (d.dataset.h !== html) { d.innerHTML = html; d.dataset.h = html; d._w = null; }
    });
    items.forEach((_, i) => { const d = calloutEls[i]; if (!d._w) { d._w = d.offsetWidth; d._h = d.offsetHeight; } });
    // the label column never runs under the probe form: lift the whole stack until every label clears it
    let lift = 0; const f = SL.form;
    if (f) items.forEach((_, i) => {
      const d = calloutEls[i], ly = t1[1] - 44 + i * 50, top = ly - d._h / 2, bot = ly + d._h / 2;
      if (leftX - d._w < f.right + 14 && bot > f.top - y - 10 && top < f.bottom - y + 10) lift = Math.max(lift, bot - (f.top - y - 10));
    });
    items.forEach(([n, , hot], i) => {
      const [x, py] = proj(n); const ly = t1[1] - 44 + i * 50 - lift; const midX = leftX + 8;
      svg += `<path d="M${x} ${py} L${x - 12} ${py} L${midX + 14} ${ly} L${midX} ${ly}" stroke="#121315" stroke-width="1" fill="none"/><rect x="${x - 3}" y="${py - 3}" width="6" height="6" fill="${hot ? '#FF4B12' : '#121315'}"/>`;
      const d = calloutEls[i];
      // last guard: a label that would still reach a text block of the hero column is cut with an ellipsis
      let w = d._w;
      for (const o of SL.obst || []) {
        const top = ly - d._h / 2, bot = ly + d._h / 2;
        if (bot > o.top - y - 4 && top < o.bottom - y + 4 && leftX - w < o.right + 12) w = Math.max(60, leftX - (o.right + 12));
      }
      const mw = w < d._w ? w + 'px' : ''; if (d.style.maxWidth !== mw) { d.style.maxWidth = mw; d.classList.toggle('clip', !!mw); }
      d.style.left = (leftX - w) + 'px'; d.style.top = (ly - d._h / 2) + 'px';
    });
  }
  leaders.innerHTML = svg;
}

// ---------------------------------------------------------------- pinout labels (beat 3)
let pinLabs = [];
function buildPinLabels() {
  pinLabs.forEach((d) => d.remove()); pinLabs = []; pinShown = false;
  if (!pkg) return;
  const n = pkg.pins.length;
  const pick = isMobile ? new Set([0, 3, 6, 9, 12, 15, n - 1]) : null;
  pkg.pins.forEach((p, i) => {
    if (pick && !pick.has(i)) return;
    const d = document.createElement('div');
    const side = pkg.spec.sides === 2 ? (p.side === 0 ? 0 : 2) : p.side;
    d.className = 'plab' + (side === 1 || side === 3 ? ' vert' : '') + (i === 0 && current.version === 'v1' ? ' hot' : '');
    d.innerHTML = side === 0 ? `<b>${esc(pinName(p.range))}</b> ${i + 1}` : side === 2 ? `${i + 1} <b>${esc(pinName(p.range))}</b>` : `${i + 1} <b>${esc(pinName(p.range))}</b>`;
    d.dataset.side = side; d.dataset.i = i; d.style.display = 'none';
    labels.appendChild(d); pinLabs.push(d);
  });
}
// all reads first (one layout), then transform-only writes; labels finish printing by ~40% of the beat
let pinShown = false;
const tipV = new THREE.Vector3();
function placePinLabels(show, p) {
  if (!show) { if (pinShown) { for (const d of pinLabs) d.style.display = 'none'; pinShown = false; } return; }
  if (!pinShown) { for (const d of pinLabs) d.style.display = ''; pinShown = true; }
  for (const d of pinLabs) if (!d._s) d._s = [d.offsetWidth, d.offsetHeight];
  const n = pkg.pins.length; const k = reduced ? n : Math.floor(clamp01(p * 2.6) * n);
  for (const d of pinLabs) {
    const i = +d.dataset.i, side = +d.dataset.side; const pin = pkg.pins[i];
    const [x, y] = stage.project(tipV.copy(pin.tip).applyMatrix4(pkg.group.matrixWorld));
    const [w, h] = d._s;
    let lx, ly;
    if (side === 0) { lx = x - w - 6; ly = y - h / 2; }
    else if (side === 2) { lx = x + 6; ly = y - h / 2; }
    else if (side === 1) { lx = x - w / 2; ly = y + 6; }
    else { lx = x - w / 2; ly = y - h - 6; }
    const t = `translate(${lx.toFixed(1)}px,${ly.toFixed(1)}px)${side === 1 || side === 3 ? ' rotate(180deg)' : ''}`;
    if (d._t !== t) { d.style.transform = t; d._t = t; }
    const on = i < k; if (d._on !== on) { d.classList.toggle('on', on); d._on = on; }
  }
}

// ---------------------------------------------------------------- listing (beat 4): real code from src/decode.ts (the library at the repo root)
function renderListing() {
  const KW = new Set(['const', 'let', 'if', 'else', 'for', 'return', 'throw', 'new', 'true', 'false', 'null', 'continue', 'of']);
  const TOK = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(0x[0-9a-fA-F]+|\b\d+\b)|([A-Za-z_$][\w$]*)|(\s+)|(.)/g;
  const lines = listing.lines.map((l, i) => {
    let h = '';
    l.replace(TOK, (m, cm, str, num, word, ws, other) => {
      if (cm) h += `<span class="cm">${esc(cm)}</span>`;
      else if (str) h += esc(str);
      else if (num) h += `<span class="lit">${esc(num)}</span>`;
      else if (word) h += KW.has(word) ? `<span class="kw">${word}</span>` : esc(word);
      else h += esc(m);
      return m;
    });
    const ln = listing.start + i;
    const hi = l.match(/^ */)[0].length + 2;   // hanging indent: a wrapped line continues 2 columns past its own indent
    return `<div class="ln${ln === listing.hot ? ' hot' : ''}"><i>${ln}</i><span style="--hi:${hi}ch">${h}</span></div>`;
  });
  $('#listing').innerHTML = lines.join('');
  $('#listingCap').textContent = `${listing.file}, lines ${listing.start}–${listing.end}. every read pushes a [start, end) range; a test asserts the ranges cover [0, size) with no gaps and no overlaps.`;
}

// ---------------------------------------------------------------- presets
function renderPresets(feat) {
  const kinds = { 'v1-largest': (p) => `v1 · <b>${fmt(p.size)} B</b>`, 'v1-dead-cb': () => 'v1 + dead harness', 'v0-lookups': () => 'v0 + lookups', legacy: () => 'legacy' };
  for (const [el, hero] of [[$('#heroPresets'), true], [$('#benchPresets'), false]]) {
    if (!feat || !feat.picks || !feat.picks.length) { el.innerHTML = '<span>try:</span><em>no live block yet. paste any mainnet signature.</em>'; continue; }
    el.innerHTML = '<span>try:</span>' + feat.picks.map((p, i) => `<button type="button" class="${i === 0 && hero ? 'on' : ''} ${p.kind === 'legacy' ? 'x' : ''}" data-sig="${esc(p.signature)}" title="${esc(p.signature)}">${kinds[p.kind] ? kinds[p.kind](p) : esc(p.kind)}</button>`).join('');
  }
}

// ---------------------------------------------------------------- main
(async function boot() {
  await loadFonts();
  stage = await createStage(THREE, canvas, { hdrUrl: '/tex/monochrome_studio_02_1k.hdr', mobile: isMobile });
  holder = new THREE.Group(); holder.name = 'chip-holder'; stage.scene.add(holder);
  pinHeat = createPinHeat(THREE, stage.scene); holder.add(pinHeat.light); holder.add(pinHeat.glow);
  // first frame: the live featured tx if it lands fast, else the recorded one (slot 450,355,468, labelled "Recorded")
  const first = await Promise.race([featuredP, new Promise((r) => setTimeout(() => r(null), 1200))]);
  if (first && first.picks && first.picks.length) { featuredData = first; featuredState = 'ok'; }
  const pick0 = (featuredData || recorded).picks[0];
  setPackage(pick0.xray);
  sockets = createSocketRow(THREE, stage.scene, { pkg, xray: current, onEvent: onSocketEvent });
  sockets.group.visible = false;
  wafer = createWafer(THREE, stage.scene, null, { maxDies: isMobile ? 2400 : 6000 }); wafer.group.visible = false;
  // the mark in the package's own moulded epoxy, bevelled; a front fill (intensity only in its beat) shows the grain
  mark = buildMark(THREE, { depth: 1.6, epoxy: true, laser: true, bevel: 0.12, bevelSegments: 3, heatIntensity: 1.4, markFont: 'Archivo', monoFont: 'Atkinson Hyperlegible Mono' }); mark.scale.setScalar(3); mark.position.y = 12; mark.visible = false; stage.scene.add(mark);
  markFill = new THREE.DirectionalLight(0xffffff, 0); markFill.position.set(22, 20, 34); stage.scene.add(markFill);
  renderListing();
  renderPresets(featuredData);
  setupRepo({ rows: $('#orderRows'), cmds: $('#cmds'), bench: $('#benchTable'), toast });

  const bench = createBench({ root: $('#result'), form: $('#benchForm'), input: $('#benchInput'), presetsEl: $('#benchPresets'), reduced, toast, onXray: (r, o) => {
    if (o && o.seat) { setPackage(r); goTo('#readers', 0.12); toast(`your part is in the row: ${r.version} · ${fmt(r.size)} B · ${r.ranges.length} pins`); }
  } });
  const heroRun = (q) => { $('#benchInput').value = q; goTo('#xray'); bench.run(q); };
  $('#heroForm').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#heroInput').value.trim(); if (!q) { $('#heroInput').focus(); $('#heroInput').placeholder = 'no bytes, no ox. paste a signature or base64'; return; } heroRun(q); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.presets button[data-sig], button.ex[data-sig]'); if (!b) return;
    b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    heroRun(b.dataset.sig);
  });

  const census = createCensus({ table: $('#censusTable'), head: $('#censusHead'), toggle: document.querySelector('#census .toggle'), band: $('#censusBand'), bandBig: $('#bandBig'), bandTxt: $('#bandTxt'), mCensus: $('#mCensus'), fig5: $('#fig5'), reduced,
    onData: (c) => { wafer.setCensus(c); lastWaferP = -1; } });
  census.load('latest');

  // live featured may land after the first frame: swap the part (print wipe on the callouts)
  featuredP.then((f) => {
    if (!f || !f.picks || !f.picks.length) { featuredState = 'none'; buildHeroCopy(); renderPresets(null); return; }
    const was = featuredData; featuredData = f; featuredState = 'ok'; renderPresets(f);
    if (!was || was.picks[0].signature !== f.picks[0].signature) { if (!bench.current || current === (was || recorded).picks[0].xray) setPackage(f.picks[0].xray); }
    buildHeroCopy();
  });

  // socket buttons
  const btns = $('#socketBtns');
  btns.innerHTML = READERS.map((r, i) => `<button type="button" data-i="${i}" aria-pressed="false"><span class="k">${i + 1}</span><span>${esc(r.label)}</span><small>${esc(r.note)}</small></button>`).join('');
  btns.addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) userSeat(+b.dataset.i); });
  btns.addEventListener('pointerover', (e) => { const b = e.target.closest('button[data-i]'); sockets.hover(b ? +b.dataset.i : -1); });
  btns.addEventListener('pointerleave', () => sockets.hover(-1));
  addEventListener('keydown', (e) => {
    if (!inReaders() || e.target.closest('input,textarea')) return;
    if (/^[1-6]$/.test(e.key)) { userSeat(+e.key - 1); }
    if (e.key === 'Escape') { sockets.lift(); userAt = scrollY; }
  });

  setupScroll();
  setupPointer();
  warmUp();
  addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) last = performance.now(); });
  requestAnimationFrame(loop);
  // first frame final → ready
  requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true; }));
})().catch((e) => { console.error(e); window.__ready = true; });

// ---------------------------------------------------------------- warm-up: every program, shadow variant and texture
// is compiled/uploaded once at boot (all beats' objects visible for one off-screen-order render), so no beat
// compiles a shader or uploads a texture the first time it scrolls into view.
const TEX_KEYS = ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'clearcoatNormalMap'];
function primeTextures(root) {
  if (!stage) return;
  root.traverse((o) => {
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) for (const k of TEX_KEYS) if (m[k] && m[k].isTexture) { try { stage.renderer.initTexture(m[k]); } catch { /* not fatal */ } }
  });
}
function warmUp() {
  const vis = [holder.visible, sockets.group.visible, wafer.group.visible, mark.visible, decap ? decap.group.visible : false];
  const sx = sockets.group.position.x;
  holder.visible = sockets.group.visible = wafer.group.visible = mark.visible = true;
  if (decap) decap.group.visible = true;
  sockets.group.position.x = 0;
  primeTextures(stage.scene);
  stage.shadowBox(70); stage.setRig(RIGS.wafer1());
  try { stage.renderer.compile(stage.scene, stage.camera); stage.render(); } catch (e) { console.info('warm-up skipped:', e.message); }
  [holder.visible, sockets.group.visible, wafer.group.visible, mark.visible] = vis;
  if (decap) decap.group.visible = vis[4];
  sockets.group.position.x = sx;
}

// ---------------------------------------------------------------- seat it: events → readout
let userAt = null, autoIdx = -1;
function userSeat(i) { sockets.seat(i, { instant: reduced }); userAt = scrollY; }
function onSocketEvent(ev) {
  const ro = $('#readout'), main = $('#roMain'), sub = $('#roSub'), stamp = $('#stamp');
  document.querySelectorAll('#socketBtns button').forEach((b) => { b.setAttribute('aria-pressed', String(ev.index === +b.dataset.i && ev.type !== 'lift')); b.classList.remove('fail'); });
  $('#socketBtns').classList.remove('dim');
  $('#edgeLabel').hidden = true;
  if (ev.type === 'lift' || ev.type === 'drag') { main.textContent = ev.type === 'drag' ? 'carrying the part. drop it on a socket.' : 'lifted. hovering 6 mm over the row.'; sub.textContent = ''; ro.classList.remove('bad'); stamp.hidden = true; stamp.classList.remove('on'); return; }
  const o = ev.outcome; const rd = READERS[ev.index];
  if (ev.type === 'seat') { main.textContent = `seating into ${rd.label.toLowerCase()}…`; sub.textContent = ''; stamp.hidden = true; stamp.classList.remove('on'); return; }
  // seated
  main.textContent = o.main; sub.textContent = o.sub && o.sub !== o.main ? o.sub : '';
  ro.classList.toggle('bad', !o.ok);
  const b = document.querySelector(`#socketBtns button[data-i="${ev.index}"]`); if (b && !o.ok) b.classList.add('fail');
  if (o.kind === 'reject') {
    stamp.innerHTML = `<b>${o.code}</b>transaction version (${esc(String(current.version).replace(/^v/, ''))}) is not supported by the requesting client`;
    stamp.hidden = false; stamp._w = null; stamp.classList.remove('on'); void stamp.offsetWidth; stamp.classList.add('on');
    stampFor = ev.index;
    if (o.block) { $('#socketBtns').classList.add('dim'); sub.textContent = 'getBlock fails for the whole block, not just this part.'; }
  } else { stamp.hidden = true; stamp.classList.remove('on'); stampFor = -1; }
  if (o.kind === 'rail') { sub.textContent = `${o.sub} web3.js 1.99 Transaction.from: "Reached end of buffer unexpectedly".`; if (isMobile) { const e = $('#edgeLabel'); e.hidden = false; e.textContent = `→ ${fmt(o.needed)} B`; } }
}
let stampFor = -1; const stampV = new THREE.Vector3();
function inReaders() { return scrollY > T.s2s - innerHeight * 0.5 && scrollY < T.s2e + innerHeight * 0.5; }

// ---------------------------------------------------------------- scroll
let lenis = null;
const T = { s2s: 0, s2e: 0, s2x: 0, s3s: 0, s3e: 0, s4s: 0, s4e: 0, xr: 0, s6s: 0, s6e: 0, bp: 0, end: 0 };
let trig = {};
function goTo(sel, frac = 0) {
  let y;
  if (sel === '#readers') y = T.s2s + (T.s2e - T.s2s) * frac;
  else { const el = document.querySelector(sel); y = el.getBoundingClientRect().top + scrollY - (isMobile ? 48 : 56) + 1; }
  if (lenis) lenis.scrollTo(y, { duration: 1.1 }); else scrollTo({ top: y, behavior: reduced ? 'auto' : 'smooth' });
}
function setupScroll() {
  const k = isMobile ? 0.6 : 1;
  if (!reduced) {
    lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    document.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => { const h = a.getAttribute('href'); if (h.length > 1 && document.querySelector(h)) { e.preventDefault(); goTo(h === '#top' ? '#part' : h); } }));
  }
  const pin = !reduced;
  trig.s2 = ScrollTrigger.create({ trigger: '#readers', start: 'top top', end: `+=${200 * k}%`, pin, pinSpacing: true, onUpdate: (s) => onReaders(s.progress) });
  trig.s3 = ScrollTrigger.create({ trigger: '#pinout', start: 'top top', end: `+=${150 * k}%`, pin, pinSpacing: true });
  trig.s4 = ScrollTrigger.create({ trigger: '#decap', start: 'top top', end: `+=${150 * k}%`, pin, pinSpacing: true });
  trig.s6 = ScrollTrigger.create({ trigger: '#census', start: 'top top', end: `+=${100 * k}%`, pin, pinSpacing: true });
  ScrollTrigger.addEventListener('refresh', measure);
  ScrollTrigger.refresh();
  measure();
}
function measure() {
  const top = (sel) => { const el = document.querySelector(sel); return el.getBoundingClientRect().top + scrollY; };
  if (reduced) {
    T.s2s = top('#readers'); T.s2e = T.s2s + innerHeight * 0.5; T.s3s = top('#pinout'); T.s3e = T.s3s + innerHeight * 0.5; T.s4s = top('#decap'); T.s4e = T.s4s + innerHeight * 0.5;
    T.xr = top('#xray'); T.s6s = top('#census'); T.s6e = T.s6s + innerHeight * 0.5; T.bp = top('#bench');
  } else {
    T.s2s = trig.s2.start; T.s2e = trig.s2.end; T.s3s = trig.s3.start; T.s3e = trig.s3.end; T.s4s = trig.s4.start; T.s4e = trig.s4.end;
    T.xr = top('#xray'); T.s6s = trig.s6.start; T.s6e = trig.s6.end; T.bp = top('#bench');
  }
  T.s2x = T.s2e + (T.s3s - T.s2e) * 0.7;   // end of the ride-up: the socket band has cleared the header by then
  T.end = Math.max(document.documentElement.scrollHeight - innerHeight, T.bp + 1);
  T.p6a = reduced ? top('#census') : trig.s6.start; T.p6b = reduced ? T.p6a : trig.s6.end;   // census pinned span
  pinLabs.forEach((d) => (d._s = null));
  // slots: wafer in census coordinates (census top = viewport top while pinned), mark in document coordinates
  const rc = (sel) => document.querySelector(sel).getBoundingClientRect();
  const cen = rc('#census'), ws = rc('#waferSlot'), ms = rc('#markSlot'), fm = rc('#heroForm');
  SL.wafer = ws.width > 20 && ws.height > 20 ? { cx: ws.left + ws.width / 2, cy: ws.top - cen.top + ws.height / 2, w: ws.width, h: ws.height } : null;
  SL.mark = ms.width > 20 && ms.height > 20 ? { cx: ms.left + ms.width / 2, top: ms.top + scrollY, w: ms.width, h: ms.height } : null;
  SL.form = { right: fm.right, top: fm.top + scrollY, bottom: fm.bottom + scrollY };
  SL.hdr = document.querySelector('header.top').offsetHeight;
  // obstacles for the hero callouts: the set text (its ink extent, not the column box) and the form
  const inkRect = (q) => { const el = document.querySelector(q); const rg = document.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect(); };
  SL.obst = [inkRect('#part .h-head'), inkRect('#part .lede'), rc('#heroForm')].map((r) => ({ right: r.right, top: r.top + scrollY, bottom: r.bottom + scrollY })).filter((r) => r.bottom > r.top);
  if (isMobile) {
    const dec = rc('#decap .pin-inner'), dl = rc('.decap-left');
    const t = dl.bottom - dec.top + 6, b = innerHeight - 10;
    SL.band = b - t > 120 ? { cy: (t + b) / 2, h: b - t } : null;
  }
}
// where the reserved slots are on screen at scroll y
function waferDy(y) { return y < T.p6a ? T.p6a - y : y > T.p6b ? -(y - T.p6b) : 0; }
function markCy(y) { const s = SL.mark; const top = isMobile ? s.top - y : Math.max(SL.hdr + 24, s.top - y); return top + s.h / 2; }
function onReaders(p) {
  if (!sockets) return;
  if (userAt != null) { if (Math.abs(scrollY - userAt) < 60) return; userAt = null; autoIdx = -2; }
  const want = p < 0.25 ? -1 : p < 0.55 ? 4 : p < 0.85 ? 1 : 0;
  if (want !== autoIdx) {
    autoIdx = want;
    if (want < 0) { if (sockets.state.target >= 0) sockets.lift(); }
    else sockets.seat(want, { instant: reduced });
  }
}

// rig at scroll y: keyframes between beat boundaries
function rigAt(y) {
  // after the readers pin releases, the socket row rides up with its sheet (so the button row never climbs onto it),
  // then the part flies into the pinout
  const rideUp = (yy) => { const r = RIGS.sockets(); r.sy -= (yy - T.s2e) / innerHeight; return r; };
  if (!reduced && y > T.s2e && y < T.s2x) return rideUp(y);
  const K = [
    [0, RIGS.hero()], [T.s2s, RIGS.sockets()], [T.s2e, RIGS.sockets()], ...(reduced ? [] : [[T.s2x, rideUp(T.s2x)]]), [T.s3s, RIGS.pinout()], [T.s3e, RIGS.pinout()],
    [T.s4s, RIGS.decap0()], [T.s4e, RIGS.decap1()], [T.xr, RIGS.decap1()], [T.xr + 1, RIGS.wafer0()], [T.s6s, RIGS.wafer0()], [T.s6e, RIGS.wafer1()],
    [T.bp, RIGS.wafer1()], [T.bp + 1, RIGS.mark0()], [T.end, RIGS.mark1()],
  ];
  if (reduced) {
    // camera cuts, no interpolation: the rig of the beat under the viewport centre
    const c = y + innerHeight * 0.3;
    const pick = c < T.s2s ? RIGS.hero() : c < T.s3s ? RIGS.sockets() : c < T.s4s ? RIGS.pinout() : c < T.xr ? RIGS.decap1() : c < T.bp ? RIGS.wafer1() : RIGS.mark0();
    return pick;
  }
  for (let i = 0; i < K.length - 1; i++) {
    const [ya, ra] = K[i], [yb, rb] = K[i + 1];
    if (y <= yb || i === K.length - 2) { const t = yb > ya ? clamp01((y - ya) / (yb - ya)) : 1; return lerpRig(ra, rb, easeIO(t)); }
  }
  return K[K.length - 1][1];
}

// ---------------------------------------------------------------- pointer: hero tilt + drag the part into a socket
const ptr = { x: 0, y: 0, tx: 0, ty: 0, dragging: false };
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -4), hitP = new THREE.Vector3();
function setupPointer() {
  addEventListener('pointermove', (e) => {
    ptr.tx = (e.clientX / innerWidth) * 2 - 1; ptr.ty = (e.clientY / innerHeight) * 2 - 1;
    if (ptr.dragging) { rayFrom(e); if (ray.ray.intersectPlane(plane, hitP)) sockets.dragTo(hitP.x, Math.max(-8, Math.min(8, hitP.z))); }
  }, { passive: true });
  canvas.addEventListener('pointerdown', (e) => {
    if (!inReaders() || isMobile) return;
    rayFrom(e);
    const hitChip = ray.intersectObject(pkg.group, true).length > 0;
    if (hitChip) { ptr.dragging = true; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; userAt = scrollY; return; }
    // click a socket frame
    const hits = ray.intersectObject(sockets.row, true);
    if (hits.length) { let o = hits[0].object; while (o && o.parent !== sockets.row) o = o.parent; const i = sockets.sockets.findIndex((s) => s.group === o); if (i >= 0) userSeat(i); }
  });
  const up = (e) => { if (!ptr.dragging) return; ptr.dragging = false; canvas.style.cursor = ''; sockets.endDrag(); userAt = scrollY; try { canvas.releasePointerCapture(e.pointerId); } catch {} };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointermove', (e) => {
    if (ptr.dragging || !inReaders() || isMobile) return;
    rayFrom(e); canvas.style.cursor = ray.intersectObject(pkg.group, true).length ? 'grab' : ray.intersectObject(sockets.row, true).length ? 'pointer' : '';
  });
}
function rayFrom(e) { ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, stage.camera); }

function onResize() { stage.resize(); ScrollTrigger.refresh(); calloutEls.forEach((d) => (d._w = null)); }

// ---------------------------------------------------------------- loop
let last = performance.now(), lastP3 = 0, lastWaferP = -1, visibleCanvas = true;
function loop(now) {
  requestAnimationFrame(loop);
  if (document.hidden || !stage) return;
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const t = now / 1000;
  const y = lenis ? lenis.scroll : scrollY;
  const vh = innerHeight;
  // canvas fully covered by the bench (opaque) → skip rendering
  const covered = (y >= T.xr && y + vh <= T.s6s - (reduced ? 0 : 0)) || (y >= T.bp && y + vh <= T.bp + document.querySelector('#bench').offsetHeight);
  if (covered) { if (visibleCanvas) { visibleCanvas = false; heroCallouts(false); placePinLabels(false); } return; }
  visibleCanvas = true;

  const rig = rigAt(y);
  // zones
  const zChip = y < T.xr, zWafer = y >= T.xr && y < T.bp, zMark = y >= T.bp;
  // 3D rides in its reserved slot: the wafer scrolls in and out with the census sheet, the mark stays under its rule
  if (zWafer && SL.wafer) rig.sy += waferDy(y) / vh;
  if (zChip && !reduced && y > T.s4e) rig.sy -= (y - T.s4e) / vh;   // the decapped part leaves with its sheet
  if (zMark && SL.mark) rig.sy = markCy(y) / vh;
  markFill.intensity = zMark ? 1.8 : 0;
  holder.visible = zChip; wafer.group.visible = zWafer; mark.visible = zMark;

  // sockets blend: in from the right while the hero scrolls away, out to the left before the pinout
  let b2 = 0, dir = 1;
  if (y < T.s2s) { b2 = clamp01((y - 0) / Math.max(1, T.s2s)); dir = 1; }
  else if (y <= T.s2x) b2 = 1;   // pinned, then riding up with the sheet
  else { b2 = 1 - clamp01((y - T.s2x) / Math.max(1, T.s3s - T.s2x)); dir = -1; }
  if (reduced) b2 = y + vh * 0.3 >= T.s2s && y + vh * 0.3 < T.s3s ? 1 : 0;
  const e2 = easeIO(b2);
  sockets.group.visible = zChip && b2 > 0.001 && (reduced || y <= T.s2x);
  sockets.group.position.x = (1 - e2) * 190 * dir;
  const sp = sockets.update(t, dt, { panRate: isMobile ? 7 : 3.2 });   // ~1.5 sockets fit a phone: centre fast
  // chip pose: hero (on the page) → socket pose (hover / seated / dragged)
  ptr.x += (ptr.tx - ptr.x) * 0.08; ptr.y += (ptr.ty - ptr.y) * 0.08;
  const heroW = 1 - e2;
  holder.position.set(sp.chip.x * e2, sp.chip.y * e2, sp.chip.z * e2);
  holder.rotation.set(sp.chip.rx * e2 + ptr.y * 0.052 * heroW * (y < vh ? 1 : 0), 0, sp.chip.rz * e2 - ptr.x * 0.052 * heroW * (y < vh ? 1 : 0));
  contact.visible = holder.position.y < 0.3;
  pinHeat.glow.visible = current.version === 'v1' && holder.position.y < 0.3;
  // pin-1 heat breathes 1.8 ↔ 2.6 over 2.4 s
  if (pkg.materials.heatMat) pkg.materials.heatMat.emissiveIntensity = reduced ? 2.2 : 2.2 + 0.4 * Math.sin(t * Math.PI * 2 / 2.4);

  // decap progress
  const p4 = reduced ? (y + vh * 0.3 >= T.s4s && y < T.xr ? 1 : 0) : clamp01((y - T.s4s) / Math.max(1, T.s4e - T.s4s));
  if (decap) decap.update(t, zChip ? (y >= T.s4s - 2 ? Math.max(p4, 0) : 0) : 0);
  // wafer
  if (zWafer) {
    const p6 = reduced ? 1 : clamp01((y - (T.s6s - vh)) / Math.max(1, T.s6e - (T.s6s - vh)));
    wafer.update(t, p6); lastWaferP = p6;
  }
  if (zMark) mark.rotation.y = reduced ? 0.3 : 0.44 * clamp01((y - T.bp) / Math.max(1, T.end - T.bp)) + Math.sin(t * 0.4) * 0.06;
  stage.shadowBox(zWafer ? 70 : zMark ? 34 : 14 + (b2 > 0 ? 10 : 0));
  if (zMark) stage.floorFade(3, 3, 10, 24); else stage.floorFade();
  stage.setRig(rig);
  holder.updateMatrixWorld(true);
  stage.render();

  // DOM overlays tied to the 3D
  heroCallouts(y < vh * 0.12 && zChip, y);
  const p3 = reduced ? 1 : clamp01((y - T.s3s) / Math.max(1, T.s3e - T.s3s));
  const inPin = reduced ? (y + vh * 0.5 >= T.s3s && y + vh * 0.5 < T.s4s) : (y >= T.s3s - 2 && y <= T.s3e + vh * 0.05);
  placePinLabels(inPin && zChip, p3);
  if (timing && Math.abs(p3 - lastP3) > 0.001) { timing.set(reduced ? 1 : p3 * 2.6); lastP3 = p3; }
  // -32015 stamp: hangs under the socket that rejected the part (between the 3D band and the button row,
  // clear of the readout column)
  const st = $('#stamp');
  if (stampFor >= 0 && !st.hidden) {
    const c = sockets.socketCenters()[stampFor];
    const [sx, sy] = stage.project(stampV.set(c.x, 0, c.outer / 2));
    if (!st._w) st._w = st.offsetWidth;
    const top = sy + 14;
    st.style.left = Math.max(12, Math.min(innerWidth - st._w - 12, sx - st._w / 2)) + 'px'; st.style.top = top + 'px';
    const show = b2 >= 0.9 && sockets.group.visible && (reduced || y <= T.s2e + 2) && top > (SL.hdr || 56) + 8;   // a pinned-beat overlay only
    const v = show ? '' : 'hidden'; if (st.style.visibility !== v) st.style.visibility = v;
  }
}
