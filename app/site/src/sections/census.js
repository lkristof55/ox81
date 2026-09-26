// Typical characteristics: the live census (latest block / 24 h) as a datasheet table. Every number from /api/census.
import { census as apiCensus, fmt, pct, utc, esc, short } from '../function/api.js';

export function censusRows(c) {
  const v1 = c.v1, dc = v1.deadComputeBudget;
  const slots = c.slots.first === c.slots.last ? fmt(c.slots.last) : `${fmt(c.slots.first)} – ${fmt(c.slots.last)}`;
  const masks = v1.masks || [], m0 = masks[0], mrest = masks.slice(1, 3);
  const mhex = (m) => `0x${m.mask.toString(16).padStart(8, '0')} ×${m.count}`;
  const rows = [
    ['Window', c.window === '24h' ? `24 h · ${c.blocks} snapshot block${c.blocks === 1 ? '' : 's'}${c.fallback ? ' (fallback: latest only)' : ''}` : 'latest snapshot block', ''],
    ['Slot', slots, ''],
    ['Block time', c.blockTime.first === c.blockTime.last ? utc(c.blockTime.last) : `${utc(c.blockTime.first)} – ${utc(c.blockTime.last)}`, ''],
    ['Transactions', fmt(c.txs.total), `${fmt(c.txs.vote)} vote · ${fmt(c.txs.nonVote)} non-vote`],
    ['By version', `${fmt(c.versions.legacy)} / ${fmt(c.versions.v0)} / ${fmt(c.versions.v1)}`, 'legacy / v0 / v1'],
    ['v1 share', `${pct(v1.shareAll)} %`, `of all txs · ${pct(v1.shareNonVote)} % of non-vote`, true],
    ['v1 over 1,232 B', fmt(v1.over1232), `of ${fmt(v1.count)} v1 · only possible as v1`],
    ['Dead ComputeBudget', `${fmt(dc.txs)} tx · ${fmt(dc.ixs)} ix`, `${fmt(dc.cu)} CU for nothing · ${fmt(dc.failedTxs)} of those failed (program errors, not the no-op)`, dc.txs > 0],
    ['Priority only in a dead ix', fmt(v1.priorityOnlyInIx), 'v1 txs that bid 0 priority'],
    ['Loaded limit at 64 MiB max', fmt(v1.loadedLimitMax), 'v1 txs'],
    ['CU / loaded limit absent', `${fmt(v1.cuLimitAbsent)} / ${fmt(v1.loadedLimitAbsent)}`, 'v1 txs'],
    ['CU over-ask, median', v1.cuOveraskMedian == null ? '–' : `${v1.cuOveraskMedian.toFixed(2)}×`, 'limit ÷ consumed'],
    ['v1 size p50 / p90 / max', `${fmt(v1.size.p50)} / ${fmt(v1.size.p90)} / ${fmt(v1.size.max)} B`, ''],
    ['Top config mask', m0 ? mhex(m0) : '–', `${mrest.length ? `then ${mrest.map(mhex).join(' · ')} · ` : ''}bits 0+1 fee · 2 CU · 3 loaded · 4 heap`],
    ['v0 with lookup tables', `${fmt(c.v0.withLookups)} of ${fmt(c.v0.count)}`, ''],
  ];
  return rows;
}

