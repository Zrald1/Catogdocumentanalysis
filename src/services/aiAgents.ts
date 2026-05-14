/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentExecutionMessage, AppConfig, Correction, DocumentAnalysis, Finding, Message, MessageCitation, Obligation } from "../types";
import { formatKnowledgeBaseContext, queryKnowledgeBases } from "./knowledgeBase";
import { DEFAULT_LOCAL_AGENT_MODEL, generateAgentContent, parseJsonResponseText } from "./agentProviders";
import { indexAnalysisKnowledgeGraph } from "./knowledgeGraph";
import { getCoreAgent, getPipelineFinalStep, getSpecialistAgents } from "../lib/agentConfig";
import { clearRuntimeBreadcrumb, markRuntimeBreadcrumb, writeSystemLog } from "../lib/systemLogger";

type ReviewAgentId = string;

type KnowledgeBaseLookup = Awaited<ReturnType<typeof summarizeKnowledgeBaseHits>>;

type AgentReview = {
  agentId: ReviewAgentId;
  agentName: string;
  summary: string;
  findings: Finding[];
  corrections: Correction[];
  obligations: Obligation[];
  source: 'model' | 'fallback';
  note?: string;
  lobstertrap?: any;
};

type NormalizedAnalysis = {
  summary: string;
  findings: Finding[];
  corrections: Correction[];
  obligations: Obligation[];
};

type SynthesizedAnalysis = NormalizedAnalysis & {
  source: 'model' | 'fallback';
  note?: string;
  lobstertrap?: any;
};

const DEFAULT_FINDINGS: Finding[] = [
  { type: 'missing', severity: 'high', message: 'Termination clause requires a specific notice period and clearer service disengagement language.' },
  { type: 'incorrect', severity: 'medium', message: 'Liability and indemnity language should be aligned with the enterprise policy baseline.' },
];

const DEFAULT_CORRECTIONS: Correction[] = [
  {
    reason: 'Critical operational protections are incomplete.',
    original: '',
    suggested: 'Add a clause defining notice periods, transition obligations, and minimum disengagement safeguards for both parties.',
    isRequirement: true,
  },
  {
    reason: 'Risk allocation language is ambiguous.',
    original: '',
    suggested: 'Clarify indemnity scope, third-party claims handling, and the exact liability cap exclusions.',
    isRequirement: false,
  },
];

const DEFAULT_OBLIGATIONS: Obligation[] = [
  {
    title: 'Define termination and transition ownership',
    owner: 'Legal Operations',
    dueDate: 'Before contract execution',
    priority: 'high',
    status: 'open',
    rationale: 'The agreement needs a clear operational owner for notice periods, exit planning, and service transition safeguards.',
    sourceExcerpt: 'Termination clause requires a specific notice period and clearer service disengagement language.',
  },
  {
    title: 'Align liability and indemnity language to policy baseline',
    owner: 'Legal Counsel',
    dueDate: 'Before final approval',
    priority: 'high',
    status: 'open',
    rationale: 'Risk allocation is ambiguous and should be reconciled with the enterprise policy baseline before approval.',
    sourceExcerpt: 'Liability and indemnity language should be aligned with the enterprise policy baseline.',
  },
];

type OnAgentEvent = (event: AgentExecutionMessage) => void;

const emitAgentEvent = (
  onAgentEvent: OnAgentEvent,
  event: AgentExecutionMessage,
) => {
  onAgentEvent(event);
};

const summarizeKnowledgeBaseHits = async (
  config: AppConfig,
  query: string,
  kbIds = config.selectedKBIds,
) => {
  const activeKnowledgeBases = config.knowledgeBases.filter((kb) => kbIds.includes(kb.id));
  return queryKnowledgeBases(activeKnowledgeBases, query, 4);
};

const createFallbackAnalysis = (results: KnowledgeBaseLookup['results'], summary: string): NormalizedAnalysis => {
  const findings = results.length > 0
    ? results.slice(0, 2).map((result, index) => ({
      type: index === 0 ? 'missing' : 'info',
      severity: index === 0 ? 'high' : 'medium',
      message: `${result.knowledgeBaseName}${result.source ? ` (${result.source})` : ''}: ${result.content.slice(0, 180)}`,
    } satisfies Finding))
    : DEFAULT_FINDINGS;

  const corrections = results.length > 0
    ? results.slice(0, 3).map((result, index) => ({
      reason: `Retrieved from ${result.knowledgeBaseName}${result.source ? ` (${result.source})` : ''}`,
      original: '',
      suggested: result.content.slice(0, 320),
      isRequirement: index === 0,
    } satisfies Correction))
    : DEFAULT_CORRECTIONS;

  const obligations = results.length > 0
    ? results.slice(0, 3).map((result, index) => ({
      title: `Review ${result.knowledgeBaseName} obligation ${index + 1}`,
      owner: index === 0 ? 'Legal Operations' : index === 1 ? 'Compliance' : 'Program Management',
      dueDate: index === 0 ? 'Before contract execution' : 'Before next workflow milestone',
      priority: index === 0 ? 'high' : 'medium',
      status: 'open',
      rationale: `Derived from ${result.knowledgeBaseName}${result.source ? ` (${result.source})` : ''}: ${result.content.slice(0, 180)}`,
      sourceExcerpt: result.content.slice(0, 180),
    } satisfies Obligation))
    : DEFAULT_OBLIGATIONS;

  return {
    summary,
    findings,
    corrections,
    obligations,
  };
};

