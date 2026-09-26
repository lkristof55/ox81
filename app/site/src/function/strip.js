// The byte strip: a transaction drawn as one row of its byte ranges, in the datasheet group patterns
// (encoded by value and pattern, not hue). Used by the bench result and by the Save-plate PNG.
const INK = '#121315', SHEET = '#EDEEEB', GRAPH = '#5B5F63', TIN = '#A9AEB2', HEAT = '#FF4B12';

const pats = new Map();
function pat(g, key, draw, size) {
  const k = key + size;
  if (!pats.has(k)) {
    const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d');
    x.fillStyle = SHEET; x.fillRect(0, 0, size, size); draw(x, size); pats.set(k, c);
  }
  return g.createPattern(pats.get(k), 'repeat');
}
export function groupFill(g, group, version, s = 1) {
  switch (group) {
    case 'version': return version === 'v1' ? HEAT : INK;
    case 'header': return INK;
    case 'lifetime': return GRAPH;
    case 'address': return TIN;
    case 'config': return pat(g, 'cfg', (x, n) => { x.strokeStyle = INK; x.lineWidth = 2 * s; for (let k = -n; k <= n * 2; k += n) { x.beginPath(); x.moveTo(k, n); x.lineTo(k + n, 0); x.stroke(); } }, Math.round(5 * s));
    case 'count': return pat(g, 'cnt', (x, n) => { x.fillStyle = INK; x.fillRect(1 * s, 1 * s, 2 * s, 2 * s); }, Math.round(5 * s));
    case 'instruction': return pat(g, 'ix', (x, n) => { x.fillStyle = INK; x.fillRect(0, 0, 1.5 * s, n); }, Math.round(4 * s));
    case 'lookup': return pat(g, 'lk', (x, n) => { x.strokeStyle = INK; x.lineWidth = 1 * s; for (const d of [1, -1]) for (let k = -n; k <= n * 2; k += n) { x.beginPath(); x.moveTo(k, d > 0 ? n : 0); x.lineTo(k + n, d > 0 ? 0 : n); x.stroke(); } }, Math.round(6 * s));
    case 'signature': return pat(g, 'sig', (x, n) => { x.fillStyle = INK; x.fillRect(0, 0, n, 2 * s); }, Math.round(4 * s));
    default: return GRAPH;
  }
}
export function dontCare(g, s = 1) {
  return pat(g, 'dc', (x, n) => { x.fillStyle = 'rgba(0,0,0,0)'; x.clearRect(0, 0, n, n); x.fillStyle = SHEET; x.fillRect(0, 0, n, n); x.strokeStyle = HEAT; x.lineWidth = 1.5 * s; for (const d of [1, -1]) for (let k = -n; k <= n * 2; k += n) { x.beginPath(); x.moveTo(k, d > 0 ? n : 0); x.lineTo(k + n, d > 0 ? 0 : n); x.stroke(); } }, Math.round(5 * s));
}

// Widths: proportional to bytes, with a floor so a 1-byte range stays visible; the rest scales down.
export function layoutStrip(ranges, W, minW = 3) {
  const size = ranges.length ? ranges[ranges.length - 1].end : 1;
  let k = W / size;
  for (let it = 0; it < 6; it++) {
    let fixed = 0, flex = 0;
    for (const r of ranges) { const w = (r.end - r.start) * k; if (w < minW) fixed += minW; else flex += r.end - r.start; }
    k = flex ? (W - fixed) / flex : k;
  }
  let x = 0;
  return ranges.map((r) => { const w = Math.max(minW, (r.end - r.start) * k); const o = { r, x, w }; x += w; return o; });
}

