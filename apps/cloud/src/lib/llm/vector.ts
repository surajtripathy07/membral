// pgvector text encoding helpers, moved from lib/kg/embeddings.ts (refactor
// programme step 1.1). lib/kg/embeddings.ts re-exports both.

export function toVectorString(v: number[]): string {
  return `[${v.join(",")}]`;
}

export function parseVector(value: unknown): number[] {
  const asNumbers = (arr: unknown[]): number[] => arr.filter((n): n is number => typeof n === "number");
  if (Array.isArray(value)) return asNumbers(value);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? asNumbers(parsed) : [];
    } catch {
      return [];
    }
  }
  return [];
}