const normalizeGeneratedAnalysis = (raw: unknown, fallback: NormalizedAnalysis): NormalizedAnalysis => {
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const candidate = raw as {
    summary?: string;
    findings?: Array<{ type?: string; severity?: string; message?: string }>;
    corrections?: Array<{ reason?: string; original?: string; suggested?: string; isRequirement?: boolean }>;
    obligations?: Array<{
      title?: string;
      owner?: string;
      dueDate?: string;
      priority?: string;
      status?: string;
      rationale?: string;
      sourceExcerpt?: string;
    }>;
  };

  const findings: Finding[] = Array.isArray(candidate.findings)
    ? candidate.findings
      .filter((finding) => typeof finding?.message === 'string' && finding.message.trim().length > 0)
      .slice(0, 6)
      .map((finding) => ({
        type: finding.type === 'missing' || finding.type === 'incorrect' || finding.type === 'info'
          ? finding.type
          : 'info',
        severity: finding.severity === 'low' || finding.severity === 'medium' || finding.severity === 'high'
          ? finding.severity
          : 'medium',
        message: finding.message!.trim(),
      }))
    : [];

  const corrections: Correction[] = Array.isArray(candidate.corrections)
    ? candidate.corrections
      .filter((correction) => typeof correction?.reason === 'string' && typeof correction?.suggested === 'string')
      .slice(0, 6)
      .map((correction) => ({
        reason: correction.reason!.trim(),
        original: typeof correction.original === 'string' ? correction.original.trim() : '',
        suggested: correction.suggested!.trim(),
        isRequirement: Boolean(correction.isRequirement),
      }))
    : [];

  const obligations: Obligation[] = Array.isArray(candidate.obligations)
    ? candidate.obligations
      .filter((obligation) =>
        typeof obligation?.title === 'string'
        && typeof obligation.owner === 'string'
        && typeof obligation.dueDate === 'string'
        && typeof obligation.rationale === 'string'
        && typeof obligation.sourceExcerpt === 'string',
      )
      .slice(0, 6)
      .map((obligation) => ({
        title: obligation.title!.trim(),
        owner: obligation.owner!.trim(),
        dueDate: obligation.dueDate!.trim(),
        priority: obligation.priority === 'low' || obligation.priority === 'medium' || obligation.priority === 'high'
          ? obligation.priority
          : 'medium',
        status: obligation.status === 'open' || obligation.status === 'in_progress' || obligation.status === 'blocked' || obligation.status === 'resolved'
          ? obligation.status
          : 'open',
        rationale: obligation.rationale!.trim(),
        sourceExcerpt: obligation.sourceExcerpt!.trim(),
      }))
    : [];

  if (findings.length === 0 || corrections.length === 0) {
    return fallback;
  }

  return {
    summary: typeof candidate.summary === 'string' && candidate.summary.trim().length > 0
      ? candidate.summary.trim()
      : fallback.summary,
    findings,
    corrections,
    obligations: obligations.length > 0 ? obligations : fallback.obligations,
  };
};

const clipStreamText = (value: string, limit = 1600) => (
  value.length > limit ? `…${value.slice(-limit)}` : value
);

type PartialAgentJson = {
  summary?: string;
  findings?: Array<{ type?: string; severity?: string; message?: string }>;
  corrections?: Array<unknown>;
  obligations?: Array<unknown>;
};

const tryParseAgentJson = (text: string): PartialAgentJson | null => {
  try {
    return JSON.parse(text) as PartialAgentJson;
  } catch {
    return null;
  }
};

const formatLiveModelOutput = (agentName: string, partialText: string): string => {
  const parsed = tryParseAgentJson(partialText);
  if (!parsed) {
    return `${agentName}: Receiving model response…`;
  }
  const lines: string[] = [`${agentName}: Response received`];
  if (parsed.summary) {
    lines.push(`  ${parsed.summary.slice(0, 260)}`);
  }
  if (Array.isArray(parsed.findings) && parsed.findings.length > 0) {
    parsed.findings.slice(0, 3).forEach((f) => {
      if (f?.message) {
        lines.push(`  [${(f.severity ?? 'med').toUpperCase()}|${f.type ?? 'info'}] ${f.message.slice(0, 160)}`);
      }
    });
  }
  if (Array.isArray(parsed.obligations) && parsed.obligations.length > 0) {
    lines.push(`  Obligations detected: ${parsed.obligations.length}`);
  }
  return lines.join('\n');
};

const formatReviewCompletion = (agentName: string, review: AgentReview): string => {
  const lines: string[] = [
    review.source === 'model'
      ? `${agentName}: Specialist review complete — ${review.findings.length} finding(s), ${review.corrections.length} correction(s), ${review.obligations.length} obligation(s).`
      : `${agentName}: Review finalized (fallback) — ${review.findings.length} finding(s), ${review.corrections.length} correction(s), ${review.obligations.length} obligation(s).`,
  ];
  if (review.summary) {
    lines.push(`  ${review.summary.slice(0, 260)}`);
  }
  review.findings.slice(0, 3).forEach((f) => {
    lines.push(`  [${f.severity.toUpperCase()}|${f.type}] ${f.message.slice(0, 160)}`);
  });
  return lines.join('\n');
};

const formatSynthesisCompletion = (agentName: string, result: SynthesizedAnalysis): string => {
  const lines: string[] = [
    result.source === 'model'
      ? `${agentName}: Final synthesis complete — ${result.findings.length} finding(s), ${result.corrections.length} correction(s), ${result.obligations.length} obligation(s).`
      : `${agentName}: Synthesis finalized (fallback) — ${result.findings.length} finding(s), ${result.corrections.length} correction(s), ${result.obligations.length} obligation(s).`,
  ];
  if (result.summary) {
    lines.push(`  ${result.summary.slice(0, 300)}`);
  }
  result.findings.slice(0, 4).forEach((f) => {
    lines.push(`  [${f.severity.toUpperCase()}|${f.type}] ${f.message.slice(0, 160)}`);
  });
  return lines.join('\n');
};

const buildLookupCitations = (
  results: KnowledgeBaseLookup['results'],
  limit = 3,
): MessageCitation[] => (
  results
    .filter((result) => result.content.trim().length > 0)
    .slice(0, limit)
    .map((result, index) => ({
      label: result.source?.trim()
        || `${result.knowledgeBaseName} clause ${index + 1}`,
      excerpt: result.content.trim().slice(0, 240),
    }))
);

const buildObligationCitations = (
  obligations: Obligation[],
  limit = 2,
): MessageCitation[] => (
  obligations
    .filter((obligation) => obligation.sourceExcerpt.trim().length > 0)
    .slice(0, limit)
    .map((obligation, index) => ({
      label: `Clause ${index + 1}: ${obligation.title}`,
      excerpt: obligation.sourceExcerpt.trim().slice(0, 240),
    }))
);

