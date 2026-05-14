import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun } from 'docx';
import { saveAs } from 'file-saver';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { DocumentAnalysis } from '../types';
import { buildMermaidChart, renderMermaidPng } from '../lib/mermaidChart';

type SaveFilter = {
  name: string;
  extensions: string[];
};

const getFileStem = (fileName: string) => fileName.replace(/\.[^/.]+$/, '');

const dataUrlToUint8Array = (dataUrl: string) => {
  const base64 = dataUrl.split(',')[1] || '';
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
};

const addPdfWrappedText = (pdf: jsPDF, text: string, x: number, y: number, maxWidth: number, lineHeight = 5) => {
  const lines = pdf.splitTextToSize(text, maxWidth);
  pdf.text(lines, x, y);
  return y + (lines.length * lineHeight);
};

const renderMermaidReportImage = async (doc: DocumentAnalysis) => {
  try {
    return await renderMermaidPng(buildMermaidChart(doc), {
      theme: 'default',
      fontFamily: 'Arial',
      backgroundColor: '#FFFFFF',
      scale: 2,
    });
  } catch (error) {
    console.error('Mermaid report render failed:', error);
    return null;
  }
};

const addMermaidSectionToPdf = async (pdf: jsPDF, doc: DocumentAnalysis, title: string) => {
  const mermaid = await renderMermaidReportImage(doc);

  pdf.addPage('landscape');
  const pageWidth = pdf.internal.pageSize.width;
  const pageHeight = pdf.internal.pageSize.height;
  pdf.setFillColor(13, 13, 15);
  pdf.rect(0, 0, pageWidth, 28, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.text(title, 15, 18);

  pdf.setTextColor(0, 0, 0);
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  pdf.text(`FILE: ${doc.fileName}`, 15, 36);

  if (!mermaid) {
    addPdfWrappedText(
      pdf,
      'Mermaid diagram was unavailable during export, so this report was generated without the diagram image.',
      15,
      50,
      pageWidth - 30,
      6,
    );
    return;
  }

  const maxImageWidth = pageWidth - 36;
  const maxImageHeight = pageHeight - 68;
  const imageScale = Math.min(maxImageWidth / mermaid.width, maxImageHeight / mermaid.height);
  const imageWidth = mermaid.width * imageScale;
  const imageHeight = mermaid.height * imageScale;
  pdf.setDrawColor(220, 220, 220);
  pdf.roundedRect(12, 40, pageWidth - 24, pageHeight - 52, 4, 4);
  pdf.addImage(
    mermaid.dataUrl,
    'PNG',
    (pageWidth - imageWidth) / 2,
    46,
    imageWidth,
    imageHeight,
  );
};

const buildMermaidDocxChildren = async (doc: DocumentAnalysis) => {
  const mermaid = await renderMermaidReportImage(doc);

  if (!mermaid) {
    return [
      new Paragraph({
        text: 'MERMAID DIAGRAM',
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 400, after: 200 },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: 'Mermaid diagram was unavailable during export, so this report was generated without the diagram image.',
            italics: true,
            color: '666666',
          }),
        ],
        spacing: { after: 200 },
      }),
    ];
  }

  const maxWidth = 620;
  const scale = Math.min(1, maxWidth / mermaid.width);

  return [
    new Paragraph({
      text: 'MERMAID DIAGRAM',
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 400, after: 200 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new ImageRun({
          data: dataUrlToUint8Array(mermaid.dataUrl),
          type: 'png',
          transformation: {
            width: Math.round(mermaid.width * scale),
            height: Math.round(mermaid.height * scale),
          },
        }),
      ],
      spacing: { after: 200 },
    }),
  ];
};

const persistGeneratedBlob = async (blob: Blob, defaultFileName: string, filter: SaveFilter) => {
  if (!isTauri()) {
    saveAs(blob, defaultFileName);
    return;
  }

  const targetPath = await save({
    defaultPath: defaultFileName,
    filters: [filter],
  });

  if (!targetPath) {
    return;
  }

  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  await invoke('save_binary_file', { path: targetPath, bytes, openAfterSave: true });
};

