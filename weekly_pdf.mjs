// World Trade Pro Weekly, PDF report: the issue laid out like a consulting report (A4 landscape, one exhibit per page,
// every chart titled with its conclusion, source line under every exhibit), from the same blocks + notes as the e-mail.
//   newsletter/out/<date>-weekly.blocks.json + newsletter/notes/<date>-weekly.json
//   -> newsletter/out/<date>-weekly/<PDFNAME>.pdf (real text, selectable) + cover.jpg (page 1, for sharing / LinkedIn)
// Design: DESIGN.md direction C (2026-10-15) - white pages, black ink, Newsreader headlines and numbers, IBM Plex Sans UI,
// Plex Mono dates, hairline tables with a 2px black header rule, ▲/▼ text for changes; no gold, pills, shadows or caps labels.
// Fonts: Google Fonts at render time (the runner is online); fallbacks Georgia / Segoe UI / Roboto. Usage: node weekly_pdf.mjs [--date YYYY-MM-DD]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { SECTORS, SECTOR_ORDER, esc } from './newsletter_assemble.mjs';
import { pickPhoto } from './weekly_photo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const W = cfg.newsletter.weekly || {};
// 2026-10-14 (owner): one Weekly sponsor package = e-mail + web issue + PDF; the PDF names the sponsor on the cover
const SP = W.sponsor?.enabled && W.sponsor.name ? W.sponsor : null;
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
const delta = (d) => (d > 0 ? `<span class="up">▲ +${d}</span>` : d < 0 ? `<span class="dn">▼ -${-d}</span>` : '<span class="eq">0</span>');
// flag emoji print as letter pairs in Chromium on Windows and are 'emoji as decoration' anyway: country names only
const noFlag = (s) => String(s || '').replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').trim();
const full = b.full || {};
const total = Object.values(full).reduce((n, a) => n + a.length, 0);
const M = b.material || {};
// the refined horizontal lockup for documents on white (brand/logo/README.md), never recoloured
const logo = pathToFileURL(join(HERE, 'assets', 'wtp-logo-horizontal-color-240.png')).href;
// cover photo: a licensed library photo for the week's leading sector (flattened into the PDF; credit on the cover)
const leadKey = Object.entries(full).sort((x, y) => y[1].length - x[1].length)[0]?.[0] || 'energy';
const PHOTO = pickPhoto(leadKey, b.issue);

// ---------------------------------------------------------------- pages
const countries = esc(String(b.head.sub).match(/in (\d+) countries/)?.[1] || '');
// photo credit only where the licence requires one (CC BY / BY-SA); Pixabay / CC0 / PD need none (DESIGN.md section 1)
const credit = PHOTO && /CC BY/i.test(PHOTO.credit) ? esc(PHOTO.credit) : '';
const cover = `<section class="page cover">
  <div class="cv-l">
    <img src="${logo}" alt="World Trade Pro" class="logo">
    <div class="kick">${esc(W.name || 'World Trade Pro Weekly')} · Issue ${b.issue} · Week ${b.week}, ${b.year}</div>
    <h1>Who's buying, who won, what moved</h1>
    <div class="dek">${plural(st.epc ?? 0, 'new project')} in ${countries} countries, ${st.tenders} tenders, ${st.awards} awards and ${plural(st.flow ?? 0, 'trade-flow signal')}.</div>
    <div class="date">${fmtDay(b.from)} – ${fmtDay(b.to)}</div>
    ${M.biggest?.value ? `<div class="cv-big"><div class="l">Biggest contract of the week</div><div class="n">${esc(M.biggest.value)}</div><div class="w">${esc(M.biggest.name)}${M.biggest.who ? `, ${esc(M.biggest.who)}` : ''}</div></div>` : ''}
    ${SP ? `<div class="cv-spon">Brought to you by <b>${esc(SP.name)}</b>${SP.url ? ` · ${esc(String(SP.url).replace(/^https?:\/\//, '').replace(/\/$/, ''))}` : ''}</div>` : ''}
  </div>
  ${PHOTO ? `<div class="cv-r" style="background-image:url('${PHOTO.localUrl}')"></div>` : ''}
  <div class="keys">
    <div><span>New projects</span><b>${st.epc ?? 0}</b><i>${delta(dl.epc)}</i></div>
    <div><span>Tenders</span><b>${st.tenders ?? 0}</b><i>${delta(dl.tenders)}</i></div>
    <div><span>Awards</span><b>${st.awards ?? 0}</b><i>${delta(dl.awards)}</i></div>
    <div><span>Flow signals</span><b>${st.flow ?? 0}</b><i>${delta(dl.flow)}</i></div>
  </div>
  <div class="cv-foot">Change vs the week before · worldtradepro.com · free every Tuesday · data: World Trade Pro project radar and trade-flow radar, public sources only${credit ? ` · ${credit}` : ''}</div>
</section>`;

