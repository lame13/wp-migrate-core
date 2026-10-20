/**
 * Model output is untrusted text until it has been parsed and checked. These
 * helpers only make the parse forgiving of a markdown fence or a sentence
 * around the object; the job-specific validators decide whether the shape is
 * acceptable.
 */

export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstObject = candidate.indexOf("{");
    const firstArray = candidate.indexOf("[");
    const start =
      firstObject === -1
        ? firstArray
        : firstArray === -1
          ? firstObject
          : Math.min(firstObject, firstArray);
    if (start === -1) throw new Error("The model response contains no JSON value.");
    const closing = candidate[start] === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(closing);
    if (end <= start) throw new Error("The model response contains an incomplete JSON value.");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

export function expectObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function expectArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array.`);
  return value;
}

export function expectString(value: unknown, label: string, maximum = 4_000): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return plainText(value, maximum);
}

export function optionalString(value: unknown, label: string, maximum = 4_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  return expectString(value, label, maximum);
}

export function expectStringArray(value: unknown, label: string, maximum = 40): readonly string[] {
  const entries = expectArray(value, label);
  if (entries.length > maximum) throw new Error(`${label} has more than ${maximum} entries.`);
  return entries.map((entry, index) => expectString(entry, `${label}[${index}]`, 500));
}

export function expectEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[]
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}.`);
  }
  return value as T;
}

export function expectNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
  return value;
}

/** Flatten model prose into one line for a report or a table cell. */
export function plainText(value: string, maximum = 4_000): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
