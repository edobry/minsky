#!/bin/bash

echo "=== FINAL CONTEXT COMPARISON: MINSKY vs CURSOR ==="
echo

# Line counts
echo "=== LINE COUNTS ==="
echo "Cursor context: $(wc -l < /Users/edobry/Projects/minsky/full-ai-prompt-complete-verbatim-2025-01-27.md)"
echo "Minsky context: $(wc -l < current_context_output.txt)"
echo

# Section presence analysis
echo "=== SECTION ALIGNMENT ==="
echo

echo "Cursor sections found in our output:"
grep -i "## Environment Setup" current_context_output.txt > /dev/null && echo "✅ Environment Setup" || echo "❌ Environment Setup"
grep -i "workspace.*rules" current_context_output.txt > /dev/null && echo "✅ Workspace Rules" || echo "❌ Workspace Rules"  
grep -i "system.*instructions" current_context_output.txt > /dev/null && echo "✅ System Instructions" || echo "❌ System Instructions"
grep -i "communication" current_context_output.txt > /dev/null && echo "✅ Communication" || echo "❌ Communication"
grep -i "tool.*calling" current_context_output.txt > /dev/null && echo "✅ Tool Calling Rules" || echo "❌ Tool Calling Rules"
grep -i "parallel.*tool" current_context_output.txt > /dev/null && echo "✅ Maximize Parallel Tool Calls" || echo "❌ Maximize Parallel Tool Calls"
grep -i "context.*understanding" current_context_output.txt > /dev/null && echo "✅ Maximize Context Understanding" || echo "❌ Maximize Context Understanding"
grep -i "making.*code.*changes" current_context_output.txt > /dev/null && echo "✅ Making Code Changes" || echo "❌ Making Code Changes"
grep -i "code.*citation" current_context_output.txt > /dev/null && echo "✅ Code Citation Format" || echo "❌ Code Citation Format"
grep -i "task.*management" current_context_output.txt > /dev/null && echo "✅ Task Management" || echo "❌ Task Management"
grep -i "tool.*schemas\|functions.*available" current_context_output.txt > /dev/null && echo "✅ Tool Schemas" || echo "❌ Tool Schemas"
grep -i "git.*status\|project.*context" current_context_output.txt > /dev/null && echo "✅ Project Context" || echo "❌ Project Context"

echo
echo "Minsky-specific sections (not in Cursor):"
grep -i "session.*context" current_context_output.txt > /dev/null && echo "⭐ Session Context (Minsky enhancement)" || echo "○ Session Context"

echo

# Format comparison
echo "=== FORMAT ANALYSIS ==="
echo

echo "Tool schema format:"
if grep -q "Here are the functions available in JSONSchema format:" current_context_output.txt; then
    echo "✅ Matches Cursor's tool schema header"
else
    echo "❌ Tool schema header mismatch"
fi

if grep -A5 "Here are the functions available" current_context_output.txt | grep -q "{"; then
    echo "✅ JSON format detected"
else
    echo "❌ JSON format not detected"
fi

echo
echo "Environment format:"
if grep -A5 "## Environment Setup" current_context_output.txt | grep -q "OS Version:"; then
    echo "✅ Environment format matches Cursor structure"
else
    echo "❌ Environment format mismatch"
fi

echo
