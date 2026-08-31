/**
 * Tests for `trustedGitHubUrl` (mt#4764, PR #3511 R1).
 *
 * The behaviour under test is a REJECTION set, so the cases that matter are the
 * ones that look like github.com and are not. Each rejection below is a URL a
 * naive check could let through, and the consequence of letting one through is
 * an operator clicking a link Minsky told them was GitHub's.
 */
import { describe, it, expect } from "bun:test";
import { trustedGitHubUrl } from "./trusted-url";

describe("trustedGitHubUrl", () => {
  it("accepts the URLs GitHub actually returns", () => {
    // A personal-account installation, and the org form this whole task exists
    // for — the second is the one a constructed path cannot produce.
    expect(trustedGitHubUrl("https://github.com/settings/installations/125403046")).toBe(
      "https://github.com/settings/installations/125403046"
    );
    expect(trustedGitHubUrl("https://github.com/organizations/acme/settings/installations/1")).toBe(
      "https://github.com/organizations/acme/settings/installations/1"
    );
    expect(trustedGitHubUrl("https://github.com/apps/minsky-ai")).toBe(
      "https://github.com/apps/minsky-ai"
    );
  });

  it("rejects hosts that merely LOOK like github.com", () => {
    // The whole reason this parses rather than prefix-matches: each of these
    // reads as github.com to a hurried human.
    expect(trustedGitHubUrl("https://github.com.evil.com/settings/installations/1")).toBeNull();
    expect(trustedGitHubUrl("https://evil.com/github.com/settings/installations/1")).toBeNull();
    expect(trustedGitHubUrl("https://notgithub.com/settings/installations/1")).toBeNull();
    expect(trustedGitHubUrl("https://github.co/settings/installations/1")).toBeNull();
  });

  it("rejects a URL whose credentials disguise the real host", () => {
    // `https://github.com@evil.com/` resolves to evil.com; the text before the
    // `@` is userinfo, not a host. This is the classic disguise.
    expect(trustedGitHubUrl("https://github.com@evil.com/x")).toBeNull();
    expect(trustedGitHubUrl("https://user:pw@github.com/settings/installations/1")).toBeNull();
  });

  it("rejects non-https schemes, including a plain-http downgrade", () => {
    expect(trustedGitHubUrl("http://github.com/settings/installations/1")).toBeNull();
    expect(trustedGitHubUrl("javascript:alert(1)")).toBeNull();
    expect(trustedGitHubUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(trustedGitHubUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects anything that is not a parseable non-empty string", () => {
    expect(trustedGitHubUrl("")).toBeNull();
    expect(trustedGitHubUrl("not a url")).toBeNull();
    expect(trustedGitHubUrl("/settings/installations/1")).toBeNull();
    expect(trustedGitHubUrl(undefined)).toBeNull();
    expect(trustedGitHubUrl(null)).toBeNull();
    expect(trustedGitHubUrl(42)).toBeNull();
    expect(trustedGitHubUrl({ href: "https://github.com/" })).toBeNull();
  });

  it("accepts the www host and is case-insensitive about the host only", () => {
    expect(trustedGitHubUrl("https://www.github.com/apps/minsky-ai")).toBe(
      "https://www.github.com/apps/minsky-ai"
    );
    // Host casing is normalized by URL parsing; the PATH's casing is preserved,
    // because the returned value must be the URL GitHub gave us, unchanged.
    expect(trustedGitHubUrl("https://GitHub.com/Apps/Minsky-AI")).toBe(
      "https://GitHub.com/Apps/Minsky-AI"
    );
  });
});
