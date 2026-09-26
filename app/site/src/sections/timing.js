// Figure 3: the timing diagram. Fields in offset order along x (not to scale: widths are log-compressed and long
// runs are broken), each tick labelled with its real start offset. Rows: V1 READER, PRE-V1 PARSER, GEYSER.
// Rows: V1 READER (bus eyes per field), PRE-V1 PARSER (0x81 + byte 1 as a sig count, running past the end), GEYSER (versioned → v0).
import { pinName } from '../function/bench.js';
import { v1Misread } from '../function/api.js';

const NS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');

function cellsFrom(xr) {
  const out = [];
  const R = xr.ranges;
  for (let i = 0; i < R.length; i++) {
    const r = R[i];
    let j = i;
    while (j + 1 < R.length && R[j + 1].field === r.field && (r.field === 'address' || r.field === 'signature' || r.field === 'lookupTable')) j++;
    const n = j - i + 1;
    const start = r.start, end = R[j].end;
    let text;
    if (n > 1) text = `${pinName(r).replace(/\[\d+\]/, '')} ×${n}`;
    else if (r.field === 'version') text = r.value;
    else if (r.field === 'configMask') text = r.value;
    else if (r.group === 'address' || r.group === 'signature' || r.field === 'lifetimeSpecifier' || r.field === 'recentBlockhash' || r.field === 'lookupTable') text = (r.value || '').slice(0, 6) + '…';
    else if (r.field === 'ixHeader' || r.field === 'ixData' || r.field === 'ixAccounts') text = pinName(r);
    else text = r.value ?? pinName(r);
    out.push({ start, end, field: r.field, group: r.group, text, name: pinName(r), broken: n > 2, ix: r.ix });
    i = j;
  }
  // too many cells: merge runs of instruction cells
  if (out.length > 30) {
    const m = [];
    for (const c of out) {
      const last = m[m.length - 1];
      if (last && last.group === 'instruction' && c.group === 'instruction') { last.end = c.end; last.count = (last.count || 1) + 1; last.text = `IX ×${Math.ceil(last.count / 3)}`; last.broken = true; }
      else m.push({ ...c });
    }
    return m;
  }
  return out;
}

