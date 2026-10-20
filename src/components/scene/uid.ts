/** Deterministic per-build id counter for Scene3D instances (unique within a page). */
let n = 0;
export function sceneUid(id: string): string {
  n = (n + 1) % 1_000_000;
  return `scene-${id}-${n}`;
}
