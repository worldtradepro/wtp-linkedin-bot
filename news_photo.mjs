// News article photo = third picture source for Infrastructure project posts (owner 2026-11-11: "放开,排除通讯社图").
// Order in pick_official.mjs: the project party's official photo -> a Wikimedia Commons photo of the facility -> this -> fact card.
// The lead picture (og:image) of the news article the project came from, unedited, credited "Image: <outlet>".
// Owner's view: at worst a publisher asks for a post to be taken down. The exception that costs money is agency / stock pictures
// (Getty, Reuters, AP, AFP ... chase businesses with invoices through Copytrack / Pixsy), so those are skipped whenever the caption,
// the credit line, the alt text, the file name or the picture's embedded IPTC / XMP rights text names an agency or a stock library.
import { loadPhoto, siteLabel } from './image_search.mjs';
import { BANNER_NAME, STOCK, MIN_DETAIL, detailOf } from './official_photo.mjs';

export const AGENCY = /getty|reuters|associated press|\bap photo|\(ap\)|\bap\/|\/ap\b|\bafp\b|agence france|bloomberg|\bepa\b|european pressphoto|xinhua|anadolu|\bdpa\b|picture[\s-]?alliance|\bpa (images|wire|media)\b|press association|kyodo|yonhap|\btass\b|ria novosti|sputnik|imago|abaca|\befe\b|\bansa\b|corbis|nurphoto|sopa images|zuma|sipa|rex features|shutterstock|scanpix|\bntb\b|belga|\baap\b|polaris|redux|magnum|alamy|istock|adobe ?stock|dreamstime|123rf|depositphotos|bigstock|stocksy|pond5|envato/i;
// sites that mostly re-publish agency pictures, or whose lead picture is a chart / screenshot, not the project
const SKIP_HOST = /(^|\.)(msn\.com|yahoo\.com|aol\.com|news\.google\.com|google\.com|marketscreener\.com|tradingview\.com|investing\.com|seekingalpha\.com|zawya\.com|linkedin\.com|x\.com|twitter\.com|facebook\.com|youtube\.com|ted\.europa\.eu|find-tender\.service\.gov\.uk|projects\.worldbank\.org|d-portal\.org|static\.cninfo\.com\.cn)$/i;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

// the article's lead picture + every credit-like text near it (figcaption, credit/caption classes, alt text, "Photo:" lines)
async function articlePicture(ctx, url) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (/news\.google\.com/.test(page.url())) await page.waitForURL((u) => !/google\.com/.test(u.hostname), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    return await page.evaluate(() => {
      const m = (n) => document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]')?.content || '';
      const img = m('og:image') || m('og:image:url') || m('twitter:image');
      const abs = img ? new URL(img, location.href).href : '';
      const file = abs.split(/[?#]/)[0].split('/').pop() || '';
      const texts = [...document.querySelectorAll('figcaption, [class*="caption" i], [class*="credit" i], [class*="copyright" i], [itemprop="copyrightHolder"], [itemprop="creditText"]')]
        .map((e) => e.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 12);
      const alts = [...document.images].filter((i) => file && (i.currentSrc || i.src).includes(file.slice(0, 20))).map((i) => (i.alt || '') + ' ' + (i.title || ''));
      const lines = (document.body?.innerText || '').split('\n').filter((l) => /^(photo|image|picture|credit|source)\s*[:：]|©/i.test(l.trim())).slice(0, 8);
      return { img: abs, page: location.href, site: m('og:site_name'), credits: [...texts, ...alts, ...lines, m('og:image:alt'), m('twitter:image:alt')].join(' | ') };
    });
  } catch { return null; } finally { await page.close().catch(() => {}); }
}
async function embeddedRights(ctx, url) {   // IPTC / XMP rights text sits in the first part of the JPEG
  // only readable text runs (8+ characters, where IPTC / XMP credit fields live): short names like "afp" / "efe" / "/AP" also occur by chance
  // in the raw bytes of a JPEG (first test 2026-11-11 skipped 3 pictures that way)
  try {
    const r = await ctx.request.get(url, { timeout: 15000 });
    if (r.ok()) { const text = ((await r.body()).subarray(0, 196608).toString('latin1').match(/[\x20-\x7e]{8,}/g) || []).join('\n'); const m = AGENCY.exec(text) || STOCK.exec(text); if (m) return m[0]; }
  } catch { /* the photo check downloads it again */ }
  return '';
}

// links: the post's source article first, then the other news pages the pipeline linked to the project
export async function newsPhoto(ctx, links, { seen = () => false } = {}, log = () => {}) {
  for (const url of [...new Set(links.filter(Boolean))].slice(0, 3)) {
    const host = hostOf(url);
    if (!host || SKIP_HOST.test(host) || /\.pdf(\?|$)/i.test(url)) continue;
    const a = await articlePicture(ctx, url);
    const h2 = hostOf(a?.page || '');
    if (!a?.img) { log(`news ${host}: no lead picture`); continue; }
    if (SKIP_HOST.test(h2)) { log(`news ${h2}: aggregator, skipped`); continue; }
    const file = decodeURIComponent(a.img.split(/[?#]/)[0].split('/').pop() || '');
    const agency = AGENCY.exec(a.credits) || AGENCY.exec(file);
    if (agency) { log(`news ${h2}: agency / stock picture (${agency[0]}) - skipped`); continue; }
    if (BANNER_NAME.test(file)) { log(`news ${h2}: site banner / share graphic`); continue; }
    const rights = await embeddedRights(ctx, a.img);
    if (rights) { log(`news ${h2}: agency / stock picture (embedded: ${rights}) - skipped`); continue; }
    const ph = await loadPhoto(ctx, a.img, a.page);
    if (!ph) { log(`news ${h2}: picture rejected (shape / text / not a photo)`); continue; }
    const detail = await detailOf(ctx, ph.jpeg);
    if (detail < MIN_DETAIL) { log(`news ${h2}: abstract / blurred graphic (detail ${detail})`); continue; }
    if (seen(ph.url, ph.jpeg)) { log(`news ${h2}: picture already used`); continue; }
    const credit = siteLabel(a.site, h2) || h2;
    return { ...ph, credit, page: a.page, source: 'news', note: `news photo (${credit}, ${h2})` };
  }
  return null;
}
