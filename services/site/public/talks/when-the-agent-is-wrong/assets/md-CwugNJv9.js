import {
  Y as n,
  i as c,
  a3 as l,
  g as m,
  aL as d,
  f as e,
  l as a,
  M as p,
  s as _,
  af as o,
} from "./modules/vue-D4u9h7Td.js";
import { _ as u } from "./minsky-icon-CaXDhekZ.js";
import { b as f } from "./index-Bjqpo1hl.js";
import { u as x, f as g } from "./slidev/context-eddjAoUW.js";
import "./modules/shiki-CBR8dv5M.js";
const h = {},
  v = { class: "slidev-layout cover" };
function y(t, s) {
  return n(), c("div", v, [l(t.$slots, "default")]);
}
const k = f(h, [["render", y]]),
  P = {
    __name: "slides.md__slidev_1",
    setup(t) {
      const { $clicksContext: s, $frontmatter: i } = x();
      return (
        s.setup(),
        (b, r) => (
          n(),
          m(
            k,
            p(_(o(g)(o(i), 0))),
            {
              default: d(() => [
                ...(r[0] ||
                  (r[0] = [
                    e(
                      "div",
                      { class: "center-slide" },
                      [
                        e("img", {
                          src: u,
                          alt: "Minsky",
                          style: { width: "140px", height: "140px", "margin-bottom": "1.5em" },
                        }),
                        e("p", null, [e("span", { class: "eyebrow" }, "Case study")]),
                        e("h1", null, [a("When the Agent"), e("br"), a("is Wrong")]),
                        e(
                          "p",
                          { class: "dim mt-12 text-sm" },
                          "Metacognitive infrastructure in practice"
                        ),
                      ],
                      -1
                    ),
                  ])),
              ]),
              _: 1,
            },
            16
          )
        )
      );
    },
  };
export { P as default };
