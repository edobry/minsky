# Test Migration Tool

A CLI tool for automatically migrating Jest/Vitest tests to Bun test patterns.

## Overview

This tool was created to help migrate an existing codebase from Jest/Vitest testing frameworks to Bun's native test runner. It analyzes test files, identifies patterns that need migration, and can automatically transform the code.

## Features

- **Analyze**: Scan test files to identify migration targets
- **Migrate**: Automatically transform test syntax from Jest/Vitest to Bun
- **Batch**: Process multiple files with verification and rollback capabilities

## Usage

### Installation

```bash
bun install
```

### Commands

#### Analyze test files

```bash
bun test-migration.ts analyze <files>
```

#### Migrate test files

```bash
bun test-migration.ts migrate <files> [options]
```

#### Batch process

```bash
bun test-migration.ts batch <files> [options]
```

See `test-migration.md` for detailed documentation.

## History

This tool was extracted from the [Minsky project](https://github.com/user/minsky) after successfully completing the migration of all tests to Bun. It's preserved here for reference and potential reuse in other projects.

## License

Inherited from the original Minsky project.