export function buildTiming(svg, xr, opts = {}) {
  const W = opts.width || 600;
  const L = 96, R = W - 24;
  const cells = cellsFrom(xr);
  const raw = cells.map((c) => (c.broken ? 30 : 16 + 9 * Math.log2(1 + (c.end - c.start))));
  const k = (R - L) / raw.reduce((a, b) => a + b, 0);
  let x = L;
  const pos = cells.map((c, i) => { const o = { ...c, x0: x, x1: x + raw[i] * k }; x += raw[i] * k; return o; });
  const dead = new Set();
  for (const f of xr.lint || []) if (f.id === 'V1_DEAD_COMPUTE_BUDGET') for (const [a, b] of f.ranges) for (const c of pos) if (c.start < b && c.end > a) dead.add(c);
  const rows = xr.version === 'v1' ? ['V1 READER', 'PRE-V1 PARSER', 'GEYSER'] : [`${xr.version.toUpperCase()} READER`];
  const rowY = (i) => 44 + i * 78;
  const H = rowY(rows.length - 1) + 74;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const h = 11, s = 4;
  const eye = (x0, x1, y) => `M${x0} ${y}L${x0 + s} ${y - h}L${x1 - s} ${y - h}L${x1} ${y}L${x1 - s} ${y + h}L${x0 + s} ${y + h}Z`;
  let g = `<defs><pattern id="dc" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 5L5 0M-1 1L1 -1M4 6L6 4M0 0L5 5" stroke="#FF4B12" stroke-width="1.2"/></pattern>
    <clipPath id="tclip"><rect id="tclipR" x="0" y="0" width="${W}" height="${H}"/></clipPath></defs><g clip-path="url(#tclip)">`;
  rows.forEach((name, i) => {
    g += `<text x="0" y="${rowY(i) + 4}" font-size="10" font-weight="700" letter-spacing=".06em" fill="#121315">${name}</text>`;
  });
  // V1 / main reader row
  const y0 = rowY(0);
  for (const c of pos) {
    const w = c.x1 - c.x0;
    g += `<path d="${eye(c.x0, c.x1, y0)}" fill="${dead.has(c) ? 'url(#dc)' : c.field === 'version' && xr.version === 'v1' ? '#FF4B12' : 'none'}" stroke="#121315" stroke-width="1.6"/>`;
    const maxC = Math.floor((w - 6) / 5.6);
    if (maxC >= 2) { const t = c.text.length > maxC ? c.text.slice(0, maxC - 1) + '…' : c.text; g += `<text x="${(c.x0 + c.x1) / 2}" y="${y0 + 3.5}" font-size="9" text-anchor="middle" fill="#121315">${esc(t)}</text>`; }
    if (c.broken) g += `<path d="M${(c.x0 + c.x1) / 2 - 5} ${y0 + h + 4}l4 -8M${(c.x0 + c.x1) / 2 + 1} ${y0 + h + 4}l4 -8" stroke="#121315" stroke-width="1.2"/>`;
  }
  // axis ticks under the v1 row (start offsets); none collide with the end label
  let lastX = -99;
  const endW = String(xr.size).length * 5.2 + 8;
  for (const c of pos) {
    if (c.x0 - lastX < 26) continue;
    if (c.x0 + String(c.start).length * 5.2 > R - endW) continue;
    g += `<path d="M${c.x0} ${y0 + h + 6}v5" stroke="#5B5F63"/><text x="${c.x0}" y="${y0 + h + 20}" font-size="8.5" fill="#5B5F63">${c.start}</text>`;
    lastX = c.x0;
  }
  g += `<text x="${R}" y="${y0 + h + 20}" font-size="8.5" fill="#5B5F63" text-anchor="end">${xr.size}</text>`;
  if (xr.version === 'v1') {
    const mr = v1Misread(xr);
    const claimed = mr.claimed, needed = mr.needed;
    const y1 = rowY(1);
    const a = pos[0].x0, b = pos[1] ? pos[1].x1 : pos[0].x1;
    g += `<path d="${eye(a, b + 40, y1)}" fill="#EDEEEB" stroke="#121315" stroke-width="1.6"/><text x="${a + 6}" y="${y1 + 3.5}" font-size="9" fill="#121315">n=${claimed}</text>`;
    g += `<path d="M${b + 40} ${y1}L${b + 44} ${y1 - h}L${R} ${y1 - h}M${b + 40} ${y1}L${b + 44} ${y1 + h}L${R} ${y1 + h}" fill="none" stroke="#121315" stroke-width="1.6"/>`;
    g += `<path d="M${R} ${y1 - h}h22M${R} ${y1 + h}h22" stroke="#121315" stroke-width="1.6" stroke-dasharray="3 3"/><path d="M${R + 18} ${y1 - 4}l6 4l-6 4" fill="none" stroke="#121315" stroke-width="1.6"/>`;
    g += `<text x="${b + 52}" y="${y1 + 3.5}" font-size="9" fill="#121315">SIG[0..${claimed - 1}] · 64 B each · needs ${fmt(needed)} B, has ${fmt(xr.size)}</text>`;
    g += `<text x="${a}" y="${y1 + h + 16}" font-size="8.5" fill="#5B5F63">0x81 ${mr.b1hex} read as compact-u16: ${mr.formula ? mr.formula + ' = ' : ''}${claimed}</text>`;
    const y2 = rowY(2);
    g += `<path d="${eye(L, R, y2)}" fill="none" stroke="#121315" stroke-width="1.6"/><text x="${(L + R) / 2}" y="${y2 + 3.5}" font-size="9" text-anchor="middle" fill="#121315">versioned = true → filed as v0 (true for v0 and v1)</text>`;
  }
  g += '</g>';
  // scan cursor: while the diagram draws, an ink line marks the edge, so a partial frame reads as a sweep
  g += `<path id="tcur" d="M0 ${rowY(0) - 26}V${H - 20}" stroke="#121315" stroke-width="1" stroke-dasharray="2 2"/>`;
  svg.innerHTML = g;
  const clip = svg.querySelector('#tclipR'), cur = svg.querySelector('#tcur');
  let last = -1;
  return { set(p) {
    const q = Math.max(0, Math.min(1, p)); if (q === last) return; last = q;
    const x = L - 6 + q * (W - L + 6);
    clip.setAttribute('width', x.toFixed(1));
    cur.setAttribute('transform', `translate(${x.toFixed(1)} 0)`);
    cur.style.display = q > 0 && q < 1 ? '' : 'none';
  } };
}
void NS;