export function drawStrip(g, xr, { x0 = 0, y0 = 0, W, H, s = 1, marks = [], ticks = true, partialAt = null, size = null } = {}) {
  const total = size || xr.size || (xr.ranges.length ? xr.ranges[xr.ranges.length - 1].end : 0);
  let ranges = xr.ranges;
  let tail = null;
  if (partialAt != null && total > partialAt) { tail = { start: partialAt, end: total }; }
  const all = tail ? [...ranges, { ...tail, group: '__dc' }] : ranges;
  const lay = layoutStrip(all, W, 3 * s);
  const hl = (r) => marks.some(([a, b]) => r.start < b && r.end > a);
  for (const { r, x, w } of lay) {
    g.fillStyle = r.group === '__dc' ? dontCare(g, s) : hl(r) ? dontCare(g, s) : groupFill(g, r.group, xr.version, s);
    g.fillRect(x0 + x, y0, Math.max(1, w - 1 * s), H);
  }
  g.strokeStyle = INK; g.lineWidth = 2 * s; g.strokeRect(x0 - s, y0 - s, W + 2 * s, H + 2 * s);
  if (ticks) {
    g.fillStyle = INK; g.font = `600 ${10 * s}px "Atkinson Hyperlegible Mono"`; g.textBaseline = 'top';
    let lastX = -1e9;
    const endTxt0 = String(total), endW = g.measureText(endTxt0).width + 8 * s;
    for (const { r, x } of lay) {
      if (x - lastX < 34 * s && r.start !== 0) continue;
      if (r.start !== 0 && x + 2 * s + g.measureText(String(r.start)).width > W - endW) continue;   // keep clear of the end label
      g.fillRect(x0 + x, y0 + H + 2 * s, 1 * s, 5 * s);
      g.fillText(String(r.start), x0 + x + 2 * s, y0 + H + 8 * s);
      lastX = x;
    }
    const endTxt = String(total); g.textAlign = 'right'; g.fillText(endTxt, x0 + W, y0 + H + 8 * s); g.textAlign = 'left';
  }
  return lay;
}

// Mark (8x8 bitmap) at x,y with a given cell size.
export function drawMark(g, x, y, cell) {
  const rows = [0x81, 0x81, 0xff, 0xdb, 0x7e, 0x3c, 0x3c, 0x18];
  rows.forEach((row, r) => { for (let c = 0; c < 8; c++) if (row & (0x80 >> c)) { g.fillStyle = r === 0 ? HEAT : INK; g.fillRect(x + c * cell, y + r * cell, cell, cell); } });
  // eyes: rows 3 (0xdb) holes already in bitmap
}

