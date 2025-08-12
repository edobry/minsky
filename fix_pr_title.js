const {
  createRepositoryBackendFromSession,
} = require("./src/domain/session/session-pr-operations.js");
const { createSessionProvider } = require("./src/domain/session/index.js");

async function fixPrTitle() {
  const sessionProvider = createSessionProvider();
  const sessionRecord = await sessionProvider.getSession("task-md#1");

  if (!sessionRecord) {
    console.log("Session not found");
    return;
  }

  const repositoryBackend = await createRepositoryBackendFromSession(sessionRecord);

  // Update PR #76 title
  const result = await repositoryBackend.updatePullRequest({
    prIdentifier: 76,
    title: "feat(md#1): Test draft PR feature",
  });

  console.log("PR updated:", result);
}

fixPrTitle().catch(console.error);
