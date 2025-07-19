#!/bin/bash
echo "Checking for 'as unknown' patterns in session workspace..."
echo "Working directory: $(pwd)"
echo

# Count patterns
COUNT=$(find . -name "*.ts" -exec grep -l "as unknown" {} \; 2>/dev/null | wc -l | tr -d ' ')
echo "Files with 'as unknown': $COUNT"

# Show any remaining patterns
echo
echo "Remaining patterns:"
find . -name "*.ts" -exec grep -n "as unknown" {} + 2>/dev/null || echo "No patterns found" 