export const generateTxtReport = async (doc: DocumentAnalysis) => {
  const mermaidChart = buildMermaidChart(doc);
  const content = `
==================================================
ENTERPRISE INTELLIGENCE SOLUTION: FINAL REPORT
==================================================
DOCUMENT: ${doc.fileName}
TIMESTAMP: ${new Date().toLocaleString()}
STATUS: COMPLIANCE RUN COMPLETE
==================================================

SUMMARY:
- Total Findings: ${doc.findings.length}
- Total Gaps/Corrections: ${doc.corrections.length}
- Total Obligations: ${doc.obligations.length}
- Risk Level: CRITICAL (Automated mapping active)

DETAILED FINDINGS:
${doc.findings.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.type.toUpperCase()}: ${f.message}`).join('\n')}

MAPPED CORRECTIONS & GAP SYNC:
${doc.corrections.map((c, i) => `
[FIX ${i + 1}]
REASON: ${c.reason}
ORIGINAL: ${c.original || '(N/A)'}
SUGGESTED: ${c.suggested}
`).join('\n')}

OBLIGATION REGISTER:
${doc.obligations.map((obligation, i) => `
[OBLIGATION ${i + 1}]
TITLE: ${obligation.title}
OWNER: ${obligation.owner}
DUE/TRIGGER: ${obligation.dueDate}
PRIORITY: ${obligation.priority.toUpperCase()}
STATUS: ${obligation.status.toUpperCase()}
RATIONALE: ${obligation.rationale}
SOURCE: ${obligation.sourceExcerpt}
`).join('\n')}

MERMAID DIAGRAM:
${mermaidChart}

==================================================
END OF REPORT
==================================================
  `.trim();

  const blob = new Blob([content], { type: 'text/plain' });
  await persistGeneratedBlob(blob, `Report_${getFileStem(doc.fileName)}.txt`, {
    name: 'Text Report',
    extensions: ['txt'],
  });
};

export const generatePdfReport = async (doc: DocumentAnalysis) => {
  const pdf = new jsPDF();
  const pageWidth = pdf.internal.pageSize.width;
  
  // Header
  pdf.setFillColor(13, 13, 15);
  pdf.rect(0, 0, pageWidth, 40, 'F');
  
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(20);
  pdf.setFont('helvetica', 'bold');
  pdf.text('ENTERPRISE INTELLIGENCE REPORT', 15, 25);
  
  pdf.setFontSize(10);
  pdf.setTextColor(150, 150, 150);
  pdf.text(`GENERATE DATE: ${new Date().toLocaleString()}`, 15, 32);

  // Document Info
  pdf.setTextColor(0, 0, 0);
  pdf.setFontSize(14);
  pdf.text('DOCUMENT ANALYSIS SUMMARY', 15, 55);
  
  pdf.setFontSize(10);
  pdf.text(`Filename: ${doc.fileName}`, 15, 65);
  pdf.text(`Risk Status: CRITICAL`, 15, 72);
  pdf.text(`Total Findings: ${doc.findings.length}`, 15, 79);
  pdf.text(`Open Obligations: ${doc.obligations.length}`, 15, 86);

  // Table of Findings
  autoTable(pdf, {
    startY: 96,
    head: [['ID', 'SEVERITY', 'TYPE', 'MESSAGE']],
    body: doc.findings.map((f, i) => [i + 1, f.severity.toUpperCase(), f.type.toUpperCase(), f.message]),
    theme: 'striped',
    headStyles: { fillColor: [255, 45, 149], textColor: [255, 255, 255] },
    alternateRowStyles: { fillColor: [245, 245, 245] }
  });

  // Table of Corrections
  const finalY = (pdf as any).lastAutoTable.finalY + 15;
  pdf.setFontSize(14);
  pdf.text('MAPPED CORRECTIONS', 15, finalY);

  autoTable(pdf, {
    startY: finalY + 5,
    head: [['ID', 'REASON', 'SUGGESTED CORRECTION']],
    body: doc.corrections.map((c, i) => [i + 1, c.reason, c.suggested]),
    theme: 'grid',
    headStyles: { fillColor: [0, 242, 157], textColor: [0, 0, 0] },
    columnStyles: {
      2: { cellWidth: 100 }
    }
  });

  const obligationY = (pdf as any).lastAutoTable.finalY + 15;
  pdf.setFontSize(14);
  pdf.text('OBLIGATION REGISTER', 15, obligationY);

  autoTable(pdf, {
    startY: obligationY + 5,
    head: [['ID', 'OWNER', 'DUE / TRIGGER', 'PRIORITY', 'OBLIGATION']],
    body: doc.obligations.map((obligation, i) => [
      i + 1,
      obligation.owner,
      obligation.dueDate,
      obligation.priority.toUpperCase(),
      `${obligation.title}\n${obligation.rationale}`,
    ]),
    theme: 'grid',
    headStyles: { fillColor: [0, 210, 255], textColor: [0, 0, 0] },
    columnStyles: {
      0: { cellWidth: 12 },
      1: { cellWidth: 32 },
      2: { cellWidth: 34 },
      3: { cellWidth: 22 },
      4: { cellWidth: 80 },
    }
  });

  await addMermaidSectionToPdf(pdf, doc, 'MERMAID DIAGRAM');

  await persistGeneratedBlob(pdf.output('blob'), `Report_${getFileStem(doc.fileName)}.pdf`, {
    name: 'PDF Report',
    extensions: ['pdf'],
  });
};

export const generateConsolidatedTxtReport = async (docs: DocumentAnalysis[]) => {
  if (docs.length === 0) return;
  
  let content = `
