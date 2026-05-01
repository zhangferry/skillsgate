import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { parseSource, getSourceLabel } from "../core/source-parser.js";
import { cloneRepo, cleanupTempDir, GitCloneError } from "../core/git.js";
import { discoverSkills, filterSkills } from "../core/skill-discovery.js";
import {
  evaluateSkill,
  formatEvaluationReport,
  type EvaluationOptions,
} from "../core/skill-evaluator.js";
import { dirExists } from "../utils/fs.js";
import { fmt } from "../ui/format.js";
import { confirmAction } from "../ui/prompts.js";
import {
  SkillsGateError,
  NoSkillsInRepoError,
} from "../utils/errors.js";
import type { ScannerType, EvaluationMode } from "../types.js";

interface EvaluateOptions {
  scanner?: string;
  mode: EvaluationMode;
  timeout: number;
  yes: boolean;
  output: "text" | "json";
}

export async function runEvaluate(args: string[]): Promise<void> {
  const { source, options } = parseEvaluateOptions(args);

  if (!source) {
    console.error(
      fmt.error("Missing source. Usage: skillsgate evaluate <source>")
    );
    process.exit(1);
  }

  const parsed = parseSource(source);
  const sourceLabel = getSourceLabel(parsed);

  p.intro(fmt.bold(`Evaluating skills from ${sourceLabel}`));

  let tmpDir: string | undefined;

  try {
    let skillDir: string;

    if (parsed.type === "local") {
      if (!(await dirExists(parsed.localPath!))) {
        throw new SkillsGateError(
          `Local path does not exist: ${parsed.localPath}`,
          "LOCAL_PATH_NOT_FOUND"
        );
      }
      skillDir = parsed.localPath!;
    } else {
      const spinner = p.spinner();
      spinner.start(`Cloning ${sourceLabel}...`);
      tmpDir = await cloneRepo(parsed);
      spinner.stop("Repository cloned.");
      skillDir = tmpDir;
    }

    // Discover skills
    let skills = await discoverSkills(skillDir, parsed.subpath);
    if (skills.length === 0) {
      throw new NoSkillsInRepoError(sourceLabel);
    }

    // Apply skill filter
    if (parsed.skillFilter) {
      skills = filterSkills(skills, parsed.skillFilter);
      if (skills.length === 0) {
        throw new SkillsGateError(
          `Skill "${parsed.skillFilter}" not found`,
          "SKILL_NOT_FOUND"
        );
      }
    }

    p.log.info(
      `Found ${skills.length} skill(s): ${skills.map((s) => fmt.skillName(s.name)).join(", ")}`
    );

    // Large skill warning
    const totalSize = skills.reduce((sum, s) => sum + s.content.length, 0);
    if (totalSize > 50000) {
      p.log.warn(
        `Total skill content is ${Math.round(totalSize / 1000)}KB. This may use significant API credits.`
      );
      if (!options.yes) {
        const proceed = await confirmAction("Continue with evaluation?");
        if (!proceed) {
          p.outro("Evaluation cancelled.");
          return;
        }
      }
    }

    // Run evaluation
    const evalOptions: EvaluationOptions = {
      scanner: options.scanner as ScannerType | undefined,
      mode: options.mode,
      timeout: options.timeout,
      yes: options.yes,
    };

    const spinner = p.spinner();
    spinner.start(`Evaluating with AI agent (mode: ${options.mode})...`);

    const result = await evaluateSkill({
      skills: skills.map((s) => ({
        name: s.name,
        content: s.content,
        relativePath: path.relative(skillDir, s.filePath),
      })),
      options: evalOptions,
      cwd: skillDir,
    });

    if (result.timedOut) {
      spinner.stop("Evaluation timed out");
      throw new SkillsGateError(
        `Evaluation timed out after ${options.timeout}s. Try increasing --timeout.`,
        "EVAL_TIMEOUT"
      );
    }

    if (result.creditsExhausted) {
      spinner.stop("Credits exhausted");
      throw new SkillsGateError(
        `${result.scannerUsed} ran out of API credits. Try a different agent with --scanner.`,
        "CREDITS_EXHAUSTED"
      );
    }

    spinner.stop(`Evaluation complete (${result.scannerUsed}, ${result.durationMs}ms)`);

    if (result.parseFailed) {
      p.log.warn("Could not parse structured output from agent.");
      if (result.rawOutput) {
        p.log.message(fmt.dim(result.rawOutput.slice(0, 1000)));
      }
    }

    // Set skill names on evaluation
    if (result.evaluation && skills.length === 1) {
      result.evaluation.name = skills[0].name;
    } else if (result.evaluation) {
      result.evaluation.name = skills.map((s) => s.name).join(", ");
    }

    // Output results
    if (result.evaluation) {
      if (options.output === "json") {
        console.log(JSON.stringify(result.evaluation, null, 2));
      } else {
        console.log("");
        console.log(formatEvaluationReport(result.evaluation));
      }
    }

    p.outro(
      result.evaluation
        ? fmt.success(
            `Evaluation complete — Score: ${result.evaluation.overallScore}/100`
          )
        : fmt.dim("Evaluation complete — could not parse results")
    );
  } catch (err) {
    if (err instanceof GitCloneError) {
      if (err.isAuth) {
        p.log.error(
          "Authentication failed. For private repos, set GITHUB_TOKEN."
        );
      } else {
        p.log.error(err.message);
      }
    } else if (err instanceof SkillsGateError) {
      p.log.error(err.message);
    } else if (err instanceof Error) {
      p.log.error(err.message);
    }
    process.exit(1);
  } finally {
    if (tmpDir) await cleanupTempDir(tmpDir);
  }
}

function parseEvaluateOptions(args: string[]): {
  source: string | undefined;
  options: EvaluateOptions;
} {
  const options: EvaluateOptions = {
    mode: "standard",
    timeout: 120,
    yes: false,
    output: "text",
  };
  let source: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-y" || arg === "--yes") {
      options.yes = true;
    } else if (arg === "--json") {
      options.output = "json";
    } else if ((arg === "-s" || arg === "--scanner") && args[i + 1]) {
      options.scanner = args[++i];
    } else if (arg === "--mode" && args[i + 1]) {
      const mode = args[++i] as EvaluationMode;
      if (["quick", "standard", "detailed"].includes(mode)) {
        options.mode = mode;
      }
    } else if (arg === "--timeout" && args[i + 1]) {
      options.timeout = parseInt(args[++i], 10) || 120;
    } else if (!arg.startsWith("-")) {
      source = arg;
    }
  }

  return { source, options };
}
