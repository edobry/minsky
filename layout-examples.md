# Task Dependency Graph Layout Options

## Layout Engines

### 1. **dot** (Hierarchical - DEFAULT)

```bash
minsky tasks deps graph --layout dot --direction TB
```

- **Best for**: Clear hierarchical dependencies
- **Use case**: Standard project dependencies, prerequisite chains

### 2. **twopi** (Radial - TECH TREE FAVORITE)

```bash
minsky tasks deps graph --layout twopi --style tech-tree --format svg --output tech-tree.svg
```

- **Best for**: Central concept with radiating dependencies
- **Use case**: Core technology with multiple research branches

### 3. **circo** (Circular)

```bash
minsky tasks deps graph --layout circo --spacing wide
```

- **Best for**: Cyclic or interconnected dependencies
- **Use case**: Complex feature interdependencies

### 4. **fdp** (Force-Directed)

```bash
minsky tasks deps graph --layout fdp --style network
```

- **Best for**: Natural clustering and organic layouts
- **Use case**: Large, complex dependency networks

### 5. **neato** (Spring Model)

```bash
minsky tasks deps graph --layout neato --spacing wide
```

- **Best for**: Balanced node placement
- **Use case**: Medium-sized graphs with clear structure

## Direction Options

### **BT** (Bottom-Top - CLASSIC TECH TREE)

```bash
minsky tasks deps graph --direction BT --style tech-tree
```

- Prerequisites at bottom, advanced tech at top
- **Perfect for game-style tech trees**

### **TB** (Top-Bottom - DEFAULT)

```bash
minsky tasks deps graph --direction TB
```

- Standard hierarchy view

### **LR/RL** (Horizontal Flow)

```bash
minsky tasks deps graph --direction LR --style flowchart
```

- Timeline or process flow visualization

## Visual Styles

### **tech-tree** (Game-Inspired)

```bash
minsky tasks deps graph --style tech-tree --direction BT --spacing wide
```

- Game-like colors and styling
- Clear borders and tech tree aesthetics
- **Best combined with BT direction**

### **flowchart** (Process Flow)

```bash
minsky tasks deps graph --style flowchart --direction LR
```

- Clean business process appearance
- **Best combined with LR direction**

### **network** (Interconnected)

```bash
minsky tasks deps graph --style network --layout fdp
```

- Network-style visualization
- **Best combined with force-directed layouts**

## Perfect Tech Tree Combinations

### Classic Tech Tree (Bottom-Up)

```bash
minsky tasks deps graph --format svg --style tech-tree --direction BT --spacing wide --output classic-tech-tree.svg
```

### Radial Tech Tree (Central Hub)

```bash
minsky tasks deps graph --format svg --layout twopi --style tech-tree --output radial-tech-tree.svg
```

### Research Network

```bash
minsky tasks deps graph --format svg --layout fdp --style network --spacing wide --output research-network.svg
```

### Development Timeline

```bash
minsky tasks deps graph --format svg --style flowchart --direction LR --spacing normal --output dev-timeline.svg
```
