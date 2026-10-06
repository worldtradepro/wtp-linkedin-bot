// World Trade Pro Weekly, PDF report: the issue laid out like a consulting report (A4 landscape, one exhibit per page,
// every chart titled with its conclusion, source line under every exhibit), from the same blocks + notes as the e-mail.
//   newsletter/out/<date>-weekly.blocks.json + newsletter/notes/<date>-weekly.json
//   -> newsletter/out/<date>-weekly/<PDFNAME>.pdf (real text, selectable) + cover.jpg (page 1, for sharing / LinkedIn)
// Fonts: Segoe UI on Windows, Roboto on the Linux runner (fonts-roboto). Usage: node weekly_pdf.mjs [--date YYYY-MM-DD]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { SECTORS, SECTOR_ORDER, esc } from './newsletter_assemble.mjs';
import { pickPhoto } from './weekly_photo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const W = cfg.newsletter.weekly || {};
const args = process.argv.slice(2);
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const NAME = `${TODAY}-weekly`;
const b = JSON.parse(readFileSync(join(HERE, 'newsletter', 'out', `${NAME}.blocks.json`), 'utf8'));
const NOTES_FILE = join(HERE, 'newsletter', 'notes', `${NAME}.json`);
const NOTES = existsSync(NOTES_FILE) ? JSON.parse(readFileSync(NOTES_FILE, 'utf8')) : null;
const OUT = join(HERE, 'newsletter', 'out', NAME);
mkdirSync(OUT, { recursive: true });
export const pdfNameOf = (year, week) => `WorldTradePro-Weekly-${year}-W${String(week).padStart(2, '0')}`;
const PDFNAME = pdfNameOf(b.year, b.week);
const fmtDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const st = b.stats || {}, dl = st.deltas || {};
const delta = (d) => (d > 0 ? `<span class="up">▲ ${d} vs last week</span>` : d < 0 ? `<span class="dn">▼ ${-d} vs last week</span>` : '<span class="eq">= last week</span>');
const full = b.full || {};
const total = Object.values(full).reduce((n, a) => n + a.length, 0);
const M = b.material || {};
const logo = pathToFileURL(join(HERE, 'assets', 'logo_light.png')).href;
// cover photo: a licensed library photo for the week's leading sector (flattened into the PDF; credit on the cover)
const leadKey = Object.entries(full).sort((x, y) => y[1].length - x[1].length)[0]?.[0] || 'energy';
const PHOTO = pickPhoto(leadKey, b.issue);

// ---------------------------------------------------------------- pages
const cover = `<section class="page cover"${PHOTO ? ` style="background-image:linear-gradient(90deg, rgba(11,37,69,.97) 0%, rgba(11,37,69,.88) 55%, rgba(11,37,69,.45) 100%), url('${PHOTO.localUrl}');background-size:cover;background-position:center;"` : ''}>
  <div class="cv-top"><img src="${logo}" alt="World Trade Pro" class="logo"><div class="k">${esc(W.name || 'World Trade Pro Weekly')} · Issue ${b.issue} · Week ${b.week}, ${b.year}</div></div>
  <h1>Who's buying,<br>who won,<br>what moved</h1>
  <div class="cv-sub">${fmtDay(b.from)} – ${fmtDay(b.to)} · ${plural(st.epc ?? 0, 'new project')} in ${esc(String(b.head.sub).match(/in (\d+) countries/)?.[1] || '')} countries · ${st.tenders} tenders · ${st.awards} awards · ${plural(st.flow ?? 0, 'trade-flow signal')}</div>
  ${M.biggest?.value ? `<div class="cv-big"><div class="n">${esc(M.biggest.value)}</div><div class="l">biggest contract of the week — ${esc(M.biggest.name)}${M.biggest.who ? `, ${esc(M.biggest.who)}` : ''}</div></div>` : ''}
  <div class="cv-stats">
    <div><b>${st.epc ?? 0}</b><span>new projects</span><i>${delta(dl.epc)}</i></div>
    <div><b>${st.tenders ?? 0}</b><span>tenders</span><i>${delta(dl.tenders)}</i></div>
    <div><b>${st.awards ?? 0}</b><span>awards</span><i>${delta(dl.awards)}</i></div>
    <div><b>${st.flow ?? 0}</b><span>flow signals</span><i>${delta(dl.flow)}</i></div>
  </div>
  <div class="cv-foot">worldtradepro.com · free every Tuesday · data: World Trade Pro project radar and trade-flow radar, public sources only${PHOTO ? ` · ${esc(PHOTO.credit)}${PHOTO.illustrative ? ' (illustrative)' : ''}` : ''}</div>
</section>`;

