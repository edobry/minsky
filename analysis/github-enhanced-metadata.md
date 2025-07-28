# GitHub Issues + Enhanced Metadata: Storage Options

## The Challenge

GitHub Issues provide:
- Rich task specifications (markdown, images, discussions)
- Comments and collaboration
- Labels and basic metadata
- Native developer workflow integration

But lack:
- Complex task relationships (parent/child, dependencies)
- Custom fields and structured metadata
- AI-generated insights and embeddings
- Advanced querying capabilities

**Question: Where do we store the enhanced metadata?**

## Storage Options Analysis

### Option 1: Separate Hosted Database

Store enhanced metadata in Supabase/Neon/etc., reference GitHub Issues by ID:

```sql
-- Enhanced metadata table
CREATE TABLE task_metadata (
  github_issue_id INT PRIMARY KEY,
  parent_task_id INT REFERENCES task_metadata(github_issue_id),
  ai_complexity_score FLOAT,
  estimated_hours INT,
  dependencies INT[], -- Array of issue IDs
  embeddings VECTOR(1536), -- For AI features
  minsky_status VARCHAR(50), -- Our enhanced status
  created_at TIMESTAMP
);
```

**Workflow:**
```typescript
// Minsky creates GitHub issue
const issue = await github.issues.create({
  title: "Implement user auth",
  body: "## Specification\n\n..."
});

// Store enhanced metadata separately
await db.insert('task_metadata', {
  github_issue_id: issue.number,
  parent_task_id: 123,
  ai_complexity_score: 0.7,
  dependencies: [124, 125]
});
```

**Pros:**
- Full SQL capabilities
- Fast queries
- Real-time features
- AI vector storage

**Cons:**
- External dependency
- Two-system synchronization
- Backup complexity

### Option 2: GitHub Repository Files

Store metadata as JSON/YAML files in the git repository:

```
your-project/
  ├── src/
  ├── .minsky/
  │   ├── metadata/
  │   │   ├── issue-123.json
  │   │   ├── issue-124.json
  │   │   └── relationships.json
  │   └── config.yaml
  └── README.md
```

**Example metadata file:**
```json
// .minsky/metadata/issue-123.json
{
  "github_issue": 123,
  "parent_task": 122,
  "dependencies": [124, 125],
  "ai_insights": {
    "complexity_score": 0.7,
    "estimated_hours": 8
  },
  "minsky_status": "IN_PROGRESS",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

**Pros:**
- Git backup included
- Version history
- Clone includes metadata
- No external dependencies

**Cons:**
- File coordination issues (back to special workspace)
- Poor query performance
- No real-time updates
- Large repos with many tasks

### Option 3: GitHub Gists

Store metadata in private GitHub Gists:

```typescript
// Create/update gist for task metadata
const gist = await github.gists.create({
  files: {
    'task-metadata.json': {
      content: JSON.stringify(allTaskMetadata)
    }
  },
  public: false
});
```

**Pros:**
- Stays within GitHub ecosystem
- Git versioning via gist
- API access
- No external services

**Cons:**
- Single file for all metadata (scaling issues)
- Not really designed for this use case
- Limited query capabilities

### Option 4: GitHub Issues Custom Fields (Beta)

Use GitHub's newer custom fields and projects:

```typescript
// Use GitHub Projects v2 custom fields
await github.projects.updateItem({
  project_id: projectId,
  item_id: issueNodeId,
  field_values: {
    "Complexity": 7,
    "Parent Task": parentIssueId,
    "AI Confidence": 0.85
  }
});
```

**Pros:**
- Native GitHub feature
- Single source of truth
- GitHub UI integration

**Cons:**
- Limited field types
- Beta/evolving feature
- Tied to GitHub Projects (not all teams use)

### Option 5: Abuse GitHub Issue Body

Encode metadata in hidden sections of issue body:

```markdown
## Task Specification

User authentication system needs...

## Implementation Notes

...

<!-- MINSKY_METADATA
{
  "parent_task": 122,
  "dependencies": [124, 125],
  "ai_complexity": 0.7,
  "embeddings": [0.1, 0.2, ...]
}
-->
```

**Pros:**
- Everything in one place
- No external storage
- Version history via issue edits

**Cons:**
- Hacky approach
- Large metadata bloats issues
- Parsing complexity
- UI pollution

### Option 6: GitHub Repository Database

Store SQLite database in the git repository:

```
your-project/
  ├── src/
  ├── .minsky/
  │   ├── tasks.db        # SQLite database
  │   └── tasks.db.backup # Committed backup
  └── README.md
```

**Sync strategy:**
- SQLite for operations
- Export to SQL/JSON for git commits
- Auto-import on clone/pull

**Pros:**
- Fast SQL queries
- Git backup via exports
- Self-contained

**Cons:**
- Binary files in git
- Merge conflicts on database
- Back to coordination issues

### Option 7: GitHub GraphQL + Local Cache

Use GitHub's rich GraphQL API maximally, cache locally:

```typescript
// Store everything possible in GitHub via GraphQL
const query = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100) {
        nodes {
          id
          number
          title
          body
          labels(first: 10) { nodes { name } }
          projectItems(first: 10) { 
            nodes { 
              fieldValues(first: 10) { nodes { ... } }
            }
          }
        }
      }
    }
  }
`;

// Cache locally for performance, sync with GitHub
```

**Pros:**
- Maximize GitHub native features
- Local performance
- Single source of truth

**Cons:**
- Complex caching logic
- API rate limits
- Limited by GitHub's data model

## Recommended Approach: Hybrid

Based on the analysis, I recommend a **hybrid approach**:

### Phase 1: GitHub Native + Simple Enhancement
```typescript
// Store basic metadata in GitHub Issues + Labels + Projects
// Add simple JSON metadata file per issue in git repo
.minsky/
  metadata/
    issue-123.json  // Simple metadata only
    issue-124.json
```

### Phase 2: Add Hosted Database for Advanced Features
```typescript
// When users need AI features, migrate metadata to hosted DB
// Keep GitHub Issues as source of truth for specs
// Database stores relationships, embeddings, analytics
```

### Phase 3: Full Integration
```typescript
// Bidirectional sync between GitHub and database
// Users choose their preference:
// - GitHub-only (limited features)
// - GitHub + Database (full features)
```

## Summary

For **enhanced metadata storage** with GitHub Issues:

1. **Start simple**: JSON files in git repo (`.minsky/metadata/`)
2. **Upgrade path**: Hosted database when AI features needed
3. **Always preserve**: GitHub Issues as primary spec location
4. **Avoid**: Complex coordination schemes that recreate special workspace problems

The key insight: GitHub Issues solve the task spec problem beautifully. We just need lightweight metadata enhancement, not a complete database replacement.