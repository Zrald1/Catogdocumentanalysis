import * as ort from 'onnxruntime-web';
import { writeSystemLog } from '../lib/systemLogger';

const MODEL_PATH = '/models/yolo11n_doc_layout.onnx';
const MODEL_SIZE = 1280;
const CLASS_COUNT = 11;
const SCORE_THRESHOLD = 0.1;
const NMS_THRESHOLD = 0.45;
const FEATURE_COUNT = CLASS_COUNT + 4;

export const CLASS_NAMES = [
  'Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer',
  'Page-header', 'Picture', 'Section-header', 'Table', 'Text', 'Title',
] as const;

export type ClassName = (typeof CLASS_NAMES)[number];

export interface NormalizedRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DetectedBox {
  region: NormalizedRegion;
  label: ClassName;
  score: number;
}

export interface DocumentLayoutDetection {
  region: NormalizedRegion;
  confidence: number;
  detectionCount: number;
  boxes: DetectedBox[];
  outputTensorShape: string;
}

type PreprocessResult = {
  tensor: ort.Tensor;
  scale: number;
  padX: number;
  padY: number;
  originalWidth: number;
  originalHeight: number;
};

type CandidateBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  score: number;
  classIndex: number;
};

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let sessionStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let sessionError: string | null = null;
let preprocessCanvas: HTMLCanvasElement | null = null;
let activeDetectionCount = 0;
const queuedSessionReleases = new Set<Promise<ort.InferenceSession>>();

export const getSessionStatus = () => ({ status: sessionStatus, error: sessionError });

const releaseSession = async (activePromise: Promise<ort.InferenceSession>) => {
  try {
    const session = await activePromise;
    const releasable = session as ort.InferenceSession & { release?: () => Promise<void> | void };
    await releasable.release?.();
  } catch {
    // Ignore teardown errors while resetting the detector.
  }
};

const flushQueuedSessionReleases = () => {
  if (activeDetectionCount > 0 || queuedSessionReleases.size === 0) {
    return;
  }

  const releases = Array.from(queuedSessionReleases);
  queuedSessionReleases.clear();
  releases.forEach((activePromise) => {
    void releaseSession(activePromise);
  });
};

export const disposeDocumentLayoutDetector = async () => {
  const activePromise = sessionPromise;
  sessionPromise = null;
  sessionStatus = 'idle';
  sessionError = null;

  void writeSystemLog({
    scope: 'vision.detector',
    event: 'disposal-requested',
    message: 'Requesting disposal of the YOLO document layout detector to free resources.',
    details: { hasActivePromise: !!activePromise, activeDetectionCount },
  });

  if (preprocessCanvas) {
    preprocessCanvas.width = 0;
    preprocessCanvas.height = 0;
    preprocessCanvas = null;
  }

  if (!activePromise) {
    return;
  }

  if (activeDetectionCount > 0) {
    queuedSessionReleases.add(activePromise);
    return;
  }

  await releaseSession(activePromise);
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const getSession = async () => {
  if (sessionPromise) {
    return sessionPromise;
  }

  // ort is excluded from Vite's optimizeDeps, so it's served directly from
  // node_modules. import.meta.url inside ort.mjs resolves all sibling files
  // (worker .mjs and .wasm) from the same node_modules/dist/ path automatically.
  // Do NOT set wasmPaths — that would redirect imports into /public, which Vite
  // refuses to transform when used as a module import.
  ort.env.wasm.proxy = false;
  ort.env.wasm.simd = true;
  ort.env.wasm.numThreads = 1;
  sessionStatus = 'loading';
  sessionError = null;
  sessionPromise = ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  }).then((session) => {
    sessionStatus = 'ready';
    return session;
  }).catch((error: unknown) => {
    sessionStatus = 'error';
    sessionError = error instanceof Error ? error.message : String(error);
    sessionPromise = null;
    throw error;
  });
  return sessionPromise;
};

const getPreprocessCanvas = () => {
  if (!preprocessCanvas) {
    preprocessCanvas = document.createElement('canvas');
    preprocessCanvas.width = MODEL_SIZE;
    preprocessCanvas.height = MODEL_SIZE;
  }
  return preprocessCanvas;
};

