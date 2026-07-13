// Tailwind v4 uses the Vite plugin (@tailwindcss/vite) directly and does NOT
// want a PostCSS pipeline. This file exists to override the repo-root
// postcss.config.js (which loads the Tailwind v3 PostCSS plugin for the cockpit
// web app under src/cockpit/web/). PostCSS walks up looking for a config; an
// empty plugins map here stops the search and prevents the v3 plugin from
// running on the site's v4 CSS.
module.exports = { plugins: {} };
