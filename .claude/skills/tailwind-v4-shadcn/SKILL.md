---
name: tailwind-v4-shadcn
description: "| Production-tested setup for Tailwind CSS v4 with shadcn/ui, Vite, and React. Use when: initializing React projects with Tailwind v4, setting up shadcn/ui, implementing dark mode, debugging CSS variable issues, fixing theme switching, migrating from Tailwind v3, or encountering color/theming problems. Covers: @theme inline pattern, CSS variable architecture, dark mode with ThemeProvider, component composition, vite.config setup, common v4 gotchas, and production-tested patterns."

metadata:
  keywords:
    - Tailwind v4
    - shadcn/ui
    - "@tailwindcss/vite"
    - "@theme inline"
    - dark mode
    - CSS variables
    - hsl() wrapper
    - components.json
    - React theming
    - theme switching
    - colors not working
    - variables broken
    - theme not applying
    - "@plugin directive"
    - typography plugin
    - forms plugin
    - prose class
    - "@tailwindcss/typography"
    - "@tailwindcss/forms"

license: MIT
---

# Tailwind v4 + shadcn/ui Production Stack

**Production-tested**: WordPress Auditor (https://wordpress-auditor.webfonts.workers.dev)
**Last Updated**: 2025-12-04
**Status**: Production Ready

## Quick Start (5 Minutes - Follow This Exact Order)

### 1. Install Dependencies

```bash
bun add tailwindcss @tailwindcss/vite
bun add -d @types/node

# Note: Using pnpm for shadcn init due to known Bun compatibility issues
pnpm dlx shadcn@latest init
```

### 2. Configure Vite

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

### 3. Update components.json

```json
{
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "cssVariables": true
  }
}
```

### 4. Delete tailwind.config.ts

```bash
rm tailwind.config.ts  # v4 doesn't use this file
```

---

## The Four-Step Architecture (CRITICAL)

This pattern is **mandatory** - skipping steps will break your theme.

### Step 1: Define CSS Variables at Root Level

```css
/* src/index.css */
@import "tailwindcss";

:root {
  --background: hsl(0 0% 100%);
  --foreground: hsl(222.2 84% 4.9%);
  --primary: hsl(221.2 83.2% 53.3%);
}

.dark {
  --background: hsl(222.2 84% 4.9%);
  --foreground: hsl(210 40% 98%);
  --primary: hsl(217.2 91.2% 59.8%);
}
```

**Critical Rules:**

- Define at root level (NOT inside `@layer base`)
- Use `hsl()` wrapper on all color values
- Use `.dark` for dark mode (NOT `.dark { @theme { } }`)

### Step 2: Map Variables to Tailwind Utilities

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
}
```

### Step 3: Apply Base Styles

```css
@layer base {
  body {
    background-color: var(--background);
    color: var(--foreground);
  }
}
```

### Step 4: Result - Automatic Dark Mode

```tsx
<div className="bg-background text-foreground">
  {/* No dark: variants needed - theme switches automatically */}
</div>
```

---

## Dark Mode Setup

### 1. Create ThemeProvider

```typescript
// src/components/theme-provider.tsx
import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'dark' | 'light' | 'system'

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeProviderContext = createContext<ThemeProviderState>({
  theme: 'system',
  setTheme: () => null,
})

