// Result handling filters and parsers for list/get style commands

export type BackendType = "github" | "remote" | "local";

// Parse a comma-separated status filter or 'all'
export function parseStatusFilter(input?: string | null): Set<string> | null {
  if (!input) return null;
  const value = String(input).trim().toLowerCase();
  if (value === "all") return null;
  const parts = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  return new Set(parts);
}

// Normalize backend filter
export function parseBackendFilter(input?: string | null): BackendType | undefined {
  if (!input) return undefined;
  const value = String(input).trim().toLowerCase();
  if (value === "github" || value === "remote" || value === "local") return value as BackendType;
  return undefined;
}

// Parse time values: YYYY-MM-DD or relative like 7d / 24h / 30m
// Returns a unix epoch milliseconds timestamp (UTC) or null if invalid/absent
export function parseTime(value?: string | null): number | null {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;

  // Try absolute date (YYYY-MM-DD)
  const absMatch = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (absMatch) {
    const [_, y, m, d] = absMatch;
    const ts = Date.parse(`${y}-${m}-${d}T00:00:00Z`);
    return Number.isNaN(ts) ? null : ts;
  }

  // Try relative format
  const relMatch = v.match(/^(\d+)([dhm])$/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const now = Date.now();
    switch (unit) {
      case "d":
        return now - amount * 24 * 60 * 60 * 1000;
      case "h":
        return now - amount * 60 * 60 * 1000;
      case "m":
        return now - amount * 60 * 1000;
      default:
        return null;
    }
  }

  return null;
}

// Generic item types used by filters
export interface HasStatus {
  status?: string;
}
export interface HasBackend {
  backendType?: string;
}
export interface HasUpdatedAt {
  updatedAt?: string | Date;
}

export function filterByStatus<T extends HasStatus>(items: T[], statuses: Set<string> | null): T[] {
  if (!statuses) return items;
  return items.filter((item) => statuses.has(String(item.status || "").toLowerCase()));
}

export function filterByBackend<T extends HasBackend>(items: T[], backend?: BackendType): T[] {
  if (!backend) return items;
  return items.filter((item) => item.backendType === backend);
}

export function filterByTimeRange<T extends HasUpdatedAt>(
  items: T[],
  sinceTs: number | null,
  untilTs: number | null
): T[] {
  if (sinceTs === null && untilTs === null) return items;
  return items.filter((item) => {
    if (!item.updatedAt) return false;
    const ts =
      item.updatedAt instanceof Date
        ? item.updatedAt.getTime()
        : Date.parse(item.updatedAt as string);
    if (Number.isNaN(ts)) return false;
    if (sinceTs !== null && ts < sinceTs) return false;
    if (untilTs !== null && ts > untilTs) return false;
    return true;
  });
}