const ph = (t, n = '') => `<div class="ph"><span class="kick">${t}</span><span class="pn">${n}</span></div>`;
const thisWeek = `<section class="page">
  ${ph('This week', 2)}
  <div class="two">
    <div class="note">${NOTES?.lede_html ? `<h2 class="ex-t">Editor's note</h2><div class="lede">${NOTES.lede_html}</div>${NOTES.signoff ? `<div class="sig">${esc(NOTES.signoff)}</div>` : ''}` : `<h2 class="ex-t">This week</h2><div class="lede">${esc(b.head.sub)}</div>`}</div>
    <div class="toc"><div class="lab">In this issue</div>
      <ol>
        <li><span class="no">1</span><div><b>Dashboard</b><span>New projects by sector, region, stage and country</span></div></li>
        <li><span class="no">2</span><div><b>Largest contracts</b><span>The ten biggest tenders and awards by value${b.calendar ? ', and the bid deadlines of the next 14 days' : ''}</span></div></li>
        <li><span class="no">3</span><div><b>Trade flows</b><span>Signals by market, lane pressure, what moved</span></div></li>
        <li><span class="no">4</span><div><b>All ${total} new projects</b><span>By sector, with stage, country, company and value</span></div></li>
      </ol>
      <div class="lab" style="margin-top:32px">Who this is for</div>
      <ul class="open"><li><b>Suppliers and contractors:</b> awards = who is buying now; tenders = where to bid.</li><li><b>Owners and procurement:</b> award values = reference prices; busy contractors = who is booked.</li><li><b>Traders, charterers, finance:</b> flows and lane pressure = what moves next; projects = tomorrow's cargo and credit.</li></ul>
    </div>
  </div>
</section>`;
const em = (html) => `<table class="em" role="presentation" width="100%" cellpadding="0" cellspacing="0">${html}</table>`;
const exhibit = (n, title, sub, body, source) => `<section class="page">
  ${ph(`Exhibit ${n}`)}
  <h2 class="ex-t">${title}</h2>${sub ? `<div class="ex-s">${sub}</div>` : ''}
  <div class="ex-b">${body}</div>
  <div class="src">Source: ${source}</div>
