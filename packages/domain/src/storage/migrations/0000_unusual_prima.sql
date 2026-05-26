CREATE TABLE `sessions` (
	`session` text PRIMARY KEY NOT NULL,
	`repoName` text NOT NULL,
	`repoUrl` text,
	`createdAt` text NOT NULL,
	`taskId` text,
	`repoPath` text,
	`prBranch` text,
	`prApproved` text,
	`prState` text,
	`backendType` text,
	`pullRequest` text
);
