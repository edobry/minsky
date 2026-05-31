import {
  Y as a,
  g as l,
  aL as n,
  f as e,
  M as p,
  s as u,
  af as r,
} from "./modules/vue-D4u9h7Td.js";
import { I as i } from "./slidev/default-Cw5Kcts5.js";
import { u as m, f as c } from "./slidev/context-eddjAoUW.js";
import "./index-Bjqpo1hl.js";
import "./modules/shiki-CBR8dv5M.js";
const B = {
  __name: "slides.md__slidev_7",
  setup(f) {
    const { $clicksContext: s, $frontmatter: o } = m();
    return (
      s.setup(),
      (d, t) => (
        a(),
        l(
          i,
          p(u(r(c)(r(o), 6))),
          {
            default: n(() => [
              ...(t[0] ||
                (t[0] = [
                  e("p", null, [e("span", { class: "eyebrow" }, "Predictable failure")], -1),
                  e("h2", null, "Runtime error on a nonexistent export", -1),
                  e("p", null, "Barrel files mask import errors until runtime.", -1),
                  e(
                    "p",
                    null,
                    "The re-export layer decouples the consumer’s type-check from the source module’s actual exports.",
                    -1
                  ),
                  e(
                    "p",
                    { class: "error text-sm mt-6" },
                    "Exactly the class of bug the literature predicts.",
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
export { B as default };
