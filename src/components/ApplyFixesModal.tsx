/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, CheckSquare, Square, FileText, Download, Wand2, ChevronRight, AlertCircle } from 'lucide-react';
import { jsPDF } from 'jspdf';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { saveAs } from 'file-saver';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { DocumentAnalysis, Correction } from '../types';

interface UploadedFile {
  name: string;
  content: string;
}

interface ApplyFixesModalProps {
  isOpen: boolean;
  onClose: () => void;
  analyses: DocumentAnalysis[];
  uploadedFiles: UploadedFile[];
  initialAnalysisId?: string | null;
}

type ExportFormat = 'txt' | 'docx' | 'pdf';

const getFileStem = (fileName: string) => fileName.replace(/\.[^/.]+$/, '');

const guessFormat = (fileName: string): ExportFormat => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (ext === 'pdf') return 'pdf';
  return 'txt';
};

const applyTextFixes = (
  originalContent: string,
  corrections: Correction[],
  selected: Set<number>,
): string => {
  let fixed = originalContent;
  const applied: Correction[] = [];
  const appended: Correction[] = [];

  corrections.forEach((c, idx) => {
    if (!selected.has(idx)) return;
    if (c.original && fixed.includes(c.original)) {
      fixed = fixed.replace(c.original, c.suggested);
      applied.push(c);
    } else {
      appended.push(c);
    }
  });

  const header = [
    '='.repeat(60),
    'CATOG CORRECTED DOCUMENT',
    `SOURCE: ${originalContent ? 'Uploaded file' : 'No original content'}`,
    `APPLIED: ${applied.length} inline replacements`,
    `APPENDED: ${appended.length} additional corrections`,
    `GENERATED: ${new Date().toLocaleString()}`,
    '='.repeat(60),
    '',
  ].join('\n');

  let appendSection = '';
  if (appended.length > 0) {
    appendSection = [
      '',
      '='.repeat(60),
      'ADDITIONAL CORRECTIONS (no inline anchor found)',
      '='.repeat(60),
      ...appended.flatMap((c, i) => [
        ``,
        `[CORRECTION ${i + 1}]`,
        `Reason: ${c.reason}`,
        `Suggested: ${c.suggested}`,
      ]),
      '',
      '='.repeat(60),
    ].join('\n');
  }

  return header + fixed + appendSection;
};

const persistBlob = async (blob: Blob, defaultFileName: string, ext: string, label: string) => {
  if (!isTauri()) {
    saveAs(blob, defaultFileName);
    return;
  }
  const path = await save({
    defaultPath: defaultFileName,
    filters: [{ name: label, extensions: [ext] }],
  });
  if (!path) return;
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  await invoke('save_binary_file', { path, bytes, openAfterSave: true });
};

