// Charts drawn as inline SVG / HTML. One measure per chart, one axis, thin marks, recessive grid,
// a hover layer on every chart and a table view next to it.
import { h, raw, esc, setHTML, $, nf, icon, showTip, hideTip } from './core.js';

let redraw = [];
export const resetCharts = () => { redraw = []; };
let rt;
window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => redraw.forEach((f) => f()), 120); });
export const redrawCharts = () => redraw.forEach((f) => f());

function niceMax(v) {
  if (v <= 4) return 4; if (v <= 8) return 8; if (v <= 12) return 12; if (v <= 20) return 20;
  const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 6 ? 6 : n <= 8 ? 8 : 10) * p;
}
const empty = (el, text = 'Bu dövr üçün məlumat yoxdur') => setHTML(el, h`<div class="empty">${text}</div>`);

// points: [{label, full, value}]
export function lineChart(el, points, name) {
  if (!points.length) return empty(el);
  const draw = () => {
    if (!el.isConnected || el.hidden) return;
    const W = Math.max(260, el.clientWidth), H = 250, m = { l: 46, r: 16, t: 14, b: 26 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const max = niceMax(Math.max(1, ...points.map((p) => p.value)));
    const x = (i) => m.l + (points.length === 1 ? iw / 2 : (i * iw) / (points.length - 1)), y = (v) => m.t + ih - (v / max) * ih;
    let g = '';
    for (let i = 0; i <= 4; i++) { const v = (max * i) / 4, yy = y(v); g += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="var(--grid)" stroke-width="1"/><text x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${esc(nf(v))}</text>`; }
    const step = Math.max(1, Math.ceil(points.length / (W < 520 ? 4 : 8)));
    let xl = '';
    points.forEach((p, i) => { if (i % step === 0) xl += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(p.label)}</text>`; });
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
    const area = `${d} L${x(points.length - 1).toFixed(1)} ${m.t + ih} L${x(0).toFixed(1)} ${m.t + ih} Z`;
    const li = points.length - 1;
    el.innerHTML = `<svg height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(name)} — xətt qrafiki">${g}${xl}` +
      (points.length > 1 ? `<path d="${area}" fill="var(--c1)" opacity=".1"/><path d="${d}" fill="none" stroke="var(--c1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : '') +
      `<circle cx="${x(li)}" cy="${y(points[li].value)}" r="4.5" fill="var(--c1)" stroke="var(--chart-surface)" stroke-width="2"/>` +
      `<line class="ch" y1="${m.t}" y2="${m.t + ih}" stroke="var(--ink-3)" stroke-width="1" visibility="hidden"/><circle class="cd" r="5" fill="var(--c1)" stroke="var(--chart-surface)" stroke-width="2" visibility="hidden"/>` +
      `<rect class="linehit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
    const svg = $('svg', el), ch = $('.ch', el), cd = $('.cd', el), hit = $('.linehit', el);
    const mv = (e) => {
      const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) * W) / r.width;
      let i = points.length === 1 ? 0 : Math.round(((px - m.l) / iw) * (points.length - 1));
      i = Math.max(0, Math.min(points.length - 1, i));
      ch.setAttribute('x1', x(i)); ch.setAttribute('x2', x(i)); ch.setAttribute('visibility', 'visible');
      cd.setAttribute('cx', x(i)); cd.setAttribute('cy', y(points[i].value)); cd.setAttribute('visibility', 'visible');
      showTip(nf(points[i].value), `${name} · ${points[i].full}`, r.left + (x(i) * r.width) / W, r.top + y(points[i].value));
    };
    hit.addEventListener('pointermove', mv); hit.addEventListener('pointerdown', mv);
    hit.addEventListener('pointerleave', () => { ch.setAttribute('visibility', 'hidden'); cd.setAttribute('visibility', 'hidden'); hideTip(); });
  };
  draw(); redraw.push(draw);
}
// cats: ['May', …]; series: [{name, color, values:[…]}]
export function groupBars(el, cats, series) {
  if (!cats.length) return empty(el);
  const draw = () => {
    if (!el.isConnected || el.hidden) return;
    const W = Math.max(260, el.clientWidth), H = 230, m = { l: 34, r: 8, t: 12, b: 26 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
    const band = iw / cats.length, bw = Math.max(6, Math.min(24, (band - 12) / series.length - 2)), y = (v) => m.t + ih - (v / max) * ih;
    let s = '';
    for (let i = 0; i <= 4; i++) { const v = (max * i) / 4, yy = y(v); s += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="var(--grid)"/><text x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${esc(nf(v))}</text>`; }
    cats.forEach((c, ci) => {
      const cx = m.l + band * ci + band / 2, tw = series.length * bw + (series.length - 1) * 2;
      s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(c)}</text>`;
      series.forEach((se, si) => {
        const v = se.values[ci] || 0, x0 = cx - tw / 2 + si * (bw + 2), yt = y(v), y0 = m.t + ih, r = Math.min(4, y0 - yt);
        const tipAttr = `data-tip="${esc(nf(v))}|${esc(se.name)} · ${esc(c)}"`;
        if (v > 0) s += `<path ${tipAttr} fill="${se.color}" d="M${x0} ${y0} V${yt + r} Q${x0} ${yt} ${x0 + r} ${yt} H${x0 + bw - r} Q${x0 + bw} ${yt} ${x0 + bw} ${yt + r} V${y0} Z"/>`;
        s += `<rect ${tipAttr} x="${x0}" y="${m.t}" width="${bw}" height="${ih}" fill="transparent"/>`;
      });
    });
    el.innerHTML = `<svg height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sütun qrafiki">${s}</svg>`;
  };
  draw(); redraw.push(draw);
}
// items: [{label, value}] - horizontal bars, single hue.
export function hbars(el, items) {
  if (!items.length || !items.some((i) => i.value > 0)) return empty(el);
  const max = Math.max(1, ...items.map((i) => i.value)), tot = items.reduce((a, i) => a + i.value, 0) || 1;
  setHTML(el, h`<div class="hb">${items.map((i) => h`<div class="hb-r" data-tip="${nf(i.value)}|${i.label} · ${((i.value / tot) * 100).toFixed(1)}%">
    <span class="hl" title="${i.title || i.label}">${i.label}</span><span class="htw"><span class="ht" style="width:${((i.value / max) * 100).toFixed(1)}%"></span></span><span class="hv">${nf(i.value)}</span></div>`)}</div>`);
}
const DONUT_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)'];
// items: up to three [{label, value}] segments.
export function donut(el, items, center) {
  const tot = items.reduce((a, i) => a + i.value, 0);
  if (!tot) return empty(el);
  const R = 56, C = 2 * Math.PI * R;
  let off = 0, s = '';
  items.forEach((i, idx) => {
    const len = (i.value / tot) * C;
    if (i.value > 0) s += `<circle data-tip="${esc(nf(i.value))}|${esc(i.label)} · ${((i.value / tot) * 100).toFixed(1)}%" cx="75" cy="75" r="${R}" fill="none" stroke="${DONUT_COLORS[idx % 3]}" stroke-width="22" stroke-dasharray="${Math.max(0, len - 2).toFixed(2)} ${(C - Math.max(0, len - 2)).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 75 75)"/>`;
    off += len;
  });
  setHTML(el, h`<div class="donut"><svg viewBox="0 0 150 150" width="150" height="150" role="img" aria-label="Dairəvi qrafik">${raw(s)}<text x="75" y="72" text-anchor="middle" class="donut-n">${nf(tot)}</text><text x="75" y="90" text-anchor="middle">${center}</text></svg>
    <ul>${items.map((i, idx) => h`<li><i style="background:${DONUT_COLORS[idx % 3]}"></i><span>${i.label}</span><b>${nf(i.value)}</b><em>${((i.value / tot) * 100).toFixed(0)}%</em></li>`)}</ul></div>`);
}
// rows: [{label, value, rate}] - conversion steps.
export function funnel(el, rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  setHTML(el, h`<div class="funnel">${rows.map((r, i) => h`<div class="fn" data-tip="${nf(r.value)}|${r.label}"><span>${r.label}</span><span class="fw"><span class="fb" style="width:${((r.value / max) * 78).toFixed(1)}%"></span><span class="fv">${nf(r.value)}</span>${i && r.rate !== null && r.rate !== undefined ? h`<span class="fp">${r.rate}% əvvəlki mərhələdən</span>` : ''}</span></div>`)}</div>`);
}
export const tableView = (head, rows) => h`<div class="tw"><table class="tview"><thead><tr>${head.map((x, i) => h`<th class="${i ? 'num' : ''}">${x}</th>`)}</tr></thead><tbody>${rows.map((r) => h`<tr>${r.map((c, i) => h`<td class="${i ? 'num' : ''}">${c}</td>`)}</tr>`)}</tbody></table></div>`;
// Card wrapper with a "Cədvəl" toggle. legend: [[label, color]]
export const chartCard = (id, title, sub, { legend, controls } = {}) => h`<section class="card"><div class="card-h"><div><h2>${title}</h2><p>${sub}</p></div><span class="sp"></span>${controls || ''}
  <button class="btn sm ghost" data-tv="${id}" aria-pressed="false">${icon('table', 'sm')}<span>Cədvəl</span></button></div>
  <div class="card-b">${legend ? h`<div class="legend" style="margin-bottom:10px">${legend.map((l) => h`<span><i style="background:${l[1]}"></i>${l[0]}</span>`)}</div>` : ''}<div class="chart" id="${id}"></div><div id="${id}-t" hidden></div></div></section>`;
document.addEventListener('click', (e) => {
  const tv = e.target.closest('[data-tv]');
  if (!tv) return;
  const id = tv.getAttribute('data-tv'), c = document.getElementById(id), tb = document.getElementById(id + '-t');
  if (!c || !tb) return;
  const on = tb.hidden;
  tb.hidden = !on; c.hidden = on; tv.setAttribute('aria-pressed', String(on));
  tv.querySelector('span').textContent = on ? 'Qrafik' : 'Cədvəl';
  if (!on) redrawCharts();
});
