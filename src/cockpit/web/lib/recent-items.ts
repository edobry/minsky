const STORAGE_KEY = "minsky-cockpit-recent-items";
const MAX_RECENT = 5;

export interface RecentItem {
  type: string;
  id: string;
  label: string;
  path: string;
  timestamp: number;
}

export function getRecentItems(): RecentItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const items = JSON.parse(raw) as RecentItem[];
    if (!Array.isArray(items)) return [];
    return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function addRecentItem(item: Omit<RecentItem, "timestamp">): void {
  try {
    const items = getRecentItems().filter((i) => i.id !== item.id);
    items.unshift({ ...item, timestamp: Date.now() });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
  } catch {
    // localStorage unavailable — silently skip
  }
}
