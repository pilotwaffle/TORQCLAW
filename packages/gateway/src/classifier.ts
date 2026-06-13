import { TaskTypeSchema, type TaskType } from '@torqclaw/contracts';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const CLASSIFIER_MODEL = process.env.TORQCLAW_CLASSIFIER_MODEL || 'torq-local';

const CLASSIFIER_SCHEMA = {
  type: 'object',
  properties: {
    taskType: { type: 'string', enum: TaskTypeSchema.options },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['taskType', 'confidence'],
} as const;

const SYSTEM = `You classify user requests into exactly one category. Respond with JSON only.

Categories:
- DATA_EXTRACTION: pull structured fields/values out of provided text, parse formats, convert data
- SUMMARIZATION: condense, recap, or explain existing content
- ROUTINE_AUTOMATION: a known repeatable action — send, schedule, rename, run, check status
- AUTONOMOUS_RESEARCH: open-ended investigation requiring web/tools across multiple steps
- COMPLEX_CODING: write, refactor, or debug non-trivial code

Examples:
"grab the invoice numbers and totals out of this email" -> {"taskType":"DATA_EXTRACTION","confidence":0.95}
"tldr this changelog" -> {"taskType":"SUMMARIZATION","confidence":0.97}
"rename all files in /reports to include today's date" -> {"taskType":"ROUTINE_AUTOMATION","confidence":0.9}
"find out which MCP gateways support tool namespacing and compare them" -> {"taskType":"AUTONOMOUS_RESEARCH","confidence":0.92}
"refactor the ws handler to support backpressure" -> {"taskType":"COMPLEX_CODING","confidence":0.93}
"what's the weather" -> {"taskType":"ROUTINE_AUTOMATION","confidence":0.85}`;

export interface Classification {
  taskType: TaskType;
  confidence: number;
  method: 'LOCAL_LLM' | 'KEYWORD_FALLBACK' | 'DEFAULT';
  latencyMs: number;
}

/** Never throws. The enrichment step must never be what blocks a request. */
export async function classifyTaskType(prompt: string): Promise<Classification> {
  const start = performance.now();
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        stream: false,
        format: CLASSIFIER_SCHEMA, // constrained decoding — no garbage JSON
        options: { temperature: 0, num_predict: 60 },
        keep_alive: '10m',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Classify: "${prompt.slice(0, 500)}"` },
        ],
      }),
    });
    if (res.ok) {
      const out = JSON.parse((await res.json()).message.content);
      const parsed = TaskTypeSchema.safeParse(out.taskType);
      if (parsed.success) {
        return {
          taskType: parsed.data,
          confidence: typeof out.confidence === 'number' ? out.confidence : 0.5,
          method: 'LOCAL_LLM',
          latencyMs: performance.now() - start,
        };
      }
    }
  } catch { /* cold model, timeout, Ollama down — fall through */ }
  return { ...keywordFallback(prompt), latencyMs: performance.now() - start };
}

// Crude-but-safe degradation rung: checked most-specific-first; misfires land
// at low confidence, which Rule 1.5 routes to FRONTIER anyway.
const RULES: Array<[RegExp, TaskType]> = [
  [/\b(refactor|debug|implement|function|class|typescript|python|compile|stack trace)\b/i, 'COMPLEX_CODING'],
  [/\b(research|investigate|compare|find out|look up|deep dive)\b/i, 'AUTONOMOUS_RESEARCH'],
  [/\b(extract|parse|pull|csv|json|fields?|values?)\b/i, 'DATA_EXTRACTION'],
  // 'summar' is a prefix (summary/summarize/summarise), not a whole word.
  [/\b(summar\w*|tldr|recap|condense|brief)\b/i, 'SUMMARIZATION'],
];

export function keywordFallback(prompt: string): Omit<Classification, 'latencyMs'> {
  for (const [re, taskType] of RULES) {
    if (re.test(prompt)) return { taskType, confidence: 0.6, method: 'KEYWORD_FALLBACK' };
  }
  return { taskType: 'ROUTINE_AUTOMATION', confidence: 0.3, method: 'DEFAULT' };
}
