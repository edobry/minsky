/**
 * DeployLoopCard — /vitals "deploy" loop (mt#2601).
 *
 * Live: deploy status + last-deploy timestamp via useDeployVitals (reuses
 * the mcp-server-status widget's deploy field — same source useSystemHealth
 * already wires for the header chip).
 *
 * Honest gap: phase-level detail (build -> smoke -> live sub-stages) and any
 * deploy-history sparkline have no event source yet — no `deploy.*` system
 * events exist. That arrives with mt#2537. The sparkline slot renders the
 * shared honest placeholder (dashed baseline) rather than fabricating a
 * trend from a single point-in-time status read.
 */
import { useDeployVitals, type DeploymentStatus } from "../../hooks/useDeployVitals";
import { formatDurationShort } from "../../lib/format-duration";
import { LoopCardShell } from "./LoopCardShell";
import { RingGauge } from "./RingGauge";
import { Sparkline } from "./Sparkline";

/** Short code for the ring's fixed-width center label — the full status word
 *  (e.g. "DEPLOYING") doesn't fit an 88px ring at legible size; the aria
 *  label carries the full word for assistive tech. */
function statusShortLabel(status: DeploymentStatus): string {
  switch (status) {
    case "SUCCESS":
      return "OK";
    case "FAILED":
      return "FAIL";
    case "CANCELLED":
      return "CNCL";
    case "CRASHED":
      return "CRSH";
    case "BUILDING":
      return "BLD";
    case "DEPLOYING":
      return "DPL";
    case "UNKNOWN":
    default:
      return "?";
  }
}

/** Ring fill + color per status. Fill is a legibility read ("done" = full),
 *  not a percentage-complete estimate — deploys are not fractionally tracked
 *  today (mt#2537 gap, same as the sparkline). */
function statusVisual(status: DeploymentStatus): { fraction: number; colorVar: string } {
  switch (status) {
    case "SUCCESS":
      return { fraction: 1, colorVar: "--vsm-s4" };
    case "BUILDING":
    case "DEPLOYING":
      return { fraction: 0.5, colorVar: "--warn-amber" };
    case "FAILED":
    case "CRASHED":
    case "CANCELLED":
      return { fraction: 1, colorVar: "--warn-red" };
    case "UNKNOWN":
    default:
      return { fraction: 0, colorVar: "--muted-foreground" };
  }
}

export function DeployLoopCard() {
  const { data, isError } = useDeployVitals();

  const status = data?.status ?? "UNKNOWN";
  const { fraction, colorVar } = statusVisual(status);
  const needsAttention = status === "FAILED" || status === "CRASHED";

  const statusLine = isError
    ? "Deploy: unavailable"
    : data === undefined
      ? "Loading…"
      : data.lastDeployAt
        ? `Last deploy ${formatDurationShort(Date.now() - new Date(data.lastDeployAt).getTime())} ago`
        : "No deploy recorded yet";

  return (
    <LoopCardShell
      label="Deploy"
      needsAttention={needsAttention}
      ring={
        <RingGauge
          fraction={fraction}
          colorVar={colorVar}
          valueLabel={data === undefined ? "—" : statusShortLabel(status)}
          ariaLabel={`Deploy loop: status ${status}`}
        />
      }
      sparkline={
        <Sparkline
          data={null}
          colorVar={colorVar}
          ariaLabel="Deploy loop history"
          placeholderReason="No deploy history yet (mt#2537)"
        />
      }
      statusLine={statusLine}
    />
  );
}
