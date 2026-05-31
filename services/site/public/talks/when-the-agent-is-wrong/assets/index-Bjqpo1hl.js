const __vite__mapDeps = (
  i,
  m = __vite__mapDeps,
  d = m.f ||
    (m.f = [
      "assets/md-CwugNJv9.js",
      "assets/modules/vue-D4u9h7Td.js",
      "assets/minsky-icon-CaXDhekZ.js",
      "assets/slidev/context-eddjAoUW.js",
      "assets/modules/shiki-CBR8dv5M.js",
      "assets/modules/shiki-UqVAgQbi.css",
      "assets/md-C-pOAcFC.css",
      "assets/md-3ByqbAQi.js",
      "assets/slidev/default-Cw5Kcts5.js",
      "assets/md-DV0VGgo2.js",
      "assets/md-B1aCOhaI.js",
      "assets/slidev/md-9XCSYhTQ.js",
      "assets/modules/unplugin-icons-G2-mK4-T.js",
      "assets/md-CjDI1-kt.js",
      "assets/md-Dg3T7Ht7.js",
      "assets/md-DjrRrqKe.js",
      "assets/slidev/md-BoWYxWXm.js",
      "assets/md-Dk4ZRs7a.js",
      "assets/md-CeEI3qH4.js",
      "assets/md-C9BIPv-A.js",
      "assets/md-xV8rmEVa.js",
      "assets/md-D6gPvIeW.js",
      "assets/md-Bz2oVJP_.js",
      "assets/md-B11nts_w.js",
      "assets/md-D8I4mP1_.js",
      "assets/md-BxnhzQyV.js",
      "assets/md-DSP4bw3K.js",
      "assets/md-DWteXKYz.js",
      "assets/md-l2n3CdvD.js",
      "assets/md-DARPu-FA.js",
      "assets/md-CkzLLCAW.js",
      "assets/md-BbSWcYwW.js",
      "assets/slidev/entry-xwAQwhc4.js",
      "assets/entry-15QH0Q6e.css",
      "assets/slidev/overview-DErbmAdv.js",
      "assets/slidev/NoteDisplay.vue_vue_type_style_index_0_lang-Doo4Qrp0.js",
      "assets/NoteDisplay-CGTG5ZHT.css",
      "assets/slidev/SlideWrapper-DOw9mgBs.js",
      "assets/SlideWrapper-2uwFe7eL.css",
      "assets/slidev/IconButton.vue_vue_type_script_setup_true_lang-DaELRGQo.js",
      "assets/slidev/useSlideInfo-Ch6shhMa.js",
      "assets/slidev/notes-CkF9nP1H.js",
      "assets/slidev/presenter-DmWlCvc4.js",
      "assets/slidev/shortcuts-CtzYrQiz.js",
      "assets/shortcuts-BbJOi48n.css",
      "assets/slidev/DrawingControls.vue_vue_type_style_index_0_lang-BHKf2Brs.js",
      "assets/DrawingControls-Cxk9a9ub.css",
      "assets/presenter-DK9Ev5Ts.css",
      "assets/slidev/play-Cfb_UOn_.js",
      "assets/play-D_7yfuao.css",
      "assets/slidev/404-ibDRAdSv.js",
      "assets/404-n_Eqdu3W.css",
    ])
) => i.map((i) => d[i]);
const $r = Object.defineProperty;
const Lr = (t, e, n) =>
  e in t ? $r(t, e, { enumerable: !0, configurable: !0, writable: !0, value: n }) : (t[e] = n);
const qe = (t, e, n) => Lr(t, typeof e != "symbol" ? `${e}` : e, n);
import {
  d as _,
  z as Pr,
  ae as un,
  u as Cr,
  v as Ds,
  aJ as Qe,
  Q as Ir,
  S as Rr,
  P as Dr,
  a1 as E,
  r as js,
  aI as ee,
  V as Ns,
  a7 as C,
  y as jr,
  X as Nr,
  Y as Lt,
  i as fn,
  aa as Hr,
  p as Hs,
  F as xr,
  f as Wn,
  h as Fr,
  a0 as L,
  a8 as En,
  o as zr,
  ax as Ft,
  J as Vr,
  af as qr,
  ar as Wr,
  an as Br,
  aq as J,
  ah as Jr,
  aA as xs,
  ag as Ur,
  c as Kr,
  x as zt,
  aE as Gr,
  k as Fs,
  aw as Qr,
  av as Yr,
  ay as Zr,
  ab as zs,
  g as Xr,
  a4 as eo,
  ak as to,
  R as no,
  w as so,
  aD as ro,
  q as oo,
  j as io,
  n as ao,
  e as lo,
} from "./modules/vue-D4u9h7Td.js";
import { T as co } from "./modules/shiki-CBR8dv5M.js";
(function () {
  const e = document.createElement("link").relList;
  if (e && e.supports && e.supports("modulepreload")) return;
  for (const r of document.querySelectorAll('link[rel="modulepreload"]')) s(r);
  new MutationObserver((r) => {
    for (const o of r)
      if (o.type === "childList")
        for (const i of o.addedNodes) i.tagName === "LINK" && i.rel === "modulepreload" && s(i);
  }).observe(document, { childList: !0, subtree: !0 });
  function n(r) {
    const o = {};
    return (
      r.integrity && (o.integrity = r.integrity),
      r.referrerPolicy && (o.referrerPolicy = r.referrerPolicy),
      r.crossOrigin === "use-credentials"
        ? (o.credentials = "include")
        : r.crossOrigin === "anonymous"
          ? (o.credentials = "omit")
          : (o.credentials = "same-origin"),
      o
    );
  }
  function s(r) {
    if (r.ep) return;
    r.ep = !0;
    const o = n(r);
    fetch(r.href, o);
  }
})();
const F = {
  theme: "none",
  title: "When the Agent is Wrong",
  titleTemplate: "%s - Slidev",
  addons: [],
  remoteAssets: !1,
  monaco: !0,
  monacoTypesSource: "local",
  monacoTypesAdditionalPackages: [],
  monacoTypesIgnorePackages: [],
  monacoRunAdditionalDeps: [],
  download: !1,
  export: {},
  info: `<p>Case study: metacognitive infrastructure in practice.
Minsky — the cyberbrain for software organizations.</p>
`,
  highlighter: "shiki",
  twoslash: !0,
  lineNumbers: !1,
  colorSchema: "auto",
  routerMode: "history",
  aspectRatio: 1.7777777777777777,
  canvasWidth: 980,
  exportFilename: "",
  selectable: !1,
  themeConfig: {},
  fonts: {
    sans: [
      '"Geist"',
      "ui-sans-serif",
      "system-ui",
      "-apple-system",
      "BlinkMacSystemFont",
      '"Segoe UI"',
      "Roboto",
      '"Helvetica Neue"',
      "Arial",
      '"Noto Sans"',
      "sans-serif",
      '"Apple Color Emoji"',
      '"Segoe UI Emoji"',
      '"Segoe UI Symbol"',
      '"Noto Color Emoji"',
    ],
    serif: ["ui-serif", "Georgia", "Cambria", '"Times New Roman"', "Times", "serif"],
    mono: [
      '"JetBrains Mono"',
      "ui-monospace",
      "SFMono-Regular",
      "Menlo",
      "Monaco",
      "Consolas",
      '"Liberation Mono"',
      '"Courier New"',
      "monospace",
    ],
    webfonts: ["Geist", "JetBrains Mono"],
    provider: "google",
    local: [],
    italic: !1,
    weights: ["200", "400", "600"],
  },
  favicon: "https://cdn.jsdelivr.net/gh/slidevjs/slidev/assets/favicon.png",
  drawings: { enabled: !0, persist: !1, presenterOnly: !1, syncAll: !0 },
  plantUmlServer: "https://www.plantuml.com/plantuml",
  codeCopy: !0,
  author: "",
  record: "dev",
  css: "unocss",
  presenter: !0,
  browserExporter: "dev",
  htmlAttrs: {},
  transition: "none",
  editor: !0,
  contextMenu: null,
  wakeLock: !0,
  mdc: !0,
  seoMeta: {},
  overview: !1,
  slidesTitle: "When the Agent is Wrong - Slidev",
};
function hn(t, e, n) {
  return Math.min(n, Math.max(e, t));
}
function uo(...t) {
  return ho(t).reduce((e, n) => e + n, 0);
}
function fo(t) {
  return (t = t ?? []), Array.isArray(t) ? t : [t];
}
function ho(t) {
  return fo(t).flat(1);
}
function po(t) {
  return Array.from(new Set(t));
}
function Bn(...t) {
  let e, n, s;
  t.length === 1 ? ((e = 0), (s = 1), ([n] = t)) : ([e, n, s = 1] = t);
  const r = [];
  let o = e;
  for (; o < n; ) r.push(o), (o += s || 1);
  return r;
}
function go(t) {
  return t != null;
}
function mo(t, e) {
  return Object.fromEntries(
    Object.entries(t)
      .map(([n, s]) => e(n, s))
      .filter(go)
  );
}
const Xl = "build",
  Vs = _(() => F.aspectRatio),
  qs = _(() => F.canvasWidth),
  yo = _(() => Math.ceil(qs.value / Vs.value)),
  vo = _(() => mo(F.themeConfig || {}, (t, e) => [`--slidev-theme-${t}`, e])),
  Qt = F.slidesTitle,
  ec = "/talks/when-the-agent-is-wrong/",
  wo = [],
  ko = new Set(["link", "style", "script", "noscript"]),
  bo = new Set(["title", "titleTemplate", "script", "style", "noscript"]),
  dn = new Set(["base", "meta", "link", "style", "script", "noscript"]),
  o = new Set([
    "title",
    "base",
    "htmlAttrs",
    "bodyAttrs",
    "meta",
    "link",
    "style",
    "script",
    "noscript",
  ]),
  So = new Set(["base", "title", "titleTemplate", "bodyAttrs", "htmlAttrs", "templateParams"]),
  Mo = new Set([
    "key",
    "tagPosition",
    "tagPriority",
    "tagDuplicateStrategy",
    "innerHTML",
    "textContent",
    "processTemplateParams",
  ]),
  To = new Set(["templateParams", "htmlAttrs", "bodyAttrs"]),
  Oo = new Set([
    "theme-color",
    "google-site-verification",
    "og",
    "article",
    "book",
    "profile",
    "twitter",
    "author",
  ]);
function pn(t, e = {}, n) {
  for (const s in t) {
    const r = t[s],
      o = n ? `${n}:${s}` : s;
    typeof r == "object" && r !== null ? pn(r, e, o) : typeof r == "function" && (e[o] = r);
  }
  return e;
}
const Ws = (() => {
  if (console.createTask) return console.createTask;
  const t = { run: (e) => e() };
  return () => t;
})();
function Bs(t, e, n, s) {
  for (let r = n; r < t.length; r += 1)
    try {
      const o = s ? s.run(() => t[r](...e)) : t[r](...e);
      if (o && typeof o.then == "function")
        return Promise.resolve(o).then(() => Bs(t, e, r + 1, s));
    } catch (o) {
      return Promise.reject(o);
    }
}
function Ao(t, e, n) {
  if (t.length > 0) return Bs(t, e, 0, Ws(n));
}
function Eo(t, e, n) {
  if (t.length > 0) {
    const s = Ws(n);
    return Promise.all(t.map((r) => s.run(() => r(...e))));
  }
}
function Yt(t, e) {
  for (const n of [...t]) n(e);
}
const $o = class {
  constructor() {
    qe(this, "_hooks");
    qe(this, "_before");
    qe(this, "_after");
    qe(this, "_deprecatedHooks");
    qe(this, "_deprecatedMessages");
    (this._hooks = {}),
      (this._before = void 0),
      (this._after = void 0),
      (this._deprecatedMessages = void 0),
      (this._deprecatedHooks = {}),
      (this.hook = this.hook.bind(this)),
      (this.callHook = this.callHook.bind(this)),
      (this.callHookWith = this.callHookWith.bind(this));
  }
  hook(t, e, n = {}) {
    if (!t || typeof e != "function") return () => {};
    const s = t;
    let r;
    for (; this._deprecatedHooks[t]; ) (r = this._deprecatedHooks[t]), (t = r.to);
    if (r && !n.allowDeprecated) {
      let o = r.message;
      o || (o = `${s} hook has been deprecated${r.to ? `, please use ${r.to}` : ""}`),
        this._deprecatedMessages || (this._deprecatedMessages = new Set()),
        this._deprecatedMessages.has(o) || (console.warn(o), this._deprecatedMessages.add(o));
    }
    if (!e.name)
      try {
        Object.defineProperty(e, "name", {
          get: () => `_${t.replace(/\W+/g, "_")}_hook_cb`,
          configurable: !0,
        });
      } catch {}
    return (
      (this._hooks[t] = this._hooks[t] || []),
      this._hooks[t].push(e),
      () => {
        e && (this.removeHook(t, e), (e = void 0));
      }
    );
  }
  hookOnce(t, e) {
    let n,
      s = (...r) => (typeof n == "function" && n(), (n = void 0), (s = void 0), e(...r));
    return (n = this.hook(t, s)), n;
  }
  removeHook(t, e) {
    const n = this._hooks[t];
    if (n) {
      const s = n.indexOf(e);
      s !== -1 && n.splice(s, 1), n.length === 0 && (this._hooks[t] = void 0);
    }
  }
  clearHook(t) {
    this._hooks[t] = void 0;
  }
  deprecateHook(t, e) {
    this._deprecatedHooks[t] = typeof e == "string" ? { to: e } : e;
    const n = this._hooks[t] || [];
    this._hooks[t] = void 0;
    for (const s of n) this.hook(t, s);
  }
  deprecateHooks(t) {
    for (const e in t) this.deprecateHook(e, t[e]);
  }
  addHooks(t) {
    const e = pn(t),
      n = Object.keys(e).map((s) => this.hook(s, e[s]));
    return () => {
      for (const s of n) s();
      n.length = 0;
    };
  }
  removeHooks(t) {
    const e = pn(t);
    for (const n in e) this.removeHook(n, e[n]);
  }
  removeAllHooks() {
    this._hooks = {};
  }
  callHook(t, ...e) {
    return this.callHookWith(Ao, t, e);
  }
  callHookParallel(t, ...e) {
    return this.callHookWith(Eo, t, e);
  }
  callHookWith(t, e, n) {
    const s = this._before || this._after ? { name: e, args: n, context: {} } : void 0;
    this._before && Yt(this._before, s);
    const r = t(this._hooks[e] ? [...this._hooks[e]] : [], n, e);
    return r instanceof Promise
      ? r.finally(() => {
          this._after && s && Yt(this._after, s);
        })
      : (this._after && s && Yt(this._after, s), r);
  }
  beforeEach(t) {
    return (
      (this._before = this._before || []),
      this._before.push(t),
      () => {
        if (this._before !== void 0) {
          const e = this._before.indexOf(t);
          e !== -1 && this._before.splice(e, 1);
        }
      }
    );
  }
  afterEach(t) {
    return (
      (this._after = this._after || []),
      this._after.push(t),
      () => {
        if (this._after !== void 0) {
          const e = this._after.indexOf(t);
          e !== -1 && this._after.splice(e, 1);
        }
      }
    );
  }
};
function Lo() {
  return new $o();
}
const Po = ["name", "property", "http-equiv"],
  Co = new Set(["viewport", "description", "keywords", "robots"]);
function Js(t) {
  const e = t.split(":");
  return e.length ? Oo.has(e[1]) : !1;
}
function gn(t) {
  const { props: e, tag: n } = t;
  if (So.has(n)) return n;
  if (n === "link" && e.rel === "canonical") return "canonical";
  if (n === "link" && e.rel === "alternate") {
    if (e.hreflang) return `alternate:${e.hreflang}`;
    if (e.type) return `alternate:${e.type}:${e.href || ""}`;
  }
  if (e.charset) return "charset";
  if (t.tag === "meta") {
    for (const s of Po)
      if (e[s] !== void 0) {
        const r = e[s],
          o = r && typeof r == "string" && r.includes(":"),
          i = r && Co.has(r),
          l = !(o || i) && t.key ? `:key:${t.key}` : "";
        return `${n}:${r}${l}`;
      }
  }
  if (t.key) return `${n}:key:${t.key}`;
  if (e.id) return `${n}:id:${e.id}`;
  if (n === "link" && e.rel === "alternate") return `alternate:${e.href || ""}`;
  if (bo.has(n)) {
    const s = t.textContent || t.innerHTML;
    if (s) return `${n}:content:${s}`;
  }
}
function Us(t) {
  const e = t._h || t._d;
  if (e) return e;
  const n = t.textContent || t.innerHTML;
  return (
    n ||
    `${t.tag}:${Object.entries(t.props)
      .map(([s, r]) => `${s}:${String(r)}`)
      .join(",")}`
  );
}
function Pt(t, e, n) {
  typeof t === "function" &&
    (!n || (n !== "titleTemplate" && !(n[0] === "o" && n[1] === "n"))) &&
    (t = t());
  const r = e ? e(n, t) : t;
  if (Array.isArray(r)) return r.map((o) => Pt(o, e));
  if ((r == null ? void 0 : r.constructor) === Object) {
    const o = {};
    for (const i of Object.keys(r)) o[i] = Pt(r[i], e, i);
    return o;
  }
  return r;
}
function Io(t, e) {
  const n = t === "style" ? new Map() : new Set();
  function s(r) {
    if (r == null || r === void 0) return;
    const o = String(r).trim();
    if (o)
      if (t === "style") {
        const [i, ...a] = o.split(":").map((l) => (l ? l.trim() : ""));
        i && a.length && n.set(i, a.join(":"));
      } else
        o.split(" ")
          .filter(Boolean)
          .forEach((i) => n.add(i));
  }
  return (
    typeof e == "string"
      ? t === "style"
        ? e.split(";").forEach(s)
        : s(e)
      : Array.isArray(e)
        ? e.forEach((r) => s(r))
        : e &&
          typeof e == "object" &&
          Object.entries(e).forEach(([r, o]) => {
            o && o !== "false" && (t === "style" ? n.set(String(r).trim(), String(o)) : s(r));
          }),
    n
  );
}
function Ks(t, e) {
  if (((t.props = t.props || {}), !e)) return t;
  if (t.tag === "templateParams") return (t.props = e), t;
  const n = dn.has(t.tag) || t.tag === "htmlAttrs" || t.tag === "bodyAttrs";
  return (
    Object.entries(e).forEach(([s, r]) => {
      if (s === "__proto__" || s === "constructor" || s === "prototype") return;
      if (r === null) {
        t.props[s] = null;
        return;
      }
      if (s === "class" || s === "style") {
        t.props[s] = Io(s, r);
        return;
      }
      if (Mo.has(s)) {
        if ((s === "textContent" || s === "innerHTML") && typeof r == "object") {
          let c = e.type;
          if (
            (e.type || (c = "application/json"),
            !(c != null && c.endsWith("json")) && c !== "speculationrules")
          )
            return;
          (e.type = c), (t.props.type = c), (t[s] = JSON.stringify(r));
        } else t[s] = r;
        return;
      }
      const o = s.startsWith("data-"),
        i = n && !o ? s.toLowerCase() : s,
        a = String(r),
        l = t.tag === "meta" && i === "content";
      a === "true" || a === ""
        ? (t.props[i] = o || l ? a : !0)
        : !r && o && a === "false"
          ? (t.props[i] = "false")
          : r !== void 0 && (t.props[i] = r);
    }),
    t
  );
}
function Ro(t, e) {
  const n =
      typeof e == "object" && typeof e != "function"
        ? e
        : {
            [t === "script" || t === "noscript" || t === "style" ? "innerHTML" : "textContent"]: e,
          },
    s = Ks({ tag: t, props: {} }, n);
  return (
    s.key && ko.has(s.tag) && (s.props["data-hid"] = s._h = s.key),
    s.tag === "script" &&
      typeof s.innerHTML == "object" &&
      ((s.innerHTML = JSON.stringify(s.innerHTML)),
      (s.props.type = s.props.type || "application/json")),
    Array.isArray(s.props.content)
      ? s.props.content.map((r) => ({ ...s, props: { ...s.props, content: r } }))
      : s
  );
}
function Do(t, e) {
  if (!t) return [];
  typeof t == "function" && (t = t());
  const n = (r, o) => {
    for (let i = 0; i < e.length; i++) o = e[i](r, o);
    return o;
  };
  t = n(void 0, t);
  const s = [];
  return (
    (t = Pt(t, n)),
    Object.entries(t || {}).forEach(([r, o]) => {
      if (o !== void 0) for (const i of Array.isArray(o) ? o : [o]) s.push(Ro(r, i));
    }),
    s.flat()
  );
}
const Jn = (t, e) => (t._w === e._w ? t._p - e._p : t._w - e._w),
  Un = { base: -10, title: 10 },
  jo = { critical: -8, high: -1, low: 2 },
  Kn = {
    meta: { "content-security-policy": -30, charset: -20, viewport: -15 },
    link: {
      preconnect: 20,
      stylesheet: 60,
      preload: 70,
      modulepreload: 70,
      prefetch: 90,
      "dns-prefetch": 90,
      prerender: 90,
    },
    script: { async: 30, defer: 80, sync: 50 },
    style: { imported: 40, sync: 60 },
  },
  No = /@import/,
  nt = (t) => t === "" || t === !0;
function Ho(t, e) {
  if (typeof e.tagPriority == "number") return e.tagPriority;
  let n = 100;
  const s = jo[e.tagPriority] || 0,
    r = t.resolvedOptions.disableCapoSorting ? { link: {}, script: {}, style: {} } : Kn;
  if (e.tag in Un) n = Un[e.tag];
  else if (e.tag === "meta") {
    const o =
      e.props["http-equiv"] === "content-security-policy"
        ? "content-security-policy"
        : e.props.charset
          ? "charset"
          : e.props.name === "viewport"
            ? "viewport"
            : null;
    o && (n = Kn.meta[o]);
  } else if (e.tag === "link" && e.props.rel) n = r.link[e.props.rel];
  else if (e.tag === "script") {
    const o = String(e.props.type);
    nt(e.props.async)
      ? (n = r.script.async)
      : (e.props.src &&
            !nt(e.props.defer) &&
            !nt(e.props.async) &&
            o !== "module" &&
            !o.endsWith("json")) ||
          (e.innerHTML && !o.endsWith("json"))
        ? (n = r.script.sync)
        : ((nt(e.props.defer) && e.props.src && !nt(e.props.async)) || o === "module") &&
          (n = r.script.defer);
  } else
    e.tag === "style" &&
      (n = e.innerHTML && No.test(e.innerHTML) ? r.style.imported : r.style.sync);
  return (n || 100) + s;
}
function Gn(t, e) {
  const n = typeof e == "function" ? e(t) : e,
    s = n.key || String(t.plugins.size + 1);
  t.plugins.get(s) || (t.plugins.set(s, n), t.hooks.addHooks(n.hooks || {}));
}
function xo(t = {}) {
  let a;
  const e = Lo();
  e.addHooks(t.hooks || {});
  const n = !t.document,
    s = new Map(),
    r = new Map(),
    o = new Set(),
    i = {
      _entryCount: 1,
      plugins: r,
      dirty: !1,
      resolvedOptions: t,
      hooks: e,
      ssr: n,
      entries: s,
      headEntries() {
        return [...s.values()];
      },
      use: (l) => Gn(i, l),
      push(l, c) {
        const u = { ...(c || {}) };
        delete u.head;
        const h = u._index ?? i._entryCount++,
          p = { _i: h, input: l, options: u },
          f = {
            _poll(d = !1) {
              (i.dirty = !0), !d && o.add(h), e.callHook("entries:updated", i);
            },
            dispose() {
              s.delete(h) && i.invalidate();
            },
            patch(d) {
              (!u.mode || (u.mode === "server" && n) || (u.mode === "client" && !n)) &&
                ((p.input = d), s.set(h, p), f._poll());
            },
          };
        return f.patch(l), f;
      },
      async resolveTags() {
        const l = { tagMap: new Map(), tags: [], entries: [...i.entries.values()] };
        for (await e.callHook("entries:resolve", l); o.size; ) {
          const f = o.values().next().value;
          o.delete(f);
          const d = s.get(f);
          if (d) {
            const g = {
              tags: Do(d.input, t.propResolvers || []).map((m) => Object.assign(m, d.options)),
              entry: d,
            };
            await e.callHook("entries:normalize", g),
              (d._tags = g.tags.map(
                (m, v) => (
                  (m._w = Ho(i, m)),
                  (m._p = (d._i << 10) + v),
                  (m._d = gn(m)),
                  m._d || (m._h = Us(m)),
                  m
                )
              ));
          }
        }
        let c = !1;
        l.entries
          .flatMap((f) => (f._tags || []).map((d) => ({ ...d, props: { ...d.props } })))
          .sort(Jn)
          .reduce((f, d) => {
            const g = d._d || d._h;
            if (!f.has(g)) return f.set(g, d);
            const m = f.get(g);
            if (
              ((d == null ? void 0 : d.tagDuplicateStrategy) ||
                (To.has(d.tag) ? "merge" : null) ||
                (d.key && d.key === m.key ? "merge" : null)) === "merge"
            ) {
              const y = { ...m.props };
              Object.entries(d.props).forEach(
                ([w, b]) =>
                  (y[w] =
                    w === "style"
                      ? new Map([...(m.props.style || new Map()), ...b])
                      : w === "class"
                        ? new Set([...(m.props.class || new Set()), ...b])
                        : b)
              ),
                f.set(g, { ...d, props: y });
            } else
              d._p >> 10 === m._p >> 10 && d.tag === "meta" && Js(g)
                ? (f.set(g, Object.assign([...(Array.isArray(m) ? m : [m]), d], d)), (c = !0))
                : (d._w === m._w
                    ? d._p > m._p
                    : (d == null ? void 0 : d._w) < (m == null ? void 0 : m._w)) && f.set(g, d);
            return f;
          }, l.tagMap);
        const u = l.tagMap.get("title"),
          h = l.tagMap.get("titleTemplate");
        if (((i._title = u == null ? void 0 : u.textContent), h)) {
          const f = h == null ? void 0 : h.textContent;
          if (((i._titleTemplate = f), f)) {
            let d = typeof f == "function" ? f(u == null ? void 0 : u.textContent) : f;
            typeof d == "string" &&
              !i.plugins.has("template-params") &&
              (d = d.replace("%s", (u == null ? void 0 : u.textContent) || "")),
              u
                ? d === null
                  ? l.tagMap.delete("title")
                  : l.tagMap.set("title", { ...u, textContent: d })
                : ((h.tag = "title"), (h.textContent = d));
          }
        }
        (l.tags = Array.from(l.tagMap.values())),
          c && (l.tags = l.tags.flat().sort(Jn)),
          await e.callHook("tags:beforeResolve", l),
          await e.callHook("tags:resolve", l),
          await e.callHook("tags:afterResolve", l);
        const p = [];
        for (const f of l.tags) {
          const { innerHTML: d, tag: g, props: m } = f;
          if (
            _o.has(g) &&
            !(Object.keys(m).length === 0 && !f.innerHTML && !f.textContent) &&
            !(g === "meta" && !m.content && !m["http-equiv"] && !m.charset)
          ) {
            if (g === "script" && d) {
              if (String(m.type).endsWith("json")) {
                const v = typeof d == "string" ? d : JSON.stringify(d);
                f.innerHTML = v.replace(/</g, "\\u003C");
              } else
                typeof d == "string" &&
                  (f.innerHTML = d.replace(new RegExp(`</${g}`, "g"), `<\\/${g}`));
              f._d = gn(f);
            }
            p.push(f);
          }
        }
        return p;
      },
      invalidate() {
        for (const l of s.values()) o.add(l._i);
        (i.dirty = !0), e.callHook("entries:updated", i);
      },
    };
  return (
    ((t == null ? void 0 : t.plugins) || []).forEach((l) => Gn(i, l)),
    i.hooks.callHook("init", i),
    (a = t.init) == null || a.forEach((l) => l && i.push(l)),
    i
  );
}
const Fo = (t, e) => (Pr(e) ? un(e) : e),
  Gs = "usehead";