const mergeCitations = (...groups: MessageCitation[][]): MessageCitation[] => {
  const seen = new Set<string>();
  const merged: MessageCitation[] = [];

  groups.flat().forEach((citation) => {
    const label = citation.label.trim();
    const excerpt = citation.excerpt.trim();
    if (!label || !excerpt) {
      return;
    }

    const key = `${label}::${excerpt}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push({ label, excerpt });
  });

  return merged.slice(0, 5);
};

const delay = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const createLiveWaitStatus = ({
  logId,
  uiAgent,
  documentId,
  fileName,
  agent,
  stage,
  onLog,
  onAgentEvent,
  initialText,
  waitingText,
  intervalMs = 1700,
}: {
  logId: string;
  uiAgent: Message['agent'];
  documentId: string;
  fileName: string;
  agent: AgentExecutionMessage['agent'];
  stage: AgentExecutionMessage['stage'];
  onLog: (msg: Message) => void;
  onAgentEvent: OnAgentEvent;
  initialText: string;
  waitingText: (elapsedSeconds?: number) => string;
  intervalMs?: number;
}) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const startedAt = Date.now();
  let stopped = false;
  let hasLiveOutput = false;

  const publish = (text: string, isComplete = false, citations?: MessageCitation[], lobstertrap?: any) => {
    onLog({
      id: logId,
      agent: uiAgent,
      text,
      citations,
      timestamp: new Date(),
      isComplete,
    });
    emitAgentEvent(onAgentEvent, {
      id: `${logId}-event`,
      documentId,
      fileName,
      agent,
      stage,
      status: isComplete ? 'complete' : 'running',
      text,
      timestamp: new Date(),
      lobstertrap,
    });
  };

  const tick = () => {
    if (stopped) {
      return;
    }

    if (!hasLiveOutput) {
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
      publish(waitingText(elapsedSeconds));
    }
    timer = setTimeout(tick, intervalMs);
  };

  publish(initialText);
  timer = setTimeout(tick, intervalMs);

  return {
    update(text: string, options?: { liveOutput?: boolean; citations?: MessageCitation[]; lobstertrap?: any }) {
      if (!stopped) {
        if (options?.liveOutput) {
          hasLiveOutput = true;
        }
        publish(text, false, options?.citations, options?.lobstertrap);
      }
    },
    stop(text: string, options?: { isComplete?: boolean; citations?: MessageCitation[]; lobstertrap?: any }) {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      publish(text, options?.isComplete ?? true, options?.citations, options?.lobstertrap);
    },
  };
};

const streamStructuredJson = async (
  agentConfig: AppConfig['agents'][string],
  prompt: string,
  onPartial?: (partialText: string) => void,
  forceGemini?: boolean,
) => {
  const response = await generateAgentContent(
    agentConfig,
    prompt,
    'application/json',
    onPartial ? (partialText) => {
      onPartial(clipStreamText(partialText));
    } : undefined,
    { forceGemini },
  );
  return {
    data: parseJsonResponseText(response.text),
    lobstertrap: response.lobstertrap,
  };
};

const buildAgentReviewPrompt = (
  agentName: string,
  agentRole: string,
  fileName: string,
  content: string,
  knowledgeBaseLookup: KnowledgeBaseLookup,
) => `
You are ${agentName}. ${agentRole}

Review the following document and return JSON only:
{
  "summary": "...",
  "findings": [
    { "type": "missing" | "incorrect" | "info", "severity": "low" | "medium" | "high", "message": "..." }
  ],
  "corrections": [
    { "reason": "...", "original": "...", "suggested": "...", "isRequirement": true | false }
  ],
  "obligations": [
    {
      "title": "...",
      "owner": "...",
      "dueDate": "...",
      "priority": "low" | "medium" | "high",
      "status": "open" | "in_progress" | "blocked" | "resolved",
      "rationale": "...",
      "sourceExcerpt": "..."
    }
  ]
}

Rules:
- Focus only on your specialist role.
- Return 1 to 3 findings, 1 to 3 corrections, and 1 to 3 obligations.
- Keep corrections concrete and implementation-ready.
- Use obligations for explicit duties, approvals, reporting commitments, renewals, deadlines, review triggers, or owner assignments.
- If source material is limited, use filename plus retrieved knowledge-base context without inventing unsupported specifics.
- Use only evidence-backed facts from the document or retrieved knowledge-base context.
- If the evidence is incomplete, say so plainly instead of guessing.

Document:
${fileName}

Content excerpt:
${content || '(No document content supplied)'}

Retrieved knowledge-base context:
${formatKnowledgeBaseContext(knowledgeBaseLookup.results) || '(No knowledge-base context retrieved)'}
`;

const buildCoreSynthesisPrompt = (
  fileName: string,
  content: string,
  config: AppConfig,
  globalKnowledgeBaseLookup: KnowledgeBaseLookup,
  reviewBundle: string,
) => {
  const coreAgent = getCoreAgent(config);
  const truncatedContent = content.length > 1500
    ? `${content.slice(0, 1500)}\n...[TRUNCATED: Full content provided to specialists, omitted here to optimize synthesis context]`
    : content;

  return `
You are ${coreAgent.name}. ${coreAgent.role}

Synthesize the specialist reviews below into one final CATOG document analysis.

Return JSON only:
{
  "summary": "...",
  "findings": [
    { "type": "missing" | "incorrect" | "info", "severity": "low" | "medium" | "high", "message": "..." }
  ],
  "corrections": [
    { "reason": "...", "original": "...", "suggested": "...", "isRequirement": true | false }
  ],
  "obligations": [
    {
      "title": "...",
      "owner": "...",
      "dueDate": "...",
      "priority": "low" | "medium" | "high",
      "status": "open" | "in_progress" | "blocked" | "resolved",
      "rationale": "...",
      "sourceExcerpt": "..."
    }
  ]
}

Rules:
- Produce 2 to 6 findings, 2 to 6 corrections, and 2 to 6 obligations.
- Remove duplicates and reconcile conflicts across specialist reviews.
- Final output must be coherent, actionable, suitable for the CATOG analysis UI, and useful as an enterprise obligation register.
- Use only evidence-backed facts from the document, retrieved knowledge-base context, and specialist outputs.
- If the evidence is incomplete or conflicting, state the limitation instead of inventing detail.

Document:
${fileName}

Content excerpt:
${truncatedContent || '(No document content supplied)'}

Retrieved knowledge-base context:
${formatKnowledgeBaseContext(globalKnowledgeBaseLookup.results) || '(No global knowledge-base context retrieved)'}

Specialist reviews:
${reviewBundle}
`;
};

const generateAgentReview = async (
  agentId: ReviewAgentId,
  fileName: string,
  content: string,
  config: AppConfig,
  knowledgeBaseLookup: KnowledgeBaseLookup,
  onPartial?: (partialText: string) => void,
): Promise<AgentReview> => {
  const agentConfig = config.agents[agentId];
  const agentName = agentConfig.name;
  const fallback = createFallbackAnalysis(
    knowledgeBaseLookup.results,
    `${agentName} fallback review derived from knowledge-base context.`,
  );

  try {
    const { data: generated, lobstertrap } = await streamStructuredJson(
      agentConfig,
      buildAgentReviewPrompt(agentName, agentConfig.role, fileName, content, knowledgeBaseLookup),
      onPartial,
    );

    const normalized = normalizeGeneratedAnalysis(generated, fallback);
    return {
      agentId,
      agentName,
      ...normalized,
      source: 'model',
      lobstertrap,
    };
  } catch (error) {
    return {
      agentId,
      agentName,
      ...fallback,
      source: 'fallback',
      note: error instanceof Error ? error.message : String(error),
    };
  }
};

const synthesizeAgentReviews = async (
  fileName: string,
  content: string,
  config: AppConfig,
  globalKnowledgeBaseLookup: KnowledgeBaseLookup,
  reviews: AgentReview[],
  onPartial?: (partialText: string) => void,
): Promise<SynthesizedAnalysis> => {
  const coreAgent = getCoreAgent(config);
  const fallback = reviews.length > 0
    ? {
      summary: reviews.map((review) => `${review.agentName}: ${review.summary}`).join(' '),
      findings: reviews.flatMap((review) => review.findings).slice(0, 6),
      corrections: reviews.flatMap((review) => review.corrections).slice(0, 6),
      obligations: reviews.flatMap((review) => review.obligations).slice(0, 6),
    }
    : createFallbackAnalysis(
      globalKnowledgeBaseLookup.results,
      'Fallback synthesis derived from knowledge-base context.',
    );

  const reviewBundle = reviews.map((review) => (
    `Agent: ${review.agentName}
Summary: ${review.summary}
Findings:
${review.findings.map((finding) => `- [${finding.severity.toUpperCase()}|${finding.type}] ${finding.message}`).join('\n')}
Corrections:
${review.corrections.map((correction) => `- Reason: ${correction.reason} | Suggested: ${correction.suggested}`).join('\n')}
Obligations:
${review.obligations.map((obligation) => `- ${obligation.title} | Owner: ${obligation.owner} | Due: ${obligation.dueDate} | Priority: ${obligation.priority} | Status: ${obligation.status}`).join('\n')}`
  )).join('\n\n');

  try {
    const { data: generated, lobstertrap } = await streamStructuredJson(
      coreAgent,
      buildCoreSynthesisPrompt(fileName, content, config, globalKnowledgeBaseLookup, reviewBundle),
      onPartial,
      true, // forceGemini
    );
    
    return {
      ...normalizeGeneratedAnalysis(generated, fallback),
      source: 'model',
      lobstertrap,
    };
  } catch (error) {
    return {
      ...fallback,
      source: 'fallback',
      note: error instanceof Error ? error.message : String(error),
    };
  }
};

const getKBStatus = (config: AppConfig, agentId: ReviewAgentId) => {
  const kbIds = config.agents[agentId].kbIds || config.selectedKBIds;
  const kbs = config.knowledgeBases.filter((knowledgeBase) => kbIds.includes(knowledgeBase.id));
  if (kbs.length === 0) {
    return '[KB: None]';
  }

  const kbNames = kbs.map((knowledgeBase) => knowledgeBase.name).join(', ');
  const collections = kbs.map((knowledgeBase) => knowledgeBase.collectionName || 'default').join('|');
  return `[KBs: ${kbNames} | COLLS: ${collections}]`;
};

const runSequentialReviews = async (
  fileName: string,
  content: string,
  config: AppConfig,
  onLog: (msg: Message) => void,
  onAgentEvent: OnAgentEvent,
  onStep: (step: number) => void,
  docId: string,
): Promise<AgentReview[]> => {
  const reviews: AgentReview[] = [];
  const reviewAgents = getSpecialistAgents(config);

  for (const [index, agent] of reviewAgents.entries()) {
    const agentId = agent.id;
    const step = index + 3;
    const agentConfig = config.agents[agentId];
    markRuntimeBreadcrumb({
      phase: `specialist-${agentConfig.name.toLowerCase()}-review-start`,
      docId,
      fileName,
      details: { agentId, agentName: agentConfig.name, mode: 'sequential' },
    });
    void writeSystemLog({
      scope: 'ai-agent.workflow',
      event: 'specialist-review-start',
      message: `${agentConfig.name} started sequential review for ${fileName}.`,
      details: { docId, fileName, agentId, agentName: agentConfig.name, mode: 'sequential' },
    });
    const retrievalEventId = `retrieval-${agentId}-${docId}-${Date.now()}`;
    const agentLogId = `agent-progress-${agentId}-${docId}`;

    emitAgentEvent(onAgentEvent, {
      id: retrievalEventId,
      documentId: docId,
      fileName,
      agent: agentId,
      stage: 'retrieval',
      status: 'running',
      text: `${agentConfig.name} is retrieving knowledge-base context for ${fileName}.`,
      timestamp: new Date(),
    });
    onLog({
      id: agentLogId,
      agent: agentId,
      text: `${agentConfig.name}: Loading knowledge-base context for ${fileName}...`,
      timestamp: new Date(),
      isComplete: false,
    });

    const agentLookup = await summarizeKnowledgeBaseHits(config, `${fileName}\n${content}`, agentConfig.kbIds || config.selectedKBIds);

    onStep(step);
    onLog({
      id: agentLogId,
      agent: agentId,
      text: `${agentConfig.name}: Retrieved ${agentLookup.results.length} contextual passage(s) across ${agentLookup.queriedKnowledgeBaseCount} knowledge base(s).`,
      timestamp: new Date(),
      isComplete: false,
    });
    emitAgentEvent(onAgentEvent, {
      id: `retrieval-complete-${agentId}-${docId}-${Date.now()}`,
      documentId: docId,
      fileName,
      agent: agentId,
      stage: 'retrieval',
      status: agentLookup.errors.length > 0 ? 'fallback' : 'complete',
      text: `Retrieved ${agentLookup.results.length} context passage(s) across ${agentLookup.queriedKnowledgeBaseCount} knowledge base(s)${agentLookup.errors.length > 0 ? `. Warnings: ${agentLookup.errors.map((error) => `${error.knowledgeBaseName}: ${error.message}`).join(' | ')}` : '.'}`,
      timestamp: new Date(),
    });

    onLog({
      id: agentLogId,
      agent: agentId,
      text: `${getKBStatus(config, agentId)} ${agentConfig.name}: Running specialist review for ${fileName}...`,
      timestamp: new Date(),
      isComplete: false,
    });
    onLog({
      id: agentLogId,
      agent: agentId,
      text: `${agentConfig.name}: Building specialist review prompt with ${agentLookup.results.length} retrieved knowledge-base passage(s).`,
      timestamp: new Date(),
      isComplete: false,
    });

    const reviewWaitStatus = createLiveWaitStatus({
      logId: agentLogId,
      uiAgent: agentId,
      documentId: docId,
      fileName,
      agent: agentId,
      stage: 'review',
      onLog,
      onAgentEvent,
      initialText: `${agentConfig.name}: Sending specialist review request to ${agentConfig.model || DEFAULT_LOCAL_AGENT_MODEL}.`,
      waitingText: () => 'Working ...',
    });

    const review = await generateAgentReview(
      agentId,
      fileName,
      content,
      config,
      agentLookup,
      (partialText) => {
        if (partialText.trim()) {
          reviewWaitStatus.update(
            formatLiveModelOutput(agentConfig.name, partialText),
            { liveOutput: true },
          );
        }
      },
    );
    reviews.push(review);
    markRuntimeBreadcrumb({
      phase: `specialist-${agentConfig.name.toLowerCase()}-review-complete`,
      docId,
      fileName,
      details: {
        agentId,
        agentName: agentConfig.name,
        mode: 'sequential',
        source: review.source,
        findings: review.findings.length,
        corrections: review.corrections.length,
        obligations: review.obligations.length,
      },
    });
    void writeSystemLog({
      scope: 'ai-agent.workflow',
      event: 'specialist-review-complete',
      message: `${agentConfig.name} completed sequential review for ${fileName}.`,
      details: {
        docId,
        fileName,
        agentId,
        agentName: agentConfig.name,
        mode: 'sequential',
        source: review.source,
        findings: review.findings.length,
        corrections: review.corrections.length,
        obligations: review.obligations.length,
      },
    });

    reviewWaitStatus.stop(formatReviewCompletion(agentConfig.name, review), {
      citations: mergeCitations(
        buildLookupCitations(agentLookup.results, 3),
        buildObligationCitations(review.obligations, 2),
      ),
      lobstertrap: review.lobstertrap,
    });
  }

  return reviews;
};

const runParallelReviews = async (
  fileName: string,
  content: string,
  config: AppConfig,
  onLog: (msg: Message) => void,
  onAgentEvent: OnAgentEvent,
  onStep: (step: number) => void,
  docId: string,
): Promise<AgentReview[]> => {
  onStep(3);
  const reviewAgents = getSpecialistAgents(config);

  const reviewPromises = reviewAgents.map(async (agent) => {
    const agentId = agent.id;
    const agentConfig = config.agents[agentId];
    markRuntimeBreadcrumb({
      phase: `specialist-${agentConfig.name.toLowerCase()}-parallel-review-start`,
      docId,
      fileName,
      details: { agentId, agentName: agentConfig.name, mode: 'parallel' },
    });
    void writeSystemLog({
      scope: 'ai-agent.workflow',
      event: 'specialist-review-start',
      message: `${agentConfig.name} started parallel review for ${fileName}.`,
      details: { docId, fileName, agentId, agentName: agentConfig.name, mode: 'parallel' },
    });
    const logId = `parallel-agent-progress-${agentId}-${docId}`;
    const retrievalEventId = `parallel-retrieval-${agentId}-${docId}-${Date.now()}`;

    emitAgentEvent(onAgentEvent, {
      id: retrievalEventId,
      documentId: docId,
      fileName,
      agent: agentId,
      stage: 'retrieval',
      status: 'running',
      text: `${agentConfig.name} is retrieving knowledge-base context in parallel.`,
      timestamp: new Date(),
    });
    onLog({
      id: logId,
      agent: agentId,
      text: `${agentConfig.name}: Loading knowledge-base context in parallel for ${fileName}...`,
      timestamp: new Date(),
      isComplete: false,
    });

    const agentLookup = await summarizeKnowledgeBaseHits(config, `${fileName}\n${content}`, agentConfig.kbIds || config.selectedKBIds);

    onLog({
      id: logId,
      agent: agentId,
      text: `${agentConfig.name}: Retrieved ${agentLookup.results.length} contextual passage(s) across ${agentLookup.queriedKnowledgeBaseCount} knowledge base(s).`,
      timestamp: new Date(),
      isComplete: false,
    });
    onLog({
      id: logId,
      agent: agentId,
      text: `${getKBStatus(config, agentId)} ${agentConfig.name}: Parallel specialist review active.`,
      timestamp: new Date(),
      isComplete: false,
    });
    onLog({
      id: logId,
      agent: agentId,
      text: `${agentConfig.name}: Building specialist review prompt with ${agentLookup.results.length} retrieved knowledge-base passage(s).`,
      timestamp: new Date(),
      isComplete: false,
    });

    emitAgentEvent(onAgentEvent, {
      id: `parallel-retrieval-complete-${agentId}-${docId}-${Date.now()}`,
      documentId: docId,
      fileName,
      agent: agentId,
      stage: 'retrieval',
      status: agentLookup.errors.length > 0 ? 'fallback' : 'complete',
      text: `Retrieved ${agentLookup.results.length} context passage(s) across ${agentLookup.queriedKnowledgeBaseCount} knowledge base(s)${agentLookup.errors.length > 0 ? `. Warnings: ${agentLookup.errors.map((error) => `${error.knowledgeBaseName}: ${error.message}`).join(' | ')}` : '.'}`,
      timestamp: new Date(),
    });

    const reviewWaitStatus = createLiveWaitStatus({
      logId,
      uiAgent: agentId,
      documentId: docId,
      fileName,
      agent: agentId,
      stage: 'review',
      onLog,
      onAgentEvent,
      initialText: `${agentConfig.name}: Sending parallel specialist review request to ${agentConfig.model || DEFAULT_LOCAL_AGENT_MODEL}.`,
      waitingText: () => 'Working ...',
    });

    const review = await generateAgentReview(
      agentId,
      fileName,
      content,
      config,
      agentLookup,
      (partialText) => {
        if (partialText.trim()) {
          reviewWaitStatus.update(
            formatLiveModelOutput(agentConfig.name, partialText),
            { liveOutput: true },
          );
        }
      },
    );
    markRuntimeBreadcrumb({
      phase: `specialist-${agentConfig.name.toLowerCase()}-parallel-review-complete`,
      docId,
      fileName,
      details: {
        agentId,
        agentName: agentConfig.name,
        mode: 'parallel',
        source: review.source,
        findings: review.findings.length,
        corrections: review.corrections.length,
        obligations: review.obligations.length,
      },
    });
    void writeSystemLog({
      scope: 'ai-agent.workflow',
      event: 'specialist-review-complete',
      message: `${agentConfig.name} completed parallel review for ${fileName}.`,
      details: {
        docId,
        fileName,
        agentId,
        agentName: agentConfig.name,
        mode: 'parallel',
        source: review.source,
        findings: review.findings.length,
        corrections: review.corrections.length,
        obligations: review.obligations.length,
      },
    });

    reviewWaitStatus.stop(formatReviewCompletion(agentConfig.name, review), {
      citations: mergeCitations(
        buildLookupCitations(agentLookup.results, 3),
        buildObligationCitations(review.obligations, 2),
      ),
      lobstertrap: review.lobstertrap,
    });

    return review;
  });

  return Promise.all(reviewPromises);
};

const runAnalysisFlow = async (
  mode: 'sequential' | 'parallel',
  fileName: string,
  content: string,
  config: AppConfig,
  onLog: (msg: Message) => void,
  onAgentEvent: OnAgentEvent,
  onStep: (step: number) => void,
  onAnalysisUpdate: (analysis: DocumentAnalysis) => void,
  onComplete: () => void,
): Promise<DocumentAnalysis> => {
  const docId = Math.random().toString(36).substr(2, 9);
  const coreAgent = getCoreAgent(config);
  const finalReportStep = getPipelineFinalStep(config);
  let analysis: DocumentAnalysis = {
    id: docId,
    fileName,
    status: 'analyzing',
    findings: [],
    corrections: [],
    obligations: [],
    createdAt: new Date().toISOString(),
  };
  onAnalysisUpdate(analysis);

  onStep(1);
  onLog({
    id: `init-${docId}`,
    agent: 'system',
    text: `Initializing ingestion for document: ${fileName}`,
    timestamp: new Date(),
    isComplete: false,
  });
  if (mode === 'sequential') {
    await delay(180);
  }
  emitAgentEvent(onAgentEvent, {
    id: `queued-${docId}`,
    documentId: docId,
    fileName,
    agent: 'system',
    stage: 'queued',
    status: 'complete',
    text: `Queued ${fileName} for ${mode} execution.`,
    timestamp: new Date(),
  });

  onStep(2);
  onLog({
    id: `rag-${docId}`,
    agent: 'system',
    text: 'Dispatching specialist agents and preparing document context...',
    timestamp: new Date(),
    isComplete: false,
  });
  onLog({
    id: `rag-${docId}`,
    agent: 'system',
    text: 'Dispatching specialist agents and preparing document context...',
    timestamp: new Date(),
    isComplete: true,
  });
  if (mode === 'sequential') {
    await delay(180);
  }

  const reviews = mode === 'parallel'
    ? await runParallelReviews(fileName, content, config, onLog, onAgentEvent, onStep, docId)
    : await runSequentialReviews(fileName, content, config, onLog, onAgentEvent, onStep, docId);

  const synthesisRetrievalLogId = `core-retrieval-${docId}`;
  onLog({
    id: synthesisRetrievalLogId,
    agent: 'core',
    text: 'Collecting specialist outputs and global knowledge-base context for CORE synthesis...',
    timestamp: new Date(),
    isComplete: false,
  });
  emitAgentEvent(onAgentEvent, {
    id: `core-retrieval-${docId}-${Date.now()}`,
    documentId: docId,
    fileName,
      agent: 'core',
      stage: 'retrieval',
      status: 'running',
      text: `${coreAgent.name} is reading specialist outputs and loading shared knowledge-base context.`,
      timestamp: new Date(),
    });

  const globalKnowledgeBaseLookup = await summarizeKnowledgeBaseHits(config, `${fileName}\n${content}`);
  onLog({
    id: synthesisRetrievalLogId,
    agent: 'core',
    text: 'Collecting specialist outputs and global knowledge-base context for CORE synthesis...',
    timestamp: new Date(),
    isComplete: true,
  });

  if (globalKnowledgeBaseLookup.queriedKnowledgeBaseCount > 0) {
    onLog({
      id: `rag-results-${docId}`,
      agent: 'core',
      text: `RAG_SYNC: Retrieved ${globalKnowledgeBaseLookup.results.length} contextual passages across ${globalKnowledgeBaseLookup.queriedKnowledgeBaseCount} configured knowledge bases for CORE synthesis.`,
      timestamp: new Date(),
      isComplete: true,
    });
  }

  if (globalKnowledgeBaseLookup.errors.length > 0) {
    onLog({
      id: `rag-errors-${docId}`,
      agent: 'core',
      text: `RAG_WARNINGS: ${globalKnowledgeBaseLookup.errors.map((error) => `${error.knowledgeBaseName}: ${error.message}`).join(' | ')}`,
      timestamp: new Date(),
      isComplete: true,
    });
  }

  emitAgentEvent(onAgentEvent, {
    id: `core-retrieval-complete-${docId}-${Date.now()}`,
    documentId: docId,
    fileName,
    agent: 'core',
    stage: 'retrieval',
    status: globalKnowledgeBaseLookup.errors.length > 0 ? 'fallback' : 'complete',
    text: globalKnowledgeBaseLookup.queriedKnowledgeBaseCount > 0
      ? `${coreAgent.name} loaded ${globalKnowledgeBaseLookup.results.length} contextual passage(s) across ${globalKnowledgeBaseLookup.queriedKnowledgeBaseCount} knowledge base(s) for synthesis${globalKnowledgeBaseLookup.errors.length > 0 ? `. Warnings: ${globalKnowledgeBaseLookup.errors.map((error) => `${error.knowledgeBaseName}: ${error.message}`).join(' | ')}` : '.'}`
      : `No knowledge bases were configured for ${coreAgent.name} synthesis, so the final correction uses specialist outputs only.`,
    timestamp: new Date(),
  });

  onStep(finalReportStep);
  const synthesisStreamLogId = `synthesis-stream-${docId}`;
  markRuntimeBreadcrumb({
    phase: 'core-synthesis-start',
    runId: docId,
    docId,
    fileName,
    details: {
      model: coreAgent.model || DEFAULT_LOCAL_AGENT_MODEL,
      specialistReviewCount: reviews.length,
      globalKnowledgeBaseHits: globalKnowledgeBaseLookup.results.length,
    },
  });
  void writeSystemLog({
    scope: 'ai-agent.core',
    event: 'synthesis-start',
    message: `${coreAgent.name} started final synthesis for ${fileName}.`,
    details: {
      docId,
      fileName,
      model: coreAgent.model || DEFAULT_LOCAL_AGENT_MODEL,
      specialistReviewCount: reviews.length,
      globalKnowledgeBaseHits: globalKnowledgeBaseLookup.results.length,
      globalKnowledgeBaseErrors: globalKnowledgeBaseLookup.errors,
    },
  });
  onLog({
    id: synthesisStreamLogId,
    agent: 'core',
    text: `${coreAgent.name}: Building synthesis prompt from ${reviews.length} specialist outputs and ${globalKnowledgeBaseLookup.results.length} shared knowledge-base passage(s).`,
    timestamp: new Date(),
    isComplete: false,
  });
  const synthesisWaitStatus = createLiveWaitStatus({
    logId: synthesisStreamLogId,
    uiAgent: 'core',
    documentId: docId,
    fileName,
    agent: 'core',
    stage: 'synthesis',
    onLog,
    onAgentEvent,
    initialText: `${coreAgent.name}: Sending synthesis request to ${coreAgent.model || DEFAULT_LOCAL_AGENT_MODEL}.`,
    waitingText: () => 'Working ...',
  });

  let synthesizedAnalysis: SynthesizedAnalysis;
  try {
    markRuntimeBreadcrumb({
      phase: 'core-synthesis-request-in-flight',
      runId: docId,
      docId,
      fileName,
      details: {
        model: coreAgent.model || DEFAULT_LOCAL_AGENT_MODEL,
      },
    });

    let lastSynthesisUpdateAt = 0;
    const SYNTHESIS_UPDATE_THROTTLE_MS = 320;

    synthesizedAnalysis = await synthesizeAgentReviews(
      fileName,
      content,
      config,
      globalKnowledgeBaseLookup,
      reviews,
      (partialText) => {
        const now = Date.now();
        if (now - lastSynthesisUpdateAt >= SYNTHESIS_UPDATE_THROTTLE_MS) {
          lastSynthesisUpdateAt = now;
          if (partialText.trim()) {
            synthesisWaitStatus.update(
              formatLiveModelOutput(coreAgent.name, partialText),
              { liveOutput: true },
            );
          }
        }
      },
    );
    markRuntimeBreadcrumb({
      phase: 'core-synthesis-model-complete',
      runId: docId,
      docId,
      fileName,
      details: {
        source: synthesizedAnalysis.source,
        findings: synthesizedAnalysis.findings.length,
        corrections: synthesizedAnalysis.corrections.length,
        obligations: synthesizedAnalysis.obligations.length,
      },
    });
    void writeSystemLog({
      scope: 'ai-agent.core',
      event: 'synthesis-model-complete',
      message: `${coreAgent.name} returned final synthesis output for ${fileName}.`,
      details: {
        docId,
        fileName,
        source: synthesizedAnalysis.source,
        findings: synthesizedAnalysis.findings.length,
        corrections: synthesizedAnalysis.corrections.length,
        obligations: synthesizedAnalysis.obligations.length,
      },
    });
  } catch (error) {
    void writeSystemLog({
      scope: 'ai-agent.core',
      event: 'synthesis-error',
      level: 'error',
      message: `${coreAgent.name} failed during final synthesis for ${fileName}.`,
      details: {
        docId,
        fileName,
        error,
      },
    });
    throw error;
  }

  onLog({
    id: `synthesis-success-${docId}-${Date.now()}`,
    agent: 'success',
    text: `${coreAgent.name} Synthesis Completed`,
    timestamp: new Date(),
    isComplete: true,
  });
  synthesisWaitStatus.stop(formatSynthesisCompletion(coreAgent.name, synthesizedAnalysis), {
    citations: mergeCitations(
      buildLookupCitations(globalKnowledgeBaseLookup.results, 3),
      buildObligationCitations(synthesizedAnalysis.obligations, 2),
    ),
    lobstertrap: synthesizedAnalysis.lobstertrap,
  });

  analysis = {
    ...analysis,
    status: 'complete',
    findings: synthesizedAnalysis.findings,
    corrections: synthesizedAnalysis.corrections,
    obligations: synthesizedAnalysis.obligations,
    createdAt: new Date().toISOString(),
  };
  markRuntimeBreadcrumb({
    phase: 'core-analysis-state-ready',
    runId: docId,
    docId,
    fileName,
    details: {
      status: analysis.status,
      findings: analysis.findings.length,
      corrections: analysis.corrections.length,
      obligations: analysis.obligations.length,
    },
  });
  void writeSystemLog({
    scope: 'ai-agent.core',
    event: 'analysis-state-complete',
    message: `Analysis state marked complete for ${fileName}.`,
    details: {
      docId,
      fileName,
      status: analysis.status,
      findings: analysis.findings.length,
      corrections: analysis.corrections.length,
      obligations: analysis.obligations.length,
    },
  });
  onAnalysisUpdate(analysis);

  // Sequential Graph Indexing - moved here to reduce memory pressure during synthesis
  const graphLogId = `graph-${docId}`;
  onLog({
    id: graphLogId,
    agent: 'system',
    text: `Starting final graph indexing for ${fileName}...`,
    timestamp: new Date(),
    isComplete: false,
  });
  emitAgentEvent(onAgentEvent, {
    id: `${graphLogId}-running`,
    documentId: docId,
    fileName,
    agent: 'core',
    stage: 'graph',
    status: 'running',
    text: `Sequential graph indexing started for ${fileName}.`,
    timestamp: new Date(),
  });

  try {
    const result = await indexAnalysisKnowledgeGraph(
      config,
      fileName,
      content,
      docId,
      'Sequential graph indexing started after specialist review and core synthesis.',
      config.selectedKBIds,
    );

    analysis = {
      ...analysis,
      graph: result.graph,
      graphIndex: result.graphIndex,
    };
    onAnalysisUpdate(analysis);

    if (result.storageMode === 'indexed' && result.graphIndex) {
      onLog({
        id: graphLogId,
        agent: 'system',
        text: `GRAPH_INDEXED: ${result.graphIndex.nodeCount} nodes and ${result.graphIndex.edgeCount} edges stored in ${result.graphIndex.graphName}.`,
        timestamp: new Date(),
        isComplete: true,
      });
      onLog({
        id: `graph-success-${docId}-${Date.now()}`,
        agent: 'success',
        text: 'Analysis Graph Indexed',
        timestamp: new Date(),
        isComplete: true,
      });
      emitAgentEvent(onAgentEvent, {
        id: `${graphLogId}-complete`,
        documentId: docId,
        fileName,
        agent: 'core',
        stage: 'graph',
        status: 'complete',
        text: `Stored ${result.graphIndex.nodeCount} node(s) and ${result.graphIndex.edgeCount} edge(s) in ${result.graphIndex.graphName}.`,
        timestamp: new Date(),
      });
    } else if (result.storageMode === 'skipped') {
      onLog({
        id: graphLogId,
        agent: 'system',
        text: `GRAPH_SKIPPED: ${result.message}`,
        timestamp: new Date(),
        isComplete: true,
      });
      emitAgentEvent(onAgentEvent, {
        id: `${graphLogId}-skipped`,
        documentId: docId,
        fileName,
        agent: 'core',
        stage: 'graph',
        status: 'complete',
        text: `Skipped graph generation. ${result.message}`,
        timestamp: new Date(),
      });
    } else if (result.graphIndex) {
      onLog({
        id: graphLogId,
        agent: 'system',
        text: `GRAPH_READY_LOCAL: ${result.graphIndex.nodeCount} nodes and ${result.graphIndex.edgeCount} edges prepared in ${result.graphIndex.graphName}. ${result.message}`,
        timestamp: new Date(),
        isComplete: true,
      });
      emitAgentEvent(onAgentEvent, {
        id: `${graphLogId}-fallback`,
        documentId: docId,
        fileName,
        agent: 'core',
        stage: 'graph',
        status: 'fallback',
        text: `Prepared ${result.graphIndex.nodeCount} node(s) and ${result.graphIndex.edgeCount} edge(s) in ${result.graphIndex.graphName}. ${result.message}`,
        timestamp: new Date(),
      });
    }
  } catch (error) {
    const graphError = error instanceof Error ? error.message : String(error);
    onLog({
      id: graphLogId,
      agent: 'system',
      text: `GRAPH_WARNING: ${graphError}`,
      timestamp: new Date(),
      isComplete: true,
    });
    emitAgentEvent(onAgentEvent, {
      id: `${graphLogId}-warning`,
      documentId: docId,
      fileName,
      agent: 'core',
      stage: 'graph',
      status: 'fallback',
      text: `Graph indexing skipped: ${graphError}`,
      timestamp: new Date(),
    });
  }

  markRuntimeBreadcrumb({
    phase: 'core-complete-event-emitted',
    runId: docId,
    docId,
    fileName,
  });
  emitAgentEvent(onAgentEvent, {
    id: `complete-${docId}`,
    documentId: docId,
    fileName,
    agent: 'core',
    stage: 'complete',
    status: 'complete',
    text: `Execution finished for ${fileName}.`,
    timestamp: new Date(),
  });

  markRuntimeBreadcrumb({
    phase: 'core-complete-callback-start',
    runId: docId,
    docId,
    fileName,
  });
  onComplete();
  clearRuntimeBreadcrumb();
  void writeSystemLog({
    scope: 'ai-agent.core',
    event: 'analysis-complete-callback-fired',
    message: `Completion callback fired for ${fileName}.`,
    details: {
      docId,
      fileName,
    },
  });

  return analysis;
};

export const runMultiAgentAnalysis = async (
  fileName: string,
  content: string,
  config: AppConfig,
  onLog: (msg: Message) => void,
  onAgentEvent: OnAgentEvent,
  onStep: (step: number) => void,
  onAnalysisUpdate: (analysis: DocumentAnalysis) => void,
  onComplete: () => void,
): Promise<DocumentAnalysis> => {
  return runAnalysisFlow('sequential', fileName, content, config, onLog, onAgentEvent, onStep, onAnalysisUpdate, onComplete);
};

export const runParallelMultiAgentAnalysis = async (
  fileName: string,
  content: string,
  config: AppConfig,
  onLog: (msg: Message) => void,
  onAgentEvent: OnAgentEvent,
  onStep: (step: number) => void,
  onAnalysisUpdate: (analysis: DocumentAnalysis) => void,
  onComplete: () => void,
): Promise<DocumentAnalysis> => {
  return runAnalysisFlow('parallel', fileName, content, config, onLog, onAgentEvent, onStep, onAnalysisUpdate, onComplete);
};
