/**
 * Shared parameters for config commands
 */

import { CommonParameters, ConfigParameters, composeParams } from "../../common-parameters";

/**
 * Shared parameters for config commands (eliminates duplication)
 */
export const configCommandParams = composeParams(
  {
    repo: CommonParameters.repo,
    workspace: CommonParameters.workspace,
    json: CommonParameters.json,
  },
  {
    sources: ConfigParameters.sources,
  }
);
