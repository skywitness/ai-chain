// Quiet entry lookup for company pages (owner: pages-companies). getEntry() logs a warning for every
// id that has no file yet, which would print hundreds of lines while the content is still being
// written; this resolves ids against one cached getCollection() map instead (refreshed after a few
// seconds in dev so new files show up).
import type { CollectionEntry, CollectionKey } from 'astro:content';
import { safeCollection } from '../../lib/collections';

const cache = new Map<CollectionKey, { at: number; map: Promise<Map<string, unknown>> }>();

/** The entry with this id, or undefined when the file does not exist (never throws, never logs). */
export async function findEntry<C extends CollectionKey>(
  collection: C,
  id: string | { id: string } | undefined | null,
): Promise<CollectionEntry<C> | undefined> {
  if (!id) return undefined;
  const key = typeof id === 'string' ? id : id.id;
  const now = Date.now();
  let hit = cache.get(collection);
  if (!hit || (import.meta.env.DEV && now - hit.at > 3000)) {
    hit = { at: now, map: safeCollection(collection).then((list) => new Map<string, unknown>(list.map((e) => [e.id, e]))) };
    cache.set(collection, hit);
  }
  try {
    return (await hit.map).get(key) as CollectionEntry<C> | undefined;
  } catch {
    return undefined;
  }
}
