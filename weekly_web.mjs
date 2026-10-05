// World Trade Pro Weekly, web version: the FULL issue as a Blog post (/blog/world-trade-pro-weekly-<year>-w<NN>/).
//   Same blocks + notes as the e-mail (newsletter/out/<date>-weekly.blocks.json, newsletter/notes/<date>-weekly.json), but
//   nothing folded: every project of the week listed under its sector with an anchor (#sec-power ...), so the e-mail's
//   "All 41 power & renewables projects" links land on exactly those 41. Also the archive: one URL per issue, indexable.
// Writes newsletter/out/<date>-weekly.web.html (preview, standalone) and newsletter/out/<date>-weekly.wp.json
// ({ slug, title, excerpt, content }) for weekly_web_publish.mjs -> POST /wtp/v1/insights/stage + /publish.
// Usage: node weekly_web.mjs [--date YYYY-MM-DD]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTORS, SECTOR_ORDER, esc } from './newsletter_assemble.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const W = cfg.newsletter.weekly || {};
const args = process.argv.slice(2);
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const NAME = `${TODAY}-weekly`;
const b = JSON.parse(readFileSync(join(HERE, 'newsletter', 'out', `${NAME}.blocks.json`), 'utf8'));
const NOTES_FILE = join(HERE, 'newsletter', 'notes', `${NAME}.json`);
const NOTES = existsSync(NOTES_FILE) ? JSON.parse(readFileSync(NOTES_FILE, 'utf8')) : null;
const slug = b.slug || `world-trade-pro-weekly-${b.year}-w${String(b.week).padStart(2, '0')}`;
const url = `${cfg.site}/blog/${slug}/`;
const fmtDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const st = b.stats || {}, dl = st.deltas || {};
const delta = (d) => (d > 0 ? `<span class="up">▲ ${d}</span>` : d < 0 ? `<span class="dn">▼ ${-d}</span>` : '<span class="eq">=</span>');

// the e-mail blocks are table HTML with inline styles; on the web they sit inside a 760px column and read fine as they are.
// Project rows / deal cards are reused verbatim; the full per-sector lists come from blocks.full (every project, not 8).
const full = b.full || {};
const sectorsOut = SECTOR_ORDER.filter((k) => (full[k] || []).length).map((k) => {
  const items = full[k];
  return `<section class="sec" id="sec-${k}"><h2>${esc(SECTORS[k])} <span class="n">${items.length}</span></h2>
  <table class="list"><thead><tr><th>Project</th><th>Stage</th><th>Country</th><th>Scale</th><th>Company</th></tr></thead><tbody>
  ${items.map((it) => `<tr><td><a href="${esc(it.url)}" rel="nofollow noopener" target="_blank">${esc(it.name)}</a>${it.sub ? `<div class="sub">${esc(it.sub)}</div>` : ''}</td><td><span class="st st-${esc(it.stageKey)}">${esc(it.stage)}</span>${it.value ? `<div class="sub"><b>${esc(it.value)}</b></div>` : ''}${it.deadline ? `<div class="sub">bids due ${esc(it.deadline)}</div>` : ''}</td><td>${esc(it.country)}</td><td>${esc(it.scale)}</td><td title="${esc(it.company)}">${esc(it.company.length > 48 ? it.company.slice(0, 46).replace(/\s+\S*$/, '') + '…' : it.company)}</td></tr>`).join('\n')}
  </tbody></table></section>`;
}).join('\n');

const toc = SECTOR_ORDER.filter((k) => (full[k] || []).length).map((k) => `<a href="#sec-${k}">${esc(SECTORS[k])} <span>${full[k].length}</span></a>`).join('');
const emailTable = (html) => `<table class="em" role="presentation" width="100%" cellpadding="0" cellspacing="0">${html}</table>`;

const css = `
.wtpw{--navy:#0B2545;--accent:#1F6FEB;--ink:#111827;--text:#374151;--muted:#6B7280;--line:#E5E7EB;--soft:#F3F4F6;--gold:#c8a94a;font:16px/1.6 "Segoe UI",Helvetica,Arial,sans-serif;color:var(--text);max-width:860px;margin:0 auto}
.wtpw *{box-sizing:border-box}.wtpw a{color:var(--accent)}
.wtpw .hero{background:var(--navy);color:#fff;padding:34px 32px 28px;border-radius:12px}
.wtpw .hero .k{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:700}
.wtpw .hero h1{font-size:38px;line-height:1.1;margin:10px 0 12px;color:#fff;letter-spacing:-.01em;font-family:inherit!important}
.wtpw .hero .sub{color:rgba(255,255,255,.75);font-size:15px}.wtpw .hero .promise{color:var(--gold);font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;margin-top:12px}
.wtpw .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0 0}.wtpw .tile{background:var(--soft);border-top:3px solid var(--navy);padding:12px 8px 10px;text-align:center}
.wtpw .tile b{display:block;font-size:30px;color:var(--navy);line-height:1}.wtpw .tile span{display:block;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-top:4px;font-weight:700}.wtpw .tile i{display:block;font-style:normal;font-size:12px;font-weight:700;margin-top:3px}
.wtpw .up{color:#15803d}.wtpw .dn{color:#b42318}.wtpw .eq{color:var(--muted)}
.wtpw .toc{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 0}.wtpw .toc a{display:inline-block;border:1px solid var(--navy);color:var(--navy);border-radius:3px;padding:4px 10px;font-size:13px;font-weight:700;text-decoration:none}.wtpw .toc a span{color:var(--muted);font-weight:400}.wtpw .toc a.pdf{background:var(--navy);color:#fff;margin-left:auto}
.wtpw .note{background:#f4efe4;border-radius:10px;padding:18px 22px;margin:22px 0 0;font-size:17px;line-height:1.65;color:var(--ink)}.wtpw .note .k{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a6d1f;font-weight:700}.wtpw .note .s{color:var(--muted);font-size:14px;margin-top:8px}
.wtpw h2{font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:var(--navy);padding:10px 16px;margin:34px 0 10px;font-family:inherit!important}.wtpw h2 .n{color:rgba(255,255,255,.65);font-weight:400;margin-left:6px}
.wtpw .em{margin:0}.wtpw .em td{font-family:inherit}
.wtpw table.list{width:100%;border-collapse:collapse;font-size:14.5px}.wtpw table.list th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border-bottom:2px solid var(--navy);padding:6px 8px}
.wtpw table.list td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}.wtpw table.list td a{color:var(--ink);font-weight:600;text-decoration:none}.wtpw table.list td a:hover{color:var(--accent)}.wtpw .sub{font-size:12.5px;color:var(--muted);margin-top:2px}
.wtpw .st{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}.wtpw .st-S4{color:var(--accent)}.wtpw .st-S5{color:var(--navy)}.wtpw .st-S1,.wtpw .st-S2,.wtpw .st-S3{color:var(--muted)}
.wtpw .foot{border-top:1px solid var(--line);margin-top:34px;padding-top:16px;font-size:14px;color:var(--muted)}.wtpw .foot a{font-weight:700;color:var(--navy);text-decoration:none;margin-right:18px}
@media(max-width:640px){.wtpw .hero{padding:22px 18px}.wtpw .hero h1{font-size:28px}.wtpw .tiles{grid-template-columns:1fr 1fr}.wtpw table.list th:nth-child(4),.wtpw table.list td:nth-child(4),.wtpw table.list th:nth-child(5),.wtpw table.list td:nth-child(5){display:none}}`;

