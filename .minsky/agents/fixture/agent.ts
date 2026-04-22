import { defineAgent } from "../../../src/domain/definitions/factories";

export default defineAgent({
  name: "fixture",
  description:
    "Fixture agent for end-to-end testing of the compile pipeline. Not for production use.",
  model: "sonnet",
  tools: ["Read", "Bash"],
  prompt: "# Fixture Agent\n\nThis is a fixture agent used to verify the compile pipeline.\n",
});
