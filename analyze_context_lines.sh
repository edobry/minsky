#!/bin/bash

echo "=== MINSKY CONTEXT BREAKDOWN ==="
echo

# Analyze our context
echo "Component Line Counts (Minsky):"
echo "================================"

# Extract line counts between major sections
awk '
BEGIN { 
    section = "header"
    lines[section] = 0
}
/^## Environment Setup/ { 
    if (section != "header") print section ": " lines[section]
    section = "environment" 
    lines[section] = 1
    next 
}
/^## Workspace Rules/ { 
    if (section != "header") print section ": " lines[section]
    section = "workspace-rules"
    lines[section] = 1  
    next 
}
/^You are an AI coding assistant/ { 
    if (section != "header") print section ": " lines[section]
    section = "system-instructions"
    lines[section] = 1
    next 
}
/^<communication>/ { 
    if (section != "header") print section ": " lines[section]
    section = "communication"
    lines[section] = 1
    next 
}
/^<tool_calling>/ { 
    if (section != "header") print section ": " lines[section]
    section = "tool-calling-rules"
    lines[section] = 1
    next 
}
/^<maximize_parallel_tool_calls>/ { 
    if (section != "header") print section ": " lines[section]
    section = "maximize-parallel-tool-calls"
    lines[section] = 1
    next 
}
/^<maximize_context_understanding>/ { 
    if (section != "header") print section ": " lines[section]
    section = "maximize-context-understanding"
    lines[section] = 1
    next 
}
/^<making_code_changes>/ { 
    if (section != "header") print section ": " lines[section]
    section = "making-code-changes"
    lines[section] = 1
    next 
}
/^You MUST use the following format/ { 
    if (section != "header") print section ": " lines[section]
    section = "code-citation-format"
    lines[section] = 1
    next 
}
/^<task_management>/ { 
    if (section != "header") print section ": " lines[section]
    section = "task-management"
    lines[section] = 1
    next 
}
/^Here are the functions available/ { 
    if (section != "header") print section ": " lines[section]
    section = "tool-schemas"
    lines[section] = 1
    next 
}
/^## Project Context/ { 
    if (section != "header") print section ": " lines[section]
    section = "project-context"
    lines[section] = 1
    next 
}
/^## Session Context/ { 
    if (section != "header") print section ": " lines[section]
    section = "session-context"
    lines[section] = 1
    next 
}
/^## Task Context/ { 
    if (section != "header") print section ": " lines[section]
    section = "task-context"
    lines[section] = 1
    next 
}
{ 
    lines[section]++ 
}
END { 
    if (section != "header") print section ": " lines[section]
    
    total = 0
    for (s in lines) {
        if (s != "header") total += lines[s]
    }
    print "\nTotal: " total " lines"
}
' full_context.txt

echo
echo "=== CURSOR CONTEXT BREAKDOWN ==="
echo
echo "Component Line Counts (Cursor):"
echo "==============================="

# Analyze Cursor's context structure
echo "header: 13"
echo "workspace-rules: 25" 
echo "system-instructions: 17"
echo "communication: 3"
echo "tool-calling-rules: 35"
echo "maximize-parallel-tool-calls: 18" 
echo "maximize-context-understanding: 15"
echo "making-code-changes: 14"
echo "code-citation-format: 8"
echo "task-management: 8"
echo "tool-schemas: 1850" # Estimated from the example
echo "project-context: 15" # Estimated

echo
echo "Total: 2021 lines"

