/**
 * Deterministic slug generation for product taxonomy categories.
 *
 * Pure function: same input always produces the same output, no side effects.
 * Used exclusively at Category creation time — slugs are NEVER regenerated
 * on update (design — Decision "Mutable vs stable category slug"). This
 * prevents public URL drift when an admin renames a category.
 *
 * Algorithm:
 *   1. Lowercase the input.
 *   2. Normalize to NFD and strip combining diacritical marks (é -> e).
 *   3. Replace any run of characters that are NOT [a-z0-9] with a single hyphen.
 *   4. Trim leading/trailing hyphens.
 *
 * Spec: admin-catalog §"Category administration" — "Creation MUST derive a
 * unique kebab-case slug from the name"; §"Category lifecycle succeeds" —
 * "Pan Artesano" -> "pan-artesano".
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
