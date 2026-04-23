import { defineSkill } from "../../../src/domain/definitions/factories";

export default defineSkill({
  name: "fixture",
  description:
    "Fixture skill for end-to-end testing of the compile pipeline. Not for production use.",
  content: "# Fixture Skill\n\nThis is a fixture skill used to verify the compile pipeline.\n",
});
