// AST worker — runs inside a worker_threads Worker.
//
// Receives one Pkg per message, globs every .ts/.tsx in its sourceRoot, and
// for each file emits a WorkerFileResult containing top-level symbol metadata.
//
// CRITICAL: no type checker, no ts.Program. We only call ts.createSourceFile
// per file. With ~25k files at ~3ms each, distributed across ~8 workers, the
// whole pass lands in ~10 seconds.
//
// We also do NOT touch SQLite from here — better-sqlite3 connections aren't
// safe to share across worker_threads. The main thread owns all writes; we
// just return result rows.

import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { globFiles } from "../util/glob-helpers.js";
import type { Pkg, SymbolKind } from "../types.js";

interface WorkerInit {
  targetRepo: string;
  excludeGlobs: string[];
}

export interface WorkerSymbol {
  name: string;
  kind: SymbolKind;
  isExported: boolean;
  isDefault: boolean;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  jsdoc?: string;
}

export interface WorkerImport {
  moduleSpecifier: string;
  importedName: string | null; // null for side-effect imports
  isTypeOnly: boolean;
}

export interface WorkerFileResult {
  path: string; // repo-relative, forward-slash
  language: "ts" | "tsx";
  bytes: number;
  isIndexFile: boolean;
  symbols: WorkerSymbol[];
  imports: WorkerImport[];
}

export interface WorkerJobMsg {
  pkg: Pkg;
}

export interface WorkerResultMsg {
  pkg: string;
  files: WorkerFileResult[];
  error?: string;
}

const init = workerData as WorkerInit;

if (!parentPort) {
  throw new Error(
    "ast-worker.ts must be loaded inside a worker_threads Worker",
  );
}

parentPort.on("message", async (msg: WorkerJobMsg) => {
  try {
    const result = await processPackage(msg.pkg);
    parentPort!.postMessage(result);
  } catch (err) {
    const errorMsg: WorkerResultMsg = {
      pkg: msg.pkg.name,
      files: [],
      error: err instanceof Error ? err.message : String(err),
    };
    parentPort!.postMessage(errorMsg);
  }
});

// ---- Per-package processing --------------------------------------------

