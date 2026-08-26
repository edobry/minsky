# mt#4630 — render-path evidence

`memories-row-hover-card.png` — the `/memories` list, served from this task's session
workspace at `76fd788f5` (the build hash is stamped in the sidebar footer, bottom left),
with the cursor hovering the `mt#4199` reference inside a memory's DESCRIPTION cell.

That cell renders through `<LinkifiedText>`, the path this task fixes. The open card
shows `TASK / mt#4199 / <title> / DONE`. Before this change the same anchor was a bare
`<Link>`: it navigated on click and produced nothing on hover.

Captured against the live app with real data (2,840 entity references on the page), not a
test fixture. The DOM read taken at the same moment:

```
{"totalAnchors":2927,"entityRefs":2840,"sample":[
  {"text":"mem#669","href":"/memory/39a1e828-…","hasEntityRefAttr":true,"dataState":"closed",
   "ariaLabel":"39a1e828-…, Under-called a flagship-breaking gap as routine …"},
  {"text":"mt#4199","href":"/tasks/mt%234199","hasEntityRefAttr":true,"dataState":"closed",
   "ariaLabel":"mt#4199, Turn-end scan: the closing message says an entity is awaiting the principal, …, DONE"},
  …]}
```

`hasEntityRefAttr` and `dataState` are the two attributes that were absent on this path
and present on the prose one — the peek wiring plus the hover-card trigger. `ariaLabel`
is the density half: the resolved title reaches assistive tech without being appended to
the visible row, so the line height is unchanged.
