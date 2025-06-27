#!/bin/bash

# Create a mapping of common circular references to their values
declare -A fixes=(
    ["TEST_VALUE=TEST_VALUE"]="TEST_VALUE=123"
    ["TEST_ARRAY_SIZE=TEST_ARRAY_SIZE"]="TEST_ARRAY_SIZE=3"
    ["COMMIT_HASH_SHORT_LENGTH=COMMIT_HASH_SHORT_LENGTH"]="COMMIT_HASH_SHORT_LENGTH=7"
    ["DEFAULT_HTTP_PORT=DEFAULT_HTTP_PORT"]="DEFAULT_HTTP_PORT=8080"
    ["DEFAULT_DISPLAY_LENGTH=DEFAULT_DISPLAY_LENGTH"]="DEFAULT_DISPLAY_LENGTH=100"
    ["HTTP_NOT_FOUND=HTTP_NOT_FOUND"]="HTTP_NOT_FOUND=404"
    ["HTTP_UNAUTHORIZED=HTTP_UNAUTHORIZED"]="HTTP_UNAUTHORIZED=401"
    ["HTTP_FORBIDDEN=HTTP_FORBIDDEN"]="HTTP_FORBIDDEN=403"
    ["DEFAULT_TIMEOUT_MS=DEFAULT_TIMEOUT_MS"]="DEFAULT_TIMEOUT_MS=5000"
    ["UUID_LENGTH=UUID_LENGTH"]="UUID_LENGTH=36"
    ["SHORT_ID_LENGTH=SHORT_ID_LENGTH"]="SHORT_ID_LENGTH=8"
    ["TEST_ANSWER=TEST_ANSWER"]="TEST_ANSWER=42"
    ["TEST_PORT=DEFAULT_HTTP_PORT"]="TEST_PORT=8080"
    ["SIZE_6=SIZE_6"]="SIZE_6=6"
)

echo "Fixing circular references in codebase..."

# Apply fixes to all TypeScript files
for pattern in "${!fixes[@]}"; do
    replacement="${fixes[$pattern]}"
    echo "Fixing: const $pattern; -> const $replacement;"
    
    # Find and replace in all .ts files
    find src -name "*.ts" -type f -exec sed -i '' "s/const $pattern;/const $replacement;/g" {} \;
done

echo "Fixed circular references. Files affected:"
grep -r "const [A-Z_]* = [A-Z_]*;" src --include="*.ts" | head -10
