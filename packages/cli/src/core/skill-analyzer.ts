import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type {
  SkillAnalysis,
  SkillStructure,
  SkillMetrics,
  SectionInfo,
  CompatibilityInfo,
  QualityIndicator,
} from "../types.js";

// ---------- Section Parsing ----------

function parseSections(content: string): SectionInfo[] {
  const lines = content.split("\n");
  const sections: SectionInfo[] = [];
  let currentSection: SectionInfo | null = null;
  let lineCount = 0;
  let hasCode = false;
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) hasCode = true;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      if (currentSection) {
        currentSection.lineCount = lineCount;
        currentSection.hasCode = hasCode;
        sections.push(currentSection);
      }
      currentSection = {
        title: headingMatch[2].trim(),
        level: headingMatch[1].length,
        lineCount: 0,
        hasCode: false,
      };
      lineCount = 0;
      hasCode = false;
    } else {
      lineCount++;
    }
  }

  if (currentSection) {
    currentSection.lineCount = lineCount;
    currentSection.hasCode = hasCode;
    sections.push(currentSection);
  }

  return sections;
}

// ---------- Metrics Calculation ----------

function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 3) return 1;

  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  word = word.replace(/^y/, "");
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

function calculateReadability(content: string): number {
  const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = content.split(/\s+/).filter((w) => w.length > 0);

  if (sentences.length === 0 || words.length === 0) return 0;

  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const avgSentenceLength = words.length / sentences.length;
  const avgSyllablesPerWord = totalSyllables / words.length;

  // Flesch Reading Ease (0-100, higher = easier)
  const score =
    206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllablesPerWord;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function calculateMetrics(content: string): SkillMetrics {
  const words = content.split(/\s+/).filter((w) => w.length > 0);
  const sentences = content
    .split(/[.!?]+/)
    .filter((s) => s.trim().length > 0);
  const avgSentenceLength =
    sentences.length > 0 ? words.length / sentences.length : 0;

  const readabilityScore = calculateReadability(content);

  // Complexity based on multiple factors
  let complexity: "low" | "medium" | "high" = "medium";
  if (words.length < 200 && readabilityScore > 60) {
    complexity = "low";
  } else if (words.length > 800 || readabilityScore < 30) {
    complexity = "high";
  }

  // Specificity: ratio of technical terms, code blocks, specific instructions
  const codeBlockCount = (content.match(/```/g) || []).length / 2;
  const bulletPointCount = (content.match(/^[\s]*[-*]\s+/gm) || []).length;
  const specificity = Math.min(
    100,
    Math.round(
      (codeBlockCount * 15 + bulletPointCount * 5 + words.length * 0.02) * 2
    )
  );

  return {
    wordCount: words.length,
    sentenceCount: sentences.length,
    avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
    readabilityScore,
    complexity,
    specificity,
  };
}

// ---------- Compatibility Detection ----------

const AGENT_KEYWORDS: Record<string, string[]> = {
  "claude-code": ["claude code", "claude", "anthropic"],
  cursor: ["cursor"],
  windsurf: ["windsurf"],
  "github-copilot": ["github copilot", "copilot"],
  cline: ["cline"],
  continue: ["continue"],
  "codex-cli": ["codex", "codex cli"],
  goose: ["goose"],
  amp: ["amp"],
  "roo-code": ["roo code", "roo"],
  opencode: ["opencode"],
  "kilo-code": ["kilo code", "kilo"],
};

function detectCompatibility(content: string): CompatibilityInfo {
  const lowerContent = content.toLowerCase();
  const mentionedAgents: string[] = [];

  for (const [agent, keywords] of Object.entries(AGENT_KEYWORDS)) {
    if (keywords.some((kw) => lowerContent.includes(kw))) {
      mentionedAgents.push(agent);
    }
  }

  const hasUniversalScope =
    lowerContent.includes("universal") ||
    lowerContent.includes("all agents") ||
    lowerContent.includes("any agent") ||
    mentionedAgents.length === 0;

  // Detect tool requirements
  const toolPatterns = [
    /allowed[-_]?tools[:\s]+([^\n]+)/i,
    /requires?[:\s]+([^\n]+)/i,
    /dependencies[:\s]+([^\n]+)/i,
  ];

  const toolDependencies: string[] = [];
  for (const pattern of toolPatterns) {
    const match = content.match(pattern);
    if (match) {
      const tools = match[1]
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean);
      toolDependencies.push(...tools);
    }
  }

  return {
    mentionedAgents,
    hasUniversalScope,
    requiresSpecialTools: toolDependencies.length > 0,
    toolDependencies: [...new Set(toolDependencies)],
  };
}

// ---------- Quality Indicators ----------

function assessQuality(
  content: string,
  structure: SkillStructure,
  metrics: SkillMetrics
): QualityIndicator[] {
  const indicators: QualityIndicator[] = [];

  // Structure quality
  const structureScore = calculateStructureScore(structure);
  indicators.push({
    category: "structure",
    score: structureScore,
    maxScore: 100,
    description: getStructureDescription(structureScore),
    suggestions: getStructureSuggestions(structure),
  });

  // Clarity quality
  const clarityScore = Math.min(100, metrics.readabilityScore + 20);
  indicators.push({
    category: "clarity",
    score: clarityScore,
    maxScore: 100,
    description: getClarityDescription(clarityScore),
    suggestions: getClaritySuggestions(metrics),
  });

  // Completeness quality
  const completenessScore = calculateCompletenessScore(content, structure);
  indicators.push({
    category: "completeness",
    score: completenessScore,
    maxScore: 100,
    description: getCompletenessDescription(completenessScore),
    suggestions: getCompletenessSuggestions(content, structure),
  });

  // Best practices
  const bestPracticesScore = calculateBestPracticesScore(content, structure);
  indicators.push({
    category: "best-practices",
    score: bestPracticesScore,
    maxScore: 100,
    description: getBestPracticesDescription(bestPracticesScore),
    suggestions: getBestPracticesSuggestions(content),
  });

  return indicators;
}

function calculateStructureScore(structure: SkillStructure): number {
  let score = 0;

  // Has frontmatter (name, description)
  if (structure.hasFrontmatter) score += 25;

  // Has sections/headings
  if (structure.headingCount >= 2) score += 20;
  else if (structure.headingCount >= 1) score += 10;

  // Has code examples
  if (structure.hasExamples) score += 15;

  // Has instructions
  if (structure.hasInstructions) score += 15;

  // Reasonable length
  if (structure.totalSize > 100 && structure.totalSize < 50000) score += 15;
  else if (structure.totalSize > 0) score += 5;

  // Code blocks present
  if (structure.codeBlockCount > 0) score += 10;

  return Math.min(100, score);
}

function getStructureDescription(score: number): string {
  if (score >= 80) return "Well-structured with clear sections and examples";
  if (score >= 60) return "Adequate structure with room for improvement";
  if (score >= 40) return "Basic structure, missing key elements";
  return "Poor structure, needs significant improvement";
}

function getStructureSuggestions(structure: SkillStructure): string[] {
  const suggestions: string[] = [];
  if (!structure.hasFrontmatter) {
    suggestions.push("Add YAML frontmatter with name and description");
  }
  if (structure.headingCount < 2) {
    suggestions.push("Add more section headings to organize content");
  }
  if (!structure.hasExamples) {
    suggestions.push("Include code examples or usage patterns");
  }
  if (!structure.hasInstructions) {
    suggestions.push("Add clear step-by-step instructions");
  }
  if (structure.codeBlockCount === 0) {
    suggestions.push("Include code blocks for technical content");
  }
  return suggestions;
}

function getClarityDescription(score: number): string {
  if (score >= 80) return "Clear and easy to understand";
  if (score >= 60) return "Generally clear, some complex passages";
  if (score >= 40) return "Moderately difficult to follow";
  return "Difficult to understand, needs simplification";
}

function getClaritySuggestions(metrics: SkillMetrics): string[] {
  const suggestions: string[] = [];
  if (metrics.avgSentenceLength > 25) {
    suggestions.push("Break long sentences into shorter ones");
  }
  if (metrics.readabilityScore < 30) {
    suggestions.push("Use simpler words and shorter sentences");
  }
  if (metrics.complexity === "high") {
    suggestions.push("Reduce technical jargon where possible");
  }
  return suggestions;
}

function calculateCompletenessScore(
  content: string,
  structure: SkillStructure
): number {
  let score = 0;
  const lowerContent = content.toLowerCase();

  // Has description/purpose
  if (
    lowerContent.includes("purpose") ||
    lowerContent.includes("description") ||
    lowerContent.includes("what") ||
    lowerContent.includes("overview")
  ) {
    score += 20;
  }

  // Has usage instructions
  if (
    lowerContent.includes("usage") ||
    lowerContent.includes("how to") ||
    lowerContent.includes("instructions") ||
    lowerContent.includes("steps")
  ) {
    score += 20;
  }

  // Has examples
  if (
    lowerContent.includes("example") ||
    lowerContent.includes("```") ||
    lowerContent.includes("sample")
  ) {
    score += 20;
  }

  // Has error handling / edge cases
  if (
    lowerContent.includes("error") ||
    lowerContent.includes("edge case") ||
    lowerContent.includes("caveat") ||
    lowerContent.includes("warning") ||
    lowerContent.includes("note")
  ) {
    score += 15;
  }

  // Has parameters/options
  if (
    lowerContent.includes("parameter") ||
    lowerContent.includes("option") ||
    lowerContent.includes("argument") ||
    lowerContent.includes("flag")
  ) {
    score += 15;
  }

  // Reasonable content length
  if (structure.totalSize > 500) score += 10;

  return Math.min(100, score);
}

function getCompletenessDescription(score: number): string {
  if (score >= 80) return "Comprehensive with good coverage";
  if (score >= 60) return "Adequate coverage, some gaps";
  if (score >= 40) return "Partial coverage, missing key information";
  return "Incomplete, needs more content";
}

function getCompletenessSuggestions(
  content: string,
  _structure: SkillStructure
): string[] {
  const suggestions: string[] = [];
  const lowerContent = content.toLowerCase();

  if (!lowerContent.includes("example") && !content.includes("```")) {
    suggestions.push("Add usage examples");
  }
  if (
    !lowerContent.includes("error") &&
    !lowerContent.includes("edge case")
  ) {
    suggestions.push("Document error handling and edge cases");
  }
  if (
    !lowerContent.includes("parameter") &&
    !lowerContent.includes("option")
  ) {
    suggestions.push("Document available parameters or options");
  }
  return suggestions;
}

function calculateBestPracticesScore(
  content: string,
  structure: SkillStructure
): number {
  let score = 0;

  // Reasonable size (not too small, not too large)
  if (structure.totalSize > 200 && structure.totalSize < 20000) score += 20;
  else if (structure.totalSize > 0) score += 10;

  // Has clear title
  if (structure.sections.length > 0 && structure.sections[0].level <= 2) {
    score += 15;
  }

  // Uses bullet points for lists
  if (structure.bulletPointCount > 0) score += 10;

  // Code blocks are properly formatted
  if (structure.codeBlockCount > 0) score += 15;

  // Not too many code blocks (balance)
  if (structure.codeBlockCount > 0 && structure.codeBlockCount < 20) {
    score += 10;
  }

  // Has frontmatter
  if (structure.hasFrontmatter) score += 15;

  // Content is focused (not too long)
  const words = content.split(/\s+/).length;
  if (words < 2000) score += 15;
  else if (words < 5000) score += 10;

  return Math.min(100, score);
}

function getBestPracticesDescription(score: number): string {
  if (score >= 80) return "Follows best practices well";
  if (score >= 60) return "Generally good practices, minor improvements possible";
  if (score >= 40) return "Some best practices not followed";
  return "Needs significant improvement in best practices";
}

function getBestPracticesSuggestions(content: string): string[] {
  const suggestions: string[] = [];
  const words = content.split(/\s+/).length;

  if (words > 5000) {
    suggestions.push("Consider breaking into smaller, focused skills");
  }
  if (!content.includes("---")) {
    suggestions.push("Add YAML frontmatter for metadata");
  }
  if ((content.match(/```/g) || []).length === 0) {
    suggestions.push("Use fenced code blocks for code examples");
  }
  return suggestions;
}

// ---------- Technique Detection ----------

function detectTechniques(content: string): string[] {
  const techniques: string[] = [];
  const lowerContent = content.toLowerCase();

  const techniquePatterns: [RegExp, string][] = [
    [/chain[- ]?of[- ]?thought/i, "Chain-of-Thought Prompting"],
    [/few[- ]?shot/i, "Few-Shot Learning"],
    [/zero[- ]?shot/i, "Zero-Shot Learning"],
    [/role[- ]?play|persona|act as/i, "Role/Persona Assignment"],
    [/step[- ]?by[- ]?step/i, "Step-by-Step Instructions"],
    [/constraint|limitation|must not|do not/i, "Constraint Setting"],
    [/template|format|structure/i, "Template/Format Guidance"],
    [/example|e\.g\.|for instance/i, "Example-Driven Design"],
    [/context|background|scenario/i, "Context Provision"],
    [/output[- ]?format|respond with|return/i, "Output Format Control"],
    [/error[- ]?handling|edge case|fallback/i, "Error Handling Guidance"],
    [/validation|verify|check/i, "Validation Patterns"],
    [/tool[- ]?use|function[- ]?call|api/i, "Tool Integration"],
    [/memory|state|context[- ]?window/i, "Memory Management"],
    [/reflexion|self[- ]?correction|review/i, "Self-Correction Patterns"],
    [/multi[- ]?agent|delegate|sub[- ]?task/i, "Multi-Agent Coordination"],
    [/rag|retrieval|search|vector/i, "RAG Integration"],
    [/markdown|render|format/i, "Markdown Formatting"],
  ];

  for (const [pattern, technique] of techniquePatterns) {
    if (pattern.test(content)) {
      techniques.push(technique);
    }
  }

  return techniques;
}

// ---------- Main Analysis Function ----------

export async function analyzeSkill(
  skillPath: string
): Promise<SkillAnalysis> {
  const skillMdPath = path.join(skillPath, "SKILL.md");
  let content: string;

  try {
    content = await fs.readFile(skillMdPath, "utf-8");
  } catch {
    throw new Error(`Could not read SKILL.md at ${skillMdPath}`);
  }

  const parsed = matter(content);
  const bodyContent = parsed.content;
  const frontmatterData = parsed.data as Record<string, unknown>;

  // Parse structure
  const sections = parseSections(bodyContent);
  const codeBlockCount = (bodyContent.match(/```/g) || []).length / 2;
  const bulletPointCount = (bodyContent.match(/^[\s]*[-*]\s+/gm) || []).length;
  const headingCount = sections.length;

  const structure: SkillStructure = {
    totalFiles: await countFiles(skillPath),
    totalSize: content.length,
    hasFrontmatter: Object.keys(frontmatterData).length > 0,
    hasExamples:
      bodyContent.toLowerCase().includes("example") ||
      codeBlockCount > 0,
    hasInstructions:
      bodyContent.toLowerCase().includes("instruction") ||
      bodyContent.toLowerCase().includes("step") ||
      bodyContent.toLowerCase().includes("how to") ||
      bodyContent.toLowerCase().includes("usage"),
    sections,
    codeBlockCount,
    bulletPointCount,
    headingCount,
  };

  // Calculate metrics
  const metrics = calculateMetrics(bodyContent);

  // Detect techniques
  const techniques = detectTechniques(bodyContent);

  // Detect compatibility
  const compatibility = detectCompatibility(bodyContent);

  // Assess quality
  const qualityIndicators = assessQuality(bodyContent, structure, metrics);

  return {
    name:
      (frontmatterData.name as string) || path.basename(skillPath),
    description:
      (frontmatterData.description as string) || "No description",
    structure,
    metrics,
    techniques,
    compatibility,
    qualityIndicators,
  };
}

async function countFiles(dirPath: string): Promise<number> {
  let count = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isFile()) count++;
      else if (entry.isDirectory()) {
        count += await countFiles(path.join(dirPath, entry.name));
      }
    }
  } catch {
    // Ignore errors
  }
  return count;
}

