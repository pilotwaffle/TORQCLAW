import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type {
  BuiltInProfileDefinition,
  CapabilityClass,
  ProfileId,
  SideEffectClass,
} from '../../packages/contracts/src/profile.js';
import type { RegisteredTool } from '../../packages/bridge/src/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const PINNED_BASE = '8dfa98fe7dd03d6ef45804b37bb2a09e980dd6c2';
export const DOC_START = '<!-- PROFILE-CONFORMANCE:START -->';
export const DOC_END = '<!-- PROFILE-CONFORMANCE:END -->';

export interface ClassifierFixture {
  id: string;
  rawToolId: string;
  condition: {
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
    configCapability?: CapabilityClass;
  };
  classifierOutput: CapabilityClass;
  scopeMode: 'read' | 'write';
  sideEffect: SideEffectClass;
  purpose: string;
}

export interface GoldenManifest {
  schemaVersion: string;
  baseCommit: string;
  profiles: Record<ProfileId, BuiltInProfileDefinition>;
  classifierFixtures: ClassifierFixture[];
  fixedPolicyVector: {
    label: string;
    canonicalPreimage: string;
    expectedSha256: string;
  };
}

export function readGolden(): GoldenManifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'profile-conformance-golden.json'), 'utf8')) as GoldenManifest;
}

export function namespaceOf(toolName: string): string {
  return toolName.split('__', 1)[0] ?? '';
}

export function expectedSideEffect(tool: Pick<RegisteredTool, 'name' | 'capability'>): SideEffectClass {
  if (tool.capability === 'read') return 'none';
  if (tool.capability === 'exec') return 'process';
  if (tool.capability === 'send') return 'network_send';
  const namespace = namespaceOf(tool.name);
  if (namespace === 'filesystem') return 'filesystem_write';
  if (namespace === 'browser' || namespace === 'playwright') return 'browser_mutation';
  return 'process';
}

export function frozenTool(
  name: string,
  capability: RegisteredTool['capability'],
  requiresApproval = capability !== 'read',
  extra: Partial<RegisteredTool> = {},
): Readonly<RegisteredTool> {
  const [sourceServerId = '', rawName = name] = name.split('__', 2);
  return Object.freeze({
    name,
    rawName,
    sourceServerId,
    description: `conformance:${name}`,
    inputSchema: Object.freeze({ type: 'object' }),
    capability,
    requiresApproval,
    ...extra,
  });
}

export const SYNTHETIC_TOOLS: readonly Readonly<RegisteredTool>[] = Object.freeze([
  frozenTool('filesystem__read_file', 'read', false, { pathScope: { read: [], write: [], deny: [] } }),
  frozenTool('filesystem__write_file', 'write', true, { pathScope: { read: [], write: [], deny: [] } }),
  frozenTool('browser__snapshot', 'read', false),
  frozenTool('browser__click', 'write', true),
  frozenTool('playwright__snapshot', 'read', false),
  frozenTool('playwright__fill', 'write', true),
  frozenTool('websearch__search', 'read', false),
  frozenTool('shell__inspect', 'read', false),
  frozenTool('shell__run_command', 'exec', true),
  frozenTool('terminal__set_option', 'write', true),
  frozenTool('sandbox__exec', 'exec', true),
  frozenTool('mailer__send_email', 'send', true),
  frozenTool('unknown__frobnicate', 'write', true),
]);

export function declaredAllows(definition: BuiltInProfileDefinition, tool: Pick<RegisteredTool, 'name' | 'capability'>): boolean {
  const namespace = namespaceOf(tool.name);
  return (definition.allowedNamespaces.includes('*') || definition.allowedNamespaces.includes(namespace))
    && definition.allowedCapabilities.includes(tool.capability)
    && definition.allowedSideEffects.includes(expectedSideEffect(tool));
}

