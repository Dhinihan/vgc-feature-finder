export function firstLastKey(displayName: string): string {
  const parts = displayName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length < 2) {
    return parts[0] ?? "";
  }

  return `${parts[0]}|${parts[parts.length - 1]}`;
}
