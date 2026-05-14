import { DocumentAnalysis, KnowledgeGraphData, KnowledgeGraphIndex } from '../types';

const LOCAL_ANALYSIS_GRAPH_NAME = 'LOCAL_ANALYSIS_GRAPH';
const GRAPH_STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'agreement', 'because', 'before', 'between', 'clause', 'compliance',
  'contract', 'correction', 'corrections', 'document', 'during', 'enterprise', 'finding', 'findings',
  'following', 'including', 'information', 'legal', 'notice', 'obligation', 'obligations', 'other', 'party',
  'policy', 'process', 'requirement', 'section', 'service', 'shall', 'should', 'their', 'there', 'these',
  'those', 'under', 'which', 'with', 'without',
]);

const sanitizeId = (value: string) => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'node';

const normalizeSummaryText = (analysis: DocumentAnalysis) => [
  analysis.fileName,
  ...analysis.findings.map((finding) => finding.message),
  ...analysis.corrections.map((correction) => `${correction.reason}. ${correction.suggested}`),
  ...analysis.obligations.map((obligation) => `${obligation.title}. ${obligation.owner}. ${obligation.dueDate}. ${obligation.rationale}`),
].join('\n');

const extractGraphTerms = (summaryText: string) => {
  const normalizedText = summaryText.replace(/\s+/g, ' ').trim();
  const termCounts = new Map<string, number>();
  const sentenceTerms: string[][] = [];

  const sentences = normalizedText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  sentences.forEach((sentence) => {
    const matches = sentence.match(/\b[A-Za-z][A-Za-z0-9-]{3,}(?:\s+[A-Za-z][A-Za-z0-9-]{3,}){0,2}\b/g) || [];
    const terms = matches
      .map((term) => term.trim())
      .filter((term) => {
        const normalizedTerm = term.toLowerCase();
        return normalizedTerm.length > 3 && !GRAPH_STOP_WORDS.has(normalizedTerm);
      });

    sentenceTerms.push(terms);
    terms.forEach((term) => {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    });
  });

  const terms = Array.from(termCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([label]) => label);

  return {
    terms,
    sentenceTerms,
  };
};

const buildFallbackLabels = (analysis: DocumentAnalysis) => {
  const labels = [
    analysis.findings[0]?.message,
    analysis.corrections[0]?.suggested,
    analysis.obligations[0]?.title,
    analysis.fileName.replace(/\.[^/.]+$/, ''),
    'Correction Plan',
    'Obligation Register',
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .slice(0, 6);

  return labels.length > 0 ? labels : ['Analysis Overview'];
};

export const buildLocalAnalysisGraphSnapshot = (
  analysis: DocumentAnalysis,
  knowledgeBaseId = 'local-analysis',
  knowledgeBaseName = 'Local Analysis Graph',
  summaryTextOverride?: string,
): { graph: KnowledgeGraphData; graphIndex: KnowledgeGraphIndex } => {
  const sourceDocumentId = analysis.id || sanitizeId(analysis.fileName);
  const summaryText = summaryTextOverride?.trim() || normalizeSummaryText(analysis);
  const { terms, sentenceTerms } = extractGraphTerms(summaryText);
  const labels = terms.length > 0 ? terms : buildFallbackLabels(analysis);
  const documentNodeId = `doc:${sanitizeId(sourceDocumentId)}`;

  const nodes = [
    {
      id: documentNodeId,
      label: analysis.fileName,
      kind: 'document',
      kbId: knowledgeBaseId,
      scope: 'analysis' as const,
      sourceFile: analysis.fileName,
      description: 'Indexed analysis document',
    },
    ...labels.map((label, index) => ({
      id: `node:${sanitizeId(sourceDocumentId)}:${sanitizeId(label)}:${index}`,
      label,
      kind: 'concept',
      kbId: knowledgeBaseId,
      scope: 'analysis' as const,
      sourceFile: analysis.fileName,
      description: `Locally prepared from the analysis summary for ${analysis.fileName}.`,
    })),
  ];

  const labelToNodeId = new Map(nodes.slice(1).map((node) => [node.label, node.id]));
  const links = [
    ...nodes.slice(1).map((node) => ({
      id: `${documentNodeId}->MENTIONS->${node.id}`,
      source: documentNodeId,
      target: node.id,
      label: 'MENTIONS',
      kbId: knowledgeBaseId,
      scope: 'analysis' as const,
      sourceFile: analysis.fileName,
      description: `Document mentions ${node.label}.`,
    })),
    ...sentenceTerms.flatMap((termsInSentence) => {
      const filteredTerms = Array.from(new Set(termsInSentence.filter((term) => labelToNodeId.has(term))));
      return filteredTerms.slice(1).map((term, index) => {
        const sourceLabel = filteredTerms[index];
        const source = labelToNodeId.get(sourceLabel);
        const target = labelToNodeId.get(term);
        if (!source || !target) {
          return null;
        }

        return {
          id: `${source}->CO_OCCURS_WITH->${target}`,
          source,
          target,
          label: 'CO_OCCURS_WITH',
          kbId: knowledgeBaseId,
          scope: 'analysis' as const,
          sourceFile: analysis.fileName,
          description: `Locally inferred from the same analysis sentence for ${analysis.fileName}.`,
        };
      }).filter((link): link is NonNullable<typeof link> => Boolean(link));
    }),
  ];

  const graph: KnowledgeGraphData = {
    graphName: analysis.graphIndex?.graphName || analysis.graph?.graphName || LOCAL_ANALYSIS_GRAPH_NAME,
    knowledgeBaseId,
    knowledgeBaseName,
    scope: 'analysis',
    sourceDocumentId,
    sourceFile: analysis.fileName,
    nodes,
    links,
  };

  return {
    graph,
    graphIndex: {
      graphName: graph.graphName,
      storageMode: analysis.graphIndex?.storageMode || 'local',
      knowledgeBaseId,
      knowledgeBaseName,
      scope: 'analysis',
      sourceDocumentId,
      sourceFile: analysis.fileName,
      nodeCount: graph.nodes.length,
      edgeCount: graph.links.length,
    },
  };
};

export const ensureDocumentAnalysisGraph = (analysis: DocumentAnalysis): DocumentAnalysis => {
  const localSnapshot = buildLocalAnalysisGraphSnapshot(
    analysis,
    analysis.graphIndex?.knowledgeBaseId || analysis.graph?.knowledgeBaseId || 'local-analysis',
    analysis.graphIndex?.knowledgeBaseName || analysis.graph?.knowledgeBaseName || 'Local Analysis Graph',
  );

  const graph = analysis.graph && analysis.graph.nodes.length > 0
    ? analysis.graph
    : localSnapshot.graph;

  const graphIndex = analysis.graphIndex
    ? {
      ...analysis.graphIndex,
      nodeCount: graph.nodes.length,
      edgeCount: graph.links.length,
    }
    : localSnapshot.graphIndex;

  return {
    ...analysis,
    graph,
    graphIndex,
  };
};
