#!/bin/bash

# Script to reclaim space across all Minsky sessions using bun hardlink backend
echo "🚀 Starting space reclamation across all Minsky sessions..."

SESSIONS_DIR="/Users/edobry/.local/state/minsky/sessions"
TOTAL_BEFORE=0
TOTAL_AFTER=0
PROCESSED=0

echo "📊 Measuring current usage..."
TOTAL_BEFORE=$(du -sk "$SESSIONS_DIR" | cut -f1)
echo "Total space before: $(($TOTAL_BEFORE / 1024))MB"

echo ""
echo "🔄 Processing sessions..."

for session_dir in "$SESSIONS_DIR"/*; do
    if [ -d "$session_dir" ] && [ -f "$session_dir/package.json" ]; then
        SESSION_NAME=$(basename "$session_dir")
        echo "Processing session: $SESSION_NAME"
        
        cd "$session_dir"
        
        # Check if node_modules exists and get its size
        if [ -d "node_modules" ]; then
            BEFORE_SIZE=$(du -sk node_modules | cut -f1)
            echo "  Before: $(($BEFORE_SIZE / 1024))MB"
            
            # Remove and reinstall with hardlink backend
            rm -rf node_modules
            if bun install --backend hardlink --silent 2>/dev/null; then
                AFTER_SIZE=$(du -sk node_modules | cut -f1)
                SAVED=$(($BEFORE_SIZE - $AFTER_SIZE))
                echo "  After: $(($AFTER_SIZE / 1024))MB (saved: $(($SAVED / 1024))MB)"
                PROCESSED=$((PROCESSED + 1))
            else
                echo "  ❌ Failed to reinstall"
            fi
        else
            echo "  ⏭️  No node_modules found"
        fi
        echo ""
    fi
done

echo "📈 Final Results:"
TOTAL_AFTER=$(du -sk "$SESSIONS_DIR" | cut -f1)
TOTAL_SAVED=$(($TOTAL_BEFORE - $TOTAL_AFTER))

echo "Sessions processed: $PROCESSED"
echo "Total space before: $(($TOTAL_BEFORE / 1024))MB"
echo "Total space after: $(($TOTAL_AFTER / 1024))MB" 
echo "Total space saved: $(($TOTAL_SAVED / 1024))MB"
echo "Space savings: $(($TOTAL_SAVED * 100 / $TOTAL_BEFORE))%"

echo ""
echo "✅ Space reclamation complete!"
echo "💡 All future 'bun install' commands will use hardlinks automatically."
