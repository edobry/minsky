/**
 * ESLint plugin for Minsky project custom rules
 */

import noRealFsInTests from "./eslint-rules/no-real-fs-in-tests.js";

export default {
  rules: {
    "no-real-fs-in-tests": noRealFsInTests,
  },
  configs: {
    recommended: {
      plugins: ["minsky"],
      rules: {
        "minsky/no-real-fs-in-tests": "error",
      },
    },
  },
};
