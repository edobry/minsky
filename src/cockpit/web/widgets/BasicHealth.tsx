import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";

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

interface Props {
  data: WidgetData;
}

export function BasicHealth({ data }: Props) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">System Health</CardTitle>
      </CardHeader>
      <CardContent>
        {data.state === "ok" ? (
          <dl>
            <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-sm">
              <dt className="text-muted-foreground">Uptime</dt>
              <dd className="tabular-nums">{formatUptime((data.payload as HealthPayload).uptimeSec)}</dd>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-sm">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="tabular-nums">{(data.payload as HealthPayload).version}</dd>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-sm">
              <dt className="text-muted-foreground">Widgets loaded</dt>
              <dd className="tabular-nums">{(data.payload as HealthPayload).loadedWidgetCount}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{data.reason}</p>
        )}
      </CardContent>
    </Card>
  );
}
