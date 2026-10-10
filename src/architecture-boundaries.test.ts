import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [path] : [];
  });
}

function productionFiles(directory: string): string[] {
  return sourceFiles(directory).filter((path) => !/(?:^|\.)test\.(?:ts|tsx|mts|cts)$/.test(path) && !path.endsWith(".d.ts"));
}

function parse(path: string): ts.SourceFile {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

function moduleSpecifiers(file: ts.SourceFile): Array<{ value: string; node: ts.Node }> {
  const result: Array<{ value: string; node: ts.Node }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) result.push({ value: specifier.text, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

function isCorePlatformImport(sourcePath: string, specifier: string): boolean {
  if (/^(?:node:|react(?:-dom)?(?:\/|$))/.test(specifier)) return true;
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(sourcePath), specifier).split(sep).join("/");
  return /\/src\/(?:platform|app|bootstrap)\//.test(target);
}

function identifierReferences(file: ts.SourceFile, names: ReadonlySet<string>): ts.Identifier[] {
  const result: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const parent = node.parent;
      const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || ((ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)
          || ts.isMethodSignature(parent) || ts.isPropertyAssignment(parent)) && parent.name === node);
      if (!isPropertyName) result.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

function location(path: string, node: ts.Node): string {
  const { line } = parse(path).getLineAndCharacterOfPosition(node.getStart());
  return `${relative(sourceRoot, path)}:${line + 1}`;
}

describe("shared architecture boundaries", () => {
  it("keeps the domain core free of app, platform, runtime, and host globals", () => {
    const violations: string[] = [];
    const forbiddenGlobals = new Set([
      "window", "document", "localStorage", "globalThis", "process", "require", "Buffer",
      "navigator", "fetch", "XMLHttpRequest", "HTMLElement", "HTMLVideoElement",
    ]);
    for (const path of productionFiles(resolve(sourceRoot, "core"))) {
      const file = parse(path);
      for (const item of moduleSpecifiers(file)) {
        if (isCorePlatformImport(path, item.value)) violations.push(`${location(path, item.node)} imports ${item.value}`);
      }
      for (const identifier of identifierReferences(file, forbiddenGlobals)) {
        violations.push(`${location(path, identifier)} references host global ${identifier.text}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps app screens behind runtime and playback contracts", () => {
    const violations: string[] = [];
    const forbiddenIdentifiers = new Set([
      "isTizenRuntime", "isTizenAvPlayAvailable", "TizenAvPlayPlayer", "TizenLiveRelayPlayer", "HtmlVideoPlayer",
      "isWebOsRuntime", "WebOsHtmlVideoPlayer", "WebOsPlaybackPlayerFactory", "PalmSystem",
    ]);
    const concretePlayerPath = /\/platform\/(?:tizen\/(?:avplay-player|live-relay-player)|browser\/html-video-player|webos\/(?:runtime|html-video-player|player-factory))(?:\.ts)?$/;
    for (const path of productionFiles(resolve(sourceRoot, "app"))) {
      const file = parse(path);
      for (const item of moduleSpecifiers(file)) {
        if (!item.value.startsWith(".")) continue;
        const target = resolve(dirname(path), item.value).split(sep).join("/");
        if (concretePlayerPath.test(target)) violations.push(`${location(path, item.node)} imports platform player ${item.value}`);
      }
      for (const identifier of identifierReferences(file, forbiddenIdentifiers)) {
        violations.push(`${location(path, identifier)} references platform-specific player/runtime API ${identifier.text}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
