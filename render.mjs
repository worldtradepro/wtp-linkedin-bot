// Turns the day's queue JSON into finished posts: for each post it opens the SOURCE article,
//   1. dismisses the cookie / consent pop-up (prefers "Reject"),
//   2. reads the article's first sentences and uses them as the post's description,
//   3. screenshots the headline area as the post image;
// when the page is blocked (paywall, bot wall, wrong page) it falls back to an own-design card.
//
// Usage:  node render.mjs [--date YYYY-MM-DD] [--only main-1]

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { stockPhoto } from './stock_photo.mjs';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const DATE = val('--date') || new Date().toISOString().slice(0, 10);
const ONLY = val('--only');
const DIR = join(HERE, 'queue', DATE);
const IMG = join(DIR, 'images');
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const MAX_EXCERPT = 850;
// Images used in the last 30 days (URL without query + content hash): some outlets put the same file photo on every story
// about a topic (2026-09-26: two Saudi pipeline posts in a row with one oilprice.com picture) -> a repeat goes to the stock-photo fallback.
const IMG_STATE = join(HERE, 'state', 'images_used.json');
const imgUsed = (existsSync(IMG_STATE) ? JSON.parse(readFileSync(IMG_STATE, 'utf8')).items || [] : [])
  .filter((x) => x.date >= new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
const imgKey = (u) => (u || '').replace(/[?#].*$/, '');
const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');
const imgSeen = (url, buf) => imgUsed.find((x) => (url && x.url === imgKey(url)) || (buf && x.hash === sha1(buf)));
const W = 1200, H = 760, FH = 800;

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const STOP = new Set('the and for with from that this into over amid after their than have will says said its are was has new more your'.split(' '));
const toks = (s) => new Set(clean(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 3 && !STOP.has(w)));
const overlap = (a, b) => { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };

// ---------------------------------------------------------------- page handling
const REJECT = /^(reject all|reject|decline|deny|refuse|only necessary|necessary only|use necessary cookies only|continue without accepting|disagree|no thanks)$/i;
const ACCEPT = /^(accept all|accept|agree|i agree|got it|ok|okay|allow all|continue)$/i;

async function dismissConsent(page) {
  for (const re of [REJECT, ACCEPT]) {          // privacy-preserving choice first, "accept" only if there is no way to reject
    for (const frame of page.frames()) {
      try {
        const btn = frame.getByRole('button', { name: re }).first();
        if (await btn.isVisible({ timeout: 400 })) { await btn.click({ timeout: 1500 }); await page.waitForTimeout(700); return true; }
      } catch { /* try the next frame / pattern */ }
    }
  }
  return false;
}

async function clearOverlays(page) {
  await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const headings = [...document.querySelectorAll('h1, h2')];
    // Never hide <html>/<body> or anything that CONTAINS the headline (e.g. <body class="modal-open"> or a page wrapper).
    const protectedEl = (el) => el === document.body || el === document.documentElement || headings.some((h) => el.contains(h));
    const kill = (el) => { if (!protectedEl(el)) el.style.setProperty('display', 'none', 'important'); };
    document.querySelectorAll('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="onetrust" i],[id^="sp_message"],[class*="gdpr" i],[id*="gdpr" i],[class*="newsletter-pop" i],[class*="modal" i],[class*="popup" i],[class*="paywall" i],[id*="paywall" i]').forEach(kill);
    document.querySelectorAll('*').forEach((el) => {
      if (protectedEl(el)) return;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
      const r = el.getBoundingClientRect();
      const big = r.width > innerWidth * 0.5 && r.height > innerHeight * 0.2;
      if (big || (parseInt(cs.zIndex, 10) || 0) >= 1000) kill(el);
    });
    for (const el of [document.documentElement, document.body]) { el.style.setProperty('overflow', 'auto', 'important'); el.style.setProperty('position', 'static', 'important'); }
    window.scrollTo(0, 0);
  });
}

async function readArticle(page, headline) {
  return page.evaluate((headline) => {
    const words = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 3));
    const ov = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
    const meta = (n) => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content || '';
    // the heading that actually matches the story (some sites' first <h1> is just the section name, e.g. "News")
    const h1 = [...document.querySelectorAll('h1, h2')].map((h) => ({ h, o: ov(h.innerText || '', headline) })).filter((x) => x.o >= 0.5).sort((a, b) => b.o - a.o)[0]?.h || document.querySelector('h1');
    const r = h1 ? h1.getBoundingClientRect() : null;
    const bad = /cookie|subscribe|sign up|sign in|log in|newsletter|copyright|all rights reserved|privacy policy|advertis|follow us|read more|share this/i;
    // Real article body only: after the headline, and not inside author boxes / sidebars / footers / disclaimers / captions.
    // (kept narrow on purpose: page builders put words like "widget" on the article body itself)
    const junkBox = '[class*="author-" i],[class*="-author" i],[class*="authorbox" i],[class*="author_" i],[class*="byline" i],[class*="sidebar" i],[class*="related-" i],[class*="comments" i],[class*="disclaimer" i],[class*="site-footer" i],aside,footer,nav,figcaption';
    const junkText = /enquiries|initial publication|what i cover|for nearly a decade|about the author|all rights|click here|read more|photo:|image:|credit:/i;
    const okP = (p) => {
      const t = (p.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length <= 70 || bad.test(t) || junkText.test(t) || /(…|\.\.\.)$/.test(t)) return false;
      const jb = p.closest(junkBox);
      if (jb && !(h1 && jb.contains(h1))) return false;   // an author box / sidebar / footer - but not a wrapper that holds the whole article
      return !h1 || !!(h1.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const paras = [...document.querySelectorAll('article p, main p, [itemprop="articleBody"] p, [class*="article" i] p, [class*="content" i] p, [class*="post" i] p')]
      .filter(okP)
      .map((p) => (p.innerText || '').replace(/\s+/g, ' ').trim());
    const uniq = [...new Set(paras)].slice(0, 8);
    const center = document.elementFromPoint(innerWidth / 2, Math.min(300, innerHeight / 2));
    const cover = center ? `${center.id} ${center.className}` : '';
    // Region worth screenshotting: headline + the first real paragraph + a large picture just below them (if any).
    const abs = (el) => { const b = el.getBoundingClientRect(); return { l: b.left + scrollX, t: b.top + scrollY, r: b.right + scrollX, b: b.bottom + scrollY, w: b.width, h: b.height }; };
    const boxes = [];
    if (h1) boxes.push(abs(h1));
    const firstP = [...document.querySelectorAll('article p, main p, [itemprop="articleBody"] p, [class*="article" i] p, [class*="content" i] p')].find(okP);
    if (firstP && h1) { const b = abs(firstP); if (b.t >= boxes[0].t && b.t - boxes[0].b < 500) boxes.push(b); }
    // no usable lede found: still take the byline / date line under the headline
    if (h1 && boxes.length === 1) boxes.push({ l: boxes[0].l, r: boxes[0].r, t: boxes[0].t, b: boxes[0].b + 120, w: boxes[0].w, h: 120 });
    const boxesNoHero = boxes.slice();
    if (h1) {
      const top0 = boxes[0].t;
      const hero = [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth >= 300 && getComputedStyle(i).visibility !== 'hidden' && !i.closest('[class*="advert" i],[class*="sponsor" i],[id*="google_ads" i],[class*="banner" i]')).map(abs).filter((b) => b.w >= 420 && b.h >= 200 && b.t >= top0 - 20 && b.t - top0 < 700).sort((a, b) => a.t - b.t)[0];
      if (hero) boxes.push(hero);
    }
    const region = boxes.length ? {
      l: Math.min(...boxes.map((b) => b.l)), t: Math.min(...boxes.map((b) => b.t)),
      r: Math.max(...boxes.map((b) => b.r)), b: Math.max(...boxes.map((b) => b.b)),
    } : null;
    const unionOf = (bs) => bs.length ? { l: Math.min(...bs.map((b) => b.l)), t: Math.min(...bs.map((b) => b.t)), r: Math.max(...bs.map((b) => b.r)), b: Math.max(...bs.map((b) => b.b)) } : null;
    return {
      region, regionNoHero: unionOf(boxesNoHero),
      // last resort when the page paints its picture badly: just the headline and the byline line under it
      regionHeadOnly: h1 ? { l: abs(h1).l, t: abs(h1).t, r: abs(h1).r, b: abs(h1).b + 110 } : null,
      visibleChars: (document.body.innerText || '').length,
      h1: h1 ? h1.innerText.replace(/\s+/g, ' ').trim() : '',
      h1Top: r ? r.top + window.scrollY : 0,
      ogTitle: meta('og:title'), ogDesc: meta('og:description') || meta('description'),
      paras: uniq, cover: String(cover), bodyStart: (document.body.innerText || '').slice(0, 400),
    };
  }, headline);
}

function excerptOf(info, headline) {
  const sentencesOf = (t) => clean(t).match(/[^.!?]+[.!?]+(?=\s|$)/g) || [];
  // A clean opening sentence: whole, not a fragment of a quotation, not an update note, not just the headline again.
  // strip section labels that sites glue onto the first sentence ("Operational Overview Saudi Arabia ..."), and refuse fragments (must start with a capital letter)
  const unlabel = (s) => clean(s).replace(/^(operational overview|overview|summary|key points|highlights|background|breaking)\s*[:\-–—]?\s+/i, '');
  // never let a cookie / consent / ad-blocker / subscription banner leak into a post ("we and our partners process personal data ...")
  const BANNER = /personal data|legitimate interest|display ads|consent|cookies?\b|privacy|advertis|tracking|third[- ]party|partners? process|subscribe|subscription|sign in|log in|your browser|javascript|ad[- ]?block/i;
  const goodSentence = (s) => { const t = unlabel(s); return t.length > 40 && /^[A-Z]/.test(t) && !/^(update|correction|editor)/i.test(t) && !BANNER.test(t) && overlap(t, headline) < 0.8; };
  const parts = [];
  // 1st choice: the publisher's own summary line (og:description) - it is written to stand alone.
  if (info.ogDesc) for (const s of sentencesOf(info.ogDesc)) if (goodSentence(s)) parts.push(unlabel(s));
  // then the first clean sentences of the body text that add something new (not a restatement of what is already there)
  for (const p of info.paras) for (const s of sentencesOf(p)) {
    if (goodSentence(s) && !parts.some((x) => overlap(x, s) >= 0.4)) parts.push(unlabel(s));
    if (parts.join(' ').length >= 640) break;
  }
  let picked = [], total = 0;
  for (const s of parts) { if (total + s.length + 1 > MAX_EXCERPT) break; picked.push(s); total += s.length + 1; if (total >= 560) break; }
  // paragraphs like the friend's posts: start a new paragraph once the current one has ~200 characters
  const paras = []; let cur = [];
  for (const s of picked) { cur.push(s); if (cur.join(' ').length >= 200) { paras.push(cur.join(' ')); cur = []; } }
  if (cur.length) paras.push(cur.join(' '));
  const out = paras.join('\n\n');
  return out;
}

function frameHtml(dataUrl, p) {
  return `<html><body style="margin:0;width:${W}px;height:${FH}px;background:linear-gradient(180deg,#0b1a33,#13294d);font-family:Segoe UI,Arial,sans-serif;position:relative;overflow:hidden">
  <div style="position:absolute;left:60px;right:60px;top:36px;bottom:92px;display:flex;align-items:center;justify-content:center">
    <img src="${dataUrl}" style="min-width:72%;max-width:100%;max-height:100%;object-fit:contain;border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.45);background:#fff"></div>
  <div style="position:absolute;left:60px;right:60px;bottom:26px;display:flex;justify-content:space-between;align-items:baseline;color:#9fb4d0;font-size:26px;font-weight:600">
    <span>Source: <b style="color:#fff">${esc(p.sourceName || '')}</b></span><b style="color:#e0a84a;font-size:30px">worldtradepro.com</b></div></body></html>`;
}
// ---------------------------------------------------------------- fallback card
const SECTOR_COLOR = { Energy: '#e0a84a', Shipping: '#4a90e0', Metals: '#c94ae0', 'Mining & Metals': '#9b8cd6', Agriculture: '#4fb286', Policy: '#6b7fd6', 'Logistics & Infrastructure': '#4fb286' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function cardHtml(p) {
  const color = SECTOR_COLOR[p.meta?.sector] || '#e0a84a';
  const kicker = p.type === 'project' ? `New project · ${p.meta?.sector || ''}` : `Trade Flow · ${p.meta?.sector || ''}`;
  const chips = p.type === 'project'
    ? [p.meta?.country, p.meta?.stage, p.meta?.scale && `Scale: ${p.meta.scale}`].filter(Boolean)
    : [(p.meta?.laneName || p.meta?.lane) && `Lane: ${p.meta.laneName || p.meta.lane}`, p.meta?.country].filter(Boolean);
  return `<html><body style="margin:0;width:${W}px;height:${H}px;background:linear-gradient(180deg,#0b1a33,#13294d);color:#fff;font-family:Segoe UI,Arial,sans-serif;position:relative;overflow:hidden">
  <div style="position:absolute;left:0;top:0;bottom:0;width:14px;background:${color}"></div>
  <div style="padding:64px 80px 0 90px">
    <div style="color:${color};font-weight:700;letter-spacing:.09em;text-transform:uppercase;font-size:24px">${esc(kicker)}</div>
    <div style="font-weight:800;font-size:58px;line-height:1.14;margin-top:26px">${esc(p.headline)}</div>
    <div style="margin-top:34px">${chips.map((c) => `<span style="display:inline-block;background:rgba(255,255,255,.1);border-radius:100px;padding:8px 22px;margin:0 12px 10px 0;font-size:24px;font-weight:600;color:#dbe5f5">${esc(c)}</span>`).join('')}</div>
  </div>
  <div style="position:absolute;left:90px;right:80px;bottom:44px;display:flex;justify-content:space-between;align-items:baseline;border-top:2px solid rgba(255,255,255,.14);padding-top:22px;color:#9fb4d0;font-size:26px;font-weight:600">
    <span>${esc(p.sourceName || '')}</span></div></body></html>`;
}

// ---------------------------------------------------------------- Infrastructure own-data cards (1080x1350)
// Flags are shown as ISO chips, not emoji: Windows Chrome has no flag-emoji font, Linux CI does, and a card must look the same everywhere.
const LOGO = 'data:image/png;base64,' + readFileSync(join(HERE, 'assets', 'logo_light.png')).toString('base64');
// Hand-drawn infrastructure skyline (refinery, port gantry crane + containers, wind turbines, pylon): original artwork, so no photo licence
// questions, and it renders identically on any machine. Kept very faint - it is a backdrop, the data stays the hero.
const turbineSvg = (x, base, top, L, rot, w) => {
  const blades = [0, 120, 240].map((a) => {
    const r = ((a + rot) * Math.PI) / 180, px = Math.cos(r) * 4, py = Math.sin(r) * 4;
    const tx = x + L * Math.sin(r), ty = top - L * Math.cos(r);
    return `<path d="M${(x + px).toFixed(1)} ${(top + py).toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)} L${(x - px).toFixed(1)} ${(top - py).toFixed(1)} Z"/>`;
  }).join('');
  return `<path d="M${x - w} ${base} L${x - w / 2} ${top} L${x + w / 2} ${top} L${x + w} ${base} Z"/><circle cx="${x}" cy="${top}" r="${w * 0.9}"/>${blades}`;
};
const containers = [[470, 470, '#4a90e0'], [514, 470, ''], [558, 470, ''], [602, 470, '#da313a'], [646, 470, ''], [690, 470, ''], [514, 440, ''], [558, 440, '#009a5a'], [602, 440, ''], [646, 440, ''], [558, 410, ''], [602, 410, '#4a90e0']]
  .map(([x, y, col]) => `<rect x="${x}" y="${y}" width="40" height="28" rx="2"${col ? ` fill="${col}" fill-opacity=".30"` : ''}/>`).join('');
// Scenes: one hand-drawn backdrop + accent colour per sector, so cards for different stories do not all look the same.
const g = (part, dx = 0) => '<g transform="translate(' + dx + ' 0)">' + part + '</g>';
const REF = '<g class="f"><rect x="20" y="432" width="112" height="68" rx="8"/><ellipse cx="76" cy="432" rx="56" ry="13"/><rect x="142" y="448" width="92" height="52" rx="7"/><ellipse cx="188" cy="448" rx="46" ry="11"/><rect x="252" y="262" width="42" height="238" rx="10"/><rect x="306" y="314" width="34" height="186" rx="8"/><rect x="352" y="232" width="46" height="268" rx="12"/><rect x="228" y="418" width="190" height="9"/><rect x="414" y="150" width="8" height="350"/></g><g class="s"><line x1="252" y1="300" x2="294" y2="300"/><line x1="252" y1="350" x2="294" y2="350"/><line x1="352" y1="280" x2="398" y2="280"/><line x1="352" y1="340" x2="398" y2="340"/><line x1="352" y1="400" x2="398" y2="400"/></g><path class="a" d="M418 146 C406 128 413 112 418 98 C425 114 432 128 418 146 Z"/>';
const PORT = '<g class="f"><path d="M510 500 L538 268 L556 268 L534 500 Z"/><path d="M604 500 L580 268 L598 268 L628 500 Z"/><rect x="530" y="258" width="76" height="14"/><rect x="440" y="246" width="350" height="12"/><path d="M556 258 L568 172 L580 258 Z"/><rect x="700" y="258" width="26" height="16"/>' + containers + '</g><g class="s"><line x1="568" y1="172" x2="790" y2="246"/><line x1="568" y1="172" x2="440" y2="246"/><line x1="713" y1="274" x2="713" y2="304"/></g><rect class="a" x="696" y="304" width="34" height="20" rx="2" style="fill-opacity:.32"/>';
const WIND = '<g class="f">' + turbineSvg(870, 500, 250, 120, 20, 7) + turbineSvg(1000, 500, 336, 78, 70, 5) + '</g>';
const PYLON = '<g class="f"><path d="M912 500 L934 300 L956 500 L946 500 L934 340 L922 500 Z"/><rect x="902" y="298" width="64" height="6"/><rect x="912" y="336" width="44" height="5"/><rect x="908" y="400" width="52" height="5"/></g><g class="s"><line x1="902" y1="301" x2="790" y2="330"/><line x1="966" y1="301" x2="1080" y2="330"/></g>';
const GROUND = '<rect class="f" x="0" y="500" width="1080" height="3"/>';
const SILOS = '<g class="f"><rect x="20" y="300" width="60" height="200" rx="6"/><ellipse cx="50" cy="300" rx="30" ry="9"/><rect x="92" y="262" width="60" height="238" rx="6"/><ellipse cx="122" cy="262" rx="30" ry="9"/><rect x="164" y="316" width="60" height="184" rx="6"/><ellipse cx="194" cy="316" rx="30" ry="9"/><rect x="236" y="280" width="66" height="220" rx="6"/><ellipse cx="269" cy="280" rx="33" ry="9"/><rect x="330" y="190" width="42" height="310"/><rect x="324" y="168" width="54" height="30" rx="4"/><path d="M400 500 L440 440 L480 500 Z"/><path d="M440 500 L490 428 L540 500 Z"/></g><g class="s"><line x1="336" y1="196" x2="60" y2="298"/><line x1="336" y1="206" x2="132" y2="262"/></g><rect class="a" x="326" y="172" width="12" height="10" style="fill-opacity:.5"/>';
const MINE = '<g class="f"><path d="M110 500 L182 190 L204 190 L276 500 L260 500 L193 250 L126 500 Z"/><rect x="290" y="410" width="90" height="90" rx="4"/><path d="M0 500 L60 396 L128 500 Z"/><path d="M300 500 L360 440 L430 500 Z"/><rect x="176" y="182" width="34" height="10"/></g><g class="s"><circle cx="193" cy="176" r="24"/><line x1="200" y1="176" x2="330" y2="410"/><line x1="186" y1="176" x2="290" y2="410"/></g><circle class="a" cx="193" cy="176" r="7" style="fill-opacity:.5"/>';
const bridgeCables = [0, 1, 2, 3, 4, 5].map((i) => '<line x1="148" y1="214" x2="' + (148 - 24 - i * 22) + '" y2="430"/><line x1="148" y1="214" x2="' + (148 + 24 + i * 22) + '" y2="430"/><line x1="368" y1="214" x2="' + (368 - 24 - i * 22) + '" y2="430"/><line x1="368" y1="214" x2="' + (368 + 24 + i * 22) + '" y2="430"/>').join('');
const BRIDGE = '<g class="f"><rect x="0" y="430" width="540" height="14"/><rect x="140" y="200" width="16" height="300"/><rect x="360" y="200" width="16" height="300"/></g><g class="s" style="stroke-width:2">' + bridgeCables + '</g><circle class="a" cx="148" cy="196" r="6" style="fill-opacity:.55"/><circle class="a" cx="368" cy="196" r="6" style="fill-opacity:.55"/>';
const CITY = '<g class="f"><rect x="20" y="320" width="60" height="180"/><rect x="90" y="256" width="52" height="244"/><rect x="152" y="350" width="70" height="150"/><rect x="232" y="296" width="56" height="204"/><rect x="300" y="450" width="170" height="50"/><rect x="316" y="410" width="138" height="40"/><path d="M308 410 L385 366 L462 410 Z"/><ellipse cx="385" cy="352" rx="46" ry="34"/><rect x="380" y="290" width="10" height="26"/></g><g class="s" style="stroke-width:2"><line x1="34" y1="350" x2="66" y2="350"/><line x1="34" y1="390" x2="66" y2="390"/><line x1="104" y1="290" x2="130" y2="290"/><line x1="104" y1="330" x2="130" y2="330"/><line x1="104" y1="370" x2="130" y2="370"/><line x1="344" y1="412" x2="344" y2="450"/><line x1="385" y1="412" x2="385" y2="450"/><line x1="426" y1="412" x2="426" y2="450"/></g><rect class="a" x="382" y="284" width="6" height="8" style="fill-opacity:.55"/>';
const SOLAR = '<g class="f">' + [0, 1, 2, 3, 4, 5].map((i) => '<path d="M' + i * 64 + ' 500 L' + (i * 64 + 34) + ' 452 L' + (i * 64 + 100) + ' 452 L' + (i * 64 + 66) + ' 500 Z"/>').join('') + '<rect x="0" y="496" width="420" height="6"/></g>';
const SHIP_C = [[150, 436], [196, 436], [242, 436], [288, 436], [334, 436], [380, 436], [196, 406], [242, 406], [288, 406], [334, 406], [242, 376], [288, 376]].map(([x, y], i) => '<rect x="' + x + '" y="' + y + '" width="42" height="28" rx="2"' + (i % 5 === 0 ? ' style="fill:' + ['#4a90e0', '#da313a', '#009a5a'][i % 3] + ';fill-opacity:.3"' : '') + '/>').join('');
const SHIP = '<g class="f"><path d="M0 468 L520 468 L488 500 L44 500 Z"/><rect x="34" y="404" width="76" height="64"/><rect x="48" y="380" width="46" height="24"/><rect x="60" y="356" width="14" height="24"/>' + SHIP_C + '</g>';
const SCENES = {
  default: () => g(REF) + g(PORT) + g(WIND) + g(PYLON) + GROUND,
  energy: () => g(REF) + g(REF, 540) + g(PYLON, -300) + GROUND,
  shipping: () => g(PORT, -440) + g(SHIP, 500) + GROUND,
  renewables: () => g(WIND, -800) + g(SOLAR, 300) + g(WIND, 0) + g(PYLON, -200) + GROUND,
  mining: () => g(MINE) + g(MINE, 640) + g(PYLON, -300) + GROUND,
  agriculture: () => g(SILOS) + g(SILOS, 570) + GROUND,
  policy: () => g(CITY) + g(CITY, 560) + GROUND,
  logistics: () => g(BRIDGE) + g(PORT, 130) + GROUND,
};
const ACCENT = { default: '#e0a84a', energy: '#e0a84a', shipping: '#4a90e0', renewables: '#4fb286', mining: '#9b8cd6', agriculture: '#a3c94a', policy: '#6b7fd6', logistics: '#3fb6c9' };
function sceneKey(sector, subsector) {
  const sec = (sector || '').toLowerCase(), t = sec + ' ' + (subsector || '').toLowerCase();
  if (/renewable|solar|wind|battery|storage|hydro/.test(t) && !/ship/.test(sec)) return 'renewables';
  if (/ship|tanker|maritime|container/.test(sec)) return 'shipping';
  if (/energy|oil|gas|lng|power/.test(sec)) return 'energy';
  if (/metal|mining|mine/.test(sec)) return 'mining';
  if (/agri|food|grain/.test(sec)) return 'agriculture';
  if (/polic|govern|tariff|sanction/.test(sec)) return 'policy';
  if (/logistic|infrastructure|transport|rail|port/.test(sec)) return 'logistics';
  return 'default';
}
const sceneSvg = (key) => '<svg viewBox="0 0 1080 520" xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:0;bottom:104px;width:1080px;height:520px;transform:scale(.84);transform-origin:50% 100%;-webkit-mask-image:linear-gradient(to top,#000 50%,transparent 100%)">' + (SCENES[key] || SCENES.default)() + '</svg>';
function infraCardHtml(c) {
  const key = c.scene || 'default';
  const css = `<style>*{box-sizing:border-box}
  body{margin:0;width:1080px;height:1350px;color:#fff;font-family:Segoe UI,Arial,sans-serif;position:relative;overflow:hidden;
    background:radial-gradient(900px 620px at 92% 8%,rgba(74,144,224,.22),transparent 70%),radial-gradient(700px 520px at 0% 100%,color-mix(in srgb,var(--acc) 16%,transparent),transparent 70%),
      linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px) 0 0/54px 54px,linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px) 0 0/54px 54px,linear-gradient(180deg,#0a1830,#132a50)}
  .brandbar{position:absolute;left:0;top:0;width:1080px;height:8px;background:linear-gradient(90deg,#2563be 0 33.3%,#da313a 33.3% 66.6%,#009a5a 66.6%)}
  .hd,h1,.sub,.body,.ft{z-index:2}
  h1{text-shadow:0 2px 18px rgba(0,0,0,.35)}
  .hd{position:absolute;left:60px;right:60px;top:40px;display:flex;justify-content:space-between;align-items:center}
  .f{fill:#cfe0ff;fill-opacity:.11}.s{stroke:#cfe0ff;stroke-opacity:.13;stroke-width:3;fill:none}.a{fill:var(--acc);fill-opacity:.42}
  .hd img{height:84px}.hd b{color:var(--acc);font-size:22px;letter-spacing:.14em}
  h1{position:absolute;left:60px;top:150px;margin:0;font-size:60px;font-weight:800}
  .sub{position:absolute;left:60px;top:232px;font-size:28px;font-weight:600;color:#9fb4d0}
  .body{position:absolute;left:60px;right:60px;top:300px;bottom:112px}
  .h{color:#9fb4d0;font-weight:700;font-size:22px;letter-spacing:.1em;margin:0 0 16px}
  .iso{display:inline-block;min-width:60px;text-align:center;background:rgba(255,255,255,.12);border-radius:10px;padding:5px 10px;font-size:22px;font-weight:800;color:#dbe5f5}
  .clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .ft{position:absolute;left:60px;right:60px;bottom:32px;border-top:2px solid rgba(255,255,255,.14);padding-top:22px;display:flex;justify-content:space-between;align-items:baseline;color:#9fb4d0;font-size:24px;font-weight:600}
  .ft b{color:#e0a84a;font-size:30px;font-weight:800}
  .row{background:rgba(255,255,255,.06);border-radius:16px;margin-bottom:18px;padding:22px 26px;border-left:10px solid #e0a84a}
  .rn{font-size:35px;font-weight:800;line-height:1.18;margin-top:12px}.rm{font-size:24px;color:#9fb4d0;margin-top:10px}
  .body{text-shadow:0 1px 10px rgba(8,20,42,.85)}
  .more{border:2px dashed rgba(224,168,74,.55);border-radius:16px;padding:22px 26px;margin-top:6px;background:rgba(10,24,48,.92)}
  .more b{display:block;color:#e0a84a;font-size:40px;font-weight:800}.more span{font-size:24px;color:#cfd9ea}
  .kpis{display:flex;gap:18px;margin-bottom:26px}.kpi{flex:1;background:rgba(255,255,255,.06);border-radius:16px;padding:20px 24px}
  .kpi b{display:block;font-size:66px;font-weight:800;line-height:1}.kpi span{font-size:24px;color:#9fb4d0;font-weight:600}
  .cols{display:flex;gap:36px;margin-bottom:24px}.col{flex:1}
  .bar{margin-bottom:14px}.bl{display:flex;justify-content:space-between;font-size:24px;font-weight:600;color:#dbe5f5;margin-bottom:5px}
  .bt{height:14px;border-radius:7px;background:rgba(255,255,255,.1)}.bt i{display:block;height:14px;border-radius:7px}
  .lg{margin-bottom:14px;font-size:27px;font-weight:700;line-height:1.2}.lg small{display:block;font-size:22px;color:#9fb4d0;font-weight:600;margin-top:4px}
  </style>`;
  const head = `<div class="hd"><img src="${LOGO}"><b>${esc(c.tag || 'INFRASTRUCTURE')}</b></div><h1>${esc(c.title)}</h1><div class="sub">${esc(c.sub)}</div>`;
  const foot = `<div class="ft"><span>${esc(c.footer || 'Early project leads for BD teams')}</span><b>worldtradepro.com</b></div>`;
  let body = '';
  if (c.kind === 'daily') {
    body = `<div class="h">${esc(c.heading)}</div>` + c.rows.map((r) =>
      `<div class="row" style="border-left-color:${SECTOR_COLOR[r.sector] || '#e0a84a'}"><span class="iso">${esc(r.iso || 'GLOBAL')}</span><div class="rn clamp">${esc(r.name)}</div><div class="rm">${esc(r.meta)}</div></div>`).join('')
      + (c.restText ? `<div class="more"><b>${esc(c.restText)}</b><span>${esc(c.restSub)}</span></div>` : '');
  } else if (c.kind === 'project' || c.kind === 'news') {
    body = `<div class="h">${esc(c.label || 'NEW PROJECT LEAD')}</div>
      <div style="font-size:66px;font-weight:800;line-height:1.12;margin:18px 0 34px">${esc(c.name.length > 120 ? c.name.slice(0, 119) + '…' : c.name)}</div>
      <div>${c.chips.map((t) => `<span style="display:inline-block;background:rgba(255,255,255,.1);border-radius:100px;padding:10px 28px;margin:0 14px 14px 0;font-size:30px;font-weight:600;color:#dbe5f5">${esc(t)}</span>`).join('')}</div>
      ${c.source ? `<div class="rm" style="font-size:26px;margin-top:22px">Source: ${esc(c.source)}</div>` : ''}`;
  } else {
    const max = (a) => Math.max(1, ...a.map((x) => x.n));
    const bars = (a, color, label) => a.map((x) => `<div class="bar"><div class="bl"><span>${label(x)}</span><span>${x.n}</span></div><div class="bt"><i style="width:${Math.round((x.n / max(a)) * 100)}%;background:${color}"></i></div></div>`).join('');
    body = `<div class="kpis">${c.kpis.map((k) => `<div class="kpi"><b>${k.n}</b><span>${esc(k.label)}</span></div>`).join('')}</div>
      <div class="cols"><div class="col"><div class="h">BY SECTOR</div>${bars(c.sectors, '#e0a84a', (x) => esc(x.name))}</div>
      <div class="col"><div class="h">TOP COUNTRIES</div>${bars(c.countries, '#4a90e0', (x) => `<span class="iso" style="min-width:46px;padding:2px 8px;font-size:19px;margin-right:10px">${esc(x.iso)}</span>${esc(x.name)}`)}</div></div>
      <div class="h">LARGEST PROJECTS</div>${c.largest.map((x) => `<div class="lg"><span class="iso" style="min-width:46px;padding:2px 8px;font-size:19px;margin-right:10px">${esc(x.iso || 'GL')}</span>${esc(x.name.length > 90 ? x.name.slice(0, 89) + '…' : x.name)}<small>${esc(x.meta)}</small></div>`).join('')}`;
  }
  return `<html><body style="--acc:${ACCENT[key] || ACCENT.default}">${css}<div class="brandbar"></div>${sceneSvg(key)}${head}<div class="body">${body}</div>${foot}</body></html>`;
}

// ---------------------------------------------------------------- lead photo (what the friend's posts use)
// The article's own lead picture (og:image / biggest picture in the article), downloaded and normalised to JPEG. Rejected: logos, tiny or oddly shaped
// pictures, the publisher's generic share banner (= its homepage og:image) and flat / few-colour graphics. Nothing usable -> the caller draws its own themed card.
const BAD_IMG = /logo|placeholder|default|fallback|favicon|sprite|brand|avatar|icon|social[-_]?(share|image)|share[-_]?image|og[-_]?image|blank|spacer/i;
async function leadPhoto(page) {
  const cands = await page.evaluate(() => {
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
    const meta = (n) => abs(document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]')?.content || '');
    const out = [meta('og:image'), meta('og:image:url'), meta('twitter:image')];
    const imgs = [...document.querySelectorAll('article img, main img, [class*="article" i] img')]
      .filter((i) => i.complete && i.naturalWidth >= 600 && !i.closest('[class*="advert" i],[class*="sponsor" i],[id*="google_ads" i],[class*="related" i],aside,footer,nav'))
      .map((i) => ({ u: abs(i.currentSrc || i.src), a: i.naturalWidth * i.naturalHeight })).sort((a, b) => b.a - a.a);
    if (imgs[0]) out.push(imgs[0].u);
    return [...new Set(out.filter(Boolean))];
  });
  const rq = page.context().request;
  const origin = new URL(page.url()).origin;
  let generic = '';
  try {
    const r = await rq.get(origin + '/', { timeout: 12000 });
    const m = (await r.text()).match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)/i);
    if (m) generic = new URL(m[1], origin).href;
  } catch { /* homepage unreachable: skip the generic-banner check */ }
  const tmp = await page.context().newPage();
  try {
    for (const url of cands) {
      let path = ''; try { path = new URL(url).pathname; } catch { continue; }
      if (BAD_IMG.test(path) || (generic && url === generic)) continue;
      let resp; try { resp = await rq.get(url, { timeout: 15000, headers: { referer: page.url() } }); } catch { continue; }
      if (!resp.ok()) continue;
      const body = await resp.body();
      if (body.length < 20000) continue;
      // some CDNs serve pictures as application/octet-stream: trust the file's own magic bytes, not the header
      const head4 = body.subarray(0, 4).toString('hex');
      const ctype = body[0] === 0xff && body[1] === 0xd8 ? 'image/jpeg' : head4 === '89504e47' ? 'image/png' : (body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP') ? 'image/webp' : body.subarray(0, 3).toString() === 'GIF' ? 'image/gif' : '';
      if (!ctype) continue;
      const res = await tmp.evaluate(async ({ b64, mime }) => {
        const img = new Image(); img.src = 'data:' + mime + ';base64,' + b64;
        try { await img.decode(); } catch { return null; }
        const w = img.naturalWidth, h = img.naturalHeight, r = w / h;
        if (w < 600 || h < 315 || r < 1.0 || r > 2.4) return { ok: false };
        const k = document.createElement('canvas'); k.width = 64; k.height = 36;
        const kg = k.getContext('2d'); kg.drawImage(img, 0, 0, 64, 36);
        const d = kg.getImageData(0, 0, 64, 36).data, seen = new Set();
        for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
        if (seen.size < 45) return { ok: false };   // flat / few-colour graphic = a logo banner, not a photo
        const s = Math.min(1, 1600 / w), c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        return { ok: true, w: c.width, h: c.height, data: c.toDataURL('image/jpeg', 0.9).split(',')[1] };
      }, { b64: body.toString('base64'), mime: ctype });
      if (res && res.ok) return { url, w: res.w, h: res.h, jpeg: Buffer.from(res.data, 'base64'), mime: ctype };
    }
  } finally { await tmp.close(); }
  return null;
}

// ---------------------------------------------------------------- main
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
if (!files.length) { console.error('No queue files in ' + DIR + ' - run generate.mjs first'); process.exit(1); }
mkdirSync(IMG, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: W, height: 900 }, locale: 'en-US', deviceScaleFactor: 2,   // 2x so text in small crops stays sharp when enlarged
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
const report = [];

for (const f of files) {
  const path = join(DIR, f);
  const p = JSON.parse(readFileSync(path, 'utf8'));
  if (ONLY && p.id !== ONLY) continue;
  const out = join(IMG, p.id + '.png');
  const outPhoto = join(IMG, p.id + '.jpg');
  for (const f of [out, outPhoto]) rmSync(f, { force: true });   // a re-run may switch photo <-> card: never leave the old file behind
  if (p.card) {   // own-data card: no source article to open
    const cpage = await ctx.newPage();
    await cpage.setViewportSize({ width: 1080, height: 1350 });
    await cpage.setContent(infraCardHtml(p.card));
    await cpage.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1350 } });
    await cpage.close();
    Object.assign(p, { imagePath: 'images/' + p.id + '.png', imageKind: 'card', excerptFromArticle: false, renderNote: 'own data card' });
    writeFileSync(path, JSON.stringify(p, null, 2));
    report.push({ id: p.id, image: 'card', note: 'own data card', excerptChars: 0 });
    console.log(`${p.id}: card (own data card)`);
    continue;
  }
  const page = await ctx.newPage();
  let kind = 'card', why = '', excerpt = '', articleHeadline = '', realSource = '', photoUrl = '', photoMime = '', stockCredit = '';
  try {
    await page.goto(p.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    // Some pipeline rows carry a Google News redirect link: wait until it lands on the real publisher page, then use THAT as the source.
    const isGNews = (u) => /(^|\.)google\.[a-z.]+$/.test(new URL(u).hostname);   // news.google.com and its consent.google.com pop-up page
    for (let i = 0; i < 3 && isGNews(page.url()); i++) {
      await dismissConsent(page);
      await page.waitForURL((u) => !isGNews(u.href), { timeout: 9000 }).catch(() => {});
    }
    if (isGNews(page.url())) throw new Error('stuck on a Google redirect page');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    if (!isGNews(page.url()) && page.url() !== p.sourceUrl) realSource = page.url().replace(/[?#].*$/, '');
    await page.waitForTimeout(2500);
    const rejected = await dismissConsent(page);
    await clearOverlays(page);
    // Many sites paint images only once they scroll into view: walk down the page a little, come back, then measure.
    await page.evaluate(async () => { for (let y = 0; y <= 1800; y += 300) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 140)); } window.scrollTo(0, 0); });
    // wait until the pictures near the top are fully decoded (a half-painted hero image shows up as a blank block in the screenshot)
    await Promise.race([
      page.evaluate(() => Promise.all([...document.images].filter((i) => i.getBoundingClientRect().top + scrollY < 2500).map((i) => (i.decode ? i.decode().catch(() => {}) : null)))),
      new Promise((res) => setTimeout(res, 5000)),   // some lazy images never finish: do not hang the whole run on them
    ]).catch(() => {});
    await page.waitForTimeout(1500);
    const info = await readArticle(page, p.headline);
    const sameArticle = info.h1 && overlap(info.h1, p.headline) >= 0.5;
    const blocked = /consent|cookie|privacy|gdpr|paywall|modal|popup/i.test(info.cover);
    excerpt = excerptOf(info, p.headline);
    // Infrastructure project posts use our own portrait card by default (config accounts.infra.imageMode = "card"): a thin headline strip looks lost
    // in the feed, "extending" the crop pulls in ads / pop-ups, and third-party photos are a copyright risk. The article is still opened for the real source + excerpt.
    // imageMode "photo" (default): the article's lead photo like the friend's posts, else our own themed portrait card. "screenshot" = the old headline crop.
    const imageMode = cfg.imageMode || 'photo';
    let photo = null;
    if (imageMode === 'photo') { try { photo = await leadPhoto(page); } catch (e) { why = 'photo lookup failed: ' + String(e.message || e).slice(0, 60); } }
    const seen = photo && imgSeen(photo.url, photo.jpeg);
    if (seen) { why = 'lead photo already used on ' + seen.date + ' -> stock photo'; console.log('  ' + p.id + ': ' + why); photo = null; }
    if (photo) { writeFileSync(outPhoto, photo.jpeg); kind = 'photo'; photoUrl = photo.url; photoMime = photo.mime; why = 'article lead photo ' + photo.w + 'x' + photo.h; }
    const wantShot = imageMode === 'screenshot' && !(p.type === 'project' && cfg.accounts.infra.imageMode === 'card');
    if (!wantShot) { if (!photo && !why) why = 'no usable lead photo -> own themed card'; if (sameArticle && info.h1) articleHeadline = info.h1; }   // the article's own headline is more descriptive than the terse project name
    if (wantShot && sameArticle && !blocked && info.region && info.visibleChars > 400) {
      // Tight crop of headline + lede (+ hero picture): reads like a news "quote card" instead of a slice of a busy web page.
      const PAD = 28;
      const crop = async (R) => {
        const width = Math.min(1180, Math.max(560, Math.round(R.r - R.l + PAD * 2)));
        const height = Math.min(880, Math.max(200, Math.round(R.b - R.t + PAD * 2 + 26)));   // +26: do not clip the last text line
        const x = Math.max(0, Math.round(R.l - PAD)), y = Math.max(0, Math.round(R.t - PAD));
        return page.screenshot({ fullPage: true, clip: { x, y, width, height } });
      };
      let shot = await crop(info.region);
      // Some sites show a placeholder where the hero picture should be (lazy loading): if the lower part of the crop came out blank, redo it without the picture.
      const blankBottom = await page.evaluate(async (b64) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        // where does the last non-white row end? (a half-painted picture leaves a big white block under it)
        const d = g.getImageData(0, 0, img.width, img.height).data;
        let last = 0;
        for (let y = img.height - 1; y >= 0 && !last; y--) {
          for (let x = 0; x < img.width; x += 3) { const i = (y * img.width + x) * 4; if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) { last = y; break; } }
        }
        return last / img.height < 0.8;
      }, shot.toString('base64'));
      if (blankBottom && info.regionHeadOnly) shot = await crop(info.regionHeadOnly);
      // Only keep the article picture when it is a good FEED shape (near-square or portrait, like the friend's posts).
      // A flat headline strip (< 0.72 tall/wide) looks lost on a phone -> fall back to our own portrait card instead.
      const ratio = shot.readUInt32BE(20) / shot.readUInt32BE(16);   // PNG header: height / width
      if (ratio < 0.72) { throw new Error(`article picture too flat (${ratio.toFixed(2)}) -> own card`); }
      // Plain screenshot of the article headline area - no frame, no branding, no website address (same look as the friend's link-preview posts).
      writeFileSync(out, shot);
      kind = 'screenshot';
      if (p.type === 'project' && info.h1) articleHeadline = info.h1;   // project names are terse ("Callao Terminal Expansion"): use the article's own headline in the post
      why = rejected ? 'consent dismissed' : 'no consent pop-up';
    } else if (wantShot) {
      why = !info.h1 ? 'no headline found on page' : (!sameArticle ? `page headline differs ("${info.h1.slice(0, 50)}")` : 'still covered by an overlay');
    }
  } catch (e) {
    why = 'load failed: ' + String(e.message || e).slice(0, 80);
  }
  // No usable lead photo in the article (or the page would not load): a themed Unsplash stock photo instead of our own blue card (config stockPhoto).
  const sp = cfg.stockPhoto || {};
  if (kind === 'card' && (cfg.imageMode || 'photo') === 'photo' && sp.enabled !== false && (sp.types || ['news']).includes(p.type)) {
    try {
      const s = await stockPhoto({ id: p.id, headline: articleHeadline || p.headline, sector: p.meta?.sector, subsector: p.meta?.subsector }, (m) => console.log('  ' + p.id + ': ' + m));
      if (s) { writeFileSync(outPhoto, s.jpeg); kind = 'photo'; photoUrl = s.url; photoMime = 'image/jpeg'; stockCredit = sp.credit === false ? '' : s.credit; why = 'Unsplash stock photo (query "' + s.query + '", ' + s.photoId + ')'; }
    } catch (e) { console.log('  ' + p.id + ': stock photo failed: ' + String(e.message || e).slice(0, 80)); }
  }
  // A redirect link resolved to the real publisher: show the publisher's name and put its URL in the first comment.
  if (realSource) {
    const host = new URL(realSource).hostname.replace(/^www\./, '');
    const old = p.sourceUrl;
    p.sourceUrl = realSource; p.sourceName = host;
    // sourceLink "body" (Buffer Free has no first-comment feature): the real URL goes straight into the post, like the friend's posts.
    p.blocks = p.blocks.map((b) => (/^Source ➡️/.test(b) ? (cfg.sourceLink === 'body' ? `Source ➡️ ${realSource}` : `Source ➡️ ${host} (link in comments)`) : b));
    p.firstComment = (p.firstComment || '').split(old).join(realSource);
  }
  if (kind === 'card') {
    if (p.type === 'news') {   // main-account news without a good article picture: own portrait card, same family as the Infrastructure cards
      await page.setViewportSize({ width: 1080, height: 1350 });
      await page.setContent(infraCardHtml({ kind: 'news', scene: sceneKey(p.meta?.sector, p.meta?.subsector), tag: 'TRADE FLOW', title: 'Trade Flow Signal', sub: [p.meta?.sector, p.meta?.country].filter(Boolean).join('  ·  '), label: 'LATEST SIGNAL',
        footer: 'Live trade-flow signals', name: p.headline, chips: [p.meta?.country, p.meta?.sector, p.meta?.lane && `Lane: ${p.meta.lane}`].filter(Boolean), source: p.sourceName || '' }));
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1350 } });
    } else if (p.type === 'project') {   // no usable article screenshot: own-design project card in the same style as the daily / weekly cards
      const stage = clean(p.meta?.stage || '').replace(/^S\d[-\s]*/, '');
      await page.setViewportSize({ width: 1080, height: 1350 });
      await page.setContent(infraCardHtml({ kind: 'project', scene: sceneKey(p.meta?.sector, p.meta?.subsector), title: 'New Infrastructure Project', sub: [p.meta?.country, p.meta?.sector].filter(Boolean).join('  ·  '), name: articleHeadline || p.headline,
        chips: [p.meta?.country, p.meta?.subsector && p.meta.subsector !== '(unspecified)' ? p.meta.subsector : '', stage && `${stage} stage`, p.meta?.scale && `${p.meta.scale} scale`].filter(Boolean), source: p.sourceName || '' }));
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1350 } });
    } else {
      await page.setViewportSize({ width: W, height: H });
      await page.setContent(cardHtml(p));
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: W, height: H } });
    }
  }
  await page.close();

  // Description: the article's own opening sentences when we got them, else the (short) pipeline summary already in the post.
  const blocks = [...p.blocks];
  if (excerpt) blocks[p.descIndex] = excerpt;
  if (articleHeadline) blocks[0] = `${p.headPrefix || ''} ${clean(articleHeadline)}`.trim();
  if (stockCredit) blocks.splice(/^#/.test(blocks[blocks.length - 1] || '') ? blocks.length - 1 : blocks.length, 0, stockCredit);   // photographer credit sits just above the hashtags
  Object.assign(p, {
    blocks, text: blocks.filter(Boolean).join('\n\n'),
    imagePath: 'images/' + p.id + (kind === 'photo' ? '.jpg' : '.png'), imageKind: kind, imageUrl: photoUrl || null, imageRehost: kind === 'photo' && !/jpeg|png|gif/i.test(photoMime), stockPhoto: !!stockCredit || /^Unsplash/.test(why), excerptFromArticle: !!excerpt, renderNote: why,
  });
  writeFileSync(path, JSON.stringify(p, null, 2));
  if (kind === 'photo' && existsSync(outPhoto)) imgUsed.push({ date: DATE, id: p.id, url: imgKey(photoUrl), hash: sha1(readFileSync(outPhoto)) });
  report.push({ id: p.id, image: kind, note: why, excerptChars: excerpt.length });
  console.log(`${p.id}: ${kind} (${why}) · excerpt ${excerpt.length} chars`);
}
await browser.close();
if (!ONLY) writeFileSync(IMG_STATE, JSON.stringify({ items: imgUsed }, null, 2));

// human-readable preview with the final text
const A = cfg.accounts;
const lines = [`# LinkedIn queue — ${DATE}`, ''];
for (const acct of ['main', 'infra']) {
  lines.push(`## ${A[acct].name}`, '');
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
    if (p.account !== acct) continue;
    lines.push(`### ${p.id} · ${p.scheduledAtUtc.slice(11, 16)} UTC · image: ${p.imageKind || p.image} (${p.imagePath || '-'})`, '', '```', p.text, '```', '', ...(p.firstComment ? ['First comment:', '```', p.firstComment, '```', ''] : []));
  }
}
writeFileSync(join(DIR, 'preview.md'), lines.join('\n'));
