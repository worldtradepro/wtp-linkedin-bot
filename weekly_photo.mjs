// One licensed photo per issue for the PDF cover and the web page's hero, from the shared media library
// (media_library/ledger.json: every file has source, author, licence; only CC0 / PD / CC BY(-SA) / Pixabay rows are here).
// The photo follows the week's leading sector; the issue number rotates through the matches so consecutive weeks differ.
// Never a news photo; the caption says "Illustrative" when the ledger does.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'media_library');
const ledger = existsSync(join(LIB, 'ledger.json')) ? JSON.parse(readFileSync(join(LIB, 'ledger.json'), 'utf8')) : [];
const TAGS = {
  energy: ['lng-plant', 'refinery', 'lng-carrier', 'crude-tanker', 'offshore-platform', 'gas-processing', 'oilfield', 'pipeline', 'oil-storage', 'energy'],
  power: ['power-plant', 'transmission', 'solar', 'hydro-dam', 'wind', 'energy'],
  metals: ['copper-mine', 'iron-ore', 'mining-general', 'metals', 'smelter'],
  agri: ['grain-loading', 'agriculture', 'bulk-carrier'],
  chem: ['petrochemical', 'refinery', 'gas-processing'],
  infra: ['construction-site', 'infrastructure', 'bridge', 'rail-construction', 'metro'],
  shipping: ['container-port', 'port-cranes', 'container-ship', 'bulk-carrier', 'port-general', 'logistics', 'shipping'],
  equipment: ['construction-site', 'infrastructure'],
  recycling: ['metals', 'logistics'],
};
const RAW = `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || 'worldtradepro/wtp-linkedin-bot'}/main/media_library/`;

// { file, localUrl, publicUrl, credit, caption, illustrative } or null
export function pickPhoto(sectorKey, issueNo = 1, minWidth = 1600) {
  const want = TAGS[sectorKey] || TAGS.energy;
  const pool = ledger.filter((r) => r.file && (r.width ?? 9999) >= minWidth && (r.tags || []).some((t) => want.includes(t)))
    .sort((a, b) => want.findIndex((t) => (a.tags || []).includes(t)) - want.findIndex((t) => (b.tags || []).includes(t)) || String(a.id).localeCompare(String(b.id)));
  if (!pool.length) return null;
  const r = pool[(Math.max(1, issueNo) - 1) % pool.length];
  const lic = String(r.license || r.licence || '').trim();
  const credit = [r.author ? `Photo: ${r.author}` : 'Photo', r.source === 'wikimedia' ? 'Wikimedia Commons' : r.source === 'pixabay' ? 'Pixabay' : r.source || '', lic].filter(Boolean).join(' · ');
  return { file: r.file, localUrl: pathToFileURL(join(LIB, r.file)).href, publicUrl: RAW + encodeURIComponent(r.file), credit, caption: r.caption || '', illustrative: /illustrative/i.test(r.caption || '') || !!r.illustrative, page: r.page || '' };
}
