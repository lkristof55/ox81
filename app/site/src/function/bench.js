// Bench: the live X-ray. Input → /api/xray → datasheet result (strip, pins, lint, misread, v1 port, plate).
import { xray as apiXray, classify, fmt, short, utc, esc } from './api.js';
import { drawStrip, renderPlate } from './strip.js';
import { READERS, outcome } from '../scene/sockets.js';

const DASH_PKG = `<svg class="dashpkg" viewBox="0 0 220 220" aria-hidden="true"><rect x="40" y="40" width="140" height="140" fill="none" stroke="#121315" stroke-width="1.5" stroke-dasharray="6 5"/>${Array.from({ length: 12 }, (_, i) => { const d = 50 + i * 11; return `<path d="M40 ${d}h-16M180 ${d}h16M${d} 40v-16M${d} 180v16" stroke="#121315" stroke-width="1.5" stroke-dasharray="3 3"/>`; }).join('')}<circle cx="56" cy="56" r="5" fill="none" stroke="#121315" stroke-dasharray="2 2"/></svg>`;

const PART = (v) => (v === 'v1' ? 'OX81-V1' : v === 'v0' ? 'OX80-V0' : 'OX00-LGC');
const SHORTF = {
  version: 'VERSION', numRequiredSignatures: 'NUM_REQ_SIG', numReadonlySigned: 'NUM_RO_SIGNED', numReadonlyUnsigned: 'NUM_RO_UNSIGNED', configMask: 'CONFIG_MASK',
  lifetimeSpecifier: 'LIFETIME', recentBlockhash: 'BLOCKHASH', numInstructions: 'NUM_IX', numAddresses: 'NUM_ADDR', address: 'ADDR', configPriorityFee: 'CFG_PRIORITY_FEE',
  configComputeUnitLimit: 'CFG_CU_LIMIT', configLoadedAccountsDataSizeLimit: 'CFG_LOADED_LIMIT', configHeapSize: 'CFG_HEAP', configUnknown: 'CFG_UNKNOWN', ixHeader: 'IX_HDR',
  ixAccounts: 'IX_ACCTS', ixData: 'IX_DATA', signature: 'SIG', numSignatures: 'NUM_SIGS', ixProgramIndex: 'IX_PROG', ixNumAccounts: 'IX_NUM_ACCTS', ixDataLength: 'IX_DATA_LEN',
  numLookups: 'NUM_LOOKUPS', lookupTable: 'ALT', lookupNumWritable: 'ALT_NUM_W', lookupWritable: 'ALT_W', lookupNumReadonly: 'ALT_NUM_RO', lookupReadonly: 'ALT_RO',
};
export function pinName(r) {
  const b = SHORTF[r.field] || r.field.toUpperCase();
  if (r.index != null && (r.field === 'address' || r.field === 'signature' || r.field.startsWith('lookup'))) return `${b}[${r.index}]`;
  if (r.ix != null) return b.replace('IX_', `IX${r.ix}_`);
  return b;
}

// Strip legend: only the groups this tx has; the version key names the tx's own discriminator (0x81 / 0x80).
const KEYS = [
  ['version', (r) => (r.version === 'v1' ? ['#FF4B12', 'version 0x81'] : [ '#121315', `version ${r.discriminator ? r.discriminator.hex : '0x80'}`])],
  ['header', () => ['#121315', 'header']],
  ['config', () => ['repeating-linear-gradient(135deg,#121315 0 2px,#EDEEEB 2px 5px)', 'config']],
  ['lifetime', () => ['#5B5F63', 'lifetime']],
  ['count', () => ['radial-gradient(#121315 1px,transparent 1.5px) 0 0/5px 5px', 'count']],
  ['address', () => ['#A9AEB2', 'address']],
  ['instruction', () => ['repeating-linear-gradient(90deg,#121315 0 1.5px,#EDEEEB 1.5px 4px)', 'ix']],
  ['lookup', () => ['repeating-linear-gradient(45deg,#121315 0 1px,transparent 1px 6px),repeating-linear-gradient(135deg,#121315 0 1px,#EDEEEB 1px 6px)', 'lookup']],
  ['signature', () => ['repeating-linear-gradient(0deg,#121315 0 2px,#EDEEEB 2px 4px)', 'sig']],
];
function legend(r) {
  const has = new Set(r.ranges.map((x) => x.group));
  return KEYS.filter(([g]) => has.has(g)).map(([, f]) => { const [bg, label] = f(r); return `<span class="key"><i style="background:${bg}"></i>${label}</span>`; }).join('');
}

