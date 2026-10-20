// Per-viewer reading progress for the learning path (✓ read marks on /learn/ and /learn/<slug>/).
// Owner: pages-learn agent.
//
// The marks live only in this browser's localStorage. Every access is wrapped in try/catch: in a
// private window, with blocked site data or during previews the store simply reads as empty and the
// pages render exactly as they do without JavaScript.
//
//   import { readSlugs, setRead, onProgressChange } from '../../client/progress';
//   setRead('what-is-ai', true);
//   const stop = onProgressChange((read) => render(read));

const KEY = 'aca:learn-read:v1';
const EVENT = 'aca:learn-progress';

/** slug → ISO date (YYYY-MM-DD) the viewer marked the article as read */
type Store = Record<string, string>;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function load(): Store {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (SLUG.test(k)) out[k] = typeof v === 'string' ? v : '';
    }
    return out;
  } catch {
    return {};
  }
}

function save(store: Store): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

function notify(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* ignore */
  }
}

/** True when localStorage can be written (false in some private modes). */
export function storageAvailable(): boolean {
  try {
    const probe = `${KEY}:probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Slugs the viewer has marked as read. */
export function readSlugs(): Set<string> {
  return new Set(Object.keys(load()));
}

export function isRead(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(load(), slug);
}

/** Mark or unmark one article. Returns false when the mark could not be stored. */
export function setRead(slug: string, read: boolean): boolean {
  if (!SLUG.test(slug)) return false;
  const store = load();
  if (read) store[slug] = new Date().toISOString().slice(0, 10);
  else delete store[slug];
  const ok = save(store);
  notify();
  return ok;
}

/** Remove every mark. */
export function clearRead(): boolean {
  let ok = true;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    ok = false;
  }
  notify();
  return ok;
}

/**
 * Call `cb` whenever the marks change in this tab (setRead / clearRead) or in another tab
 * (the `storage` event). Returns an unsubscribe function.
 */
export function onProgressChange(cb: (read: Set<string>) => void): () => void {
  const local = () => cb(readSlugs());
  const remote = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY) cb(readSlugs());
  };
  window.addEventListener(EVENT, local);
  window.addEventListener('storage', remote);
  return () => {
    window.removeEventListener(EVENT, local);
    window.removeEventListener('storage', remote);
  };
}
