export interface WidgetMeta {
  id: string;
  title: string;
  updateMode: { type: "polling"; intervalMs: number } | { type: "manual" };
}

export type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

export async function fetchWidgets(): Promise<WidgetMeta[]> {
  const res = await fetch("/api/widgets");
  return res.json() as Promise<WidgetMeta[]>;
}

export async function fetchWidgetData(id: string): Promise<WidgetData> {
  const res = await fetch(`/api/widget/${id}/data`);
  return res.json() as Promise<WidgetData>;
}
