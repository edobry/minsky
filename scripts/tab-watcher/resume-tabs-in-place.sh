#!/usr/bin/env bash
#
# resume-tabs-in-place.sh — for each open iTerm tab, identify the matching
# Claude Code session by tab title + cwd, and resume that session in-place via
# `claude --resume <sid>`. Existing tabs / order / scrollback are preserved.
#
# Sister to restore-sessions.sh, which OPENS NEW tabs from recent sessions.
# This script MATCHES existing tabs to recent sessions and resumes them
# in place — useful after macOS / iTerm restored the tab structure but the
# Claude processes died (e.g. after a forced restart).
#
# Usage:
#   resume-tabs-in-place.sh                   # dry-run preview
#   resume-tabs-in-place.sh --execute         # actually write resume cmds
#   resume-tabs-in-place.sh --since "2 days ago"
#   resume-tabs-in-place.sh --exclude <sid-prefix>
#   resume-tabs-in-place.sh --no-auto-exclude # don't skip live sessions
#
# Auto-exclusion: any session id present in ~/.claude/sessions/<pid>.json
# (i.e. a currently-running claude) is skipped automatically. Disable with
# --no-auto-exclude.
#
# Background: ~/.claude/projects/-Users-edobry-Projects-minsky/memory/reference_claude_code_recovery.md

set -euo pipefail

SINCE="2 days ago"
EXECUTE=0
EXCLUDES=()
NO_AUTO_EXCLUDE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)            SINCE="$2"; shift 2 ;;
    --execute)          EXECUTE=1; shift ;;
    --exclude)          EXCLUDES+=("$2"); shift 2 ;;
    --no-auto-exclude)  NO_AUTO_EXCLUDE=1; shift ;;
    -h|--help)
      sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

PROJECTS_DIR="$HOME/.claude/projects"
SESSIONS_DIR="$HOME/.claude/sessions"

# 0. Auto-exclude session ids of any currently-running claude.
if (( ! NO_AUTO_EXCLUDE )); then
  while IFS= read -r live_sid; do
    [[ -n "$live_sid" ]] && EXCLUDES+=("$live_sid")
  done < <(
    python3 - "$SESSIONS_DIR" <<'PY'
import json, os, sys
d = sys.argv[1]
if not os.path.isdir(d):
    sys.exit(0)
for f in sorted(os.listdir(d)):
    p = os.path.join(d, f)
    if not f.endswith(".json"):
        continue
    try:
        sid = json.load(open(p)).get("sessionId", "")
    except Exception:
        continue
    if sid:
        print(sid)
PY
  )
fi

# 1. Enumerate iTerm tabs.
tabs_tsv=$(osascript <<'OSA'
tell application "iTerm"
  set out to ""
  set winCount to count of windows
  repeat with w from 1 to winCount
    tell window w
      set tabCount to count of tabs
      repeat with t from 1 to tabCount
        tell tab t
          tell current session
            set sName to name
            try
              set sPath to (variable named "session.path")
            on error
              set sPath to ""
            end try
            set out to out & w & "|||" & t & "|||" & sPath & "|||" & sName & linefeed
          end tell
        end tell
      end repeat
    end tell
  end repeat
  return out
end tell
OSA
)

if [[ -z "${tabs_tsv// /}" ]]; then
  echo "No iTerm tabs found." >&2
  exit 1
fi

# 2. Index recent session jsonls (top-level only; depth 2).
#
# `-newermt` is NOT GNU-only, despite reading that way. BSD find implements the
# whole `-newerXY` family, and `Y=t` means "interpret the argument as a direct
# date specification" — see find(1) on macOS. Verified behaviorally on Darwin
# 24.5.0 (mt#3873, PR #2980 R1, flagged BLOCKING there): this exact invocation
# returned 76 matches and exit 0. Do not "port" it to a stat/awk loop on the
# theory that it is a portability defect; it is not one, and the redirect below
# would hide a real breakage, which is what makes the claim plausible on sight.
session_files=()
while IFS= read -r path; do
  [[ -n "$path" ]] && session_files+=("$path")
done < <(
  find "$PROJECTS_DIR" -mindepth 2 -maxdepth 2 -name "*.jsonl" \
    -newermt "$SINCE" -print 2>/dev/null
)