const generateFixed = async (
  analysis: DocumentAnalysis,
  originalContent: string,
  corrections: Correction[],
  selected: Set<number>,
  format: ExportFormat,
) => {
  const stem = getFileStem(analysis.fileName);
  const fixedText = applyTextFixes(originalContent, corrections, selected);

  if (format === 'txt') {
    const blob = new Blob([fixedText], { type: 'text/plain' });
    await persistBlob(blob, `Fixed_${stem}.txt`, 'txt', 'Text Document');
    return;
  }

  if (format === 'docx') {
    const paragraphs: Paragraph[] = [
      new Paragraph({
        text: `CATOG CORRECTED: ${analysis.fileName}`,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 300 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: `Generated: ${new Date().toLocaleString()}`, italics: true, color: '888888' }),
        ],
        spacing: { after: 400 },
      }),
      new Paragraph({
        text: 'CORRECTED CONTENT',
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 200 },
      }),
      ...fixedText.split('\n').map((line) =>
        new Paragraph({
          children: [new TextRun({ text: line || ' ', size: 22 })],
          spacing: { after: 120 },
        }),
      ),
      new Paragraph({
        text: 'CORRECTIONS SUMMARY',
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 },
      }),
      ...corrections.flatMap((c, idx) =>
        selected.has(idx)
          ? [
              new Paragraph({
                children: [
                  new TextRun({ text: `[FIX ${idx + 1}] `, bold: true, color: '00F29D' }),
                  new TextRun({ text: c.reason, size: 22 }),
                ],
                spacing: { after: 100 },
              }),
              c.original
                ? new Paragraph({
                    children: [
                      new TextRun({ text: '  ORIGINAL: ', bold: true, color: 'FF2D95' }),
                      new TextRun({ text: c.original, size: 20, strike: true }),
                    ],
                    spacing: { after: 80 },
                  })
                : new Paragraph({ text: '' }),
              new Paragraph({
                alignment: AlignmentType.LEFT,
                children: [
                  new TextRun({ text: '  SUGGESTED: ', bold: true, color: '00F29D' }),
                  new TextRun({ text: c.suggested, size: 20 }),
                ],
                spacing: { after: 200 },
              }),
            ]
          : [],
      ),
    ];

    const doc = new Document({ sections: [{ children: paragraphs }] });
    const buf = await Packer.toBlob(doc);
    await persistBlob(buf, `Fixed_${stem}.docx`, 'docx', 'Word Document');
    return;
  }

  if (format === 'pdf') {
    const pdf = new jsPDF();
    const pageWidth = pdf.internal.pageSize.width;
    const margin = 15;
    const maxWidth = pageWidth - margin * 2;
    let y = 15;

    const addText = (text: string, size: number, bold = false, color: [number, number, number] = [0, 0, 0]) => {
      pdf.setFontSize(size);
      pdf.setFont('helvetica', bold ? 'bold' : 'normal');
      pdf.setTextColor(...color);
      const lines = pdf.splitTextToSize(text, maxWidth);
      lines.forEach((line: string) => {
        if (y > pdf.internal.pageSize.height - 20) {
          pdf.addPage();
          y = 20;
        }
        pdf.text(line, margin, y);
        y += size * 0.45;
      });
      y += 4;
    };

    pdf.setFillColor(13, 13, 15);
    pdf.rect(0, 0, pageWidth, 28, 'F');
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(255, 255, 255);
    pdf.text(`CATOG CORRECTED: ${analysis.fileName}`, margin, 18);
    y = 38;

    addText(`Generated: ${new Date().toLocaleString()}`, 9, false, [100, 100, 100]);
    y += 4;
    addText('CORRECTED CONTENT', 13, true, [0, 0, 0]);

    fixedText.split('\n').forEach((line) => addText(line || ' ', 9));

    y += 8;
    addText('CORRECTIONS APPLIED', 13, true, [0, 0, 0]);

    corrections.forEach((c, idx) => {
      if (!selected.has(idx)) return;
      addText(`[FIX ${idx + 1}] ${c.reason}`, 10, true, [0, 180, 100]);
      if (c.original) addText(`ORIGINAL: ${c.original}`, 9, false, [200, 50, 50]);
      addText(`SUGGESTED: ${c.suggested}`, 9, false, [30, 130, 80]);
      y += 4;
    });

    const blob = pdf.output('blob');
    await persistBlob(blob, `Fixed_${stem}.pdf`, 'pdf', 'PDF Document');
  }
};

