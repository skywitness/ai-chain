// Theme bootstrap + helpers. Owner: design-system agent.
//
// THEME_INIT_SCRIPT is inlined by BaseLayout in <head> (is:inline) so it runs before first paint:
//   - adds `js` to <html> (enables .js-only UI such as the theme toggle and search button)
//   - applies a stored explicit choice as html[data-theme="light" | "dark"]
//   - without a stored choice the attribute stays absent and CSS follows prefers-color-scheme
// The helpers below are imported by the ThemeToggle component script.

export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'aca-theme';
/** Fired on <html> after the preference changes: detail = { pref, theme } */
export const THEME_EVENT = 'aca:themechange';

/** Hand-written ES5 so it can be inlined verbatim; keep it tiny. */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement;d.classList.add('js');try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark'){d.setAttribute('data-theme',t);}}catch(e){}})();`;

const THEME_COLOR = { light: '#f8f5ee', dark: '#0b1322' } as const;

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function systemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The theme actually shown right now. */
export function resolvedTheme(): ResolvedTheme {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' || attr === 'dark' ? attr : systemTheme();
}

function syncThemeColorMeta(): void {
  const pref = document.documentElement.getAttribute('data-theme');
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const media = m.dataset['scheme'] as ResolvedTheme | undefined;
    if (!media) return;
    // An explicit choice overrides both media-specific metas; "system" restores them.
    m.content = pref === 'light' || pref === 'dark' ? THEME_COLOR[pref] : THEME_COLOR[media];
  });
}

/** Apply and persist a preference. 'system' removes the attribute (CSS media query takes over). */
export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  try {
    if (pref === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  syncThemeColorMeta();
  root.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { pref, theme: resolvedTheme() } }));
}

export const THEME_LABELS: Record<ThemePref, string> = { system: '系統', light: '淺色', dark: '深色' };
export const THEME_ORDER: readonly ThemePref[] = ['system', 'light', 'dark'];

export function nextThemePref(pref: ThemePref): ThemePref {
  return THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length]!;
}

export { syncThemeColorMeta };
