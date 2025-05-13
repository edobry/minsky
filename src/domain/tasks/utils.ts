export function normalizeTaskId(userInput: string): string | null {
  if (!userInput || typeof userInput !== 'string') {
    return null;
  }

  let normalizedInput = userInput.trim();

  // Handle formats like "task#064" or "task#64"
  if (normalizedInput.toLowerCase().startsWith('task#')) {
    normalizedInput = normalizedInput.substring(5);
  }

  // Handle formats like "#064" or "#64"
  if (normalizedInput.startsWith('#')) {
    normalizedInput = normalizedInput.substring(1);
  }

  // Check if the result is a valid number (integer)
  if (!/^[0-9]+$/.test(normalizedInput)) {
    return null;
  }

  // At this point, normalizedInput is a string of digits, e.g., "064" or "64"
  // The system seems to expect the number, possibly with leading zeros if provided.
  // No further normalization like stripping leading zeros unless specified.
  return normalizedInput;
} 
