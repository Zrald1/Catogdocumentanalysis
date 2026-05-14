export const LOCAL_VISION_MODEL_SUGGESTIONS = [
  'bartowski/google_gemma-3-4b-it-GGUF:Q4_K_M',
  'gemma-3-12b-it',
  'gemma-3-27b-it',
  'llava-v1.6-34b',
  'qwen2.5-vl-7b-instruct',
  'qwen2.5-vl-3b-instruct',
  'internvl2.5-8b',
];

export const GEMINI_MODEL_SUGGESTIONS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite-preview-02-05',
  'gemini-2.0-pro-experimental-02-05',
  'gemini-1.5-flash',
  'gemini-1.5-flash-001',
  'gemini-1.5-flash-002',
  'gemini-1.5-flash-8b',
  'gemini-1.5-flash-8b-001',
  'gemini-1.5-pro',
  'gemini-1.5-pro-001',
  'gemini-1.5-pro-002',
  'gemini-1.0-pro',
  'gemini-1.0-pro-001',
  'gemini-2.0-flash-exp',
  'gemini-exp-1206',
  'gemini-exp-1121',
  'gemini-exp-1114',
  'learnlm-1.5-pro-experimental',
];

export const GEMINI_VISION_MODEL_SUGGESTIONS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash-8b',
];

export const VISION_MODEL_SUGGESTIONS = [
  ...GEMINI_VISION_MODEL_SUGGESTIONS,
  ...LOCAL_VISION_MODEL_SUGGESTIONS,
];

export const DOCUMENT_DETECTOR_SUGGESTIONS = [
  'Armaggheddon/yolo11-document-layout',
  'opencv-document-quad',
  'doclayout-yolo',
  'yolov8-document-detector',
  'layoutlmv3',
  'detectron2-document-layout',
];

export const OCR_MODEL_SUGGESTIONS = [
  'surya',
  'paddleocr',
  'tesseract-5',
  'got-ocr-2.0',
];
