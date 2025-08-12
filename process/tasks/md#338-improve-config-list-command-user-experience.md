# Improve config list command user experience

## Context

The config list command currently shows raw key-value pairs with many null/empty values, making it difficult to read and understand actual configuration.

CURRENT ISSUES:

- Shows (null) and (empty array) for every unconfigured option
- Flat key=value format is hard to scan
- No filtering or organization of output
- Overwhelming amount of irrelevant information

IMPROVEMENTS NEEDED:

- Filter out (null) and (empty array) values by default
- Add --include-defaults flag to show everything when needed
- Improve formatting to be more readable (structured sections like config show)
- Add --format option for different output styles
- Consider hierarchical display instead of flat dotted keys
- Show only configured/relevant settings by default

GOAL: Make config list as user-friendly as the enhanced config show command

## Requirements

## Solution

## Notes