==================================================
ENTERPRISE INTELLIGENCE SOLUTION: CONSOLIDATED COMPLIANCE REPORT
==================================================
GENERATED: ${new Date().toLocaleString()}
TOTAL DOCUMENTS: ${docs.length}
==================================================\n\n`;

  docs.forEach((doc, idx) => {
    content += `
DOCUMENT ${idx + 1}: ${doc.fileName}
--------------------------------------------------
SUMMARY:
- Findings: ${doc.findings.length}
- Corrections: ${doc.corrections.length}
- Obligations: ${doc.obligations.length}

FINDINGS:
${doc.findings.map((f, i) => `  ${i + 1}. [${f.severity.toUpperCase()}] ${f.type.toUpperCase()}: ${f.message}`).join('\n')}

CORRECTIONS:
${doc.corrections.map((c, i) => `  ${i + 1}. [REASON] ${c.reason} -> [SUGGESTED] ${c.suggested}`).join('\n')}

OBLIGATIONS:
${doc.obligations.map((obligation, i) => `  ${i + 1}. [${obligation.priority.toUpperCase()}] ${obligation.title} | OWNER ${obligation.owner} | DUE ${obligation.dueDate}`).join('\n')}

MERMAID DIAGRAM:
${buildMermaidChart(doc)}

