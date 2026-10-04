import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type Violation = { component: string; line: number; hookLine: number };

function hasReturn(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isReturnStatement(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => { if (!found && hasReturn(child)) found = true; });
  return found;
}

function hasDirectHookCall(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^use[A-Z0-9]/.test(node.expression.text)) return true;
  let found = false;
  ts.forEachChild(node, (child) => { if (!found && hasDirectHookCall(child)) found = true; });
  return found;
}

function componentHookOrderViolations(source: string): Violation[] {
  const file = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !["App", "VodApp", "LiveTv"].includes(statement.name.text) || !statement.body) continue;
    const statements = statement.body.statements;
    for (let index = 0; index < statements.length; index += 1) {
      const current = statements[index]!;
      const isConditionalReturn = ts.isReturnStatement(current)
        || ts.isIfStatement(current) && (hasReturn(current.thenStatement) || Boolean(current.elseStatement && hasReturn(current.elseStatement)));
      if (!isConditionalReturn) continue;
      for (const later of statements.slice(index + 1)) {
        if (!hasDirectHookCall(later)) continue;
        violations.push({
          component: statement.name.text,
          line: file.getLineAndCharacterOfPosition(current.getStart(file)).line + 1,
          hookLine: file.getLineAndCharacterOfPosition(later.getStart(file)).line + 1,
        });
        break;
      }
    }
  }
  return violations;
}

describe("React screen hook ordering", () => {
  it("detects a hook placed after a conditional early return", () => {
    expect(componentHookOrderViolations("function VodApp() { if (busy) return null; useEffect(() => {}); return null; }")).toHaveLength(1);
  });

  it("does not count hooks inside callbacks or hooks after the final return", () => {
    expect(componentHookOrderViolations("function LiveTv() { useEffect(() => { useThing(); }); if (!ready) return null; return null; }")).toEqual([]);
  });

  it("keeps route screens from returning before later hooks", () => {
    const root = resolve(process.cwd(), "src/app");
    const violations = ["App.tsx", "VodApp.tsx", "LiveTv.tsx"].flatMap((name) => {
      const source = readFileSync(resolve(root, name), "utf8");
      return componentHookOrderViolations(source).map((item) => `${name}:${item.line} (${item.component}) returns before hook at ${item.hookLine}`);
    });
    expect(violations).toEqual([]);
  });
});