const preprocessFrame = (sourceCanvas: HTMLCanvasElement): PreprocessResult => {
  const canvas = getPreprocessCanvas();
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Document detector could not allocate a preprocessing canvas.');
  }

  const originalWidth = sourceCanvas.width;
  const originalHeight = sourceCanvas.height;
  const scale = Math.min(MODEL_SIZE / originalWidth, MODEL_SIZE / originalHeight);
  const resizedWidth = Math.max(1, Math.round(originalWidth * scale));
  const resizedHeight = Math.max(1, Math.round(originalHeight * scale));
  const padX = Math.floor((MODEL_SIZE - resizedWidth) / 2);
  const padY = Math.floor((MODEL_SIZE - resizedHeight) / 2);

  ctx.fillStyle = 'rgb(114, 114, 114)';
  ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  ctx.drawImage(sourceCanvas, 0, 0, originalWidth, originalHeight, padX, padY, resizedWidth, resizedHeight);

  const imageData = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const chw = new Float32Array(MODEL_SIZE * MODEL_SIZE * 3);
  const stride = MODEL_SIZE * MODEL_SIZE;

  for (let pixelIndex = 0; pixelIndex < stride; pixelIndex += 1) {
    const sourceIndex = pixelIndex * 4;
    chw[pixelIndex] = imageData[sourceIndex] / 255;
    chw[stride + pixelIndex] = imageData[sourceIndex + 1] / 255;
    chw[(stride * 2) + pixelIndex] = imageData[sourceIndex + 2] / 255;
  }

  return {
    tensor: new ort.Tensor('float32', chw, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    scale,
    padX,
    padY,
    originalWidth,
    originalHeight,
  };
};

const computeIoU = (left: CandidateBox, right: CandidateBox) => {
  const overlapLeft = Math.max(left.left, right.left);
  const overlapTop = Math.max(left.top, right.top);
  const overlapRight = Math.min(left.right, right.right);
  const overlapBottom = Math.min(left.bottom, right.bottom);

  const overlapWidth = Math.max(0, overlapRight - overlapLeft);
  const overlapHeight = Math.max(0, overlapBottom - overlapTop);
  const intersection = overlapWidth * overlapHeight;
  const leftArea = Math.max(0, left.right - left.left) * Math.max(0, left.bottom - left.top);
  const rightArea = Math.max(0, right.right - right.left) * Math.max(0, right.bottom - right.top);
  const union = leftArea + rightArea - intersection;

  return union > 0 ? intersection / union : 0;
};

const nonMaximumSuppression = (boxes: CandidateBox[]) => {
  const sorted = [...boxes].sort((left, right) => right.score - left.score);
  const selected: CandidateBox[] = [];

  while (sorted.length > 0) {
    const current = sorted.shift();
    if (!current) {
      continue;
    }
    selected.push(current);
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      if (computeIoU(current, sorted[index]) > NMS_THRESHOLD) {
        sorted.splice(index, 1);
      }
    }
  }

  return selected;
};

