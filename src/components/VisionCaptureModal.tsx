import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Camera, Loader2, RefreshCw, Upload, X, LayoutGrid, Files } from 'lucide-react';
import { detectDocumentLayoutRegion, disposeDocumentLayoutDetector, getSessionStatus, type NormalizedRegion, type DetectedBox } from '../services/documentLayoutDetector';
import { type VisionPreparedCapture } from '../types';
import { writeSystemLog } from '../lib/systemLogger';

interface VisionCaptureModalProps {
  isOpen: boolean;
  isBusy: boolean;
  detectorModel: string;
  onClose: () => void;
  onExtractCapture: (file: File) => Promise<VisionPreparedCapture>;
  onAnalyzeBatch: (captures: VisionPreparedCapture[]) => Promise<void>;
}

const STOPPED_VIDEO_TEXT = 'Camera preview will appear here once access is granted.';
const DETECTION_INTERVAL_MS = 320;
const AUTO_CAPTURE_STABLE_MS = 900;
const AUTO_CAPTURE_CONFIDENCE = 0.73;
const MIN_AUTOCAPTURE_REGION_AREA = 0.16;
const MIN_AUTOCAPTURE_DETECTION_COUNT = 2;

type QuadPoint = {
  x: number;
  y: number;
};

type QuadMetrics = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type DocumentDetection = {
  quad: QuadPoint[];
  confidence: number;
};

type DebugInfo = {
  sessionStatus: string;
  sessionError: string | null;
  frameCount: number;
  detectionCount: number;
  quadIsSet: boolean;
  confidence: number;
  outputShape: string | null;
  lastError: string | null;
  canvasDims: string;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const isMac = typeof window !== 'undefined' && 
  (navigator.userAgent.includes('Mac') || navigator.platform.toLowerCase().includes('mac'));

const drawDocumentOverlay = (
  canvas: HTMLCanvasElement,
  quad: QuadPoint[] | null,
  progress = 0,
  confidence = 0,
  detectionBoxes: DetectedBox[] = [],
) => {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = Math.max(1, Math.round(rect.width));
  const displayHeight = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(displayWidth * dpr) || canvas.height !== Math.round(displayHeight * dpr)) {
    canvas.width = Math.round(displayWidth * dpr);
    canvas.height = Math.round(displayHeight * dpr);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, displayWidth, displayHeight);

  // Draw individual YOLO detection boxes with class labels.
  if (detectionBoxes.length > 0) {
    ctx.save();
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    detectionBoxes.forEach((box) => {
      const bx = box.region.left * displayWidth;
      const by = box.region.top * displayHeight;
      const bw = box.region.width * displayWidth;
      const bh = box.region.height * displayHeight;
      ctx.strokeStyle = 'rgba(0, 210, 255, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.shadowBlur = 0;
      ctx.strokeRect(bx, by, bw, bh);

      const chipLabel = `${box.label} ${box.score.toFixed(2)}`;
      const chipW = ctx.measureText(chipLabel).width + 8;
      const chipH = 14;
      const chipY = by > chipH + 2 ? by - chipH - 2 : by + 2;
      ctx.fillStyle = 'rgba(0, 30, 50, 0.82)';
      ctx.fillRect(bx, chipY, chipW, chipH);
      ctx.fillStyle = 'rgba(0, 210, 255, 0.9)';
      ctx.fillText(chipLabel, bx + 4, chipY + chipH - 3);
    });
    ctx.restore();
  }

  if (!quad || quad.length !== 4) {
    return;
  }

  const points = quad.map((point) => ({
    x: point.x * displayWidth,
    y: point.y * displayHeight,
  }));
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  const safeConfidence = clamp01(confidence);
  const safeProgress = clamp01(progress);
  const accentColor = safeConfidence >= AUTO_CAPTURE_CONFIDENCE
    ? '#7CFF00'
    : safeConfidence >= 0.75
      ? '#00D2FF'
      : '#FFD166';

  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.fillStyle = accentColor;
  ctx.lineWidth = 3;
  ctx.shadowColor = `${accentColor}DD`;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.closePath();
  ctx.stroke();

  const scanProgress = (performance.now() % 1200) / 1200;
  const scanY = top + ((bottom - top) * scanProgress);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.closePath();
  ctx.clip();
  const scanGradient = ctx.createLinearGradient(left, scanY - 12, right, scanY + 12);
  scanGradient.addColorStop(0, 'rgba(255,255,255,0)');
  scanGradient.addColorStop(0.5, `${accentColor}55`);
  scanGradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = scanGradient;
  ctx.fillRect(left, scanY - 16, Math.max(1, right - left), 32);
  ctx.restore();

  points.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
  });

  const label = `LOCK ${safeConfidence.toFixed(2)}`;
  ctx.font = '700 11px Inter, system-ui, sans-serif';
  const labelWidth = ctx.measureText(label).width + 42;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.fillRect(Math.max(8, left), Math.max(8, top - 28), labelWidth, 22);
  ctx.fillStyle = accentColor;
  const labelX = Math.max(8, left);
  const labelY = Math.max(8, top - 28);
  const ringCenterX = labelX + 12;
  const ringCenterY = labelY + 11;
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.beginPath();
  ctx.arc(ringCenterX, ringCenterY, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = accentColor;
  ctx.beginPath();
  ctx.arc(ringCenterX, ringCenterY, 6, -Math.PI / 2, (-Math.PI / 2) + (Math.PI * 2 * safeProgress));
  ctx.stroke();
  ctx.fillText(label, labelX + 22, Math.max(23, top - 12));
  ctx.restore();
};