const thisWeek = `<section class="page">
  <div class="ph"><span>This week</span><span class="pn">2</span></div>
  <div class="two">
    <div class="note">${NOTES?.lede_html ? `<div class="k">Editor's note</div><div class="lede">${NOTES.lede_html}</div>${NOTES.signoff ? `<div class="sig">— ${esc(NOTES.signoff)}</div>` : ''}` : `<div class="k">This week</div><div class="lede">${esc(b.head.sub)}</div>`}</div>
    <div class="toc"><div class="k">In this issue</div>
      <ol>
        <li><b>Dashboard</b><span>new projects by sector, region, stage and country</span></li>
        <li><b>Largest contracts</b><span>the ten biggest tenders and awards by value${b.calendar ? ', and the bid deadlines of the next 14 days' : ''}</span></li>
        <li><b>Trade flows</b><span>signals by market, lane pressure, what moved</span></li>
        <li><b>All ${total} new projects</b><span>by sector, with stage, country, company and value</span></li>
      </ol>
      <div class="k" style="margin-top:14px">Who this is for</div>
      <ul class="open"><li><b>Suppliers and contractors:</b> awards = who is buying now; tenders = where to bid.</li><li><b>Owners and procurement:</b> award values = reference prices; busy contractors = who is booked.</li><li><b>Traders, charterers, finance:</b> flows and lane pressure = what moves next; projects = tomorrow's cargo and credit.</li></ul>
    </div>
  </div>
</section>`;

const em = (html) => `<table class="em" role="presentation" width="100%" cellpadding="0" cellspacing="0">${html}</table>`;
const exhibit = (n, title, sub, body, source) => `<section class="page">
  <div class="ph"><span>Exhibit ${n}</span><span class="pn"></span></div>
  <h2 class="ex-t">${title}</h2>${sub ? `<div class="ex-s">${sub}</div>` : ''}
  <div class="ex-b">${body}</div>
  <div class="src">Source: ${source}</div>
