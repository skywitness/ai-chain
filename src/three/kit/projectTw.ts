/**
 * projectTw: a tiny local equirectangular projection for Taiwan, shared by scripts/gen-geo.ts
 * (build time) and the taiwan-map scene (runtime). Pure TS, no three.js import.
 *
 * Units: 1 unit = 100 km. Origin at 23.7°N, 120.95°E (the island's centre). x → east, y → north.
 * In a three.js scene map (x, y) to (x, −y) on the XZ plane, or use `twToVec3()`.
 */
export const TW_ORIGIN = { lon: 120.95, lat: 23.7 } as const;
const KM_PER_DEG = 111.32;
const COS0 = Math.cos((TW_ORIGIN.lat * Math.PI) / 180);
/** km per unit */
export const TW_UNIT_KM = 100;

export function projectTw(lon: number, lat: number): [x: number, y: number] {
  return [((lon - TW_ORIGIN.lon) * COS0 * KM_PER_DEG) / TW_UNIT_KM, ((lat - TW_ORIGIN.lat) * KM_PER_DEG) / TW_UNIT_KM];
}

export function unprojectTw(x: number, y: number): [lon: number, lat: number] {
  return [TW_ORIGIN.lon + (x * TW_UNIT_KM) / (COS0 * KM_PER_DEG), TW_ORIGIN.lat + (y * TW_UNIT_KM) / KM_PER_DEG];
}

/** Map projected (x, y) onto the XZ ground plane (y up), returned as a tuple [x, height, z]. */
export function twToVec3(x: number, y: number, height = 0): [number, number, number] {
  return [x, height, -y];
}
