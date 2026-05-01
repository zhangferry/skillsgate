import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { parseSource, getSourceLabel } from "../core/source-parser.js";
import { cloneRepo, cleanupTempDir, GitCloneError } from "../core/git.js";
import { discoverSkills, filterSkills } from "../core/skill-discovery.js";
import { analyzeSkill, formatAnalysisReport } from "../core/skill-analyzer.js";
import { dirExists } from "../utils/fs.js";
import { fmt } from "../ui/format.js";
import {
  SkillsGateError,
  NoSkillsInRepoError,
} from "../utils/errors.js";

interface AnalyzeOptions {
  output: "text" | "json";
  skill?: string;
}

export async function runAnalyze(args: string[]): Promise<void> {
  const { source, options } = parseAnalyzeOptions(args);

  if (!source) {
    console.error(fmt.error("Missing source. Usage: skillsgate analyze <source>"));
    process.exit(1);
  }

  const parsed = parseSource(source);
  const sourceLabel = getSourceLabel(parsed);

  p.intro(fmt.bold(`Analyzing skills from ${sourceLabel}`));

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

    // Analyze each skill
    const results = [];
    for (const skill of skills) {
      const skillDir = path.dirname(skill.filePath);
      const spinner = p.spinner();
      spinner.start(`Analyzing ${skill.name}...`);

      try {
        const analysis = await analyzeSkill(skillDir);
        spinner.stop(`Analysis complete for ${skill.name}`);
        results.push(analysis);
      } catch (err) {
        spinner.stop(`Failed to analyze ${skill.name}`);
        p.log.warn(
          `Could not analyze ${skill.name}: ${(err as Error).message}`
        );
      }
    }

    // Output results
    if (options.output === "json") {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const analysis of results) {
        console.log("");
        console.log(formatAnalysisReport(analysis));
      }
    }

    p.outro(
      fmt.success(
        `Analysis complete — ${results.length} skill(s) analyzed`
      )
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

function parseAnalyzeOptions(args: string[]): {
  source: string | undefined;
  options: AnalyzeOptions;
} {
  const options: AnalyzeOptions = {
    output: "text",
  };
  let source: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      options.output = "json";
    } else if ((arg === "-s" || arg === "--skill") && args[i + 1]) {
      options.skill = args[++i];
    } else if (!arg.startsWith("-")) {
      source = arg;
    }
  }

  return { source, options };
}
