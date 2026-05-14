import mammoth from 'mammoth/mammoth.browser';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_EXTRACTED_CHARS = 24000;
const MAX_PDF_PAGES = 20;

const normalizeExtractedText = (value: string) => (
  value
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
);

const buildFallbackContent = (file: File, reason: string) => [
  `Uploaded file: ${file.name}`,
  `Type: ${file.type || 'unknown'}`,
  `Size: ${file.size} bytes`,
  reason,
].join('\n');

const truncateExtractedText = (value: string) => normalizeExtractedText(value).slice(0, MAX_EXTRACTED_CHARS);

const readPdfText = async (file: File) => {
  const pdf = await getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');

    pageTexts.push(`[Page ${pageNumber}]\n${pageText}`);
  }

  await pdf.destroy();
  return truncateExtractedText(pageTexts.join('\n\n'));
};

const readDocxText = async (file: File) => {
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return truncateExtractedText(value);
};

export const readFileForAnalysis = async (file: File) => {
  const lowerName = file.name.toLowerCase();
  const isLikelyTextFile = file.type.startsWith('text/')
    || /\.(txt|md|json|csv|xml|html|js|ts|tsx|jsx|css|yml|yaml)$/i.test(lowerName);

  if (isLikelyTextFile) {
    return truncateExtractedText(await file.text());
  }

  try {
    if (file.type === 'application/pdf' || lowerName.endsWith('.pdf')) {
      const extractedPdfText = await readPdfText(file);
      if (extractedPdfText) {
        return extractedPdfText;
      }

      return buildFallbackContent(file, 'PDF text extraction completed but no readable text was found in the document.');
    }

    if (
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || lowerName.endsWith('.docx')
    ) {
      const extractedDocxText = await readDocxText(file);
      if (extractedDocxText) {
        return extractedDocxText;
      }

      return buildFallbackContent(file, 'DOCX text extraction completed but no readable text was found in the document.');
    }
  } catch (error) {
    return buildFallbackContent(
      file,
      error instanceof Error
        ? `Local document parsing failed: ${error.message}`
        : 'Local document parsing failed for this file.',
    );
  }

  return buildFallbackContent(
    file,
    'Binary document content is not yet parsed for this file type, so analysis will rely on filename metadata and configured knowledge-base context.',
  );
};
