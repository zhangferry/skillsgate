import path from "node:path";
import {
  ScannerConfig,
  ScannerType,
  type SkillEvaluation,
  type EvaluationDimension,
  type EvaluationMode,
  type InvocationResult,
} from "../types.js";
import {
  SCANNERS,
  detectAvailableScanners,
  detectInsideScanner,
  filterInsideScanner,
  invokeScanner,
  detectCreditsExhausted,
} from "./scanners.js";

// ---------- Prompt Builders ----------

function buildEvaluationPrompt(
  skills: { name: string; content: string; relativePath: string }[],
  mode: EvaluationMode
): string {
  const fileBlocks = skills
    .map(
      (s) =>
        `--- FILE: ${s.relativePath} ---\n${s.content}\n--- END FILE ---`
    )
    .join("\n\n");

  const depthInstructions = {
    quick:
      "Provide a brief evaluation with an overall score and 3-4 dimension scores.",
    standard:
      "Provide a thorough evaluation with scores across all dimensions, strengths, weaknesses, and recommendations.",
    detailed:
      "Provide an in-depth evaluation with detailed analysis of each dimension, specific examples from the code, comparisons to best practices, and actionable recommendations.",
  };

  return `You are an expert AI skill evaluator. Analyze the following AI agent skill and provide a comprehensive quality evaluation.

${fileBlocks}

${depthInstructions[mode]}

Evaluate the skill on these dimensions:
1. **Clarity** (0-100): How clear and understandable are the instructions?
2. **Completeness** (0-100): Does it cover all necessary aspects? Are there gaps?
3. **Effectiveness** (0-100): How well would this skill guide an AI agent to produce good results?
4. **Robustness** (0-100): How well does it handle edge cases, errors, and unexpected inputs?
5. **Best Practices** (0-100): Does it follow AI skill writing best practices?
6. **Specificity** (0-100): How specific and actionable are the instructions vs vague?

Respond with ONLY a JSON object in this exact schema:
{
  "overallScore": 75,
  "dimensions": [
    {
      "name": "Clarity",
      "score": 80,
      "description": "Brief assessment of clarity"
    },
    {
      "name": "Completeness",
      "score": 70,
      "description": "Brief assessment of completeness"
    },
    {
      "name": "Effectiveness",
      "score": 75,
      "description": "Brief assessment of effectiveness"
    },
    {
      "name": "Robustness",
      "score": 65,
      "description": "Brief assessment of robustness"
    },
    {
      "name": "Best Practices",
      "score": 80,
      "description": "Brief assessment of best practices"
    },
    {
      "name": "Specificity",
      "score": 70,
      "description": "Brief assessment of specificity"
    }
  ],
  "summary": "One-paragraph overall assessment",
  "strengths": ["Strength 1", "Strength 2"],
  "weaknesses": ["Weakness 1", "Weakness 2"],
  "recommendations": ["Recommendation 1", "Recommendation 2"],
  "comparisonToAverage": "How this skill compares to typical skills"
}

Respond with ONLY the JSON object. No other text.`;
}

// ---------- Output Parsing ----------

function parseEvaluationReport(raw: string): SkillEvaluation | null {
  // Try fenced JSON block first
  const fencedMatch = raw.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (fencedMatch) {
    try {
      const parsed = JSON.parse(fencedMatch[1]);
      const result = validateEvaluation(parsed);
      if (result) return result;
    } catch {
      // Fall through
    }
  }

  // Try bare JSON
  const jsonMatch = raw.match(/\{[\s\S]*"overallScore"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const result = validateEvaluation(parsed);
      if (result) return result;
    } catch {
      // Fall through
    }
  }

  // Try full stdout as JSON
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.result === "string") {
        return parseEvaluationReport(parsed.result);
      }
      const result = validateEvaluation(parsed);
      if (result) return result;
    }
  } catch {
    // Fall through
  }

  return null;
}

function validateEvaluation(obj: unknown): SkillEvaluation | null {
  if (!obj || typeof obj !== "object") return null;

  const record = obj as Record<string, unknown>;
  if (typeof record.overallScore !== "number") return null;
  if (!Array.isArray(record.dimensions)) return null;

  const dimensions: EvaluationDimension[] = record.dimensions
    .filter(
      (d: unknown): d is Record<string, unknown> =>
        typeof d === "object" && d !== null
    )
    .map((d) => ({
      name: String(d.name ?? "Unknown"),
      score: typeof d.score === "number" ? d.score : 0,
      maxScore: 100,
      description: String(d.description ?? ""),
      details: Array.isArray(d.details)
        ? d.details.map(String)
        : [],
    }));

  return {
    name: "",
    overallScore: Math.max(0, Math.min(100, record.overallScore)),
    dimensions,
    summary: typeof record.summary === "string" ? record.summary : "",
    strengths: Array.isArray(record.strengths)
      ? record.strengths.map(String)
      : [],
    weaknesses: Array.isArray(record.weaknesses)
      ? record.weaknesses.map(String)
      : [],
    recommendations: Array.isArray(record.recommendations)
      ? record.recommendations.map(String)
      : [],
    comparisonToAverage:
      typeof record.comparisonToAverage === "string"
        ? record.comparisonToAverage
        : "",
  };
}