function cell(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}=${String(item)}`).join(', ');
  return String(value);
}

export function renderProfileTable(manifest: GoldenManifest): string {
  const rows = (Object.keys(manifest.profiles) as ProfileId[]).map((id) => {
    const p = manifest.profiles[id];
    return `| ${id} | ${cell(p.allowedNamespaces)} | ${cell(p.allowedCapabilities)} | ${cell(p.allowedSideEffects)} | ${cell(p.allowedTiers)} | ${cell(p.scopes)} | ${cell(p.approvalRequirements)} |`;
  });
  return [
    DOC_START,
    '| Profile | Namespaces | Capabilities | Side effects | Tiers | Scopes | Approval declarations |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    DOC_END,
  ].join('\n');
}

export function documentedProfileTable(markdown: string): string {
  const start = markdown.indexOf(DOC_START);
  const end = markdown.indexOf(DOC_END);
  if (start < 0 || end < start) throw new Error('profile conformance documentation markers are missing or reversed');
  const after = end + DOC_END.length;
  if (markdown.indexOf(DOC_START, start + 1) !== -1 || markdown.indexOf(DOC_END, after) !== -1) {
    throw new Error('profile conformance documentation markers are not unique');
  }
  return markdown.slice(start, after);
}

const PROD_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const EXCLUDED_PARTS = new Set(['tests', 'test', 'node_modules', 'generated', 'dist', 'build', '.next', 'coverage']);

function extension(path: string): string {
  const match = path.match(/\.[^.\\/]+$/);
  return match?.[0] ?? '';
}

function walkProduction(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relParts = relative(REPO_ROOT, full).split(/[\\/]/);
    if (relParts.some((part) => EXCLUDED_PARTS.has(part))) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) walkProduction(full, out);
    else if (PROD_EXTENSIONS.has(extension(full)) && !full.endsWith('.d.ts')) out.push(full);
  }
}

export interface ResolvedCall {
  file: string;
  line: number;
  importedName: string;
  argumentTexts: string[];
  resolved: boolean;
}

function symbolName(checker: ts.TypeChecker, expression: ts.Expression): { name?: string; resolved: boolean } {
  let symbol = checker.getSymbolAtLocation(expression);
  if (!symbol && ts.isPropertyAccessExpression(expression)) symbol = checker.getSymbolAtLocation(expression.name);
  if (!symbol) return { resolved: false };
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  const declarations = symbol.getDeclarations() ?? [];
  const declarationName = declarations.find((d) => ts.isFunctionDeclaration(d) || ts.isImportSpecifier(d));
  if (declarationName && ts.isFunctionDeclaration(declarationName)) return { name: declarationName.name?.text, resolved: true };
  return { name: symbol.getName(), resolved: true };
}

export function resolveAuditTsconfig(root: string, configFile = 'tsconfig.base.json'): string {
  const resolvedConfig = resolve(join(root, configFile));
  if (!resolvedConfig.startsWith(resolve(root) + sep)) {
    throw new Error(`profile-conformance: tsconfig resolved OUTSIDE the repository: ${resolvedConfig}`);
  }
  if (!ts.sys.fileExists(resolvedConfig)) {
    throw new Error(`profile-conformance: in-tree tsconfig is absent: ${resolvedConfig}`);
  }
  return resolvedConfig;
}

export function inventoryProductionCalls(watchedNames: readonly string[]): ResolvedCall[] {
  const files: string[] = [];
  for (const root of ['apps', 'packages', 'engines', 'ops', 'scripts']) {
    const absolute = join(REPO_ROOT, root);
    try { if (statSync(absolute).isDirectory()) walkProduction(absolute, files); } catch { /* optional production root */ }
  }
  const configPath = resolveAuditTsconfig(REPO_ROOT);
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, REPO_ROOT);
  const program = ts.createProgram({ rootNames: files, options: parsed.options });
  program.getTypeChecker(); // force full TypeScript binding/module resolution
  const wanted = new Set(watchedNames);
  const fileSet = new Set(files.map((file) => resolve(file).toLowerCase()));
  const calls: ResolvedCall[] = [];
  for (const source of program.getSourceFiles()) {
    if (!fileSet.has(resolve(source.fileName).toLowerCase())) continue;
    const aliases = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
      const bindings = statement.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) aliases.set(item.name.text, item.propertyName?.text ?? item.name.text);
      } else namespaces.add(bindings.name.text);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        let candidate = '';
        let resolvedCall = false;
        if (ts.isIdentifier(node.expression)) {
          candidate = aliases.get(node.expression.text) ?? node.expression.text;
          resolvedCall = aliases.has(node.expression.text);
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          candidate = node.expression.name.text;
          resolvedCall = ts.isIdentifier(node.expression.expression) && namespaces.has(node.expression.expression.text);
        }
        if (wanted.has(candidate)) {
          const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
          calls.push({
            file: relative(REPO_ROOT, source.fileName).split(sep).join('/'),
            line: pos.line + 1,
            importedName: candidate,
            argumentTexts: node.arguments.map((arg) => arg.getText(source)),
            resolved: resolvedCall,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export interface SnippetCall {
  importedName: string;
  localExpression: string;
  resolved: boolean;
  argumentTexts: string[];
}

/** In-memory adversarial audit: recognizes named aliases and namespace-property
 * calls and marks same-spelled unbound calls unresolved. */
export function auditSourceSnippet(sourceText: string, watchedName: string): SnippetCall[] {
  const source = ts.createSourceFile('snippet.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    const bindings = statement.importClause.namedBindings;
    if (ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) aliases.set(item.name.text, item.propertyName?.text ?? item.name.text);
    } else namespaces.add(bindings.name.text);
  }
  const found: SnippetCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let importedName = '';
      let resolved = false;
      if (ts.isIdentifier(node.expression)) {
        importedName = aliases.get(node.expression.text) ?? node.expression.text;
        resolved = aliases.has(node.expression.text);
      } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
        importedName = node.expression.name.text;
        resolved = namespaces.has(node.expression.expression.text);
      }
      if (importedName === watchedName) found.push({
        importedName,
        localExpression: node.expression.getText(source),
        resolved,
        argumentTexts: node.arguments.map((arg) => arg.getText(source)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function immutableSnapshot(tools: readonly RegisteredTool[]): readonly Readonly<RegisteredTool>[] {
  return Object.freeze(tools.map((tool) => Object.freeze({ ...tool, inputSchema: Object.freeze({ ...tool.inputSchema }) })));
}
