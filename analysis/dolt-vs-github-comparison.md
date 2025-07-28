# Dolt vs GitHub Enhanced: Key Tradeoffs

## Quick Summary

### Dolt Approach

**What**: Use Dolt (git-for-data) as task database + git repo for specs
**Gain over git**: SQL queries on versioned data, semantic diffs, proper branching
**Storage**: Would need DoltHub for best experience (or lose query features with GitHub)
**Separate repo**: Yes - tasks in Dolt repo, specs in git repo

### GitHub Enhanced Approach

**What**: GitHub Issues for specs + lightweight metadata storage
**Enhanced metadata storage**: Start with git repo JSON files, upgrade to hosted DB
**Gain**: Leverage existing workflows, beautiful specs, familiar tools
**Separate repo**: No - everything in main project repo

## Detailed Comparison

| Aspect                   | Dolt                     | GitHub Enhanced                          |
| ------------------------ | ------------------------ | ---------------------------------------- |
| **Learning Curve**       | New tool (Dolt CLI)      | Familiar (GitHub + optional DB)          |
| **Repository Structure** | Two repos (Dolt + Git)   | One repo                                 |
| **Query Power**          | Full SQL on any version  | Limited → Full (with DB upgrade)         |
| **Task Specs**           | Files in git repo        | Rich GitHub Issues                       |
| **Versioning**           | Data-aware diffs         | Text diffs (specs) + metadata versioning |
| **Hosting**              | DoltHub or self-host     | GitHub + optional Supabase               |
| **Team Workflow**        | Git-like but for data    | Native GitHub workflow                   |
| **Backup**               | Dolt native + git export | Git native + DB backup                   |
| **Migration Path**       | Big architectural change | Incremental enhancement                  |

## The Metadata Storage Challenge

For GitHub Enhanced, you asked "where would we store enhanced metadata?" The options:

1. **JSON files in git repo** (.minsky/metadata/) - Simple, versioned, but coordination issues
2. **Hosted database** (Supabase) - Powerful, but external dependency
3. **GitHub Gists** - Stays in GitHub, but scaling issues
4. **GitHub custom fields** - Native, but limited and beta

**Recommended**: Start with #1 (JSON files), upgrade to #2 (hosted DB) when needed.

## Why Dolt Might Not Be Worth It

The Dolt approach is technically elegant but:

1. **Two-repo complexity**: Tasks and specs in different places
2. **Tool adoption barrier**: Team needs to learn Dolt
3. **Hosting dependency**: DoltHub for full features, or lose query interface
4. **Over-engineering**: Adds complexity for questionable benefit over simpler approaches

## Why GitHub Enhanced Is Promising

1. **Familiar workflows**: Teams already use GitHub Issues
2. **Beautiful specs**: Rich markdown, images, discussions
3. **Incremental adoption**: Start simple, add features as needed
4. **One source of truth**: Everything in the main project repo
5. **Migration path**: Clear upgrade from simple → advanced

## Recommendation

**Start with GitHub Enhanced approach**:

- Phase 1: GitHub Issues + simple JSON metadata files
- Phase 2: Add hosted database when AI features needed
- Phase 3: Full bidirectional sync for teams that want it

This provides:

- ✅ Familiar developer workflows
- ✅ Beautiful task specifications
- ✅ Clear upgrade path
- ✅ Lower complexity
- ✅ Single repository

The Dolt approach is fascinating but probably over-engineered for most teams. GitHub Issues already solve the "rich task specs" problem beautifully - we just need to enhance them, not replace them.