export function ThemeProvider({ children, defaultTheme = 'system', storageKey = 'vite-ui-theme' }: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(storageKey) as Theme) || defaultTheme)

  useEffect(() => {
    const root = window.document.documentElement
    root.classList.remove('light', 'dark')
    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      root.classList.add(systemTheme)
      return
    }
    root.classList.add(theme)
  }, [theme])

  return (
    <ThemeProviderContext.Provider value={{ theme, setTheme: (theme) => { localStorage.setItem(storageKey, theme); setTheme(theme) } }}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined) throw new Error('useTheme must be used within a ThemeProvider')
  return context
}
```

### 2. Wrap Your App

```typescript
// src/main.tsx
import { ThemeProvider } from '@/components/theme-provider'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <App />
    </ThemeProvider>
  </React.StrictMode>,
)
```

---

## Critical Rules

### Always Do:

1. **Wrap color values with `hsl()` in `:root` and `.dark`**

   ```css
   --background: hsl(0 0% 100%);
   ```

2. **Use `@theme inline` to map all CSS variables**

   ```css
   @theme inline {
     --color-background: var(--background);
   }
   ```

3. **Set `"tailwind.config": ""` in components.json**

4. **Delete `tailwind.config.ts` if it exists**

5. **Use `@tailwindcss/vite` plugin (NOT PostCSS)**

6. **Use `cn()` for conditional classes**
   ```typescript
   import { cn } from "@/lib/utils"
   <div className={cn("base", isActive && "active")} />
   ```

### Never Do:

1. **Put `:root` or `.dark` inside `@layer base`**
2. **Use `.dark { @theme { } }` pattern** — v4 doesn't support nested @theme
3. **Double-wrap colors** — `hsl(var(--background))` is wrong
4. **Use `tailwind.config.ts` for theme colors** — v4 ignores this
5. **Use `@apply` directive** — deprecated in v4
6. **Use `dark:` variants for semantic colors** — use the CSS variable system instead

---

## Semantic Color Tokens

```css
:root {
  --destructive: hsl(0 84.2% 60.2%);
  --success: hsl(142.1 76.2% 36.3%);
  --warning: hsl(38 92% 50%);
  --info: hsl(221.2 83.2% 53.3%);
}
```

Usage:

```tsx
<div className="bg-destructive text-destructive-foreground">Critical</div>
<div className="bg-success text-success-foreground">Success</div>
```

---

## Common Issues & Quick Fixes

| Symptom                   | Cause                           | Fix                                        |
| ------------------------- | ------------------------------- | ------------------------------------------ |
| `bg-primary` doesn't work | Missing `@theme inline` mapping | Add `@theme inline` block                  |
| Colors all black/white    | Double `hsl()` wrapping         | Use `var(--color)` not `hsl(var(--color))` |
| Dark mode not switching   | Missing ThemeProvider           | Wrap app in `<ThemeProvider>`              |
| Build fails               | `tailwind.config.ts` exists     | Delete the file                            |
| Text invisible            | Wrong contrast colors           | Check color definitions in `:root`/`.dark` |

---

## Complete Setup Checklist

- [ ] Vite + React + TypeScript project created
- [ ] `@tailwindcss/vite` installed (NOT postcss)
- [ ] `vite.config.ts` uses `tailwindcss()` plugin
- [ ] `tsconfig.json` has path aliases configured
- [ ] `components.json` exists with `"config": ""`
- [ ] NO `tailwind.config.ts` file exists
- [ ] `src/index.css` follows v4 pattern:
  - [ ] `:root` and `.dark` at root level (not in @layer)
  - [ ] Colors wrapped with `hsl()`
  - [ ] `@theme inline` maps all variables
  - [ ] `@layer base` uses unwrapped variables
- [ ] Theme provider installed and wrapping app

---

## Tailwind v4 Plugins

```css
@import "tailwindcss";
@plugin "@tailwindcss/typography";
@plugin "@tailwindcss/forms";
```

**Common Error:**

- WRONG: `@import "@tailwindcss/typography"` (doesn't work)
- CORRECT: `@plugin "@tailwindcss/typography"` (use @plugin directive)

**Built-in Features:** Container queries are now core (no `@tailwindcss/container-queries` plugin needed).

---

## Dependencies

### Install These

```json
{
  "dependencies": {
    "tailwindcss": "^4.1.17",
    "@tailwindcss/vite": "^4.1.17",
    "clsx": "^2.1.1",
    "tailwind-merge": "^3.3.1"
  }
}
```

### NEVER Install These (Deprecated in v4)

```bash
# These packages will cause build errors:
bun add tailwindcss-animate  # Deprecated
bun add tw-animate-css       # Doesn't exist
```

---

## Official Documentation

- **shadcn/ui Vite Setup**: https://ui.shadcn.com/docs/installation/vite
- **shadcn/ui Tailwind v4 Guide**: https://ui.shadcn.com/docs/tailwind-v4
- **shadcn/ui Dark Mode (Vite)**: https://ui.shadcn.com/docs/dark-mode/vite
- **Tailwind v4 Docs**: https://tailwindcss.com/docs
