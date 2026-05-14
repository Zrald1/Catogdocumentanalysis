export const DEFAULT_GEMINI_PROVIDER_URL = 'https://generativelanguage.googleapis.com/v1beta';

type GeminiModelsResponse = {
  models?: Array<{
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
  }>;
};

const normalizeProviderUrl = (providerUrl: string) => providerUrl.replace(/\/+$/, '');

export const verifyGeminiConfiguration = async (apiKey: string, providerUrl?: string) => {
  const resolvedProviderUrl = providerUrl?.trim() || DEFAULT_GEMINI_PROVIDER_URL;
  if (!apiKey.trim()) {
    throw new Error('A Gemini API key is required before models can be loaded.');
  }

  const response = await fetch(`${normalizeProviderUrl(resolvedProviderUrl)}/models?key=${encodeURIComponent(apiKey.trim())}`);
  const responseText = await response.text();
  
  let payload: any;
  try {
    payload = JSON.parse(responseText);
  } catch (e) {
    if (responseText.trim().startsWith('<!doctype') || responseText.trim().startsWith('<html')) {
      throw new Error(`The Gemini endpoint returned an HTML page instead of JSON. Please check if your Provider URL (${resolvedProviderUrl}) is correct and ends with /v1beta or /v1.`);
    }
    throw new Error('The Gemini endpoint returned an invalid response. Please check your network connection and API key.');
  }

  if (!response.ok) {
    throw new Error(payload.error?.message || 'Gemini model discovery failed.');
  }

  const models = (payload.models || [])
    .map((model) => model.name?.replace(/^models\//, '') || '')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  if (models.length === 0) {
    throw new Error('No Gemini models were returned for this API key.');
  }

  return {
    models,
    message: `Verified Gemini access. ${models.length} model(s) available.`,
  };
};
