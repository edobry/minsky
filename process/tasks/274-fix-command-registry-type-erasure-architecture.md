# Fix Command Registry Type Erasure Architecture

## Status

BACKLOG

## Priority

MEDIUM

## Description

The SharedCommand interface intentionally erases types 'for easier use in bridge implementations' which forces type casting throughout the codebase. The system converts properly typed command definitions to 'any' types, then requires type casting at every usage point. This architectural decision should be reversed to enable proper type safety with generic command definitions that preserve type information through the entire execution chain.

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
