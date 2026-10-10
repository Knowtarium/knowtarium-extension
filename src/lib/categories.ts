import { normalizeCategory } from "knowtarium/clip";

// Categories are the inbox folder's subfolders. The extension can't read folder names, so it keeps
// its own list: seeded at pairing from the payload, with names the person adds through
// "+ New category" (the folder appears when the web app files the first clip in it). Names compare
// without letter case, as the filer matches them.

/** The most names the list keeps (as many as a pairing carries). */
export const MAX_CATEGORIES = 200;

function fold(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase();
}

/** `names` cleaned as folder names, without the inbox itself, duplicates or empties. */
export function cleanCategories(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeCategory(raw);
    if (name === "" || seen.has(fold(name))) continue;
    seen.add(fold(name));
    out.push(name);
    if (out.length === MAX_CATEGORIES) break;
  }
  return out;
}

/** Sorted for the picker, as a file tree would list them. */
export function sortCategories(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export type AddCategory =
  | { readonly ok: true; readonly name: string; readonly categories: string[] }
  | { readonly ok: false; readonly reason: "empty" | "full" };

/**
 * Adds a typed name: cleaned like a folder name (`normalizeCategory`); a name already in the list
 * in another letter case picks the listed one. "Inbox" and a name that cleans to nothing are
 * `empty`.
 */
export function addCategory(categories: readonly string[], typed: string): AddCategory {
  const name = normalizeCategory(typed);
  if (name === "") return { ok: false, reason: "empty" };
  const existing = categories.find((entry) => fold(entry) === fold(name));
  if (existing !== undefined) return { ok: true, name: existing, categories: [...categories] };
  if (categories.length >= MAX_CATEGORIES) return { ok: false, reason: "full" };
  return { ok: true, name, categories: [...categories, name] };
}

/** The list after connecting again: the same workspace keeps its local names, another starts over. */
export function categoriesAfterPairing(
  previous: readonly string[],
  fromPairing: readonly string[],
  sameWorkspace: boolean,
): string[] {
  return cleanCategories(sameWorkspace ? [...fromPairing, ...previous] : fromPairing);
}
