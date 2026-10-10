import { describe, expect, it } from "vitest";

import {
  addCategory,
  categoriesAfterPairing,
  cleanCategories,
  MAX_CATEGORIES,
  sortCategories,
} from "../src/lib/categories";

describe("categories", () => {
  it("adds a typed name cleaned as a folder name", () => {
    expect(addCategory(["Reading"], "  Work: later  ")).toEqual({
      ok: true,
      name: "Work- later",
      categories: ["Reading", "Work- later"],
    });
  });

  it("picks the listed name for one in another letter case", () => {
    expect(addCategory(["Reading"], "reading")).toEqual({
      ok: true,
      name: "Reading",
      categories: ["Reading"],
    });
  });

  it("refuses the inbox itself and names that clean to nothing", () => {
    expect(addCategory([], "Inbox")).toEqual({ ok: false, reason: "empty" });
    expect(addCategory([], "INBOX")).toEqual({ ok: false, reason: "empty" });
    expect(addCategory([], " ‮ ")).toEqual({ ok: false, reason: "empty" });
  });

  it("keeps at most 200 names", () => {
    const many = Array.from({ length: MAX_CATEGORIES }, (_, i) => `C${String(i)}`);
    expect(addCategory(many, "One more")).toEqual({ ok: false, reason: "full" });
    expect(cleanCategories([...many, "Extra"])).toHaveLength(MAX_CATEGORIES);
  });

  it("cleans and deduplicates a list", () => {
    expect(cleanCategories(["Work", "work", "", "Inbox", "a/b"])).toEqual(["Work", "a-b"]);
  });

  it("sorts without letter case", () => {
    expect(sortCategories(["b", "A", "c"])).toEqual(["A", "b", "c"]);
  });

  it("keeps local names when connecting again to the same workspace only", () => {
    expect(categoriesAfterPairing(["Mine"], ["Theirs"], true)).toEqual(["Theirs", "Mine"]);
    expect(categoriesAfterPairing(["Mine"], ["Theirs"], false)).toEqual(["Theirs"]);
  });
});
