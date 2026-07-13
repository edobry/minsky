import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";

type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

interface HealthPayload {
  uptimeSec: number;
  version: string;
  loadedWidgetCount: number;
}

function formatUptime(uptimeSec: number): string {
  const minutes = Math.floor(uptimeSec / 60);
  const seconds = uptimeSec % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Chrome-agnostic body for the system-health widget (mt#2373): renders only the
 * health metrics (or the degraded reason), with no card frame or title. The
 * surrounding chrome is supplied by {@link WidgetShell} so the same body can
 * render as a home-grid card, a page body, or a rail row.
 */
export function BasicHealthBody({ data }: { data: WidgetData }) {
  if (data.state !== "ok") {
    return <p className="text-sm text-muted-foreground">{data.reason}</p>;
  }

  const payload = data.payload as HealthPayload;
  return (
    <dl>
      <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-sm">
        <dt className="text-muted-foreground">Uptime</dt>
        <dd className="tabular-nums">{formatUptime(payload.uptimeSec)}</dd>
      </div>
      <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-sm">
        <dt className="text-muted-foreground">Version</dt>
        <dd className="tabular-nums">{payload.version}</dd>
      </div>
      <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-sm">
        <dt className="text-muted-foreground">Widgets loaded</dt>
        <dd className="tabular-nums">{payload.loadedWidgetCount}</dd>
      </div>
    </dl>
  );
}

interface Props {
  data: WidgetData;
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

/**
 * System-health widget. Chrome is supplied by {@link WidgetShell} keyed on
 * `variant` (mt#2373) rather than hardcoded; `title` is registry/prop-driven
 * and defaults to the canonical title so existing call sites need no change.
 */
export function BasicHealth({ data, variant = "card", title = "System Health" }: Props) {
  return (
    <WidgetShell variant={variant} title={title}>
      <BasicHealthBody data={data} />
    </WidgetShell>
  );
}
