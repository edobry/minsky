    test("should handle file processing errors gracefully", () => {
      const results = fixSessionApproveLogMocks(["/tmp/nonexistent-test-file.ts"]);

      expect(results.length).toBe(1);
      expect(results[0].changed).toBe(false);
    }); 