async function processPackage(pkg: Pkg): Promise<WorkerResultMsg> {
  const sourceRootAbs = join(init.targetRepo, pkg.sourceRoot);

  const relFiles = await globFiles({
    cwd: sourceRootAbs,
    patterns: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    ignore: init.excludeGlobs,
  });

  const results: WorkerFileResult[] = [];

  for (const relInSrc of relFiles) {
    const abs = join(sourceRootAbs, relInSrc);
    const repoRel = `${pkg.sourceRoot}/${relInSrc}`.replace(/\\/g, "/");
    const text = await readFile(abs, "utf8");

    const language: "ts" | "tsx" = relInSrc.endsWith(".tsx") ? "tsx" : "ts";
    const isIndexFile =
      relInSrc === "index.ts" ||
      relInSrc === "index.tsx" ||
      relInSrc === "index.mts" ||
      relInSrc === "index.cts";

    const sf = ts.createSourceFile(
      abs,
      text,
      ts.ScriptTarget.ES2022,
      // setParentNodes=false: we don't traverse upward; saves memory across 25k files.
      false,
      language === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const symbols = extractSymbols(sf, text, language);
    const imports = extractImports(sf);

    results.push({
      path: repoRel,
      language,
      bytes: Buffer.byteLength(text, "utf8"),
      isIndexFile,
      symbols,
      imports,
    });
  }

  return { pkg: pkg.name, files: results };
}

// ---- Import extraction --------------------------------------------------

function extractImports(sf: ts.SourceFile): WorkerImport[] {
  const out: WorkerImport[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
    const isTypeOnly = stmt.importClause?.isTypeOnly ?? false;
    const clause = stmt.importClause;

    // Side-effect: `import './foo'`
    if (!clause) {
      out.push({ moduleSpecifier: spec, importedName: null, isTypeOnly });
      continue;
    }

    // Default import: `import Foo from '...'`
    if (clause.name) {
      out.push({
        moduleSpecifier: spec,
        importedName: clause.name.text,
        isTypeOnly,
      });
    }

    const named = clause.namedBindings;
    if (named) {
      // Namespace import: `import * as Foo from '...'`
      if (ts.isNamespaceImport(named)) {
        out.push({
          moduleSpecifier: spec,
          importedName: "*" + named.name.text,
          isTypeOnly,
        });
      } else if (ts.isNamedImports(named)) {
        // Named imports: `import { X, Y as Z } from '...'`
        for (const el of named.elements) {
          out.push({
            moduleSpecifier: spec,
            importedName: el.name.text,
            isTypeOnly: isTypeOnly || (el.isTypeOnly ?? false),
          });
        }
      }
    }
  }
  return out;
}

// ---- Symbol extraction --------------------------------------------------

function extractSymbols(
  sf: ts.SourceFile,
  text: string,
  language: "ts" | "tsx",
): WorkerSymbol[] {
  const out: WorkerSymbol[] = [];
  for (const stmt of sf.statements) {
    addFromStatement(stmt, sf, text, language, out);
  }
  return out;
}

function addFromStatement(
  stmt: ts.Statement,
  sf: ts.SourceFile,
  text: string,
  language: "ts" | "tsx",
  out: WorkerSymbol[],
): void {
  const modifiers = ts.canHaveModifiers(stmt)
    ? (ts.getModifiers(stmt) ?? [])
    : [];
  const isExported = modifiers.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
  const isDefault = modifiers.some(
    (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
  );

  // FunctionDeclaration: export function foo() {}
  if (ts.isFunctionDeclaration(stmt)) {
    const name = stmt.name?.text ?? (isDefault ? "default" : null);
    if (!name) return;
    out.push({
      name,
      kind: classifyFunctionKind(name, language),
      isExported,
      isDefault,
      lineStart: lineOf(sf, stmt.getStart(sf, false)),
      lineEnd: lineOf(sf, stmt.end),
      signature: extractSignature(stmt, sf),
      jsdoc: extractJsDoc(stmt, text),
    });
    return;
  }

  // ClassDeclaration: export class Foo {}
  if (ts.isClassDeclaration(stmt)) {
    const name = stmt.name?.text ?? (isDefault ? "default" : null);
    if (!name) return;
    out.push({
      name,
      kind: "class",
      isExported,
      isDefault,
      lineStart: lineOf(sf, stmt.getStart(sf, false)),
      lineEnd: lineOf(sf, stmt.end),
      signature: extractSignature(stmt, sf),
      jsdoc: extractJsDoc(stmt, text),
    });
    return;
  }

  if (ts.isInterfaceDeclaration(stmt)) {
    out.push({
      name: stmt.name.text,
      kind: "interface",
      isExported,
      isDefault: false,
      lineStart: lineOf(sf, stmt.getStart(sf, false)),
      lineEnd: lineOf(sf, stmt.end),
      signature: extractSignature(stmt, sf),
      jsdoc: extractJsDoc(stmt, text),
    });
    return;
  }

  if (ts.isTypeAliasDeclaration(stmt)) {
    out.push({
      name: stmt.name.text,
      kind: "type",
      isExported,
      isDefault: false,
      lineStart: lineOf(sf, stmt.getStart(sf, false)),
      lineEnd: lineOf(sf, stmt.end),
      signature: extractSignature(stmt, sf),
      jsdoc: extractJsDoc(stmt, text),
    });
    return;
  }

  if (ts.isEnumDeclaration(stmt)) {
    out.push({
      name: stmt.name.text,
      kind: "enum",
      isExported,
      isDefault: false,
      lineStart: lineOf(sf, stmt.getStart(sf, false)),
      lineEnd: lineOf(sf, stmt.end),
      signature: extractSignature(stmt, sf),
      jsdoc: extractJsDoc(stmt, text),
    });
    return;
  }

  // VariableStatement: export const foo = ...
  if (ts.isVariableStatement(stmt)) {
    const jsdoc = extractJsDoc(stmt, text);
    const sig = extractSignature(stmt, sf);
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      const kind = classifyVarKind(name, decl.initializer, language);
      out.push({
        name,
        kind,
        isExported,
        isDefault: false,
        lineStart: lineOf(sf, decl.getStart(sf, false)),
        lineEnd: lineOf(sf, decl.end),
        signature: sig,
        jsdoc,
      });
    }
    return;
  }

  // Skip everything else (import, export, expression statement, etc.).
}

// ---- Heuristics ---------------------------------------------------------

// React hook convention: identifier starts with "use" followed by an uppercase letter.
function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

// PascalCase: starts with capital letter.
function isPascalCase(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function classifyFunctionKind(
  name: string,
  language: "ts" | "tsx",
): SymbolKind {
  if (isHookName(name)) return "hook";
  if (language === "tsx" && isPascalCase(name)) return "component";
  return "function";
}

function classifyVarKind(
  name: string,
  init: ts.Expression | undefined,
  language: "ts" | "tsx",
): SymbolKind {
  // For const X = (...) => ... or = function (...) ... we can apply hook/component rules.
  const isFnLike =
    init !== undefined &&
    (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
  if (isFnLike) {
    if (isHookName(name)) return "hook";
    if (language === "tsx" && isPascalCase(name)) return "component";
    return "const";
  }
  // Non-function const: always 'const' (object literals, primitives, calls).
  return "const";
}

// ---- Position + signature + jsdoc helpers -------------------------------

function lineOf(sf: ts.SourceFile, pos: number): number {
  // TS API is 0-indexed; humans expect 1-indexed.
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function extractSignature(
  node: ts.Node,
  sf: ts.SourceFile,
): string | undefined {
  const full = node.getText(sf);

  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node)
  ) {
    // Cut at the first '{' (start of body). Avoids dragging in the entire function body.
    const idx = full.indexOf("{");
    if (idx > 0) return collapseWs(full.substring(0, idx));
  }

  if (ts.isVariableStatement(node)) {
    // Cut at first '=' so we keep "export const useFoo: T" but drop the initializer.
    const idx = full.indexOf("=");
    if (idx > 0) return collapseWs(full.substring(0, idx));
  }

  // type/enum and fallthrough: full text. Truncated to 500 chars in the writer.
  return collapseWs(full);
}

function collapseWs(s: string): string | undefined {
  const out = s.replace(/\s+/g, " ").trim();
  return out || undefined;
}

// Pulls the first paragraph of the JSDoc comment immediately preceding `node`.
// Strips leading `*` markers and stops at the first `@tag` or blank line.
// Works without parent nodes — uses ts.getLeadingCommentRanges over raw text.
function extractJsDoc(node: ts.Node, text: string): string | undefined {
  const ranges = ts.getLeadingCommentRanges(text, node.pos);
  if (!ranges) return undefined;

  // Iterate from the LAST range (closest to node) backwards.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    if (!r) continue;
    const block = text.substring(r.pos, r.end);
    if (!block.startsWith("/**") || !block.endsWith("*/")) continue;

    const inner = block
      .slice(3, -2)
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, ""))
      .join("\n")
      .trim();

    // First paragraph: lines up to first blank line OR first @tag.
    const lines = inner.split("\n");
    const para: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith("@")) break;
      if (line === "" && para.length > 0) break;
      if (line !== "") para.push(line);
    }
    const result = para.join(" ").trim();
    return result || undefined;
  }
  return undefined;
}
