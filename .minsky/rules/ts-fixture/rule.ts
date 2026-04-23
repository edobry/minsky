import { defineRule } from "../../../src/domain/definitions/factories";

export default defineRule({
  name: "ts-fixture",
  description: "Fixture rule for the cursor-rules-ts compile target.",
  alwaysApply: false,
  tags: ["testing"],
  content: "# TS Fixture Rule\n\nThis rule exists solely as a compile-target fixture.\n",
});