export function createBench({ root, form, input, presetsEl, onXray, reduced, toast }) {
  let current = null, busy = false, selLint = null, ctl = null;

  function empty() {
    root.innerHTML = `<div class="r-empty">${DASH_PKG}<p>no bytes, no ox. paste a signature <b>(64–88 base58 chars)</b> or the raw base64, or pick a part from <b>try:</b>. the dashed outline is where your package gets drawn.</p></div>`;
  }
  empty();

  function msg(html, { partial } = {}) {
    root.innerHTML = `<div class="r-empty">${DASH_PKG}<div>${partial || ''}<p class="r-msg">${html}</p></div></div>`;
  }

  async function run(q, { label } = {}) {
    const c = classify(q);
    form.classList.remove('bad');
    if (c.kind === 'empty') { empty(); input.focus(); return; }
    if (c.kind === 'bad') {
      form.classList.add('bad');
      msg(`that's not a signature or base64. a signature is 64–88 base58 chars; base64 is the raw wire tx, 1–4,096 bytes.`);
      return;
    }
    if (ctl) ctl.abort();
    ctl = new AbortController();
    busy = true;
    const approx = c.kind === 'raw' ? Math.floor(c.value.replace(/=+$/, '').length * 3 / 4) : null;
    root.innerHTML = `<div class="r-head"><span>${c.kind === 'sig' ? 'getTransaction' : 'raw paste'} · ${esc(short(c.value, 8, 6))}</span><span>reading</span></div>
      <p class="loading-box">${c.kind === 'sig' ? 'reading the wire… getTransaction(sig, { maxSupportedTransactionVersion: 1 })' : `walking ${fmt(approx)} bytes…`}</p>`;
    try {
      const r = await apiXray(c.value, { signal: ctl.signal });
      current = r; selLint = null;
      render(r, label);
      onXray && onXray(r);
    } catch (e) {
      if (e.name === 'AbortError') return;
      const code = e.code || 'UPSTREAM';
      if (code === 'BAD_INPUT') { form.classList.add('bad'); msg(`that's not a signature or base64. a signature is 64–88 base58 chars; base64 is the raw wire tx, 1–4,096 bytes.${e.message && e.message !== 'bad input' ? `<br><span class="muted">${esc(e.message)}</span>` : ''}`); }
      else if (code === 'NOT_FOUND') msg('no confirmed tx with that signature. too fresh, or it never landed.');
      else if (code === 'DECODE_FAILED') {
        const b = e.body || {}; const at = b.at ?? 0; const pr = (b.partial && b.partial.ranges) || [];
        const size = approx || (pr.length ? pr[pr.length - 1].end : at) ;
        msg(`the walk stopped at offset ${fmt(at)}. ${pr.length} ranges decoded before that; they're drawn. the rest is hatched.<br><span class="muted">${esc(b.error || '')}</span>`,
          { partial: pr.length || size ? `<div class="strip-wrap"><canvas id="partialStrip"></canvas></div>` : '' });
        const cv = root.querySelector('#partialStrip');
        if (cv) paintStrip(cv, { ranges: pr, version: b.partial && b.partial.version, size: Math.max(size, at + 1) }, [], at);
      } else if (code === 'RATE_LIMITED') {
        let s = e.retryAfter || 60;
        msg(`30 x-rays a minute per ip. the ox is slow on purpose. again in <span id="rl">${s}</span> s.`);
        const iv = setInterval(() => { s--; const el = root.querySelector('#rl'); if (!el || s <= 0) { clearInterval(iv); if (el) el.textContent = '0'; return; } el.textContent = s; }, 1000);
      } else if (code === 'TIMEOUT') msg('8 s and no bytes from the rpc. paste the base64 instead: raw paste needs no rpc.');
      else msg('the rpc answered with an error, not bytes. nothing decoded, nothing guessed.');
    } finally { busy = false; }
  }

  function paintStrip(cv, xr, marks = [], partialAt = null) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 1200, H = 84;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const lay = drawStrip(g, xr, { x0: 1, y0: 1, W: W - 2, H: 56, marks, partialAt, size: xr.size });
    return lay;
  }

  function render(r, label) {
    const n = r.ranges.length;
    const stretch = 62 + 63 * Math.min(1, r.size / 4096);
    const lints = r.lint || [];
    const sevOrder = { error: 0, warn: 1, info: 2 };
    lints.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
    const readers = READERS.map((rd, i) => ({ rd, o: outcome(r, i) }));
    const cfg = r.config;
    const port = r.v1Port;
    const when = r.meta ? `slot ${fmt(r.meta.slot)} · ${utc(r.meta.blockTime)}` : 'raw paste · no rpc';
    const meta = r.meta ? `fee ${fmt(r.meta.fee)} lamports · ${fmt(r.meta.computeUnitsConsumed)} CU consumed${r.meta.err ? ' · <b>failed on-chain</b>' : ''}` : 'no meta on the raw path';
    root.innerHTML = `
      <div class="r-head"><span>${PART(r.version)} · ${esc(short(r.signature || 'raw', 8, 6))} · ${when}</span>${r.signature ? `<a href="https://solscan.io/tx/${esc(r.signature)}" target="_blank" rel="noopener">explorer ↗</a>` : ''}</div>
      <div class="r-size"><span class="n" style="font-stretch:${stretch.toFixed(0)}%">${r.version} · ${fmt(r.size)} B</span>
        <span class="d">of <b>${fmt(r.maxSize)}</b> · <b>${n}</b> ranges · no gaps${r.discriminator ? ` · discriminator <b>${r.discriminator.hex}</b> @ ${r.discriminator.offset}` : ' · no version prefix'}<br>${meta}</span></div>
      <div class="strip-wrap" id="stripWrap"><canvas id="strip" aria-label="byte strip: ${n} ranges"></canvas><div class="probe-box" id="probeBox" hidden></div></div>
      <div class="strip-tools">${legend(r)}<button class="btn" id="zoomBtn" type="button" style="display:none">2× zoom</button></div>
      <div class="actions"><button class="btn solid" id="plateBtn" type="button">Save plate</button><button class="btn" id="seatBtn" type="button">Seat it in the six readers ↑</button></div>
      <div class="r-grid">
        <div>
          <section class="r-sec"><h3><span>Pin table</span><span>${n} pins = ${n} ranges</span></h3>
            <div class="scroll-tbl"><table class="dt"><thead><tr><th class="num">Pin</th><th>Offset</th><th class="num">Bytes</th><th>Field</th><th>Value</th></tr></thead><tbody id="pinRows"></tbody></table></div></section>
          ${cfg ? `<section class="r-sec"><h3><span>Config · mask ${cfg.maskHex}</span><span>bits ${cfg.bits.join(', ') || 'none'}</span></h3>
            <table class="dt"><tbody>
            <tr><td>priority fee</td><td class="num">${cfg.priorityFeeLamports != null ? fmt(cfg.priorityFeeLamports) + ' lamports' : '<span class="muted">unset → 0</span>'}</td></tr>
            <tr><td>compute unit limit</td><td class="num">${cfg.computeUnitLimit != null ? fmt(cfg.computeUnitLimit) + ' CU' : '<span class="muted">unset → 0</span>'}</td></tr>
            <tr><td>loaded accounts data size limit</td><td class="num">${cfg.loadedAccountsDataSizeLimit != null ? fmt(cfg.loadedAccountsDataSizeLimit) + ' B' : '<span class="muted">unset → 0</span>'}</td></tr>
            <tr><td>heap size</td><td class="num">${cfg.heapSize != null ? fmt(cfg.heapSize) + ' B' : '<span class="muted">unset → 32,768</span>'}</td></tr>
            </tbody></table></section>` : ''}
        </div>
        <div>
          <section class="r-sec"><h3><span>Electrical characteristics · lint</span><span>${lints.length} finding${lints.length === 1 ? '' : 's'}</span></h3>
            ${lints.length ? `<table class="dt"><thead><tr><th>Parameter</th><th>Condition</th><th class="num">Value</th><th>Unit</th><th>Sev.</th></tr></thead><tbody id="lintRows">${lints.map((f, i) => `<tr class="click ${f.severity !== 'info' ? 'hit' : ''}" data-i="${i}" tabindex="0"><td><b>${esc(f.id)}</b><br><span class="muted">${esc(f.detail)}</span></td><td>${esc(f.title)}</td><td class="num">${f.cu != null ? fmt(f.cu) : f.bytes != null ? fmt(f.bytes) : '–'}</td><td>${f.cu != null ? 'CU' : f.bytes != null ? 'B' : ''}</td><td><span class="sev ${f.severity}">${f.severity}</span></td></tr>`).join('')}</tbody></table><p class="caption" style="margin-top:8px">click a row: its bytes get the DON'T CARE hatch in the strip.</p>` : `<p class="dashed">lint ran every rule on these ${fmt(r.size)} bytes. nothing to flag.</p>`}
          </section>
          <section class="r-sec"><h3><span>Misread · six readers</span><span>ox81.misread()</span></h3>
            <ul class="mis">${readers.map(({ rd, o }, i) => `<li><span class="k">${i + 1}</span><span><b>${esc(rd.label)}</b>${esc(o.main)}${o.sub && o.sub !== o.main ? `<br><span class="muted">${esc(o.sub)}</span>` : ''}</span><span class="st ${o.ok ? 'good' : 'bad'}">${o.ok ? 'seats' : o.kind === 'reject' ? String(o.code) : o.kind === 'rail' ? String(o.claimed) + ' sigs' : o.kind === 'misfile' ? 'as v0' : 'misread'}</span></li>`).join('')}</ul>
          </section>
          ${port ? `<section class="r-sec"><h3><span>v1 port</span><span>ox81.v1Port()</span></h3>${portFig(r, port)}</section>` : r.version === 'v1' ? `<section class="r-sec"><h3><span>v1 port</span><span>n/a</span></h3><p class="caption" style="margin-top:10px">already 0x81. nothing to port.</p></section>` : ''}
        </div>
      </div>`;
    const cv = root.querySelector('#strip');
    const wrap = root.querySelector('#stripWrap');
    let lay = paintStrip(cv, r);
    const marks = () => (selLint != null ? lints[selLint].ranges : []);
    const probe = root.querySelector('#probeBox');
    cv.addEventListener('pointermove', (ev) => {
      const b = cv.getBoundingClientRect(); const x = ev.clientX - b.left;
      const hit = lay.find((l) => x >= l.x && x < l.x + l.w);
      if (!hit || !hit.r.field) { probe.hidden = true; return; }
      const rr = hit.r;
      probe.hidden = false; probe.style.left = `${x + (cv.offsetLeft || 0)}px`; probe.style.top = '0px';
      probe.textContent = `[${rr.start}, ${rr.end}) ${rr.field} · ${rr.value != null ? String(rr.value).slice(0, 28) : ''}${rr.value && String(rr.value).length > 28 ? '…' : ''} · ${rr.end - rr.start} B`;
    });
    cv.addEventListener('pointerleave', () => { probe.hidden = true; });
    // rows print in offset order (the byte clock), capped at 1.2 s
    const rows = root.querySelector('#pinRows');
    const per = reduced ? 0 : Math.min(24, 1200 / n);
    rows.innerHTML = r.ranges.map((x, i) => `<tr class="${reduced ? '' : 'row-in'}" style="animation-delay:${(i * per).toFixed(0)}ms"><td class="num">${i + 1}</td><td>[${x.start}, ${x.end})</td><td class="num">${x.end - x.start}</td><td>${esc(x.label || x.field)}</td><td>${esc(x.value == null ? '–' : String(x.value).length > 22 ? String(x.value).slice(0, 22) + '…' : x.value)}</td></tr>`).join('');
    const lintRows = root.querySelector('#lintRows');
    if (lintRows) {
      const pick = (tr) => { const i = Number(tr.dataset.i); selLint = selLint === i ? null : i; lintRows.querySelectorAll('tr').forEach((t) => t.classList.toggle('sel', Number(t.dataset.i) === selLint)); lay = paintStrip(cv, r, marks()); };
      lintRows.addEventListener('click', (e) => { const tr = e.target.closest('tr'); if (tr) pick(tr); });
      lintRows.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const tr = e.target.closest('tr'); if (tr) pick(tr); } });
    }
    root.querySelector('#plateBtn').addEventListener('click', () => {
      const c = renderPlate(r);
      c.toBlob((b) => {
        const a = document.createElement('a'); a.href = URL.createObjectURL(b);
        a.download = `ox81-plate-${r.signature ? r.signature.slice(0, 8) : 'raw'}.png`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('plate saved · 1600×900 · post it with the slot');
      }, 'image/png');
    });
    root.querySelector('#seatBtn').addEventListener('click', () => { onXray && onXray(r, { seat: true }); });
    const zb = root.querySelector('#zoomBtn');
    if (window.matchMedia('(max-width:768px)').matches) { zb.style.display = ''; zb.addEventListener('click', () => { wrap.classList.toggle('zoom'); lay = paintStrip(cv, r, marks()); }); }
    window.addEventListener('resize', () => { if (current === r) lay = paintStrip(cv, r, marks()); }, { passive: true });
  }

  function portFig(r, p) {
    const k = 150 / Math.sqrt(4096);
    const a = Math.sqrt(r.size) * k, b = Math.sqrt(p.size) * k, H = Math.max(a, b) + 20;
    return `<div class="port"><svg width="${a + b + 60}" height="${H}" viewBox="0 0 ${a + b + 60} ${H}" aria-hidden="true">
      <rect x="1" y="${H - a - 1}" width="${a}" height="${a}" fill="#16171A"/><text x="4" y="${H - a - 6}" font-size="10" font-family="Atkinson Hyperlegible Mono" fill="#5B5F63">${r.version} · ${fmt(r.size)} B</text>
      <rect x="${a + 40}" y="${H - b - 1}" width="${b}" height="${b}" fill="${p.fits ? '#16171A' : 'none'}" stroke="#121315" stroke-width="1.5" ${p.fits ? '' : 'stroke-dasharray="4 3"'}/><rect x="${a + 40}" y="${H - b - 1}" width="6" height="6" fill="#FF4B12"/>
      <text x="${a + 40}" y="${H - b - 6}" font-size="10" font-family="Atkinson Hyperlegible Mono" fill="#5B5F63">v1 · ${fmt(p.size)} B</text></svg>
      <p>v1 port: <b>${fmt(r.size)} B → ${fmt(p.size)} B (${p.bytesDelta >= 0 ? '+' : ''}${fmt(p.bytesDelta)})</b> · ${p.removedComputeBudgetIxs} ComputeBudget ix${p.removedComputeBudgetIxs === 1 ? '' : 's'} become config slots (bits ${p.configBits.join(', ')}) · ${p.inlinedLookupAddresses ? `${p.inlinedLookupAddresses} lookup addresses inlined · ` : ''}<b>${p.fits ? 'fits' : 'does not fit'}</b>${p.blockers && p.blockers.length ? `<br>blockers: ${esc(p.blockers.join('; '))}` : ''}<br><span class="muted">drawn at true relative scale (side ∝ √bytes). the port must be re-signed; not modelled.</span></p></div>`;
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); run(input.value); });
  return { run, get current() { return current; }, get busy() { return busy; } };
}
