/**
 * Shared "technical diorama" lighting (scenes3d.md A14): a hemisphere light plus one key
 * directional light, tuned per theme. No shadows (use baked gradients / contact textures).
 */
import { DirectionalLight, Group, HemisphereLight, type Scene } from 'three';
import type { Palette } from './types';

export interface StudioLights {
  group: Group;
  /** Re-tune for a new palette (call from onPalette). */
  apply(p: Palette): void;
}

export function addStudioLights(scene: Scene, p: Palette, opts: { intensity?: number } = {}): StudioLights {
  const k = opts.intensity ?? 1;
  const group = new Group();
  group.name = 'studio-lights';
  const hemi = new HemisphereLight(0xffffff, 0x445066, 1);
  const key = new DirectionalLight(0xffffff, 1);
  key.position.set(4, 8, 6);
  const rim = new DirectionalLight(0xffffff, 0.4);
  rim.position.set(-6, 3, -5);
  group.add(hemi, key, rim);
  scene.add(group);
  const apply = (pal: Palette) => {
    const dark = pal.theme === 'dark';
    hemi.color.set(0xffffff);
    hemi.groundColor.copy(pal.bg).lerp(pal.muted, 0.35);
    hemi.intensity = (dark ? 1.25 : 1.6) * k;
    key.intensity = (dark ? 1.6 : 1.9) * k;
    rim.color.copy(pal.flow).lerp(pal.fg, 0.6);
    rim.intensity = (dark ? 0.7 : 0.35) * k;
  };
  apply(p);
  return { group, apply };
}
