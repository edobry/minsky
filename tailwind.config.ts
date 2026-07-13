import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: "class",
  content: ["./src/cockpit/web/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        background: "oklch(var(--background) / <alpha-value>)",
        foreground: "oklch(var(--foreground) / <alpha-value>)",
        card: {
          DEFAULT: "oklch(var(--card) / <alpha-value>)",
          foreground: "oklch(var(--card-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "oklch(var(--popover) / <alpha-value>)",
          foreground: "oklch(var(--popover-foreground) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "oklch(var(--primary) / <alpha-value>)",
          foreground: "oklch(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "oklch(var(--secondary) / <alpha-value>)",
          foreground: "oklch(var(--secondary-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "oklch(var(--muted) / <alpha-value>)",
          foreground: "oklch(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "oklch(var(--accent) / <alpha-value>)",
          foreground: "oklch(var(--accent-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "oklch(var(--destructive) / <alpha-value>)",
          foreground: "oklch(var(--destructive-foreground) / <alpha-value>)",
        },
        border: "oklch(var(--border) / <alpha-value>)",
        input: "oklch(var(--input) / <alpha-value>)",
        ring: "oklch(var(--ring) / <alpha-value>)",

        // Brand palette (mt#1935; docs/brand-system.md §2). Available as
        // `bg-signal-cyan`, `text-warn-amber`, `border-iso-pastel`, etc.
        signal: {
          cyan: "oklch(var(--signal-cyan) / <alpha-value>)",
          "cyan-dim": "oklch(var(--signal-cyan-dim) / <alpha-value>)",
        },
        warn: {
          amber: "oklch(var(--warn-amber) / <alpha-value>)",
          red: "oklch(var(--warn-red) / <alpha-value>)",
        },
        iso: {
          pastel: "oklch(var(--iso-pastel) / <alpha-value>)",
        },
        subtle: "oklch(var(--text-subtle) / <alpha-value>)",

        // VSM organ palette — plant board (mt#2376; docs/brand-system.md §7).
        // Available as `bg-vsm-s1`, `text-vsm-seam`, `fill-vsm-learn`, etc.
        vsm: {
          s1: "oklch(var(--vsm-s1) / <alpha-value>)",
          s2: "oklch(var(--vsm-s2) / <alpha-value>)",
          s3: "oklch(var(--vsm-s3) / <alpha-value>)",
          s4: "oklch(var(--vsm-s4) / <alpha-value>)",
          s5: "oklch(var(--vsm-s5) / <alpha-value>)",
          seam: "oklch(var(--vsm-seam) / <alpha-value>)",
          learn: "oklch(var(--vsm-learn) / <alpha-value>)",
        },

        // Liveness status sub-tokens — cockpit-local per docs/brand-system.md §7.
        liveness: {
          healthy: "oklch(var(--liveness-healthy) / <alpha-value>)",
          idle: "oklch(var(--liveness-idle) / <alpha-value>)",
          stale: "oklch(var(--liveness-stale) / <alpha-value>)",
          orphaned: "oklch(var(--liveness-orphaned) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
        "warm-mono": ["var(--font-warm-mono)"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        // mt#1935 — status-dot pulse + hook-denial flash per
        // docs/brand-system.md §3. Both gated on prefers-reduced-motion in
        // index.css.
        "status-dot-pulse": {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
        "hook-denial-flash": {
          "0%": { backgroundColor: "oklch(var(--warn-amber) / 0.4)" },
          "100%": { backgroundColor: "transparent" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "status-dot": "status-dot-pulse 1.6s ease-in-out infinite",
        "hook-denial": "hook-denial-flash 600ms ease-out forwards",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