const decodeDetections = (
  output: ort.Tensor,
  preprocess: PreprocessResult,
): CandidateBox[] => {
  const data = output.data instanceof Float32Array
    ? output.data
    : new Float32Array(output.data as ArrayLike<number>);

  // Auto-detect tensor layout: [1, features, anchors] vs [1, anchors, features].
  // Cast BigInt dims (some onnxruntime versions) to number for safe comparison.
  const dim1 = Number(output.dims?.[1] ?? 0);
  const dim2 = Number(output.dims?.[2] ?? 0);

  let candidateCount: number;
  let featuresFirst: boolean;

  if (dim1 === FEATURE_COUNT && dim2 > 0) {
    // Standard YOLO layout: [1, FEATURE_COUNT, anchors]
    candidateCount = dim2;
    featuresFirst = true;
  } else if (dim2 === FEATURE_COUNT && dim1 > 0) {
    // Transposed layout: [1, anchors, FEATURE_COUNT]
    candidateCount = dim1;
    featuresFirst = false;
  } else {
    // Unknown shape — fall back to standard layout with a safe anchor count.
    candidateCount = dim2 > 0 ? dim2 : 8400;
    featuresFirst = true;
  }

  const getFeature = (featureIndex: number, anchorIndex: number): number => (
    featuresFirst
      ? data[featureIndex * candidateCount + anchorIndex]
      : data[anchorIndex * FEATURE_COUNT + featureIndex]
  );

  const candidates: CandidateBox[] = [];

  for (let index = 0; index < candidateCount; index += 1) {
    const centerX = getFeature(0, index);
    const centerY = getFeature(1, index);
    const width = getFeature(2, index);
    const height = getFeature(3, index);

    let bestScore = 0;
    let bestClassIndex = 0;
    for (let classIndex = 0; classIndex < CLASS_COUNT; classIndex += 1) {
      const score = getFeature(4 + classIndex, index);
      if (score > bestScore) {
        bestScore = score;
        bestClassIndex = classIndex;
      }
    }

    if (bestScore < SCORE_THRESHOLD) {
      continue;
    }

    const left = ((centerX - (width / 2)) - preprocess.padX) / preprocess.scale;
    const top = ((centerY - (height / 2)) - preprocess.padY) / preprocess.scale;
    const right = ((centerX + (width / 2)) - preprocess.padX) / preprocess.scale;
    const bottom = ((centerY + (height / 2)) - preprocess.padY) / preprocess.scale;

    const normalizedLeft = clamp01(left / preprocess.originalWidth);
    const normalizedTop = clamp01(top / preprocess.originalHeight);
    const normalizedRight = clamp01(right / preprocess.originalWidth);
    const normalizedBottom = clamp01(bottom / preprocess.originalHeight);

    if (normalizedRight <= normalizedLeft || normalizedBottom <= normalizedTop) {
      continue;
    }

    candidates.push({
      left: normalizedLeft,
      top: normalizedTop,
      right: normalizedRight,
      bottom: normalizedBottom,
      score: bestScore,
      classIndex: bestClassIndex,
    });
  }

  return nonMaximumSuppression(candidates);
};

export const detectDocumentLayoutRegion = async (
  sourceCanvas: HTMLCanvasElement,
): Promise<DocumentLayoutDetection | null> => {
  activeDetectionCount += 1;

  try {
    const preprocess = preprocessFrame(sourceCanvas);
    const session = await getSession();
    const outputs = await session.run({ images: preprocess.tensor });
    const output = outputs.output0 || Object.values(outputs)[0];
    if (!output) {
      throw new Error('Document detector returned no output tensor.');
    }

    const boxes = decodeDetections(output, preprocess);
    if (boxes.length === 0) {
      return null;
    }

    const union = boxes.reduce<NormalizedRegion>((region, box) => ({
      left: Math.min(region.left, box.left),
      top: Math.min(region.top, box.top),
      width: Math.max(region.left + region.width, box.right) - Math.min(region.left, box.left),
      height: Math.max(region.top + region.height, box.bottom) - Math.min(region.top, box.top),
    }), {
      left: boxes[0].left,
      top: boxes[0].top,
      width: boxes[0].right - boxes[0].left,
      height: boxes[0].bottom - boxes[0].top,
    });

    const padX = Math.min(0.12, union.width * 0.18);
    const padY = Math.min(0.16, union.height * 0.22);
    const paddedRegion = {
      left: clamp01(union.left - padX),
      top: clamp01(union.top - padY),
      width: clamp01((union.width + (padX * 2))),
      height: clamp01((union.height + (padY * 2))),
    };

    if (paddedRegion.left + paddedRegion.width > 1) {
      paddedRegion.width = 1 - paddedRegion.left;
    }
    if (paddedRegion.top + paddedRegion.height > 1) {
      paddedRegion.height = 1 - paddedRegion.top;
    }

    const maxScore = Math.max(...boxes.map((box) => box.score));
    const averageScore = boxes.reduce((sum, box) => sum + box.score, 0) / boxes.length;
    const structureBonus = Math.min(0.12, boxes.length * 0.03);

    const tensorShape = `[${Array.from(output.dims).join('×')}]`;

    return {
      region: paddedRegion,
      confidence: clamp01((maxScore * 0.55) + (averageScore * 0.35) + structureBonus),
      detectionCount: boxes.length,
      outputTensorShape: tensorShape,
      boxes: boxes.map((box) => ({
        region: {
          left: box.left,
          top: box.top,
          width: box.right - box.left,
          height: box.bottom - box.top,
        },
        label: CLASS_NAMES[box.classIndex] ?? 'Text',
        score: box.score,
      })),
    };
  } finally {
    activeDetectionCount = Math.max(0, activeDetectionCount - 1);
    flushQueuedSessionReleases();
  }
};
