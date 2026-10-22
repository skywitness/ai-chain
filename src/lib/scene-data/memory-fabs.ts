// Scene data for `memory-fab-map` (docs/SCENES.md → custom（memory-fab-map））:
//   { asOf, fabs: [{ id, company, companyName, href, name, city, country, lat, lon, products, status,
//                    capacityKwpm?, capacityStatus?, addKwpm?, capex?, timeline?, note? }] }
// Built from src/data/memory/fabs.yaml through the /memory/ loader (src/lib/memory-data.ts). `companyName` is the
// roster's Chinese name, `href` is /companies/<id>/ without the base path (the scene applies it). Source keys
// mentioned in notes are dropped (the page's fab table shows them as citations). Returns undefined when the file is
// missing or invalid, so <Scene3D> falls back to the scene's illustrative fixture.
// Build-time only (node:fs).
import { getMemoryData, plainText } from '../memory-data';
import { getRosterCompany } from '../collections';

export interface MemoryFabSceneDatum {
  id: string;
  company: string;
  companyName: string;
  href: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  products: string[];
  status: string;
  capacityKwpm?: number;
  capacityStatus?: 'actual' | 'estimate' | 'forecast';
  addKwpm?: number;
  capex?: string;
  timeline?: string;
  note?: string;
}
export interface MemoryFabSceneData {
  asOf: string;
  fabs: MemoryFabSceneDatum[];
}

export function buildMemoryFabsSceneData(): MemoryFabSceneData | undefined {
  const data = getMemoryData();
  const src = data.fabs;
  if (!src || src.fabs.length === 0) return undefined;
  const fabs = src.fabs.map((f) => {
    const company = getRosterCompany(f.company);
    const d: MemoryFabSceneDatum = {
      id: f.id,
      company: f.company,
      companyName: company?.nameZh ?? f.company,
      href: `/companies/${f.company}/`,
      name: f.name,
      city: f.city,
      country: f.country,
      lat: f.lat,
      lon: f.lon,
      products: [...f.products],
      status: f.status,
    };
    if (f.capacityKwpm != null) d.capacityKwpm = f.capacityKwpm;
    if (f.capacityStatus) d.capacityStatus = f.capacityStatus;
    if (f.addKwpm != null) d.addKwpm = f.addKwpm;
    const capex = plainText(f.capex);
    if (capex) d.capex = capex;
    const timeline = plainText(f.timeline);
    if (timeline) d.timeline = timeline;
    const note = plainText(f.note);
    if (note) d.note = note;
    return d;
  });
  return { asOf: src.asOf, fabs };
}
