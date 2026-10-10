// Trade Flow Weekly as a web report + its derivatives, from ONE data pull and ONE editorial note.
//   data.json      the week's numbers (public API only, same sources as newsletter.mjs --edition flow)
//   notes          reports/notes/<date>-flow.json - headline, analysis, implications, watch list.
//                  Facts only from the week's stories, every claim linked. In production: one LLM call over data.json.
// Outputs in reports/out/<date>-flow/:
//   article.html   post body for /insights/<slug>/ (scoped CSS + JSON-LD, no theme dependency)
//   preview.html   article inside a site-like page, for review
//   forum.html     weekly thread for the Global Commodity Radar board (summary + discussion question + link)
//   linkedin.txt   caption for the LinkedIn document post
//   carousel.pdf   1080x1350 slides for the LinkedIn document post (+ slide-N.png previews)
//
// Usage:  node weekly_report.mjs [--date YYYY-MM-DD]   (date = the Monday of publication; covers the 7 days before)

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dayShift, fetchJson, flagOf, countryName, LANES, laneOf, clean, hostOf, similar, score, summaryOf, tokens, laneSlug } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const API = cfg.site + '/wp-json/wtp/v1';
const FROM = dayShift(TODAY, -7), TO = dayShift(TODAY, -1);

const isoWeek = (iso) => {
  const d = new Date(iso + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear(), jan4 = new Date(Date.UTC(y, 0, 4));
  return [y, 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)];
};
const [YEAR, WEEK] = isoWeek(FROM);
const SLUG = `trade-flow-weekly-${YEAR}-w${String(WEEK).padStart(2, '0')}`;
const URL_ = `${cfg.site}/insights/${SLUG}/`;
const OUT = join(HERE, 'reports', 'out', `${TODAY}-flow`);
mkdirSync(OUT, { recursive: true });

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const utm = (u, source, content) => { const x = new URL(u); x.searchParams.set('utm_source', source); x.searchParams.set('utm_medium', source === 'linkedin' ? 'social' : 'referral'); x.searchParams.set('utm_campaign', SLUG); if (content) x.searchParams.set('utm_content', content); return x.toString(); };
const fmtDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtLong = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const gnews = (it) => hostOf(it.source_url) === 'news.google.com' && clean(it.project_name).match(/^(.*\S)\s+-\s+([^-]{2,40})$/);
const title = (it) => { const g = gnews(it); return g ? g[1] : clean(it.project_name); };
const source = (it) => { const g = gnews(it); return g ? g[2] : it.source_name || hostOf(it.source_url); };
const blocked = (cfg.blockedWords || []).map((w) => w.toLowerCase());
const ok = (it) => it.source_url && !blocked.some((w) => clean(it.project_name + ' ' + it.description).toLowerCase().includes(w));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const tier = (n) => (n >= 12 ? 'Critical' : n >= 8 ? 'Elevated' : 'Watch');

// ================================================================ data (same rules as newsletter.mjs flow)
function related(a, b) {
  if (similar(a, b)) return true;
  const A = tokens(a), B = tokens(b); let shared = 0; for (const w of A) if (B.has(w)) shared++;
  return shared >= 2 && shared / Math.min(A.size, B.size) >= 0.33;
}
function clusters(items) {
  const out = [];
  for (const it of [...items].sort((a, b) => score(b) - score(a) || (b.report_date > a.report_date ? 1 : -1))) {
    const c = out.find((x) => [x.lead, ...x.more].some((m) => related(m.project_name, it.project_name)));
    if (c) c.more.push(it); else out.push({ lead: it, more: [] });
  }
  return out;
}

const res = await fetchJson(`${API}/opportunities?report_type=flow_distortion&from=${FROM}&to=${TO}&limit=1000`);
const flow = (res.items || []).filter(ok);
const lw = await fetchJson(`${API}/lane-weeks?weeks=4`);
const weeks = (lw.weeks || []).filter((w) => w.total > 0);   // weeks before the pipeline started report 0
const idx = (c) => (c ? c.crit * 3 + c.elev * 2 + c.watch : 0);
const lanes = LANES.map((l) => {
  const hist = weeks.map((w) => w.lanes?.[l.id] || null);
  const now = hist[0] || { crit: 0, elev: 0, watch: 0 }, prev = hist[1] || { crit: 0, elev: 0, watch: 0 };
  return { id: l.id, name: l.name, flow: l.flow, now, prev, n: now.crit + now.elev + now.watch, p: idx(now), pp: idx(prev), trend: hist.map(idx).reverse(), top: now.top?.[0] || null };
}).sort((a, b) => b.p - a.p || b.pp - a.pp);
const status = (p) => (p >= 30 ? 'High' : p >= 10 ? 'Elevated' : p > 0 ? 'Watch' : 'Quiet');
const crit = flow.filter((it) => score(it) >= 12).length;
const critPrev = weeks[1]?.tiers?.crit ?? null;
const cl = clusters(flow.filter((it) => score(it) >= 8));
const big = cl[0];
const used = new Set(big ? [big.lead, ...big.more] : []);
const MARKETS = [['Energy', 'Oil, gas & power'], ['Shipping', 'Shipping & freight'], ['Agriculture', 'Grains & agri'], ['Policy', 'Trade policy & sanctions'], ['Metals', 'Metals & mining']];
const markets = MARKETS.map(([key, label]) => ({ key, label, n: flow.filter((it) => it.sector === key).length,
  picks: cl.filter((c) => c.lead.sector === key && !used.has(c.lead)).slice(0, 3).map((c) => c.lead) })).filter((m) => m.n);