export function createCensus({ table, head, toggle, band, bandBig, bandTxt, mCensus, fig5, onData, reduced }) {
  const cache = {};
  let windowName = 'latest';
  function stamp(c) {
    const age = Math.round((Date.now() - new Date(c.generatedAt).getTime()) / 60000);
    return c.stale ? `<span class="stale">STALE</span> <span class="muted">snapshot from slot ${fmt(c.slots.last)}, ${age} min old. the cron runs every 10 min.</span>` : '';
  }
  function renderTable(c) {
    const rows = censusRows(c);
    table.innerHTML = `<table class="dt"><thead><tr><th>Parameter</th><th class="num">Value</th><th>Condition</th></tr></thead><tbody>${rows.map(([a, b, cnd, hit], i) => `<tr class="${hit ? 'hit' : ''} ${reduced ? '' : 'row-in'}" style="animation-delay:${i * 24}ms"><td>${esc(a)}</td><td class="num"><b>${esc(b)}</b></td><td class="muted">${esc(cnd)}</td></tr>`).join('')}</tbody></table>
      <p class="note">generated ${esc(c.generatedAt.replace('T', ' ').slice(0, 19))} UTC ${stamp(c)}${c.v1.deadComputeBudget.examples && c.v1.deadComputeBudget.examples.length ? `<br>dead-harness examples: ${c.v1.deadComputeBudget.examples.slice(0, 3).map((s) => `<button type="button" class="ex" data-sig="${esc(s)}" style="text-decoration:underline">${esc(short(s, 6, 4))}</button>`).join(' · ')}` : ''}</p>`;
    const v1 = c.v1;
    head.innerHTML = c.window === '24h'
      ? `24 h, ${c.blocks} blocks: <span class="mono-hl">${fmt(c.versions.v1)}</span> of ${fmt(c.txs.total)} are <span class="mono-hl">0x81</span>.`
      : `slot ${fmt(c.slots.last)}: <span class="mono-hl">${fmt(v1.count)}</span> of ${fmt(c.txs.total)} are <span class="mono-hl">0x81</span>.`;
    if (c.window === 'latest') fig5.textContent = `wafer map of slot ${fmt(c.slots.last)} (${utc(c.blockTime.last)}): ${fmt(c.txs.total)} dies, one per tx. sites filled by class from real counts, not block order. ${fmt(v1.deadComputeBudget.txs)} ink dot${v1.deadComputeBudget.txs === 1 ? '' : 's'} = v1 txs still carrying ComputeBudget ixs.`;
  }
  function renderBand(c) {
    const v1 = c.v1, dc = v1.deadComputeBudget;
    const target = v1.shareAll * 100;
    const obj = { v: 0 };
    const draw = () => { bandBig.innerHTML = `${obj.v.toFixed(1)}<small>%</small>`; };
    if (reduced || !window.gsap) { obj.v = target; draw(); } else window.gsap.to(obj, { v: target, duration: 0.4, ease: 'power2.out', onUpdate: draw });
    bandTxt.innerHTML = `of txs in slot <b>${fmt(c.slots.last)}</b> are <b>0x81</b> (${fmt(v1.count)} of ${fmt(c.txs.total)}).${c.stale ? ' <span class="stale">STALE</span>' : ''}<br><b>${fmt(dc.txs)} of ${fmt(v1.count)}</b> v1 still wear the ComputeBudget harness: 150 CU each, set nothing.`;
    const time = new Date(c.blockTime.last * 1000).toISOString().slice(11, 19);
    mCensus.innerHTML = `<i></i><b>slot ${fmt(c.slots.last)}</b> · ${time} UTC · v1 = <b>${pct(v1.shareAll)}%</b> of txs · <b>${fmt(dc.txs)} of ${fmt(v1.count)}</b> v1 still wear the harness`;
  }
  async function load(w) {
    windowName = w;
    toggle.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.window === w)));
    if (cache[w]) { renderTable(cache[w]); return cache[w]; }
    table.innerHTML = `<p class="dashed">reading ${w === '24h' ? 'every snapshot of the last 24 h' : 'the latest finalized block'}… getBlock(slot, { maxSupportedTransactionVersion: 1 })</p>`;
    try {
      const c = await apiCensus(w);
      cache[w] = c;
      if (windowName === w) renderTable(c);
      if (w === 'latest') { renderBand(c); onData && onData(c); }
      return c;
    } catch (e) {
      const msg = e.code === 'TIMEOUT' ? '8 s and no block from the rpc. the census tries again on the next load.' : 'the rpc answered with an error, not a block. no census numbers, none guessed.';
      table.innerHTML = `<p class="r-msg">${msg}</p>`;
      if (w === 'latest') { bandTxt.textContent = msg; mCensus.textContent = msg; head.textContent = 'no census yet. nothing guessed.'; }
      return null;
    }
  }
  toggle.addEventListener('click', (e) => { const b = e.target.closest('button[data-window]'); if (b) load(b.dataset.window); });
  return { load, get data() { return cache.latest; } };
}
