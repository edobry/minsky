import {
  p as f,
  ax as m,
  i as _,
  f as o,
  l as a,
  aa as r,
  af as x,
  g as u,
  aL as i,
  h as c,
  d as v,
  a4 as g,
  Y as n,
} from "../modules/vue-D4u9h7Td.js";
import { ak as k, b as h } from "../index-Bjqpo1hl.js";
import "../modules/shiki-CBR8dv5M.js";
const N = { class: "grid justify-center text-center pt-15% gap-5" },
  y = { class: "text-2xl" },
  B = { class: "op-60" },
  C = { class: "mt-3 flex flex-col gap-2 max-w-xs mx-auto w-full" },
  R = f({
    __name: "404",
    setup(w) {
      const { currentRoute: l } = m(),
        { total: p } = k(),
        s = v(() => {
          const t = l.value.path.match(/\d+/);
          if (t) {
            const e = +t[0];
            if (e > 0 && e <= p.value) return e;
          }
          return null;
        });
      return (d, t) => {
        const e = g("RouterLink");
        return (
          n(),
          _("div", N, [
            o("div", null, [
              t[2] || (t[2] = o("h1", { class: "text-9xl font-light" }, " 404 ", -1)),
              o("p", y, [
                t[0] || (t[0] = a(" Page ", -1)),
                o("code", B, r(x(l).path), 1),
                t[1] || (t[1] = a(" not found ", -1)),
              ]),
            ]),
            o("div", C, [
              s.value !== 1
                ? (n(),
                  u(
                    e,
                    { key: 0, to: "/", class: "page-link" },
                    { default: i(() => [...(t[3] || (t[3] = [a(" Go Home ", -1)]))]), _: 1 }
                  ))
                : c("v-if", !0),
              s.value
                ? (n(),
                  u(
                    e,
                    { key: 1, to: `/${s.value}`, class: "page-link" },
                    { default: i(() => [a(` Go to Slide ${r(s.value)}`, 1)]), _: 1 },
                    8,
                    ["to"]
                  ))
                : c("v-if", !0),
            ]),
          ])
        );
      };
    },
  }),
  G = h(R, [["__scopeId", "data-v-2af184e6"]]);
export { G as default };
