// Ordering information: the repo block. The repo is public on GitHub; the npm package is still planned.
import { esc } from '../function/api.js';
import benchData from '../data/bench.json';

export const REPO_URL = 'https://github.com/lkristof55/ox81';
export const PACKAGE = 'ox81';

export function setupRepo({ rows, cmds, bench, toast }) {
  const R = [
    ['Part number', 'OX81-V1 · Solana transaction wire format v1 (SIMD-0385)', 'decoded'],
    ['Package', `<span class="mono">${PACKAGE}</span> · TypeScript, zero runtime dependencies, runs in Node ≥ 23.6 and the browser`, '<span class="ptag">Planned</span> npm'],
    ['Repository', `<span class="mono">${REPO_URL.replace('https://', '')}</span>`, `<a href="${REPO_URL}" target="_blank" rel="noopener">open on GitHub</a>`],
    ['License', 'MIT', ''],
    ['API', '<span class="mono">sniff · decode · byteMap · lint · misread · v1Port · census · xray</span>', ''],
    ['CLI', '<span class="mono">ox81 xray | lint | census</span>', '<span class="ptag">Planned</span> npx'],
  ];
  rows.innerHTML = R.map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`).join('');
  const C = [
    ['npm i ox81', true],
    ['npx ox81 census --slots 100', true],
    ['npx ox81 xray <signature|base64> --json', true],
    [`git clone ${REPO_URL}`, false],
  ];
  cmds.innerHTML = C.map(([c, planned]) => `<div class="cmd ${planned ? 'planned' : ''}"><code>${esc(c)}</code><button type="button" data-c="${esc(c)}">Copy</button></div>`).join('') +
    '<p class="caption">dashed = planned: the npm package is not published yet. git clone works today.</p>';
  cmds.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-c]'); if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.c); } catch { /* clipboard blocked: still show state */ }
    b.classList.add('done'); b.textContent = 'Copied'; toast(`copied: ${b.dataset.c}`);
    setTimeout(() => { b.classList.remove('done'); b.textContent = 'Copy'; }, 400);
  });
  if (!benchData || !benchData.rows || !benchData.rows.length) {
    bench.innerHTML = '<div class="dashed"><span class="ptag">Measuring</span>measuring… numbers land here after the bench runs on real fixtures. no number is shown before it is measured.</div>';
  } else {
    bench.innerHTML = `<table class="dt"><thead><tr><th>Parameter</th><th>Condition</th><th class="num">Value</th><th>Unit</th></tr></thead><tbody>${benchData.rows.map((r) => `<tr><td>${esc(r.parameter)}</td><td class="muted">${esc(r.condition)}</td><td class="num"><b>${esc(r.value)}</b></td><td>${esc(r.unit)}</td></tr>`).join('')}</tbody></table>
      <p class="caption" style="margin-top:10px">${esc(benchData.machine || '')} · reproduce: <span class="mono">${esc(benchData.command || 'npm run bench')}</span>${benchData.note ? ' · ' + esc(benchData.note) : ''}</p>`;
  }
}
