// Local sample of the "Who builds X" market card (who_builds.mjs). Not used in CI.
// node preview_whobuilds_market.mjs <rows90.json> <out dir> [themeKey ...]   (no key = the theme pickTheme chooses)
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, pickTheme, renderWhoBuilds, whoBuildsPost } from './who_builds.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const [rowsFile, outDir, ...keys] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const j = JSON.parse(readFileSync(rowsFile, 'utf8'));
const rows = (Array.isArray(j) ? j : j.items).filter((r) => r.verification === 'full' || r.verification === 'project_only');
const LOGO = 'data:image/png;base64,' + readFileSync(join(HERE, 'assets', 'logo_white_v2.png')).toString('base64');
const cta = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8')).accounts.infra.ctaLine;
const today = '2026-11-27';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1350 } });
for (const k of keys.length ? keys : ['']) {
  // a given key: that theme only (THEMES filtered), else the pick
  const pick = k ? (() => { const keep = THEMES.splice(0); THEMES.push(...keep.filter((t) => t.key === k)); const r = pickTheme(rows, today); THEMES.splice(0, THEMES.length, ...keep); return r; })() : pickTheme(rows, today);
  if (!pick) { console.log(k, ': too little data'); continue; }
  const out = join(outDir, `market-${pick.theme.key}.png`);
  const shown = await renderWhoBuilds(p, pick, LOGO, out);
  writeFileSync(out.replace(/\.png$/, '.txt'), whoBuildsPost(shown, cta));
  console.log(out, '| deals', pick.all.length, '| rows shown', shown.deals.length);
}
await b.close();