function zo(t) {
  return {
    install(n) {
      (n.config.globalProperties.$unhead = t),
        (n.config.globalProperties.$head = t),
        n.provide(Gs, t);
    },
  }.install;
}
function Vo() {
  if (Cr()) {
    const t = Ds(Gs);
    if (t) return t;
  }
  throw new Error(
    "useHead() was called without provide context, ensure you call it through the setup() function."
  );
}
function qo(t, e = {}) {
  const n = e.head || Vo();
  return n.ssr ? n.push(t || {}, e) : Wo(n, t, e);
}
function Wo(t, e, n = {}) {
  const s = E(!1);
  let r;
  return (
    Qe(() => {
      const i = s.value ? {} : Pt(e, Fo);
      r ? r.patch(i) : (r = t.push(i, n));
    }),
    js() &&
      (Ir(() => {
        r.dispose();
      }),
      Rr(() => {
        s.value = !0;
      }),
      Dr(() => {
        s.value = !1;
      })),
    r
  );
}
function mn(t) {
  if (t === !1 || t === "false") return null;
  if (t == null || t === !0 || t === "true") return "+1";
  if (typeof t == "string" && "+-".includes(t[0])) return t;
  const e = +t;
  return Number.isNaN(e)
    ? (console.error(`Invalid "at" prop value: ${t}`), null)
    : e <= 0
      ? (console.warn(
          `[Slidev] "at" prop value must be greater than 0, but got ${t}, has been set to 1`
        ),
        1)
      : e;
}
function Bo(t) {
  return Array.isArray(t) ? [mn(t[0]), mn(t[1])] : null;
}
function Qs(t, e = 0, n) {
  const s = E(!1);
  let r = new Map(),
    o = new Map();
  const i = {
    get current() {
      return hn(+t.value, e, i.total);
    },
    set current(a) {
      t.value = s.value ? hn(a, e, i.total) : a;
    },
    clicksStart: e,
    get relativeSizeMap() {
      return r;
    },
    get maxMap() {
      return o;
    },
    get isMounted() {
      return s.value;
    },
    setup() {
      Ns(() => {
        (s.value = !0), (o = C(o)), jr(t) || (i.current = t.value);
      }),
        Nr(() => {
          (s.value = !1), (r = new Map()), (o = new Map());
        });
    },
    calculateSince(a, l = 1) {
      const c = mn(a);
      if (c == null) return null;
      let u, h, p;
      if (typeof c == "string") {
        const f = i.currentOffset,
          d = +c;
        (u = f + d), (h = f + d + l - 1), (p = d + l - 1);
      } else (u = c), (h = c + l - 1), (p = 0);
      return {
        start: u,
        end: +Number.POSITIVE_INFINITY,
        max: h,
        delta: p,
        currentOffset: _(() => i.current - u),
        isCurrent: _(() => i.current === u),
        isActive: _(() => i.current >= u),
      };
    },
    calculateRange(a) {
      const l = Bo(a);
      if (l == null) return null;
      const [c, u] = l;
      let h, p, f;
      return (
        typeof c == "string" ? ((h = i.currentOffset + +c), (f = +c)) : ((h = c), (f = 0)),
        typeof u == "string" ? ((p = h + +u), (f += +u)) : (p = u),
        {
          start: h,
          end: p,
          max: p,
          delta: f,
          currentOffset: _(() => i.current - h),
          isCurrent: _(() => i.current === h),
          isActive: _(() => h <= i.current && i.current < p),
        }
      );
    },
    calculate(a) {
      return Array.isArray(a) ? i.calculateRange(a) : i.calculateSince(a);
    },
    register(a, l) {
      if (!l) return;
      const { delta: c, max: u } = l;
      r.set(a, c), o.set(a, u);
    },
    unregister(a) {
      r.delete(a), o.delete(a);
    },
    get currentOffset() {
      return uo(...r.values());
    },
    get total() {
      return n ?? (s.value ? Math.max(0, ...o.values()) : 0);
    },
  };
  return i;
}
function Jo(t, e = 0) {
  let r, o;
  const n =
      ((r = t == null ? void 0 : t.meta.slide) == null ? void 0 : r.frontmatter.clicksStart) ?? 0,
    s = E(Math.max(un(e), n));
  return (
    ee(
      () => un(e),
      (i) => {
        s.value = Math.max(i, n);
      }
    ),
    Qs(s, n, (o = t == null ? void 0 : t.meta) == null ? void 0 : o.clicks)
  );
}
const Uo = "modulepreload",
  Ko = function (t) {
    return `/talks/when-the-agent-is-wrong/${t}`;
  },
  Qn = {},
  $ = function (e, n, s) {
    let r = Promise.resolve();
    if (n && n.length > 0) {
      const i = function (c) {
        return Promise.all(
          c.map((u) =>
            Promise.resolve(u).then(
              (h) => ({ status: "fulfilled", value: h }),
              (h) => ({ status: "rejected", reason: h })
            )
          )
        );
      };
      document.getElementsByTagName("link");
      const a = document.querySelector("meta[property=csp-nonce]"),
        l = (a == null ? void 0 : a.nonce) || (a == null ? void 0 : a.getAttribute("nonce"));
      r = i(
        n.map((c) => {
          if (((c = Ko(c)), c in Qn)) return;
          Qn[c] = !0;
          const u = c.endsWith(".css"),
            h = u ? '[rel="stylesheet"]' : "";
          if (document.querySelector(`link[href="${c}"]${h}`)) return;
          const p = document.createElement("link");
          if (
            ((p.rel = u ? "stylesheet" : Uo),
            u || (p.as = "script"),
            (p.crossOrigin = ""),
            (p.href = c),
            l && p.setAttribute("nonce", l),
            document.head.appendChild(p),
            u)
          )
            return new Promise((f, d) => {
              p.addEventListener("load", f),
                p.addEventListener("error", () => d(new Error(`Unable to preload CSS for ${c}`)));
            });
        })
      );
    }
    function o(i) {
      const a = new Event("vite:preloadError", { cancelable: !0 });
      if (((a.payload = i), window.dispatchEvent(a), !a.defaultPrevented)) throw i;
    }
    return r.then((i) => {
      for (const a of i || []) a.status === "rejected" && o(a.reason);
      return e().catch(o);
    });
  },
  Go = (t, e) => {
    const n = t.__vccOpts || t;
    for (const [s, r] of e) n[s] = r;
    return n;
  },
  Qo = {},
  Yo = { class: "px-4 py-10 text-center text-red-700 dark:text-red-500 font-bold font-mono" };
