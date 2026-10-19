/**
 * Meta sends budgets and caps as integers in the currency's minor unit ("offset").
 * Most currencies (including PKR) use offset 100; the ones below use offset 1.
 * All conversion goes through these helpers — never multiply by 100 anywhere else.
 */
const OFFSET_ONE = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);

export function currencyOffset(currency: string): number {
  return OFFSET_ONE.has(currency.toUpperCase()) ? 1 : 100;
}

/** 600 PKR -> "60000" (string, as Meta expects). */
export function toMinorUnits(amountMajor: number, currency: string): string {
  if (!Number.isFinite(amountMajor) || amountMajor < 0) throw new Error(`Invalid amount: ${amountMajor}`);
  return String(Math.round(amountMajor * currencyOffset(currency)));
}

/** "60000" -> 600 (PKR). */
export function fromMinorUnits(amountMinor: string | number | null | undefined, currency: string): number | null {
  if (amountMinor === null || amountMinor === undefined || amountMinor === "") return null;
  const n = typeof amountMinor === "number" ? amountMinor : Number(amountMinor);
  if (!Number.isFinite(n)) return null;
  return n / currencyOffset(currency);
}

export function formatMoney(amountMajor: number | null | undefined, currency = "PKR"): string {
  if (amountMajor === null || amountMajor === undefined || !Number.isFinite(amountMajor)) return "—";
  return `${currency} ${amountMajor.toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;
}
