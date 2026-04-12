#!/usr/bin/env bash
# PreToolUse hook: block session_pr_merge if no review exists on the PR
# or if the review lacks a spec verification section.
# Ensures code review AND spec verification are complete before merging.

task=$(jq -r '.tool_input.task // empty')
[ -z "$task" ] && exit 0

branch="task/$(echo "$task" | sed 's/#/-/')"
pr=$(gh pr list --repo edobry/minsky --head "$branch" --json number --jq '.[0].number' 2>/dev/null)
[ -z "$pr" ] && exit 0

# Check that at least one review exists
reviews=$(gh api "repos/edobry/minsky/pulls/$pr/reviews" --jq 'length' 2>/dev/null)
if [ "$reviews" = "0" ] || [ -z "$reviews" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"No review on PR #%s. Use /review-pr to submit a review before merging."}}' "$pr"
  exit 0
fi

# Check that at least one review contains spec verification
has_spec=$(gh api "repos/edobry/minsky/pulls/$pr/reviews" --jq '[.[].body] | any(test("Spec verification|spec verification|SPEC VERIFICATION"))' 2>/dev/null)
if [ "$has_spec" != "true" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Review on PR #%s lacks spec verification section. Use /review-pr to post a review that includes spec verification before merging."}}' "$pr"
  exit 0
fi
