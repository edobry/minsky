---
name: seo-skill
description: >-
  Lightweight SEO and discoverability audit for static marketing sites:
  meta tags, Open Graph, Twitter Cards, JSON-LD schema, sitemap.xml,
  robots.txt, image alt text, canonical URLs, viewport, deferred JS.
  No build tools, no agents, no API calls. Use when auditing a static
  HTML/Astro/Hono marketing site for SEO completeness, fixing missing
  meta/OG tags, generating sitemap/robots.txt, or verifying social-preview
  rendering. Vendored from aevans-eng/seo-skill 2026-05-19.
user-invocable: true
---

# SEO Skill — Static Site Optimization

Lightweight audit and fix tool for static HTML sites (GitHub Pages, Netlify, Vercel, Astro static-output, etc.). No build tools required.

## Setup

Before using, provide Claude with:

- **Domain** (e.g. `https://yourname.com`)
- **Pages** list
- **Social profiles**
- **Target keywords** (what you want to rank for)

Claude retains this context for the session.

---

## What to Check

### 1. Per-Page Head Essentials

Each HTML page requires:

- `<title>` (50-60 chars): name + differentiator
- `<meta name="description">` (150-160 chars): unique, keyword-rich
- `<link rel="canonical">`: matches deployed URL exactly
- Open Graph tags: `og:title`, `og:description`, `og:image` (1200x630px)
- Twitter Card tags: `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`

### 2. Structured Data (JSON-LD)

Homepage should include:

- **Person** / **Organization** schema: name, jobTitle, affiliation, sameAs links, knowsAbout
- **WebSite** schema: name, URL

Project / product pages use **CreativeWork** or **SoftwareApplication** schema with name, author, description, URL.

_Rule:_ JSON-LD only. No FAQPage, HowTo, or placeholder text.

### 3. robots.txt

Create at site root:

```
User-agent: *
Allow: /
Sitemap: https://yourdomain.com/sitemap.xml
```

### 4. sitemap.xml

XML file listing all pages with `<loc>`, `<lastmod>` (YYYY-MM-DD), and `<priority>`.

### 5. Image SEO

- Descriptive `alt` text on all `<img>` tags
- WebP format preferred; under 200KB
- `loading="lazy"` for below-fold images
- OG image must be a real file

### 6. Content & Keywords

- One H1 per page including name/project name
- Proper heading hierarchy (h1 -> h2 -> h3)
- Your name appears naturally in body text
- Internal cross-linking between pages
- External links to social profiles

### 7. Technical Checks

- HTTPS throughout (all links and resources)
- Consistent trailing-slash convention
- No broken links
- Viewport meta tag on all pages
- Minimal/deferred JavaScript

### 8. Post-Deploy Verification

1. Verify `/robots.txt` and `/sitemap.xml` accessible
2. Test OG tags via social preview (Discord/Slack)
3. Submit sitemap in Google Search Console
4. Monitor `site:yourdomain.com` after a few days
5. Track target keyword rankings

### 9. Google Search Console

1. Add property for your domain
2. Verify via DNS or HTML file
3. Submit sitemap
4. Monitor Coverage report

---

## Audit Output Format

When invoked, read all HTML files and report:

| Check             | Status | Notes   |
| ----------------- | ------ | ------- |
| Meta descriptions | Y/N    | Details |
| OG tags           | Y/N    | Details |
| JSON-LD schema    | Y/N    | Details |
| robots.txt        | Y/N    | Details |
| sitemap.xml       | Y/N    | Details |
| Image alt text    | Y/N    | Details |
| H1 tags           | Y/N    | Details |
| Internal links    | Y/N    | Details |
| Canonical URLs    | Y/N    | Details |

Then offer to fix what's missing.
