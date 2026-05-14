import mermaid from 'mermaid';
import { DocumentAnalysis } from '../types';

let mermaidInitialized = false;
let mermaidConfigKey = '';

type MermaidRenderOptions = {
  theme?: 'dark' | 'default';
  fontFamily?: string;
  backgroundColor?: string;
  scale?: number;
};

const ensureMermaidInitialized = (options: MermaidRenderOptions = {}) => {
  const theme = options.theme || 'dark';
  const fontFamily = options.fontFamily || 'JetBrains Mono';
  const nextConfigKey = `${theme}::${fontFamily}`;

  if (mermaidInitialized && mermaidConfigKey === nextConfigKey) {
    return;
  }

  mermaid.initialize({
    startOnLoad: true,
    theme,
    securityLevel: 'loose',
    fontFamily,
    flowchart: {
      useMaxWidth: false,
    },
  });

  mermaidInitialized = true;
  mermaidConfigKey = nextConfigKey;
};

export const escapeMermaidText = (value: string) => value
  .replace(/["`]/g, '\'')
  .replace(/[\[\]{}()|<>#;]/g, ' ')
  .replace(/\n/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120) || 'N/A';

export const buildMermaidChart = (doc: DocumentAnalysis) => {
  const graphNodes = (doc.graph?.nodes || [])
    .filter((node) => node.kind !== 'document')
    .slice(0, 6);
  const graphLinks = (doc.graph?.links || []).slice(0, 6);
  const findings = doc.findings.slice(0, 3);
  const corrections = doc.corrections.slice(0, 3);
  const obligations = doc.obligations.slice(0, 3);

  const graphNodeBlocks = graphNodes.length > 0
    ? graphNodes.map((node, index) => `    G${index}["${escapeMermaidText(node.label)}\\n${escapeMermaidText(node.kind)}"]`).join('\n')
    : doc.graphIndex
      ? `    G0["${escapeMermaidText(`${doc.graphIndex.nodeCount} nodes | ${doc.graphIndex.edgeCount} edges`)}"]`
      : '    G0["No graph nodes indexed"]';
  const graphLinkBlocks = graphLinks.map((link) => {
    const sourceIndex = graphNodes.findIndex((node) => node.id === link.source);
    const targetIndex = graphNodes.findIndex((node) => node.id === link.target);
    if (sourceIndex === -1 || targetIndex === -1) {
      return '';
    }

    return `    G${sourceIndex} -->|${escapeMermaidText(link.label)}| G${targetIndex}`;
  }).filter(Boolean).join('\n');

  const findingBlocks = findings.map((finding, index) => `    F${index}["${escapeMermaidText(`${finding.severity.toUpperCase()}: ${finding.message}`)}"]`).join('\n');
  const correctionBlocks = corrections.map((correction, index) => `    C${index}["${escapeMermaidText(correction.suggested)}"]`).join('\n');
  const obligationBlocks = obligations.map((obligation, index) => `    O${index}["${escapeMermaidText(`${obligation.title} | ${obligation.owner} | ${obligation.dueDate}`)}"]`).join('\n');
  const findingEdges = findings.map((_, index) => `    DOC --> F${index}`).join('\n');
  const correctionEdges = corrections.map((_, index) => `    F${Math.min(index, Math.max(findings.length - 1, 0))} --> C${index}`).join('\n');
  const obligationEdges = obligations.map((_, index) => `    C${Math.min(index, Math.max(corrections.length - 1, 0))} --> O${index}`).join('\n');
  
  const graphEdgesFromIdx = graphNodes.length > 0
    ? graphNodes.map((_, index) => `    IDX --> G${index}`).join('\n')
    : '    IDX --> G0';

  return `
flowchart LR
    DOC["${escapeMermaidText(doc.fileName)}"]
    
    subgraph Security_Audit [LobsterTrap DPI]
        LBT["Security Verdict: ${escapeMermaidText(doc.lobstertrap?.verdict || 'Active Monitoring')}"]
        HALL["Hallucination: ${doc.lobstertrap?.egress?.detected?.contains_hallucination ? 'DETECTED' : 'CLEAR'}"]
        LBT --> HALL
    end
    DOC --> LBT

    subgraph Neural_Graph [Graph Indexing]
        IDX["Index: ${escapeMermaidText(doc.graphIndex?.graphName || 'FalkorDB Live')}"]
        ${graphNodeBlocks}
    end
    DOC --> IDX
    ${graphEdgesFromIdx}
    ${graphLinkBlocks}

    subgraph Findings
        ${findingBlocks || '    F0["No findings captured"]'}
    end

    subgraph Corrections
        ${correctionBlocks || '    C0["No corrections captured"]'}
    end

    subgraph Obligations
        ${obligationBlocks || '    O0["No obligations captured"]'}
    end

    ${findingEdges || '    DOC --> F0'}
    ${correctionEdges || '    F0 --> C0'}
    ${obligationEdges || '    C0 --> O0'}
  `;
};

export const renderMermaidSvg = async (chart: string, options: MermaidRenderOptions = {}) => {
  ensureMermaidInitialized(options);
  const { svg } = await mermaid.render(`mermaid-export-${Math.random().toString(36).slice(2, 11)}`, chart);
  return svg;
};

const parseSvgDimensions = (svg: string) => {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const svgElement = doc.documentElement;
  const viewBox = svgElement.getAttribute('viewBox')?.split(/\s+/).map(Number) || [];
  const width = Number(svgElement.getAttribute('width')?.replace(/[^\d.]/g, ''));
  const height = Number(svgElement.getAttribute('height')?.replace(/[^\d.]/g, ''));

  return {
    width: Number.isFinite(width) && width > 0 ? width : (viewBox[2] || 1200),
    height: Number.isFinite(height) && height > 0 ? height : (viewBox[3] || 700),
  };
};

const svgToDataUrl = (svg: string) => {
  const encoded = btoa(
    Array.from(new TextEncoder().encode(svg))
      .map((byte) => String.fromCharCode(byte))
      .join(''),
  );
  return `data:image/svg+xml;base64,${encoded}`;
};

export const renderMermaidPng = async (chart: string, options: MermaidRenderOptions = {}) => {
  const svg = await renderMermaidSvg(chart, options);
  const { width, height } = parseSvgDimensions(svg);
  const pixelScale = options.scale || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * pixelScale);
  canvas.height = Math.round(height * pixelScale);

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas rendering is unavailable for Mermaid export.');
  }
  context.scale(pixelScale, pixelScale);

  await new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      context.fillStyle = options.backgroundColor || '#0D0D0F';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      resolve();
    };
    image.onerror = () => reject(new Error('Mermaid image conversion failed.'));
    image.src = svgToDataUrl(svg);
  });

  return {
    width,
    height,
    dataUrl: canvas.toDataURL('image/png'),
  };
};