const body = `<style>${css}</style>
<div class="wtpw">
<div class="hero"><div class="k">${esc(b.head.kicker)}</div><h1>${esc(b.head.title)}</h1><div class="sub">${esc(b.head.sub)}</div>${b.promise ? `<div class="promise">${esc(b.promise)}</div>` : ''}</div>
<div class="tiles"><div class="tile"><b>${st.epc ?? 0}</b><span>new projects</span><i>${delta(dl.epc)}</i></div><div class="tile"><b>${st.tenders ?? 0}</b><span>tenders</span><i>${delta(dl.tenders)}</i></div><div class="tile"><b>${st.awards ?? 0}</b><span>awards</span><i>${delta(dl.awards)}</i></div><div class="tile"><b>${st.flow ?? 0}</b><span>flow signals</span><i>${delta(dl.flow)}</i></div></div>
<div class="toc">${toc}${b.pdfUrl ? `<a class="pdf" href="${esc(b.pdfUrl)}">Download the PDF report ↓</a>` : ''}</div>
${NOTES?.lede_html ? `<div class="note"><div class="k">This week</div><div>${NOTES.lede_html}</div>${NOTES.signoff ? `<div class="s">— ${esc(NOTES.signoff)}</div>` : ''}</div>` : ''}
<h2>The week in one look</h2>
${b.chartTitle ? `<p style="font-size:18px;font-weight:700;color:var(--ink);margin:0 0 2px">${esc(b.chartTitle)}</p><p style="font-size:13px;color:var(--muted);margin:0">New projects by sector · tenders / awards / earlier stage · value where the notice names one</p>` : ''}
${b.chart ? emailTable(b.chart) : ''}${b.callout ? emailTable(b.callout) : ''}
<h2>Deals of the week</h2>
${emailTable(b.calls.slice(0, 6).map((c, i) => `<tr><td style="padding:8px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:4px solid #1F6FEB;background:#F3F4F6;"><tr><td style="padding:12px 16px 14px;"><div style="font-size:11px;color:#9CA3AF;font-weight:700;">${i + 1} / ${Math.min(6, b.calls.length)}</div>${c.html}${c.why ? '' : c.call || ''}</td></tr></table></td></tr>`).join(''))}
${b.calendar ? `<h2 id="deadlines">Bid deadlines, next 14 days</h2>${emailTable(b.calendar)}` : ''}
<h2>All ${st.epc ?? 0} new projects, by sector</h2>
<p style="font-size:14px;color:var(--muted);margin:0 0 6px">First seen ${fmtDay(b.from)} – ${fmtDay(b.to)}. Each name links to the source notice or report.</p>
${sectorsOut}
${b.flows?.items?.length ? `<h2 id="flows">Flows that moved</h2>${emailTable(b.flows.items.map((f) => f.html).join('') + (b.flows.lanes || ''))}` : ''}
<div class="foot"><a href="${esc(cfg.site + '/subscribe/')}">Get this by e-mail every Tuesday →</a><a href="${esc(cfg.site + '/project-sourcing/')}">Add your project or tender →</a><a href="${esc(cfg.site + '/blog/')}">Past issues →</a></div>
</div>`;

const title = `${W.name || 'World Trade Pro Weekly'} · Issue ${b.issue}: ${b.subject}`;
const excerpt = `${b.preview}. Who's buying, who won, what moved — the week of ${fmtDay(b.from)} – ${fmtDay(b.to)}.`;
writeFileSync(join(HERE, 'newsletter', 'out', `${NAME}.wp.json`), JSON.stringify({ slug, url, title, excerpt, content: `<!-- wp:html -->\n${body}\n<!-- /wp:html -->` }, null, 1));
writeFileSync(join(HERE, 'newsletter', 'out', `${NAME}.web.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="margin:0;background:#fff;padding:24px 16px">${body}</body></html>`);
console.log(`web issue: ${slug} -> ${url} (${Object.values(full).reduce((n, a) => n + a.length, 0)} projects listed, ${(body.length / 1024).toFixed(0)} KB)`);