if [[ ${#session_files[@]} -eq 0 ]]; then
  echo "No sessions modified since: $SINCE" >&2
  exit 1
fi

# 3+4. Match tabs → sessions; emit preview + plan file.
PLAN_FILE=$(mktemp -t resume-tabs-plan.XXXXXX)
trap 'rm -f "$PLAN_FILE"' EXIT

python3 - "$tabs_tsv" "$PLAN_FILE" "${#EXCLUDES[@]}" "${EXCLUDES[@]:-_NONE_}" "${session_files[@]}" <<'PY'
import json, os, re, sys, time

tabs_tsv = sys.argv[1]
plan_path = sys.argv[2]
exclude_count = int(sys.argv[3])
i = 4
excludes = sys.argv[i:i+exclude_count] if exclude_count else []
i += exclude_count
session_files = sys.argv[i:]
# Filter sentinel
excludes = [e for e in excludes if e and e != "_NONE_"]

SYSREM = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
# Common iTerm-set status icons + leading whitespace
ICON = re.compile(r"^[✨✳✴✵✷✸⠇⠂⠘⠒⠊⠋⠚⠛⠞⠟⠰⠲⠦⠴⠶⠨⠮⋮…⋯]+\s*", re.U)
# Trailing shell suffix " (-zsh)", " (bun)", " (-bash)" etc.
SUFFIX = re.compile(r"\s*\([-_a-zA-Z0-9]+\)\s*$")

def normalize(s):
    s = ICON.sub("", s)
    s = SUFFIX.sub("", s)
    s = " ".join(s.split())
    return s.lower()

# Build session index.
sessions = []
for f in session_files:
    sid = os.path.basename(f)[:-6]
    if any(sid.startswith(ex) for ex in excludes):
        continue
    cwd = ""
    first_user = ""
    ai_title = ""
    try:
        with open(f, "r", errors="replace") as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if not cwd and d.get("cwd"):
                    cwd = d["cwd"]
                if d.get("aiTitle"):
                    ai_title = d["aiTitle"]  # take last; aiTitle may be regenerated
                if not first_user:
                    msg = d.get("message") or {}
                    if msg.get("role") == "user":
                        c = msg.get("content")
                        if isinstance(c, str):
                            first_user = c
                        elif isinstance(c, list):
                            for p in c:
                                if isinstance(p, dict) and p.get("type") == "text":
                                    first_user = p.get("text", "")
                                    break
    except OSError:
        continue
    first_user = SYSREM.sub("", first_user)
    first_user_clean = " ".join(first_user.split())
    norm_first = normalize(first_user_clean)
    norm_title = normalize(ai_title) if ai_title else ""
    try:
        mtime = os.path.getmtime(f)
    except OSError:
        mtime = 0
    # display preview: prefer aiTitle, else first prompt
    preview = ai_title if ai_title else first_user_clean
    sessions.append((mtime, sid, cwd, norm_title, norm_first, preview))

# Most recent first; first match wins among candidates.
sessions.sort(reverse=True)
# Prevent two tabs from being matched to the same session.
used_sids = set()

def find_match(tab_title_norm, tab_cwd):
    if not tab_title_norm:
        return None, []
    cands = sessions
    if tab_cwd:
        cwd_filter = [s for s in sessions if s[2] == tab_cwd]
        if cwd_filter:
            cands = cwd_filter
    # 1) Exact match on aiTitle (case-insensitive, normalized).
    matches = [s for s in cands
               if s[1] not in used_sids and s[3] and s[3] == tab_title_norm]
    if matches:
        return matches[0], matches
    # 2) Prefix match on aiTitle (handles iTerm display truncation).
    matches = [s for s in cands
               if s[1] not in used_sids and s[3]
               and (s[3].startswith(tab_title_norm) or tab_title_norm.startswith(s[3]))
               and min(len(tab_title_norm), len(s[3])) >= 8]
    if matches:
        return matches[0], matches
    # 3) Fallback: prefix match on first user message (legacy
    #    restore-sessions.sh behavior — title set from first 40 chars).
    matches = []
    for s in cands:
        _, sid, _, _, sn_first, _ = s
        if sid in used_sids or not sn_first:
            continue
        n = min(len(tab_title_norm), len(sn_first), 38)
        if n < 8:
            continue
        if sn_first[:n] == tab_title_norm[:n]:
            matches.append(s)
    if matches:
        return matches[0], matches
    return None, []

# Walk tabs.
out_rows = []
for line in tabs_tsv.split("\n"):
    line = line.rstrip("\r")
    if not line.strip():
        continue
    parts = line.split("|||")
    if len(parts) < 4:
        continue
    win, tab, cwd, name = parts[0], parts[1], parts[2], parts[3]
    norm = normalize(name)
    match, all_matches = find_match(norm, cwd)
    if match:
        mtime, sid, scwd, _, _, preview = match
        used_sids.add(sid)
        when = time.strftime("%m-%d %H:%M", time.localtime(mtime))
        ambig = " AMBIG" if len(all_matches) > 1 else ""
        out_rows.append((win, tab, "MATCH" + ambig, sid, scwd, name, preview, when))
    else:
        out_rows.append((win, tab, "SKIP", "", cwd, name, "", ""))

# Preview.
print("Tab → Session matches:")
print()
hdr = f"{'tab':<6}  {'status':<11}  {'sid':<8}  {'when':<11}  {'tab title':<54}  {'first prompt':<48}"
print(hdr)
print("-" * len(hdr))
matched = unmatched = 0
for r in out_rows:
    win, tab, status, sid, cwd, name, preview, when = r
    short_sid = sid[:8] if sid else ""
    name_disp = name if len(name) <= 54 else name[:52] + ".."
    prev_disp = preview if len(preview) <= 48 else preview[:46] + ".."
    print(f"{win+'.'+tab:<6}  {status:<11}  {short_sid:<8}  {when:<11}  {name_disp:<54}  {prev_disp:<48}")
    if status.startswith("MATCH"):
        matched += 1
    else:
        unmatched += 1
print()
print(f"matched: {matched}    skipped: {unmatched}")

# Plan file: tab-separated win, tab, sid, cwd.
with open(plan_path, "w") as pf:
    for r in out_rows:
        win, tab, status, sid, cwd, name, preview, when = r
        if status.startswith("MATCH"):
            pf.write(f"{win}\t{tab}\t{sid}\t{cwd}\n")
PY

# 5. Apply if --execute.
if (( ! EXECUTE )); then
  echo
  echo "Dry run. Re-run with --execute to apply."
  exit 0
fi

if [[ ! -s "$PLAN_FILE" ]]; then
  echo "No matched tabs to resume." >&2
  exit 0
fi

echo
echo "Applying..."
applied=0
while IFS=$'\t' read -r win tab sid cwd; do
  [[ -z "$win" ]] && continue
  cwd_esc=${cwd//\'/\'\\\'\'}
  osascript <<OSA
tell application "iTerm"
  tell window $win
    tell tab $tab
      tell current session
        write text "cd '$cwd_esc' && claude --resume $sid"
      end tell
    end tell
  end tell
end tell
OSA
  applied=$((applied + 1))
done < "$PLAN_FILE"

echo "Applied: $applied tab(s)"
