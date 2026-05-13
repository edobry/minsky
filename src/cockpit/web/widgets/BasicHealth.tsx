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
      <CardHeader>
        <CardTitle>System Health</CardTitle>
      </CardHeader>
      <CardContent>
        {data.state === "ok" ? (
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Uptime</dt>
              <dd>{formatUptime((data.payload as HealthPayload).uptimeSec)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Version</dt>
              <dd>{(data.payload as HealthPayload).version}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Widgets loaded</dt>
              <dd>{(data.payload as HealthPayload).loadedWidgetCount}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted-foreground">{data.reason}</p>
        )}
      </CardContent>
    </Card>
  );
}
