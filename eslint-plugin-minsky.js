/**
 * ESLint plugin for Minsky project custom rules
 */

import noRealFsInTests from "./eslint-rules/no-real-fs-in-tests.js";
import noUnwaitedAsyncFactory from "./eslint-rules/no-unwaited-async-factory.js";

export default {
  rules: {
    "no-real-fs-in-tests": noRealFsInTests,
    "no-unwaited-async-factory": noUnwaitedAsyncFactory,
  },
  configs: {
    recommended: {
      plugins: ["minsky"],
      rules: {
        "minsky/no-real-fs-in-tests": "error",
        "minsky/no-unwaited-async-factory": "error",
      },
    },
  },
};
