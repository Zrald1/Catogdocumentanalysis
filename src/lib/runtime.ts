export const getGeminiApiKey = (preferredKey?: string) => {
  const trimmedPreferredKey = preferredKey?.trim();
  if (trimmedPreferredKey) {
    return trimmedPreferredKey;
  }

  return import.meta.env.VITE_GEMINI_API_KEY?.trim()
    || import.meta.env.GEMINI_API_KEY?.trim()
    || '';
};
