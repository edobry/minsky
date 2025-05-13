export const validateSingleLineDescription = {
  isValid: (value?: string): boolean => {
    // Returns true if valid (no newlines or undefined/empty), false otherwise.
    if (value === undefined || value === null) return true; // Allow empty/undefined descriptions
    return !value.includes("\n");
  },

  errorMessage: "Rule description must be a single line and cannot contain newline characters.",

  forPrompt: (value?: string): string | undefined => {
    if (value && value.includes("\n")) {
      return validateSingleLineDescription.errorMessage;
    }
    return undefined;
  },
}; 