const days = Array.from({ length: 7 }, (_, i) => dayShift(FROM, i)).map((d) => ({ d, n: flow.filter((it) => it.report_date === d).length, c: flow.filter((it) => it.report_date === d && score(it) >= 12).length }));
const hot = lanes.filter((x) => x.n > 0);
const pick = (it) => ({ title: title(it), source: source(it), url: it.source_url, date: it.report_date, tier: tier(score(it)), flag: flagOf(it.country), country: countryName(it.country), lane: laneOf(it)?.name || '', summary: summaryOf(it.description, 240) || '' });
const data = {
  slug: SLUG, url: URL_, date: TODAY, from: FROM, to: TO, year: YEAR, week: WEEK,
  totals: { signals: flow.length, critical: crit, criticalPrev: critPrev, signalsPrev: weeks[1]?.total ?? null, lanesActive: hot.length },
  big: big ? { lead: pick(big.lead), more: big.more.slice(0, 8).map(pick) } : null,
  lanes, markets: markets.map((m) => ({ ...m, picks: m.picks.map(pick) })), days,
  // the week's 15 strongest stories (one per cluster, with its other reports) = the only facts the editorial note may use
  clusters: cl.slice(0, 15).map((c) => ({ lead: pick(c.lead), reports: c.more.length + 1, sector: c.lead.sector, more: c.more.slice(0, 4).map(pick) })),
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'data.json'), JSON.stringify(data, null, 2));
if (args.includes('--data-only')) { console.log(`data only: ${join(OUT, 'data.json')}`); process.exit(0); }

// ================================================================ editorial note + images
const notesPath = join(HERE, 'reports', 'notes', `${TODAY}-flow.json`);
if (!existsSync(notesPath)) throw new Error('missing editorial note ' + notesPath);
const N = JSON.parse(readFileSync(notesPath, 'utf8'));
mkdirSync(join(OUT, 'img'), { recursive: true });

// ---------------------------------------------------------------- images
// Photos come ONLY from the shared, licence-checked library (media_pick.mjs; ledger has author, licence, source page).
// notes.images = { hero: <ledger id>, story: <ledger id> }. The globe is our own map (share_card.mjs weekly), no licence issue.
const LIB = join(HERE, 'media_library');
const ledger = existsSync(join(LIB, 'ledger.json')) ? JSON.parse(readFileSync(join(LIB, 'ledger.json'), 'utf8')) : [];
const IMG = {};
for (const [key, id] of Object.entries(N.images || {})) {
  const row = ledger.find((l) => l.id === id);
  if (!row) throw new Error(`image ${key}: ${id} is not in media_library/ledger.json`);
  copyFileSync(join(LIB, row.file), join(OUT, 'img', row.file));
  const lic = row.licenseUrl ? `<a href="${row.licenseUrl}" rel="license nofollow noopener" target="_blank">${row.license}</a>` : row.license;
  const who = `<a href="${row.page}" rel="nofollow noopener" target="_blank">${row.author || 'unknown'}</a> / ${row.source === 'pixabay' ? 'Pixabay' : 'Wikimedia Commons'}, ${lic}`;
  IMG[key] = { file: row.file, w: row.width, h: row.height, alt: row.caption.replace(/^Illustrative:\s*/, ''), caption: row.caption.charAt(0).toUpperCase() + row.caption.slice(1) + '.',
    credit: `Photo: ${who}`, cc0: /cc0|public domain|pixabay/i.test(row.license) };
}
// globe: the map's own weekly share card, cropped to the globe
const cardDir = join(OUT, 'map');
if (!existsSync(cardDir) || !readdirSync(cardDir).some((f) => f.endsWith('.png'))) {
  execFileSync(process.execPath, [join(HERE, 'share_card.mjs'), 'weekly'], { cwd: HERE, env: { ...process.env, OUT_DIR: cardDir }, stdio: 'inherit' });
}
const cardPng = join(cardDir, readdirSync(cardDir).find((f) => f.endsWith('.png')));
IMG.globe = { file: `${SLUG}-globe.jpg`, w: 760, h: 760, alt: `Trade Flow signals and affected shipping lanes on the World Trade Pro Intelligence Map, ${fmtDay0(FROM)} – ${fmtDay0(TO)}`,
  caption: `This week's trade-flow signals on the Intelligence Map. Red = critical, orange = elevated; lines are the shipping lanes with signals.`, credit: 'World Trade Pro Intelligence Map' };
function fmtDay0(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }

// ================================================================ article (WordPress post body)
const STATUS_ICON = { High: '▲', Elevated: '●', Watch: '○', Quiet: '–' };
const chg = (a, b) => (a > b ? `<span class="up">▲ ${a - b}</span>` : a < b ? `<span class="down">▼ ${b - a}</span>` : '<span class="flat">no change</span>');
const maxP = Math.max(...lanes.map((x) => Math.max(x.p, x.pp)), 1);
// paired horizontal bars: this week (navy) vs last week (grey), one row per active lane
const laneBars = (rows) => rows.map((x) => `
  <div class="lb" title="${esc(x.name)}: pressure ${x.p} this week, ${x.pp} last week">
    <div class="lb-name"><a href="${esc(utm(`${cfg.site}/trade-lanes/${laneSlug(x.id)}/`, 'insights', 'lane-' + x.id))}">${esc(x.name)}</a><span>${esc(x.flow)}</span></div>
    <div class="lb-bars"><i class="now" style="width:${(x.p / maxP * 100).toFixed(1)}%"></i><i class="prev" style="width:${(x.pp / maxP * 100).toFixed(1)}%"></i></div>
    <div class="lb-val"><b>${x.p}</b> ${chg(x.p, x.pp)}</div>
    <div class="lb-st st-${status(x.p).toLowerCase()}">${STATUS_ICON[status(x.p)]} ${status(x.p)}</div>
  </div>`).join('');
