# Dolt Deep Dive: Git for Task Data

## How Dolt Would Work

### Repository Structure Options

#### Option 1: Separate Dolt Repo

```
your-project/           # Git repo (code)
your-project-tasks/     # Dolt repo (tasks)
  ├── .dolt/           # Dolt metadata
  ├── tasks.sql        # Schema
  └── specs/           # Task spec files
```

#### Option 2: Embedded Dolt in Git

```
your-project/          # Git repo
  ├── src/            # Code
  ├── .dolt/          # Dolt database (gitignored?)
  ├── tasks-export/   # Exported SQL for git backup
  └── specs/          # Task specs
```

#### Option 3: Hybrid Approach

```
your-project/          # Git repo
  ├── src/           # Code
  ├── tasks.sql      # Exported task data (committed)
  └── specs/         # Task specs (committed)

# Plus separate Dolt repo for live operations
your-project-dolt/     # Dolt repo (not in git)
```

## What We Gain Over Git

### 1. **Structured Diff/Merge**

```sql
-- Git shows file changes:
- [ ] Task 1
+ [x] Task 1

-- Dolt shows semantic changes:
UPDATE tasks SET status = 'DONE' WHERE id = 1;
```

### 2. **SQL Queries on History**

```sql
-- Who completed the most tasks last month?
SELECT assignee, COUNT(*)
FROM tasks
WHERE status = 'DONE'
  AND AS OF '2024-01-01' status != 'DONE'
GROUP BY assignee;

-- What was the task graph on January 1st?
SELECT * FROM task_dependencies AS OF '2024-01-01';
```

### 3. **Branching Database State**

```bash
# Create feature branch in database
dolt checkout -b feature/add-ai-tasks

# Add AI-related tasks in isolation
dolt sql -q "INSERT INTO tasks ..."

# Merge back to main when ready
dolt checkout main
dolt merge feature/add-ai-tasks
```

### 4. **Collaborative Database Development**

```bash
# Alice adds tasks
dolt add .
dolt commit -m "Add user authentication tasks"
dolt push origin main

# Bob pulls changes
dolt pull origin main
# Gets Alice's tasks automatically
```

## GitHub vs DoltHub

### DoltHub (Dolt's service)

```bash
# Create hosted Dolt database
dolt remote add origin dolthub.com/team/project-tasks

# Web interface for SQL queries
# https://dolthub.com/team/project-tasks

# Pull requests for database changes
# Diff viewer for data changes
```

**Advantages:**

- Native Dolt support
- SQL query interface in browser
- Data diffs and PRs
- Free hosting for public repos

**Disadvantages:**

- Another service to depend on
- Less familiar than GitHub
- Smaller ecosystem

### GitHub Integration Options

#### Option A: Export to GitHub

```bash
# Daily export to git repo
dolt dump | git commit -F -
# Backup in GitHub, operations in Dolt
```

#### Option B: Dolt Files in GitHub

```bash
# Commit Dolt database files directly
git add .dolt/
git commit -m "Update task database"
```

**Problem**: Binary files, huge commits, lose query interface

#### Option C: Hybrid Workflow

- **Live operations**: DoltHub for team collaboration
- **Backup**: Automated exports to GitHub
- **Specs**: Task specs in GitHub repo alongside code

## Practical Workflow Example

### Setup

```bash
# Initialize Dolt database for tasks
dolt init
dolt remote add origin dolthub.com/team/project-tasks

# Create schema
dolt sql -q "
CREATE TABLE tasks (
  id INT PRIMARY KEY,
  title VARCHAR(255),
  status ENUM('TODO', 'IN_PROGRESS', 'DONE'),
  spec_path VARCHAR(255),  -- Points to file in git repo
  created_at TIMESTAMP
);
"
dolt add .
dolt commit -m "Initial schema"
dolt push origin main
```

### Team Development

```bash
# Developer creates feature branch
dolt checkout -b feature/auth-system

# Add related tasks
dolt sql -q "
INSERT INTO tasks (title, status, spec_path) VALUES
  ('Design login UI', 'TODO', 'specs/auth/login-ui.md'),
  ('Implement JWT', 'TODO', 'specs/auth/jwt.md'),
  ('Add password reset', 'TODO', 'specs/auth/password-reset.md');
"

# Meanwhile, task specs go in git repo
echo "# Login UI Spec..." > specs/auth/login-ui.md
git add specs/auth/
git commit -m "Add auth task specifications"
```

### Integration Points

```typescript
// Minsky connects to both
const doltDB = new DoltClient("dolthub.com/team/project-tasks");
const gitSpecs = new GitClient("github.com/team/project");

// Query tasks from Dolt
const tasks = await doltDB.query('SELECT * FROM tasks WHERE status = "TODO"');

// Load specs from git
for (const task of tasks) {
  task.spec = await gitSpecs.readFile(task.spec_path);
}
```

## Comparison: Dolt vs Special Workspace

| Aspect             | Dolt                      | Special Workspace    |
| ------------------ | ------------------------- | -------------------- |
| **Coordination**   | Native database branching | File locks + git     |
| **Queries**        | SQL on any version        | File parsing only    |
| **History**        | Semantic diffs            | Text diffs           |
| **Merging**        | Data-aware merges         | Text merge conflicts |
| **Learning curve** | New tool (Dolt)           | Git concepts         |
| **Hosting**        | DoltHub or self-host      | Any git host         |

## Challenges with Dolt Approach

### 1. **Two-Repo Complexity**

- Tasks in Dolt repo
- Specs in Git repo
- Need to keep them synchronized
- More complex onboarding

### 2. **Tool Dependencies**

- Team needs Dolt CLI installed
- Another tool to learn
- Smaller community than git

### 3. **Hosting Questions**

- DoltHub for full features
- Or lose query interface with GitHub
- Backup strategy for Dolt data

## Verdict on Dolt

**Advantages:**

- True versioned database semantics
- SQL queries on historical data
- Proper data branching and merging
- Eliminates special workspace complexity

**Trade-offs:**

- Adds tool complexity
- Two-repo architecture
- Smaller ecosystem than git
- DoltHub dependency for best experience

**Best for:**

- Teams comfortable with new tools
- Heavy task relationship queries
- Data-driven task analytics
- Complex branching workflows

**Maybe not worth it if:**

- Team prefers familiar tools
- Simple task tracking needs
- Want to minimize dependencies

The Dolt approach is technically elegant but adds significant tooling complexity. It's a "power user" solution that might be overkill for many teams.