// ---------- Evaluation Runner ----------

export interface EvaluationOptions {
  scanner?: ScannerType;
  mode: EvaluationMode;
  timeout: number;
  yes: boolean;
}

export interface EvaluationRunResult {
  evaluation: SkillEvaluation | null;
  scannerUsed: string;
  durationMs: number;
  timedOut: boolean;
  creditsExhausted: boolean;
  rawOutput?: string;
  parseFailed: boolean;
}

export async function evaluateSkill(opts: {
  skills: { name: string; content: string; relativePath: string }[];
  options: EvaluationOptions;
  cwd: string;
}): Promise<EvaluationRunResult> {
  const { skills, options, cwd } = opts;

  // Scanner detection
  const insideScanner = detectInsideScanner();
  const available = await detectAvailableScanners();
  const filtered = filterInsideScanner(available, insideScanner);

  if (filtered.length === 0 && insideScanner) {
    throw new Error(
      `Cannot evaluate: running inside ${SCANNERS[insideScanner].displayName} and no other scanner available.`
    );
  }
  if (filtered.length === 0) {
    throw new Error(
      "No coding agents available for evaluation. Install Claude Code, Codex CLI, or another supported agent."
    );
  }

  // Select scanner
  let selectedScanner: ScannerConfig;
  if (options.scanner) {
    const entry = Object.values(SCANNERS).find(
      (s) => s.name === options.scanner
    );
    if (!entry) {
      throw new Error(`Unknown scanner: "${options.scanner}"`);
    }
    if (!filtered.find((s) => s.name === entry.name)) {
      throw new Error(`"${options.scanner}" is not available on this system.`);
    }
    selectedScanner = entry;
  } else {
    selectedScanner = filtered[0];
  }

  // Build prompt
  const prompt = buildEvaluationPrompt(skills, options.mode);

  // Invoke
  const startTime = Date.now();
  const result: InvocationResult = await invokeScanner({
    scanner: selectedScanner,
    prompt,
    cwd,
    timeoutMs: options.timeout * 1000,
  });
  const durationMs = Date.now() - startTime;

  // Handle failures
  if (result.timedOut) {
    return {
      evaluation: null,
      scannerUsed: selectedScanner.displayName,
      durationMs,
      timedOut: true,
      creditsExhausted: false,
      parseFailed: true,
    };
  }

  if (detectCreditsExhausted(result.stderr, result.stdout)) {
    return {
      evaluation: null,
      scannerUsed: selectedScanner.displayName,
      durationMs,
      timedOut: false,
      creditsExhausted: true,
      parseFailed: true,
    };
  }

  // Parse
  const evaluation = parseEvaluationReport(result.stdout);

  return {
    evaluation,
    scannerUsed: selectedScanner.displayName,
    durationMs,
    timedOut: false,
    creditsExhausted: false,
    rawOutput: result.stdout,
    parseFailed: !evaluation,
  };
}

// ---------- Formatting ----------

export function formatEvaluationReport(evaluation: SkillEvaluation): string {
  const lines: string[] = [];

  lines.push(`# Skill Evaluation: ${evaluation.name}`);
  lines.push("");

  // Overall score
  const overallBar = getScoreBar(evaluation.overallScore);
  lines.push(`## Overall Score: ${evaluation.overallScore}/100`);
  lines.push(overallBar);
  lines.push("");

  // Summary
  if (evaluation.summary) {
    lines.push("## Summary");
    lines.push(evaluation.summary);
    lines.push("");
  }

  // Dimensions
  lines.push("## Dimensions");
  for (const dim of evaluation.dimensions) {
    const bar = getScoreBar(dim.score);
    lines.push(`### ${dim.name}: ${dim.score}/100`);
    lines.push(bar);
    lines.push(dim.description);
    if (dim.details.length > 0) {
      for (const detail of dim.details) {
        lines.push(`  - ${detail}`);
      }
    }
    lines.push("");
  }

  // Strengths
  if (evaluation.strengths.length > 0) {
    lines.push("## Strengths");
    for (const strength of evaluation.strengths) {
      lines.push(`- ${strength}`);
    }
    lines.push("");
  }

  // Weaknesses
  if (evaluation.weaknesses.length > 0) {
    lines.push("## Weaknesses");
    for (const weakness of evaluation.weaknesses) {
      lines.push(`- ${weakness}`);
    }
    lines.push("");
  }

  // Recommendations
  if (evaluation.recommendations.length > 0) {
    lines.push("## Recommendations");
    for (const rec of evaluation.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push("");
  }

  // Comparison
  if (evaluation.comparisonToAverage) {
    lines.push("## Comparison to Average");
    lines.push(evaluation.comparisonToAverage);
    lines.push("");
  }

  return lines.join("\n");
}

function getScoreBar(score: number): string {
  const filled = Math.round(score / 5);
  const empty = 20 - filled;
  const color = score >= 80 ? "🟢" : score >= 60 ? "🟡" : score >= 40 ? "🟠" : "🔴";
  return `${color} [${"█".repeat(filled)}${"░".repeat(empty)}]`;
}
