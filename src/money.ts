// Money formatting for any ISO 4217 currency. Amounts are always integers in
// the currency's minor unit (cents for USD/EUR, whole units for PYG/JPY…), so
// formatting needs to know how many decimals each currency has.

const digitsCache = new Map<string, number>();

/** Decimal places of a currency's minor unit (USD 2, PYG 0, KWD 3). */
export function currencyDigits(currency: string): number {
  const cached = digitsCache.get(currency);
  if (cached !== undefined) return cached;
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // Unknown code: assume cents.
  }
  digitsCache.set(currency, digits);
  return digits;
}

/** "$1,234.56", "₲1,234", "€12.00", with a leading minus for negatives. */
export function fmt(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const major = Math.abs(minor) / 10 ** digits;
  let body: string;
  try {
    body = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(major);
  } catch {
    body = `${major.toFixed(digits)} ${currency}`;
  }
  return `${minor < 0 ? "−" : ""}${body}`;
}

/** Short form for tight spaces: "$1.2k", "₲2.7M". */
export function fmtCompact(minor: number, currency: string): string {
  const major = Math.abs(minor) / 10 ** currencyDigits(currency);
  const symbol = fmt(0, currency).replace(/[\d.,\s]/g, "") || currency + " ";
  const n = major >= 1e6 ? (major / 1e6).toFixed(major >= 1e7 ? 0 : 1) + "M" : major >= 1e3 ? (major / 1e3).toFixed(major >= 1e4 ? 0 : 1) + "k" : String(Math.round(major));
  return `${minor < 0 ? "−" : ""}${symbol}${n}`;
}

/** Turn a typed amount ("12.50", "1.234,56" not supported) into minor units. */
export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyDigits(currency));
}

export function isCurrencyCode(c: unknown): c is string {
  return typeof c === "string" && /^[A-Z]{3}$/.test(c);
}

export const PALETTE = ["#9a78d1", "#6ba3d4", "#d4a853", "#7cc49a", "#e8869a", "#c9a3e6", "#5fb8b0", "#e0a06b"];

/** A stable color for an account or bank name, unless one was chosen. */
export function colorFor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return PALETTE[h % PALETTE.length];
}
