import {
  Y as i,
  g as o,
  aL as l,
  f as e,
  l as t,
  M as m,
  s as p,
  af as a,
} from "./modules/vue-D4u9h7Td.js";
import { I as c } from "./slidev/default-Cw5Kcts5.js";
import { u, f as d } from "./slidev/context-eddjAoUW.js";
import "./index-Bjqpo1hl.js";
import "./modules/shiki-CBR8dv5M.js";
const R = {
  __name: "slides.md__slidev_18",
  setup(f) {
    const { $clicksContext: r, $frontmatter: n } = u();
    return (
      r.setup(),
      (_, s) => (
        i(),
        o(
          c,
          m(p(a(d)(a(n), 17))),
          {
            default: l(() => [
              ...(s[0] ||
                (s[0] = [
                  e("p", null, [e("span", { class: "eyebrow" }, "Organ 2")], -1),
                  e("h2", null, "Tiered escalation", -1),
                  e(
                    "div",
                    { class: "tier-ladder" },
                    [
                      e("div", { class: "tier-item" }, [
                        e("span", { class: "tier-num" }, "R1"),
                        e("span", null, "Memory entry"),
                      ]),
                      e("div", { class: "tier-item" }, [
                        e("span", { class: "tier-num" }, "R2"),
                        e("span", null, "Corpus rule update"),
                      ]),
                      e("div", { class: "tier-item" }, [
                        e("span", { class: "tier-num" }, "R3-5"),
                        e("span", null, "Hook (UserPromptSubmit scanner)"),
                      ]),
                      e("div", { class: "tier-item active" }, [
                        e("span", { class: "tier-num" }, "R6"),
                        e("span", null, "Hook pattern extension + implementation gate"),
                      ]),
                    ],
                    -1
                  ),
                  e(
                    "p",
                    { class: "dim text-xs mt-6" },
                    [
                      t("Each tier is harder to bypass than the last."),
                      e("br"),
                      t("Enforcement improves monotonically with recurrence."),
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
export { R as default };
