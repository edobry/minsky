#!/usr/bin/env node

/**
 * Simple test script for GitHub Issues Task Backend
 * Tests the GitHub backend functionality directly
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

async function testGitHubBackend() {
  console.log("🔍 Testing GitHub Issues Task Backend...\n");

  // Step 1: Check if .env file exists
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    console.log("❌ No .env file found. Please create one with:");
    console.log("   GITHUB_TOKEN=your_token_here");
    return;
  }

  // Step 2: Load environment variables
  const envContent = fs.readFileSync(envPath, "utf8");
  const envLines = envContent.split("\n");
  envLines.forEach((line) => {
    if (line.includes("=") && !line.startsWith("#")) {
      const [key, value] = line.split("=");
      process.env[key] = value;
    }
  });

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.log("❌ No GitHub token found in .env file");
    return;
  }

  console.log("✅ GitHub token found:", `${token.slice(0, 4)}***${token.slice(-4)}`);

  // Step 3: Get GitHub repository info
  try {
    const remoteUrl = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
    console.log("✅ Git remote URL:", remoteUrl);

    // Parse GitHub URL
    const match = remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)(?:\.git)?$/);
    if (!match) {
      console.log("❌ Not a GitHub repository");
      return;
    }

    const [, owner, repo] = match;
    console.log("✅ Repository:", `${owner}/${repo}`);

    // Step 4: Test GitHub API access
    const { Octokit } = require("@octokit/rest");
    const octokit = new Octokit({ auth: token });

    console.log("\n🔍 Testing GitHub API access...");

    try {
      // Test API access by getting repository info
      const { data: repoData } = await octokit.rest.repos.get({
        owner,
        repo,
      });

      console.log("✅ Repository access confirmed");
      console.log(`   - Name: ${repoData.name}`);
      console.log(`   - Private: ${repoData.private}`);
      console.log(`   - Issues: ${repoData.has_issues}`);

      // Test listing issues
      console.log("\n🔍 Testing issue listing...");
      const { data: issues } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: "all",
        per_page: 5,
      });

      console.log(`✅ Found ${issues.length} issues (showing first 5)`);
      issues.forEach((issue, index) => {
        const labels = issue.labels.map((l) => l.name).join(", ");
        console.log(`   ${index + 1}. #${issue.number}: ${issue.title}`);
        console.log(`      State: ${issue.state}, Labels: ${labels || "none"}`);
      });
    } catch (error) {
      console.log("❌ GitHub API error:", error.message);
      if (error.status === 401) {
        console.log("   → Check your token permissions");
      } else if (error.status === 404) {
        console.log("   → Repository not found or no access");
      }
    }
  } catch (error) {
    console.log("❌ Git error:", error.message);
  }

  console.log("\n🎉 Test complete!");
}

// Run the test
testGitHubBackend().catch(console.error);
