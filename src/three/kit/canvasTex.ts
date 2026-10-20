/**
 * canvasTex: procedural CanvasTextures (die floorplans, vent atlases, glows, Latin/number marks).
 * zh-TW text never goes into textures (use the LabelLayer); Latin and digits may, drawn with the
 * page font after `document.fonts.ready`.
 */
import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';

export function canvasTexture(
  width: number,
  height: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  if (g) draw(g, width, height);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Soft radial gradient (white centre → transparent), e.g. for contact shadows or glows. */
export function radialTexture(size = 128, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): CanvasTexture {
  return canvasTexture(size, size, (g, w) => {
    const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grd.addColorStop(0, inner);
    grd.addColorStop(1, outer);
    g.fillStyle = grd;
    g.fillRect(0, 0, w, w);
  });
}

/** A single-line Latin/number mark (e.g. "2nm", "2028"). Not for CJK text. */
export async function textTexture(
  text: string,
  opts: { color?: string; font?: string; height?: number; padding?: number } = {},
): Promise<CanvasTexture> {
  try {
    await document.fonts?.ready;
  } catch {
    /* ignore */
  }
  const h = opts.height ?? 64;
  const pad = opts.padding ?? 8;
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'system-ui, sans-serif';
  const font = opts.font ?? `600 ${Math.round(h * 0.72)}px ${family}`;
  const probe = document.createElement('canvas').getContext('2d');
  let w = h * text.length;
  if (probe) {
    probe.font = font;
    w = Math.ceil(probe.measureText(text).width) + pad * 2;
  }
  const t = canvasTexture(w, h, (g) => {
    g.font = font;
    g.fillStyle = opts.color ?? '#ffffff';
    g.textBaseline = 'middle';
    g.fillText(text, pad, h / 2);
  });
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}
