## TECH TREE LAYOUT DEMONSTRATIONS

### 1. Classic Tech Tree (Bottom-Up)

```bash
minsky tasks deps graph --format svg --style tech-tree --direction BT --spacing wide --limit 10 --output classic-tech-tree.svg
```

### 2. Radial Tech Tree (Central Hub)

```bash
minsky tasks deps graph --format svg --layout twopi --style tech-tree --limit 10 --output radial-tech-tree.svg
```

### 3. Force-Directed Network

```bash
minsky tasks deps graph --format svg --layout fdp --style network --spacing wide --limit 10 --output network.svg
```

### 4. Development Timeline

```bash
minsky tasks deps graph --format svg --style flowchart --direction LR --limit 10 --output timeline.svg
```
