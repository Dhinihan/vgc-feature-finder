const WILDCARD = "*";

/** Maps common tournament / PokéData country codes to a single canonical form. */
const CANONICAL: Record<string, string> = {
  US: "USA",
  USA: "USA",
  UK: "GB",
  GB: "GB",
  GBR: "GB",
  UAE: "AE",
  AE: "AE"
};

export function normalizeCountryCode(country: string): string {
  const trimmed = country.trim().toUpperCase();
  if (!trimmed) {
    return WILDCARD;
  }
  return CANONICAL[trimmed] ?? trimmed;
}

export function countryCodesMatch(stored: string, playerCountry: string): boolean {
  const a = normalizeCountryCode(stored);
  const b = normalizeCountryCode(playerCountry);
  if (a === WILDCARD || b === WILDCARD) {
    return true;
  }
  return a === b;
}
