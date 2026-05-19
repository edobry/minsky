---
name: motion-framer
description: >-
  Modern animation library for React and JavaScript (Motion, formerly
  Framer Motion). Create production-ready animations with motion components,
  variants, gestures (hover/tap/drag), layout animations, AnimatePresence
  exit animations, spring physics, and scroll-based effects. Use when
  building interactive UI components, micro-interactions, page transitions,
  scroll-triggered reveals, or complex animation sequences. Vendored from
  freshtechbro/claudedesignskills 2026-05-19.
user-invocable: true
---

# Motion & Framer Motion

## Overview

Motion (formerly Framer Motion) is a production-ready animation library for React and JavaScript that enables declarative, performant animations with minimal code. It provides `motion` components that wrap HTML elements with animation superpowers, supports gesture recognition (hover, tap, drag, focus), and includes advanced features like layout animations, exit animations, and spring physics.

**When to use this skill:**
- Building interactive UI components (buttons, cards, menus)
- Creating micro-interactions and hover effects
- Implementing page transitions and route animations
- Adding scroll-based animations and parallax effects
- Animating layout changes (resizing, reordering, shared element transitions)
- Drag-and-drop interfaces
- Complex animation sequences and state-based animations
- Replacing CSS transitions with more powerful, controllable animations

**Technology:**
- **Motion** (v11+) — the modern, smaller library from Framer Motion creators
- **Framer Motion** — the full-featured predecessor (still widely used)
- React 18+ compatible, also supports Vue
- Supports TypeScript
- Works with Next.js, Vite, Remix, Astro islands, and all modern React frameworks

## Core Concepts

### 1. Motion Components

Convert any HTML/SVG element into an animatable component by prefixing with `motion.`:

```jsx
import { motion } from "framer-motion"

<motion.div />
<motion.button />
<motion.svg />
<motion.path />
```

Every motion component accepts animation props like `animate`, `initial`, `transition`, and gesture props like `whileHover`, `whileTap`.

### 2. Animate Prop

The `animate` prop defines the target animation state. When values change, Motion automatically animates to them:

```jsx
<motion.div animate={{ x: 100 }} />
<motion.div animate={{ x: 100, opacity: 1, scale: 1.2 }} />

const [isOpen, setIsOpen] = useState(false)
<motion.div animate={{ width: isOpen ? 300 : 100 }} />
```

### 3. Initial State

Set the initial state before animation using the `initial` prop:

```jsx
<motion.div
  initial={{ opacity: 0, y: 50 }}
  animate={{ opacity: 1, y: 0 }}
/>
```

Set `initial={false}` to disable initial animations on mount.

### 4. Transitions

Control how animations move between states using the `transition` prop:

```jsx
// Duration-based
<motion.div animate={{ x: 100 }} transition={{ duration: 0.5, ease: "easeInOut" }} />

// Spring physics
<motion.div animate={{ scale: 1.2 }} transition={{ type: "spring", stiffness: 300, damping: 20 }} />

// Per-property transitions
<motion.div
  animate={{ x: 100, opacity: 1 }}
  transition={{
    x: { type: "spring", stiffness: 300 },
    opacity: { duration: 0.2 }
  }}
/>
```

**Transition types:** `"tween"` (default, duration-based), `"spring"` (physics), `"inertia"` (decelerating).

### 5. Variants

Organize animation states using named variants:

```jsx
const variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, scale: 0.9 }
}

<motion.div variants={variants} initial="hidden" animate="visible" exit="exit" />
```

**Variant propagation** — children inherit parent variant states; use `staggerChildren` to orchestrate sequences:

```jsx
const container = {
  visible: { opacity: 1, transition: { staggerChildren: 0.1 } }
}
const item = { hidden: { x: -20, opacity: 0 }, visible: { x: 0, opacity: 1 } }

<motion.ul variants={container} initial="hidden" animate="visible">
  <motion.li variants={item} />
  <motion.li variants={item} />
</motion.ul>
```

## Common Patterns

### Hover / Tap

```jsx
<motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }} />
```

### Drag

```jsx
<motion.div drag dragConstraints={{ left: -100, right: 100 }} whileDrag={{ scale: 1.1 }} />
```

### Exit Animations (AnimatePresence)

Components removed from DOM animate out:

```jsx
import { AnimatePresence } from "framer-motion"

<AnimatePresence>
  {visible && (
    <motion.div
      key="modal"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    />
  )}
</AnimatePresence>
```

Children of `AnimatePresence` must have unique `key` props.

### Layout Animations

```jsx
<motion.div layout />                   // animate all layout changes
<motion.div layout="position" />        // only position
<motion.img layoutId="hero" />          // shared layout across mount/unmount
```

### Scroll-Triggered (whileInView)

```jsx
<motion.div
  initial={{ opacity: 0, y: 50 }}
  whileInView={{ opacity: 1, y: 0 }}
  viewport={{ once: true, amount: 0.5 }}
  transition={{ duration: 0.5 }}
/>
```

### Spring Presets

- **Gentle:** `stiffness: 100, damping: 20`
- **Wobbly:** `stiffness: 200, damping: 10`
- **Stiff:** `stiffness: 400, damping: 30`
- **Slow:** `stiffness: 50, damping: 20`

## Hooks

- **`useAnimate`** — imperative animate with scope; `animate([[el, props], ...])`
- **`useSpring`** — spring-animated motion values; `useSpring(0, { stiffness: 300, damping: 20 })`
- **`useInView`** — viewport detection; `useInView(ref, { once: true, amount: 0.5 })`
- **`useReducedMotion`** — respect user accessibility preference

## Performance

1. **Prefer transform properties** (`x`, `y`, `scale`, `rotate`) — hardware-accelerated. Avoid `top`/`left`/`width`/`height` for animation.
2. **Use individual transforms** (`style={{ x, y, scale }}`) rather than concatenated strings.
3. **Respect reduced motion:**
   ```jsx
   const reduce = useReducedMotion()
   <motion.div transition={reduce ? { duration: 0 } : { duration: 0.5 }} />
   ```
4. **Layout animations are expensive** — use `layout="position"` when only position changes.
5. **Use `layoutId` sparingly** — global tracking.

## Common Pitfalls

1. **Forgetting `AnimatePresence` for exit animations** — exit animations only fire inside `<AnimatePresence>`.
2. **Missing `key` prop in lists** — `AnimatePresence` can't track exits without keys.
3. **Animating non-transform properties** — janky; use `x`/`y`/`scale` instead of `top`/`left`/`width`.
4. **Overusing layout animations** — every `layout` element costs; use cheaper `animate` where possible.
5. **Wrong transition placement** — a top-level `transition={{ duration: 1 }}` does NOT apply to `whileHover` — put the transition inside `whileHover={{ scale: 1.2, transition: { duration: 0.2 } }}`.

## Resources

- [Motion Docs](https://motion.dev/)
- [Framer Motion Docs](https://www.framer.com/motion/)
- [Motion GitHub](https://github.com/framer/motion)
- [Motion Recipes](https://motion.dev/docs/recipes)