const detectDocumentQuadFromRegion = (
  region: NormalizedRegion,
): DocumentDetection => ({
  quad: [
    { x: region.left, y: region.top },
    { x: region.left + region.width, y: region.top },
    { x: region.left + region.width, y: region.top + region.height },
    { x: region.left, y: region.top + region.height },
  ],
  confidence: 1,
});

const toQuadMetrics = (quad: QuadPoint[] | null): QuadMetrics | null => {
  if (!quad || quad.length !== 4) {
    return null;
  }

  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
};

const areQuadMetricsStable = (previous: QuadMetrics | null, next: QuadMetrics | null) => {
  if (!previous || !next) {
    return false;
  }

  return (
    Math.abs(previous.left - next.left) < 0.035
    && Math.abs(previous.top - next.top) < 0.035
    && Math.abs(previous.width - next.width) < 0.05
    && Math.abs(previous.height - next.height) < 0.05
  );
};

export default function VisionCaptureModal({
  isOpen,
  isBusy,
  detectorModel,
  onClose,
  onExtractCapture,
  onAnalyzeBatch,
}: VisionCaptureModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const detectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectionFrameRef = useRef<number | null>(null);
  const detectorInFlightRef = useRef(false);
  const lastDetectionAtRef = useRef(0);
  const detectedQuadRef = useRef<QuadPoint[] | null>(null);
  const detectedConfidenceRef = useRef(0);
  const detectionBoxesRef = useRef<DetectedBox[]>([]);
  const modelRegionRef = useRef<NormalizedRegion | null>(null);
  const modelRegionConfidenceRef = useRef(0);
  const previousQuadMetricsRef = useRef<QuadMetrics | null>(null);
  const stableSinceRef = useRef<number | null>(null);
  const autoCaptureTriggeredRef = useRef(false);
  const lockConfidenceRef = useRef(0);
  const detectionMessageRef = useRef(STOPPED_VIDEO_TEXT);
  const previewUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const isOpenRef = useRef(isOpen);
  const cameraStartTokenRef = useRef(0);
  const [cameraState, setCameraState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [cameraMessage, setCameraMessage] = useState(STOPPED_VIDEO_TEXT);
  const [lockConfidence, setLockConfidence] = useState(0);
  const [detectorScore, setDetectorScore] = useState(0);
  const [capturePhase, setCapturePhase] = useState<'choice' | 'camera' | 'processing'>('choice');
  const [processingPhase, setProcessingPhase] = useState<'locking' | 'cropping' | 'analyzing'>('locking');
  const [processingPreviewUrl, setProcessingPreviewUrl] = useState<string | null>(null);
  const [batchCaptures, setBatchCaptures] = useState<VisionPreparedCapture[]>([]);
  const batchCapturesRef = useRef<VisionPreparedCapture[]>([]);
  const [lastPreparedCapture, setLastPreparedCapture] = useState<VisionPreparedCapture | null>(null);
  const [batchDecisionState, setBatchDecisionState] = useState<'hidden' | 'prompt' | 'finalizing'>('hidden');
  const [workflowMode, setWorkflowMode] = useState<'single' | 'multiple' | null>(null);
  const [isExtractingCapture, setIsExtractingCapture] = useState(false);
  const [isFinalizingBatch, setIsFinalizingBatch] = useState(false);
  const isCaptureBusy = isBusy || isExtractingCapture || isFinalizingBatch;
  const [showDebug, setShowDebug] = useState(false);
  const showDebugRef = useRef(false);
  const [debugInfo, setDebugInfo] = useState<DebugInfo>({
    sessionStatus: 'idle',
    sessionError: null,
    frameCount: 0,
    detectionCount: 0,
    quadIsSet: false,
    confidence: 0,
    outputShape: null,
    lastError: null,
    canvasDims: 'n/a',
  });
  const debugFrameCountRef = useRef(0);
  isOpenRef.current = isOpen;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      cameraStartTokenRef.current += 1;
    };
  }, []);

  const replaceProcessingPreview = useCallback((nextUrl: string | null) => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = nextUrl;
    setProcessingPreviewUrl(nextUrl);
  }, []);

  const releaseDetectorResources = useCallback(() => {
    debugFrameCountRef.current = 0;
    if (mountedRef.current) {
      setDebugInfo((current) => ({
        ...current,
        frameCount: 0,
        detectionCount: 0,
        quadIsSet: false,
        confidence: 0,
        outputShape: null,
        lastError: null,
        canvasDims: 'n/a',
      }));
    }
    
    void writeSystemLog({
      scope: 'app.vision-capture',
      event: 'resource-release',
      message: 'Releasing vision detector resources following capture or modal close.',
    });

    return disposeDocumentLayoutDetector();
  }, []);

  const updateCameraMessage = (message: string) => {
    if (!mountedRef.current) {
      return;
    }

    if (detectionMessageRef.current !== message) {
      detectionMessageRef.current = message;
      setCameraMessage(message);
    }
  };

  const stopDetectionLoop = () => {
    if (detectionFrameRef.current !== null) {
      cancelAnimationFrame(detectionFrameRef.current);
      detectionFrameRef.current = null;
    }
    detectedQuadRef.current = null;
    detectedConfidenceRef.current = 0;
    detectionBoxesRef.current = [];
    modelRegionRef.current = null;
    modelRegionConfidenceRef.current = 0;
    detectorInFlightRef.current = false;
    previousQuadMetricsRef.current = null;
    stableSinceRef.current = null;
    lockConfidenceRef.current = 0;
    if (mountedRef.current) {
      setLockConfidence(0);
      setDetectorScore(0);
    }
    lastDetectionAtRef.current = 0;
    if (overlayCanvasRef.current) {
      drawDocumentOverlay(overlayCanvasRef.current, null, 0);
    }
  };

  const stopCamera = () => {
    cameraStartTokenRef.current += 1;
    try {
      stopDetectionLoop();
    } catch {
      // ignore
    }
    try {
      streamRef.current?.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore individual track stop failures
        }
      });
    } catch {
      // ignore
    }
    streamRef.current = null;
    try {
      if (videoRef.current) {
        const video = videoRef.current;
        try {
          video.pause();
        } catch {
          // ignore
        }
        try {
          video.srcObject = null;
        } catch {
          // ignore
        }
        try {
          video.removeAttribute('src');
        } catch {
          // ignore
        }
        try {
          video.load();
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  };

  const resetBatchSession = useCallback(() => {
    batchCapturesRef.current = [];
    setBatchCaptures([]);
    setLastPreparedCapture(null);
    setBatchDecisionState('hidden');
    setIsExtractingCapture(false);
    setIsFinalizingBatch(false);
  }, []);

  const startCamera = async () => {
    stopCamera();
    const cameraStartToken = cameraStartTokenRef.current + 1;
    cameraStartTokenRef.current = cameraStartToken;
    autoCaptureTriggeredRef.current = false;
    replaceProcessingPreview(null);
    setCapturePhase('camera');
    setProcessingPhase('locking');
    setCameraState('loading');
    setCameraMessage('Requesting camera access...');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 3840, min: 1920 },
          height: { ideal: 2160, min: 1080 },
          frameRate: { ideal: 30, max: 60 }
        },
        audio: false,
      });

      if (cameraStartTokenRef.current !== cameraStartToken || !isOpenRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      if (cameraStartTokenRef.current !== cameraStartToken || !isOpenRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        if (streamRef.current === stream) {
          streamRef.current = null;
        }
        if (videoRef.current?.srcObject === stream) {
          videoRef.current.pause();
          videoRef.current.srcObject = null;
          videoRef.current.removeAttribute('src');
          videoRef.current.load();
        }
        return;
      }

      setCameraState('ready');
      const settings = stream.getVideoTracks()[0].getSettings();
      const resLabel = settings.width && settings.height ? `${settings.width}x${settings.height}` : 'High-Res';
      updateCameraMessage(`Live preview ready (${resLabel}). Initializing live document detector...`);
    } catch (error) {
      if (cameraStartTokenRef.current !== cameraStartToken || !isOpenRef.current) {
        return;
      }
      setCameraState('error');
      updateCameraMessage(error instanceof Error ? error.message : 'Camera access failed.');
    }
  };

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      void releaseDetectorResources();
      setCapturePhase('camera');
      setProcessingPhase('locking');
      resetBatchSession();
      replaceProcessingPreview(null);
      setCameraState('idle');
      updateCameraMessage(STOPPED_VIDEO_TEXT);
      return;
    }

    setCapturePhase('choice');
    setWorkflowMode(null);
    setProcessingPhase('locking');
    replaceProcessingPreview(null);

    return () => {
      stopCamera();
      void releaseDetectorResources();
    };
  }, [isOpen, releaseDetectorResources, replaceProcessingPreview, resetBatchSession]);

  useEffect(() => () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    void releaseDetectorResources();
  }, [releaseDetectorResources]);

  const processCapturedFile = useCallback(async (
    file: File,
    previewBlob: Blob,
    messages?: {
      preparing?: string;
      extracting?: string;
    },
  ) => {
    stopCamera();
    void releaseDetectorResources();
    setCapturePhase('processing');
    setBatchDecisionState('hidden');
    setCameraState('idle');
    setProcessingPhase('locking');
    replaceProcessingPreview(URL.createObjectURL(previewBlob));
    updateCameraMessage(messages?.preparing || 'Live crop ready. Finalizing the corrected document edges...');
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 180);
    });
    setProcessingPhase('analyzing');
    updateCameraMessage(messages?.extracting || 'Live crop ready. CATOG is extracting the document now...');
    setIsExtractingCapture(true);

    try {
      const preparedCapture = await onExtractCapture(file);
      const nextBatch = [...batchCapturesRef.current, preparedCapture];
      batchCapturesRef.current = nextBatch;
      setBatchCaptures(nextBatch);
      setLastPreparedCapture(preparedCapture);
      autoCaptureTriggeredRef.current = false;

      if (workflowMode === 'multiple') {
        setBatchDecisionState('prompt');
        setIsFinalizingBatch(false);
        updateCameraMessage(`Extraction ready for ${preparedCapture.name}. You can add another document or finish.`);
      } else {
        setBatchDecisionState('finalizing');
        setIsFinalizingBatch(true);
        updateCameraMessage(`Extraction ready for ${preparedCapture.name}. Handing off to CATOG...`);
        onClose();
        onAnalyzeBatch(nextBatch).catch((analyzeError) => {
          console.error('Vision analysis handover failed:', analyzeError);
        });
      }
    } catch (error) {
      autoCaptureTriggeredRef.current = false;
      if (isOpenRef.current) {
        setCapturePhase('camera');
        setProcessingPhase('locking');
        setBatchDecisionState('hidden');
        replaceProcessingPreview(null);
        updateCameraMessage(
          error instanceof Error
            ? `Vision capture failed: ${error.message}`
            : 'Vision capture failed.',
        );
        void startCamera();
      }
    } finally {
      if (mountedRef.current && isOpenRef.current) {
        setIsExtractingCapture(false);
      }
    }
  }, [onAnalyzeBatch, onClose, onExtractCapture, releaseDetectorResources, replaceProcessingPreview, workflowMode]);

  const handleCaptureClick = async (captureMode: 'auto' | 'manual' = 'manual') => {
    if (!videoRef.current || autoCaptureTriggeredRef.current || isCaptureBusy) {
      return;
    }

    autoCaptureTriggeredRef.current = true;
    lockConfidenceRef.current = 1;
    setLockConfidence(1);
    setProcessingPhase('locking');
    updateCameraMessage(
      captureMode === 'auto'
        ? 'Document locked at 100%. Auto-capturing now...'
        : 'Manual capture triggered. Freezing frame now...',
    );

    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setCameraState('error');
      setCameraMessage('Vision capture could not prepare a snapshot.');
      autoCaptureTriggeredRef.current = false;
      return;
    }

    if (isMac) {
      ctx.filter = 'brightness(1.25) contrast(1.18) saturate(1.1)';
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) {
      setCameraState('error');
      setCameraMessage('Vision capture could not encode the captured image.');
      autoCaptureTriggeredRef.current = false;
      return;
    }

    let captureBlob = blob;
    const captureRegion = modelRegionRef.current;
    if (captureRegion) {
      try {
        setProcessingPhase('cropping');
        updateCameraMessage('Document region locked. Cropping to document area...');
        const roiLeft = Math.max(0, Math.floor(captureRegion.left * canvas.width));
        const roiTop = Math.max(0, Math.floor(captureRegion.top * canvas.height));
        const roiWidth = Math.min(canvas.width - roiLeft, Math.ceil(captureRegion.width * canvas.width));
        const roiHeight = Math.min(canvas.height - roiTop, Math.ceil(captureRegion.height * canvas.height));

        if (roiWidth > 20 && roiHeight > 20) {
          const croppedCanvas = document.createElement('canvas');
          croppedCanvas.width = roiWidth;
          croppedCanvas.height = roiHeight;
          const croppedCtx = croppedCanvas.getContext('2d');
          if (croppedCtx) {
            croppedCtx.drawImage(canvas, roiLeft, roiTop, roiWidth, roiHeight, 0, 0, roiWidth, roiHeight);
            const croppedBlob = await new Promise<Blob | null>((resolve) => croppedCanvas.toBlob(resolve, 'image/jpeg', 0.95));
            if (croppedBlob) {
              captureBlob = croppedBlob;
            }
          }
        }
      } catch {
        // Fall back to uncropped
      }
    }

    const file = new File([captureBlob], `vision-capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
    await processCapturedFile(file, captureBlob);
  };

  useEffect(() => {
    if (!isOpen || cameraState !== 'ready' || capturePhase !== 'camera' || !videoRef.current) {
      return;
    }

    let cancelled = false;
    detectionCanvasRef.current = detectionCanvasRef.current || document.createElement('canvas');

    const startDetectionLoop = () => {
      updateCameraMessage('Live preview ready. Loading the YOLO document detector...');
      const runDetection = () => {
        if (cancelled) {
          return;
        }

        const video = videoRef.current;
        const overlayCanvas = overlayCanvasRef.current;
        const scratchCanvas = detectionCanvasRef.current;
        if (!video || !overlayCanvas || !scratchCanvas) {
          detectionFrameRef.current = requestAnimationFrame(runDetection);
          return;
        }

        drawDocumentOverlay(
          overlayCanvas,
          detectedQuadRef.current,
          lockConfidenceRef.current,
          detectorScore,
          detectionBoxesRef.current,
        );

        const now = performance.now();
        if (
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          && video.videoWidth > 0
          && video.videoHeight > 0
          && now - lastDetectionAtRef.current >= DETECTION_INTERVAL_MS
        ) {
          lastDetectionAtRef.current = now;
          const targetWidth = Math.min(1280, video.videoWidth);
          const scale = targetWidth / video.videoWidth;
          const targetHeight = Math.max(1, Math.round(video.videoHeight * scale));
          scratchCanvas.width = targetWidth;
          scratchCanvas.height = targetHeight;
          const scratchContext = scratchCanvas.getContext('2d', { willReadFrequently: true });
          if (scratchContext && !detectorInFlightRef.current) {
            scratchContext.drawImage(video, 0, 0, targetWidth, targetHeight);
            detectorInFlightRef.current = true;
            void (async () => {
              try {
                const layoutDetection = await detectDocumentLayoutRegion(scratchCanvas);
                if (cancelled) {
                  return;
                }

                modelRegionRef.current = layoutDetection?.region || null;
                modelRegionConfidenceRef.current = layoutDetection?.confidence || 0;
                detectionBoxesRef.current = layoutDetection?.boxes || [];
                setDetectorScore(modelRegionConfidenceRef.current);

                const modelRegionArea = modelRegionRef.current
                  ? modelRegionRef.current.width * modelRegionRef.current.height
                  : 0;
                const hasStrongDocumentCandidate = Boolean(
                  modelRegionRef.current
                  && modelRegionConfidenceRef.current >= AUTO_CAPTURE_CONFIDENCE
                  && modelRegionArea >= MIN_AUTOCAPTURE_REGION_AREA
                  && detectionBoxesRef.current.length >= MIN_AUTOCAPTURE_DETECTION_COUNT,
                );
                const hasRenderableCandidate = Boolean(
                  modelRegionRef.current
                  && modelRegionConfidenceRef.current >= 0.35
                  && modelRegionArea >= 0.08,
                );

                detectedQuadRef.current = hasRenderableCandidate && modelRegionRef.current
                  ? detectDocumentQuadFromRegion(modelRegionRef.current).quad
                  : null;
                detectedConfidenceRef.current = modelRegionConfidenceRef.current;

                debugFrameCountRef.current += 1;
                if (showDebugRef.current) {
                  const { status, error } = getSessionStatus();
                  setDebugInfo({
                    sessionStatus: status,
                    sessionError: error,
                    frameCount: debugFrameCountRef.current,
                    detectionCount: layoutDetection?.detectionCount ?? 0,
                    quadIsSet: detectedQuadRef.current !== null,
                    confidence: detectedConfidenceRef.current,
                    outputShape: layoutDetection?.outputTensorShape ?? null,
                    lastError: null,
                    canvasDims: `${scratchCanvas.width}×${scratchCanvas.height}`,
                  });
                }

                const nextMetrics = toQuadMetrics(detectedQuadRef.current);
                const stableMetrics = areQuadMetricsStable(previousQuadMetricsRef.current, nextMetrics);
                previousQuadMetricsRef.current = nextMetrics;
                const detectedAt = performance.now();

                if (!nextMetrics) {
                  stableSinceRef.current = null;
                  lockConfidenceRef.current = 0;
                  detectionBoxesRef.current = [];
                  setLockConfidence(0);
                  setDetectorScore(0);
                  updateCameraMessage('YOLO model active. Scanning the camera feed for document content...');
                } else {
                  if (!stableSinceRef.current || !stableMetrics || !hasStrongDocumentCandidate) {
                    stableSinceRef.current = detectedAt;
                  }

                  const stableForMs = detectedAt - stableSinceRef.current;
                  const stabilityScore = clamp01(stableForMs / AUTO_CAPTURE_STABLE_MS);
                  const combinedConfidence = clamp01(
                    (detectedConfidenceRef.current * 0.75) + (stabilityScore * 0.25),
                  );
                  lockConfidenceRef.current = combinedConfidence;
                  setLockConfidence(combinedConfidence);
                  if (
                    !autoCaptureTriggeredRef.current
                    && hasStrongDocumentCandidate
                    && stableForMs >= AUTO_CAPTURE_STABLE_MS
                  ) {
                    void handleCaptureClick('auto');
                  } else if (!autoCaptureTriggeredRef.current) {
                    updateCameraMessage(
                      hasStrongDocumentCandidate
                        ? `Document score ${detectedConfidenceRef.current.toFixed(2)}. Auto capture starts after a stable ${AUTO_CAPTURE_CONFIDENCE.toFixed(2)}+ lock.`
                        : `Document score ${detectedConfidenceRef.current.toFixed(2)}. Waiting for a valid ${AUTO_CAPTURE_CONFIDENCE.toFixed(2)}+ document box before auto capture.`,
                    );
                  }
                }
              } catch (error) {
                if (!cancelled) {
                  const msg = error instanceof Error ? error.message : String(error);
                  updateCameraMessage(`Document detector error: ${msg}`);
                  if (showDebugRef.current) {
                    const { status, sessionErr } = (() => {
                      const s = getSessionStatus();
                      return { status: s.status, sessionErr: s.error };
                    })();
                    setDebugInfo((prev) => ({
                      ...prev,
                      sessionStatus: status,
                      sessionError: sessionErr,
                      lastError: msg,
                    }));
                  }
                }
              } finally {
                detectorInFlightRef.current = false;
              }
            })();
          }
        }

        detectionFrameRef.current = requestAnimationFrame(runDetection);
      };

      runDetection();
    };

    startDetectionLoop();

    return () => {
      cancelled = true;
      stopDetectionLoop();
    };
  }, [cameraState, capturePhase, isBusy, isOpen]);

  const handleUploadFallback = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    await processCapturedFile(file, file, {
      preparing: 'Uploaded image ready. Preparing the extracted document preview...',
      extracting: 'Uploaded image ready. CATOG is extracting the document now...',
    });
    event.target.value = '';
  };

  const handleCaptureAnother = useCallback(() => {
    setBatchDecisionState('hidden');
    updateCameraMessage(
      batchCaptures.length > 0
        ? `${batchCaptures.length} file(s) already extracted. Reopening the camera for another page...`
        : 'Reopening the camera for another page...',
    );
    void startCamera();
  }, [batchCaptures.length]);

  const handleFinalizeBatch = useCallback(async () => {
    if (batchCaptures.length === 0 || isFinalizingBatch || isBusy) {
      return;
    }

    setBatchDecisionState('finalizing');
    setIsFinalizingBatch(true);
    updateCameraMessage(`Starting CATOG analysis for ${batchCaptures.length} extracted file(s)...`);

    try {
      await onAnalyzeBatch(batchCaptures);
      onClose();
    } catch (error) {
      setBatchDecisionState('prompt');
      updateCameraMessage(
        error instanceof Error
          ? `Could not start CATOG analysis: ${error.message}`
          : 'Could not start CATOG analysis.',
      );
      setIsFinalizingBatch(false);
    }
  }, [batchCaptures, isBusy, isFinalizingBatch, onAnalyzeBatch, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-6 backdrop-blur-md">
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            className="w-full max-w-5xl overflow-hidden rounded-xl border border-white/10 bg-[#0D0D0F] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-white/10 bg-[#161618] px-5 py-4">
              <div>
                <div className="text-[10px] font-black uppercase tracking-[0.3em] text-neon-cyan">Vision Intake Camera</div>
                <div className="mt-1 text-sm font-semibold text-white">Live paper preview before CATOG analysis</div>
              </div>
              <button onClick={onClose} disabled={isCaptureBusy} className="text-white/40 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
                <X size={18} />
              </button>
            </div>

            <div className="p-5">
              <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black/50 aspect-video w-full flex items-center justify-center">
                {capturePhase === 'choice' ? (
                  <div className="flex flex-col items-center justify-center h-full p-10 text-center space-y-8">
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-[0.4em] text-neon-cyan mb-2">Workflow Selection</div>
                      <h2 className="text-2xl font-bold text-white">How many documents?</h2>
                      <p className="mt-2 text-sm text-white/40 max-w-sm">Choose the intake mode for this session. You can capture multiple pages to be analyzed as a single logical batch.</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-lg">
                      <button
                        onClick={() => {
                          setWorkflowMode('single');
                          setCapturePhase('camera');
                          void startCamera();
                        }}
                        className="group relative flex flex-col items-center p-6 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-neon-cyan/50 transition-all text-center"
                      >
                        <div className="mb-4 p-3 rounded-lg bg-white/5 group-hover:bg-neon-cyan/20 transition-colors">
                          <LayoutGrid size={32} className="text-white/60 group-hover:text-neon-cyan" />
                        </div>
                        <div className="text-sm font-bold text-white uppercase tracking-widest">Single Document</div>
                        <div className="mt-1 text-[10px] text-white/30 uppercase tracking-wider">Fast-track capture & analysis</div>
                      </button>

                      <button
                        onClick={() => {
                          setWorkflowMode('multiple');
                          setCapturePhase('camera');
                          void startCamera();
                        }}
                        className="group relative flex flex-col items-center p-6 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-neon-pink/50 transition-all text-center"
                      >
                        <div className="mb-4 p-3 rounded-lg bg-white/5 group-hover:bg-neon-pink/20 transition-colors">
                          <Files size={32} className="text-white/60 group-hover:text-neon-pink" />
                        </div>
                        <div className="text-sm font-bold text-white uppercase tracking-widest">Multiple Documents</div>
                        <div className="mt-1 text-[10px] text-white/30 uppercase tracking-wider">Batch capture many pages</div>
                      </button>
                    </div>
                  </div>
                ) : capturePhase === 'camera' ? (
                  <>
                    <video 
                      ref={videoRef} 
                      className="h-full w-full object-cover" 
                      style={{
                        filter: isMac ? 'brightness(1.25) contrast(1.18) saturate(1.1)' : 'none',
                        imageRendering: isMac ? '-webkit-optimize-contrast' : 'auto'
                      }}
                      playsInline 
                      muted 
                    />
                    <canvas ref={overlayCanvasRef} className="absolute inset-0 h-full w-full pointer-events-none" />
                    <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-white/10 bg-black/55 px-3 py-2">
                      <div className="text-[9px] font-black uppercase tracking-[0.25em] text-white/60">YOLO Score</div>
                      <div className="mt-1 text-lg font-black text-white">{detectorScore.toFixed(2)}</div>
                      <div className="mt-2 h-1.5 w-32 overflow-hidden rounded-full bg-white/10">
                        <motion.div
                          className="h-full rounded-full bg-neon-cyan"
                          animate={{ width: `${Math.round(lockConfidence * 100)}%` }}
                          transition={{ duration: 0.18, ease: 'easeOut' }}
                        />
                      </div>
                    </div>
                    {cameraState !== 'ready' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center">
                        {cameraState === 'loading' ? <Loader2 size={24} className="animate-spin text-neon-cyan" /> : <Camera size={24} className="text-white/40" />}
                        <p className="max-w-md text-[11px] leading-relaxed text-white/70">{cameraMessage}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="grid min-h-[580px] grid-cols-1 gap-4 bg-[#08090B] p-5 md:grid-cols-[1.2fr_0.8fr]">
                    <div className="relative overflow-hidden rounded-xl border border-neon-cyan/20 bg-black/70">
                      {processingPreviewUrl ? (
                        <>
                          <img src={processingPreviewUrl} alt="Live cropped document preview" className="h-full w-full object-contain" />
                          <motion.div
                            className="absolute inset-x-6 h-10 rounded-full bg-neon-cyan/20 blur-xl"
                            animate={{ top: ['12%', '78%', '12%'] }}
                            transition={{ duration: 1.7, repeat: Infinity, ease: 'linear' }}
                          />
                          <div className="absolute inset-0 border border-neon-cyan/30" />
                        </>
                      ) : (
                        <div className="flex h-full min-h-[480px] items-center justify-center">
                          <Loader2 size={28} className="animate-spin text-neon-cyan" />
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col justify-between rounded-xl border border-white/10 bg-black/40 p-4">
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-[0.3em] text-neon-cyan">
                          {batchDecisionState === 'prompt' ? 'CATOG Capture Agent' : 'Live Crop Widget'}
                        </div>
                        <div className="mt-2 text-lg font-semibold text-white">
                          {batchDecisionState === 'prompt'
                            ? 'Add another file?'
                            : batchDecisionState === 'finalizing'
                              ? `Starting analysis for ${batchCaptures.length} extracted file(s)`
                              : processingPhase === 'cropping'
                                ? 'Refining document edges'
                                : 'Sending corrected crop to CATOG'}
                        </div>
                        <p className="mt-2 text-[11px] leading-relaxed text-white/65">
                          {batchDecisionState === 'prompt'
                            ? 'CATOG finished extracting the latest capture. You can add another page now or stop and launch agent analysis for the full captured batch.'
                            : batchDecisionState === 'finalizing'
                              ? 'The capture queue is locked. CATOG is handing every extracted page into the agent pipeline now.'
                              : 'The camera feed is closed. CATOG is focusing on the corrected paper crop, straightening it, and preparing the live intake payload.'}
                        </p>
                      </div>
                      <div className="space-y-3">
                        <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                          <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-[0.2em] text-white/55">
                            <span>Extracted Queue</span>
                            <span>{batchCaptures.length}</span>
                          </div>
                          <div className="mt-3 space-y-2">
                            {batchCaptures.length === 0 ? (
                              <div className="text-[11px] text-white/40">No extracted pages yet.</div>
                            ) : (
                              batchCaptures.map((capture, index) => (
                                <div key={`${capture.sourceFileName}-${index}`} className="rounded-lg border border-white/5 bg-white/5 px-3 py-2">
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0 text-[11px] font-medium text-white">
                                      <div className="truncate">{index + 1}. {capture.name}</div>
                                      <div className="truncate text-[10px] text-white/35">{capture.sourceFileName}</div>
                                    </div>
                                    <div className="text-[10px] font-black uppercase tracking-[0.2em] text-success-green">Ready</div>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                        {lastPreparedCapture && (
                          <div className="rounded-lg border border-neon-cyan/20 bg-neon-cyan/5 p-3">
                            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-neon-cyan">Latest Extraction</div>
                            <div className="mt-2 text-[11px] font-semibold text-white">{lastPreparedCapture.name}</div>
                            <p className="mt-1 line-clamp-4 text-[11px] leading-relaxed text-white/65">{lastPreparedCapture.summary}</p>
                          </div>
                        )}
                        <div className="space-y-3">
                          {[
                            { id: 'locking', label: 'Locking paper edges' },
                            { id: 'cropping', label: 'Perspective crop + cleanup' },
                            { id: 'analyzing', label: 'Vision extraction + intake handoff' },
                          ].map((step, index) => {
                            const phaseOrder = { locking: 0, cropping: 1, analyzing: 2 } as const;
                            const currentOrder = phaseOrder[processingPhase];
                            const stepOrder = phaseOrder[step.id as keyof typeof phaseOrder];
                            const isActive = currentOrder === stepOrder && batchDecisionState === 'hidden';
                            const isDone = currentOrder > stepOrder || batchDecisionState !== 'hidden';
                            return (
                              <div key={step.id} className="flex items-center gap-3">
                                <div className={`h-2.5 w-2.5 rounded-full ${isDone ? 'bg-success-green' : isActive ? 'bg-neon-cyan animate-pulse' : 'bg-white/15'}`} />
                                <div className={`text-[11px] ${isDone ? 'text-success-green' : isActive ? 'text-white' : 'text-white/40'}`}>
                                  {index + 1}. {step.label}
                                </div>
                              </div>
                            );
                          })}
                          {batchDecisionState === 'prompt' ? (
                            <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
                              <button
                                onClick={handleCaptureAnother}
                                className="inline-flex items-center justify-center gap-2 rounded border border-neon-cyan/30 bg-neon-cyan/10 px-3 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-neon-cyan transition-all hover:bg-neon-cyan/20"
                              >
                                <Camera size={12} />
                                Add More Files
                              </button>
                              <button
                                onClick={() => void handleFinalizeBatch()}
                                disabled={isCaptureBusy}
                                className={`inline-flex items-center justify-center gap-2 rounded px-3 py-2 text-[10px] font-black uppercase tracking-[0.2em] transition-all ${isCaptureBusy
                                    ? 'cursor-not-allowed bg-white/5 text-white/20'
                                    : 'bg-success-green text-black hover:brightness-110'
                                  }`}
                              >
                                {isFinalizingBatch ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                                Stop & Analyze
                              </button>
                            </div>
                          ) : (
                            <div className="overflow-hidden rounded-full bg-white/10">
                              <motion.div
                                className="h-2 rounded-full bg-neon-cyan"
                                animate={{ x: ['-35%', '105%'] }}
                                transition={{ duration: 1.1, repeat: Infinity, ease: 'linear' }}
                                style={{ width: '45%' }}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => void handleCaptureClick()}
                  disabled={isCaptureBusy || cameraState !== 'ready' || capturePhase !== 'camera'}
                  className={`inline-flex items-center gap-2 rounded px-4 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${isCaptureBusy || cameraState !== 'ready' || capturePhase !== 'camera'
                      ? 'cursor-not-allowed bg-white/5 text-white/20'
                      : workflowMode === 'multiple' ? 'bg-neon-pink text-white hover:brightness-110' : 'bg-neon-cyan text-black hover:brightness-110'
                    }`}
                >
                  {isCaptureBusy ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
                  {workflowMode === 'multiple' ? 'Capture & Add to Batch' : 'Capture, Auto-Send & Analyze'}
                </button>
                <button
                  onClick={() => void startCamera()}
                  disabled={isCaptureBusy}
                  className="inline-flex items-center gap-2 rounded border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white/70 transition-all hover:bg-white/10 hover:text-neon-cyan disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RefreshCw size={12} />
                  {capturePhase === 'processing' ? 'Open Camera Again' : 'Restart Camera'}
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isCaptureBusy}
                  className="inline-flex items-center gap-2 rounded border border-neon-pink bg-neon-pink px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Upload size={12} />
                  Upload Image Instead
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    void handleUploadFallback(event);
                  }}
                />
                <button
                  onClick={() => {
                    setShowDebug((prev) => {
                      const next = !prev;
                      showDebugRef.current = next;
                      if (next) {
                        const { status, error } = getSessionStatus();
                        setDebugInfo((d) => ({ ...d, sessionStatus: status, sessionError: error }));
                      }
                      return next;
                    });
                  }}
                  className="ml-auto inline-flex items-center gap-2 rounded border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white/40 transition-all hover:bg-white/10 hover:text-neon-cyan"
                >
                  {showDebug ? '✕ Debug' : '⚙ Debug'}
                </button>
              </div>

              {showDebug && (
                <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/40 p-3 font-mono text-[10px] leading-5 text-amber-200/80">
                  <div className="mb-1 text-[9px] font-black uppercase tracking-widest text-amber-400">YOLO Detection Debug Panel</div>
                  <div><span className="text-amber-400">session:</span> <span className={debugInfo.sessionStatus === 'ready' ? 'text-green-400' : debugInfo.sessionStatus === 'error' ? 'text-red-400' : 'text-amber-300'}>{debugInfo.sessionStatus}</span></div>
                  {debugInfo.sessionError && <div className="break-all text-red-400"><span className="text-amber-400">session-err:</span> {debugInfo.sessionError}</div>}
                  <div><span className="text-amber-400">frames-processed:</span> {debugInfo.frameCount}</div>
                  <div><span className="text-amber-400">detections-after-nms:</span> {debugInfo.detectionCount}</div>
                  <div><span className="text-amber-400">quad-drawn:</span> <span className={debugInfo.quadIsSet ? 'text-green-400' : 'text-red-400'}>{debugInfo.quadIsSet ? 'yes' : 'no — no boxes passed threshold'}</span></div>
                  <div><span className="text-amber-400">confidence:</span> {debugInfo.confidence.toFixed(3)}</div>
                  <div><span className="text-amber-400">output-tensor:</span> {debugInfo.outputShape ?? 'waiting…'}</div>
                  <div><span className="text-amber-400">scratch-canvas:</span> {debugInfo.canvasDims}</div>
                  {debugInfo.lastError && <div className="mt-1 break-all text-red-400"><span className="text-amber-400">last-error:</span> {debugInfo.lastError}</div>}
                  <div className="mt-1 text-amber-400/50">WASM path: /ort/ · threads: 1 · simd: on</div>
                </div>
              )}

              <div className="mt-4 rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-[11px] leading-relaxed text-white/60">
                {cameraMessage}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