// ---------- Formatting ----------

export function formatAnalysisReport(analysis: SkillAnalysis): string {
  const lines: string[] = [];

  lines.push(`# Skill Analysis: ${analysis.name}`);
  lines.push("");
  lines.push(`> ${analysis.description}`);
  lines.push("");

  // Structure
  lines.push("## Structure");
  lines.push(`- Files: ${analysis.structure.totalFiles}`);
  lines.push(`- Size: ${formatBytes(analysis.structure.totalSize)}`);
  lines.push(`- Sections: ${analysis.structure.headingCount}`);
  lines.push(`- Code blocks: ${analysis.structure.codeBlockCount}`);
  lines.push(`- Bullet points: ${analysis.structure.bulletPointCount}`);
  lines.push(`- Has frontmatter: ${analysis.structure.hasFrontmatter ? "Yes" : "No"}`);
  lines.push(`- Has examples: ${analysis.structure.hasExamples ? "Yes" : "No"}`);
  lines.push(`- Has instructions: ${analysis.structure.hasInstructions ? "Yes" : "No"}`);
  lines.push("");

  // Metrics
  lines.push("## Metrics");
  lines.push(`- Word count: ${analysis.metrics.wordCount}`);
  lines.push(`- Sentences: ${analysis.metrics.sentenceCount}`);
  lines.push(`- Avg sentence length: ${analysis.metrics.avgSentenceLength} words`);
  lines.push(`- Readability score: ${analysis.metrics.readabilityScore}/100`);
  lines.push(`- Complexity: ${analysis.metrics.complexity}`);
  lines.push(`- Specificity: ${analysis.metrics.specificity}/100`);
  lines.push("");

  // Techniques
  if (analysis.techniques.length > 0) {
    lines.push("## Techniques Detected");
    for (const technique of analysis.techniques) {
      lines.push(`- ${technique}`);
    }
    lines.push("");
  }

  // Compatibility
  lines.push("## Compatibility");
  lines.push(
    `- Universal scope: ${analysis.compatibility.hasUniversalScope ? "Yes" : "No"}`
  );
  if (analysis.compatibility.mentionedAgents.length > 0) {
    lines.push(
      `- Mentioned agents: ${analysis.compatibility.mentionedAgents.join(", ")}`
    );
  }
  if (analysis.compatibility.requiresSpecialTools) {
    lines.push(
      `- Tool dependencies: ${analysis.compatibility.toolDependencies.join(", ")}`
    );
  }
  lines.push("");

  // Quality Indicators
  lines.push("## Quality Assessment");
  for (const indicator of analysis.qualityIndicators) {
    const scorePercent = Math.round(
      (indicator.score / indicator.maxScore) * 100
    );
    const bar = getProgressBar(scorePercent);
    lines.push(`### ${capitalize(indicator.category)}`);
    lines.push(`${bar} ${indicator.score}/${indicator.maxScore}`);
    lines.push(`${indicator.description}`);
    if (indicator.suggestions.length > 0) {
      lines.push("Suggestions:");
      for (const suggestion of indicator.suggestions) {
        lines.push(`  - ${suggestion}`);
      }
    }
    lines.push("");
  }

  // Sections detail
  if (analysis.structure.sections.length > 0) {
    lines.push("## Section Breakdown");
    for (const section of analysis.structure.sections) {
      const indent = "  ".repeat(section.level - 1);
      const codeTag = section.hasCode ? " [code]" : "";
      lines.push(
        `${indent}${"#".repeat(section.level)} ${section.title} (${section.lineCount} lines)${codeTag}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getProgressBar(percent: number): string {
  const filled = Math.round(percent / 5);
  const empty = 20 - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