--------------------------------------------------
`;
  });

  content += `\n==================================================\nEND OF CONSOLIDATED REPORT`;

  const blob = new Blob([content], { type: 'text/plain' });
  await persistGeneratedBlob(blob, `Consolidated_Report_${Date.now()}.txt`, {
    name: 'Text Report',
    extensions: ['txt'],
  });
};

export const generateConsolidatedPdfReport = async (docs: DocumentAnalysis[]) => {
  if (docs.length === 0) return;
  
  const pdf = new jsPDF();
  const pageWidth = pdf.internal.pageSize.width;
  
  for (const [idx, doc] of docs.entries()) {
    if (idx > 0) pdf.addPage();
    
    // Header
    pdf.setFillColor(13, 13, 15);
    pdf.rect(0, 0, pageWidth, 40, 'F');
    
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(16);
    pdf.setFont('helvetica', 'bold');
    pdf.text(`CONSOLIDATED REPORT | DOC ${idx + 1}/${docs.length}`, 15, 25);
    
    pdf.setFontSize(10);
    pdf.setTextColor(150, 150, 150);
    pdf.text(`FILE: ${doc.fileName}`, 15, 32);

    // Document Info
    pdf.setTextColor(0, 0, 0);
    pdf.setFontSize(14);
    pdf.text('DOCUMENT ANALYSIS SUMMARY', 15, 55);
    
    pdf.setFontSize(10);
    pdf.text(`Risk Status: CRITICAL`, 15, 65);
    pdf.text(`Total Findings: ${doc.findings.length}`, 15, 72);
    pdf.text(`Open Obligations: ${doc.obligations.length}`, 15, 79);

    // Table of Findings
    autoTable(pdf, {
      startY: 92,
      head: [['ID', 'SEVERITY', 'TYPE', 'MESSAGE']],
      body: doc.findings.map((f, i) => [i + 1, f.severity.toUpperCase(), f.type.toUpperCase(), f.message]),
      theme: 'striped',
      headStyles: { fillColor: [0, 210, 255], textColor: [0, 0, 0] },
      alternateRowStyles: { fillColor: [245, 245, 245] }
    });

    // Table of Corrections
    const finalY = (pdf as any).lastAutoTable.finalY + 15;
    pdf.setFontSize(14);
    pdf.text('MAPPED CORRECTIONS', 15, finalY);

    autoTable(pdf, {
      startY: finalY + 5,
      head: [['ID', 'REASON', 'SUGGESTED CORRECTION']],
      body: doc.corrections.map((c, i) => [i + 1, c.reason, c.suggested]),
      theme: 'grid',
      headStyles: { fillColor: [255, 255, 0], textColor: [0, 0, 0] },
      columnStyles: {
        2: { cellWidth: 100 }
      }
    });

    const obligationY = (pdf as any).lastAutoTable.finalY + 15;
    pdf.setFontSize(14);
    pdf.text('OBLIGATION REGISTER', 15, obligationY);

    autoTable(pdf, {
      startY: obligationY + 5,
      head: [['ID', 'OWNER', 'DUE / TRIGGER', 'PRIORITY', 'OBLIGATION']],
      body: doc.obligations.map((obligation, i) => [
        i + 1,
        obligation.owner,
        obligation.dueDate,
        obligation.priority.toUpperCase(),
        `${obligation.title}\n${obligation.rationale}`,
      ]),
      theme: 'grid',
      headStyles: { fillColor: [0, 210, 255], textColor: [0, 0, 0] },
      columnStyles: {
        0: { cellWidth: 12 },
        1: { cellWidth: 32 },
        2: { cellWidth: 34 },
        3: { cellWidth: 22 },
        4: { cellWidth: 80 },
      }
    });

    await addMermaidSectionToPdf(pdf, doc, `MERMAID DIAGRAM | DOC ${idx + 1}/${docs.length}`);
  }

  await persistGeneratedBlob(pdf.output('blob'), `Consolidated_Report_${Date.now()}.pdf`, {
    name: 'PDF Report',
    extensions: ['pdf'],
  });
};

export const generateConsolidatedDocxReport = async (docs: DocumentAnalysis[]) => {
  if (docs.length === 0) return;

  const sections = await Promise.all(docs.map(async (doc, idx) => ({
    properties: {
      type: idx > 0 ? "nextPage" as any : undefined
    },
    children: [
      new Paragraph({
        text: `CONSOLIDATED REPORT: ${doc.fileName}`,
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({
        text: `Analysis ${idx + 1} of ${docs.length}`,
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({
        children: [
          new TextRun({ text: `Timestamp: ${new Date().toLocaleString()}`, bold: true }),
        ],
        spacing: { after: 200, before: 200 },
      }),
      new Paragraph({
        text: `Obligations: ${doc.obligations.length}`,
        spacing: { after: 200 },
      }),
      
      new Paragraph({
        text: "DETAILED FINDINGS",
        heading: HeadingLevel.HEADING_3,
      }),
      ...doc.findings.flatMap((f, i) => [
        new Paragraph({
          children: [
            new TextRun({ text: `Finding ${i + 1} [${f.severity.toUpperCase()}]: `, bold: true }),
            new TextRun(f.message),
          ]
        })
      ]),

      new Paragraph({
        text: "MAPPED CORRECTIONS",
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 400 },
      }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "ID", bold: true })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "REASON", bold: true })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "SUGGESTED", bold: true })] })] }),
            ]
          }),
          ...doc.corrections.map((c, i) => new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(String(i + 1))] }),
              new TableCell({ children: [new Paragraph(c.reason)] }),
              new TableCell({ children: [new Paragraph(c.suggested)] }),
            ]
          }))
        ]
      }),
      new Paragraph({
        text: "OBLIGATION REGISTER",
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 400 },
      }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "ID", bold: true })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "OWNER", bold: true })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "DUE / TRIGGER", bold: true })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "OBLIGATION", bold: true })] })] }),
            ]
          }),
          ...doc.obligations.map((obligation, i) => new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(String(i + 1))] }),
              new TableCell({ children: [new Paragraph(obligation.owner)] }),
              new TableCell({ children: [new Paragraph(obligation.dueDate)] }),
              new TableCell({ children: [new Paragraph(`${obligation.title} — ${obligation.rationale}`)] }),
            ]
          }))
        ]
      }),
      ...(await buildMermaidDocxChildren(doc)),
    ],
  })));

  const docx = new Document({
    sections,
  });

  const blob = await Packer.toBlob(docx);
  await persistGeneratedBlob(blob, `Consolidated_Report_${Date.now()}.docx`, {
    name: 'Word Report',
    extensions: ['docx'],
  });
};

export const generateDocxReport = async (doc: DocumentAnalysis) => {
  const mermaidDocxChildren = await buildMermaidDocxChildren(doc);
  const docx = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          text: "ENTERPRISE INTELLIGENCE SOLUTION",
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({
          text: `Final Analysis Report: ${doc.fileName}`,
          heading: HeadingLevel.HEADING_2,
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({
          children: [
            new TextRun({ text: `Timestamp: ${new Date().toLocaleString()}`, bold: true }),
          ],
          spacing: { after: 200 },
        }),
        
        new Paragraph({
          text: "SUMMARY INFO",
          heading: HeadingLevel.HEADING_3,
        }),
        new Paragraph({ text: `Risk Assessment: CRITICAL` }),
        new Paragraph({ text: `Total Identified Risks: ${doc.findings.length}` }),
        new Paragraph({ text: `Automated Corrections: ${doc.corrections.length}` }),
        new Paragraph({ text: `Tracked Obligations: ${doc.obligations.length}`, spacing: { after: 400 } }),

        new Paragraph({
          text: "DETAILED FINDINGS",
          heading: HeadingLevel.HEADING_3,
        }),
        ...doc.findings.flatMap((f, i) => [
          new Paragraph({
            children: [
              new TextRun({ text: `Finding ${i + 1} [${f.severity.toUpperCase()}]: `, bold: true }),
              new TextRun(f.message),
            ]
          })
        ]),

        new Paragraph({
          text: "MAPPED CORRECTIONS",
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 400 },
        }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "ID", bold: true })] })] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "REASON", bold: true })] })] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "SUGGESTED", bold: true })] })] }),
              ]
            }),
             ...doc.corrections.map((c, i) => new TableRow({
               children: [
                 new TableCell({ children: [new Paragraph(String(i + 1))] }),
                 new TableCell({ children: [new Paragraph(c.reason)] }),
                 new TableCell({ children: [new Paragraph(c.suggested)] }),
               ]
              }))
            ]
          }),
        new Paragraph({
          text: "OBLIGATION REGISTER",
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 400 },
        }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "ID", bold: true })] })] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "OWNER", bold: true })] })] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "DUE / TRIGGER", bold: true })] })] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "OBLIGATION", bold: true })] })] }),
              ]
            }),
             ...doc.obligations.map((obligation, i) => new TableRow({
               children: [
                 new TableCell({ children: [new Paragraph(String(i + 1))] }),
                 new TableCell({ children: [new Paragraph(obligation.owner)] }),
                 new TableCell({ children: [new Paragraph(obligation.dueDate)] }),
                 new TableCell({ children: [new Paragraph(`${obligation.title} — ${obligation.rationale}`)] }),
               ]
             }))
           ]
         }),
          ...mermaidDocxChildren,
       ],
     }],
   });

  const blob = await Packer.toBlob(docx);
  await persistGeneratedBlob(blob, `Report_${getFileStem(doc.fileName)}.docx`, {
    name: 'Word Report',
    extensions: ['docx'],
  });
};