</section>`;

const D = b.dash || {};
const bar = (rows, max, color = '#0B2545') => `<table class="bars">${rows.map((r) => `<tr><td class="bl">${r.label}</td><td class="bb"><div style="width:${Math.max(2, Math.round((r.n / Math.max(1, max)) * 100))}%;background:${r.color || color};"></div></td><td class="bn">${r.n}${r.extra ? ` <span>${r.extra}</span>` : ''}</td></tr>`).join('')}</table>`;
const panel = (title, body) => `<div class="panel"><div class="pt">${title}</div>${body}</div>`;
const sectorRows = (b.chart ? Object.entries(full).map(([k, v]) => ({ label: esc(SECTORS[k]), n: v.length, extra: (() => { const u = v.reduce((n, it) => n + (it.usd || 0), 0); return u ? (u >= 1e9 ? `US$${(u / 1e9).toFixed(1)}bn` : `US$${Math.round(u / 1e6)}m`) : ''; })() })) : []).sort((a, b2) => b2.n - a.n);
const stageColor = { S1: '#9CA3AF', S2: '#9DB4D6', S3: '#9DB4D6', S4: '#1F6FEB', S5: '#0B2545' };
const ex1 = exhibit(1, `${esc(b.chartTitle || 'New projects this week')}`, `${plural(st.epc ?? 0, 'new project')} first seen ${fmtDay(b.from)} – ${fmtDay(b.to)}; same-name reports merged; contract value where the notice names one`,
  `<div class="grid4">
    ${panel('By sector', bar(sectorRows, Math.max(...sectorRows.map((r) => r.n), 1)))}
    ${panel('By region', bar((D.regions || []).filter((r) => r.name !== 'Unknown').map((r) => ({ label: esc(r.name), n: r.n })), Math.max(...(D.regions || []).map((r) => r.n), 1), '#1F6FEB'))}
    ${panel('By stage', bar((D.stages || []).map((r) => ({ label: esc(r.label), n: r.n, color: stageColor[r.key] })), Math.max(...(D.stages || []).map((r) => r.n), 1)))}
    ${panel('Busiest countries', bar((D.countries || []).slice(0, 8).map((r) => ({ label: `${r.flag || ''} ${esc(r.name)}`, n: r.n })), Math.max(...(D.countries || []).map((r) => r.n), 1), '#1F6FEB'))}
  </div>`, `World Trade Pro project radar, ${fmtDay(b.from)} – ${fmtDay(b.to)}; official notices (EU TED, UK Find a Tender, World Bank) and trade press`);

const money = (usd) => (!usd ? '' : usd >= 1e9 ? `US$${(usd / 1e9).toFixed(1)}bn` : `US$${Math.round(usd / 1e6)}m`);
const topTable = `<table class="list top"><thead><tr><th>#</th><th>Contract</th><th>Stage</th><th>Country</th><th>Sector</th><th>Counterparty</th><th class="val">Value</th></tr></thead><tbody>
  ${(D.topDeals || []).map((d, i) => `<tr><td class="num">${i + 1}</td><td><a href="${esc(d.url)}">${esc(d.name.length > 70 ? d.name.slice(0, 68).replace(/\s+\S*$/, '') + '…' : d.name)}</a></td><td class="${d.tender ? 'st-S4' : 'st-S5'}">${d.tender ? 'Tender' : 'Awarded'}</td><td>${esc(d.country)}</td><td>${esc(d.sector)}</td><td>${d.who ? `<span class="sub">${d.tender ? 'buyer' : 'won by'}</span> ${esc(d.who.length > 44 ? d.who.slice(0, 42).replace(/\s+\S*$/, '') + '…' : d.who)}` : ''}</td><td class="val">${esc(d.value)}</td></tr>`).join('')}
  </tbody></table>`;
const ex2 = exhibit(2, `${money(D.totalUsd) ? `${money(D.totalUsd)} of named contract value this week; ` : ''}the ten largest tenders and awards`, 'Ranked by the value stated in the notice. Awards are reference prices for buyers and a buying contractor for suppliers; tenders are open windows for bidders.',
  topTable, 'as Exhibit 1; values as stated in the notice, converted to US$ by the source');
const ex3 = b.calendar ? exhibit(3, `${b.calendarCount || ''} bid deadlines in the next 14 days`.trim(), 'Tender notices that state a closing date, soonest first. Red = due within three days.', `<div class="two"><div class="cal">${em(b.calendar)}</div><div>${panel('By stage', bar((D.stages || []).map((r) => ({ label: esc(r.label), n: r.n, color: stageColor[r.key] })), Math.max(...(D.stages || []).map((r) => r.n), 1)))}</div></div>`, 'tender notices with a stated deadline') : '';
const secTables = SECTOR_ORDER.filter((k) => (full[k] || []).length).map((k) => `<div class="sec-block"><h3>${esc(SECTORS[k])} <span>${full[k].length}</span></h3>
  <table class="list"><thead><tr><th>Project</th><th>Stage</th><th>Country</th><th>Scale</th><th>Company</th><th>Value</th></tr></thead><tbody>
  ${full[k].map((it) => `<tr><td><a href="${esc(it.url)}">${esc(it.name)}</a>${it.sub ? `<div class="sub">${esc(it.sub)}</div>` : ''}</td><td class="st-${esc(it.stageKey)}">${esc(it.stage)}${it.deadline ? `<div class="sub">bids due ${esc(it.deadline)}</div>` : ''}</td><td>${esc(it.country)}</td><td>${esc(it.scale)}</td><td>${esc(it.company.length > 40 ? it.company.slice(0, 38).replace(/\s+\S*$/, '') + '…' : it.company)}</td><td class="val">${esc(it.value || '')}</td></tr>`).join('')}
  </tbody></table></div>`).join('');
const exProjects = `<section class="page flow"><div class="ph"><span>All ${total} new projects, by sector</span><span class="pn"></span></div>
  <div class="ex-s">First seen ${fmtDay(b.from)} – ${fmtDay(b.to)}. Same-name reports merged. Each project name links to the source notice or report.</div>
  ${secTables}
  <div class="src">Source: World Trade Pro project radar; official notices and trade press as linked</div></section>`;

const laneRows = (D.lanes || []).filter((l) => l.n).map((l) => ({ label: esc(l.name), n: l.n, color: l.status === 'High' ? '#b42318' : l.status === 'Elevated' ? '#b45309' : '#9DB4D6', extra: `${l.status}${l.p > l.pp ? ' ▲' : l.p < l.pp ? ' ▼' : ''}` }));
const exFlows = exhibit(4, `${plural(st.flow ?? 0, 'trade-flow signal')} this week, ${st.critical ?? 0} of them critical${laneRows[0] ? `; ${laneRows[0].label} under the most pressure` : ''}`, 'Signals by market and pressure on the nine main shipping lanes (critical ×3, elevated ×2, watch ×1), then the stories that moved and what they mean',
  `<div class="grid4 g2"><div>${panel('Signals by market', bar((D.flowSectors || []).map((r) => ({ label: esc(r.name), n: r.n })), Math.max(...(D.flowSectors || []).map((r) => r.n), 1), '#1F6FEB'))}${panel('Lane pressure', bar(laneRows, Math.max(...laneRows.map((r) => r.n), 1)))}</div><div class="flowlist">${em((b.flows?.items || []).slice(0, 3).map((f) => f.html).join(''))}</div></div>`, 'World Trade Pro trade-flow radar; stories as linked');

const back = `<section class="page back">
  <div class="ph"><span>World Trade Pro Weekly</span><span class="pn"></span></div>
  <h2 class="ex-t">Three ways to get this every week</h2>
  <div class="three">
    <div><div class="k">1 · Tuesday e-mail</div><p>A five-minute preview: the week's judgement, the headline numbers and the largest contracts, filtered to the sectors you pick.</p></div>
    <div><div class="k">2 · The full issue online</div><p>Every new project of the week by sector, the deals, the bid calendar, the flows; one page per issue, always there.</p></div>
    <div><div class="k">3 · This PDF report</div><p>The issue as a report: one exhibit per page, sources under every chart. Forward it, print it, bring it to Monday's meeting.</p></div>
  </div>
  <div class="cta"><b>${esc(cfg.site.replace(/^https?:\/\//, ''))}/subscribe/</b> — free, pick your sectors, one e-mail a week.</div>
  <div class="cta2">Need equipment, spares or services for a project, or want your company in the supplier directory? <b>${esc(cfg.site.replace(/^https?:\/\//, ''))}/project-sourcing/</b></div>
  <div class="src">© ${b.year} World Trade Pro. Data from public notices and trade press, linked in each entry; no guarantee of completeness. Sponsorship: contact@worldtradepro.com</div>
</section>`;

const css = `
@page { size: A4 landscape; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #374151; font-size: 11.5pt; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 297mm; min-height: 210mm; padding: 14mm 16mm 12mm; page-break-after: always; position: relative; background: #fff; }
.page.flow { min-height: auto; }
.page:last-child { page-break-after: auto; }
.ph { display: flex; justify-content: space-between; font-size: 9pt; letter-spacing: .12em; text-transform: uppercase; color: #6B7280; font-weight: 700; border-bottom: 1px solid #E5E7EB; padding-bottom: 6px; margin-bottom: 14px; }
.cover { background: #0B2545; color: #fff; padding: 14mm 18mm 10mm; }
.cv-top { display: flex; align-items: center; gap: 14px; } .logo { height: 34px; } .cv-top .k { font-size: 10pt; letter-spacing: .14em; text-transform: uppercase; color: #c8a94a; font-weight: 700; }
.cover h1 { font-size: 48pt; line-height: 1.02; margin: 12mm 0 6mm; letter-spacing: -.01em; font-weight: 800; color: #fff; }
.cv-sub { font-size: 12.5pt; color: rgba(255,255,255,.78); max-width: 180mm; }
.cv-big { margin-top: 7mm; display: flex; align-items: baseline; gap: 14px; } .cv-big .n { font-size: 40pt; font-weight: 800; color: #c8a94a; line-height: 1; } .cv-big .l { font-size: 11pt; color: rgba(255,255,255,.85); max-width: 150mm; }
.cv-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 7mm; }
.cv-stats div { border-top: 2px solid rgba(255,255,255,.35); padding-top: 8px; } .cv-stats b { font-size: 26pt; display: block; line-height: 1; } .cv-stats span { display: block; font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.7); margin-top: 4px; } .cv-stats i { display: block; font-style: normal; font-size: 9pt; margin-top: 3px; }
.up { color: #86efac; } .dn { color: #fca5a5; } .eq { color: rgba(255,255,255,.6); } .page:not(.cover) .up { color: #15803d; } .page:not(.cover) .dn { color: #b42318; } .page:not(.cover) .eq { color: #6B7280; }
.cv-foot { margin-top: 8mm; padding-top: 4mm; border-top: 1px solid rgba(255,255,255,.18); font-size: 8.5pt; color: rgba(255,255,255,.55); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12mm; align-items: start; }
.note { background: #f4efe4; border-radius: 8px; padding: 16px 20px; } .k { font-size: 9pt; letter-spacing: .1em; text-transform: uppercase; color: #8a6d1f; font-weight: 700; } .lede { font-size: 13pt; line-height: 1.55; color: #111827; margin-top: 8px; } .lede a { color: #1F6FEB; } .sig { color: #6B7280; font-size: 10pt; margin-top: 10px; }
.toc .k { color: #0B2545; } .toc ol { margin: 8px 0 0; padding-left: 20px; } .toc li { margin: 6px 0; } .toc li b { color: #111827; } .toc li span { display: block; font-size: 10pt; color: #6B7280; }
.open { margin: 6px 0 0; padding-left: 18px; font-size: 11pt; color: #111827; } .open li { margin: 3px 0; }
.ex-t { font-size: 20pt; line-height: 1.2; color: #111827; margin: 0 0 4px; font-weight: 800; } .ex-s { font-size: 10pt; color: #6B7280; margin-bottom: 10px; }
.ex-b { margin-top: 6px; }
.grid4 .panel table.bars td { padding: 2px 0; } .grid4 .bb div { height: 9px; } .grid4 table.bars { font-size: 9pt; }
.src { position: absolute; bottom: 9mm; left: 16mm; right: 16mm; font-size: 8.5pt; color: #9CA3AF; border-top: 1px solid #E5E7EB; padding-top: 5px; }
.page.flow .src { position: static; margin-top: 10mm; }
.em { width: 100%; } .em td { font-family: inherit !important; }
.grid4 { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm 12mm; } .grid4.g2 { grid-template-columns: 1fr 1.25fr; }
.panel { break-inside: avoid; } .pt { font-size: 9.5pt; letter-spacing: .1em; text-transform: uppercase; color: #0B2545; font-weight: 800; border-bottom: 2px solid #0B2545; padding-bottom: 4px; margin-bottom: 6px; }
table.bars { width: 100%; border-collapse: collapse; font-size: 10pt; } table.bars td { padding: 3px 0; } .bl { width: 42%; color: #111827; font-weight: 600; padding-right: 8px !important; } .bb div { height: 11px; border-radius: 2px; } .bn { width: 22%; padding-left: 8px !important; font-weight: 700; color: #111827; white-space: nowrap; } .bn span { color: #6B7280; font-weight: 400; font-size: 9pt; }
table.top td.num { color: #9CA3AF; font-weight: 700; width: 18px; }
.flowlist .em td { font-size: 10pt !important; }
.deals { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
.deal { background: #F3F4F6; border-left: 4px solid #1F6FEB; padding: 10px 12px 12px; font-size: 10pt; position: relative; } .deal a { color: #111827; text-decoration: none; }
.deal .dn { position: absolute; right: 10px; top: 8px; font-size: 9pt; color: #9CA3AF; font-weight: 700; } .deal .dsec { font-size: 8.5pt; letter-spacing: .06em; text-transform: uppercase; color: #6B7280; font-weight: 700; }
.deal div[style*="font-size:17px"] { font-size: 12pt !important; } .deal div[style*="font-size:14px"] { font-size: 10pt !important; }
.cal .em td { font-size: 10pt !important; }
h3 { font-size: 12pt; background: #0B2545; color: #fff; padding: 6px 10px; margin: 10mm 0 4px; letter-spacing: .06em; text-transform: uppercase; page-break-after: avoid; } h3 span { color: rgba(255,255,255,.65); font-weight: 400; margin-left: 6px; }
.sec-block:first-child h3 { margin-top: 0; }
table.list { width: 100%; border-collapse: collapse; font-size: 9.5pt; page-break-inside: auto; } table.list tr { page-break-inside: avoid; }
table.list th { text-align: left; font-size: 8pt; letter-spacing: .06em; text-transform: uppercase; color: #6B7280; border-bottom: 1.5px solid #0B2545; padding: 4px 6px; }
table.list td { padding: 5px 6px; border-bottom: 1px solid #E5E7EB; vertical-align: top; } table.list td a { color: #111827; text-decoration: none; font-weight: 600; } .sub { font-size: 8.5pt; color: #6B7280; }
.st-S4 { color: #1F6FEB; font-weight: 700; } .st-S5 { color: #0B2545; font-weight: 700; } .st-S1, .st-S2, .st-S3 { color: #6B7280; } .val { font-weight: 700; color: #111827; white-space: nowrap; }
.back .three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12mm; margin-top: 8mm; } .back .three .k { color: #0B2545; } .back p { font-size: 11pt; margin: 6px 0 0; }
.cta { margin-top: 14mm; font-size: 16pt; color: #111827; } .cta2 { margin-top: 6mm; font-size: 11pt; color: #374151; }
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(PDFNAME)}</title><style>${css}</style></head><body>${cover}${thisWeek}${ex1}${ex2}${ex3}${exProjects}${exFlows}${back}</body></html>`;
writeFileSync(join(OUT, 'report.html'), html);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1123, height: 794 } });
await page.goto(pathToFileURL(join(OUT, 'report.html')).href, { waitUntil: 'load' });
await page.waitForTimeout(300);
await page.pdf({ path: join(OUT, `${PDFNAME}.pdf`), format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
await page.locator('.cover').screenshot({ path: join(OUT, 'cover.jpg'), type: 'jpeg', quality: 88 });
await browser.close();
const kb = (readFileSync(join(OUT, `${PDFNAME}.pdf`)).length / 1024).toFixed(0);
writeFileSync(join(OUT, 'pdf.json'), JSON.stringify({ file: `${PDFNAME}.pdf`, name: PDFNAME, cover: 'cover.jpg', slug: b.slug, kb: Number(kb) }, null, 2));
console.log(`PDF report: newsletter/out/${NAME}/${PDFNAME}.pdf (${kb} KB), cover.jpg`);
