import json
import re

# Read Cursor's context
with open('/Users/edobry/Projects/minsky/full-ai-prompt-complete-verbatim-2025-01-27.md', 'r') as f:
    cursor_content = f.read()

# Extract the JSON section from Cursor
json_start = cursor_content.find('```json\n{')
json_end = cursor_content.find('\n```', json_start)
cursor_json_str = cursor_content[json_start+8:json_end]

# Parse JSON
try:
    cursor_tools = json.loads(cursor_json_str)
    print(f"CURSOR TOOLS: {len(cursor_tools)} tools")
    print("First 10 tools:", list(cursor_tools.keys())[:10])
except Exception as e:
    print(f"Failed to parse Cursor JSON: {e}")

# Now check our output
try:
    with open('actual_output.txt', 'r') as f:
        our_content = f.read()
    
    # Find our JSON section
    json_start = our_content.find('{\n  "')
    if json_start == -1:
        print("Could not find JSON start in our output")
    else:
        # Try to extract just the JSON
        brace_count = 0
        start_pos = json_start
        for i, char in enumerate(our_content[json_start:]):
            if char == '{':
                brace_count += 1
            elif char == '}':
                brace_count -= 1
                if brace_count == 0:
                    our_json_str = our_content[json_start:json_start+i+1]
                    break
        
        our_tools = json.loads(our_json_str)
        print(f"OUR TOOLS: {len(our_tools)} tools")
        print("First 10 tools:", list(our_tools.keys())[:10])
        
except Exception as e:
    print(f"Failed to parse our JSON: {e}")
