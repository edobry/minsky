/**
 * formatDurationShort — compact "age" formatting shared by the /vitals loop
 * cards (mt#2601). Mirrors the rounding behavior of the ad-hoc
 * `formatRelative` helpers already duplicated in ActivityPage.tsx /
 * AsksPage.tsx, factored out here so new vitals code has one canonical
 * source instead of a third copy.
 */
export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}
