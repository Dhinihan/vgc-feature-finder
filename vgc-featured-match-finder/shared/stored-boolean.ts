export function readStoredBoolean(value: unknown, defaultValue = false): boolean {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return defaultValue;
}
