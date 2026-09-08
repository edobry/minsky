#!/usr/bin/env bun
/**
 * Is the published npm package meaningfully behind main? (mt#5013)
 *
 * ## Why this exists
 *
 * Every internal check runs from source — contributors use `bun run src/cli.ts`,
 * CI builds from the checkout, the bundle-boot smoke builds its own bundle. The
 * npm tarball is the one artifact nobody exercises and the only one a new user
 * touches, so it can drift arbitrarily far behind main with nothing to notice.
 *
 * It did. On 2026-09-05 a cold agent installed `@edobry/minsky` per the README
 * and hit `setup db --connection-string <url>` failing with *"Non-interactive
 * mode: pass --connection-string"* while passing that exact flag — a bug fixed
 * on main three weeks earlier (mt#4076). Both `package.json` and `npm view` read
 * `0.1.2`, so neither the user nor an agent helping them had any signal the code
 * was stale. "Upgrade to the latest" was already satisfied.
 *
 * ## What this does NOT mean
 *
 * Main being ahead of npm is the normal state between releases, not a defect —
 * firing on any drift at all would be pure noise. What this reports is drift
 * that has gone on long enough to stop being a release cadence and start being
 * an abandoned channel.
 *
 * ## The threshold, and where it comes from
 *
 * `MAX_DAYS_BEHIND` is 10, taken from `decision-defaults.mdc §Thresholds` —
 * *"Stall threshold (status hasn't changed): 5 days for active work, 10 days for
 * lynchpin tracking."* An install channel every new user passes through is
 * lynchpin rather than active work, so 10 is the value that rule already
 * specifies; it is not a round number picked here. For calibration: the observed
 * healthy cadence was same-day (0.1.0, 0.1.1 and 0.1.2 all shipped within 29
 * hours), and the incident that prompted this ran 27 days.
 *
 * The COMMIT count is reported and never gates. Commit volume varies with how
 * work happens to be batched, so it informs a reader without deciding anything.
 */

/** Everything the verdict depends on, so the decision is a pure function. */
export interface StalenessInputs {
  /** `npm view <pkg> version` — the version a new user installs. */
  readonly publishedVersion: string;
  /** ISO timestamp for that version, from `npm view <pkg> time`. */
  readonly publishedAt: string;
  /** `package.json`'s version on main. */
  readonly mainVersion: string;
  /** Commits on main since the published version's tag. Reported, not gating. */
  readonly commitsSincePublish: number;
}

export interface StalenessVerdict {
  readonly stale: boolean;
  readonly daysBehind: number;
  readonly commitsSincePublish: number;
  readonly versionsIndistinguishable: boolean;
  /** Human-readable lines, most important first. */
  readonly report: readonly string[];
}

/**
 * Stall threshold for a lynchpin channel, per `decision-defaults.mdc
 * §Thresholds`. See the docblock above for why this is 10 rather than a number
 * chosen here.
 */
export const MAX_DAYS_BEHIND = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The whole decision, as a pure function of its inputs.
 *
 * `nowMs` is injected with a real default rather than read from the clock
 * inside, so a test can pin the window instead of being a time bomb that fails
 * on a date nobody chose (`testing-standards.mdc §Testable Design → The clock is
 * injected`).
 */
export function assessStaleness(
  inputs: StalenessInputs,
  nowMs: number = Date.now()
): StalenessVerdict {
  const publishedAtMs = Date.parse(inputs.publishedAt);
  if (Number.isNaN(publishedAtMs)) {
    throw new Error(
      `unparseable publishedAt: ${JSON.stringify(inputs.publishedAt)} — refusing to ` +
        `compute a staleness window from it, because an Invalid Date compares false ` +
        `against everything and would silently report "not stale"`
    );
  }

  const daysBehind = Math.floor((nowMs - publishedAtMs) / MS_PER_DAY);
  const versionsIndistinguishable = inputs.publishedVersion === inputs.mainVersion;
  const stale = daysBehind > MAX_DAYS_BEHIND;

  const report: string[] = [
    `published: ${inputs.publishedVersion} (${inputs.publishedAt}, ${daysBehind}d ago)`,
    `main:      ${inputs.mainVersion}`,
    `commits on main since that publish: ${inputs.commitsSincePublish}`,
  ];

  if (stale) {
    report.unshift(
      `STALE: the published package is ${daysBehind} days old, past the ${MAX_DAYS_BEHIND}-day ` +
        `threshold for an install channel. A new user installing today gets that build.`
    );
  } else {
    report.unshift(
      `OK: published ${daysBehind}d ago, within the ${MAX_DAYS_BEHIND}-day threshold.`
    );
  }

  if (versionsIndistinguishable) {
    report.push(
      `NOTE: main and npm both read ${inputs.mainVersion}, so nothing distinguishes ` +
        `in-development code from the published build. "Upgrade to the latest" is ` +
        `already satisfied for a user on a stale install.`
    );
  }

  return {
    stale,
    daysBehind,
    commitsSincePublish: inputs.commitsSincePublish,
    versionsIndistinguishable,
    report,
  };
}

// ---------------------------------------------------------------------------
// Imperative shell: gather the real inputs and print the verdict. Everything
// above is pure and tested; everything below talks to npm and git and is
// exercised by running it.
// ---------------------------------------------------------------------------

const PACKAGE_NAME = "@edobry/minsky";
const SUBPROCESS_TIMEOUT_MS = 30_000;

function run(command: string[]): string {
  const result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`\`${command.join(" ")}\` failed: ${stderr || `exit ${result.exitCode}`}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function gatherInputs(): Promise<StalenessInputs> {
  const publishedVersion = run(["npm", "view", PACKAGE_NAME, "version"]);

  // `npm view <pkg> time` returns a map of version -> ISO timestamp, plus
  // `created` and `modified`. Read the entry for the version we actually
  // resolved rather than `modified`, which moves on any registry-side change.
  const times = JSON.parse(run(["npm", "view", PACKAGE_NAME, "time", "--json"])) as Record<
    string,
    string
  >;
  const publishedAt = times[publishedVersion];
  if (!publishedAt) {
    // Deliberately fatal rather than "resilient". The tempting fallbacks —
    // `times.modified`, `times.created`, or skipping the check — each yield a
    // staleness number that is WRONG rather than absent, and a wrong number
    // here is indistinguishable from a right one at every downstream surface.
    // That is the precise failure this whole check exists to catch, so it must
    // not be the check's own behaviour under anomaly (mem#728: a failed
    // measurement must not be typed as a measurement).
    throw new Error(
      `npm reports latest=${publishedVersion} but its time map has no entry for that ` +
        `version (keys: ${Object.keys(times).join(", ")}). Refusing to guess a date.`
    );
  }

  const mainVersion = (await Bun.file("package.json").json()).version as string;

  // Commits since the published version's tag. A missing tag is reported as -1
  // rather than 0: "no tag" and "no commits since the tag" are different facts,
  // and 0 would read as perfectly in sync.
  let commitsSincePublish = -1;
  const tag = `v${publishedVersion}`;
  const tagExists = Bun.spawnSync(["git", "rev-parse", "--verify", `refs/tags/${tag}`], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: SUBPROCESS_TIMEOUT_MS,
  }).success;
  if (tagExists) {
    commitsSincePublish = Number(run(["git", "rev-list", "--count", `${tag}..HEAD`]));
  }

  return { publishedVersion, publishedAt, mainVersion, commitsSincePublish };
}

if (import.meta.main) {
  const verdict = assessStaleness(await gatherInputs());
  for (const line of verdict.report) console.log(line);
  process.exit(verdict.stale ? 1 : 0);
}
