#!/bin/bash

echo "=== DETAILED CONTENT COMPARISON ==="
echo

# Component line counts
echo "=== COMPONENT-BY-COMPONENT ANALYSIS ==="
echo

# Analyze environment section
env_lines=$(sed -n '/## Environment Setup/,/^## /p' current_context_output.txt | head -n -1 | wc -l)
echo "Environment: $env_lines lines"

# Analyze workspace rules
rules_lines=$(sed -n '/<rules>/,/<\/rules>/p' current_context_output.txt | wc -l)
echo "Workspace Rules: $rules_lines lines"

# Analyze tool schemas  
tool_start=$(grep -n "Here are the functions available" current_context_output.txt | cut -d: -f1)
if [ ! -z "$tool_start" ]; then
    next_section=$(tail -n +$((tool_start + 1)) current_context_output.txt | grep -n "^## " | head -1 | cut -d: -f1)
    if [ ! -z "$next_section" ]; then
        tool_lines=$((next_section - 1))
    else
        tool_lines=$(tail -n +$tool_start current_context_output.txt | wc -l)
    fi
    echo "Tool Schemas: $tool_lines lines"
fi

echo
echo "=== CONTENT QUALITY CHECKS ==="
echo

# Check for specific Cursor content patterns
echo "Key content pattern checks:"

# Environment content
if grep -A3 "## Environment Setup" current_context_output.txt | grep -q "darwin\|macOS"; then
    echo "✅ Environment includes OS detection"
else
    echo "❌ Environment missing OS details"
fi

# Tool schema content
tool_count=$(grep -o '"[^"]*": {' current_context_output.txt | wc -l)
echo "✅ Tool schemas contain $tool_count tools"

# Workspace rules content
if grep -i "agent.requestable\|always.applied" current_context_output.txt > /dev/null; then
    echo "✅ Workspace rules include requestable/applied sections"
else
    echo "❌ Workspace rules missing structure"
fi

echo
echo "=== DIVERGENCE ANALYSIS ==="
echo

# Check for extra content
echo "Content additions beyond Cursor:"
if grep -i "Generated at:" current_context_output.txt > /dev/null; then
    echo "• Generation timestamp metadata"
fi

if grep -i "Components:" current_context_output.txt > /dev/null; then
    echo "• Component listing metadata"  
fi

if grep -i "Template:" current_context_output.txt > /dev/null; then
    echo "• Template information"
fi

if grep -i "Target Model:" current_context_output.txt > /dev/null; then
    echo "• Model targeting info"
fi

if grep -i "Session Context" current_context_output.txt > /dev/null; then
    echo "• Session context (Minsky enhancement)"
fi

echo
echo "=== STRUCTURAL COMPARISON ==="
echo

echo "Section order analysis:"
grep "^## " current_context_output.txt | nl -w2 -s'. '

