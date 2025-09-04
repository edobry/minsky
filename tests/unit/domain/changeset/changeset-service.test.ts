/**
 * Changeset Service Tests
 *
 * Tests for the unified changeset abstraction layer.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { ChangesetService } from "../../../../src/domain/changeset/changeset-service";
import type {
  ChangesetAdapter,
  ChangesetAdapterFactory,
} from "../../../../src/domain/changeset/adapter-interface";
import type {
  Changeset,
  ChangesetPlatform,
  CreateChangesetOptions,
} from "../../../../src/domain/changeset/types";

describe("ChangesetService", () => {
  let mockAdapter: ChangesetAdapter;
  let mockFactory: ChangesetAdapterFactory;
  let service: ChangesetService;

  beforeEach(() => {
    // Create mock adapter
    mockAdapter = {
      platform: "github-pr",
      name: "Test GitHub Adapter",
      isAvailable: mock(() => Promise.resolve(true)),
      list: mock(() => Promise.resolve([])),
      get: mock(() => Promise.resolve(null)),
      search: mock(() => Promise.resolve([])),
      create: mock(() =>
        Promise.resolve({
          changeset: createMockChangeset(),
          platformId: "123",
          url: "https://github.com/test/repo/pull/123",
        })
      ),
      update: mock(() => Promise.resolve(createMockChangeset())),
      merge: mock(() =>
        Promise.resolve({
          success: true,
          mergeCommitSha: "abc123",
          mergedAt: new Date(),
          mergedBy: "testuser",
        })
      ),
      getDetails: mock(() =>
        Promise.resolve({
          ...createMockChangeset(),
          files: [],
          diffStats: { filesChanged: 1, additions: 10, deletions: 5 },
        })
      ),
      supportsFeature: mock(() => true),
    };

    // Create mock factory
    mockFactory = {
      platform: "github-pr",
      canHandle: mock(() => true),
      createAdapter: mock(() => Promise.resolve(mockAdapter)),
    };

    // Create service instance
    service = new ChangesetService("https://github.com/test/repo.git");
    service.registerAdapterFactory(mockFactory);
  });

  test("registers adapter factory correctly", () => {
    expect(mockFactory.canHandle).toBeDefined();
    expect(mockFactory.createAdapter).toBeDefined();
  });

  test("detects platform from repository URL", async () => {
    const githubService = new ChangesetService("https://github.com/test/repo.git");
    githubService.registerAdapterFactory(mockFactory);

    await githubService.list(); // Trigger adapter creation
    expect(mockFactory.createAdapter).toHaveBeenCalled();
  });

  test("lists changesets through adapter", async () => {
    const mockChangesets = [createMockChangeset()];
    mockAdapter.list = mock(() => Promise.resolve(mockChangesets));

    const result = await service.list();

    expect(mockAdapter.list).toHaveBeenCalled();
    expect(result).toEqual(mockChangesets);
  });

  test("searches changesets with query", async () => {
    const mockChangesets = [createMockChangeset()];
    mockAdapter.search = mock(() => Promise.resolve(mockChangesets));

    const result = await service.search({
      query: "test search",
      searchTitle: true,
    });

    expect(mockAdapter.search).toHaveBeenCalledWith({
      query: "test search",
      searchTitle: true,
    });
    expect(result).toEqual(mockChangesets);
  });

  test("gets specific changeset by id", async () => {
    const mockChangeset = createMockChangeset();
    mockAdapter.get = mock(() => Promise.resolve(mockChangeset));

    const result = await service.get("123");

    expect(mockAdapter.get).toHaveBeenCalledWith("123");
    expect(result).toEqual(mockChangeset);
  });

  test("creates changeset through adapter", async () => {
    const createOptions: CreateChangesetOptions = {
      title: "Test PR",
      description: "Test description",
      targetBranch: "main",
      sourceBranch: "feature-branch",
    };

    const result = await service.create(createOptions);

    expect(mockAdapter.create).toHaveBeenCalledWith(createOptions);
    expect(result.changeset).toBeDefined();
    expect(result.platformId).toBe("123");
  });

  test("merges changeset through adapter", async () => {
    const result = await service.merge("123");

    expect(mockAdapter.merge).toHaveBeenCalledWith("123", undefined);
    expect(result.success).toBe(true);
    expect(result.mergeCommitSha).toBe("abc123");
  });

  test("handles approval when adapter supports it", async () => {
    mockAdapter.approve = mock(() =>
      Promise.resolve({
        success: true,
        reviewId: "review-123",
      })
    );

    const result = await service.approve("123", "LGTM");

    expect(mockAdapter.approve).toHaveBeenCalledWith("123", "LGTM");
    expect(result?.success).toBe(true);
    expect(result?.reviewId).toBe("review-123");
  });

  test("returns null for approval when adapter does not support it", async () => {
    mockAdapter.approve = undefined;

    const result = await service.approve("123");

    expect(result).toBeNull();
  });

  test("gets detailed changeset information", async () => {
    const result = await service.getDetails("123");

    expect(mockAdapter.getDetails).toHaveBeenCalledWith("123");
    expect(result.diffStats).toBeDefined();
    expect(result.files).toBeDefined();
  });

  test("checks feature support through adapter", async () => {
    const result = await service.supportsFeature("approval_workflow");

    expect(mockAdapter.supportsFeature).toHaveBeenCalledWith("approval_workflow");
    expect(result).toBe(true);
  });

  test("gets changeset URL from metadata", async () => {
    const mockChangeset = createMockChangeset();
    mockChangeset.metadata.github = {
      number: 123,
      url: "https://api.github.com/repos/test/repo/pulls/123",
      htmlUrl: "https://github.com/test/repo/pull/123",
      apiUrl: "https://api.github.com/repos/test/repo/pulls/123",
      isDraft: false,
      isMergeable: true,
      mergeableState: "clean",
      headSha: "abc123",
      baseSha: "def456",
    };

    mockAdapter.get = mock(() => Promise.resolve(mockChangeset));

    const url = await service.getChangesetUrl("123");

    expect(url).toBe("https://github.com/test/repo/pull/123");
  });

  test("throws error when adapter is not available", async () => {
    mockAdapter.isAvailable = mock(() => Promise.resolve(false));

    expect(async () => {
      await service.list();
    }).toThrow(/not available/);
  });

  test("throws error when no adapter factory is registered", () => {
    const serviceWithoutAdapter = new ChangesetService("https://unknown-platform.com/repo.git");

    expect(async () => {
      await serviceWithoutAdapter.list();
    }).toThrow(/No changeset adapter factory registered/);
  });
});

/**
 * Create a mock changeset for testing
 */
function createMockChangeset(): Changeset {
  return {
    id: "123",
    platform: "github-pr",
    title: "Test Changeset",
    description: "Test description",
    author: {
      username: "testuser",
      email: "test@example.com",
    },
    status: "open",
    targetBranch: "main",
    sourceBranch: "feature-branch",
    commits: [
      {
        sha: "abc123",
        message: "Test commit",
        author: {
          username: "testuser",
          email: "test@example.com",
        },
        timestamp: new Date("2024-01-01"),
        filesChanged: ["src/test.ts"],
      },
    ],
    reviews: [],
    comments: [],
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    metadata: {
      github: {
        number: 123,
        url: "https://api.github.com/repos/test/repo/pulls/123",
        htmlUrl: "https://github.com/test/repo/pull/123",
        apiUrl: "https://api.github.com/repos/test/repo/pulls/123",
        isDraft: false,
        isMergeable: true,
        mergeableState: "clean",
        headSha: "abc123",
        baseSha: "def456",
      },
    },
  };
}
