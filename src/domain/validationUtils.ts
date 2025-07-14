export const validateSingleLineDescription = {
  isValid: (value?: string): boolean => {
    // Returns true if valid (no newlines or undefined/empty), false otherwise.
    if (value === undefined || value === null) return true; // Allow empty/undefined descriptions
    return !(value as unknown).includes("\n");
  },

  errorMessage: "Rule description must be a single line and cannot contain newline characters.",

  forPrompt: (value?: string): string | undefined => {
    if (value && (value as unknown).includes("\n")) {
      return (validateSingleLineDescription as unknown).errorMessage;
    }
    return undefined;
  },
};
