/**
 * Unit tests — slugify (WU2 Category Administration, RED phase).
 *
 * Pure function: no mocks required.
 *
 * Scenarios covered (spec: admin-catalog §"Category administration",
 * §"Category lifecycle succeeds"; design — Decision "Mutable vs stable
 * category slug"):
 *   - lowercases input
 *   - strips diacritics (accented Latin characters → ASCII equivalents)
 *   - replaces whitespace runs with a single hyphen
 *   - trims leading/trailing hyphens
 *   - collapses repeated separators into a single hyphen
 *   - strips characters that are not lowercase letters, digits, or hyphens
 *   - matches the exact spec example: "Pan Artesano" -> "pan-artesano"
 */
import { describe, expect, it } from "vitest";

import { slugify } from "@/shared/utils/slugify";

describe("slugify — spec example", () => {
  it('derives "pan-artesano" from "Pan Artesano" (admin-catalog spec example)', () => {
    expect(slugify("Pan Artesano")).toBe("pan-artesano");
  });
});

describe("slugify — diacritics", () => {
  it("strips diacritics from accented Latin characters", () => {
    expect(slugify("Salchichón Ibérico")).toBe("salchichon-iberico");
  });

  it("strips diacritics on a different word set (triangulation)", () => {
    expect(slugify("Queso Añejo")).toBe("queso-anejo");
  });
});

describe("slugify — whitespace and separators", () => {
  it("collapses multiple internal spaces into a single hyphen", () => {
    expect(slugify("Miel   de   Romero")).toBe("miel-de-romero");
  });

  it("trims leading and trailing whitespace before hyphenating", () => {
    expect(slugify("  Aceite de Oliva  ")).toBe("aceite-de-oliva");
  });
});

describe("slugify — non-alphanumeric characters", () => {
  it("strips punctuation not part of the kebab-case alphabet", () => {
    expect(slugify("Café & Té!")).toBe("cafe-te");
  });

  it("preserves digits (triangulation)", () => {
    expect(slugify("Pack 100% Natural")).toBe("pack-100-natural");
  });
});

describe("slugify — case normalization", () => {
  it("lowercases uppercase input", () => {
    expect(slugify("PAN ARTESANO")).toBe("pan-artesano");
  });
});
