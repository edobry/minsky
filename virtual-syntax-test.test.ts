
const mockLog = {
  info: vi.fn(),
  error: vi.fn(),
  cli: vi.fn()
};
        
describe("Session Approve", () => {
  test("should approve", () => {
    mockLog.info("test");
  });
});
      