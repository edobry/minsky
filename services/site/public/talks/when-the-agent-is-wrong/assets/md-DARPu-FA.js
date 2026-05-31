import {
  Y as n,
  g as l,
  aL as i,
  f as e,
  l as t,
  M as m,
  s as p,
  af as a,
} from "./modules/vue-D4u9h7Td.js";
import { I as c } from "./slidev/default-Cw5Kcts5.js";
import { u as d, f as u } from "./slidev/context-eddjAoUW.js";
import "./index-Bjqpo1hl.js";
import "./modules/shiki-CBR8dv5M.js";
const x = {
  __name: "slides.md__slidev_22",
  setup(h) {
    const { $clicksContext: o, $frontmatter: r } = d();
    return (
      o.setup(),
      (f, s) => (
        n(),
        l(
          c,
          m(p(a(u)(a(r), 21))),
          {
            default: i(() => [
              ...(s[0] ||
                (s[0] = [
                  e("p", null, [e("span", { class: "eyebrow" }, "Thesis")], -1),
                  e("h2", null, "Infrastructure, not capability", -1),
                  e(
                    "p",
                    null,
                    [
                      t("The model doesn’t need to be better at self-monitoring."),
                      e("br"),
                      t(" The "),
                      e("span", { class: "highlight" }, "environment"),
                      t(" monitors it."),
                    ],
                    -1
                  ),
                  e(
                    "div",
                    { class: "mt-6" },
                    [
                      e("p", null, [
                        t("The model doesn’t need to remember its prior failures."),
                        e("br"),
                        t(" The "),
                        e("span", { class: "highlight" }, "memory system"),
                        t(" remembers."),
                      ]),
                    ],
                    -1
                  ),
                  e(
                    "div",
                    { class: "mt-6" },
                    [
                      e("p", null, [
                        t("The model doesn’t need to escalate its own enforcement."),
                        e("br"),
                        t(" The "),
                        e("span", { class: "highlight" }, "tiered system"),
                        t(" escalates automatically."),
                      ]),
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
export { x as default };