function Zo(t, e) {
  return (
    Lt(), fn("div", Yo, Hr("Failed to fetch this slide. Please check your network connection."))
  );
}
const I = Go(Qo, [["render", Zo]]),
  Xo = { class: "h-full w-full flex items-center justify-center gap-2 slidev-slide-loading" },
  ei = Hs({
    __name: "SlideLoading",
    setup(t) {
      const e = E(!1);
      return (
        Ns(() => {
          setTimeout(() => {
            e.value = !0;
          }, 200);
        }),
        (n, s) => (
          Lt(),
          fn("div", Xo, [
            e.value
              ? (Lt(),
                fn(
                  xr,
                  { key: 0 },
                  [
                    s[0] ||
                      (s[0] = Wn(
                        "div",
                        { class: "i-svg-spinners-90-ring-with-bg text-xl" },
                        null,
                        -1
                      )),
                    s[1] || (s[1] = Wn("div", null, "Loading slide...", -1)),
                  ],
                  64
                ))
              : Fr("v-if", !0),
          ])
        )
      );
    },
  }),
  ti = {
    theme: "none",
    title: "When the Agent is Wrong",
    info: `Case study: metacognitive infrastructure in practice.
Minsky — the cyberbrain for software organizations.
`,
    highlighter: "shiki",
    drawings: { persist: !1 },
    transition: "none",
    mdc: !0,
    fonts: { sans: "Geist", mono: "JetBrains Mono" },
    css: "unocss",
    aspectRatio: "16/9",
    canvasWidth: 980,
    overview: !1,
  },
  de = L(ti),
  ni = C({
    get layout() {
      return de.layout;
    },
    get transition() {
      return de.transition;
    },
    get class() {
      return de.class;
    },
    get clicks() {
      return de.clicks;
    },
    get name() {
      return de.name;
    },
    get preload() {
      return de.preload;
    },
    slide: {
      content: "",
      revision: "1y5p0h",
      frontmatterRaw: `theme: none
title: "When the Agent is Wrong"
info: |
  Case study: metacognitive infrastructure in practice.
  Minsky — the cyberbrain for software organizations.
highlighter: shiki
drawings:
  persist: false
transition: none
mdc: true
fonts:
  sans: Geist
  mono: JetBrains Mono
css: unocss
aspectRatio: 16/9
canvasWidth: 980
overview: false
`,
      note: "",
      title: "When the Agent is Wrong",
      index: 0,
      noteHTML: `<p>This talk is about what happens after an AI agent makes a mistake — and about what infrastructure makes &quot;after&quot; different from &quot;again.&quot; I'm going to walk through a real incident from last week, show you the full chain of what fired, and then pull back to the theory of why it works.</p>
`,
      raw: "",
      frontmatter: de,
      filepath: "",
      start: 0,
      id: 0,
      no: 1,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  si = {},
  pe = L(si),
  ri = C({
    get layout() {
      return pe.layout;
    },
    get transition() {
      return pe.transition;
    },
    get class() {
      return pe.class;
    },
    get clicks() {
      return pe.clicks;
    },
    get name() {
      return pe.name;
    },
    get preload() {
      return pe.preload;
    },
    slide: {
      content: "",
      revision: "g5vr1p",
      note: "",
      title: "What Minsky is",
      level: 2,
      index: 1,
      noteHTML: `<p>Minsky is a dev workflow orchestration platform. Here's the scope: tasks with a spec-driven lifecycle. Sessions that isolate each unit of work. A persistent memory system that carries knowledge across sessions. A compiled rules corpus. Skills — structured multi-step workflows like the retrospective we're about to see. Hooks — environmental enforcement gates that fire automatically. An adversarial reviewer bot. An asks system for structured escalation to the principal. A mesh for multi-agent coordination. And a cockpit — an operator dashboard for mission control. The thesis: the same control structures that keep human teams aligned work for AI agents. Environmental constraints that make good behavior the path of least resistance.</p>
`,
      raw: "",
      frontmatter: pe,
      filepath: "",
      start: 38,
      id: 1,
      no: 2,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  oi = {},
  ge = L(oi),
  ii = C({
    get layout() {
      return ge.layout;
    },
    get transition() {
      return ge.transition;
    },
    get class() {
      return ge.class;
    },
    get clicks() {
      return ge.clicks;
    },
    get name() {
      return ge.name;
    },
    get preload() {
      return ge.preload;
    },
    slide: {
      content: "",
      revision: "j40ve7",
      note: "",
      title: "Organizational cybernetics",
      level: 2,
      index: 2,
      noteHTML: `<p>Organizational cybernetics: every viable organization — person, team, corporation, agent network — is structurally self-similar. Beer formalized this as 5 systems. System 1: operations, the units doing work. System 2: coordination, preventing conflicts. System 3: operational feedback — observing what operations actually produce and correcting drift. This is the one we'll see most today. System 4: environmental intelligence. System 5: identity. Ashby's Law is the constraint: variety — the entropy of your configuration space, the number of states your system can be in — must be matched by regulatory variety. More failure modes your agents can produce, more hooks and gates and scanners you need. Minsky's claim: for AI agents, these organs are buildable as infrastructure. That's what we're about to see.</p>
`,
      raw: "",
      frontmatter: ge,
      filepath: "",
      start: 65,
      id: 2,
      no: 3,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  ai = {},
  me = L(ai),
  li = C({
    get layout() {
      return me.layout;
    },
    get transition() {
      return me.transition;
    },
    get class() {
      return me.class;
    },
    get clicks() {
      return me.clicks;
    },
    get name() {
      return me.name;
    },
    get preload() {
      return me.preload;
    },
    slide: {
      content: "",
      revision: "-z8dwq3",
      note: "",
      title: "The setup",
      level: 2,
      index: 3,
      noteHTML: `<p>Minsky is a TypeScript monorepo. We have multiple deployed services — the MCP server, the reviewer bot — that all need the same domain layer: database access, task management, session lifecycle, configuration. That domain code lived inside the main package, so each service was either duplicating it or calling over HTTP. The fix is to extract it into a shared package. The investigation found 224 files that would need import path updates. Mechanical work, but large.</p>
`,
      raw: "",
      frontmatter: me,
      filepath: "",
      start: 93,
      id: 3,
      no: 4,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  ci = {},
  ye = L(ci),
  ui = C({
    get layout() {
      return ye.layout;
    },
    get transition() {
      return ye.transition;
    },
    get class() {
      return ye.class;
    },
    get clicks() {
      return ye.clicks;
    },
    get name() {
      return ye.name;
    },
    get preload() {
      return ye.preload;
    },
    slide: {
      content: "",
      revision: "-hou7s2",
      note: "",
      title: "The shortcut",
      level: 2,
      index: 4,
      noteHTML: `<p>The agent proposed a shortcut: create a thin proxy package — a barrel file — that re-exports everything from the original location. The code doesn't move. One file instead of touching 224. It's a well-known pattern. It's also a well-known anti-pattern.</p>
`,
      raw: "",
      frontmatter: ye,
      filepath: "",
      start: 109,
      id: 4,
      no: 5,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  fi = {},
  ve = L(fi),
  hi = C({
    get layout() {
      return ve.layout;
    },
    get transition() {
      return ve.transition;
    },
    get class() {
      return ve.class;
    },
    get clicks() {
      return ve.clicks;
    },
    get name() {
      return ve.name;
    },
    get preload() {
      return ve.preload;
    },
    slide: {
      content: "",
      revision: "-u2rxxy",
      note: "",
      title: "The search that didn't happen",
      level: 2,
      index: 5,
      noteHTML: `<p>A single web search — thirty seconds — would have surfaced unambiguous community consensus. Turborepo warns against barrel files. The Nx blog advises physical moves. Bun's own workspace docs say &quot;if you find yourself writing ../ to get from one package to another, rethink.&quot; The agent had a web search tool. It didn't use it.</p>
`,
      raw: "",
      frontmatter: ve,
      filepath: "",
      start: 130,
      id: 5,
      no: 6,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  di = {},
  we = L(di),
  pi = C({
    get layout() {
      return we.layout;
    },
    get transition() {
      return we.transition;
    },
    get class() {
      return we.class;
    },
    get clicks() {
      return we.clicks;
    },
    get name() {
      return we.name;
    },
    get preload() {
      return we.preload;
    },
    slide: {
      content: "",
      revision: "xfpppw",
      note: "",
      title: "Runtime error on a nonexistent export",
      level: 2,
      index: 6,
      noteHTML: `<p>It failed within minutes. A runtime error on a nonexistent export — exactly the class of bug that barrel files are documented to cause. The re-export layer decouples type-checking from reality. The pattern the agent chose, the failure it produced, and the community's warning were all the same thing.</p>
`,
      raw: "",
      frontmatter: we,
      filepath: "",
      start: 146,
      id: 6,
      no: 7,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  gi = {},
  ke = L(gi),
  mi = C({
    get layout() {
      return ke.layout;
    },
    get transition() {
      return ke.transition;
    },
    get class() {
      return ke.class;
    },
    get clicks() {
      return ke.clicks;
    },
    get name() {
      return ke.name;
    },
    get preload() {
      return ke.preload;
    },
    slide: {
      content: "",
      revision: "m3filz",
      note: "",
      title: "The meta-failure",
      level: 2,
      index: 7,
      noteHTML: `<p>Here's where it gets interesting. The agent recognized its mistake. It said &quot;I should be honest&quot; — that's self-recognized failure language. In Minsky's system, that sentence is supposed to trigger a structured retrospective process. The agent described the finding, proposed to pivot, and waited. It didn't invoke the process. The recognition happened; the response mechanism didn't fire.</p>
`,
      raw: "",
      frontmatter: ke,
      filepath: "",
      start: 162,
      id: 7,
      no: 8,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  yi = {},
  be = L(yi),
  vi = C({
    get layout() {
      return be.layout;
    },
    get transition() {
      return be.transition;
    },
    get class() {
      return be.class;
    },
    get clicks() {
      return be.clicks;
    },
    get name() {
      return be.name;
    },
    get preload() {
      return be.preload;
    },
    slide: {
      content: "",
      revision: "gjjrs6",
      note: "",
      title: "Structured retrospective",
      level: 2,
      index: 8,
      noteHTML: `<p>Here's the actual retrospective output from the incident. On the left, the six-step process. On the right, what it produced for this specific case. Premise confirmed — barrel re-exports are documented anti-pattern. Verification error — scope reduction over correctness. The structural gap: nothing in the implementation process requires checking architectural patterns against community practice. Root cause: defaults to the lower-effort path. And critically — the recurrence check found five prior instances of the same root pattern. The fixes: a memory entry, a corpus rule update, a hook trigger extension, and a new checklist item in the implementation gate. Each of these persists across sessions.</p>
`,
      raw: "",
      frontmatter: be,
      filepath: "",
      start: 178,
      id: 8,
      no: 9,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  wi = {},
  e = L(wi),
  ki = C({
    get layout() {
      return _e.layout;
    },
    get transition() {
      return _e.transition;
    },
    get class() {
      return _e.class;
    },
    get clicks() {
      return _e.clicks;
    },
    get name() {
      return _e.name;
    },
    get preload() {
      return _e.preload;
    },
    slide: {
      content: "",
      revision: "-y61wzr",
      note: "",
      title: "Verification Error",
      level: 2,
      index: 9,
      noteHTML: `<p>Classification: verification error. The agent optimized for scope reduction — touching one file instead of 224 — over correctness. It had a web search tool available and didn't use it. The structural gap: nothing in the implementation process requires checking whether an architectural pattern is a known anti-pattern before implementing it. Security surfaces have a community-practice gate. Dependencies have a verification gate. Architectural patterns had nothing.</p>
`,
      raw: "",
      frontmatter: _e,
      filepath: "",
      start: 215,
      id: 9,
      no: 10,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  bi = {},
  Se = L(bi),
  i = C({
    get layout() {
      return Se.layout;
    },
    get transition() {
      return Se.transition;
    },
    get class() {
      return Se.class;
    },
    get clicks() {
      return Se.clicks;
    },
    get name() {
      return Se.name;
    },
    get preload() {
      return Se.preload;
    },
    slide: {
      content: "",
      revision: "lhakp9",
      note: "",
      title: "Defaults to the lower-effort path",
      level: 2,
      index: 10,
      noteHTML: `<p>Root cause: the agent defaults to the lower-effort path at action-execution time without evaluating whether the path is correct. This isn't laziness in a human sense — it's a model optimization pattern. The cheaper action that satisfies the immediate requirement wins over the correct action that requires a research step first. And here's the key finding: this is the same root cause as five prior incidents over the preceding two weeks.</p>
`,
      raw: "",
      frontmatter: Se,
      filepath: "",
      start: 231,
      id: 10,
      no: 11,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  Si = {},
  Me = L(Si),
  Mi = C({
    get layout() {
      return Me.layout;
    },
    get transition() {
      return Me.transition;
    },
    get class() {
      return Me.class;
    },
    get clicks() {
      return Me.clicks;
    },
    get name() {
      return Me.name;
    },
    get preload() {
      return Me.preload;
    },
    slide: {
      content: "",
      revision: "rx55y",
      note: "",
      title: "Durable artifacts",
      level: 2,
      index: 11,
      noteHTML: `<p>The retrospective produced durable artifacts. A new checklist item in the implementation process: before implementing a significant architectural pattern, verify against community practice. A new trigger family for the hook that detects self-recognized failure language. A memory entry in the database. A task filed for the structural fix. All of these persist across sessions — the next agent that hits a similar choice point will have the checklist in its loaded context.</p>
`,
      raw: "",
      frontmatter: Me,
      filepath: "",
      start: 247,
      id: 11,
      no: 12,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  Ti = {},
  Te = L(Ti),
  Oi = C({
    get layout() {
      return Te.layout;
    },
    get transition() {
      return Te.transition;
    },
    get class() {
      return Te.class;
    },
    get clicks() {
      return Te.clicks;
    },
    get name() {
      return Te.name;
    },
    get preload() {
      return Te.preload;
    },
    slide: {
      content: "",
      revision: "-cin6kl",
      note: "",
      title: "instances, same root, two weeks",
      level: 2,
      index: 12,
      noteHTML: `<p>Here's where Minsky's infrastructure does something no stateless agent can do. The retrospective's recurrence check — step 4 — searched the memory database for prior instances of the same pattern. It found five. Spanning two weeks. Six total instances of the same root failure across completely different task contexts.</p>
`,
      raw: "",
      frontmatter: Te,
      filepath: "",
      start: 264,
      id: 12,
      no: 13,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  Ai = {},
  Oe = L(Ai),
  Ei = C({
    get layout() {
      return Oe.layout;
    },
    get transition() {
      return Oe.transition;
    },
    get class() {
      return Oe.class;
    },
    get clicks() {
      return Oe.clicks;
    },
    get name() {
      return Oe.name;
    },
    get preload() {
      return Oe.preload;
    },
    slide: {
      content: "",
      revision: "y1kmp3",
      note: "",
      title: "The build-path-as-research family",
      level: 2,
      index: 13,
      noteHTML: `<p>Here's the family tree. R1-R2: agent bypassed a SaaS evaluation step by extracting from in-house logs — cheaper path, skipped the research. R3: agent built against raw JSONL instead of extending the canonical database — ad-hoc path, skipped the substrate. R4: agent wrote a retrospective inline instead of invoking the retrospective skill — reproduction of the form, not the function. R5: agent verbally committed to updating memory without calling the tool — promise evaporated at session end. R6: our barrel incident. Same root pattern. Six different surfaces.</p>
`,
      raw: "",
      frontmatter: Oe,
      filepath: "",
      start: 280,
      id: 13,
      no: 14,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  $i = {},
  Ae = L($i),
  Li = C({
    get layout() {
      return Ae.layout;
    },
    get transition() {
      return Ae.transition;
    },
    get class() {
      return Ae.class;
    },
    get clicks() {
      return Ae.clicks;
    },
    get name() {
      return Ae.name;
    },
    get preload() {
      return Ae.preload;
    },
    slide: {
      content: "",
      revision: "jslol3",
      note: "",
      title: "Why stateless fails",
      level: 2,
      index: 14,
      noteHTML: `<p>A stateless agent — Claude, GPT, any model without persistent memory — would have treated the barrel incident as a one-off. It wouldn't know about R1 through R5. It can't connect six incidents across two weeks into a single pattern family. It would say &quot;I'll be more careful&quot; — and on the next novel surface, where none of the specific fixes apply, it would do the exact same thing. The pattern is invisible without cross-session memory.</p>
`,
      raw: "",
      frontmatter: Ae,
      filepath: "",
      start: 318,
      id: 14,
      no: 15,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  Pi = {},
  Ee = L(Pi),
  Ci = C({
    get layout() {
      return Ee.layout;
    },
    get transition() {
      return Ee.transition;
    },
    get class() {
      return Ee.class;
    },
    get clicks() {
      return Ee.clicks;
    },
    get name() {
      return Ee.name;
    },
    get preload() {
      return Ee.preload;
    },
    slide: {
      content: "",
      revision: "n2nmwr",
      note: "",
      title: "What made this possible",
      level: 2,
      index: 15,
      noteHTML: `<p>Four pieces of infrastructure made the full retrospective chain possible. Cross-session memory: the pattern is visible across time. Structured retrospective: produces artifacts that change behavior, not just acknowledgments. Tiered escalation: each recurrence gets stronger enforcement. Environmental pre-delegation: hooks fire automatically without the agent needing to remember to check.</p>
`,
      raw: "",
      frontmatter: Ee,
      filepath: "",
      start: 342,
      id: 15,
      no: 16,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  Ii = {},
  $e = L(Ii),
  Ri = C({
    get layout() {
      return $e.layout;
    },
    get transition() {
      return $e.transition;
    },
    get class() {
      return $e.class;
    },
    get clicks() {
      return $e.clicks;
    },
    get name() {
      return $e.name;
    },
    get preload() {
      return $e.preload;
    },
    slide: {
      content: "",
      revision: "1kgcf3",
      note: "",
      title: "Cross-session memory",
      level: 2,
      index: 16,
      noteHTML: `<p>The memory system stores each retrospective finding as a structured record. When the R6 retrospective ran its recurrence check, it did a semantic search — not keyword matching — over the full memory database. It found R1-R5 across different sessions, different days, different task contexts. The semantic similarity was in the cognitive pattern, not the surface details. Without persistent memory, each failure is the agent's first failure.</p>
`,
      raw: "",
      frontmatter: $e,
      filepath: "",
      start: 357,
      id: 16,
      no: 17,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  Di = {},
  Le = L(Di),
  ji = C({
    get layout() {
      return Le.layout;
    },
    get transition() {
      return Le.transition;
    },
    get class() {
      return Le.class;
    },
    get clicks() {
      return Le.clicks;
    },
    get name() {
      return Le.name;
    },
    get preload() {
      return Le.preload;
    },
    slide: {
      content: "",
      revision: "-rphzfz",
      note: "",
      title: "Tiered escalation",
      level: 2,
      index: 17,
      noteHTML: `<p>The escalation tiers. R1 produced a memory entry — advice the agent has to choose to read. R2 promoted it to a corpus rule — injected into every session's context. R3-R5 shipped a hook — a scanner that runs on every agent turn and detects substrate-bypass language automatically. R6 extended the hook's patterns and added a gate to the implementation process. Each tier is harder to bypass. The system's containment improves monotonically with each recurrence.</p>
`,
      raw: "",
      frontmatter: Le,
      filepath: "",
      start: 373,
      id: 17,
      no: 18,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  Ni = {},
  Pe = L(Ni),
  Hi = C({
    get layout() {
      return Pe.layout;
    },
    get transition() {
      return Pe.transition;
    },
    get class() {
      return Pe.class;
    },
    get clicks() {
      return Pe.clicks;
    },
    get name() {
      return Pe.name;
    },
    get preload() {
      return Pe.preload;
    },
    slide: {
      content: "",
      revision: "-wb2ks5",
      note: "",
      title: "Environmental pre-delegation",
      level: 2,
      index: 18,
      noteHTML: `<p>This is the key architectural insight. The hooks aren't instructions the agent has to remember — they're environmental constraints that fire automatically. The retrospective trigger scanner runs on every single user prompt, scanning the prior agent turn for self-recognized failure language. The agent doesn't need to remember to self-check. The environment checks for it. This is Ashby's Law of Requisite Variety in practice: the regulatory variety of the system has to match the variety of disturbances it faces. Each new failure pattern widens the scanner's variety.</p>
`,
      raw: "",
      frontmatter: Pe,
      filepath: "",
      start: 404,
      id: 18,
      no: 19,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  xi = {},
  Ce = L(xi),
  Fi = C({
    get layout() {
      return Ce.layout;
    },
    get transition() {
      return Ce.transition;
    },
    get class() {
      return Ce.class;
    },
    get clicks() {
      return Ce.clicks;
    },
    get name() {
      return Ce.name;
    },
    get preload() {
      return Ce.preload;
    },
    slide: {
      content: "",
      revision: "-141360",
      note: "",
      title: "The meta-failure as evidence",
      level: 2,
      index: 19,
      noteHTML: `<p>Here's why the meta-failure matters as evidence. The agent said &quot;the barrel approach is an anti-pattern&quot; — that's a third-person observation about the world. The trigger scanner matched first-person failure language: &quot;I was wrong,&quot; &quot;I should have caught this.&quot; The reframing — &quot;X is an anti-pattern&quot; instead of &quot;I chose an anti-pattern&quot; — slipped past the regex. The meta-failure produced its own fix: a new trigger family (R5 patterns) that catches finding-reframing language. The system improved because it failed. That IS the point.</p>
`,
      raw: "",
      frontmatter: Ce,
      filepath: "",
      start: 422,
      id: 19,
      no: 20,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  zi = {},
  Ie = L(zi),
  Vi = C({
    get layout() {
      return Ie.layout;
    },
    get transition() {
      return Ie.transition;
    },
    get class() {
      return Ie.class;
    },
    get clicks() {
      return Ie.clicks;
    },
    get name() {
      return Ie.name;
    },
    get preload() {
      return Ie.preload;
    },
    slide: {
      content: "",
      revision: "-gyauzx",
      note: "",
      title: "The viable cognitive system",
      level: 2,
      index: 20,
      noteHTML: `<p>The theoretical frame is Stafford Beer's Viable System Model. The retrospective is System 3 — operational feedback. It observes what the agents actually produce, compares to what they should produce, and feeds corrections back. The trigger scanner is System 3-star — the audit channel. It spot-checks whether behavior matches declared intent. The escalation tiers are variety amplification in Ashby's sense: each failure reveals insufficient regulatory variety; each fix amplifies it at a higher tier.</p>
`,
      raw: "",
      frontmatter: Ie,
      filepath: "",
      start: 446,
      id: 20,
      no: 21,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  qi = {},
  Re = L(qi),
  Wi = C({
    get layout() {
      return Re.layout;
    },
    get transition() {
      return Re.transition;
    },
    get class() {
      return Re.class;
    },
    get clicks() {
      return Re.clicks;
    },
    get name() {
      return Re.name;
    },
    get preload() {
      return Re.preload;
    },
    slide: {
      content: "",
      revision: "lrcx3v",
      note: "",
      title: "Infrastructure, not capability",
      level: 2,
      index: 21,
      noteHTML: `<p>This is the thesis. These metacognitive organs — self-monitoring, durable memory, escalation tiers, environmental enforcement — can be built as infrastructure rather than required as capabilities of the underlying model. The model doesn't need to be better at introspection; the environment introspects on its behalf. The model doesn't need a longer memory; the memory system persists across sessions. The model doesn't need to remember to escalate; the tier system escalates on recurrence count.</p>
`,
      raw: "",
      frontmatter: Re,
      filepath: "",
      start: 467,
      id: 21,
      no: 22,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  Bi = {},
  De = L(Bi),
  Ji = C({
    get layout() {
      return De.layout;
    },
    get transition() {
      return De.transition;
    },
    get class() {
      return De.class;
    },
    get clicks() {
      return De.clicks;
    },
    get name() {
      return De.name;
    },
    get preload() {
      return De.preload;
    },
    slide: {
      content: "",
      revision: "-i83ht8",
      note: "",
      title: "A stateless agent has no System 3.<br>No audit channel. No escalation tiers.",
      level: 2,
      index: 22,
      noteHTML: `<p>A stateless agent has strong System 1 — it can do work. It has some System 5 — it has instructions. But the feedback and coordination organs are absent. Each session is a fresh start. Each mistake is a first mistake. Minsky's contribution is that these organs are infrastructure. The thirty-second search that didn't happen is a small incident. But it took the full weight of the metacognitive infrastructure to ensure that the same class of mistake gets harder to make every time it occurs. The system improved because it failed. That's the point.</p>
`,
      raw: "",
      frontmatter: De,
      filepath: "",
      start: 494,
      id: 22,
      no: 23,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  Ui = {},
  je = L(Ui),
  Ki = C({
    get layout() {
      return je.layout;
    },
    get transition() {
      return je.transition;
    },
    get class() {
      return je.class;
    },
    get clicks() {
      return je.clicks;
    },
    get name() {
      return je.name;
    },
    get preload() {
      return je.preload;
    },
    slide: {
      content: "",
      revision: "k6q62k",
      note: "",
      title: "The cyberbrain for software organizations",
      level: 2,
      index: 23,
      noteHTML: `<p>Closing resources slide: repo and slides as QR + text, a call-to-action, and contact handle. Kept separate from the rhetorical closer so the &quot;that's the point&quot; landing stays clean.</p>
`,
      raw: "",
      frontmatter: je,
      filepath: "",
      start: 514,
      id: 23,
      no: 24,
    },
    __clicksContext: null,
    __preloaded: !1,
  }),
  k = new Array(24),
  R = (t, e) =>
    zr({
      loader: e,
      delay: 300,
      loadingComponent: ei,
      errorComponent: I,
      onError: (n) => console.error(`Failed to load slide ${t + 1}`, n),
    }),
  Yn = async () => {
    try {
      return (
        k[0] ??
        (k[0] = await $(() => import("./md-CwugNJv9.js"), __vite__mapDeps([0, 1, 2, 3, 4, 5, 6])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  Zn = async () => {
    try {
      return (
        k[1] ??
        (k[1] = await $(() => import("./md-3ByqbAQi.js"), __vite__mapDeps([7, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  Xn = async () => {
    try {
      return (
        k[2] ??
        (k[2] = await $(() => import("./md-DV0VGgo2.js"), __vite__mapDeps([9, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  es = async () => {
    try {
      return (
        k[3] ??
        (k[3] = await $(() => import("./md-B1aCOhaI.js"), __vite__mapDeps([10, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  ts = async () => {
    try {
      return (
        k[4] ??
        (k[4] = await $(
          () => import("./slidev/md-9XCSYhTQ.js"),
          __vite__mapDeps([11, 12, 1, 3, 8, 4, 5])
        ))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  ns = async () => {
    try {
      return (
        k[5] ??
        (k[5] = await $(() => import("./md-CjDI1-kt.js"), __vite__mapDeps([13, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  ss = async () => {
    try {
      return (
        k[6] ??
        (k[6] = await $(() => import("./md-Dg3T7Ht7.js"), __vite__mapDeps([14, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  rs = async () => {
    try {
      return (
        k[7] ??
        (k[7] = await $(() => import("./md-DjrRrqKe.js"), __vite__mapDeps([15, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  os = async () => {
    try {
      return (
        k[8] ??
        (k[8] = await $(
          () => import("./slidev/md-BoWYxWXm.js"),
          __vite__mapDeps([16, 1, 3, 8, 4, 5])
        ))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  is = async () => {
    try {
      return (
        k[9] ??
        (k[9] = await $(() => import("./md-Dk4ZRs7a.js"), __vite__mapDeps([17, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  as = async () => {
    try {
      return (
        k[10] ??
        (k[10] = await $(() => import("./md-CeEI3qH4.js"), __vite__mapDeps([18, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  ls = async () => {
    try {
      return (
        k[11] ??
        (k[11] = await $(() => import("./md-C9BIPv-A.js"), __vite__mapDeps([19, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  cs = async () => {
    try {
      return (
        k[12] ??
        (k[12] = await $(() => import("./md-xV8rmEVa.js"), __vite__mapDeps([20, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  us = async () => {
    try {
      return (
        k[13] ??
        (k[13] = await $(() => import("./md-D6gPvIeW.js"), __vite__mapDeps([21, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  fs = async () => {
    try {
      return (
        k[14] ??
        (k[14] = await $(() => import("./md-Bz2oVJP_.js"), __vite__mapDeps([22, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  hs = async () => {
    try {
      return (
        k[15] ??
        (k[15] = await $(() => import("./md-B11nts_w.js"), __vite__mapDeps([23, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  ds = async () => {
    try {
      return (
        k[16] ??
        (k[16] = await $(() => import("./md-D8I4mP1_.js"), __vite__mapDeps([24, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  ps = async () => {
    try {
      return (
        k[17] ??
        (k[17] = await $(() => import("./md-BxnhzQyV.js"), __vite__mapDeps([25, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  gs = async () => {
    try {
      return (
        k[18] ??
        (k[18] = await $(() => import("./md-DSP4bw3K.js"), __vite__mapDeps([26, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  ms = async () => {
    try {
      return (
        k[19] ??
        (k[19] = await $(() => import("./md-DWteXKYz.js"), __vite__mapDeps([27, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  ys = async () => {
    try {
      return (
        k[20] ??
        (k[20] = await $(() => import("./md-l2n3CdvD.js"), __vite__mapDeps([28, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  vs = async () => {
    try {
      return (
        k[21] ??
        (k[21] = await $(() => import("./md-DARPu-FA.js"), __vite__mapDeps([29, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  ws = async () => {
    try {
      return (
        k[22] ??
        (k[22] = await $(() => import("./md-CkzLLCAW.js"), __vite__mapDeps([30, 1, 2, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  ks = async () => {
    try {
      return (
        k[23] ??
        (k[23] = await $(() => import("./md-BbSWcYwW.js"), __vite__mapDeps([31, 1, 8, 3, 4, 5])))
      );
    } catch (t) {
      return console.error("slide failed to load", t), I;
    }
  },
  Gi = [
    { no: 1, meta: ni, load: Yn, component: R(0, Yn) },
    { no: 2, meta: ri, load: Zn, component: R(1, Zn) },
    { no: 3, meta: ii, load: Xn, component: R(2, Xn) },
    { no: 4, meta: li, load: es, component: R(3, es) },
    { no: 5, meta: ui, load: ts, component: R(4, ts) },
    { no: 6, meta: hi, load: ns, component: R(5, ns) },
    { no: 7, meta: pi, load: ss, component: R(6, ss) },
    { no: 8, meta: mi, load: rs, component: R(7, rs) },
    { no: 9, meta: vi, load: os, component: R(8, os) },
    { no: 10, meta: ki, load: is, component: R(9, is) },
    { no: 11, meta: _i, load: as, component: R(10, as) },
    { no: 12, meta: Mi, load: ls, component: R(11, ls) },
    { no: 13, meta: Oi, load: cs, component: R(12, cs) },
    { no: 14, meta: Ei, load: us, component: R(13, us) },
    { no: 15, meta: Li, load: fs, component: R(14, fs) },
    { no: 16, meta: Ci, load: hs, component: R(15, hs) },
    { no: 17, meta: Ri, load: ds, component: R(16, ds) },
    { no: 18, meta: ji, load: ps, component: R(17, ps) },
    { no: 19, meta: Hi, load: gs, component: R(18, gs) },
    { no: 20, meta: Fi, load: ms, component: R(19, ms) },
    { no: 21, meta: Vi, load: ys, component: R(20, ys) },
    { no: 22, meta: Wi, load: vs, component: R(21, vs) },
    { no: 23, meta: Ji, load: ws, component: R(22, ws) },
    { no: 24, meta: Ki, load: ks, component: R(23, ks) },
  ],
  re = En(Gi);
function Ys(t, e) {
  if (!e || e === "all" || e === "*") return Bn(1, t + 1);
  if (e === "none") return [];
  const n = [];
  for (const s of e.split(/[,;]/g))
    if (!s.includes("-")) n.push(+s);
    else {
      const [r, o] = s.split("-", 2);
      n.push(...Bn(+r, o ? +o + 1 : t + 1));
    }
  return po(n)
    .filter((s) => s <= t)
    .sort((s, r) => s - r);
}
const Vt = "$$slidev-clicks-context",
  $n = "$$slidev-page",
  Zs = "$$slidev-slide-element",
  Qi = "$$slidev-slide-scale",
  Yi = "$$slidev-context",
  tc = "$$slidev-route",
  Ln = "$$slidev-render-context",
  Zi = "$$slidev-fontmatter",
  Xi = "$$slidev-slide-zoom",
  St = "slidev-vclick-target",
  st = "slidev-vclick-hidden",
  rt = "slidev-vclick-fade",
  Zt = "slidev-vclick-hidden-explicitly",
  Xt = "slidev-vclick-current",
  en = "slidev-vclick-prior",
  Mt = 999999,
  ea = ["localhost", "127.0.0.1"],
  ta = [
    "clicks",
    "clicksStart",
    "disabled",
    "hide",
    "hideInToc",
    "layout",
    "level",
    "preload",
    "routeAlias",
    "src",
    "title",
    "transition",
    "zoom",
    "dragPos",
    "lang",
  ],
  nc = [
    ...ta,
    "theme",
    "titleTemplate",
    "info",
    "author",
    "keywords",
    "presenter",
    "browserExporter",
    "download",
    "exportFilename",
    "export",
    "highlighter",
    "lineNumbers",
    "monaco",
    "monacoTypesSource",
    "monacoTypesAdditionalPackages",
    "monacoRunAdditionalDeps",
    "remoteAssets",
    "selectable",
    "record",
    "colorSchema",
    "routerMode",
    "aspectRatio",
    "canvasWidth",
    "themeConfig",
    "favicon",
    "plantUmlServer",
    "fonts",
    "defaults",
    "drawings",
    "htmlAttrs",
    "mdc",
    "contextMenu",
    "wakeLock",
    "seoMeta",
  ];
function na(t, e, { mode: n = "replace" } = {}) {
  const s = Ft();
  return _({
    get() {
      const r = s.currentRoute.value.query[t];
      return r == null ? e : Array.isArray(r) ? r.filter(Boolean) : r;
    },
    set(r) {
      Vr(() => {
        (s.currentRoute.value.query[t] ?? (e == null ? void 0 : e.toString())) !== r.toString() &&
          s[qr(n)]({ query: { ...s.currentRoute.value.query, [t]: `${r}` === e ? void 0 : r } });
      });
    },
  });
}
function qt(t) {
  return re.value.find((e) => {
    let n;
    return e.no === +t || ((n = e.meta.slide) == null ? void 0 : n.frontmatter.routeAlias) === t;
  });
}
function Je(t, e, n = !1) {
  let r;
  (typeof t == "number" || typeof t == "string") && (t = qt(t));
  const s = ((r = t.meta.slide) == null ? void 0 : r.frontmatter.routeAlias) ?? t.no;
  return n ? `/export/${s}` : e ? `/presenter/${s}` : `/${s}`;
}
const sa = {
  "slide-left": "slide-left | slide-right",
  "slide-right": "slide-right | slide-left",
  "slide-up": "slide-up | slide-down",
  "slide-down": "slide-down | slide-up",
};
function ra(t, e = !1) {
  if (!t || (typeof t == "string" && (t = { name: t }), !t.name)) return;
  let n = t.name.includes("|") ? t.name : sa[t.name] || t.name;
  if (n.includes("|")) {
    const [s, r] = n.split("|").map((o) => o.trim());
    n = e ? r : s;
  }
  if (n) return { ...t, name: n };
}
function oa(t, e, n) {
  let r, o;
  let s =
    t > 0
      ? (r = n == null ? void 0 : n.meta) == null
        ? void 0
        : r.transition
      : (o = e == null ? void 0 : e.meta) == null
        ? void 0
        : o.transition;
  return s || (s = F.transition || void 0), ra(s, t < 0);
}
const sc = E(!1),
  rc = E(!1),
  oc = E(!1),
  ia = E(!1),
  Pn = E(!1),
  ic = E(!1),
  ac = E(!0),
  lc = Jr({ xs: 460, ...Kr }),
  Ct = Gr(),
  cc = Wr(),
  uc = _(() => Ct.height.value - Ct.width.value / Vs.value > 120),
  fc = Br(zt ? document.body : null),
  Xs = Ur(),
  hc = _(() => {
    let t;
    return ["INPUT", "TEXTAREA"].includes(((t = Xs.value) == null ? void 0 : t.tagName) || "");
  }),
  dc = _(() => {
    let t;
    return ["BUTTON", "A"].includes(((t = Xs.value) == null ? void 0 : t.tagName) || "");
  });
J("slidev-camera", "default", { listenToStorageChanges: !1 });
J("slidev-mic", "default", { listenToStorageChanges: !1 });
const aa = J("slidev-scale", 0),
  pc = J("slidev-wake-lock", !0),
  gc = J("slidev-hide-cursor-idle", !0);
J("slidev-skip-export-pdf-tip", !1);
J("slidev-export-capture-delay", 400, { listenToStorageChanges: !1 });
const mc = J("slidev-presenter-cursor", !0, { listenToStorageChanges: !1 }),
  la = J("slidev-show-editor", !1, { listenToStorageChanges: !1 }),
  ca = J("slidev-editor-vertical", !1, { listenToStorageChanges: !1 }),
  ua = J("slidev-editor-width", zt ? window.innerWidth * 0.4 : 318, { listenToStorageChanges: !1 }),
  fa = J("slidev-editor-height", zt ? window.innerHeight * 0.4 : 300, {
    listenToStorageChanges: !1,
  }),
  gt = En(null),
  It = J("slidev-presenter-font-size", 1, { listenToStorageChanges: !1 }),
  mt = J("slidev-presenter-layout", 1, { listenToStorageChanges: !1 }),
  yn = { invert: !1, contrast: 1, brightness: 1, hueRotate: 0, saturate: 1, sepia: 0 },
  ha = J("slidev-viewer-css-filter", yn, {
    listenToStorageChanges: !1,
    mergeDefaults: !0,
    deep: !0,
  }),
  yc = _(() => Object.keys(yn).some((t) => ha.value[t] !== yn[t]));
function vc() {
  (mt.value = mt.value + 1), mt.value > 3 && (mt.value = 1);
}
function wc() {
  It.value = Math.min(2, It.value + 0.1);
}
function kc() {
  It.value = Math.max(0.5, It.value - 0.1);
}
const bc = xs(ia),
  yt = J(
    "slidev-sync-directions",
    { viewerSend: !0, viewerReceive: !0, presenterSend: !0, presenterReceive: !0 },
    { listenToStorageChanges: !1, mergeDefaults: !0 }
  );
function er(t, e, n = 1) {
  let r, o, i, a, l, c, u;
  const s = e.meta.slide.level ?? n;
  s && s > n && t.length > 0
    ? er(t[t.length - 1].children, e, n + 1)
    : t.push({
        no: e.no,
        children: [],
        level: n,
        titleLevel: s,
        path: Je(
          ((o = (r = e.meta.slide) == null ? void 0 : r.frontmatter) == null
            ? void 0
            : o.routeAlias) ?? e.no,
          !1
        ),
        hideInToc: !!(
          (l = (a = (i = e.meta) == null ? void 0 : i.slide) == null ? void 0 : a.frontmatter) !=
            null && l.hideInToc
        ),
        title: (u = (c = e.meta) == null ? void 0 : c.slide) == null ? void 0 : u.title,
      });
}
function tr(t, e, n = !1, s, r) {
  return t.map((o) => {
    const i = { ...o, active: o.no === (r == null ? void 0 : r.value), hasActiveParent: n };
    return (
      i.children.length > 0 &&
        (i.children = tr(i.children, e, i.active || i.hasActiveParent, i, r)),
      s && (i.active || i.activeParent) && (s.activeParent = !0),
      i
    );
  });
}
function nr(t, e = 1) {
  return t.filter((n) => !n.hideInToc).map((n) => ({ ...n, children: nr(n.children, e + 1) }));
}
function da(t, e, n) {
  const s = _(() =>
      t.value
        .filter((o) => {
          let i, a;
          return (a = (i = o.meta) == null ? void 0 : i.slide) == null ? void 0 : a.title;
        })
        .reduce((o, i) => (er(o, i), o), [])
    ),
    r = _(() => tr(s.value, n.value, void 0, void 0, e));
  return _(() => nr(r.value));
}
function pa(t, e, n = E(0), s, r, o) {
  const i = _(() => re.value.length),
    a = E(0),
    l = E(0),
    c = _(() => Je(t.value, s.value)),
    u = _(() => t.value.no),
    h = _(() => {
      let j;
      return (
        ((j = t.value.meta) == null ? void 0 : j.layout) || (u.value === 1 ? "cover" : "default")
      );
    }),
    p = _(() => e.value.current),
    f = _(() => e.value.clicksStart),
    d = _(() => e.value.total),
    g = _(() => re.value[Math.min(re.value.length, u.value + 1) - 1]),
    m = _(() => re.value[Math.max(1, u.value - 1) - 1]),
    v = _(() => u.value < re.value.length || p.value < d.value),
    y = _(() => u.value > 1 || p.value > 0),
    w = _(() => (r.value ? void 0 : oa(a.value, t.value, m.value)));
  ee(t, (j, N) => {
    a.value = j.no - N.no;
  });
  async function b(j) {
    return !1;
  }
  const S = da(re, u, t);
  async function T() {
    (l.value = 1), d.value <= n.value ? await P() : (n.value += 1);
  }
  async function O() {
    (l.value = -1), n.value <= f.value ? await z(!0) : (n.value -= 1);
  }
  async function P(j = !1) {
    (l.value = 1), u.value < re.value.length && (await A(u.value + 1, j && !r.value ? Mt : void 0));
  }
  async function z(j = !1) {
    (l.value = -1), u.value > 1 && (await A(u.value - 1, j && !r.value ? Mt : void 0));
  }
  function ne() {
    return A(1);
  }
  function Z() {
    return A(i.value);
  }
  async function A(j, N = 0, ae = !1) {
    let x, he, tt;
    Pn.value = !1;
    const ce = u.value !== j,
      et = N !== n.value,
      W = (x = qt(j)) == null ? void 0 : x.meta,
      pt = ((he = W == null ? void 0 : W.slide) == null ? void 0 : he.frontmatter.clicksStart) ?? 0;
    (N = hn(
      N,
      pt,
      ((tt = W == null ? void 0 : W.__clicksContext) == null ? void 0 : tt.total) ?? Mt
    )),
      (ae || ce || et) &&
        (await (o == null
          ? void 0
          : o.push({
              path: Je(j, s.value, o.currentRoute.value.name === "export"),
              query: {
                ...o.currentRoute.value.query,
                clicks: N === 0 ? void 0 : N.toString(),
                embedded: location.search.includes("embedded") ? "true" : void 0,
              },
            })));
  }
  function D() {
    o == null || o.push({ path: Je(u.value, !0), query: { ...o.currentRoute.value.query } });
  }
  function q() {
    o == null || o.push({ path: Je(u.value, !1), query: { ...o.currentRoute.value.query } });
  }
  return {
    slides: re,
    total: i,
    currentPath: c,
    currentSlideNo: u,
    currentPage: u,
    currentSlideRoute: t,
    currentLayout: h,
    currentTransition: w,
    clicksDirection: l,
    nextRoute: g,
    prevRoute: m,
    clicksContext: e,
    clicks: p,
    clicksStart: f,
    clicksTotal: d,
    hasNext: v,
    hasPrev: y,
    tocTree: S,
    navDirection: a,
    openInEditor: b,
    next: T,
    prev: O,
    go: A,
    goLast: Z,
    goFirst: ne,
    nextSlide: P,
    prevSlide: z,
    enterPresenter: D,
    exitPresenter: q,
  };
}
const ga = Fs(() => {
    const t = Ft(),
      e = Qr(),
      n = _(() => (t.currentRoute.value.query, new URLSearchParams(location.search))),
      s = _(() => n.value.has("print") || e.name === "export"),
      r = E(n.value.get("print") === "clicks"),
      o = _(() => n.value.has("embedded")),
      i = _(() => e.name === "play"),
      a = _(() => e.name === "presenter"),
      l = _(() => e.name === "notes"),
      c = _(() => !a.value && (!F.remote || n.value.get("password") === F.remote)),
      u = _(() => !!e.params.no),
      h = _(() => {
        let y;
        return u.value ? (((y = qt(e.params.no)) == null ? void 0 : y.no) ?? 1) : 1;
      }),
      p = _(() => re.value[h.value - 1]),
      f = E(Ys(re.value.length, e.query.range)),
      d = na("clicks", "0"),
      g = _(() => v(p.value)),
      m = _({
        get() {
          let y = +(d.value || 0);
          return Number.isNaN(y) && (y = 0), y;
        },
        set(y) {
          (Pn.value = !1), (d.value = y.toString());
        },
      });
    function v(y) {
      let S, T;
      if ((S = y == null ? void 0 : y.meta) != null && S.__clicksContext)
        return y.meta.__clicksContext;
      const w = y.no,
        b = Qs(
          _({
            get() {
              return h.value === w
                ? Math.max(+(d.value ?? 0), b.clicksStart)
                : h.value > w
                  ? Mt
                  : b.clicksStart;
            },
            set(O) {
              h.value === w && (d.value = O.toString());
            },
          }),
          ((T = y == null ? void 0 : y.meta.slide) == null ? void 0 : T.frontmatter.clicksStart) ??
            0,
          y == null ? void 0 : y.meta.clicks
        );
      return y != null && y.meta && (y.meta.__clicksContext = b), b;
    }
    return {
      router: t,
      currentRoute: _(() => e),
      isPrintMode: s,
      isPrintWithClicks: r,
      isEmbedded: o,
      isPlaying: i,
      isPresenter: a,
      isNotesViewer: l,
      isPresenterAvailable: c,
      hasPrimarySlide: u,
      currentSlideNo: h,
      currentSlideRoute: p,
      clicksContext: g,
      queryClicksRaw: d,
      queryClicks: m,
      printRange: f,
      getPrimaryClicks: v,
    };
  }),
  Ze = Fs(() => {
    const t = ga(),
      e = Ft(),
      n = pa(t.currentSlideRoute, t.clicksContext, t.queryClicks, t.isPresenter, t.isPrintMode, e);
    return (
      ee(
        [n.total, t.currentRoute],
        async () => {
          const s = t.currentRoute.value.params.no;
          t.hasPrimarySlide.value &&
            !qt(s) &&
            (s && s !== "index.html" ? await n.go(n.total.value, 0, !0) : await n.go(1, 0, !0));
        },
        { flush: "pre", immediate: !0 }
      ),
      { ...n, ...t }
    );
  }),
  bs = Yr(),
  tn = J("slidev-color-schema", "auto"),
  s = _(() => F.colorSchema !== "auto"),
  sr = _({
    get() {
      return _s.value
        ? F.colorSchema === "dark"
        : tn.value === "auto"
          ? bs.value
          : tn.value === "dark";
    },
    set(t) {
      _s.value || (tn.value = t === bs.value ? "auto" : t ? "dark" : "light");
    },
  }),
  c = xs(sr);
if (zt) {
  const t =
    "*,*::before,*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;-ms-transition:none!important;transition:none!important}";
  ee(
    sr,
    (e) => {
      const n = window.document.createElement("style");
      n.appendChild(document.createTextNode(t)), window.document.head.appendChild(n);
      const s = document.querySelector("html");
      s.classList.toggle("dark", e),
        s.classList.toggle("light", !e),
        window.getComputedStyle(n).opacity,
        document.head.removeChild(n);
    },
    { immediate: !0 }
  );
}
function ma() {
  const { isPrintMode: t } = Ze();
  Zr(
    _(() =>
      t.value
        ? `
@page {
  size: ${qs.value}px ${yo.value}px;
  margin: 0px;
}

* {
  transition: none !important;
  transition-duration: 0s !important;
}`
        : ""
    )
  );
}
const Cn = Symbol.for("yaml.alias"),
  ya = Symbol.for("yaml.document"),
  Fe = Symbol.for("yaml.map"),
  rr = Symbol.for("yaml.pair"),
  In = Symbol.for("yaml.scalar"),
  ht = Symbol.for("yaml.seq"),
  ie = Symbol.for("yaml.node.type"),
  Xe = (t) => !!t && typeof t == "object" && t[ie] === Cn,
  Wt = (t) => !!t && typeof t == "object" && t[ie] === ya,
  or = (t) => !!t && typeof t == "object" && t[ie] === Fe,
  B = (t) => !!t && typeof t == "object" && t[ie] === rr,
  V = (t) => !!t && typeof t == "object" && t[ie] === In,
  Rn = (t) => !!t && typeof t == "object" && t[ie] === ht;
function Y(t) {
  if (t && typeof t == "object")
    switch (t[ie]) {
      case Fe:
      case ht:
        return !0;
    }
  return !1;
}
function U(t) {
  if (t && typeof t == "object")
    switch (t[ie]) {
      case Cn:
      case Fe:
      case In:
      case ht:
        return !0;
    }
  return !1;
}
const ir = (t) => (V(t) || Y(t)) && !!t.anchor,
  Ne = Symbol("break visit"),
  va = Symbol("skip children"),
  lt = Symbol("remove node");
function Bt(t, e) {
  const n = wa(e);
  Wt(t)
    ? Ue(null, t.contents, n, Object.freeze([t])) === lt && (t.contents = null)
    : Ue(null, t, n, Object.freeze([]));
}
Bt.BREAK = Ne;
Bt.SKIP = va;
Bt.REMOVE = lt;
function Ue(t, e, n, s) {
  const r = ka(t, e, n, s);
  if (U(r) || B(r)) return ba(t, s, r), Ue(t, r, n, s);
  if (typeof r != "symbol") {
    if (Y(e)) {
      s = Object.freeze(s.concat(e));
      for (let o = 0; o < e.items.length; ++o) {
        const i = Ue(o, e.items[o], n, s);
        if (typeof i == "number") o = i - 1;
        else {
          if (i === Ne) return Ne;
          i === lt && (e.items.splice(o, 1), (o -= 1));
        }
      }
    } else if (B(e)) {
      s = Object.freeze(s.concat(e));
      const o = Ue("key", e.key, n, s);
      if (o === Ne) return Ne;
      o === lt && (e.key = null);
      const i = Ue("value", e.value, n, s);
      if (i === Ne) return Ne;
      i === lt && (e.value = null);
    }
  }
  return r;
}
function wa(t) {
  return typeof t == "object" && (t.Collection || t.Node || t.Value)
    ? Object.assign(
        { Alias: t.Node, Map: t.Node, Scalar: t.Node, Seq: t.Node },
        t.Value && { Map: t.Value, Scalar: t.Value, Seq: t.Value },
        t.Collection && { Map: t.Collection, Seq: t.Collection },
        t
      )
    : t;
}
function ka(t, e, n, s) {
  let r, o, i, a, l;
  if (typeof n == "function") return n(t, e, s);
  if (or(e)) return (r = n.Map) == null ? void 0 : r.call(n, t, e, s);
  if (Rn(e)) return (o = n.Seq) == null ? void 0 : o.call(n, t, e, s);
  if (B(e)) return (i = n.Pair) == null ? void 0 : i.call(n, t, e, s);
  if (V(e)) return (a = n.Scalar) == null ? void 0 : a.call(n, t, e, s);
  if (Xe(e)) return (l = n.Alias) == null ? void 0 : l.call(n, t, e, s);
}
function ba(t, e, n) {
  const s = e[e.length - 1];
  if (Y(s)) s.items[t] = n;
  else if (B(s)) t === "key" ? (s.key = n) : (s.value = n);
  else if (Wt(s)) s.contents = n;
  else {
    const r = Xe(s) ? "alias" : "scalar";
    throw new Error(`Cannot replace node with ${r} parent`);
  }
}
function ar(t) {
  if (/[\x00-\x19\s,[\]{}]/.test(t)) {
    const n = `Anchor must not contain whitespace or control characters: ${JSON.stringify(t)}`;
    throw new Error(n);
  }
  return !0;
}
function at(t, e, n, s) {
  if (s && typeof s == "object")
    if (Array.isArray(s))
      for (let r = 0, o = s.length; r < o; ++r) {
        const i = s[r],
          a = at(t, s, String(r), i);
        a === void 0 ? delete s[r] : a !== i && (s[r] = a);
      }
    else if (s instanceof Map)
      for (const r of Array.from(s.keys())) {
        const o = s.get(r),
          i = at(t, s, r, o);
        i === void 0 ? s.delete(r) : i !== o && s.set(r, i);
      }
    else if (s instanceof Set)
      for (const r of Array.from(s)) {
        const o = at(t, s, r, r);
        o === void 0 ? s.delete(r) : o !== r && (s.delete(r), s.add(o));
      }
    else
      for (const [r, o] of Object.entries(s)) {
        const i = at(t, s, r, o);
        i === void 0 ? delete s[r] : i !== o && (s[r] = i);
      }
  return t.call(e, n, s);
}
function oe(t, e, n) {
  if (Array.isArray(t)) return t.map((s, r) => oe(s, String(r), n));
  if (t && typeof t.toJSON == "function") {
    if (!n || !ir(t)) return t.toJSON(e, n);
    const s = { aliasCount: 0, count: 1, res: void 0 };
    n.anchors.set(t, s),
      (n.onCreate = (o) => {
        (s.res = o), delete n.onCreate;
      });
    const r = t.toJSON(e, n);
    return n.onCreate && n.onCreate(r), r;
  }
  return typeof t == "bigint" && !(n != null && n.keep) ? Number(t) : t;
}
class Dn {
  constructor(e) {
    Object.defineProperty(this, ie, { value: e });
  }
  clone() {
    const e = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    return this.range && (e.range = this.range.slice()), e;
  }
  toJS(e, { mapAsMap: n, maxAliasCount: s, onAnchor: r, reviver: o } = {}) {
    if (!Wt(e)) throw new TypeError("A document argument is required");
    const i = {
        anchors: new Map(),
        doc: e,
        keep: !0,
        mapAsMap: n === !0,
        mapKeyWarned: !1,
        maxAliasCount: typeof s == "number" ? s : 100,
      },
      a = oe(this, "", i);
    if (typeof r == "function") for (const { count: l, res: c } of i.anchors.values()) r(c, l);
    return typeof o == "function" ? at(o, { "": a }, "", a) : a;
  }
}
class _a extends Dn {
  constructor(e) {
    super(Cn),
      (this.source = e),
      Object.defineProperty(this, "tag", {
        set() {
          throw new Error("Alias nodes cannot have tags");
        },
      });
  }
  resolve(e, n) {
    if ((n == null ? void 0 : n.maxAliasCount) === 0)
      throw new ReferenceError("Alias resolution is disabled");
    let s;
    n != null && n.aliasResolveCache
      ? (s = n.aliasResolveCache)
      : ((s = []),
        Bt(e, {
          Node: (o, i) => {
            (Xe(i) || ir(i)) && s.push(i);
          },
        }),
        n && (n.aliasResolveCache = s));
    let r;
    for (const o of s) {
      if (o === this) break;
      o.anchor === this.source && (r = o);
    }
    return r;
  }
  toJSON(e, n) {
    if (!n) return { source: this.source };
    const { anchors: s, doc: r, maxAliasCount: o } = n,
      i = this.resolve(r, n);
    if (!i) {
      const l = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
      throw new ReferenceError(l);
    }
    let a = s.get(i);
    if ((a || (oe(i, null, n), (a = s.get(i))), (a == null ? void 0 : a.res) === void 0)) {
      const l = "This should not happen: Alias anchor was not resolved?";
      throw new ReferenceError(l);
    }
    if (
      o >= 0 &&
      ((a.count += 1),
      a.aliasCount === 0 && (a.aliasCount = Tt(r, i, s)),
      a.count * a.aliasCount > o)
    ) {
      const l = "Excessive alias count indicates a resource exhaustion attack";
      throw new ReferenceError(l);
    }
    return a.res;
  }
  toString(e, n, s) {
    const r = `*${this.source}`;
    if (e) {
      if ((ar(this.source), e.options.verifyAliasOrder && !e.anchors.has(this.source))) {
        const o = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new Error(o);
      }
      if (e.implicitKey) return `${r} `;
    }
    return r;
  }
}
function Tt(t, e, n) {
  if (Xe(e)) {
    const s = e.resolve(t),
      r = n && s && n.get(s);
    return r ? r.count * r.aliasCount : 0;
  } else if (Y(e)) {
    let s = 0;
    for (const r of e.items) {
      const o = Tt(t, r, n);
      o > s && (s = o);
    }
    return s;
  } else if (B(e)) {
    const s = Tt(t, e.key, n),
      r = Tt(t, e.value, n);
    return Math.max(s, r);
  }
  return 1;
}
const lr = (t) => !t || (typeof t != "function" && typeof t != "object");
class H extends Dn {
  constructor(e) {
    super(In), (this.value = e);
  }
  toJSON(e, n) {
    return n != null && n.keep ? this.value : oe(this.value, e, n);
  }
  toString() {
    return String(this.value);
  }
}
H.BLOCK_FOLDED = "BLOCK_FOLDED";
H.BLOCK_LITERAL = "BLOCK_LITERAL";
H.PLAIN = "PLAIN";
H.QUOTE_DOUBLE = "QUOTE_DOUBLE";
H.QUOTE_SINGLE = "QUOTE_SINGLE";
function Sa(t, e, n) {
  return n.find((s) => {
    let r;
    return ((r = s.identify) == null ? void 0 : r.call(s, t)) && !s.format;
  });
}
function Rt(t, e, n) {
  let h, p, f;
  if ((Wt(t) && (t = t.contents), U(t))) return t;
  if (B(t)) {
    const d = (p = (h = n.schema[Fe]).createNode) == null ? void 0 : p.call(h, n.schema, null, n);
    return d.items.push(t), d;
  }
  (t instanceof String ||
    t instanceof Number ||
    t instanceof Boolean ||
    (typeof BigInt < "u" && t instanceof BigInt)) &&
    (t = t.valueOf());
  const { aliasDuplicateObjects: s, onAnchor: r, onTagObj: o, schema: i, sourceObjects: a } = n;
  let l;
  if (s && t && typeof t == "object") {
    if (((l = a.get(t)), l)) return l.anchor ?? (l.anchor = r(t)), new _a(l.anchor);
    (l = { anchor: null, node: null }), a.set(t, l);
  }
  let c = Sa(t, e, i.tags);
  if (!c) {
    if ((t && typeof t.toJSON == "function" && (t = t.toJSON()), !t || typeof t != "object")) {
      const d = new H(t);
      return l && (l.node = d), d;
    }
    c = t instanceof Map ? i[Fe] : Symbol.iterator in Object(t) ? i[ht] : i[Fe];
  }
  o && (o(c), delete n.onTagObj);
  const u =
    c != null && c.createNode
      ? c.createNode(n.schema, t, n)
      : typeof ((f = c == null ? void 0 : c.nodeClass) == null ? void 0 : f.from) == "function"
        ? c.nodeClass.from(n.schema, t, n)
        : new H(t);
  return c.default || (u.tag = c.tag), l && (l.node = u), u;
}
function Ss(t, e, n) {
  let s = n;
  for (let r = e.length - 1; r >= 0; --r) {
    const o = e[r];
    if (typeof o == "number" && Number.isInteger(o) && o >= 0) {
      const i = [];
      (i[o] = s), (s = i);
    } else s = new Map([[o, s]]);
  }
  return Rt(s, void 0, {
    aliasDuplicateObjects: !1,
    keepUndefined: !1,
    onAnchor: () => {
      throw new Error("This should not happen, please report a bug.");
    },
    schema: t,
    sourceObjects: new Map(),
  });
}
const Ma = (t) => t == null || (typeof t == "object" && !!t[Symbol.iterator]().next().done);
class cr extends Dn {
  constructor(e, n) {
    super(e),
      Object.defineProperty(this, "schema", {
        value: n,
        configurable: !0,
        enumerable: !1,
        writable: !0,
      });
  }
  clone(e) {
    const n = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    return (
      e && (n.schema = e),
      (n.items = n.items.map((s) => (U(s) || B(s) ? s.clone(e) : s))),
      this.range && (n.range = this.range.slice()),
      n
    );
  }
  addIn(e, n) {
    if (Ma(e)) this.add(n);
    else {
      const [s, ...r] = e,
        o = this.get(s, !0);
      if (Y(o)) o.addIn(r, n);
      else if (o === void 0 && this.schema) this.set(s, Ss(this.schema, r, n));
      else throw new Error(`Expected YAML collection at ${s}. Remaining path: ${r}`);
    }
  }
  deleteIn(e) {
    const [n, ...s] = e;
    if (s.length === 0) return this.delete(n);
    const r = this.get(n, !0);
    if (Y(r)) return r.deleteIn(s);
    throw new Error(`Expected YAML collection at ${n}. Remaining path: ${s}`);
  }
  getIn(e, n) {
    const [s, ...r] = e,
      o = this.get(s, !0);
    return r.length === 0 ? (!n && V(o) ? o.value : o) : Y(o) ? o.getIn(r, n) : void 0;
  }
  hasAllNullValues(e) {
    return this.items.every((n) => {
      if (!B(n)) return !1;
      const s = n.value;
      return (
        s == null || (e && V(s) && s.value == null && !s.commentBefore && !s.comment && !s.tag)
      );
    });
  }
  hasIn(e) {
    const [n, ...s] = e;
    if (s.length === 0) return this.has(n);
    const r = this.get(n, !0);
    return Y(r) ? r.hasIn(s) : !1;
  }
  setIn(e, n) {
    const [s, ...r] = e;
    if (r.length === 0) this.set(s, n);
    else {
      const o = this.get(s, !0);
      if (Y(o)) o.setIn(r, n);
      else if (o === void 0 && this.schema) this.set(s, Ss(this.schema, r, n));
      else throw new Error(`Expected YAML collection at ${s}. Remaining path: ${r}`);
    }
  }
}
const Ta = (t) => t.replace(/^(?!$)(?: $)?/gm, "#");
function ft(t, e) {
  return /^\n+$/.test(t) ? t.substring(1) : e ? t.replace(/^(?! *$)/gm, e) : t;
}
const Ke = (t, e, n) =>
    t.endsWith(`
`)
      ? ft(n, e)
      : n.includes(`
`)
        ? `
${ft(n, e)}`
        : (t.endsWith(" ") ? "" : " ") + n,
  ur = "flow",
  vn = "block",
  Ot = "quoted";
function Jt(
  t,
  e,
  n = "flow",
  { indentAtStart: s, lineWidth: r = 80, minContentWidth: o = 20, onFold: i, onOverflow: a } = {}
) {
  if (!r || r < 0) return t;
  r < o && (o = 0);
  const l = Math.max(1 + o, 1 + r - e.length);
  if (t.length <= l) return t;
  const c = [],
    u = {};
  let h = r - e.length;
  typeof s == "number" && (s > r - Math.max(2, o) ? c.push(0) : (h = r - s));
  let p,
    f,
    d = !1,
    g = -1,
    m = -1,
    v = -1;
  n === vn && ((g = Ms(t, g, e.length)), g !== -1 && (h = g + l));
  for (let w; (w = t[(g += 1)]); ) {
    if (n === Ot && w === "\\") {
      switch (((m = g), t[g + 1])) {
        case "x":
          g += 3;
          break;
        case "u":
          g += 5;
          break;
        case "U":
          g += 9;
          break;
        default:
          g += 1;
      }
      v = g;
    }
    if (
      w ===
      `
`
    )
      n === vn && (g = Ms(t, g, e.length)), (h = g + e.length + l), (p = void 0);
    else {
      if (
        w === " " &&
        f &&
        f !== " " &&
        f !==
          `
` &&
        f !== "	"
      ) {
        const b = t[g + 1];
        b &&
          b !== " " &&
          b !==
            `
` &&
          b !== "	" &&
          (p = g);
      }
      if (g >= h)
        if (p) c.push(p), (h = p + l), (p = void 0);
        else if (n === Ot) {
          for (; f === " " || f === "	"; ) (f = w), (w = t[(g += 1)]), (d = !0);
          const b = g > v + 1 ? g - 2 : m - 1;
          if (u[b]) return t;
          c.push(b), (u[b] = !0), (h = b + l), (p = void 0);
        } else d = !0;
    }
    f = w;
  }
  if ((d && a && a(), c.length === 0)) return t;
  i && i();
  let y = t.slice(0, c[0]);
  for (let w = 0; w < c.length; ++w) {
    const b = c[w],
      S = c[w + 1] || t.length;
    b === 0
      ? (y = `
${e}${t.slice(0, S)}`)
      : (n === Ot && u[b] && (y += `${t[b]}\\`),
        (y += `
${e}${t.slice(b + 1, S)}`));
  }
  return y;
}
function Ms(t, e, n) {
  let s = e,
    r = e + 1,
    o = t[r];
  for (; o === " " || o === "	"; )
    if (e < r + n) o = t[++e];
    else {
      do o = t[++e];
      while (
        o &&
        o !==
          `
`
      );
      (s = e), (r = e + 1), (o = t[r]);
    }
  return s;
}
const Ut = (t, e) => ({
    indentAtStart: e ? t.indent.length : t.indentAtStart,
    lineWidth: t.options.lineWidth,
    minContentWidth: t.options.minContentWidth,
  }),
  Kt = (t) => /^(%|---|\.\.\.)/m.test(t);
function Oa(t, e, n) {
  if (!e || e < 0) return !1;
  const s = e - n,
    r = t.length;
  if (r <= s) return !1;
  for (let o = 0, i = 0; o < r; ++o)
    if (
      t[o] ===
      `
`
    ) {
      if (o - i > s) return !0;
      if (((i = o + 1), r - i <= s)) return !1;
    }
  return !0;
}
function ct(t, e) {
  const n = JSON.stringify(t);
  if (e.options.doubleQuotedAsJSON) return n;
  const { implicitKey: s } = e,
    r = e.options.doubleQuotedMinMultiLineLength,
    o = e.indent || (Kt(t) ? "  " : "");
  let i = "",
    a = 0;
  for (let l = 0, c = n[l]; c; c = n[++l])
    if (
      (c === " " &&
        n[l + 1] === "\\" &&
        n[l + 2] === "n" &&
        ((i += `${n.slice(a, l)}\\ `), (l += 1), (a = l), (c = "\\")),
      c === "\\")
    )
      switch (n[l + 1]) {
        case "u":
          {
            i += n.slice(a, l);
            const u = n.substr(l + 2, 4);
            switch (u) {
              case "0000":
                i += "\\0";
                break;
              case "0007":
                i += "\\a";
                break;
              case "000b":
                i += "\\v";
                break;
              case "001b":
                i += "\\e";
                break;
              case "0085":
                i += "\\N";
                break;
              case "00a0":
                i += "\\_";
                break;
              case "2028":
                i += "\\L";
                break;
              case "2029":
                i += "\\P";
                break;
              default:
                u.substr(0, 2) === "00" ? (i += `\\x${u.substr(2)}`) : (i += n.substr(l, 6));
            }
            (l += 5), (a = l + 1);
          }
          break;
        case "n":
          if (s || n[l + 2] === '"' || n.length < r) l += 1;
          else {
            for (
              i += `${n.slice(a, l)}

`;
              n[l + 2] === "\\" && n[l + 3] === "n" && n[l + 4] !== '"';

            )
              (i += `
`),
                (l += 2);
            (i += o), n[l + 2] === " " && (i += "\\"), (l += 1), (a = l + 1);
          }
          break;
        default:
          l += 1;
      }
  return (i = a ? i + n.slice(a) : n), s ? i : Jt(i, o, Ot, Ut(e, !1));
}
function wn(t, e) {
  if (
    e.options.singleQuote === !1 ||
    (e.implicitKey &&
      t.includes(`
`)) ||
    /[ \t]\n|\n[ \t]/.test(t)
  )
    return ct(t, e);
  const n = e.indent || (Kt(t) ? "  " : ""),
    s = `'${t.replace(/'/g, "''").replace(
      /\n+/g,
      `$&
${n}`
    )}'`;
  return e.implicitKey ? s : Jt(s, n, ur, Ut(e, !1));
}
function Ge(t, e) {
  const { singleQuote: n } = e.options;
  let s;
  if (n === !1) s = ct;
  else {
    const r = t.includes('"'),
      o = t.includes("'");
    r && !o ? (s = wn) : o && !r ? (s = ct) : (s = n ? wn : ct);
  }
  return s(t, e);
}
let kn;
try {
  kn = new RegExp(
    `(^|(?<!
))
+(?!
|$)`,
    "g"
  );
} catch {
  kn = /\n+(?!\n|$)/g;
}
function At({ comment: t, type: e, value: n }, s, r, o) {
  const { blockQuote: i, commentString: a, lineWidth: l } = s.options;
  if (!i || /\n[\t ]+$/.test(n)) return Ge(n, s);
  const c = s.indent || (s.forceBlockIndent || Kt(n) ? "  " : ""),
    u =
      i === "literal"
        ? !0
        : i === "folded" || e === H.BLOCK_FOLDED
          ? !1
          : e === H.BLOCK_LITERAL
            ? !0
            : !Oa(n, l, c.length);
  if (!n)
    return u
      ? `|
`
      : `>
`;
  let h, p;
  for (p = n.length; p > 0; --p) {
    const S = n[p - 1];
    if (
      S !==
        `
` &&
      S !== "	" &&
      S !== " "
    )
      break;
  }
  let f = n.substring(p);
  const d = f.indexOf(`
`);
  d === -1 ? (h = "-") : n === f || d !== f.length - 1 ? ((h = "+"), o && o()) : (h = ""),
    f &&
      ((n = n.slice(0, -f.length)),
      f[f.length - 1] ===
        `
` && (f = f.slice(0, -1)),
      (f = f.replace(kn, `$&${c}`)));
  let g = !1,
    m,
    v = -1;
  for (m = 0; m < n.length; ++m) {
    const S = n[m];
    if (S === " ") g = !0;
    else if (
      S ===
      `
`
    )
      v = m;
    else break;
  }
  let y = n.substring(0, v < m ? v + 1 : m);
  y && ((n = n.substring(y.length)), (y = y.replace(/\n+/g, `$&${c}`)));
  let b = (g ? (c ? "2" : "1") : "") + h;
  if ((t && ((b += ` ${a(t.replace(/ ?[\r\n]+/g, " "))}`), r && r()), !u)) {
    const S = n
      .replace(
        /\n+/g,
        `
$&`
      )
      .replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2")
      .replace(/\n+/g, `$&${c}`);
    let T = !1;
    const O = Ut(s, !0);
    i !== "folded" &&
      e !== H.BLOCK_FOLDED &&
      (O.onOverflow = () => {
        T = !0;
      });
    const P = Jt(`${y}${S}${f}`, c, vn, O);
    if (!T)
      return `>${b}
${c}${P}`;
  }
  return (
    (n = n.replace(/\n+/g, `$&${c}`)),
    `|${b}
${c}${y}${n}${f}`
  );
}
function Aa(t, e, n, s) {
  const { type: r, value: o } = t,
    { actualString: i, implicitKey: a, indent: l, indentStep: c, inFlow: u } = e;
  if (
    (a &&
      o.includes(`
`)) ||
    (u && /[[\]{},]/.test(o))
  )
    return Ge(o, e);
  if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(o))
    return a ||
      u ||
      !o.includes(`
`)
      ? Ge(o, e)
      : At(t, e, n, s);
  if (
    !a &&
    !u &&
    r !== H.PLAIN &&
    o.includes(`
`)
  )
    return At(t, e, n, s);
  if (Kt(o)) {
    if (l === "") return (e.forceBlockIndent = !0), At(t, e, n, s);
    if (a && l === c) return Ge(o, e);
  }
  const h = o.replace(
    /\n+/g,
    `$&
${l}`
  );
  if (i) {
    const p = (g) => {
        let m;
        return (
          g.default &&
          g.tag !== "tag:yaml.org,2002:str" &&
          ((m = g.test) == null ? void 0 : m.test(h))
        );
      },
      { compat: f, tags: d } = e.doc.schema;
    if (d.some(p) || (f != null && f.some(p))) return Ge(o, e);
  }
  return a ? h : Jt(h, l, ur, Ut(e, !1));
}
function Ea(t, e, n, s) {
  const { implicitKey: r, inFlow: o } = e,
    i = typeof t.value == "string" ? t : Object.assign({}, t, { value: String(t.value) });
  let { type: a } = t;
  a !== H.QUOTE_DOUBLE &&
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(i.value) &&
    (a = H.QUOTE_DOUBLE);
  const l = (u) => {
    switch (u) {
      case H.BLOCK_FOLDED:
      case H.BLOCK_LITERAL:
        return r || o ? Ge(i.value, e) : At(i, e, n, s);
      case H.QUOTE_DOUBLE:
        return ct(i.value, e);
      case H.QUOTE_SINGLE:
        return wn(i.value, e);
      case H.PLAIN:
        return Aa(i, e, n, s);
      default:
        return null;
    }
  };
  let c = l(a);
  if (c === null) {
    const { defaultKeyType: u, defaultStringType: h } = e.options,
      p = (r && u) || h;
    if (((c = l(p)), c === null)) throw new Error(`Unsupported default string type ${p}`);
  }
  return c;
}
function $a(t, e) {
  const n = Object.assign(
    {
      blockQuote: !0,
      commentString: Ta,
      defaultKeyType: null,
      defaultStringType: "PLAIN",
      directives: null,
      doubleQuotedAsJSON: !1,
      doubleQuotedMinMultiLineLength: 40,
      falseStr: "false",
      flowCollectionPadding: !0,
      indentSeq: !0,
      lineWidth: 80,
      minContentWidth: 20,
      nullStr: "null",
      simpleKeys: !1,
      singleQuote: null,
      trailingComma: !1,
      trueStr: "true",
      verifyAliasOrder: !0,
    },
    t.schema.toStringOptions,
    e
  );
  let s;
  switch (n.collectionStyle) {
    case "block":
      s = !1;
      break;
    case "flow":
      s = !0;
      break;
    default:
      s = null;
  }
  return {
    anchors: new Set(),
    doc: t,
    flowCollectionPadding: n.flowCollectionPadding ? " " : "",
    indent: "",
    indentStep: typeof n.indent == "number" ? " ".repeat(n.indent) : "  ",
    inFlow: s,
    options: n,
  };
}
function La(t, e) {
  let r;
  if (e.tag) {
    const o = t.filter((i) => i.tag === e.tag);
    if (o.length > 0) return o.find((i) => i.format === e.format) ?? o[0];
  }
  let n, s;
  if (V(e)) {
    s = e.value;
    let o = t.filter((i) => {
      let a;
      return (a = i.identify) == null ? void 0 : a.call(i, s);
    });
    if (o.length > 1) {
      const i = o.filter((a) => a.test);
      i.length > 0 && (o = i);
    }
    n = o.find((i) => i.format === e.format) ?? o.find((i) => !i.format);
  } else (s = e), (n = t.find((o) => o.nodeClass && s instanceof o.nodeClass));
  if (!n) {
    const o =
      ((r = s == null ? void 0 : s.constructor) == null ? void 0 : r.name) ??
      (s === null ? "null" : typeof s);
    throw new Error(`Tag not resolved for ${o} value`);
  }
  return n;
}
function Pa(t, e, { anchors: n, doc: s }) {
  if (!s.directives) return "";
  const r = [],
    o = (V(t) || Y(t)) && t.anchor;
  o && ar(o) && (n.add(o), r.push(`&${o}`));
  const i = t.tag ?? (e.default ? null : e.tag);
  return i && r.push(s.directives.tagString(i)), r.join(" ");
}
function Dt(t, e, n, s) {
  let l;
  if (B(t)) return t.toString(e, n, s);
  if (Xe(t)) {
    if (e.doc.directives) return t.toString(e);
    if ((l = e.resolvedAliases) != null && l.has(t))
      throw new TypeError("Cannot stringify circular structure without alias nodes");
    e.resolvedAliases ? e.resolvedAliases.add(t) : (e.resolvedAliases = new Set([t])),
      (t = t.resolve(e.doc));
  }
  let r;
  const o = U(t) ? t : e.doc.createNode(t, { onTagObj: (c) => (r = c) });
  r ?? (r = La(e.doc.schema.tags, o));
  const i = Pa(o, r, e);
  i.length > 0 && (e.indentAtStart = (e.indentAtStart ?? 0) + i.length + 1);
  const a =
    typeof r.stringify == "function"
      ? r.stringify(o, e, n, s)
      : V(o)
        ? Ea(o, e, n, s)
        : o.toString(e, n, s);
  return i
    ? V(o) || a[0] === "{" || a[0] === "["
      ? `${i} ${a}`
      : `${i}
${e.indent}${a}`
    : a;
}
function Ca({ key: t, value: e }, n, s, r) {
  const {
    allNullValues: o,
    doc: i,
    indent: a,
    indentStep: l,
    options: { commentString: c, indentSeq: u, simpleKeys: h },
  } = n;
  let p = (U(t) && t.comment) || null;
  if (h) {
    if (p) throw new Error("With simple keys, key nodes cannot have comments");
    if (Y(t) || (!U(t) && typeof t == "object")) {
      const O = "With simple keys, collection cannot be used as a key value";
      throw new Error(O);
    }
  }
  let f =
    !h &&
    (!t ||
      (p && e == null && !n.inFlow) ||
      Y(t) ||
      (V(t) ? t.type === H.BLOCK_FOLDED || t.type === H.BLOCK_LITERAL : typeof t == "object"));
  n = Object.assign({}, n, { allNullValues: !1, implicitKey: !f && (h || !o), indent: a + l });
  let d = !1,
    g = !1,
    m = Dt(
      t,
      n,
      () => (d = !0),
      () => (g = !0)
    );
  if (!f && !n.inFlow && m.length > 1024) {
    if (h)
      throw new Error(
        "With simple keys, single line scalar must not span more than 1024 characters"
      );
    f = !0;
  }
  if (n.inFlow) {
    if (o || e == null) return d && s && s(), m === "" ? "?" : f ? `? ${m}` : m;
  } else if ((o && !h) || (e == null && f))
    return (m = `? ${m}`), p && !d ? (m += Ke(m, n.indent, c(p))) : g && r && r(), m;
  d && (p = null),
    f
      ? (p && (m += Ke(m, n.indent, c(p))),
        (m = `? ${m}
${a}:`))
      : ((m = `${m}:`), p && (m += Ke(m, n.indent, c(p))));
  let v, y, w;
  U(e)
    ? ((v = !!e.spaceBefore), (y = e.commentBefore), (w = e.comment))
    : ((v = !1), (y = null), (w = null), e && typeof e == "object" && (e = i.createNode(e))),
    (n.implicitKey = !1),
    !f && !p && V(e) && (n.indentAtStart = m.length + 1),
    (g = !1),
    !u &&
      l.length >= 2 &&
      !n.inFlow &&
      !f &&
      Rn(e) &&
      !e.flow &&
      !e.tag &&
      !e.anchor &&
      (n.indent = n.indent.substring(2));
  let b = !1;
  const S = Dt(
    e,
    n,
    () => (b = !0),
    () => (g = !0)
  );
  let T = " ";
  if (p || v || y) {
    if (
      ((T = v
        ? `
`
        : ""),
      y)
    ) {
      const O = c(y);
      T += `
${ft(O, n.indent)}`;
    }
    S === "" && !n.inFlow
      ? T ===
          `
` &&
        w &&
        (T = `

`)
      : (T += `
${n.indent}`);
  } else if (!f && Y(e)) {
    const O = S[0],
      P = S.indexOf(`
`),
      z = P !== -1,
      ne = n.inFlow ?? e.flow ?? e.items.length === 0;
    if (z || !ne) {
      let Z = !1;
      if (z && (O === "&" || O === "!")) {
        let A = S.indexOf(" ");
        O === "&" && A !== -1 && A < P && S[A + 1] === "!" && (A = S.indexOf(" ", A + 1)),
          (A === -1 || P < A) && (Z = !0);
      }
      Z ||
        (T = `
${n.indent}`);
    }
  } else
    (S === "" ||
      S[0] ===
        `
`) &&
      (T = "");
  return (
    (m += T + S),
    n.inFlow ? b && s && s() : w && !b ? (m += Ke(m, n.indent, c(w))) : g && r && r(),
    m
  );
}
function Ia(t, e) {
  (t === "debug" || t === "warn") && console.warn(e);
}
const vt = "<<",
  nn = {
    identify: (t) => t === vt || (typeof t == "symbol" && t.description === vt),
    default: "key",
    tag: "tag:yaml.org,2002:merge",
    test: /^<<$/,
    resolve: () => Object.assign(new H(Symbol(vt)), { addToJSMap: fr }),
    stringify: () => vt,
  },
  Ra = (t, e) =>
    (nn.identify(e) || (V(e) && (!e.type || e.type === H.PLAIN) && nn.identify(e.value))) &&
    (t == null ? void 0 : t.doc.schema.tags.some((n) => n.tag === nn.tag && n.default));
function fr(t, e, n) {
  const s = hr(t, n);
  if (Rn(s)) for (const r of s.items) sn(t, e, r);
  else if (Array.isArray(s)) for (const r of s) sn(t, e, r);
  else sn(t, e, s);
}
function sn(t, e, n) {
  const s = hr(t, n);
  if (!or(s)) throw new Error("Merge sources must be maps or map aliases");
  const r = s.toJSON(null, t, Map);
  for (const [o, i] of r)
    e instanceof Map
      ? e.has(o) || e.set(o, i)
      : e instanceof Set
        ? e.add(o)
        : Object.prototype.hasOwnProperty.call(e, o) ||
          Object.defineProperty(e, o, { value: i, writable: !0, enumerable: !0, configurable: !0 });
  return e;
}
function hr(t, e) {
  return t && Xe(e) ? e.resolve(t.doc, t) : e;
}
function dr(t, e, { key: n, value: s }) {
  if (U(n) && n.addToJSMap) n.addToJSMap(t, e, s);
  else if (Ra(t, n)) fr(t, e, s);
  else {
    const r = oe(n, "", t);
    if (e instanceof Map) e.set(r, oe(s, r, t));
    else if (e instanceof Set) e.add(r);
    else {
      const o = Da(n, r, t),
        i = oe(s, o, t);
      o in e
        ? Object.defineProperty(e, o, { value: i, writable: !0, enumerable: !0, configurable: !0 })
        : (e[o] = i);
    }
  }
  return e;
}
function Da(t, e, n) {
  if (e === null) return "";
  if (typeof e != "object") return String(e);
  if (U(t) && n != null && n.doc) {
    const s = $a(n.doc, {});
    s.anchors = new Set();
    for (const o of n.anchors.keys()) s.anchors.add(o.anchor);
    (s.inFlow = !0), (s.inStringifyKey = !0);
    const r = t.toString(s);
    if (!n.mapKeyWarned) {
      let o = JSON.stringify(r);
      o.length > 40 && (o = `${o.substring(0, 36)}..."`),
        Ia(
          n.doc.options.logLevel,
          `Keys with collection values will be stringified due to JS Object restrictions: ${o}. Set mapAsMap: true to use object keys.`
        ),
        (n.mapKeyWarned = !0);
    }
    return r;
  }
  return JSON.stringify(e);
}
function jn(t, e, n) {
  const s = Rt(t, void 0, n),
    r = Rt(e, void 0, n);
  return new le(s, r);
}
class le {
  constructor(e, n = null) {
    Object.defineProperty(this, ie, { value: rr }), (this.key = e), (this.value = n);
  }
  clone(e) {
    let { key: n, value: s } = this;
    return U(n) && (n = n.clone(e)), U(s) && (s = s.clone(e)), new le(n, s);
  }
  toJSON(e, n) {
    const s = n != null && n.mapAsMap ? new Map() : {};
    return dr(n, s, this);
  }
  toString(e, n, s) {
    return e != null && e.doc ? Ca(this, e, n, s) : JSON.stringify(this);
  }
}
function pr(t, e, n) {
  return ((e.inFlow ?? t.flow) ? Na : ja)(t, e, n);
}
function ja(
  { comment: t, items: e },
  n,
  { blockItemPrefix: s, flowChars: r, itemIndent: o, onChompKeep: i, onComment: a }
) {
  const {
      indent: l,
      options: { commentString: c },
    } = n,
    u = Object.assign({}, n, { indent: o, type: null });
  let h = !1;
  const p = [];
  for (let d = 0; d < e.length; ++d) {
    const g = e[d];
    let m = null;
    if (U(g))
      !h && g.spaceBefore && p.push(""), jt(n, p, g.commentBefore, h), g.comment && (m = g.comment);
    else if (B(g)) {
      const y = U(g.key) ? g.key : null;
      y && (!h && y.spaceBefore && p.push(""), jt(n, p, y.commentBefore, h));
    }
    h = !1;
    let v = Dt(
      g,
      u,
      () => (m = null),
      () => (h = !0)
    );
    m && (v += Ke(v, o, c(m))), h && m && (h = !1), p.push(s + v);
  }
  let f;
  if (p.length === 0) f = r.start + r.end;
  else {
    f = p[0];
    for (let d = 1; d < p.length; ++d) {
      const g = p[d];
      f += g
        ? `
${l}${g}`
        : `
`;
    }
  }
  return (
    t
      ? ((f += `
${ft(c(t), l)}`),
        a && a())
      : h && i && i(),
    f
  );
}
function Na({ items: t }, e, { flowChars: n, itemIndent: s }) {
  const {
    indent: r,
    indentStep: o,
    flowCollectionPadding: i,
    options: { commentString: a },
  } = e;
  s += o;
  const l = Object.assign({}, e, { indent: s, inFlow: !0, type: null });
  let c = !1,
    u = 0;
  const h = [];
  for (let d = 0; d < t.length; ++d) {
    const g = t[d];
    let m = null;
    if (U(g))
      g.spaceBefore && h.push(""), jt(e, h, g.commentBefore, !1), g.comment && (m = g.comment);
    else if (B(g)) {
      const y = U(g.key) ? g.key : null;
      y && (y.spaceBefore && h.push(""), jt(e, h, y.commentBefore, !1), y.comment && (c = !0));
      const w = U(g.value) ? g.value : null;
      w
        ? (w.comment && (m = w.comment), w.commentBefore && (c = !0))
        : g.value == null && y != null && y.comment && (m = y.comment);
    }
    m && (c = !0);
    let v = Dt(g, l, () => (m = null));
    c ||
      (c =
        h.length > u ||
        v.includes(`
`)),
      d < t.length - 1
        ? (v += ",")
        : e.options.trailingComma &&
          (e.options.lineWidth > 0 &&
            (c ||
              (c = h.reduce((y, w) => y + w.length + 2, 2) + (v.length + 2) > e.options.lineWidth)),
          c && (v += ",")),
      m && (v += Ke(v, s, a(m))),
      h.push(v),
      (u = h.length);
  }
  const { start: p, end: f } = n;
  if (h.length === 0) return p + f;
  if (!c) {
    const d = h.reduce((g, m) => g + m.length + 2, 2);
    c = e.options.lineWidth > 0 && d > e.options.lineWidth;
  }
  if (c) {
    let d = p;
    for (const g of h)
      d += g
        ? `
${o}${r}${g}`
        : `
`;
    return `${d}
${r}${f}`;
  } else return `${p}${i}${h.join(" ")}${i}${f}`;
}
function jt({ indent: t, options: { commentString: e } }, n, s, r) {
  if ((s && r && (s = s.replace(/^\n+/, "")), s)) {
    const o = ft(e(s), t);
    n.push(o.trimStart());
  }
}
function xe(t, e) {
  const n = V(e) ? e.value : e;
  for (const s of t)
    if (B(s) && (s.key === e || s.key === n || (V(s.key) && s.key.value === n))) return s;
}
class We extends cr {
  static get tagName() {
    return "tag:yaml.org,2002:map";
  }
  constructor(e) {
    super(Fe, e), (this.items = []);
  }
  static from(e, n, s) {
    const { keepUndefined: r, replacer: o } = s,
      i = new this(e),
      a = (l, c) => {
        if (typeof o == "function") c = o.call(n, l, c);
        else if (Array.isArray(o) && !o.includes(l)) return;
        (c !== void 0 || r) && i.items.push(jn(l, c, s));
      };
    if (n instanceof Map) for (const [l, c] of n) a(l, c);
    else if (n && typeof n == "object") for (const l of Object.keys(n)) a(l, n[l]);
    return typeof e.sortMapEntries == "function" && i.items.sort(e.sortMapEntries), i;
  }
  add(e, n) {
    let i;
    let s;
    B(e)
      ? (s = e)
      : !e || typeof e != "object" || !("key" in e)
        ? (s = new le(e, e == null ? void 0 : e.value))
        : (s = new le(e.key, e.value));
    const r = xe(this.items, s.key),
      o = (i = this.schema) == null ? void 0 : i.sortMapEntries;
    if (r) {
      if (!n) throw new Error(`Key ${s.key} already set`);
      V(r.value) && lr(s.value) ? (r.value.value = s.value) : (r.value = s.value);
    } else if (o) {
      const a = this.items.findIndex((l) => o(s, l) < 0);
      a === -1 ? this.items.push(s) : this.items.splice(a, 0, s);
    } else this.items.push(s);
  }
  delete(e) {
    const n = xe(this.items, e);
    return n ? this.items.splice(this.items.indexOf(n), 1).length > 0 : !1;
  }
  get(e, n) {
    const s = xe(this.items, e),
      r = s == null ? void 0 : s.value;
    return (!n && V(r) ? r.value : r) ?? void 0;
  }
  has(e) {
    return !!xe(this.items, e);
  }
  set(e, n) {
    this.add(new le(e, n), !0);
  }
  toJSON(e, n, s) {
    const r = s ? new s() : n != null && n.mapAsMap ? new Map() : {};
    n != null && n.onCreate && n.onCreate(r);
    for (const o of this.items) dr(n, r, o);
    return r;
  }
  toString(e, n, s) {
    if (!e) return JSON.stringify(this);
    for (const r of this.items)
      if (!B(r)) throw new Error(`Map items must all be pairs; found ${JSON.stringify(r)} instead`);
    return (
      !e.allNullValues &&
        this.hasAllNullValues(!1) &&
        (e = Object.assign({}, e, { allNullValues: !0 })),
      pr(this, e, {
        blockItemPrefix: "",
        flowChars: { start: "{", end: "}" },
        itemIndent: e.indent || "",
        onChompKeep: s,
        onComment: n,
      })
    );
  }
}
class gr extends cr {
  static get tagName() {
    return "tag:yaml.org,2002:seq";
  }
  constructor(e) {
    super(ht, e), (this.items = []);
  }
  add(e) {
    this.items.push(e);
  }
  delete(e) {
    const n = wt(e);
    return typeof n != "number" ? !1 : this.items.splice(n, 1).length > 0;
  }
  get(e, n) {
    const s = wt(e);
    if (typeof s != "number") return;
    const r = this.items[s];
    return !n && V(r) ? r.value : r;
  }
  has(e) {
    const n = wt(e);
    return typeof n == "number" && n < this.items.length;
  }
  set(e, n) {
    const s = wt(e);
    if (typeof s != "number") throw new Error(`Expected a valid index, not ${e}.`);
    const r = this.items[s];
    V(r) && lr(n) ? (r.value = n) : (this.items[s] = n);
  }
  toJSON(e, n) {
    const s = [];
    n != null && n.onCreate && n.onCreate(s);
    let r = 0;
    for (const o of this.items) s.push(oe(o, String(r++), n));
    return s;
  }
  toString(e, n, s) {
    return e
      ? pr(this, e, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: `${e.indent || ""}  `,
          onChompKeep: s,
          onComment: n,
        })
      : JSON.stringify(this);
  }
  static from(e, n, s) {
    const { replacer: r } = s,
      o = new this(e);
    if (n && Symbol.iterator in Object(n)) {
      let i = 0;
      for (let a of n) {
        if (typeof r == "function") {
          const l = n instanceof Set ? a : String(i++);
          a = r.call(n, l, a);
        }
        o.items.push(Rt(a, void 0, s));
      }
    }
    return o;
  }
}
function wt(t) {
  let e = V(t) ? t.value : t;
  return (
    e && typeof e == "string" && (e = Number(e)),
    typeof e == "number" && Number.isInteger(e) && e >= 0 ? e : null
  );
}
function Ha(t, e, n) {
  const { replacer: s } = n,
    r = new gr(t);
  r.tag = "tag:yaml.org,2002:pairs";
  let o = 0;
  if (e && Symbol.iterator in Object(e))
    for (let i of e) {
      typeof s == "function" && (i = s.call(e, String(o++), i));
      let a, l;
      if (Array.isArray(i))
        if (i.length === 2) (a = i[0]), (l = i[1]);
        else throw new TypeError(`Expected [key, value] tuple: ${i}`);
      else if (i && i instanceof Object) {
        const c = Object.keys(i);
        if (c.length === 1) (a = c[0]), (l = i[a]);
        else throw new TypeError(`Expected tuple with one key, not ${c.length} keys`);
      } else a = i;
      r.items.push(jn(a, l, n));
    }
  return r;
}
class Nn extends gr {
  constructor() {
    super(),
      (this.add = We.prototype.add.bind(this)),
      (this.delete = We.prototype.delete.bind(this)),
      (this.get = We.prototype.get.bind(this)),
      (this.has = We.prototype.has.bind(this)),
      (this.set = We.prototype.set.bind(this)),
      (this.tag = Nn.tag);
  }
  toJSON(e, n) {
    if (!n) return super.toJSON(e);
    const s = new Map();
    n != null && n.onCreate && n.onCreate(s);
    for (const r of this.items) {
      let o, i;
      if ((B(r) ? ((o = oe(r.key, "", n)), (i = oe(r.value, o, n))) : (o = oe(r, "", n)), s.has(o)))
        throw new Error("Ordered maps must not include duplicate keys");
      s.set(o, i);
    }
    return s;
  }
  static from(e, n, s) {
    const r = Ha(e, n, s),
      o = new this();
    return (o.items = r.items), o;
  }
}
Nn.tag = "tag:yaml.org,2002:omap";
class Hn extends We {
  constructor(e) {
    super(e), (this.tag = Hn.tag);
  }
  add(e) {
    let n;
    B(e)
      ? (n = e)
      : e && typeof e == "object" && "key" in e && "value" in e && e.value === null
        ? (n = new le(e.key, null))
        : (n = new le(e, null)),
      xe(this.items, n.key) || this.items.push(n);
  }
  get(e, n) {
    const s = xe(this.items, e);
    return !n && B(s) ? (V(s.key) ? s.key.value : s.key) : s;
  }
  set(e, n) {
    if (typeof n != "boolean")
      throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof n}`);
    const s = xe(this.items, e);
    s && !n ? this.items.splice(this.items.indexOf(s), 1) : !s && n && this.items.push(new le(e));
  }
  toJSON(e, n) {
    return super.toJSON(e, n, Set);
  }
  toString(e, n, s) {
    if (!e) return JSON.stringify(this);
    if (this.hasAllNullValues(!0))
      return super.toString(Object.assign({}, e, { allNullValues: !0 }), n, s);
    throw new Error("Set items must all have null values");
  }
  static from(e, n, s) {
    const { replacer: r } = s,
      o = new this(e);
    if (n && Symbol.iterator in Object(n))
      for (let i of n)
        typeof r == "function" && (i = r.call(n, i, i)), o.items.push(jn(i, null, s));
    return o;
  }
}
Hn.tag = "tag:yaml.org,2002:set";
new Set("0123456789ABCDEFabcdef");
new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
new Set(",[]{}");
new Set(` ,[]{}
\r	`);
function xn(t = 5) {
  const e = [],
    n = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    s = n.length;
  for (let r = 0; r < t; r++) e.push(n.charAt(Math.floor(Math.random() * s)));
  return e.join("");
}
function Sc(t, e, n, s) {
  const r = Ys(e + n - 1, t);
  for (let o = 0; o < e; o++) {
    const i = s(o),
      a = r.includes(o + n);
    for (const l of i)
      l.classList.toggle("slidev-code-highlighted", a),
        l.classList.toggle("slidev-code-dishonored", !a),
        l.classList.toggle("highlighted", a),
        l.classList.toggle("dishonored", !a);
  }
}
function mr() {
  return Math.random()
    .toString(36)
    .replace(/[^a-z]+/g, "")
    .substr(2, 10);
}
function te(t, e, n) {
  Object.defineProperty(t, e, { value: n, writable: !0, enumerable: !1 });
}
const ue = L({});
const xa = [],
  Fa = [];
te(ue, "$syncUp", !0);
te(ue, "$syncDown", !0);
te(ue, "$paused", !1);
te(ue, "$onSet", (t) => xa.push(t));
te(ue, "$onPatch", (t) => Fa.push(t));
mr();
te(ue, "$patch", async () => !1);
const za = {
    channels: [],
    enabled: !0,
    init(t, e, n, s = !1) {
      let r;
      if (!s)
        (r = new BroadcastChannel(t)),
          r.addEventListener("message", (o) => e(o.data)),
          this.channels.push(r);
      else if (s) {
        (this.listener = function (i) {
          i && i.key === t && i.newValue && e(JSON.parse(i.newValue));
        }),
          window.addEventListener("storage", this.listener);
        const o = window.localStorage.getItem(t);
        o && e(JSON.parse(o));
      }
      return (o, i = !1) => {
        this.enabled &&
          (!s && r && !i && r.postMessage(zs(o)),
          s && !i && window.localStorage.setItem(t, JSON.stringify(o)));
      };
    },
    disable() {
      (this.enabled = !1),
        this.channels.forEach((t) => t.close()),
        this.listener && window.removeEventListener("storage", this.listener);
    },
  },
  Va = L([za]),
  qa = new Map(),
  Ts = E({});
function yr(t, e, n = !1) {
  const s = [];
  let r = !1,
    o = !1,
    i,
    a;
  const l = L(e);
  function c(f) {
    s.push(f);
  }
  function u(f, d) {
    l[f] !== d && (clearTimeout(i), (r = !0), (l[f] = d), (i = setTimeout(() => (r = !1), 0)));
  }
  function h(f) {
    r ||
      (clearTimeout(a),
      (o = !0),
      Object.entries(f).forEach(([d, g]) => {
        l[d] = g;
      }),
      (a = setTimeout(() => (o = !1), 0)));
  }
  function p(f) {
    qa.set(f, { onUpdate: h, persist: n, state: l }),
      (Ts.value[f] = Va.map((g) => g.init(f, h, l, n)).filter((g) => !!g));
    function d() {
      Ts.value[f].forEach((g) => (g == null ? void 0 : g(zs(l), o))), r || s.forEach((g) => g(l));
    }
    ee(l, d, { deep: !0 });
  }
  return { init: p, onPatch: c, onUpdate: h, patch: u, state: l };
}
const { init: Wa, onPatch: Mc, patch: Tc, state: Oc } = yr(ue, ue, !1),
  ze = L({ page: 0, clicks: 0 });
const Ba = [],
  Ja = [];
te(ze, "$syncUp", !0);
te(ze, "$syncDown", !0);
te(ze, "$paused", !1);
te(ze, "$onSet", (t) => Ba.push(t));
te(ze, "$onPatch", (t) => Ja.push(t));
mr();
te(ze, "$patch", async () => !1);
const {
  init: Ua,
  onPatch: Ka,
  patch: kt,
  state: Ac,
} = yr(ze, { page: 1, clicks: 0, clicksTotal: 0 });
function Ga() {
  const t = js().appContext.app,
    e = L({ nav: Ze(), configs: F, themeConfigs: _(() => F.themeConfig) });
  t.provide(Ln, E("none")),
    t.provide(Yi, e),
    t.provide(
      $n,
      _(() => e.nav.currentSlideNo)
    ),
    t.provide(Vt, En(Jo()));
  for (const p of wo) p();
  const {
    clicksContext: n,
    currentSlideNo: s,
    hasPrimarySlide: r,
    isNotesViewer: o,
    isPresenter: i,
    isPrintMode: a,
  } = Ze();
  qo({ title: Qt, htmlAttrs: F.htmlAttrs }), ma(), Ua(`${Qt} - shared`), Wa(`${Qt} - drawings`);
  const l = `${location.origin}_${xn()}`,
    c = _(() => (i.value ? "presenter" : "viewer"));
  function u() {
    (i.value ? yt.value.presenterSend : yt.value.viewerSend) &&
      (o.value ||
        a.value ||
        (!i.value && !ea.includes(location.host.split(":")[0])) ||
        (kt("page", +s.value),
        kt("clicks", n.value.current),
        kt("clicksTotal", n.value.total),
        kt("lastUpdate", { id: l, type: c.value, time: new Date().getTime() })));
  }
  const h = Ft();
  h.afterEach(u),
    ee(n, u),
    Ka((p) => {
      let d;
      (i.value ? yt.value.presenterReceive : yt.value.viewerReceive) &&
        (!r.value ||
          a.value ||
          (((d = p.lastUpdate) == null ? void 0 : d.type) !== c.value &&
            ((+p.page == +s.value && +n.value.current == +p.clicks) ||
              ((Pn.value = !1),
              h.replace({
                path: Je(p.page, i.value),
                query: { ...h.currentRoute.value.query, clicks: p.clicks || 0 },
              })))));
    });
}
const Qa = Hs({
    __name: "App",
    setup(t) {
      return (
        Ga(),
        Qe(() => {
          for (const [e, n] of Object.entries(vo.value))
            document.body.style.setProperty(e, n.toString());
        }),
        (e, n) => {
          const s = eo("RouterView");
          return Lt(), Xr(s);
        }
      );
    },
  }),
  Ya = [];
async function vr(t, e = {}) {
  const n = e.document || t.resolvedOptions.document;
  if (!n || !t.dirty) return;
  const s = { shouldRender: !0, tags: [] };
  if ((await t.hooks.callHook("dom:beforeRender", s), !!s.shouldRender))
    return (
      t._domUpdatePromise ||
        (t._domUpdatePromise = new Promise(async (r) => {
          let f;
          const o = new Map(),
            i = new Promise((d) => {
              t.resolveTags().then((g) => {
                d(
                  g.map((m) => {
                    const v = o.get(m._d) || 0,
                      y = { tag: m, id: (v ? `${m._d}:${v}` : m._d) || m._h, shouldRender: !0 };
                    return m._d && Js(m._d) && o.set(m._d, v + 1), y;
                  })
                );
              });
            });
          let a = t._dom;
          if (!a) {
            a = {
              title: n.title,
              elMap: new Map().set("htmlAttrs", n.documentElement).set("bodyAttrs", n.body),
            };
            for (const d of ["body", "head"]) {
              const g = (f = n[d]) == null ? void 0 : f.children;
              for (const m of g) {
                const v = m.tagName.toLowerCase();
                if (!dn.has(v)) continue;
                const y = Ks(
                  { tag: v, props: {} },
                  {
                    innerHTML: m.innerHTML,
                    ...(m
                      .getAttributeNames()
                      .reduce((w, b) => ((w[b] = m.getAttribute(b)), w), {}) || {}),
                  }
                );
                if (
                  ((y.key = m.getAttribute("data-hid") || void 0),
                  (y._d = gn(y) || Us(y)),
                  a.elMap.has(y._d))
                ) {
                  let w = 1,
                    b = y._d;
                  for (; a.elMap.has(b); ) b = `${y._d}:${w++}`;
                  a.elMap.set(b, m);
                } else a.elMap.set(y._d, m);
              }
            }
          }
          (a.pendingSideEffects = { ...a.sideEffects }), (a.sideEffects = {});
          function l(d, g, m) {
            const v = `${d}:${g}`;
            (a.sideEffects[v] = m), delete a.pendingSideEffects[v];
          }
          function c({ id: d, $el: g, tag: m }) {
            const v = m.tag.endsWith("Attrs");
            a.elMap.set(d, g),
              v ||
                (m.textContent &&
                  m.textContent !== g.textContent &&
                  (g.textContent = m.textContent),
                m.innerHTML && m.innerHTML !== g.innerHTML && (g.innerHTML = m.innerHTML),
                l(d, "el", () => {
                  g == null || g.remove(), a.elMap.delete(d);
                }));
            for (const y in m.props) {
              if (!Object.prototype.hasOwnProperty.call(m.props, y)) continue;
              const w = m.props[y];
              if (y.startsWith("on") && typeof w == "function") {
                const S = g == null ? void 0 : g.dataset;
                if (S && S[`${y}fired`]) {
                  const T = y.slice(0, -5);
                  w.call(g, new Event(T.substring(2)));
                }
                g.getAttribute(`data-${y}`) !== "" &&
                  ((m.tag === "bodyAttrs" ? n.defaultView : g).addEventListener(
                    y.substring(2),
                    w.bind(g)
                  ),
                  g.setAttribute(`data-${y}`, ""));
                continue;
              }
              const b = `attr:${y}`;
              if (y === "class") {
                if (!w) continue;
                for (const S of w)
                  v && l(d, `${b}:${S}`, () => g.classList.remove(S)),
                    !g.classList.contains(S) && g.classList.add(S);
              } else if (y === "style") {
                if (!w) continue;
                for (const [S, T] of w)
                  l(d, `${b}:${S}`, () => {
                    g.style.removeProperty(S);
                  }),
                    g.style.setProperty(S, T);
              } else
                w !== !1 &&
                  w !== null &&
                  (g.getAttribute(y) !== w && g.setAttribute(y, w === !0 ? "" : String(w)),
                  v && l(d, b, () => g.removeAttribute(y)));
            }
          }
          const u = [],
            h = { bodyClose: void 0, bodyOpen: void 0, head: void 0 },
            p = await i;
          for (const d of p) {
            const { tag: g, shouldRender: m, id: v } = d;
            if (m) {
              if (g.tag === "title") {
                (n.title = g.textContent), l("title", "", () => (n.title = a.title));
                continue;
              }
              (d.$el = d.$el || a.elMap.get(v)), d.$el ? c(d) : dn.has(g.tag) && u.push(d);
            }
          }
          for (const d of u) {
            const g = d.tag.tagPosition || "head";
            (d.$el = n.createElement(d.tag.tag)),
              c(d),
              (h[g] = h[g] || n.createDocumentFragment()),
              h[g].appendChild(d.$el);
          }
          for (const d of p) await t.hooks.callHook("dom:renderTag", d, n, l);
          h.head && n.head.appendChild(h.head),
            h.bodyOpen && n.body.insertBefore(h.bodyOpen, n.body.firstChild),
            h.bodyClose && n.body.appendChild(h.bodyClose);
          for (const d in a.pendingSideEffects) a.pendingSideEffects[d]();
          (t._dom = a), await t.hooks.callHook("dom:rendered", { renders: p }), r();
        }).finally(() => {
          (t._domUpdatePromise = void 0), (t.dirty = !1);
        })),
      t._domUpdatePromise
    );
}
function Za(t = {}) {
  let s, r, o;
  const e = ((s = t.domOptions) == null ? void 0 : s.render) || vr;
  t.document = t.document || (typeof window < "u" ? document : void 0);
  const n =
    ((o =
      (r = t.document) == null ? void 0 : r.head.querySelector('script[id="unhead:payload"]')) ==
    null
      ? void 0
      : o.innerHTML) || !1;
  return xo({
    ...t,
    plugins: [...(t.plugins || []), { key: "client", hooks: { "entries:updated": e } }],
    init: [n ? JSON.parse(n) : !1, ...(t.init || [])],
  });
}
function Xa(t, e) {
  let n = 0;
  return () => {
    const s = ++n;
    e(() => {
      n === s && t();
    });
  };
}
function el(t = {}) {
  const e = Za({
    domOptions: {
      render: Xa(
        () => vr(e),
        (n) => setTimeout(n, 0)
      ),
    },
    ...t,
  });
  return (e.install = zo(e)), e;
}
function Ec(t, e = "") {
  let r, o;
  const n = ["slidev-page", e],
    s = (o = (r = t == null ? void 0 : t.meta) == null ? void 0 : r.slide) == null ? void 0 : o.no;
  return s != null && n.push(`slidev-page-${s}`), n.filter(Boolean).join(" ");
}
async function $c() {
  const { saveAs: t } = await $(async () => {
    const { saveAs: e } = await import("./modules/file-saver-DKWcVV7Q.js").then((n) => n.F);
    return { saveAs: e };
  }, []);
  t(
    typeof F.download == "string"
      ? F.download
      : F.exportFilename
        ? `${F.exportFilename}.pdf`
        : "/talks/when-the-agent-is-wrong/slidev-exported.pdf",
    `${F.title}.pdf`
  );
}
function Ye(t, e, n) {
  let s;
  return ((s = t.instance) == null ? void 0 : s.$).provides[e] ?? n;
}
function tl() {
  return {
    install(t) {
      t.directive("click", {
        name: "v-click",
        mounted(e, n) {
          const s = Et(e, n, n.value);
          s != null &&
            (e.classList.toggle(St, !0),
            (e.dataset.slidevClicksStart = String(s.start)),
            Number.isFinite(s.end) && (e.dataset.slidevClicksEnd = String(s.end)),
            (e.watchStopHandle = Qe(() => {
              const r = s.isActive.value,
                o = s.isCurrent.value,
                i = r && !o;
              s.flagHide
                ? (e.classList.toggle(s.flagFade ? rt : st, r), e.classList.toggle(Zt, r))
                : e.classList.toggle(s.flagFade ? rt : st, !r),
                e.classList.toggle(Xt, o),
                e.classList.toggle(en, i);
            })));
        },
        unmounted: rn,
      }),
        t.directive("after", {
          name: "v-after",
          mounted(e, n) {
            const s = Et(e, n, "+0");
            s != null &&
              (e.classList.toggle(St, !0),
              (e.watchStopHandle = Qe(() => {
                const r = s.isActive.value,
                  o = s.isCurrent.value,
                  i = r && !o;
                s.flagHide
                  ? (e.classList.toggle(s.flagFade ? rt : st, r), e.classList.toggle(Zt, r))
                  : e.classList.toggle(s.flagFade ? rt : st, !r),
                  e.classList.toggle(Xt, o),
                  e.classList.toggle(en, i);
              })));
          },
          unmounted: rn,
        }),
        t.directive("click-hide", {
          name: "v-click-hide",
          mounted(e, n) {
            const s = Et(e, n, n.value, !0);
            s != null &&
              (e.classList.toggle(St, !0),
              (e.watchStopHandle = Qe(() => {
                const r = s.isActive.value,
                  o = s.isCurrent.value,
                  i = r && !o;
                e.classList.toggle(s.flagFade ? rt : st, r),
                  e.classList.toggle(Zt, r),
                  e.classList.toggle(Xt, o),
                  e.classList.toggle(en, i);
              })));
          },
          unmounted: rn,
        });
    },
  };
}
const wr = new Map();
function Et(t, e, n, s = !1) {
  let h;
  const r = (h = Ye(e, Vt)) == null ? void 0 : h.value;
  if (!t || !r) return null;
  const o = s || (e.modifiers.hide !== !1 && e.modifiers.hide != null),
    i = e.modifiers.fade !== !1 && e.modifiers.fade != null,
    a = r.calculate(n);
  if (!a) return null;
  r.register(t, a);
  const l = _(() => (o ? !a.isActive.value : a.isActive.value)),
    c = _(() =>
      l.value
        ? "shown"
        : Number.isFinite(a.end)
          ? r.current < a.start
            ? "before"
            : "after"
          : o
            ? "after"
            : "before"
    ),
    u = { ...a, isShown: l, visibilityState: c, flagFade: i, flagHide: o };
  return wr.set(t, u), u;
}
function rn(t, e) {
  let s, r;
  t.classList.toggle(St, !1);
  const n = (s = Ye(e, Vt)) == null ? void 0 : s.value;
  n == null || n.unregister(t), (r = t.watchStopHandle) == null || r.call(t);
}
function nl(t = Ds(Zs, E())) {
  const e = to(t),
    n = ee(
      [la, ca, ua, fa, aa, Ct.width, Ct.height],
      () => {
        setTimeout(e.update, 300);
      },
      { flush: "post", immediate: !0 }
    );
  return { ...e, stop: n };
}
function sl(t) {
  return () => {};
}
function rl(t, e, n, s = !1) {
  let pt;
  function r(x) {
    return t ? Ye(t, x) : so(x);
  }
  const o = r(Ln),
    i = r(Zi) ?? {},
    a = r($n),
    l = _(() => sl(a.value)),
    c = r(Qi) ?? E(1),
    u = r(Xi) ?? E(1),
    { left: h, top: p, stop: f } = nl(r(Zs) ?? E()),
    { isPrintMode: d } = Ze(),
    g = ["slide", "presenter"].includes(o.value) && !d.value;
  let m = t ? "directive" : "prop",
    v = xn(),
    y;
  if (
    (Array.isArray(e)
      ? (y = e)
      : typeof e == "string" && e.includes(",")
        ? (y = e.split(",").map(Number))
        : e != null &&
          ((m = "frontmatter"),
          (v = `${e}`),
          (e = (pt = i == null ? void 0 : i.dragPos) == null ? void 0 : pt[v]),
          (y = e == null ? void 0 : e.split(",").map(Number))),
    m !== "frontmatter" && !n)
  )
    throw new Error(
      "[Slidev] Can not identify the source position of the v-drag element, please provide an explicit `id` prop."
    );
  const w = [f],
    b = !s && e != null && !Number.isFinite(y == null ? void 0 : y[3]);
  y ?? (y = [Number.NaN, Number.NaN, 0]);
  const S = E(y[2]),
    T = E(y[0] + y[2] / 2),
    O = E(s ? 0 : (y[4] ?? 0)),
    P = _(() => (O.value * Math.PI) / 180),
    z = _(() => Math.sin(P.value)),
    ne = _(() => Math.cos(P.value)),
    Z = E(),
    A = E({ left: 0, top: 0, width: 0, height: 0 }),
    D = E(0);
  function q() {
    if (!Z.value) return;
    const x = Z.value.getBoundingClientRect();
    (A.value = {
      left: x.left / u.value,
      top: x.top / u.value,
      width: x.width / u.value,
      height: x.height / u.value,
    }),
      (D.value =
        (A.value.width + A.value.height) / c.value / (Math.abs(z.value) + Math.abs(ne.value)) -
        S.value);
  }
  w.push(ee(S, q, { flush: "post" }));
  const j = E(y[3] ?? 0),
    N = b ? _({ get: () => (b ? D.value : j.value) || 0, set: (x) => !b && (j.value = x) }) : j,
    ae = b ? E(y[1]) : E(y[1] + y[3] / 2),
    ce = b
      ? _({ get: () => ae.value + N.value / 2, set: (x) => (ae.value = x - N.value / 2) })
      : ae,
    et = _(() =>
      Number.isFinite(T.value)
        ? {
            position: "absolute",
            zIndex: 100,
            left: `${T.value - S.value / 2}px`,
            top: `${ce.value - N.value / 2}px`,
            width: `${S.value}px`,
            height: b ? void 0 : `${N.value}px`,
            transformOrigin: "center center",
            transform: `rotate(${O.value}deg)`,
          }
        : { position: "absolute", zIndex: 100 }
    );
  w.push(
    ee([T, ce, S, N, O], ([x, he, tt, Vn, qn]) => {
      let Ve = [x - tt / 2, he - Vn / 2, tt].map(Math.round).join();
      b ? (Ve += m === "directive" ? ",NaN" : ",_") : (Ve += `,${Math.round(Vn)}`),
        Math.round(qn) !== 0 && (Ve += `,${Math.round(qn)}`),
        m === "directive" && (Ve = `[${Ve}]`),
        l.value(v, Ve, m, n);
    })
  );
  const W = {
    dragId: v,
    dataSource: m,
    markdownSource: n,
    isArrow: s,
    zoom: u,
    autoHeight: b,
    x0: T,
    y0: ce,
    width: S,
    height: N,
    rotate: O,
    container: Z,
    containerStyle: et,
    watchStopHandles: w,
    dragging: _(() => gt.value === W),
    mounted() {
      g &&
        (q(),
        e ||
          setTimeout(() => {
            q(),
              (T.value = (A.value.left + A.value.width / 2 - h.value) / c.value),
              (ce.value = (A.value.top - p.value) / c.value),
              (S.value = A.value.width / c.value),
              (N.value = A.value.height / c.value);
          }, 100));
    },
    unmounted() {
      g && W.stopDragging();
    },
    startDragging() {
      g && (q(), (gt.value = W));
    },
    stopDragging() {
      g && gt.value === W && (gt.value = null);
    },
  };
  return (
    w.push(
      no(Z, (x) => {
        const he = document.querySelector("#drag-control-container");
        (he && x.target && he.contains(x.target)) || W.stopDragging();
      }),
      ee(ro(), (x) => {
        x || W.stopDragging();
      })
    ),
    W
  );
}
function ol() {
  return {
    install(t) {
      t.directive("drag", {
        name: "v-drag",
        created(e, n, s) {
          let o;
          const r = rl(n, n.value, (o = s.props) == null ? void 0 : o.markdownSource);
          s.props && ((s.props = { ...s.props }), delete s.props.markdownSource),
            (r.container.value = e),
            (e.draggingState = r),
            (e.dataset.dragId = r.dragId),
            r.watchStopHandles.push(
              ee(
                r.containerStyle,
                (i) => {
                  for (const [a, l] of Object.entries(i)) l && (e.style[a] = l);
                },
                { immediate: !0 }
              )
            ),
            e.addEventListener("dblclick", r.startDragging);
        },
        mounted(e) {
          e.draggingState.mounted();
        },
        unmounted(e) {
          const n = e.draggingState;
          n.unmounted(),
            e.removeEventListener("dblclick", n.startDragging),
            n.watchStopHandles.forEach((s) => s());
        },
      });
    },
  };
}
function kr() {
  return Math.floor(Math.random() * 2 ** 31);
}
class il {
  constructor(e) {
    this.seed = e;
  }
  next() {
    return this.seed
      ? ((2 ** 31 - 1) & (this.seed = Math.imul(48271, this.seed))) / 2 ** 31
      : Math.random();
  }
}
function bn(t, e, n) {
  if (t && t.length) {
    const [s, r] = e,
      o = (Math.PI / 180) * n,
      i = Math.cos(o),
      a = Math.sin(o);
    for (const l of t) {
      const [c, u] = l;
      (l[0] = (c - s) * i - (u - r) * a + s), (l[1] = (c - s) * a + (u - r) * i + r);
    }
  }
}
function al(t, e, n) {
  const s = [];
  t.forEach((r) => s.push(...r)), bn(s, e, n);
}
function ll(t, e) {
  return t[0] === e[0] && t[1] === e[1];
}
function cl(t, e, n, s = 1) {
  const r = n,
    o = Math.max(e, 0.1),
    i = t[0] && t[0][0] && typeof t[0][0] == "number" ? [t] : t,
    a = [0, 0];
  if (r) for (const c of i) bn(c, a, r);
  const l = ul(i, o, s);
  if (r) {
    for (const c of i) bn(c, a, -r);
    al(l, a, -r);
  }
  return l;
}
function ul(t, e, n) {
  const s = [];
  for (const c of t) {
    const u = [...c];
    ll(u[0], u[u.length - 1]) || u.push([u[0][0], u[0][1]]), u.length > 2 && s.push(u);
  }
  const r = [];
  e = Math.max(e, 0.1);
  const o = [];
  for (const c of s)
    for (let u = 0; u < c.length - 1; u++) {
      const h = c[u],
        p = c[u + 1];
      if (h[1] !== p[1]) {
        const f = Math.min(h[1], p[1]);
        o.push({
          ymin: f,
          ymax: Math.max(h[1], p[1]),
          x: f === h[1] ? h[0] : p[0],
          islope: (p[0] - h[0]) / (p[1] - h[1]),
        });
      }
    }
  if (
    (o.sort((c, u) =>
      c.ymin < u.ymin
        ? -1
        : c.ymin > u.ymin
          ? 1
          : c.x < u.x
            ? -1
            : c.x > u.x
              ? 1
              : c.ymax === u.ymax
                ? 0
                : (c.ymax - u.ymax) / Math.abs(c.ymax - u.ymax)
    ),
    !o.length)
  )
    return r;
  let i = [],
    a = o[0].ymin,
    l = 0;
  for (; i.length || o.length; ) {
    if (o.length) {
      let c = -1;
      for (let h = 0; h < o.length && !(o[h].ymin > a); h++) c = h;
      o.splice(0, c + 1).forEach((h) => {
        i.push({ s: a, edge: h });
      });
    }
    if (
      ((i = i.filter((c) => !(c.edge.ymax <= a))),
      i.sort((c, u) =>
        c.edge.x === u.edge.x ? 0 : (c.edge.x - u.edge.x) / Math.abs(c.edge.x - u.edge.x)
      ),
      (n !== 1 || l % e === 0) && i.length > 1)
    )
      for (let c = 0; c < i.length; c = c + 2) {
        const u = c + 1;
        if (u >= i.length) break;
        const h = i[c].edge,
          p = i[u].edge;
        r.push([
          [Math.round(h.x), a],
          [Math.round(p.x), a],
        ]);
      }
    (a += n),
      i.forEach((c) => {
        c.edge.x = c.edge.x + n * c.edge.islope;
      }),
      l++;
  }
  return r;
}
function dt(t, e) {
  let n;
  const s = e.hachureAngle + 90;
  let r = e.hachureGap;
  r < 0 && (r = e.strokeWidth * 4), (r = Math.round(Math.max(r, 0.1)));
  let o = 1;
  return (
    e.roughness >= 1 &&
      (((n = e.randomizer) === null || n === void 0 ? void 0 : n.next()) || Math.random()) > 0.7 &&
      (o = r),
    cl(t, r, s, o || 1)
  );
}
class Fn {
  constructor(e) {
    this.helper = e;
  }
  fillPolygons(e, n) {
    return this._fillPolygons(e, n);
  }
  _fillPolygons(e, n) {
    const s = dt(e, n);
    return { type: "fillSketch", ops: this.renderLines(s, n) };
  }
  renderLines(e, n) {
    const s = [];
    for (const r of e) s.push(...this.helper.doubleLineOps(r[0][0], r[0][1], r[1][0], r[1][1], n));
    return s;
  }
}
function Gt(t) {
  const e = t[0],
    n = t[1];
  return Math.sqrt(Math.pow(e[0] - n[0], 2) + Math.pow(e[1] - n[1], 2));
}
class fl extends Fn {
  fillPolygons(e, n) {
    let s = n.hachureGap;
    s < 0 && (s = n.strokeWidth * 4), (s = Math.max(s, 0.1));
    const r = Object.assign({}, n, { hachureGap: s }),
      o = dt(e, r),
      i = (Math.PI / 180) * n.hachureAngle,
      a = [],
      l = s * 0.5 * Math.cos(i),
      c = s * 0.5 * Math.sin(i);
    for (const [h, p] of o)
      Gt([h, p]) && a.push([[h[0] - l, h[1] + c], [...p]], [[h[0] + l, h[1] - c], [...p]]);
    return { type: "fillSketch", ops: this.renderLines(a, n) };
  }
}
class hl extends Fn {
  fillPolygons(e, n) {
    const s = this._fillPolygons(e, n),
      r = Object.assign({}, n, { hachureAngle: n.hachureAngle + 90 }),
      o = this._fillPolygons(e, r);
    return (s.ops = s.ops.concat(o.ops)), s;
  }
}
class dl {
  constructor(e) {
    this.helper = e;
  }
  fillPolygons(e, n) {
    n = Object.assign({}, n, { hachureAngle: 0 });
    const s = dt(e, n);
    return this.dotsOnLines(s, n);
  }
  dotsOnLines(e, n) {
    const s = [];
    let r = n.hachureGap;
    r < 0 && (r = n.strokeWidth * 4), (r = Math.max(r, 0.1));
    let o = n.fillWeight;
    o < 0 && (o = n.strokeWidth / 2);
    const i = r / 4;
    for (const a of e) {
      const l = Gt(a),
        c = l / r,
        u = Math.ceil(c) - 1,
        h = l - u * r,
        p = (a[0][0] + a[1][0]) / 2 - r / 4,
        f = Math.min(a[0][1], a[1][1]);
      for (let d = 0; d < u; d++) {
        const g = f + h + d * r,
          m = p - i + Math.random() * 2 * i,
          v = g - i + Math.random() * 2 * i,
          y = this.helper.ellipse(m, v, o, o, n);
        s.push(...y.ops);
      }
    }
    return { type: "fillSketch", ops: s };
  }
}
class pl {
  constructor(e) {
    this.helper = e;
  }
  fillPolygons(e, n) {
    const s = dt(e, n);
    return { type: "fillSketch", ops: this.dashedLine(s, n) };
  }
  dashedLine(e, n) {
    const s =
        n.dashOffset < 0 ? (n.hachureGap < 0 ? n.strokeWidth * 4 : n.hachureGap) : n.dashOffset,
      r = n.dashGap < 0 ? (n.hachureGap < 0 ? n.strokeWidth * 4 : n.hachureGap) : n.dashGap,
      o = [];
    return (
      e.forEach((i) => {
        const a = Gt(i),
          l = Math.floor(a / (s + r)),
          c = (a + r - l * (s + r)) / 2;
        let u = i[0],
          h = i[1];
        u[0] > h[0] && ((u = i[1]), (h = i[0]));
        const p = Math.atan((h[1] - u[1]) / (h[0] - u[0]));
        for (let f = 0; f < l; f++) {
          const d = f * (s + r),
            g = d + s,
            m = [
              u[0] + d * Math.cos(p) + c * Math.cos(p),
              u[1] + d * Math.sin(p) + c * Math.sin(p),
            ],
            v = [
              u[0] + g * Math.cos(p) + c * Math.cos(p),
              u[1] + g * Math.sin(p) + c * Math.sin(p),
            ];
          o.push(...this.helper.doubleLineOps(m[0], m[1], v[0], v[1], n));
        }
      }),
      o
    );
  }
}
class gl {
  constructor(e) {
    this.helper = e;
  }
  fillPolygons(e, n) {
    const s = n.hachureGap < 0 ? n.strokeWidth * 4 : n.hachureGap,
      r = n.zigzagOffset < 0 ? s : n.zigzagOffset;
    n = Object.assign({}, n, { hachureGap: s + r });
    const o = dt(e, n);
    return { type: "fillSketch", ops: this.zigzagLines(o, r, n) };
  }
  zigzagLines(e, n, s) {
    const r = [];
    return (
      e.forEach((o) => {
        const i = Gt(o),
          a = Math.round(i / (2 * n));
        let l = o[0],
          c = o[1];
        l[0] > c[0] && ((l = o[1]), (c = o[0]));
        const u = Math.atan((c[1] - l[1]) / (c[0] - l[0]));
        for (let h = 0; h < a; h++) {
          const p = h * 2 * n,
            f = (h + 1) * 2 * n,
            d = Math.sqrt(2 * Math.pow(n, 2)),
            g = [l[0] + p * Math.cos(u), l[1] + p * Math.sin(u)],
            m = [l[0] + f * Math.cos(u), l[1] + f * Math.sin(u)],
            v = [g[0] + d * Math.cos(u + Math.PI / 4), g[1] + d * Math.sin(u + Math.PI / 4)];
          r.push(
            ...this.helper.doubleLineOps(g[0], g[1], v[0], v[1], s),
            ...this.helper.doubleLineOps(v[0], v[1], m[0], m[1], s)
          );
        }
      }),
      r
    );
  }
}
const K = {};
function ml(t, e) {
  let n = t.fillStyle || "hachure";
  if (!K[n])
    switch (n) {
      case "zigzag":
        K[n] || (K[n] = new fl(e));
        break;
      case "cross-hatch":
        K[n] || (K[n] = new hl(e));
        break;
      case "dots":
        K[n] || (K[n] = new dl(e));
        break;
      case "dashed":
        K[n] || (K[n] = new pl(e));
        break;
      case "zigzag-line":
        K[n] || (K[n] = new gl(e));
        break;
      case "hachure":
      default:
        (n = "hachure"), K[n] || (K[n] = new Fn(e));
        break;
    }
  return K[n];
}
const yl = 0,
  n = 1,
  br = 2,
  bt = {
    A: 7,
    a: 7,
    C: 6,
    c: 6,
    H: 1,
    h: 1,
    L: 2,
    l: 2,
    M: 2,
    m: 2,
    Q: 4,
    q: 4,
    S: 4,
    s: 4,
    T: 2,
    t: 2,
    V: 1,
    v: 1,
    Z: 0,
    z: 0,
  };
function vl(t) {
  const e = new Array();
  for (; t !== ""; )
    if (t.match(/^([ \t\r\n,]+)/)) t = t.substr(RegExp.$1.length);
    else if (t.match(/^([aAcChHlLmMqQsStTvVzZ])/))
      (e[e.length] = { type: yl, text: RegExp.$1 }), (t = t.substr(RegExp.$1.length));
    else if (t.match(/^(([-+]?[0-9]+(\.[0-9]*)?|[-+]?\.[0-9]+)([eE][-+]?[0-9]+)?)/))
      (e[e.length] = { type: _n, text: `${parseFloat(RegExp.$1)}` }),
        (t = t.substr(RegExp.$1.length));
    else return [];
  return (e[e.length] = { type: br, text: "" }), e;
}
function on(t, e) {
  return t.type === e;
}
function zn(t) {
  const e = [],
    n = vl(t);
  let s = "BOD",
    r = 0,
    o = n[r];
  for (; !on(o, br); ) {
    let i = 0;
    const a = [];
    if (s === "BOD")
      if (o.text === "M" || o.text === "m") r++, (i = bt[o.text]), (s = o.text);
      else return zn(`M0,0${t}`);
    else on(o, _n) ? (i = bt[s]) : (r++, (i = bt[o.text]), (s = o.text));
    if (r + i < n.length) {
      for (let l = r; l < r + i; l++) {
        const c = n[l];
        if (on(c, _n)) a[a.length] = +c.text;
        else throw new Error(`Param not a number: ${s},${c.text}`);
      }
      if (typeof bt[s] == "number") {
        const l = { key: s, data: a };
        e.push(l), (r += i), (o = n[r]), s === "M" && (s = "L"), s === "m" && (s = "l");
      } else throw new Error(`Bad segment: ${s}`);
    } else throw new Error("Path data ended short");
  }
  return e;
}
function _r(t) {
  let e = 0,
    n = 0,
    s = 0,
    r = 0;
  const o = [];
  for (const { key: i, data: a } of t)
    switch (i) {
      case "M":
        o.push({ key: "M", data: [...a] }), ([e, n] = a), ([s, r] = a);
        break;
      case "m":
        (e += a[0]), (n += a[1]), o.push({ key: "M", data: [e, n] }), (s = e), (r = n);
        break;
      case "L":
        o.push({ key: "L", data: [...a] }), ([e, n] = a);
        break;
      case "l":
        (e += a[0]), (n += a[1]), o.push({ key: "L", data: [e, n] });
        break;
      case "C":
        o.push({ key: "C", data: [...a] }), (e = a[4]), (n = a[5]);
        break;
      case "c": {
        const l = a.map((c, u) => (u % 2 ? c + n : c + e));
        o.push({ key: "C", data: l }), (e = l[4]), (n = l[5]);
        break;
      }
      case "Q":
        o.push({ key: "Q", data: [...a] }), (e = a[2]), (n = a[3]);
        break;
      case "q": {
        const l = a.map((c, u) => (u % 2 ? c + n : c + e));
        o.push({ key: "Q", data: l }), (e = l[2]), (n = l[3]);
        break;
      }
      case "A":
        o.push({ key: "A", data: [...a] }), (e = a[5]), (n = a[6]);
        break;
      case "a":
        (e += a[5]), (n += a[6]), o.push({ key: "A", data: [a[0], a[1], a[2], a[3], a[4], e, n] });
        break;
      case "H":
        o.push({ key: "H", data: [...a] }), (e = a[0]);
        break;
      case "h":
        (e += a[0]), o.push({ key: "H", data: [e] });
        break;
      case "V":
        o.push({ key: "V", data: [...a] }), (n = a[0]);
        break;
      case "v":
        (n += a[0]), o.push({ key: "V", data: [n] });
        break;
      case "S":
        o.push({ key: "S", data: [...a] }), (e = a[2]), (n = a[3]);
        break;
      case "s": {
        const l = a.map((c, u) => (u % 2 ? c + n : c + e));
        o.push({ key: "S", data: l }), (e = l[2]), (n = l[3]);
        break;
      }
      case "T":
        o.push({ key: "T", data: [...a] }), (e = a[0]), (n = a[1]);
        break;
      case "t":
        (e += a[0]), (n += a[1]), o.push({ key: "T", data: [e, n] });
        break;
      case "Z":
      case "z":
        o.push({ key: "Z", data: [] }), (e = s), (n = r);
        break;
    }
  return o;
}
function Sr(t) {
  const e = [];
  let n = "",
    s = 0,
    r = 0,
    o = 0,
    i = 0,
    a = 0,
    l = 0;
  for (const { key: c, data: u } of t) {
    switch (c) {
      case "M":
        e.push({ key: "M", data: [...u] }), ([s, r] = u), ([o, i] = u);
        break;
      case "C":
        e.push({ key: "C", data: [...u] }), (s = u[4]), (r = u[5]), (a = u[2]), (l = u[3]);
        break;
      case "L":
        e.push({ key: "L", data: [...u] }), ([s, r] = u);
        break;
      case "H":
        (s = u[0]), e.push({ key: "L", data: [s, r] });
        break;
      case "V":
        (r = u[0]), e.push({ key: "L", data: [s, r] });
        break;
      case "S": {
        let h = 0,
          p = 0;
        n === "C" || n === "S" ? ((h = s + (s - a)), (p = r + (r - l))) : ((h = s), (p = r)),
          e.push({ key: "C", data: [h, p, ...u] }),
          (a = u[0]),
          (l = u[1]),
          (s = u[2]),
          (r = u[3]);
        break;
      }
      case "T": {
        const [h, p] = u;
        let f = 0,
          d = 0;
        n === "Q" || n === "T" ? ((f = s + (s - a)), (d = r + (r - l))) : ((f = s), (d = r));
        const g = s + (2 * (f - s)) / 3,
          m = r + (2 * (d - r)) / 3,
          v = h + (2 * (f - h)) / 3,
          y = p + (2 * (d - p)) / 3;
        e.push({ key: "C", data: [g, m, v, y, h, p] }), (a = f), (l = d), (s = h), (r = p);
        break;
      }
      case "Q": {
        const [h, p, f, d] = u,
          g = s + (2 * (h - s)) / 3,
          m = r + (2 * (p - r)) / 3,
          v = f + (2 * (h - f)) / 3,
          y = d + (2 * (p - d)) / 3;
        e.push({ key: "C", data: [g, m, v, y, f, d] }), (a = h), (l = p), (s = f), (r = d);
        break;
      }
      case "A": {
        const h = Math.abs(u[0]),
          p = Math.abs(u[1]),
          f = u[2],
          d = u[3],
          g = u[4],
          m = u[5],
          v = u[6];
        h === 0 || p === 0
          ? (e.push({ key: "C", data: [s, r, m, v, m, v] }), (s = m), (r = v))
          : (s !== m || r !== v) &&
            (Mr(s, r, m, v, h, p, f, d, g).forEach(function (w) {
              e.push({ key: "C", data: w });
            }),
            (s = m),
            (r = v));
        break;
      }
      case "Z":
        e.push({ key: "Z", data: [] }), (s = o), (r = i);
        break;
    }
    n = c;
  }
  return e;
}
function wl(t) {
  return (Math.PI * t) / 180;
}
function ot(t, e, n) {
  const s = t * Math.cos(n) - e * Math.sin(n),
    r = t * Math.sin(n) + e * Math.cos(n);
  return [s, r];
}
function Mr(t, e, n, s, r, o, i, a, l, c) {
  const u = wl(i);
  let h = [],
    p = 0,
    f = 0,
    d = 0,
    g = 0;
  if (c) [p, f, d, g] = c;
  else {
    ([t, e] = ot(t, e, -u)), ([n, s] = ot(n, s, -u));
    const A = (t - n) / 2,
      D = (e - s) / 2;
    let q = (A * A) / (r * r) + (D * D) / (o * o);
    q > 1 && ((q = Math.sqrt(q)), (r = q * r), (o = q * o));
    const j = a === l ? -1 : 1,
      N = r * r,
      ae = o * o,
      ce = N * ae - N * D * D - ae * A * A,
      et = N * D * D + ae * A * A,
      W = j * Math.sqrt(Math.abs(ce / et));
    (d = (W * r * D) / o + (t + n) / 2),
      (g = (W * -o * A) / r + (e + s) / 2),
      (p = Math.asin(parseFloat(((e - g) / o).toFixed(9)))),
      (f = Math.asin(parseFloat(((s - g) / o).toFixed(9)))),
      t < d && (p = Math.PI - p),
      n < d && (f = Math.PI - f),
      p < 0 && (p = Math.PI * 2 + p),
      f < 0 && (f = Math.PI * 2 + f),
      l && p > f && (p = p - Math.PI * 2),
      !l && f > p && (f = f - Math.PI * 2);
  }
  let m = f - p;
  if (Math.abs(m) > (Math.PI * 120) / 180) {
    const A = f,
      D = n,
      q = s;
    l && f > p ? (f = p + ((Math.PI * 120) / 180) * 1) : (f = p + ((Math.PI * 120) / 180) * -1),
      (n = d + r * Math.cos(f)),
      (s = g + o * Math.sin(f)),
      (h = Mr(n, s, D, q, r, o, i, 0, l, [f, A, d, g]));
  }
  m = f - p;
  const v = Math.cos(p),
    y = Math.sin(p),
    w = Math.cos(f),
    b = Math.sin(f),
    S = Math.tan(m / 4),
    T = (4 / 3) * r * S,
    O = (4 / 3) * o * S,
    P = [t, e],
    z = [t + T * y, e - O * v],
    ne = [n + T * b, s - O * w],
    Z = [n, s];
  if (((z[0] = 2 * P[0] - z[0]), (z[1] = 2 * P[1] - z[1]), c)) return [z, ne, Z].concat(h);
  {
    h = [z, ne, Z].concat(h);
    const A = [];
    for (let D = 0; D < h.length; D += 3) {
      const q = ot(h[D][0], h[D][1], u),
        j = ot(h[D + 1][0], h[D + 1][1], u),
        N = ot(h[D + 2][0], h[D + 2][1], u);
      A.push([q[0], q[1], j[0], j[1], N[0], N[1]]);
    }
    return A;
  }
}
const kl = { randOffset: Sl, randOffsetWithRange: Ml, ellipse: Sn, doubleLineOps: Tl };
function X(t, e, n, s, r) {
  return { type: "path", ops: fe(t, e, n, s, r) };
}
function ut(t, e, n) {
  const s = (t || []).length;
  if (s > 2) {
    const r = [];
    for (let o = 0; o < s - 1; o++) r.push(...fe(t[o][0], t[o][1], t[o + 1][0], t[o + 1][1], n));
    return (
      e && r.push(...fe(t[s - 1][0], t[s - 1][1], t[0][0], t[0][1], n)), { type: "path", ops: r }
    );
  } else if (s === 2) return X(t[0][0], t[0][1], t[1][0], t[1][1], n);
  return { type: "path", ops: [] };
}
function bl(t, e) {
  return ut(t, !0, e);
}
function Tr(t, e, n, s, r) {
  const o = [
    [t, e],
    [t + n, e],
    [t + n, e + s],
    [t, e + s],
  ];
  return bl(o, r);
}
function Os(t, e) {
  if (t.length) {
    const s = typeof t[0][0] == "number" ? [t] : t,
      r = _t(s[0], 1 * (1 + e.roughness * 0.2), e),
      o = e.disableMultiStroke ? [] : _t(s[0], 1.5 * (1 + e.roughness * 0.22), $s(e));
    for (let i = 1; i < s.length; i++) {
      const a = s[i];
      if (a.length) {
        const l = _t(a, 1 * (1 + e.roughness * 0.2), e),
          c = e.disableMultiStroke ? [] : _t(a, 1.5 * (1 + e.roughness * 0.22), $s(e));
        for (const u of l) u.op !== "move" && r.push(u);
        for (const u of c) u.op !== "move" && o.push(u);
      }
    }
    return { type: "path", ops: r.concat(o) };
  }
  return { type: "path", ops: [] };
}
function Sn(t, e, n, s, r) {
  const o = Or(n, s, r);
  return Mn(t, e, r, o).opset;
}
function Or(t, e, n) {
  const s = Math.sqrt(Math.PI * 2 * Math.sqrt((Math.pow(t / 2, 2) + Math.pow(e / 2, 2)) / 2)),
    r = Math.ceil(Math.max(n.curveStepCount, (n.curveStepCount / Math.sqrt(200)) * s)),
    o = (Math.PI * 2) / r;
  let i = Math.abs(t / 2),
    a = Math.abs(e / 2);
  const l = 1 - n.curveFitting;
  return (i += M(i * l, n)), (a += M(a * l, n)), { increment: o, rx: i, ry: a };
}
function Mn(t, e, n, s) {
  const [r, o] = Ls(s.increment, t, e, s.rx, s.ry, 1, s.increment * Nt(0.1, Nt(0.4, 1, n), n), n);
  let i = Ht(r, null, n);
  if (!n.disableMultiStroke && n.roughness !== 0) {
    const [a] = Ls(s.increment, t, e, s.rx, s.ry, 1.5, 0, n),
      l = Ht(a, null, n);
    i = i.concat(l);
  }
  return { estimatedPoints: o, opset: { type: "path", ops: i } };
}
function As(t, e, n, s, r, o, i, a, l) {
  const c = t,
    u = e;
  let h = Math.abs(n / 2),
    p = Math.abs(s / 2);
  (h += M(h * 0.01, l)), (p += M(p * 0.01, l));
  let f = r,
    d = o;
  for (; f < 0; ) (f += Math.PI * 2), (d += Math.PI * 2);
  d - f > Math.PI * 2 && ((f = 0), (d = Math.PI * 2));
  const g = (Math.PI * 2) / l.curveStepCount,
    m = Math.min(g / 2, (d - f) / 2),
    v = Ps(m, c, u, h, p, f, d, 1, l);
  if (!l.disableMultiStroke) {
    const y = Ps(m, c, u, h, p, f, d, 1.5, l);
    v.push(...y);
  }
  return (
    i &&
      (a
        ? v.push(
            ...fe(c, u, c + h * Math.cos(f), u + p * Math.sin(f), l),
            ...fe(c, u, c + h * Math.cos(d), u + p * Math.sin(d), l)
          )
        : v.push(
            { op: "lineTo", data: [c, u] },
            { op: "lineTo", data: [c + h * Math.cos(f), u + p * Math.sin(f)] }
          )),
    { type: "path", ops: v }
  );
}
function Es(t, e) {
  const n = Sr(_r(zn(t))),
    s = [];
  let r = [0, 0],
    o = [0, 0];
  for (const { key: i, data: a } of n)
    switch (i) {
      case "M": {
        (o = [a[0], a[1]]), (r = [a[0], a[1]]);
        break;
      }
      case "L":
        s.push(...fe(o[0], o[1], a[0], a[1], e)), (o = [a[0], a[1]]);
        break;
      case "C": {
        const [l, c, u, h, p, f] = a;
        s.push(...Ol(l, c, u, h, p, f, o, e)), (o = [p, f]);
        break;
      }
      case "Z":
        s.push(...fe(o[0], o[1], r[0], r[1], e)), (o = [r[0], r[1]]);
        break;
    }
  return { type: "path", ops: s };
}
function an(t, e) {
  const n = [];
  for (const s of t)
    if (s.length) {
      const r = e.maxRandomnessOffset || 0,
        o = s.length;
      if (o > 2) {
        n.push({ op: "move", data: [s[0][0] + M(r, e), s[0][1] + M(r, e)] });
        for (let i = 1; i < o; i++)
          n.push({ op: "lineTo", data: [s[i][0] + M(r, e), s[i][1] + M(r, e)] });
      }
    }
  return { type: "fillPath", ops: n };
}
function Be(t, e) {
  return ml(e, kl).fillPolygons(t, e);
}
function _l(t, e, n, s, r, o, i) {
  const a = t,
    l = e;
  let c = Math.abs(n / 2),
    u = Math.abs(s / 2);
  (c += M(c * 0.01, i)), (u += M(u * 0.01, i));
  let h = r,
    p = o;
  for (; h < 0; ) (h += Math.PI * 2), (p += Math.PI * 2);
  p - h > Math.PI * 2 && ((h = 0), (p = Math.PI * 2));
  const f = (p - h) / i.curveStepCount,
    d = [];
  for (let g = h; g <= p; g = g + f) d.push([a + c * Math.cos(g), l + u * Math.sin(g)]);
  return d.push([a + c * Math.cos(p), l + u * Math.sin(p)]), d.push([a, l]), Be([d], i);
}
function Sl(t, e) {
  return M(t, e);
}
function Ml(t, e, n) {
  return Nt(t, e, n);
}
function Tl(t, e, n, s, r) {
  return fe(t, e, n, s, r, !0);
}
function $s(t) {
  const e = Object.assign({}, t);
  return (e.randomizer = void 0), t.seed && (e.seed = t.seed + 1), e;
}
function Ar(t) {
  return t.randomizer || (t.randomizer = new il(t.seed || 0)), t.randomizer.next();
}
function Nt(t, e, n, s = 1) {
  return n.roughness * s * (Ar(n) * (e - t) + t);
}
function M(t, e, n = 1) {
  return Nt(-t, t, e, n);
}
function fe(t, e, n, s, r, o = !1) {
  const i = o ? r.disableMultiStrokeFill : r.disableMultiStroke,
    a = Tn(t, e, n, s, r, !0, !1);
  if (i) return a;
  const l = Tn(t, e, n, s, r, !0, !0);
  return a.concat(l);
}
function Tn(t, e, n, s, r, o, i) {
  const a = Math.pow(t - n, 2) + Math.pow(e - s, 2),
    l = Math.sqrt(a);
  let c = 1;
  l < 200 ? (c = 1) : l > 500 ? (c = 0.4) : (c = -0.0016668 * l + 1.233334);
  let u = r.maxRandomnessOffset || 0;
  u * u * 100 > a && (u = l / 10);
  const h = u / 2,
    p = 0.2 + Ar(r) * 0.2;
  let f = (r.bowing * r.maxRandomnessOffset * (s - e)) / 200,
    d = (r.bowing * r.maxRandomnessOffset * (t - n)) / 200;
  (f = M(f, r, c)), (d = M(d, r, c));
  const g = [],
    m = () => M(h, r, c),
    v = () => M(u, r, c),
    y = r.preserveVertices;
  return (
    i
      ? g.push({ op: "move", data: [t + (y ? 0 : m()), e + (y ? 0 : m())] })
      : g.push({ op: "move", data: [t + (y ? 0 : M(u, r, c)), e + (y ? 0 : M(u, r, c))] }),
    i
      ? g.push({
          op: "bcurveTo",
          data: [
            f + t + (n - t) * p + m(),
            d + e + (s - e) * p + m(),
            f + t + 2 * (n - t) * p + m(),
            d + e + 2 * (s - e) * p + m(),
            n + (y ? 0 : m()),
            s + (y ? 0 : m()),
          ],
        })
      : g.push({
          op: "bcurveTo",
          data: [
            f + t + (n - t) * p + v(),
            d + e + (s - e) * p + v(),
            f + t + 2 * (n - t) * p + v(),
            d + e + 2 * (s - e) * p + v(),
            n + (y ? 0 : v()),
            s + (y ? 0 : v()),
          ],
        }),
    g
  );
}
function _t(t, e, n) {
  if (!t.length) return [];
  const s = [];
  s.push([t[0][0] + M(e, n), t[0][1] + M(e, n)]), s.push([t[0][0] + M(e, n), t[0][1] + M(e, n)]);
  for (let r = 1; r < t.length; r++)
    s.push([t[r][0] + M(e, n), t[r][1] + M(e, n)]),
      r === t.length - 1 && s.push([t[r][0] + M(e, n), t[r][1] + M(e, n)]);
  return Ht(s, null, n);
}
function Ht(t, e, n) {
  const s = t.length,
    r = [];
  if (s > 3) {
    const o = [],
      i = 1 - n.curveTightness;
    r.push({ op: "move", data: [t[1][0], t[1][1]] });
    for (let a = 1; a + 2 < s; a++) {
      const l = t[a];
      (o[0] = [l[0], l[1]]),
        (o[1] = [
          l[0] + (i * t[a + 1][0] - i * t[a - 1][0]) / 6,
          l[1] + (i * t[a + 1][1] - i * t[a - 1][1]) / 6,
        ]),
        (o[2] = [
          t[a + 1][0] + (i * t[a][0] - i * t[a + 2][0]) / 6,
          t[a + 1][1] + (i * t[a][1] - i * t[a + 2][1]) / 6,
        ]),
        (o[3] = [t[a + 1][0], t[a + 1][1]]),
        r.push({ op: "bcurveTo", data: [o[1][0], o[1][1], o[2][0], o[2][1], o[3][0], o[3][1]] });
    }
  } else
    s === 3
      ? (r.push({ op: "move", data: [t[1][0], t[1][1]] }),
        r.push({ op: "bcurveTo", data: [t[1][0], t[1][1], t[2][0], t[2][1], t[2][0], t[2][1]] }))
      : s === 2 && r.push(...Tn(t[0][0], t[0][1], t[1][0], t[1][1], n, !0, !0));
  return r;
}
function Ls(t, e, n, s, r, o, i, a) {
  const l = a.roughness === 0,
    c = [],
    u = [];
  if (l) {
    (t = t / 4), u.push([e + s * Math.cos(-t), n + r * Math.sin(-t)]);
    for (let h = 0; h <= Math.PI * 2; h = h + t) {
      const p = [e + s * Math.cos(h), n + r * Math.sin(h)];
      c.push(p), u.push(p);
    }
    u.push([e + s * Math.cos(0), n + r * Math.sin(0)]),
      u.push([e + s * Math.cos(t), n + r * Math.sin(t)]);
  } else {
    const h = M(0.5, a) - Math.PI / 2;
    u.push([M(o, a) + e + 0.9 * s * Math.cos(h - t), M(o, a) + n + 0.9 * r * Math.sin(h - t)]);
    const p = Math.PI * 2 + h - 0.01;
    for (let f = h; f < p; f = f + t) {
      const d = [M(o, a) + e + s * Math.cos(f), M(o, a) + n + r * Math.sin(f)];
      c.push(d), u.push(d);
    }
    u.push([
      M(o, a) + e + s * Math.cos(h + Math.PI * 2 + i * 0.5),
      M(o, a) + n + r * Math.sin(h + Math.PI * 2 + i * 0.5),
    ]),
      u.push([M(o, a) + e + 0.98 * s * Math.cos(h + i), M(o, a) + n + 0.98 * r * Math.sin(h + i)]),
      u.push([
        M(o, a) + e + 0.9 * s * Math.cos(h + i * 0.5),
        M(o, a) + n + 0.9 * r * Math.sin(h + i * 0.5),
      ]);
  }
  return [u, c];
}
function Ps(t, e, n, s, r, o, i, a, l) {
  const c = o + M(0.1, l),
    u = [];
  u.push([M(a, l) + e + 0.9 * s * Math.cos(c - t), M(a, l) + n + 0.9 * r * Math.sin(c - t)]);
  for (let h = c; h <= i; h = h + t)
    u.push([M(a, l) + e + s * Math.cos(h), M(a, l) + n + r * Math.sin(h)]);
  return (
    u.push([e + s * Math.cos(i), n + r * Math.sin(i)]),
    u.push([e + s * Math.cos(i), n + r * Math.sin(i)]),
    Ht(u, null, l)
  );
}
function Ol(t, e, n, s, r, o, i, a) {
  const l = [],
    c = [a.maxRandomnessOffset || 1, (a.maxRandomnessOffset || 1) + 0.3];
  let u = [0, 0];
  const h = a.disableMultiStroke ? 1 : 2,
    p = a.preserveVertices;
  for (let f = 0; f < h; f++)
    f === 0
      ? l.push({ op: "move", data: [i[0], i[1]] })
      : l.push({ op: "move", data: [i[0] + (p ? 0 : M(c[0], a)), i[1] + (p ? 0 : M(c[0], a))] }),
      (u = p ? [r, o] : [r + M(c[f], a), o + M(c[f], a)]),
      l.push({
        op: "bcurveTo",
        data: [t + M(c[f], a), e + M(c[f], a), n + M(c[f], a), s + M(c[f], a), u[0], u[1]],
      });
  return l;
}
function it(t) {
  return [...t];
}
function Cs(t, e = 0) {
  const n = t.length;
  if (n < 3) throw new Error("A curve must have at least three points.");
  const s = [];
  if (n === 3) s.push(it(t[0]), it(t[1]), it(t[2]), it(t[2]));
  else {
    const r = [];
    r.push(t[0], t[0]);
    for (let a = 1; a < t.length; a++) r.push(t[a]), a === t.length - 1 && r.push(t[a]);
    const o = [],
      i = 1 - e;
    s.push(it(r[0]));
    for (let a = 1; a + 2 < r.length; a++) {
      const l = r[a];
      (o[0] = [l[0], l[1]]),
        (o[1] = [
          l[0] + (i * r[a + 1][0] - i * r[a - 1][0]) / 6,
          l[1] + (i * r[a + 1][1] - i * r[a - 1][1]) / 6,
        ]),
        (o[2] = [
          r[a + 1][0] + (i * r[a][0] - i * r[a + 2][0]) / 6,
          r[a + 1][1] + (i * r[a][1] - i * r[a + 2][1]) / 6,
        ]),
        (o[3] = [r[a + 1][0], r[a + 1][1]]),
        s.push(o[1], o[2], o[3]);
    }
  }
  return s;
}
function Al(t, e) {
  return Math.sqrt($t(t, e));
}
function $t(t, e) {
  return Math.pow(t[0] - e[0], 2) + Math.pow(t[1] - e[1], 2);
}
function El(t, e, n) {
  const s = $t(e, n);
  if (s === 0) return $t(t, e);
  let r = ((t[0] - e[0]) * (n[0] - e[0]) + (t[1] - e[1]) * (n[1] - e[1])) / s;
  return (r = Math.max(0, Math.min(1, r))), $t(t, He(e, n, r));
}
function He(t, e, n) {
  return [t[0] + (e[0] - t[0]) * n, t[1] + (e[1] - t[1]) * n];
}
function $l(t, e) {
  const n = t[e + 0],
    s = t[e + 1],
    r = t[e + 2],
    o = t[e + 3];
  let i = 3 * s[0] - 2 * n[0] - o[0];
  i *= i;
  let a = 3 * s[1] - 2 * n[1] - o[1];
  a *= a;
  let l = 3 * r[0] - 2 * o[0] - n[0];
  l *= l;
  let c = 3 * r[1] - 2 * o[1] - n[1];
  return (c *= c), i < l && (i = l), a < c && (a = c), i + a;
}
function On(t, e, n, s) {
  const r = s || [];
  if ($l(t, e) < n) {
    const o = t[e + 0];
    r.length ? Al(r[r.length - 1], o) > 1 && r.push(o) : r.push(o), r.push(t[e + 3]);
  } else {
    const i = t[e + 0],
      a = t[e + 1],
      l = t[e + 2],
      c = t[e + 3],
      u = He(i, a, 0.5),
      h = He(a, l, 0.5),
      p = He(l, c, 0.5),
      f = He(u, h, 0.5),
      d = He(h, p, 0.5),
      g = He(f, d, 0.5);
    On([i, u, f, g], 0, n, r), On([g, d, p, c], 0, n, r);
  }
  return r;
}
function Ll(t, e) {
  return xt(t, 0, t.length, e);
}
function xt(t, e, n, s, r) {
  const o = r || [],
    i = t[e],
    a = t[n - 1];
  let l = 0,
    c = 1;
  for (let u = e + 1; u < n - 1; ++u) {
    const h = El(t[u], i, a);
    h > l && ((l = h), (c = u));
  }
  return (
    Math.sqrt(l) > s
      ? (xt(t, e, c + 1, s, o), xt(t, c, n, s, o))
      : (o.length || o.push(i), o.push(a)),
    o
  );
}
function An(t, e = 0.15, n) {
  const s = [],
    r = (t.length - 1) / 3;
  for (let o = 0; o < r; o++) {
    const i = o * 3;
    On(t, i, e, s);
  }
  return n && n > 0 ? xt(s, 0, s.length, n) : s;
}
function Pl(t, e, n) {
  const s = zn(t),
    r = Sr(_r(s)),
    o = [];
  let i = [],
    a = [0, 0],
    l = [];
  const c = () => {
      l.length >= 4 && i.push(...An(l, e)), (l = []);
    },
    u = () => {
      c(), i.length && (o.push(i), (i = []));
    };
  for (const { key: p, data: f } of r)
    switch (p) {
      case "M":
        u(), (a = [f[0], f[1]]), i.push(a);
        break;
      case "L":
        c(), i.push([f[0], f[1]]);
        break;
      case "C":
        if (!l.length) {
          const d = i.length ? i[i.length - 1] : a;
          l.push([d[0], d[1]]);
        }
        l.push([f[0], f[1]]), l.push([f[2], f[3]]), l.push([f[4], f[5]]);
        break;
      case "Z":
        c(), i.push([a[0], a[1]]);
        break;
    }
  if ((u(), !n)) return o;
  const h = [];
  for (const p of o) {
    const f = Ll(p, n);
    f.length && h.push(f);
  }
  return h;
}
const Q = "none";
class Cl {
  constructor(e) {
    (this.defaultOptions = {
      maxRandomnessOffset: 2,
      roughness: 1,
      bowing: 1,
      stroke: "#000",
      strokeWidth: 1,
      curveTightness: 0,
      curveFitting: 0.95,
      curveStepCount: 9,
      fillStyle: "hachure",
      fillWeight: -1,
      hachureAngle: -41,
      hachureGap: -1,
      dashOffset: -1,
      dashGap: -1,
      zigzagOffset: -1,
      seed: 0,
      disableMultiStroke: !1,
      disableMultiStrokeFill: !1,
      preserveVertices: !1,
      fillShapeRoughnessGain: 0.8,
    }),
      (this.config = e || {}),
      this.config.options && (this.defaultOptions = this._o(this.config.options));
  }
  static newSeed() {
    return kr();
  }
  _o(e) {
    return e ? Object.assign({}, this.defaultOptions, e) : this.defaultOptions;
  }
  _d(e, n, s) {
    return { shape: e, sets: n || [], options: s || this.defaultOptions };
  }
  line(e, n, s, r, o) {
    const i = this._o(o);
    return this._d("line", [X(e, n, s, r, i)], i);
  }
  rectangle(e, n, s, r, o) {
    const i = this._o(o),
      a = [],
      l = Tr(e, n, s, r, i);
    if (i.fill) {
      const c = [
        [e, n],
        [e + s, n],
        [e + s, n + r],
        [e, n + r],
      ];
      i.fillStyle === "solid" ? a.push(an([c], i)) : a.push(Be([c], i));
    }
    return i.stroke !== Q && a.push(l), this._d("rectangle", a, i);
  }
  ellipse(e, n, s, r, o) {
    const i = this._o(o),
      a = [],
      l = Or(s, r, i),
      c = Mn(e, n, i, l);
    if (i.fill)
      if (i.fillStyle === "solid") {
        const u = Mn(e, n, i, l).opset;
        (u.type = "fillPath"), a.push(u);
      } else a.push(Be([c.estimatedPoints], i));
    return i.stroke !== Q && a.push(c.opset), this._d("ellipse", a, i);
  }
  circle(e, n, s, r) {
    const o = this.ellipse(e, n, s, s, r);
    return (o.shape = "circle"), o;
  }
  linearPath(e, n) {
    const s = this._o(n);
    return this._d("linearPath", [ut(e, !1, s)], s);
  }
  arc(e, n, s, r, o, i, a = !1, l) {
    const c = this._o(l),
      u = [],
      h = As(e, n, s, r, o, i, a, !0, c);
    if (a && c.fill)
      if (c.fillStyle === "solid") {
        const p = Object.assign({}, c);
        p.disableMultiStroke = !0;
        const f = As(e, n, s, r, o, i, !0, !1, p);
        (f.type = "fillPath"), u.push(f);
      } else u.push(_l(e, n, s, r, o, i, c));
    return c.stroke !== Q && u.push(h), this._d("arc", u, c);
  }
  curve(e, n) {
    const s = this._o(n),
      r = [],
      o = Os(e, s);
    if (s.fill && s.fill !== Q)
      if (s.fillStyle === "solid") {
        const i = Os(
          e,
          Object.assign(Object.assign({}, s), {
            disableMultiStroke: !0,
            roughness: s.roughness ? s.roughness + s.fillShapeRoughnessGain : 0,
          })
        );
        r.push({ type: "fillPath", ops: this._mergedShape(i.ops) });
      } else {
        const i = [],
          a = e;
        if (a.length) {
          const c = typeof a[0][0] == "number" ? [a] : a;
          for (const u of c)
            u.length < 3
              ? i.push(...u)
              : u.length === 3
                ? i.push(...An(Cs([u[0], u[0], u[1], u[2]]), 10, (1 + s.roughness) / 2))
                : i.push(...An(Cs(u), 10, (1 + s.roughness) / 2));
        }
        i.length && r.push(Be([i], s));
      }
    return s.stroke !== Q && r.push(o), this._d("curve", r, s);
  }
  polygon(e, n) {
    const s = this._o(n),
      r = [],
      o = ut(e, !0, s);
    return (
      s.fill && (s.fillStyle === "solid" ? r.push(an([e], s)) : r.push(Be([e], s))),
      s.stroke !== Q && r.push(o),
      this._d("polygon", r, s)
    );
  }
  path(e, n) {
    const s = this._o(n),
      r = [];
    if (!e) return this._d("path", r, s);
    e = (e || "").replace(/\n/g, " ").replace(/(-\s)/g, "-").replace("/(ss)/g", " ");
    const o = s.fill && s.fill !== "transparent" && s.fill !== Q,
      i = s.stroke !== Q,
      a = !!(s.simplification && s.simplification < 1),
      l = a ? 4 - 4 * (s.simplification || 1) : (1 + s.roughness) / 2,
      c = Pl(e, 1, l),
      u = Es(e, s);
    if (o)
      if (s.fillStyle === "solid")
        if (c.length === 1) {
          const h = Es(
            e,
            Object.assign(Object.assign({}, s), {
              disableMultiStroke: !0,
              roughness: s.roughness ? s.roughness + s.fillShapeRoughnessGain : 0,
            })
          );
          r.push({ type: "fillPath", ops: this._mergedShape(h.ops) });
        } else r.push(an(c, s));
      else r.push(Be(c, s));
    return (
      i &&
        (a
          ? c.forEach((h) => {
              r.push(ut(h, !1, s));
            })
          : r.push(u)),
      this._d("path", r, s)
    );
  }
  opsToPath(e, n) {
    let s = "";
    for (const r of e.ops) {
      const o = typeof n == "number" && n >= 0 ? r.data.map((i) => +i.toFixed(n)) : r.data;
      switch (r.op) {
        case "move":
          s += `M${o[0]} ${o[1]} `;
          break;
        case "bcurveTo":
          s += `C${o[0]} ${o[1]}, ${o[2]} ${o[3]}, ${o[4]} ${o[5]} `;
          break;
        case "lineTo":
          s += `L${o[0]} ${o[1]} `;
          break;
      }
    }
    return s.trim();
  }
  toPaths(e) {
    const n = e.sets || [],
      s = e.options || this.defaultOptions,
      r = [];
    for (const o of n) {
      let i = null;
      switch (o.type) {
        case "path":
          i = { d: this.opsToPath(o), stroke: s.stroke, strokeWidth: s.strokeWidth, fill: Q };
          break;
        case "fillPath":
          i = { d: this.opsToPath(o), stroke: Q, strokeWidth: 0, fill: s.fill || Q };
          break;
        case "fillSketch":
          i = this.fillSketch(o, s);
          break;
      }
      i && r.push(i);
    }
    return r;
  }
  fillSketch(e, n) {
    let s = n.fillWeight;
    return (
      s < 0 && (s = n.strokeWidth / 2),
      { d: this.opsToPath(e), stroke: n.fill || Q, strokeWidth: s, fill: Q }
    );
  }
  _mergedShape(e) {
    return e.filter((n, s) => (s === 0 ? !0 : n.op !== "move"));
  }
}
const Er = "http://www.w3.org/2000/svg",
  Il = 800;
let ln = null;
function Rl() {
  return ln || (ln = new Cl().defaultOptions), ln;
}
function cn(t, e, n) {
  return {
    ...Rl(),
    maxRandomnessOffset: 2,
    roughness: t === "highlight" ? 3 : 1.5,
    bowing: 1,
    stroke: "#000",
    strokeWidth: 1.5,
    curveTightness: 0,
    curveFitting: 0.95,
    curveStepCount: 9,
    fillStyle: "hachure",
    fillWeight: -1,
    hachureAngle: -41,
    hachureGap: -1,
    dashOffset: -1,
    dashGap: -1,
    zigzagOffset: -1,
    disableMultiStroke: t !== "double",
    disableMultiStrokeFill: !1,
    seed: e,
    ...n,
  };
}
function Dl(t) {
  const e = t.padding;
  if (e || e === 0) {
    if (typeof e == "number") return [e, e, e, e];
    if (Array.isArray(e)) {
      const n = e;
      if (n.length)
        switch (n.length) {
          case 4:
            return [...n];
          case 1:
            return [n[0], n[0], n[0], n[0]];
          case 2:
            return [...n, ...n];
          case 3:
            return [...n, n[1]];
          default:
            return [n[0], n[1], n[2], n[3]];
        }
    }
  }
  return [5, 5, 5, 5];
}
function jl(t, e, n, s, r, o) {
  const i = [];
  let a = n.strokeWidth || 2;
  const l = Dl(n),
    c = n.animate === void 0 ? !0 : !!n.animate,
    u = n.iterations || 2,
    h = n.rtl ? 1 : 0,
    p = cn("single", o, n);
  switch (n.type) {
    case "underline": {
      const f = e.y + e.h + l[2];
      for (let d = h; d < u + h; d++)
        d % 2 ? i.push(X(e.x + e.w, f, e.x, f, p)) : i.push(X(e.x, f, e.x + e.w, f, p));
      break;
    }
    case "strike-through": {
      const f = e.y + e.h / 2;
      for (let d = h; d < u + h; d++)
        d % 2 ? i.push(X(e.x + e.w, f, e.x, f, p)) : i.push(X(e.x, f, e.x + e.w, f, p));
      break;
    }
    case "box": {
      const f = e.x - l[3],
        d = e.y - l[0],
        g = e.w + (l[1] + l[3]),
        m = e.h + (l[0] + l[2]);
      for (let v = 0; v < u; v++) i.push(Tr(f, d, g, m, p));
      break;
    }
    case "bracket": {
      const f = Array.isArray(n.brackets) ? n.brackets : n.brackets ? [n.brackets] : ["right"],
        d = e.x - l[3] * 2,
        g = e.x + e.w + l[1] * 2,
        m = e.y - l[0] * 2,
        v = e.y + e.h + l[2] * 2;
      for (const y of f) {
        let w;
        switch (y) {
          case "bottom":
            w = [
              [d, e.y + e.h],
              [d, v],
              [g, v],
              [g, e.y + e.h],
            ];
            break;
          case "top":
            w = [
              [d, e.y],
              [d, m],
              [g, m],
              [g, e.y],
            ];
            break;
          case "left":
            w = [
              [e.x, m],
              [d, m],
              [d, v],
              [e.x, v],
            ];
            break;
          case "right":
            w = [
              [e.x + e.w, m],
              [g, m],
              [g, v],
              [e.x + e.w, v],
            ];
            break;
        }
        w && i.push(ut(w, !1, p));
      }
      break;
    }
    case "crossed-off": {
      const f = e.x,
        d = e.y,
        g = f + e.w,
        m = d + e.h;
      for (let v = h; v < u + h; v++) v % 2 ? i.push(X(g, m, f, d, p)) : i.push(X(f, d, g, m, p));
      for (let v = h; v < u + h; v++) v % 2 ? i.push(X(f, m, g, d, p)) : i.push(X(g, d, f, m, p));
      break;
    }
    case "circle": {
      const f = cn("double", o, n),
        d = e.w + (l[1] + l[3]),
        g = e.h + (l[0] + l[2]),
        m = e.x - l[3] + d / 2,
        v = e.y - l[0] + g / 2,
        y = Math.floor(u / 2),
        w = u - y * 2;
      for (let b = 0; b < y; b++) i.push(Sn(m, v, d, g, f));
      for (let b = 0; b < w; b++) i.push(Sn(m, v, d, g, p));
      break;
    }
    case "highlight": {
      const f = cn("highlight", o, n);
      a = e.h * 0.95;
      const d = e.y + e.h / 2;
      for (let g = h; g < u + h; g++)
        g % 2 ? i.push(X(e.x + e.w, d, e.x, d, f)) : i.push(X(e.x, d, e.x + e.w, d, f));
      break;
    }
  }
  if (i.length) {
    const f = Nl(i),
      d = [],
      g = [];
    let m = 0;
    const v = (y, w, b) => y.setAttribute(w, b);
    for (const y of f) {
      const w = document.createElementNS(Er, "path");
      if (
        (v(w, "d", y),
        v(w, "fill", "none"),
        v(w, "stroke", n.color || "currentColor"),
        v(w, "stroke-width", `${a}`),
        n.opacity !== void 0 && v(w, "style", `opacity:${n.opacity}`),
        c)
      ) {
        const b = w.getTotalLength();
        d.push(b), (m += b);
      }
      t.appendChild(w), g.push(w);
    }
    if (c) {
      let y = 0;
      for (let w = 0; w < g.length; w++) {
        const b = g[w],
          S = d[w],
          T = m ? r * (S / m) : 0,
          O = s + y,
          P = b.style;
        (P.strokeDashoffset = `${S}`),
          (P.strokeDasharray = `${S}`),
          (P.animation = `rough-notation-dash ${T}ms ease-out ${O}ms forwards`),
          (y += T);
      }
      return Is(r + s);
    }
  }
  return Is(0);
}
function Is(t) {
  return new Promise((e) => setTimeout(e, t));
}
function Nl(t) {
  const e = [];
  for (const n of t) {
    let s = "";
    for (const r of n.ops) {
      const o = r.data;
      switch (r.op) {
        case "move":
          s.trim() && e.push(s.trim()), (s = `M${o[0]} ${o[1]} `);
          break;
        case "bcurveTo":
          s += `C${o[0]} ${o[1]}, ${o[2]} ${o[3]}, ${o[4]} ${o[5]} `;
          break;
        case "lineTo":
          s += `L${o[0]} ${o[1]} `;
          break;
      }
    }
    s.trim() && e.push(s.trim());
  }
  return e;
}
function Hl() {
  if (!window.__rno_kf_s) {
    const t = (window.__rno_kf_s = document.createElement("style"));
    (t.textContent = "@keyframes rough-notation-dash { to { stroke-dashoffset: 0; } }"),
      document.head.appendChild(t);
  }
}
const xl = Object.defineProperty,
  Fl = (t, e, n) =>
    e in t ? xl(t, e, { enumerable: !0, configurable: !0, writable: !0, value: n }) : (t[e] = n),
  se = (t, e, n) => (Fl(t, typeof e != "symbol" ? `${e}` : e, n), n);
class zl {
  constructor(e, n) {
    se(this, "_state", "unattached"),
      se(this, "_config"),
      se(this, "_resizing", !1),
      se(this, "_ro"),
      se(this, "_seed", kr()),
      se(this, "_e"),
      se(this, "_svg"),
      se(this, "_lastSizes", []),
      se(this, "_animationDelay", 0),
      se(this, "_resizeListener", () => {
        this._resizing ||
          ((this._resizing = !0),
          setTimeout(() => {
            (this._resizing = !1),
              this._state === "showing" && this.haveRectsChanged() && this.show();
          }, 400));
      }),
      se(this, "pendingRefresh"),
      (this._e = e),
      (this._config = JSON.parse(JSON.stringify(n))),
      this.attach();
  }
  getConfig(e) {
    return this._config[e];
  }
  setConfig(e, n) {
    this._config[e] !== n && ((this._config[e] = n), this.refresh());
  }
  get animate() {
    return this._config.animate;
  }
  set animate(e) {
    this._config.animate = e;
  }
  get animationDuration() {
    return this._config.animationDuration;
  }
  set animationDuration(e) {
    this._config.animationDuration = e;
  }
  get iterations() {
    return this._config.iterations;
  }
  set iterations(e) {
    this._config.iterations = e;
  }
  get color() {
    return this._config.color;
  }
  set color(e) {
    this._config.color !== e && ((this._config.color = e), this.refresh());
  }
  get class() {
    return this._config.class;
  }
  set class(e) {
    this._config.class !== e &&
      ((this._config.class = e),
      this._svg &&
        this._svg.setAttribute(
          "class",
          ["rough-annotation", this._config.class || ""].filter(Boolean).join(" ")
        ));
  }
  get strokeWidth() {
    return this._config.strokeWidth;
  }
  set strokeWidth(e) {
    this._config.strokeWidth !== e && ((this._config.strokeWidth = e), this.refresh());
  }
  get padding() {
    return this._config.padding;
  }
  set padding(e) {
    this._config.padding !== e && ((this._config.padding = e), this.refresh());
  }
  attach() {
    if (this._state === "unattached" && this._e.parentElement) {
      Hl();
      const e = (this._svg = document.createElementNS(Er, "svg"));
      e.setAttribute(
        "class",
        ["rough-annotation", this._config.class || ""].filter(Boolean).join(" ")
      );
      const n = e.style;
      (n.position = "absolute"),
        (n.top = "0"),
        (n.left = "0"),
        (n.overflow = "visible"),
        (n.pointerEvents = "none"),
        (n.width = "100px"),
        (n.height = "100px");
      const s = this._config.type === "highlight";
      if (
        (this._e.insertAdjacentElement(s ? "beforebegin" : "afterend", e),
        (this._state = "not-showing"),
        s)
      ) {
        const r = window.getComputedStyle(this._e).position;
        (!r || r === "static") && (this._e.style.position = "relative");
      }
      this.attachListeners();
    }
  }
  detachListeners() {
    window.removeEventListener("resize", this._resizeListener),
      this._ro && this._ro.unobserve(this._e);
  }
  attachListeners() {
    this.detachListeners(),
      window.addEventListener("resize", this._resizeListener, { passive: !0 }),
      !this._ro &&
        "ResizeObserver" in window &&
        (this._ro = new window.ResizeObserver((e) => {
          for (const n of e) n.contentRect && this._resizeListener();
        })),
      this._ro && this._ro.observe(this._e);
  }
  haveRectsChanged() {
    if (this._lastSizes.length) {
      const e = this.rects();
      if (e.length === this._lastSizes.length) {
        for (let n = 0; n < e.length; n++)
          if (!this.isSameRect(e[n], this._lastSizes[n])) return !0;
      } else return !0;
    }
    return !1;
  }
  isSameRect(e, n) {
    const s = (r, o) => Math.round(r) === Math.round(o);
    return s(e.x, n.x) && s(e.y, n.y) && s(e.w, n.w) && s(e.h, n.h);
  }
  isShowing() {
    return this._state !== "not-showing";
  }
  refresh() {
    this.isShowing() &&
      !this.pendingRefresh &&
      (this.pendingRefresh = Promise.resolve().then(() => {
        this.isShowing() && this.show(), delete this.pendingRefresh;
      }));
  }
  async show() {
    switch (this._state) {
      case "unattached":
        break;
      case "showing":
        this.hide(), this._svg && (await this.render(this._svg, !0));
        break;
      case "not-showing":
        this.attach(), this._svg && (await this.render(this._svg, !1));
        break;
    }
  }
  hide() {
    if (this._svg) for (; this._svg.lastChild; ) this._svg.removeChild(this._svg.lastChild);
    this._state = "not-showing";
  }
  remove() {
    this._svg && this._svg.parentElement && this._svg.parentElement.removeChild(this._svg),
      (this._svg = void 0),
      (this._state = "unattached"),
      this.detachListeners();
  }
  async render(e, n) {
    let s = this._config;
    n && ((s = JSON.parse(JSON.stringify(this._config))), (s.animate = !1));
    const r = this.rects();
    let o = 0;
    r.forEach((c) => (o += c.w));
    const i = s.animationDuration || Il;
    let a = 0;
    const l = [];
    for (let c = 0; c < r.length; c++) {
      const u = r[c],
        h = i * (u.w / o);
      l.push(jl(e, r[c], s, a + this._animationDelay + (this._config.delay || 0), h, this._seed)),
        (a += h);
    }
    return (this._lastSizes = r), (this._state = "showing"), await Promise.all(l);
  }
  rects() {
    const e = [];
    if (this._svg)
      if (this._config.multiline) {
        const n = this._e.getClientRects();
        for (let s = 0; s < n.length; s++) e.push(this.svgRect(this._svg, n[s]));
      } else e.push(this.svgRect(this._svg, this._e.getBoundingClientRect()));
    return e;
  }
  svgRect(e, n) {
    const s = e.getBoundingClientRect(),
      r = n;
    return {
      x: (r.x || r.left) - (s.x || s.left),
      y: (r.y || r.top) - (s.y || s.top),
      w: r.width,
      h: r.height,
    };
  }
}
function Vl(t, e) {
  return new zl(t, e);
}
function G(t, e) {
  return (t.class = [t.class, e].filter(Boolean).join(" ")), t;
}
const Rs = {
    box: (t) => Object.assign(t, { type: "box" }),
    circle: (t) => Object.assign(t, { type: "circle" }),
    underline: (t) => Object.assign(t, { type: "underline" }),
    highlight: (t) => Object.assign(t, { type: "highlight" }),
    "strike-through": (t) => Object.assign(t, { type: "strike-through" }),
    "crossed-off": (t) => Object.assign(t, { type: "crossed-off" }),
    bracket: (t) => Object.assign(t, { type: "bracket" }),
    strike: (t) => Object.assign(t, { type: "strike-through" }),
    cross: (t) => Object.assign(t, { type: "crossed-off" }),
    crossed: (t) => Object.assign(t, { type: "crossed-off" }),
    linethrough: (t) => Object.assign(t, { type: "strike-through" }),
    "line-through": (t) => Object.assign(t, { type: "strike-through" }),
    black: (t) => G(t, "text-black"),
    blue: (t) => G(t, "text-blue"),
    cyan: (t) => G(t, "text-cyan"),
    gray: (t) => G(t, "text-gray"),
    green: (t) => G(t, "text-green"),
    indigo: (t) => G(t, "text-indigo"),
    lime: (t) => G(t, "text-lime"),
    orange: (t) => G(t, "text-orange"),
    pink: (t) => G(t, "text-pink"),
    purple: (t) => G(t, "text-purple"),
    red: (t) => G(t, "text-red"),
    teal: (t) => G(t, "text-teal"),
    white: (t) => G(t, "text-white"),
    yellow: (t) => G(t, "text-yellow"),
  },
  ql = [
    [
      /^delay-?(\d+)?$/,
      (t, e, n) => {
        const s = (t[1] ? Number.parseInt(t[1]) : n) || 300;
        return (e.delay = s), e;
      },
    ],
    [
      /^(?:op|opacity)-?(\d+)?$/,
      (t, e, n) => {
        const s = (t[1] ? Number.parseInt(t[1]) : n) || 100;
        return (e.opacity = s / 100), e;
      },
    ],
  ];
function Wl() {
  return {
    install(t) {
      t.directive("mark", {
        name: "v-mark",
        mounted: (e, n) => {
          const { isPrintMode: s } = Ze(),
            r = _(() => {
              const a =
                typeof n.value == "object" && !Array.isArray(n.value)
                  ? { ...n.value }
                  : { at: n.value };
              let l = { at: a.at };
              const c = Object.entries(n.modifiers).filter(([h, p]) => {
                if (Rs[h]) return (l = Rs[h](l, p)), !1;
                for (const [f, d] of ql) {
                  const g = h.match(f);
                  if (g) return (l = d(g, l, p)), !1;
                }
                return !0;
              });
              c.length && console.warn("[Slidev] Invalid modifiers for v-mark:", c);
              const u = { ...l, ...a };
              return u.type || (u.type = "underline"), s.value && (u.animationDuration = 1), u;
            }),
            o = Vl(e, r.value),
            i = Et(e, n, r.value.at);
          if (!i) {
            o.show();
            return;
          }
          e.watchStopHandle = Qe(() => {
            let a;
            r.value.class && (o.class = r.value.class), r.value.color && (o.color = r.value.color);
            const l = r.value.at;
            l === !0 ? (a = !0) : l === !1 ? (a = !1) : (a = i.isActive.value),
              a != null && (a ? o.show() : o.hide());
          });
        },
        unmounted: (e) => {
          let n;
          (n = e.watchStopHandle) == null || n.call(e);
        },
      });
    },
  };
}
function Bl() {
  return {
    install(t) {
      const e = oo();
      t.directive("motion", {
        name: "v-motion",
        mounted(n, s, r, o) {
          let w, b, S;
          const i = Ye(s, Vt),
            a = Ye(s, $n),
            l = Ye(s, Ln),
            { currentPage: c, clicks: u, isPrintMode: h } = Ze(),
            p = (r.props = { ...r.props }),
            f = { ...p.initial, ...((w = p.variants) == null ? void 0 : w["slidev-initial"]) },
            d = { ...p.enter, ...((b = p.variants) == null ? void 0 : b["slidev-enter"]) },
            g = { ...p.leave, ...((S = p.variants) == null ? void 0 : S["slidev-leave"]) };
          delete p.initial, delete p.enter, delete p.leave;
          const m = `${xn()}-`,
            v = [];
          for (const T of Object.keys(p))
            if (T.startsWith("click-")) {
              const O = T.slice(6),
                P = O.includes("-") ? O.split("-").map(Number) : +O,
                z = m + O;
              v.push({
                id: z,
                at: P,
                variant: { ...p[T] },
                info: i == null ? void 0 : i.value.calculate(P),
              }),
                delete p[T];
            }
          v.sort(
            (T, O) =>
              (Array.isArray(T.at) ? T.at[0] : T.at) - (Array.isArray(O.at) ? O.at[0] : O.at)
          ),
            e.created(n, s, r, o),
            e.mounted(n, s, r, o);
          const y = n.motionInstance;
          (y.clickIds = v.map((T) => T.id)),
            y.set(f),
            (y.watchStopHandle = ee(
              [a, c, u].filter(Boolean),
              () => {
                let O;
                const T = ((O = wr.get(n)) == null ? void 0 : O.visibilityState.value) ?? "shown";
                if (
                  !(i != null && i.value) ||
                  !["slide", "presenter"].includes((l == null ? void 0 : l.value) ?? "")
                ) {
                  const P = { ...f, ...d };
                  for (const { variant: z } of v) Object.assign(P, z);
                  y.set(P);
                } else if (h.value || (a == null ? void 0 : a.value) === c.value)
                  if (T === "shown") {
                    const P = { ...f, ...d };
                    for (const { variant: z, info: ne } of v)
                      (!ne || ne.isActive.value) && Object.assign(P, z);
                    h.value ? y.set(P) : y.apply(P);
                  } else y.apply(T === "before" ? f : g);
                else y.apply(((a == null ? void 0 : a.value) ?? -1) > c.value ? f : g);
              },
              { immediate: !0 }
            ));
        },
        unmounted(n) {
          n.motionInstance.watchStopHandle();
        },
      });
    },
  };
}
const Jl = [];
function Ul() {
  const t = [];
  function e(n) {
    if (!F.remote || F.remote === n.query.password) return !0;
    if (F.remote && n.query.password === void 0) {
      const s = prompt("Enter password");
      if (F.remote === s) return !0;
    }
    return n.params.no ? { path: `/${n.params.no}` } : { path: "" };
  }
  return (
    t.push(
      {
        name: "entry",
        path: "/entry",
        component: () =>
          $(() => import("./slidev/entry-xwAQwhc4.js"), __vite__mapDeps([32, 1, 4, 5, 33])),
        beforeEnter: e,
      },
      {
        name: "overview",
        path: "/overview",
        component: () =>
          $(
            () => import("./slidev/overview-DErbmAdv.js"),
            __vite__mapDeps([34, 12, 1, 35, 36, 37, 38, 39, 40, 4, 5])
          ),
        beforeEnter: e,
      },
      {
        name: "notes",
        path: "/notes",
        component: () =>
          $(() => import("./slidev/notes-CkF9nP1H.js"), __vite__mapDeps([41, 1, 35, 36, 39, 4, 5])),
        beforeEnter: e,
      },
      {
        name: "presenter",
        path: "/presenter/:no",
        component: () =>
          $(
            () => import("./slidev/presenter-DmWlCvc4.js"),
            __vite__mapDeps([42, 1, 37, 38, 43, 3, 12, 39, 4, 5, 44, 35, 36, 45, 46, 40, 47])
          ),
        beforeEnter: e,
      },
      { path: "/presenter", redirect: { path: "/presenter/1" } }
    ),
    t.push(
      {
        name: "play",
        path: "/:no",
        component: () =>
          $(
            () => import("./slidev/play-Cfb_UOn_.js"),
            __vite__mapDeps([48, 1, 37, 38, 43, 3, 12, 39, 4, 5, 44, 49])
          ),
      },
      { path: "", redirect: { path: "/1" } },
      {
        path: "/:pathMatch(.*)*",
        name: "NotFound",
        component: () =>
          $(() => import("./slidev/404-ibDRAdSv.js"), __vite__mapDeps([50, 1, 4, 5, 51])),
      }
    ),
    Jl.reduce((n, s) => s(n), t)
  );
}
async function Kl(t) {
  function e() {
    document.documentElement.style.setProperty("--vh", `${window.innerHeight * 0.01}px`);
  }
  e(), window.addEventListener("resize", e);
  const n = io({ history: ao("/talks/when-the-agent-is-wrong/"), routes: Ul() });
  t.use(n),
    t.use(el()),
    t.use(tl()),
    t.use(Wl()),
    t.use(ol()),
    t.use(Bl()),
    t.use(co, { container: "#twoslash-container" });
  const s = { app: t, router: n };
  for (const r of Ya) await r(s);
}
async function Gl() {
  const t = lo(Qa);
  await Kl(t), t.mount("#app");
}
Gl();
export {
  ac as $,
  Ln as A,
  tc as B,
  st as C,
  Zs as D,
  Qi as E,
  ta as F,
  Xi as G,
  nc as H,
  Yi as I,
  _s as J,
  sr as K,
  ca as L,
  hc as M,
  dc as N,
  uc as O,
  cc as P,
  xn as Q,
  Xl as R,
  mn as S,
  Mc as T,
  Tc as U,
  ec as V,
  mt as W,
  It as X,
  mr as Y,
  Bn as Z,
  $ as _,
  Mt as a,
  la as a0,
  oc as a1,
  rc as a2,
  ia as a3,
  mc as a4,
  sc as a5,
  Vs as a6,
  yo as a7,
  aa as a8,
  qs as a9,
  re as aa,
  Qt as ab,
  Ac as ac,
  yt as ad,
  fo as ae,
  _c as af,
  bc as ag,
  vc as ah,
  Sc as ai,
  qo as aj,
  Ze as ak,
  nl as al,
  ha as am,
  yn as an,
  pc as ao,
  Ct as ap,
  Go as b,
  gt as c,
  Xs as d,
  lc as e,
  hn as f,
  F as g,
  Qs as h,
  Jo as i,
  yr as j,
  kc as k,
  te as l,
  ic as m,
  $c as n,
  Oc as o,
  fc as p,
  qt as q,
  Ec as r,
  Je as s,
  yc as t,
  gc as u,
  Pn as v,
  wc as w,
  Vt as x,
  $n as y,
  Zi as z,
};
