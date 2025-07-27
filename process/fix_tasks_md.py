#!/usr/bin/env python3
import re
import os
import glob

# Read the current tasks.md
with open('tasks.md', 'r') as f:
    content = f.read()

# Get all actual task files and create a mapping
task_files = {}
for filepath in sorted(glob.glob('tasks/[0-9]*.md')):
    filename = os.path.basename(filepath)
    task_num = re.match(r'^(\d+)-', filename)
    if task_num:
        task_files[task_num.group(1)] = filepath

# Fix each line in tasks.md
lines = content.split('\n')
fixed_lines = []

for line in lines:
    # Look for task entries with file paths
    match = re.search(r'\[#(\d+)\]\(process/tasks/[^)]+\.md\)', line)
    if match:
        task_num = match.group(1)
        if task_num in task_files:
            # Replace with correct file path
            correct_path = f'process/{task_files[task_num]}'
            line = re.sub(r'\[#' + task_num + r'\]\(process/tasks/[^)]+\.md\)', 
                         f'[#{task_num}]({correct_path})', line)
    fixed_lines.append(line)

# Write the fixed content
with open('tasks.md', 'w') as f:
    f.write('\n'.join(fixed_lines))

print("Fixed all file paths in tasks.md")