export default function ApplyFixesModal({
  isOpen,
  onClose,
  analyses,
  uploadedFiles,
  initialAnalysisId = null,
}: ApplyFixesModalProps) {
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(null);
  const [selectedCorrections, setSelectedCorrections] = useState<Set<number>>(new Set());
  const [format, setFormat] = useState<ExportFormat>('txt');
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const currentAnalysis = useMemo(
    () => analyses.find((a) => a.id === selectedAnalysisId) ?? (analyses.length === 1 ? analyses[0] : null),
    [analyses, selectedAnalysisId],
  );

  useEffect(() => {
    if (!isOpen) return;

    if (initialAnalysisId) {
      setSelectedAnalysisId(initialAnalysisId);
      return;
    }

    setSelectedAnalysisId(analyses.length === 1 ? analyses[0].id : null);
  }, [analyses, initialAnalysisId, isOpen]);

  // Auto-populate corrections whenever the active analysis changes (fixes empty-set bug)
  useEffect(() => {
    if (!currentAnalysis) return;
    setSelectedCorrections(new Set(currentAnalysis.corrections.map((_, i) => i)));
    setFormat(guessFormat(currentAnalysis.fileName));
    setErrorMsg(null);
  }, [currentAnalysis?.id]);

  const matchedFile = useMemo(
    () => currentAnalysis ? uploadedFiles.find((f) => f.name === currentAnalysis.fileName) : null,
    [currentAnalysis, uploadedFiles],
  );

  const selectAll = () => {
    if (!currentAnalysis) return;
    setSelectedCorrections(new Set(currentAnalysis.corrections.map((_, i) => i)));
  };

  const selectNone = () => setSelectedCorrections(new Set());

  const toggleCorrection = (idx: number) => {
    setSelectedCorrections((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleSelectAnalysis = (analysis: DocumentAnalysis) => {
    setSelectedAnalysisId(analysis.id);
    setFormat(guessFormat(analysis.fileName));
    setSelectedCorrections(new Set(analysis.corrections.map((_, i) => i)));
  };

  const handleApply = async () => {
    if (!currentAnalysis || selectedCorrections.size === 0) return;
    setIsGenerating(true);
    setErrorMsg(null);
    try {
      await generateFixed(
        currentAnalysis,
        matchedFile?.content ?? '',
        currentAnalysis.corrections,
        selectedCorrections,
        format,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGenerating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="apply-fixes-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            key="apply-fixes-panel"
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 340, damping: 30 }}
            className="relative w-[700px] max-h-[85vh] flex flex-col bg-[#0D0D0F] border border-white/10 rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-black/40">
              <div className="flex items-center gap-3">
                <Wand2 size={14} className="text-success-green" />
                <span className="text-[11px] font-black uppercase tracking-[0.25em] text-white">Apply Fixes</span>
                {currentAnalysis && (
                  <span className="text-[9px] text-white/40 font-mono">{currentAnalysis.fileName}</span>
                )}
              </div>
              <button
                onClick={onClose}
                className="text-white/30 hover:text-white transition-colors p-1 rounded hover:bg-white/5"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex flex-1 overflow-hidden">
              {/* Analysis selector (left) */}
              {analyses.length > 1 && !currentAnalysis && (
                <div className="w-52 border-r border-white/5 overflow-y-auto custom-scrollbar p-3 space-y-1.5">
                  <p className="text-[9px] uppercase tracking-widest font-black text-white/30 px-2 mb-2">Select document</p>
                  {analyses.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => handleSelectAnalysis(a)}
                      className="w-full text-left p-2 rounded-lg border border-white/5 hover:border-success-green/30 hover:bg-success-green/5 transition-all group flex items-center gap-2"
                    >
                      <FileText size={11} className="text-white/30 group-hover:text-success-green shrink-0" />
                      <span className="text-[10px] text-white/60 group-hover:text-white truncate">{a.fileName}</span>
                      <ChevronRight size={10} className="shrink-0 text-white/10 group-hover:text-success-green ml-auto" />
                    </button>
                  ))}
                </div>
              )}

              {/* Main content */}
              <div className="flex-1 flex flex-col overflow-hidden">
                {!currentAnalysis ? (
                  analyses.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-white/20 gap-3">
                      <AlertCircle size={28} strokeWidth={1} />
                      <p className="text-[10px] uppercase tracking-widest font-bold">No analyses to apply fixes to</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-white/20 gap-3">
                      <Wand2 size={28} strokeWidth={1} />
                      <p className="text-[10px] uppercase tracking-widest font-bold">Select a document on the left</p>
                    </div>
                  )
                ) : (
                  <>
                    {/* File warning */}
                    {!matchedFile && (
                      <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-neon-yellow/10 border border-neon-yellow/20 text-[10px] text-neon-yellow">
                        Original file not found in session — corrections will be appended without inline replacements. Re-upload the file to enable inline fixes.
                      </div>
                    )}

                    {/* Correction list */}
                    <div className="flex items-center justify-between px-4 pt-4 pb-2">
                      <span className="text-[9px] uppercase tracking-widest font-black text-white/40">
                        Corrections — {selectedCorrections.size} / {currentAnalysis.corrections.length} selected
                      </span>
                      <div className="flex gap-2">
                        <button onClick={selectAll} className="text-[9px] uppercase font-black tracking-widest text-success-green hover:brightness-110">All</button>
                        <span className="text-white/20">·</span>
                        <button onClick={selectNone} className="text-[9px] uppercase font-black tracking-widest text-error-red hover:brightness-110">None</button>
                      </div>
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar px-4 space-y-2 pb-4">
                      {currentAnalysis.corrections.map((c, idx) => {
                        const isSelected = selectedCorrections.has(idx);
                        return (
                          <div
                            key={idx}
                            onClick={() => toggleCorrection(idx)}
                            className={`cursor-pointer rounded-lg border p-3 transition-all ${
                              isSelected
                                ? 'border-success-green/30 bg-success-green/5'
                                : 'border-white/5 bg-white/[0.02] opacity-50'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              {isSelected
                                ? <CheckSquare size={13} className="text-success-green shrink-0 mt-0.5" />
                                : <Square size={13} className="text-white/20 shrink-0 mt-0.5" />}
                              <div className="flex-1 min-w-0 space-y-1.5">
                                <p className="text-[11px] font-bold text-white/80">{c.reason}</p>
                                {c.original && (
                                  <div className="flex items-start gap-1.5 bg-error-red/5 rounded px-2 py-1">
                                    <span className="text-[10px] font-black text-error-red shrink-0">REMOVE:</span>
                                    <span className="text-[10px] text-white/50 line-through italic">{c.original.slice(0, 140)}</span>
                                  </div>
                                )}
                                <div className="flex items-start gap-1.5 bg-success-green/5 rounded px-2 py-1">
                                  <span className="text-[10px] font-black text-success-green shrink-0">ADD:</span>
                                  <span className="text-[10px] text-white/70">{c.suggested.slice(0, 200)}</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Footer */}
            {currentAnalysis && (
              <div className="px-6 py-3 border-t border-white/5 bg-black/40 flex flex-col gap-2">
                {errorMsg && (
                  <div className="text-[9px] text-error-red bg-error-red/10 border border-error-red/20 rounded px-3 py-1.5">
                    {errorMsg}
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <span className="text-[9px] uppercase tracking-widest font-black text-white/30 mr-1">Save as</span>
                {(['txt', 'docx', 'pdf'] as ExportFormat[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormat(f)}
                    className={`px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest transition-all ${
                      format === f
                        ? 'bg-success-green text-black'
                        : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    .{f}
                  </button>
                ))}
                <div className="flex-1" />
                <button
                  onClick={handleApply}
                  disabled={isGenerating || selectedCorrections.size === 0}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                    isGenerating || selectedCorrections.size === 0
                      ? 'bg-white/5 text-white/20 cursor-not-allowed'
                      : 'bg-success-green text-black hover:brightness-110 active:scale-95'
                  }`}
                >
                  <Download size={12} />
                  {isGenerating ? 'Generating...' : `Apply ${selectedCorrections.size} Fix${selectedCorrections.size !== 1 ? 'es' : ''} & Download`}
                </button>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