</section>`;

const D = b.dash || {};
const NAVY = '#0F2D5E', GREY = '#999999';   // DESIGN.md section 11: navy main series, grey for comparison
const bar = (rows, max, color = NAVY) => `<table class="bars">${rows.map((r) => `<tr><td class="bl">${r.label}</td><td class="bb"><div style="width:${Math.max(2, Math.round((r.n / Math.max(1, max)) * 100))}%;background:${r.color || color};"></div></td><td class="bn">${r.n}${r.extra ? ` <span>${r.extra}</span>` : ''}</td></tr>`).join('')}</table>`;
const panel = (title, body) => `<div class="panel"><div class="pt">${title}</div>${body}</div>`;
const sectorRows = (b.chart ? Object.entries(full).map(([k, v]) => ({ label: esc(SECTORS[k]), n: v.length, extra: (() => { const u = v.reduce((n, it) => n + (it.usd || 0), 0); return u ? (u >= 1e9 ? `US$${(u / 1e9).toFixed(1)}bn` : `US$${Math.round(u / 1e6)}m`) : ''; })() })) : []).sort((a, b2) => b2.n - a.n);
const stageColor = { S1: '#999999', S2: '#999999', S3: '#999999', S4: '#B26B00', S5: '#2E6B4F' };   // planned / tender / awarded markers
const ex1 = exhibit(1, `${esc(b.chartTitle || 'New projects this week')}`, `${plural(st.epc ?? 0, 'new project')} first seen ${fmtDay(b.from)} – ${fmtDay(b.to)}; same-name reports merged; contract value where the notice names one`,
  `<div class="grid4">
    ${panel('By sector', bar(sectorRows, Math.max(...sectorRows.map((r) => r.n), 1)))}
    ${panel('By region', bar((D.regions || []).filter((r) => r.name !== 'Unknown').map((r) => ({ label: esc(r.name), n: r.n })), Math.max(...(D.regions || []).map((r) => r.n), 1)))}
    ${panel('By stage', bar((D.stages || []).map((r) => ({ label: esc(r.label), n: r.n, color: stageColor[r.key] })), Math.max(...(D.stages || []).map((r) => r.n), 1)))}
    ${panel('Busiest countries', bar((D.countries || []).slice(0, 8).map((r) => ({ label: esc(r.name), n: r.n })), Math.max(...(D.countries || []).map((r) => r.n), 1)))}
  </div>`, `World Trade Pro project radar, ${fmtDay(b.from)} – ${fmtDay(b.to)}; official notices (EU TED, UK Find a Tender, World Bank) and trade press`);

const money = (usd) => (!usd ? '' : usd >= 1e9 ? `US$${(usd / 1e9).toFixed(1)}bn` : `US$${Math.round(usd / 1e6)}m`);
const topTable = `<table class="list top"><thead><tr><th>#</th><th>Contract</th><th>Stage</th><th>Country</th><th>Sector</th><th>Counterparty</th><th class="val">Value</th></tr></thead><tbody>
  ${(D.topDeals || []).map((d, i) => `<tr><td class="num">${i + 1}</td><td><a href="${esc(d.url)}">${esc(d.name.length > 70 ? d.name.slice(0, 68).replace(/\s+\S*$/, '') + '…' : d.name)}</a></td><td class="${d.tender ? 'st-S4' : 'st-S5'}">${d.tender ? 'Tender' : 'Awarded'}</td><td>${esc(d.country)}</td><td>${esc(d.sector)}</td><td>${d.who ? `<span class="sub">${d.tender ? 'buyer' : 'won by'}</span> ${esc(d.who.length > 44 ? d.who.slice(0, 42).replace(/\s+\S*$/, '') + '…' : d.who)}` : ''}</td><td class="val">${esc(d.value)}</td></tr>`).join('')}
  </tbody></table>`;
const ex2 = exhibit(2, `${money(D.totalUsd) ? `${money(D.totalUsd)} of named contract value this week; ` : ''}the ten largest tenders and awards`, 'Ranked by the value stated in the notice. Awards are reference prices for buyers and a buying contractor for suppliers; tenders are open windows for bidders.',
  topTable, 'as Exhibit 1; values as stated in the notice, converted to US$ by the source');
const ex3 = b.calendar ? exhibit(3, `${b.calendarCount || ''} bid deadlines in the next 14 days`.trim(), 'Tender notices that state a closing date, soonest first. Red = due within three days.', `<div class="two"><div class="cal">${em(b.calendar)}</div><div>${panel('By stage', bar((D.stages || []).map((r) => ({ label: esc(r.label), n: r.n, color: stageColor[r.key] })), Math.max(...(D.stages || []).map((r) => r.n), 1)))}</div></div>`, 'tender notices with a stated deadline') : '';
const secTables = SECTOR_ORDER.filter((k) => (full[k] || []).length).map((k) => `<div class="sec-block"><h3>${esc(SECTORS[k])} <span>${full[k].length}</span></h3>
  <table class="list"><thead><tr><th>Project</th><th>Stage</th><th>Country</th><th>Scale</th><th>Company</th><th class="val">Value</th></tr></thead><tbody>
  ${full[k].map((it) => `<tr><td><a href="${esc(it.url)}">${esc(it.name)}</a>${it.sub ? `<div class="sub">${esc(it.sub)}</div>` : ''}</td><td class="st-${esc(it.stageKey)}">${esc(it.stage)}${it.deadline ? `<div class="sub">bids due ${esc(it.deadline)}</div>` : ''}</td><td>${esc(noFlag(it.country))}</td><td>${esc(it.scale)}</td><td>${esc(it.company.length > 40 ? it.company.slice(0, 38).replace(/\s+\S*$/, '') + '…' : it.company)}</td><td class="val">${esc(it.value || '')}</td></tr>`).join('')}
  </tbody></table></div>`).join('');
const exProjects = `<section class="page flow">${ph(`All ${total} new projects, by sector`)}
  <div class="ex-s">First seen ${fmtDay(b.from)} – ${fmtDay(b.to)}. Same-name reports merged. Each project name links to the source notice or report.</div>
  ${secTables}
  <div class="src">Source: World Trade Pro project radar; official notices and trade press as linked</div></section>`;

const laneRows = (D.lanes || []).filter((l) => l.n).map((l) => ({ label: esc(l.name), n: l.n, color: l.status === 'High' ? '#B4412E' : NAVY, extra: `${l.status}${l.p > l.pp ? ' <em class="dn">▲ rising</em>' : l.p < l.pp ? ' <em class="up">▼ easing</em>' : ''}` }));
const exFlows = exhibit(4, `${plural(st.flow ?? 0, 'trade-flow signal')} this week, ${st.critical ?? 0} of them critical${laneRows[0] ? `; ${laneRows[0].label} under the most pressure` : ''}`, 'Signals by market and pressure on the nine main shipping lanes (critical ×3, elevated ×2, watch ×1), then the stories that moved and what they mean',
  `<div class="grid4 g2"><div>${panel('Signals by market', bar((D.flowSectors || []).map((r) => ({ label: esc(r.name), n: r.n })), Math.max(...(D.flowSectors || []).map((r) => r.n), 1)))}${panel('Lane pressure', bar(laneRows, Math.max(...laneRows.map((r) => r.n), 1)))}</div><div class="flowlist">${em((b.flows?.items || []).slice(0, 3).map((f) => f.html).join(''))}</div></div>`, 'World Trade Pro trade-flow radar; stories as linked');

const back = `<section class="page back">
  ${ph('World Trade Pro Weekly')}
  <h2 class="ex-t">Three ways to get this every week</h2>
  <div class="three">
    <div><div class="lab">1 · Tuesday e-mail</div><p>A five-minute preview: the week's judgement, the headline numbers and the largest contracts, the same issue for every reader.</p></div>
    <div><div class="lab">2 · The full issue online</div><p>Every new project of the week by sector, the deals, the bid calendar, the flows; one page per issue, always there.</p></div>
    <div><div class="lab">3 · This PDF report</div><p>The issue as a report: one exhibit per page, sources under every chart. Forward it, print it, bring it to Monday's meeting.</p></div>
  </div>
  <div class="cta"><b>${esc(cfg.site.replace(/^https?:\/\//, ''))}/subscribe/</b> <span>Free, one e-mail a week, every Tuesday.</span></div>
  <div class="cta2">Supply equipment, materials or services to projects? See which ones need your product, free preview: <b>${esc(cfg.site.replace(/^https?:\/\//, ''))}/project-leads/</b></div>
  <div class="src">© ${b.year} World Trade Pro. Data from public notices and trade press, linked in each entry; no guarantee of completeness. Sponsorship: contact@worldtradepro.com</div>
</section>`;

const css = `
@page { size: A4 landscape; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "IBM Plex Sans", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1A1A1A; font-size: 15px; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.serif, h1, h2, h3, .lede, .cv-big .n, .keys b, table.list td a, .toc ol b, .cta b { font-family: Newsreader, Georgia, "Times New Roman", serif; font-weight: 400; }
.page { width: 297mm; min-height: 210mm; padding: 36px 56px 52px; page-break-after: always; position: relative; background: #fff; }
.page.flow { min-height: auto; }
.page:last-child { page-break-after: auto; }
a { color: #000; text-decoration: none; }
.up { color: #2E6B4F; } .dn { color: #B4412E; } .eq { color: #555; } em.up, em.dn { font-style: normal; }
/* kicker: the one ornament, a 28x2 black rule over 13px sentence-case Plex 600 */
.kick { font-size: 13px; font-weight: 600; color: #000; } .kick::before { content: ""; display: block; width: 28px; height: 2px; background: #000; margin-bottom: 8px; }
.lab { font-size: 13px; font-weight: 600; color: #000; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
.ph { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 1px solid #CCC; padding-bottom: 8px; margin-bottom: 16px; } .ph .pn { font-family: "IBM Plex Mono", Consolas, monospace; font-size: 13px; color: #555; }
/* cover: white page, text left, the licensed photo as the right half, key numbers row along the bottom */
.cover { display: grid; grid-template-columns: 1.25fr 1fr; grid-template-rows: 1fr auto auto; column-gap: 48px; padding: 0 0 32px 56px; }
.cv-l { padding-top: 48px; } .logo { height: 28px; display: block; margin-bottom: 40px; }
.cover h1 { font-size: 60px; line-height: 1.05; letter-spacing: -1px; margin: 8px 0 16px; color: #000; }
.cover .dek { font-family: Newsreader, Georgia, serif; font-size: 21px; line-height: 1.35; color: #1A1A1A; max-width: 560px; }
.cover .date { font-family: "IBM Plex Mono", Consolas, monospace; font-size: 13px; color: #555; margin-top: 8px; }
.cv-big { margin-top: 24px; } .cv-big .l { font-size: 13px; color: #555; } .cv-big .n { font-size: 40px; line-height: 1.1; color: #000; white-space: nowrap; } .cv-big .w { font-size: 13px; color: #555; max-width: 560px; }
.cv-spon { margin-top: 16px; font-size: 13px; color: #555; } .cv-spon b { color: #000; font-weight: 600; }
.cv-r { grid-row: 1 / 2; grid-column: 2; background-size: cover; background-position: center; min-height: 100%; }
.keys { grid-column: 1 / 3; display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid #000; border-bottom: 1px solid #000; margin: 24px 56px 0 0; }
.keys div { padding: 12px 16px; border-left: 1px solid #CCC; } .keys div:first-child { border-left: 0; padding-left: 0; }
.keys span { display: block; font-size: 13px; color: #555; } .keys b { display: block; font-size: 40px; line-height: 1.1; color: #000; white-space: nowrap; } .keys i { display: block; font-style: normal; font-size: 13px; margin-top: 2px; }
.cv-foot { grid-column: 1 / 3; margin: 8px 56px 0 0; font-size: 12px; color: #555; }
/* page 2 */
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: start; }
.lede { font-size: 21px; line-height: 1.45; color: #1A1A1A; margin-top: 16px; } .lede a { color: #0F2D5E; text-decoration: underline; } .sig { color: #555; font-size: 13px; margin-top: 16px; }
.toc ol { list-style: none; margin: 0; padding: 0; } .toc ol li { display: flex; gap: 16px; padding: 10px 0; border-top: 1px solid #CCC; } .toc ol li:first-child { border-top: 0; }
.toc .no { font-family: "IBM Plex Mono", Consolas, monospace; font-size: 13px; color: #555; padding-top: 4px; } .toc ol li b { font-size: 21px; line-height: 1.25; color: #000; display: block; } .toc ol li div > span { display: block; font-size: 13px; color: #555; }
.open { margin: 0; padding: 0; list-style: none; font-size: 15px; color: #1A1A1A; } .open li { padding: 8px 0; border-top: 1px solid #CCC; } .open li:first-child { border-top: 0; } .open b { font-weight: 600; color: #000; }
/* exhibits */
.ex-t { font-size: 30px; line-height: 1.15; color: #000; margin: 0 0 4px; letter-spacing: -0.3px; } .ex-s { font-size: 15px; color: #555; margin-bottom: 12px; max-width: 900px; }
.ex-b { margin-top: 4px; }
.src { position: absolute; bottom: 20px; left: 56px; right: 56px; font-size: 12px; color: #555; border-top: 1px solid #CCC; padding-top: 6px; }
.page.flow .src { position: static; margin-top: 48px; }
.em { width: 100%; } .em td { font-family: inherit; }
.grid4 { display: grid; grid-template-columns: 1fr 1fr; gap: 32px 48px; } .grid4.g2 { grid-template-columns: 1fr 1.25fr; }
.panel { break-inside: avoid; } .panel + .panel { margin-top: 24px; } .grid4 > .panel + .panel { margin-top: 0; }
.pt { font-size: 13px; font-weight: 600; color: #000; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 4px; }
table.bars { width: 100%; border-collapse: collapse; font-size: 13px; } table.bars td { padding: 4px 0; border-top: 1px solid #CCC; } table.bars tr:first-child td { border-top: 0; }
.bl { width: 38%; color: #1A1A1A; padding-right: 8px !important; } .bb div { height: 10px; } .bn { width: 26%; padding-left: 8px !important; color: #000; white-space: nowrap; font-variant-numeric: tabular-nums; } .bn span { color: #555; font-size: 12px; }
table.top td.num { font-family: "IBM Plex Mono", Consolas, monospace; color: #555; width: 24px; }
.flowlist .em td { font-size: 13px; } .flowlist .em td[style*="16px 0"] { padding: 10px 0 !important; } .flowlist .em a.s { font-size: 17px !important; } .flowlist .em div { font-size: 13px !important; }
.cal .em td { font-size: 13px; }
h3 { font-size: 21px; line-height: 1.25; color: #000; border-top: 2px solid #000; padding-top: 8px; margin: 32px 0 8px; page-break-after: avoid; } h3 span { color: #555; font-family: "IBM Plex Mono", Consolas, monospace; font-size: 13px; margin-left: 8px; }
.sec-block:first-child h3 { margin-top: 0; }
/* the signature table: 13px Plex 600 header over a 2px black rule, hairline rows, no zebra, no vertical lines */
table.list { width: 100%; border-collapse: collapse; font-size: 13px; page-break-inside: auto; } table.list tr { page-break-inside: avoid; }
table.list th { text-align: left; font-size: 13px; font-weight: 600; color: #000; border-bottom: 2px solid #000; padding: 6px 8px 6px 0; }
table.list td { padding: 5px 8px 5px 0; border-bottom: 1px solid #CCC; vertical-align: top; color: #1A1A1A; } table.list td a { color: #000; font-size: 15px; line-height: 1.3; } .sub { font-size: 12px; color: #555; }
table.list .val, table.list th.val { text-align: right; padding-right: 0; }
.st-S1::before, .st-S2::before, .st-S3::before, .st-S4::before, .st-S5::before { content: "■"; font-size: 11px; margin-right: 6px; }
.st-S1::before, .st-S2::before, .st-S3::before { color: #999; } .st-S4::before { color: #B26B00; } .st-S5::before { color: #2E6B4F; }
.val { font-family: Newsreader, Georgia, serif; font-size: 17px; color: #000; white-space: nowrap; font-variant-numeric: tabular-nums; }
.back .three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 48px; margin-top: 32px; } .back p { font-size: 15px; margin: 8px 0 0; }
.cta { margin-top: 64px; font-size: 15px; color: #555; } .cta b { display: block; font-size: 30px; color: #000; margin-bottom: 4px; } .cta2 { margin-top: 24px; font-size: 15px; color: #1A1A1A; } .cta2 b { font-weight: 600; color: #000; }
`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(PDFNAME)}</title><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=IBM+Plex+Sans:wght@400;600&family=Newsreader:opsz,wght@6..72,400&display=swap" rel="stylesheet"><style>${css}</style></head><body>${cover}${thisWeek}${ex1}${ex2}${ex3}${exProjects}${exFlows}${back}</body></html>`;
writeFileSync(join(OUT, 'report.html'), html);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1123, height: 794 } });
await page.goto(pathToFileURL(join(OUT, 'report.html')).href, { waitUntil: 'networkidle' }).catch(() => {});   // offline: fallback fonts
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.pdf({ path: join(OUT, `${PDFNAME}.pdf`), format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
await page.locator('.cover').screenshot({ path: join(OUT, 'cover.jpg'), type: 'jpeg', quality: 88 });
const pages = await page.locator('.page').count();   // every A4 sheet is one fixed-height .page div (cover and back page included)
await browser.close();
const kb = (readFileSync(join(OUT, `${PDFNAME}.pdf`)).length / 1024).toFixed(0);
// pages + kb are read by weekly_web.mjs for the "PDF report · N pages" buttons on the web issue
writeFileSync(join(OUT, 'pdf.json'), JSON.stringify({ file: `${PDFNAME}.pdf`, name: PDFNAME, cover: 'cover.jpg', slug: b.slug, kb: Number(kb), pages }, null, 2));
console.log(`PDF report: newsletter/out/${NAME}/${PDFNAME}.pdf (${kb} KB, ${pages} pages), cover.jpg`);