const active = lanes.filter((x) => x.p || x.pp);
const quiet = lanes.filter((x) => !x.p && !x.pp);
const maxDay = Math.max(...days.map((d) => d.n), 1);
const dayChart = `<div class="days" role="img" aria-label="Signals per day">${days.map((d) => `
  <div class="day" title="${fmtDay(d.d)}: ${d.n} signals, ${d.c} critical"><div class="col"><i style="height:${(d.n / maxDay * 100).toFixed(1)}%"></i></div><b>${d.n}</b><span>${new Date(d.d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}</span></div>`).join('')}</div>`;
const storyLi = (s) => `<li><a href="${esc(s.url)}" rel="nofollow noopener" target="_blank">${esc(s.title)}</a> <span class="src">${s.country ? esc(s.country) + ' · ' : ''}${esc(s.source)} · ${fmtDay(s.date)} · ${s.tier}${s.lane ? ' · ' + esc(s.lane) : ''}</span></li>`;
const mapUrl = utm(cfg.site + '/intelligence-map/?view=flows', 'insights', 'map');
const forumUrl = `${cfg.site}/forum/forum/industry-newsletter/`;
const delta = (a, b) => (b === null ? '' : a > b ? `up from ${b}` : a < b ? `down from ${b}` : `same as last week`);

const CSS = `
.wtp-rpt{--ink:#101828;--text:#344054;--muted:#667085;--line:#e4e7ec;--soft:#f5f7fa;--navy:#0f2d5e;--accent:#0b4a6f;--gold:#c8a94a;--up:#b42318;--down:#027a48;--prev:#c3cad5;
  font-family:'IBM Plex Sans',system-ui,sans-serif;color:var(--text);font-size:17px;line-height:1.65;max-width:760px;margin:0}
.wtp-rpt a{color:var(--accent)}
.wtp-rpt .kicker{font:600 12px/1 'IBM Plex Sans',sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--accent)}
.wtp-rpt h1{font-family:Newsreader,Georgia,serif;font-weight:600;font-size:clamp(30px,5vw,42px);line-height:1.12;color:var(--ink);margin:.35em 0 .3em}
.wtp-rpt .dek{font-size:19px;color:var(--text);margin:0 0 14px}
.wtp-rpt .byline{font-size:14px;color:var(--muted);border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:10px 0;margin-bottom:26px}
.wtp-rpt h2{font-family:Newsreader,Georgia,serif;font-weight:600;font-size:27px;line-height:1.2;color:var(--ink);margin:42px 0 12px}
.wtp-rpt h3{font-size:16px;font-weight:700;color:var(--ink);margin:26px 0 6px}
.wtp-rpt .tk{background:var(--soft);border-left:4px solid var(--navy);border-radius:6px;padding:16px 20px 6px}
.wtp-rpt .tk b.h{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
.wtp-rpt .tk ul{margin:0;padding-left:20px}.wtp-rpt .tk li{margin-bottom:10px}
.wtp-rpt .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:10px 0 6px}
.wtp-rpt .stat{border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.wtp-rpt .stat b{display:block;font:600 30px/1.1 Newsreader,Georgia,serif;color:var(--ink)}
.wtp-rpt .stat span{font-size:13px;color:var(--muted);line-height:1.35;display:block;margin-top:4px}
.wtp-rpt .lb{display:grid;grid-template-columns:minmax(150px,1.3fr) 2fr 86px 88px;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.wtp-rpt .lb-name a{font-weight:600;color:var(--ink);text-decoration:none;font-size:15px}.wtp-rpt .lb-name span{display:block;font-size:12px;color:var(--muted);line-height:1.3}
.wtp-rpt .lb-bars i{display:block;height:9px;border-radius:0 4px 4px 0;min-width:2px}.wtp-rpt .lb-bars i+i{margin-top:2px}
.wtp-rpt .lb-bars .now{background:var(--navy)}.wtp-rpt .lb-bars .prev{background:var(--prev)}
.wtp-rpt .lb-val{font-size:13px;color:var(--muted);white-space:nowrap}.wtp-rpt .lb-val b{color:var(--ink);font-size:16px;margin-right:4px}
.wtp-rpt .up{color:var(--up)}.wtp-rpt .down{color:var(--down)}.wtp-rpt .flat{color:var(--muted)}
.wtp-rpt .lb-st{font-size:13px;font-weight:600;white-space:nowrap;color:var(--ink)}
.wtp-rpt .legend{display:flex;gap:18px;font-size:13px;color:var(--muted);margin:4px 0 2px}.wtp-rpt .legend i{display:inline-block;width:14px;height:9px;border-radius:2px;margin-right:6px;vertical-align:middle}
.wtp-rpt .note{font-size:13px;color:var(--muted);margin-top:8px}
.wtp-rpt .days{display:flex;gap:10px;align-items:flex-end;height:170px;margin:14px 0 4px}
.wtp-rpt .day{flex:1;display:flex;flex-direction:column;align-items:center;height:100%;font-size:12px;color:var(--muted)}
.wtp-rpt .day .col{flex:1;width:100%;display:flex;align-items:flex-end}.wtp-rpt .day .col i{display:block;width:100%;background:var(--accent);border-radius:4px 4px 0 0}
.wtp-rpt .day b{color:var(--ink);font-size:13px;margin-top:4px}
.wtp-rpt ul.stories{list-style:none;padding:0;margin:6px 0 0}.wtp-rpt ul.stories li{padding:8px 0;border-top:1px solid var(--line);line-height:1.45}
.wtp-rpt ul.stories a{color:var(--ink);text-decoration:none;font-weight:600;font-size:15px}.wtp-rpt ul.stories .src{display:block;font-size:12.5px;color:var(--muted)}
.wtp-rpt .who{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.wtp-rpt .who div{border:1px solid var(--line);border-radius:8px;padding:14px 16px;font-size:15px;line-height:1.55}
.wtp-rpt .who b{display:block;color:var(--ink);margin-bottom:4px}
.wtp-rpt .cta{background:var(--navy);color:#dbe4f0;border-radius:10px;padding:22px 24px;margin-top:40px}
.wtp-rpt .cta b{color:#fff;font-size:19px;display:block;margin-bottom:4px}.wtp-rpt .cta a.btn{display:inline-block;margin-top:12px;background:var(--gold);color:#101828;font-weight:700;text-decoration:none;border-radius:6px;padding:11px 18px}
.wtp-rpt .cta2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.wtp-rpt .cta2 a{display:block;border:1px solid var(--line);border-radius:8px;padding:14px 16px;text-decoration:none;color:var(--text);font-size:14px}.wtp-rpt .cta2 a b{display:block;color:var(--ink);font-size:15px}
.wtp-rpt .fig{margin:22px 0 26px}.wtp-rpt .fig img{display:block;width:100%;height:auto;border-radius:8px;background:var(--soft)}
.wtp-rpt .fig.hero img{aspect-ratio:16/9;object-fit:cover}.wtp-rpt .fig.globe{max-width:560px;margin-left:auto;margin-right:auto}.wtp-rpt .fig.globe img{border-radius:14px}
.wtp-rpt .fig figcaption{font-size:13px;line-height:1.45;color:var(--muted);margin-top:7px}.wtp-rpt .fig figcaption .cr{display:block;font-size:12px;color:#98a2b3}.wtp-rpt .fig figcaption a{color:inherit}
.wtp-rpt .method{font-size:14px;color:var(--muted);border-top:1px solid var(--line);margin-top:36px;padding-top:14px}
@media (max-width:700px){.wtp-rpt{font-size:16px}.wtp-rpt .stats{grid-template-columns:1fr 1fr}.wtp-rpt .who,.wtp-rpt .cta2{grid-template-columns:1fr}
 .wtp-rpt .lb{grid-template-columns:1fr 80px;row-gap:6px}.wtp-rpt .lb-bars{grid-column:1/-1;order:3}.wtp-rpt .lb-st{display:none}}`;

const ld = { '@context': 'https://schema.org', '@type': 'Article', headline: N.title, description: N.dek, datePublished: TODAY, dateModified: TODAY,
  author: { '@type': 'Organization', name: 'World Trade Pro Research', url: cfg.site }, publisher: { '@type': 'Organization', name: 'World Trade Pro', url: cfg.site },
  mainEntityOfPage: URL_, about: ['commodity trade flows', 'shipping lanes', 'tanker freight'], isPartOf: { '@type': 'CreativeWorkSeries', name: 'Trade Flow Weekly' } };

const fig = (key, cls = '') => { const m = IMG[key]; if (!m) return '';
  return `<figure class="fig ${cls}"><img src="__IMG_${key}__" alt="${esc(m.alt)}" width="${m.w}" height="${m.h}" loading="${cls === 'hero' ? 'eager' : 'lazy'}" decoding="async"><figcaption>${esc(m.caption)}<span class="cr">${m.credit}</span></figcaption></figure>`; };
const article = `<style>${CSS}</style>
<article class="wtp-rpt">
<div class="kicker">Trade Flow Weekly · Week ${WEEK}, ${YEAR}</div>
<h1>${esc(N.title)}</h1>
<p class="dek">${esc(N.dek)}</p>
<div class="byline">World Trade Pro Research · ${fmtLong(TODAY)} · Covers ${fmtDay(FROM)} – ${fmtDay(TO)} · ${data.totals.signals} signals from ${new Set(flow.map(source)).size} sources</div>
${fig('hero', 'hero')}

<div class="tk"><b class="h">Key takeaways</b><ul>${N.takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>

<h2>${esc(N.big.heading)}</h2>
${N.big.paras.map((p, i) => `<p>${p}</p>` + (i === 1 ? fig('story') : '')).join('\n')}
${big ? `<h3>Coverage this week</h3><ul class="stories">${[big.lead, ...big.more].filter((it, i, a) => a.findIndex((x) => source(x) === source(it) && similar(x.project_name, it.project_name)) === i).slice(0, 6).map((it) => storyLi(pick(it))).join('')}</ul>` : ''}

<h2>By the numbers</h2>
<div class="stats">
  <div class="stat"><b>${data.totals.signals}</b><span>trade-flow signals${data.totals.signalsPrev ? `, ${delta(data.totals.signals, data.totals.signalsPrev)}` : ''}</span></div>
  <div class="stat"><b>${crit}</b><span>critical${critPrev !== null ? `, ${delta(crit, critPrev)}` : ''}</span></div>
  <div class="stat"><b>${hot.length}<small style="font-size:18px;color:var(--muted)"> / 9</small></b><span>shipping lanes with signals</span></div>
  <div class="stat"><b>${markets[0] ? markets.sort((a, b) => b.n - a.n)[0].n : 0}</b><span>${esc(markets[0]?.label.toLowerCase() || '')} signals, the busiest market</span></div>
</div>
<h3>Signals per day</h3>
${dayChart}
<p class="note">Every news item our pipeline scores for impact on physical commodity flows, by publication day. Critical = score 12+.</p>

<h2>Lane scoreboard</h2>
<p>${esc(N.lanesNote)}</p>
${fig('globe', 'globe')}
<div class="legend"><span><i style="background:var(--navy)"></i>This week</span><span><i style="background:var(--prev)"></i>Last week</span></div>
${laneBars(active)}
${quiet.length ? `<p class="note">No signals either week: ${quiet.map((x) => esc(x.name)).join(', ')}.</p>` : ''}
<p class="note">Pressure index = critical × 3 + elevated × 2 + watch × 1, from the week's signals on each lane. High ≥ 30, Elevated ≥ 10. <a href="${esc(utm(cfg.site + '/trade-lanes/', 'insights', 'lanes-hub'))}">All lanes, 13-week history →</a></p>

<h2>Market by market</h2>
${data.markets.map((m) => `<h3>${esc(m.label)} <span style="font-weight:400;color:var(--muted)">· ${m.n} signals</span></h3>
${N.markets[m.key] ? `<p>${esc(N.markets[m.key])}</p>` : ''}
${m.picks.length ? `<ul class="stories">${m.picks.map(storyLi).join('')}</ul>` : ''}`).join('\n')}

<h2>What it means for you</h2>
<div class="who">${N.implications.map((x) => `<div><b>${esc(x.who)}</b>${esc(x.text)}</div>`).join('')}</div>

<h2>Watch next week</h2>
<ul>${N.watch.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>

<div class="cta"><b>See every signal on the live map</b>Each story in this report is pinned to its port, lane or field on the World Trade Pro Intelligence Map, updated every weekday.<br><a class="btn" href="${esc(mapUrl)}">Open the trade-flow map →</a></div>
<div class="cta2">
  <a href="${esc(forumUrl)}"><b>Discuss this week →</b>${esc(N.question)}</a>
  <a href="${esc(utm(cfg.site + '/join-verified-club/', 'insights', 'commodity-sd'))}"><b>Buying or selling bulk commodities? →</b>Get verified and meet checked counterparties.</a>
</div>

<p class="method"><b>How this report is made.</b> World Trade Pro scans trade, shipping and energy press every weekday and scores each story for its effect on physical commodity flows (route, volume, cost, policy). Stories are clustered so one event reported by many outlets counts once in the analysis. Numbers above are computed from those signals; commentary links to the original reporting. Previous issues: <a href="${cfg.site}/insights/">Insights</a>.</p>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</article>`;
const localSrc = (html, base = 'img/') => html.replace(/__IMG_(\w+)__/g, (_, k) => base + IMG[k].file);
writeFileSync(join(OUT, 'article.html'), localSrc(article));
// WordPress post: the theme prints the title as <h1>, so the body drops its own; a Custom HTML block keeps wpautop out
const wpBody = article.replace(/<h1>[\s\S]*?<\/h1>\n/, '');
writeFileSync(join(OUT, 'wp.json'), JSON.stringify({ title: N.title, slug: SLUG, excerpt: N.dek, images: Object.fromEntries(Object.entries(IMG).map(([k, m]) => [k, { file: m.file, alt: m.alt }])), featured: 'hero', share: `${SLUG}.png`, content: `<!-- wp:html -->\n${wpBody}\n<!-- /wp:html -->` }, null, 1));

// a site-like frame for review only (fonts from Google; on the site the theme provides them)
const preview = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(N.title)} | World Trade Pro</title><meta name="description" content="${esc(N.dek)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap" rel="stylesheet">
<style>body{margin:0;background:#fff}.hdr{border-bottom:1px solid #e4e7ec;padding:14px 16px;text-align:center}.hdr img{height:40px}.crumb{max-width:760px;margin:18px auto 0;padding:0 16px;font:13px 'IBM Plex Sans',sans-serif;color:#667085}.crumb a{color:#667085}.wrap{padding:8px 16px 60px;max-width:760px;margin:0 auto}</style></head>
<body><div class="hdr"><img src="../../../assets/logo_light.png" alt="World Trade Pro"></div>
<div class="crumb"><a href="#">Home</a> › <a href="#">Insights</a> › Trade Flow Weekly</div>
<div class="wrap">${localSrc(article)}</div></body></html>`;
writeFileSync(join(OUT, 'preview.html'), preview);

// ================================================================ forum thread (Asgaros accepts basic HTML)
const forum = `<p><b>Trade Flow Weekly · Week ${WEEK} (${fmtDay(FROM)} – ${fmtDay(TO)})</b></p>
<p>${esc(N.dek)}</p>
<ul>${N.takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<p><b>Lanes:</b> ${active.slice(0, 5).map((x) => `${esc(x.name)} ${x.p > x.pp ? '▲' : x.p < x.pp ? '▼' : '–'}`).join(' · ')}</p>
<p>📊 Full report with the lane scoreboard, market-by-market stories and what to watch: <a href="${esc(utm(URL_, 'forum'))}">${esc(N.short)}</a></p>
<p>💬 <b>Discussion:</b> ${esc(N.question)}</p>`;
writeFileSync(join(OUT, 'forum.html'), `<!-- title: Trade Flow Weekly — Week ${WEEK}: ${N.short} -->\n` + forum);

// ================================================================ LinkedIn caption (no link in the text: LinkedIn cuts the reach of posts with external links)
const caption = `Trade Flow Weekly · Week ${WEEK}\n\n${N.title}\n\n${N.takeaways.map((t) => '▪️ ' + t).join('\n\n')}\n\n👉 Swipe for the lane scoreboard and what to watch next week. The full report, with every story linked, is on our website (address on the last page).\n\n#CommodityTrading #Shipping #CrudeOil #TankerMarket #SupplyChain`;
writeFileSync(join(OUT, 'linkedin.txt'), caption);

// ================================================================ carousel (1080x1350 per slide)
const S = { w: 1080, h: 1350 };
const fileUrl = (f) => 'file:///' + f.replace(/\\/g, '/');
const PHOTO = IMG.hero?.cc0 ? fileUrl(join(OUT, 'img', IMG.hero.file)) : '';
const GLOBE = fileUrl(join(OUT, 'img', IMG.globe.file));
const photoNote = PHOTO ? `<div class="pn">${esc(IMG.hero.caption.replace(/\.$/, ''))}</div>` : '';
const slide = (inner, n, dark = false) => `<section class="s${dark ? ' dark' : ''}">${inner}<footer><span>WORLD TRADE PRO · TRADE FLOW WEEKLY</span><span>${n} / 7</span></footer></section>`;
const bigStat = (v, l) => `<div class="bs"><b>${v}</b><span>${l}</span></div>`;
const cBars = active.slice(0, 7).map((x) => `<div class="cb"><div class="cb-n">${esc(x.name)}</div><div class="cb-b"><i class="now" style="width:${(x.p / maxP * 100).toFixed(1)}%"></i><i class="prev" style="width:${(x.pp / maxP * 100).toFixed(1)}%"></i></div><div class="cb-v">${x.p} <em class="${x.p > x.pp ? 'up' : x.p < x.pp ? 'down' : ''}">${x.p > x.pp ? '▲' : x.p < x.pp ? '▼' : '–'}${x.p !== x.pp ? Math.abs(x.p - x.pp) : ''}</em></div></div>`).join('');
const cBars4 = active.slice(0, 4).map((x) => `<div class="cb sm"><div class="cb-n">${esc(x.name)}</div><div class="cb-b"><i class="now" style="width:${(x.p / maxP * 100).toFixed(1)}%"></i><i class="prev" style="width:${(x.pp / maxP * 100).toFixed(1)}%"></i></div><div class="cb-v">${x.p} <em class="${x.p > x.pp ? 'up' : x.p < x.pp ? 'down' : ''}">${x.p > x.pp ? '▲' : x.p < x.pp ? '▼' : '–'}${x.p !== x.pp ? Math.abs(x.p - x.pp) : ''}</em></div></div>`).join('');
const slides = [
  slide(`${PHOTO ? `<div class="ph" style="background-image:url('${PHOTO}')"></div>${photoNote}` : ''}<div class="cv"><div class="k">Trade Flow Weekly · Week ${WEEK} · ${fmtDay(FROM)} – ${fmtDay(TO)}</div><h1>${esc(N.title)}</h1></div><div class="row3">${bigStat(data.totals.signals, 'trade-flow signals')}${bigStat(crit, 'critical')}${bigStat(hot.length + '/9', 'lanes active')}</div><div class="swipe">Swipe →</div>`, 1, true),
  slide(`<div class="k">The big story</div><h2>${esc(cap(N.big.heading.replace(/^The big story:\s*/i, '')))}</h2><ul class="bul">${(N.big.slide || N.takeaways.slice(0, 2)).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`, 2),
  slide(`<div class="k">By the numbers</div><div class="hero"><b>${esc(N.hero.value)}</b><span>${esc(N.hero.label)}</span></div><ul class="bul sm">${N.hero.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`, 3),
  slide(`<div class="k">Lane scoreboard · this week vs last</div><img class="gl" src="${GLOBE}"><div class="lg"><span><i class="now"></i>This week</span><span><i class="prev"></i>Last week</span></div>${cBars4}<p class="fine">Red pins = critical signals · lines = lanes with signals · index = critical×3 + elevated×2 + watch×1</p>`, 4),
  slide(`<div class="k">Market by market</div>${data.markets.filter((m) => N.markets[m.key] && m.key !== 'Metals').slice(0, 4).map((m) => `<div class="mk"><b>${esc(m.label)} <em>${m.n}</em></b><p>${esc(N.markets[m.key])}</p></div>`).join('')}`, 5),
  slide(`<div class="k">What to watch next week</div>${N.watch.map((w, i) => { const [h, ...r] = w.split(':'); return `<div class="wt"><span>${i + 1}</span><div><b>${esc(h)}</b><p>${esc(cap(r.join(':').trim()))}</p></div></div>`; }).join('')}`, 6),
  slide(`<div class="k">Full report</div><h2>Lane scoreboard, every story and what it means for traders, charterers and buyers</h2><div class="url">worldtradepro.com/insights</div><p class="lead">Every signal is pinned on the live trade-flow map — updated each weekday.</p><div class="follow">Follow World Trade Pro for next Monday's issue</div>`, 7, true),
];
const carousel = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap" rel="stylesheet">
<style>
@page{size:${S.w}px ${S.h}px;margin:0}*{box-sizing:border-box}body{margin:0;font-family:'IBM Plex Sans',sans-serif;color:#101828}
.s{width:${S.w}px;height:${S.h}px;padding:96px 88px 0;position:relative;overflow:hidden;background:#fff;page-break-after:always;border-top:14px solid #0f2d5e}
.s.dark{background:#0f2d5e;color:#fff;border-top-color:#c8a94a}
.k{font-size:26px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#0b4a6f;margin-bottom:34px}.dark .k{color:#c8a94a}
h1{font:600 76px/1.08 Newsreader,serif;margin:0 0 70px}h2{font:600 62px/1.12 Newsreader,serif;margin:0 0 48px}
.row3{position:absolute;left:88px;right:88px;bottom:112px;display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.bs{border:2px solid rgba(255,255,255,.25);border-radius:14px;padding:20px 24px}.bs b{display:block;font:600 60px/1 Newsreader,serif}.bs span{font-size:24px;color:#c9d6ea}
.swipe{position:absolute;right:40px;top:30px;background:rgba(9,24,52,.72);padding:8px 18px;border-radius:8px;font-size:30px;font-weight:700;color:#c8a94a}
.ph{position:absolute;left:0;right:0;top:0;height:880px;background-size:cover;background-position:35% 78%}
.ph:after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(9,24,52,0) 0%,rgba(9,24,52,0) 45%,rgba(11,31,69,.85) 80%,#0f2d5e 100%)}
.cv{position:absolute;left:88px;right:88px;top:660px}.cv h1{margin:0;font-size:60px;line-height:1.1}.cv .k{margin-bottom:22px}
.pn{position:absolute;top:34px;left:40px;font-size:17px;color:rgba(255,255,255,.75);background:rgba(0,0,0,.28);padding:6px 12px;border-radius:6px}
.gl{display:block;width:560px;height:560px;margin:-6px auto 26px;border-radius:18px}
.cb.sm{padding:13px 0;grid-template-columns:360px 1fr 130px}.cb.sm .cb-n{font-size:25px}.cb.sm .cb-b i{height:16px}
.bul{margin:0;padding:0;list-style:none}.bul li{font-size:36px;line-height:1.42;padding:0 0 34px 44px;position:relative;color:#344054}.bul li:before{content:'';position:absolute;left:0;top:18px;width:18px;height:18px;border-radius:4px;background:#0f2d5e}
.bul.sm li{font-size:32px;padding-bottom:22px}
.hero{margin:10px 0 60px}.hero b{display:block;font:600 300px/1 Newsreader,serif;color:#0f2d5e}.hero span{font-size:44px;line-height:1.25;display:block;max-width:820px;font-weight:600}
.lg{display:flex;gap:34px;font-size:24px;color:#667085;margin:-18px 0 26px}.lg i{display:inline-block;width:30px;height:16px;border-radius:3px;margin-right:10px;vertical-align:middle}
i.now{background:#0f2d5e}i.prev{background:#c3cad5}
.cb{display:grid;grid-template-columns:330px 1fr 140px;gap:20px;align-items:center;padding:20px 0;border-bottom:2px solid #eaecf0}
.cb-n{font-size:27px;font-weight:600;line-height:1.2}.cb-b i{display:block;height:20px;border-radius:0 6px 6px 0;min-width:3px}.cb-b i+i{margin-top:4px}
.cb-v{font-size:34px;font-weight:700;text-align:right}.cb-v em{font-style:normal;font-size:22px;margin-left:6px}.up{color:#b42318}.down{color:#027a48}
.fine{font-size:22px;color:#667085;margin-top:22px}
.mk{border-top:2px solid #eaecf0;padding:26px 0}.mk b{font-size:32px}.mk b em{font-style:normal;color:#667085;font-weight:400;margin-left:8px}.mk p{font-size:28px;line-height:1.42;margin:10px 0 0;color:#344054}
.wt{display:grid;grid-template-columns:90px 1fr;gap:24px;padding:34px 0;border-top:2px solid #eaecf0}.wt span{font:600 72px/1 Newsreader,serif;color:#c8a94a}.wt b{font-size:38px}.wt p{font-size:31px;line-height:1.4;margin:10px 0 0;color:#344054}
.url{display:inline-block;background:#c8a94a;color:#101828;font-size:40px;font-weight:700;padding:22px 34px;border-radius:12px;margin:10px 0 44px}
.lead{font-size:34px;line-height:1.4;color:#c9d6ea}.follow{position:absolute;left:88px;bottom:140px;font-size:30px;font-weight:600}
footer{position:absolute;left:88px;right:88px;bottom:44px;display:flex;justify-content:space-between;font-size:20px;letter-spacing:.1em;color:#98a2b3;font-weight:600}.dark footer{color:#8fa3c4}
</style></head><body>${slides.join('')}</body></html>`;
writeFileSync(join(OUT, 'carousel.html'), carousel);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: S.w, height: S.h } });
await page.setViewportSize({ width: 760, height: 760 });
writeFileSync(join(OUT, '_globe.html'), `<body style="margin:0"><div id="g" style="width:760px;height:760px;background:url('${fileUrl(cardPng)}') -160px -205px/1080px 1350px no-repeat"></div></body>`);
await page.goto(fileUrl(join(OUT, '_globe.html')));
await page.waitForTimeout(300);
await page.locator('#g').screenshot({ path: join(OUT, 'img', IMG.globe.file), type: 'jpeg', quality: 86 });
await page.setViewportSize({ width: S.w, height: S.h });
await page.goto('file:///' + join(OUT, 'carousel.html').replace(/\\/g, '/'));
await page.evaluate(() => document.fonts.ready);
const els = await page.$$('section.s');
for (let i = 0; i < els.length; i++) await els[i].screenshot({ path: join(OUT, `slide-${i + 1}.png`) });
// The PDF is built from FLATTENED slide images: LinkedIn's document converter paints transparent layers
// (the cover's photo gradient) black, so the PDF must hold no transparency. Rendered at 2x so text stays sharp.
const hi = await browser.newPage({ viewport: { width: S.w, height: S.h }, deviceScaleFactor: 2 });
await hi.goto(fileUrl(join(OUT, 'carousel.html')));
await hi.evaluate(() => document.fonts.ready);
const hiEls = await hi.$$('section.s');
mkdirSync(join(OUT, 'pdfpages'), { recursive: true });
for (let i = 0; i < hiEls.length; i++) await hiEls[i].screenshot({ path: join(OUT, 'pdfpages', `p${i + 1}.jpg`), type: 'jpeg', quality: 90 });
await hi.close();
// PIL writes the page exactly the image size (Chromium rounds 1012.5pt up to 1013pt = a white hairline at the bottom)
const pages = hiEls.map((_, i) => join(OUT, 'pdfpages', `p${i + 1}.jpg`));
execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', 'import sys; from PIL import Image; ims=[Image.open(p).convert("RGB") for p in sys.argv[3:]]; ims[0].save(sys.argv[1], save_all=True, append_images=ims[1:], resolution=192.0); ims[0].resize((1080, 1350), Image.LANCZOS).save(sys.argv[2], quality=88)', join(OUT, 'carousel.pdf'), join(OUT, 'cover.jpg'), ...pages], { stdio: 'inherit' });

// featured / og:image, 1200x630 (link previews crop a portrait slide badly)
const og = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=Newsreader:opsz,wght@6..72,600&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0}.c{width:1200px;height:630px;background:#0f2d5e ${PHOTO ? `url('${PHOTO}') center 45%/cover` : ''};color:#fff;font-family:'IBM Plex Sans',sans-serif;padding:58px 64px;position:relative;border-top:12px solid #c8a94a;overflow:hidden}
.c:before{content:'';position:absolute;inset:0;background:${PHOTO ? 'linear-gradient(90deg,rgba(9,24,52,.94) 0%,rgba(9,24,52,.82) 48%,rgba(9,24,52,.25) 100%)' : 'none'}}.c>*{position:relative}.c>.st,.c>.br{position:absolute}
.k{font-size:22px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#c8a94a}h1{font:600 54px/1.1 Newsreader,serif;margin:22px 0 0;max-width:${PHOTO ? 760 : 1000}px}
.st{position:absolute;left:64px;bottom:56px;display:flex;gap:18px}.st div{border:2px solid rgba(255,255,255,.25);border-radius:12px;padding:14px 22px}.st b{display:block;font:600 44px/1 Newsreader,serif}.st span{font-size:18px;color:#c9d6ea}
.br{position:absolute;right:64px;bottom:62px;font-size:20px;font-weight:700;letter-spacing:.1em;color:#8fa3c4}</style></head>
<body><div class="c"><div class="k">Trade Flow Weekly · Week ${WEEK}, ${YEAR}</div><h1>${esc(N.title)}</h1>
<div class="st"><div><b>${data.totals.signals}</b><span>signals</span></div><div><b>${crit}</b><span>critical</span></div><div><b>${hot.length}/9</b><span>lanes active</span></div></div><div class="br">WORLDTRADEPRO.COM</div></div></body></html>`;
await page.setViewportSize({ width: 1200, height: 630 });
writeFileSync(join(OUT, '_share.html'), og);
await page.goto(fileUrl(join(OUT, '_share.html')));
await page.evaluate(() => document.fonts.ready);
await page.locator('.c').screenshot({ path: join(OUT, `${SLUG}.png`) });
await browser.close();

const PDFNAME = `WorldTradePro-Trade-Flow-Weekly-${YEAR}-W${String(WEEK).padStart(2, '0')}`;
const assets = {
  ...Object.fromEntries(Object.entries(IMG).map(([k, m]) => [k, { file: 'img/' + m.file, name: `${SLUG}-${k}.${m.file.split('.').pop()}`, alt: m.alt }])),
  share: { file: `${SLUG}.png`, name: `${SLUG}-share.png`, alt: `Trade Flow Weekly, week ${WEEK} ${YEAR}: ${N.title}` },
  pdf: { file: 'carousel.pdf', name: `${PDFNAME}.pdf`, alt: '' },
  cover: { file: 'cover.jpg', name: `${PDFNAME}-cover.jpg`, alt: `Trade Flow Weekly, week ${WEEK} ${YEAR}` },
};
writeFileSync(join(OUT, 'assets.json'), JSON.stringify({ slug: SLUG, week: WEEK, year: YEAR, date: TODAY, title: N.title, dek: N.dek, docTitle: `Trade Flow Weekly · Week ${WEEK}, ${YEAR}`, assets }, null, 2));
console.log(`Trade Flow Weekly ${SLUG}: ${flow.length} signals, ${crit} critical, ${hot.length} lanes -> ${OUT}`);
