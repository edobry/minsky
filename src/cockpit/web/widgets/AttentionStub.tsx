import { Card, CardHeader, CardTitle, CardContent } from "../components/Card";

type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

interface Props {
  data: WidgetData;
}

export function AttentionStub({ data }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Attention</CardTitle>
      </CardHeader>
      {data.state === "degraded" && (
        <CardContent className="text-muted-foreground">
          <p>{data.reason}</p>
        </CardContent>
      )}
    </Card>
  );
}
