import { invoke, isTauri } from '@tauri-apps/api/core';
import { GoogleGenAI } from '@google/genai';
import { AppConfig, MessageCitation } from '../types';
import { getGeminiApiKey } from '../lib/runtime';
import { writeSystemLog } from '../lib/systemLogger';

const VISION_TEMPERATURE = 0;

type VisionModelResponse = {
  detectedTitle: string;
  documentType: string;
  summary: string;
  transcribedText: string;
  citations: Array<{
    label: string;
    excerpt: string;
  }>;
  suggestedFileName: string;
};

export interface VisionCaptureResult {
  suggestedFileName: string;
  synthesizedContent: string;
  summary: string;
  citations: MessageCitation[];
}

const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = reader.result;
    if (typeof result !== 'string') {
      reject(new Error('Vision upload could not be converted into base64.'));
      return;
    }
    resolve(result.split(',')[1] || '');
  };
  reader.onerror = () => reject(reader.error || new Error('Vision upload could not be read.'));
  reader.readAsDataURL(file);
});

const sanitizeFileName = (value: string, fallback: string) => {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
};

const buildVisionPrompt = (fileName: string) => `You are CATOG Vision Intake.
Review the attached image of a paper or project document and respond with strict JSON.

Requirements:
- Identify what document or paper the user is holding.
- Transcribe the most important visible text.
- Summarize the paper in a concise factual way.
- Produce citations using exact visible text only.
- If any field is uncertain, say "Insufficient visual evidence".

Return JSON with this exact shape:
{
  "detectedTitle": "string",
  "documentType": "string",
  "summary": "string",
  "transcribedText": "string",
  "citations": [
    { "label": "string", "excerpt": "string" }
  ],
  "suggestedFileName": "string"
}

Original image name: ${fileName}`;

const parseVisionResponse = (text: string): VisionModelResponse => {
  const normalized = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const jsonText = normalized.startsWith('{')
    ? normalized
    : normalized.slice(normalized.indexOf('{'), normalized.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonText) as Partial<VisionModelResponse>;
  return {
    detectedTitle: parsed.detectedTitle?.trim() || 'Insufficient visual evidence',
    documentType: parsed.documentType?.trim() || 'Insufficient visual evidence',
    summary: parsed.summary?.trim() || 'Insufficient visual evidence',
    transcribedText: parsed.transcribedText?.trim() || 'Insufficient visual evidence',
    citations: Array.isArray(parsed.citations)
      ? parsed.citations
        .filter((citation): citation is { label: string; excerpt: string } => Boolean(citation?.label && citation?.excerpt))
        .slice(0, 6)
      : [],
    suggestedFileName: parsed.suggestedFileName?.trim() || '',
  };
};

export const analyzeVisionCapture = async (
  file: File,
  config: AppConfig,
): Promise<VisionCaptureResult> => {
  const visionApiKey = config.vision.apiKey?.trim();
  const coreApiKey = config.agents.core.apiKey;
  const apiKey = getGeminiApiKey(visionApiKey || coreApiKey);
  
  if (!apiKey) {
    throw new Error('Vision intake needs Gemini credentials. Please provide a Vision API key or Core Agent key in Configuration.');
  }

  const base64Data = await fileToBase64(file);
  const prompt = buildVisionPrompt(file.name);
  const mimeType = file.type || 'image/jpeg';
  let parsed: VisionModelResponse;

  try {
    let responseText = '';
    const activeModel = config.vision.model || config.agents.core.model || 'gemini-2.0-flash';
    
    void writeSystemLog({
      scope: 'vision.intake',
      event: 'vision-analysis-start',
      message: `Starting vision analysis for ${file.name} using model ${activeModel}.`,
      details: { model: activeModel, authMode: 'api-key', fileName: file.name, fileSize: file.size }
    });

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: activeModel,
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          },
        ],
      }],
      config: {
        responseMimeType: 'application/json',
        temperature: VISION_TEMPERATURE,
      },
    });
    responseText = response.text || '';

    parsed = parseVisionResponse(responseText);
    const insufficientVision = [
      parsed.summary,
      parsed.transcribedText,
      parsed.detectedTitle,
    ].every((value) => /insufficient visual evidence/i.test(value));

    if (insufficientVision) {
      throw new Error('Vision output did not contain enough readable document detail.');
    }
    
    void writeSystemLog({
      scope: 'vision.intake',
      event: 'analysis-complete',
      message: `Vision analysis complete for ${file.name}.`,
    });

  } catch (error) {
    const message = error instanceof Error 
      ? error.message 
      : (typeof error === 'string' ? error : JSON.stringify(error));

    void writeSystemLog({
      scope: 'vision.intake',
      event: 'analysis-error',
      level: 'error',
      message: `Vision analysis failed: ${message}`,
      details: { error: message }
    });

    if (message.includes('readable document detail')) {
      throw error;
    }
    throw new Error(`Vision intake failed: ${message || 'Unknown model error'}`);
  }

  const safeFileName = sanitizeFileName(
    parsed.suggestedFileName || `${file.name.replace(/\.[^.]+$/, '')} Vision Intake.md`,
    `${file.name.replace(/\.[^.]+$/, '')} Vision Intake.md`,
  );

  const synthesizedContent = [
    `Vision capture source: ${file.name}`,
    `Detected title: ${parsed.detectedTitle}`,
    `Document type: ${parsed.documentType}`,
    '',
    'Summary:',
    parsed.summary,
    '',
    'Transcribed text:',
    parsed.transcribedText,
    '',
    'Citations:',
    ...(parsed.citations.length > 0
      ? parsed.citations.map((citation) => `- ${citation.label}: ${citation.excerpt}`)
      : ['- Visual evidence was insufficient for exact citations.']),
  ].join('\n');

  return {
    suggestedFileName: safeFileName,
    synthesizedContent,
    summary: parsed.summary,
    citations: parsed.citations.map((citation) => ({
      label: citation.label,
      excerpt: citation.excerpt,
    })),
  };
};
