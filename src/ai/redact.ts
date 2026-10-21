/**
 * The assist layer sends the smallest useful payload. These redactions run
 * before anything is serialized, so a support email or a signed image URL in a
 * title does not leave the machine.
 */
export function redactValue(value: unknown, rules: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, rules);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, rules));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, rules)])
    );
  }
  return value;
}

export function redactText(value: string, rules: readonly string[]): string {
  let result = value;
  if (rules.includes("url-query")) {
    result = result.replace(
      /((?:\bhttps?:\/\/|\/)[^\s"'<>?#]*)[?#][^\s"'<>]*/gi,
      "$1"
    );
  }
  if (rules.includes("email")) {
    result = result.replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[email]"
    );
  }
  if (rules.includes("phone")) {
    result = result.replace(
      /(?:\+?\d[\d ().-]{6,}\d)/g,
      (match) => (match.replace(/\D/g, "").length >= 7 ? "[phone]" : match)
    );
  }
  return result;
}

/** A short, safe preview for the dry-run output. */
export function previewPayload(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length <= 8_000
    ? serialized
    : `${serialized.slice(0, 8_000)}\n… (${serialized.length - 8_000} characters truncated)`;
}
