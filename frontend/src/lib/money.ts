
export const CATEGORY_COLORS = [
  "var(--cat-1)",
  "var(--cat-2)",
  "var(--cat-3)",
  "var(--cat-4)",
  "var(--cat-5)",
  "var(--cat-6)",
] as const;

export function categoryColor(index: number): string {
  return CATEGORY_COLORS[index % CATEGORY_COLORS.length];
}

export function money(amount: number): string {
  const value = Number(amount) || 0;
  const hasCents = Math.abs(value % 1) > 0.004;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(value);
}

export function signedMoney(amount: number, direction: "in" | "out"): string {
  return `${direction === "in" ? "+" : "−"} ${money(Math.abs(Number(amount) || 0))}`;
}

export function monthKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
}

export function plainMonth(raw: string | null | undefined): string {
  const key = monthKey(raw);
  if (!key) return raw?.trim() || "No date";
  const [year, month] = key.split("-");
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function plainDate(value: string | Date | null | undefined): string {
  if (!value) return "No date";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);

  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);

  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo > 1 && daysAgo < 7) {
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  }
  if (d.getFullYear() === new Date().getFullYear()) {
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  }
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function shareOf(amount: number, total: number): number {
  if (!total) return 0;
  return Math.round((Number(amount) / total) * 100);
}

export function describeChange(
  current: number,
  previous: number,
): { text: string; direction: "up" | "down" | "flat" } {
  if (!previous) return { text: "This is the first period we have on record.", direction: "flat" };
  const diff = current - previous;
  if (Math.abs(diff) < 0.5) return { text: "About the same as last time.", direction: "flat" };
  return {
    text: `${money(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than last time.`,
    direction: diff > 0 ? "up" : "down",
  };
}
