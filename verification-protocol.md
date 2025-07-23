# MANDATORY VERIFICATION PROTOCOL

## Before Making ANY Task Completion Claims

### 🔴 STOP - Run These Commands First:

```bash
# 1. Measure actual current state
find src -name "*.ts" -exec wc -l {} + | awk '$1 >= 400 {print $1, $2}' | sort -nr

# 2. Count files over threshold
find src -name "*.ts" -exec wc -l {} + | awk '$1 >= 400' | wc -l

# 3. Check specific file mentioned in claims
wc -l [file claimed to be reduced]

# 4. Verify modules exist
ls -la [directory where modules should be]

# 5. Check if extractions are used
grep -n "import.*[module-name]" [main-file]
grep -n "export.*function.*[original-function]" [main-file]
```

### 🟡 ANALYZE - What to Look For:

1. **Size Claims vs Reality**
   - Claimed: "File X reduced from Y to Z lines"
   - Reality: `wc -l file.ts` shows actual lines
   - If mismatch → STOP and investigate

2. **Module Integration**
   - Modules exist ≠ Modules are used
   - Check for thin wrapper pattern
   - Original functions should delegate, not implement

3. **Task Spec vs Code State**
   - Task spec = historical claims
   - Code = current truth
   - NEVER trust spec over code

### 🟢 LANGUAGE - How to Communicate:

#### When Verified:
"Verification shows [specific file] is currently [X] lines, with [Y] extracted modules actively imported and used."

#### When Unverified:
"The task spec claims [X], but I need to verify the current state before confirming."

#### When Discrepancy Found:
"Task spec claims [X], but current measurements show [Y]. The modularization appears incomplete."

### ⚠️ RED FLAGS - Immediate Verification Required:

- Any use of "completed", "done", "finished"
- Percentage reduction claims
- "World-class", "exceptional", "mastery"
- Task status changes
- Celebration language

### 📋 Verification Checklist:

- [ ] Ran file size measurements
- [ ] Checked specific files mentioned
- [ ] Verified modules exist AND are imported
- [ ] Compared claims to actual measurements
- [ ] Used evidence-based language
- [ ] Avoided premature celebration

## Remember: Trust Code, Not Claims