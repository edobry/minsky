import { describe, expect, it } from "bun:test";
import { checkToolDenial, toolDenials } from "./block-github-mcp-pr-writes";

describe("checkToolDenial", () => {
  it("denies mcp__github__create_pull_request", () => {
    expect(checkToolDenial("mcp__github__create_pull_request")).not.toBeNull();
  });

  it("denies mcp__github__update_pull_request", () => {
    expect(checkToolDenial("mcp__github__update_pull_request")).not.toBeNull();
  });

  it("denies mcp__github__merge_pull_request", () => {
    expect(checkToolDenial("mcp__github__merge_pull_request")).not.toBeNull();
  });

  it("denies mcp__github__pull_request_review_write", () => {
    expect(checkToolDenial("mcp__github__pull_request_review_write")).not.toBeNull();
  });

  it("allows read-only GitHub tools", () => {
    expect(checkToolDenial("mcp__github__pull_request_read")).toBeNull();
    expect(checkToolDenial("mcp__github__list_pull_requests")).toBeNull();
    expect(checkToolDenial("mcp__github__get_commit")).toBeNull();
    expect(checkToolDenial("mcp__github__search_code")).toBeNull();
  });

  it("allows Minsky tools", () => {
    expect(checkToolDenial("mcp__minsky__session_pr_create")).toBeNull();
    expect(checkToolDenial("mcp__minsky__session_pr_merge")).toBeNull();
    expect(checkToolDenial("mcp__minsky__session_pr_review_submit")).toBeNull();
  });

  it("allows unrelated tools", () => {
    expect(checkToolDenial("Bash")).toBeNull();
    expect(checkToolDenial("Read")).toBeNull();
    expect(checkToolDenial("mcp__plugin_Notion__notion-search")).toBeNull();
  });

  it("denial reason for create references session_pr_create", () => {
    const reason = checkToolDenial("mcp__github__create_pull_request");
    expect(reason).toContain("mcp__minsky__session_pr_create");
  });

  it("denial reason for merge references session_pr_merge and mt#1030", () => {
    const reason = checkToolDenial("mcp__github__merge_pull_request");
    expect(reason).toContain("mcp__minsky__session_pr_merge");
    expect(reason).toContain("mt#1030");
  });

  it("denial reason for review write references session_pr_review_submit", () => {
    const reason = checkToolDenial("mcp__github__pull_request_review_write");
    expect(reason).toContain("mcp__minsky__session_pr_review_submit");
  });

  it("all toolDenials entries have non-empty reason strings", () => {
    for (const rule of toolDenials) {
      expect(rule.reason.length).toBeGreaterThan(0);
    }
  });
});