// Save plate: 1600x900 PNG of the user's own X-ray, drawn client-side.
export function renderPlate(xr) {
  const W = 1600, H = 900, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = SHEET; g.fillRect(0, 0, W, H);
  // running head
  g.fillStyle = INK; g.font = '700 16px "Atkinson Hyperlegible Mono"'; g.textBaseline = 'alphabetic';
  const part = xr.version === 'v1' ? 'OX81-V1' : xr.version === 'v0' ? 'OX80-V0' : 'OX00-LGC';
  const slot = xr.meta ? `SLOT ${xr.meta.slot}` : 'RAW PASTE · NO RPC';
  g.fillText(`${part} · ADVANCE INFORMATION · BYTE X-RAY · ${slot}`, 64, 72);
  g.fillRect(64, 86, W - 128, 4);
  // part number + size
  g.font = '800 132px "Archivo"'; g.fillText(part, 60, 236);
  g.font = '800 64px "Archivo"'; g.fillText(`${xr.size.toLocaleString('en-US')} B`, 64, 320);
  g.font = '600 20px "Atkinson Hyperlegible Mono"'; g.fillStyle = GRAPH;
  g.fillText(`of ${xr.maxSize.toLocaleString('en-US')} · ${xr.ranges.length} ranges · no gaps${xr.config ? ' · mask ' + xr.config.maskHex : ''}`, 64, 356);
  if (xr.signature) g.fillText(`sig ${xr.signature.slice(0, 22)}…`, 64, 386);
  // caution corner: lint verdict
  const lint = xr.lint || [];
  const worst = lint.find((f) => f.severity === 'error') || lint.find((f) => f.severity === 'warn');
  const infos = lint.filter((f) => f.severity === 'info');
  const cx = 1000, cy = 130, cw = 536, ch = 200;
  g.fillStyle = INK; g.fillRect(cx, cy, 5, ch);
  g.lineWidth = 5; g.strokeStyle = INK;
  if (worst || !infos.length) {
    g.beginPath(); g.moveTo(cx + 60, cy + 24); g.lineTo(cx + 96, cy + 86); g.lineTo(cx + 24, cy + 86); g.closePath(); g.stroke();
    g.fillRect(cx + 57, cy + 44, 6, 22); g.fillRect(cx + 57, cy + 72, 6, 6);
  } else {
    // info only: a circled i, not a caution triangle
    g.beginPath(); g.arc(cx + 60, cy + 56, 30, 0, Math.PI * 2); g.stroke();
    g.fillRect(cx + 57, cy + 38, 6, 6); g.fillRect(cx + 57, cy + 50, 6, 22);
  }
  // the title fits the caution box: long lint ids step the size down, then maxWidth as a last guard
  const title = worst ? `Caution · ${worst.id}` : infos.length ? `No errors · ${infos.length} info` : 'No findings';
  let fs = 30; g.font = `800 ${fs}px "Archivo"`;
  while (fs > 16 && g.measureText(title).width > cw - 130) { fs -= 1; g.font = `800 ${fs}px "Archivo"`; }
  g.fillText(title, cx + 120, cy + 58, cw - 130);
  g.font = '600 18px "Atkinson Hyperlegible Mono"';
  const more = worst ? lint.length - 1 : 0;
  const msg = worst ? `${worst.title}${worst.cu ? ` · ${worst.cu.toLocaleString('en-US')} CU` : ''}${more ? ` · +${more} more finding${more > 1 ? 's' : ''}` : ''}`
    : infos.length ? `no errors or warnings. info: ${infos.map((f) => f.id).join(' · ')}` : 'lint ran every rule. nothing to flag.';
  wrap(g, worst || !infos.length ? msg.toLowerCase() : msg, cx + 120, cy + 96, cw - 130, 26, 4);   // lint ids keep their case, as in the table
  if (worst) { g.fillStyle = HEAT; g.fillRect(cx + 120, cy + 12, 90, 8); }
  // the strip
  g.fillStyle = INK;
  const marks = (xr.lint || []).filter((f) => f.id === 'V1_DEAD_COMPUTE_BUDGET').flatMap((f) => f.ranges);
  drawStrip(g, xr, { x0: 64, y0: 470, W: W - 128, H: 190, s: 1.6, marks });
  g.fillStyle = GRAPH; g.font = '600 16px "Atkinson Hyperlegible Mono"';
  g.fillText('offsets under the strip are byte offsets · patterns = field groups (version, header, config, lifetime, count, address, ix, lookup, sig)', 64, 732);
  // footer
  g.fillStyle = INK; g.fillRect(64, 790, W - 128, 3);
  drawMark(g, 64, 812, 7);
  g.font = '800 30px "Archivo"'; g.fillText('Ox81', 136, 850);
  g.font = '600 16px "Atkinson Hyperlegible Mono"'; g.fillStyle = GRAPH;
  const when = xr.meta && xr.meta.blockTime ? new Date(xr.meta.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'raw paste';
  g.fillText(`${when} · decoded by ox81 · github.com/lkristof55/ox81`, 236, 850);
  return c;
}
function wrap(g, text, x, y, maxW, lh, maxLines) {
  const lines = []; let line = '';
  for (const w of text.split(' ')) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {   // out of room: the last line ends in an ellipsis instead of dropping words silently
    lines.length = maxLines; let l = lines[maxLines - 1];
    while (l && g.measureText(l + '…').width > maxW) l = l.slice(0, -1);
    lines[maxLines - 1] = l + '…';
  }
  lines.forEach((l, i) => g.fillText(l, x, y + i * lh));
}
