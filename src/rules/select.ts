import { readFileSync } from "node:fs";
import { join } from "node:path";

const ORDER = [
  "php",
  "javascript",
  "typescript",
  "python",
  "rust",
  "go",
  "shell",
  "markdown",
  "github-actions",
] as const;

export function selectRuleFiles(paths: string[]): string[] {
  const langs = new Set<string>();
  for (const path of paths) {
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(path)) {
      langs.add("github-actions");
    }
    if (/\.(php|phtml)$/.test(path)) langs.add("php");
    if (/\.(js|jsx|mjs|cjs|vue)$/.test(path)) langs.add("javascript");
    if (/\.(ts|tsx)$/.test(path)) langs.add("typescript");
    if (/\.py$/.test(path)) langs.add("python");
    if (/\.rs$/.test(path)) langs.add("rust");
    if (/\.go$/.test(path)) langs.add("go");
    if (/\.(sh|bash|zsh)$/.test(path)) langs.add("shell");
    if (/\.(md|markdown)$/.test(path)) langs.add("markdown");
  }
  return ORDER.filter((lang) => langs.has(lang)).map(
    (lang) => `rules/${lang}.md`
  );
}

export function loadSelectedRules(paths: string[], root = "."): string {
  return selectRuleFiles(paths)
    .map((file) => readFileSync(join(root, file), "utf8").trim())
    .filter(Boolean)
    .join("\n\n");
}
