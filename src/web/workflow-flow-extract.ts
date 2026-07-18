import ts from "typescript";
import type {
  Diagnostic,
  EntryInfo,
  ExprSummary,
  ImportInfo,
  InputFieldInfo,
  InputInfo,
  SourceLoc,
  WorkflowDocIR,
  WorkflowOperation,
} from "./workflow-flow-ir.ts";

const CTX_METHODS = new Set([
  "phase",
  "step",
  "agent",
  "agentSession",
  "sleep",
  "human",
  "signal",
  "checkpoint",
  "drainSignals",
  "spawn",
  "waitRun",
]);
const AGENT_SPEC_FIELDS = [
  "key",
  "prompt",
  "schema",
  "provider",
  "model",
  "profile",
  "toolPolicy",
  "reasoning",
  "target",
] as const;

type AgentSpecField = (typeof AGENT_SPEC_FIELDS)[number];

export function parseWorkflowSource(sourceFile: string, source: string): WorkflowDocIR {
  const sf = ts.createSourceFile(
    sourceFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const imports: ImportInfo[] = [];
  const diagnostics: Diagnostic[] = [];
  const operations: WorkflowOperation[] = [];
  const sessionVars = new Map<string, string>();
  // ctx.state(namespace) returns a pure handle; track the handle variable so its
  // `.set(...)` writes can be emitted as durable stateSet ops (mirrors sessionVars).
  const stateVars = new Map<string, ExprSummary>();
  const typeAliases = collectTypeAliases(sf);
  const entryNode = findEntryFunctionNode(sf);
  const { usages: inputUsages, defaults: inputDefaults } = collectInputMetadata(sf, entryNode);
  let opIndex = 0;

  const nextId = (kind: string): string => `${kind}_${++opIndex}`;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      imports.push(readImport(sf, node));
    }
    if (!entryNode || !isWithin(node, entryNode)) {
      ts.forEachChild(node, visit);
      return;
    }
    if (ts.isReturnStatement(node)) {
      // Workflows commonly wrap their body in a callback, e.g.
      // `return ctx.withWorkspace(async () => { ... })`. Treat such a return as
      // a transparent wrapper: descend into the callback so its operations are
      // captured, and do not emit a terminal return node for the wrapper.
      if (returnWrapsCallback(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      const id = nextId("return");
      operations.push({
        id,
        kind: "return",
        ...readReturnStatement(sf, node),
        ...operationContext(sf, node),
        location: loc(sf, node),
      });
      return;
    }

    const sessionDecl = readAgentSessionDeclaration(sf, node);
    if (sessionDecl) {
      const id = nextId("session");
      operations.push({
        id,
        kind: "agentSession",
        ...sessionDecl.spec,
        ...operationContext(sf, node),
        location: loc(sf, sessionDecl.call),
      });
      sessionVars.set(sessionDecl.name, id);
      return;
    }

    const stateDecl = readStateNamespaceDeclaration(sf, node);
    if (stateDecl) {
      stateVars.set(stateDecl.name, stateDecl.namespace);
      return;
    }
    if (ts.isCallExpression(node)) {
      const ctxCall = readCtxCall(sf, node);
      if (ctxCall) {
        const id = nextId(ctxCall.kind);
        operations.push({
          id,
          ...ctxCall,
          ...operationContext(sf, node),
          location: loc(sf, node),
        });
      } else {
        const turn = readAgentTurnCall(sf, node, sessionVars);
        if (turn) {
          const id = nextId("turn");
          operations.push({
            id,
            kind: "agentTurn",
            ...turn.spec,
            sessionRef: turn.sessionRef,
            ...operationContext(sf, node),
            location: loc(sf, node),
          });
        } else {
          const stateSet = readStateSetCall(sf, node, stateVars);
          if (stateSet) {
            const id = nextId("state");
            operations.push({
              id,
              kind: "stateSet",
              ...stateSet,
              ...operationContext(sf, node),
              location: loc(sf, node),
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  addDiagnostics(operations, diagnostics);
  const entry = findEntry(sf);
  return {
    format: "keel.workflow-doc-ir.v1",
    sourceFile,
    source,
    entry,
    input: findInputInfo(sf, entry, typeAliases, inputUsages, inputDefaults),
    imports,
    operations,
    diagnostics,
  };
}

function collectTypeAliases(sf: ts.SourceFile): Map<string, ts.TypeAliasDeclaration> {
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  for (const stmt of sf.statements) {
    if (ts.isTypeAliasDeclaration(stmt)) aliases.set(stmt.name.text, stmt);
  }
  return aliases;
}

function readImport(sf: ts.SourceFile, node: ts.ImportDeclaration): ImportInfo {
  const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
  const bindings: string[] = [];
  const clause = node.importClause;
  if (clause?.name) bindings.push(clause.name.text);
  const named = clause?.namedBindings;
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) bindings.push(element.name.text);
  } else if (named && ts.isNamespaceImport(named)) {
    bindings.push(`* as ${named.name.text}`);
  }
  return { specifier, bindings, location: loc(sf, node) };
}

function findEntry(sf: ts.SourceFile): EntryInfo {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
      return {
        name: stmt.name?.text ?? null,
        async: hasModifier(stmt, ts.SyntaxKind.AsyncKeyword),
        params: stmt.parameters.map((p) => p.name.getText(sf)),
        location: loc(sf, stmt),
      };
    }
    if (ts.isExportAssignment(stmt)) {
      const expr = unwrapParens(stmt.expression);
      if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
        return {
          name: ts.isFunctionExpression(expr) ? (expr.name?.text ?? null) : null,
          async: hasModifier(expr, ts.SyntaxKind.AsyncKeyword),
          params: expr.parameters.map((p) => p.name.getText(sf)),
          location: loc(sf, expr),
        };
      }
      return {
        name: expr.getText(sf),
        async: false,
        params: [],
        location: loc(sf, expr),
      };
    }
  }
  return { name: null, async: false, params: [], location: null };
}

function findEntryFunctionNode(
  sf: ts.SourceFile,
): ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | null {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
      return stmt;
    }
    if (ts.isExportAssignment(stmt)) {
      const expr = unwrapParens(stmt.expression);
      if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) return expr;
    }
  }
  return null;
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if (cur === ancestor) return true;
  }
  return false;
}

/** True when a return hands its body to a callback, e.g.
 *  `return ctx.withWorkspace(async () => { ... })`. The real operations live in
 *  the callback, so the traversal should descend rather than stop. */
function returnWrapsCallback(node: ts.ReturnStatement): boolean {
  if (!node.expression) return false;
  let expr: ts.Node = unwrapParens(node.expression);
  while (ts.isAwaitExpression(expr)) expr = unwrapParens(expr.expression);
  if (!ts.isCallExpression(expr)) return false;
  return expr.arguments.some((arg) => {
    const inner = unwrapParens(arg);
    return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
  });
}

function findInputInfo(
  sf: ts.SourceFile,
  entry: EntryInfo,
  typeAliases: Map<string, ts.TypeAliasDeclaration>,
  usages: Set<string>,
  defaults: Map<string, ExprSummary>,
): InputInfo | null {
  const inputParam = findInputParameter(sf);
  if (!inputParam) return null;
  const paramName = inputParam.name.getText(sf);
  const typeText = inputParam.type ? compact(inputParam.type.getText(sf)) : null;
  const fields = readInputFields(sf, inputParam.type, typeAliases);
  const byName = new Map(fields.map((field) => [field.name, field]));
  for (const [name, defaultValue] of defaults) {
    const field = byName.get(name);
    if (field) {
      field.default = defaultValue;
      field.used = true;
    } else {
      fields.push({
        name,
        type: "unknown",
        optional: true,
        default: defaultValue,
        used: true,
      });
    }
  }
  for (const name of usages) {
    const field = byName.get(name);
    if (field) field.used = true;
    else if (!defaults.has(name)) {
      fields.push({ name, type: "unknown", optional: true, used: true });
    }
  }
  fields.sort((a, b) => {
    const aLine = a.location?.line ?? Number.MAX_SAFE_INTEGER;
    const bLine = b.location?.line ?? Number.MAX_SAFE_INTEGER;
    return aLine - bLine || a.name.localeCompare(b.name);
  });
  return { paramName, type: typeText ?? entry.params[1] ?? null, fields };
}

function findInputParameter(sf: ts.SourceFile): ts.ParameterDeclaration | null {
  const params = findEntryParameters(sf);
  if (!params) return null;
  return params.find((param) => param.name.getText(sf) === "input") ?? params[1] ?? null;
}

function findEntryParameters(sf: ts.SourceFile): ts.NodeArray<ts.ParameterDeclaration> | null {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
      return stmt.parameters;
    }
    if (ts.isExportAssignment(stmt)) {
      const expr = unwrapParens(stmt.expression);
      if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) return expr.parameters;
    }
  }
  return null;
}

function readInputFields(
  sf: ts.SourceFile,
  typeNode: ts.TypeNode | undefined,
  typeAliases: Map<string, ts.TypeAliasDeclaration>,
): InputFieldInfo[] {
  const resolved = resolveInputType(typeNode, typeAliases);
  if (!resolved || !ts.isTypeLiteralNode(resolved)) return [];
  const fields: InputFieldInfo[] = [];
  for (const member of resolved.members) {
    if (!ts.isPropertySignature(member)) continue;
    const name = propertyNameText(member.name);
    if (!name) continue;
    fields.push({
      name,
      type: member.type ? compact(member.type.getText(sf)) : "unknown",
      optional: Boolean(member.questionToken),
      used: false,
      location: loc(sf, member),
    });
  }
  return fields;
}

function resolveInputType(
  typeNode: ts.TypeNode | undefined,
  typeAliases: Map<string, ts.TypeAliasDeclaration>,
): ts.TypeNode | undefined {
  if (!typeNode) return undefined;
  if (ts.isTypeLiteralNode(typeNode)) return typeNode;
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return typeAliases.get(typeNode.typeName.text)?.type;
  }
  return undefined;
}

function collectInputMetadata(
  sf: ts.SourceFile,
  entryNode: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | null,
): {
  usages: Set<string>;
  defaults: Map<string, ExprSummary>;
} {
  const usages = new Set<string>();
  const defaults = new Map<string, ExprSummary>();
  if (!entryNode) return { usages, defaults };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === "input") {
      usages.add(node.name.text);
    }
    if (ts.isElementAccessExpression(node) && node.expression.getText(sf) === "input") {
      const arg = node.argumentExpression;
      if (arg && ts.isStringLiteral(arg)) usages.add(arg.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const left = unwrapParens(node.left);
      const right = node.right;
      const name =
        ts.isPropertyAccessExpression(left) && left.expression.getText(sf) === "input"
          ? left.name.text
          : ts.isElementAccessExpression(left) &&
              left.expression.getText(sf) === "input" &&
              left.argumentExpression &&
              ts.isStringLiteral(left.argumentExpression)
            ? left.argumentExpression.text
            : null;
      if (name) defaults.set(name, summarizeExpr(sf, right));
    }
    ts.forEachChild(node, visit);
  };
  visit(entryNode);
  return { usages, defaults };
}

function readAgentSessionDeclaration(
  sf: ts.SourceFile,
  node: ts.Node,
): { name: string; call: ts.CallExpression; spec: Partial<WorkflowOperation> } | null {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer)
    return null;
  const call = unwrapParens(node.initializer);
  if (!ts.isCallExpression(call)) return null;
  const ctxCall = readCtxCall(sf, call);
  if (!ctxCall || ctxCall.kind !== "agentSession") return null;
  return { name: node.name.text, call, spec: ctxCall };
}

function readCtxCall(
  sf: ts.SourceFile,
  node: ts.CallExpression,
): Omit<WorkflowOperation, "id" | "location" | "containers" | "parallelLane"> | null {
  const access = propertyAccess(node.expression);
  if (!access || access.owner !== "ctx" || !CTX_METHODS.has(access.name)) return null;

  if (access.name === "phase") {
    return { kind: "phase", title: summarizeExpr(sf, node.arguments[0]) };
  }
  if (access.name === "step") {
    return {
      kind: "step",
      key: summarizeExpr(sf, node.arguments[0]),
      schema: summarizeExpr(sf, node.arguments[1]),
    };
  }
  if (access.name === "agent" || access.name === "agentSession") {
    return { kind: access.name, ...readSpecObject(sf, node.arguments[0]) };
  }
  if (access.name === "sleep") {
    return { kind: "sleep", key: summarizeExpr(sf, node.arguments[0]) };
  }
  if (access.name === "human") {
    return { kind: "human", ...readSpecObject(sf, node.arguments[0]) };
  }
  if (access.name === "signal") {
    return { kind: "signal", key: summarizeExpr(sf, node.arguments[0]) };
  }
  if (access.name === "checkpoint") {
    return { kind: "checkpoint", ...readCheckpointSpec(sf, node.arguments[0]) };
  }
  if (access.name === "drainSignals") {
    return {
      kind: "drainSignals",
      key: summarizeExpr(sf, node.arguments[0]),
      signalName: summarizeExpr(sf, node.arguments[1]),
    };
  }
  if (access.name === "spawn") {
    return {
      kind: "spawn",
      key: summarizeExpr(sf, node.arguments[0]),
      ...readSpawnSpec(sf, node.arguments[1]),
    };
  }
  if (access.name === "waitRun") {
    return { kind: "waitRun", key: summarizeExpr(sf, node.arguments[0]) };
  }
  return null;
}

function readAgentTurnCall(
  sf: ts.SourceFile,
  node: ts.CallExpression,
  sessionVars: Map<string, string>,
): { sessionRef: string; spec: Partial<WorkflowOperation> } | null {
  const access = propertyAccess(node.expression);
  if (!access || access.name !== "turn") return null;
  const sessionRef = sessionVars.get(access.owner);
  if (!sessionRef) return null;
  return { sessionRef, spec: readSpecObject(sf, node.arguments[0]) };
}

/** ctx.checkpoint({ key, message }) — pull the durable key and the human message. */
function readCheckpointSpec(
  sf: ts.SourceFile,
  node: ts.Node | undefined,
): Partial<WorkflowOperation> {
  const out: Partial<WorkflowOperation> = {};
  const object = node ? unwrapParens(node) : undefined;
  if (object && ts.isObjectLiteralExpression(object)) {
    const key = objectProperty(object, "key");
    const message = objectProperty(object, "message");
    if (key) out.key = summarizeExpr(sf, key);
    if (message) out.message = summarizeExpr(sf, message);
  }
  return out;
}

/** ctx.spawn(key, { workflow }) — capture the saved-workflow reference. */
function readSpawnSpec(sf: ts.SourceFile, node: ts.Node | undefined): Partial<WorkflowOperation> {
  const out: Partial<WorkflowOperation> = {};
  const object = node ? unwrapParens(node) : undefined;
  if (object && ts.isObjectLiteralExpression(object)) {
    const workflow = objectProperty(object, "workflow");
    if (workflow) out.workflowRef = summarizeExpr(sf, workflow);
  }
  return out;
}

/** `const ns = ctx.state("namespace")` declares a pure namespace handle; record
 *  the variable so later `ns.set(...)` writes resolve to their namespace. */
function readStateNamespaceDeclaration(
  sf: ts.SourceFile,
  node: ts.Node,
): { name: string; namespace: ExprSummary } | null {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
    return null;
  }
  const call = unwrapParens(node.initializer);
  if (!ts.isCallExpression(call)) return null;
  const access = propertyAccess(call.expression);
  if (!access || access.owner !== "ctx" || access.name !== "state") return null;
  return { name: node.name.text, namespace: summarizeExpr(sf, call.arguments[0]) };
}

/** `ns.set({ key, name, value })` on a tracked state handle is a durable write;
 *  `.get`/`.snapshot` are pure and intentionally produce no nodes. */
function readStateSetCall(
  sf: ts.SourceFile,
  node: ts.CallExpression,
  stateVars: Map<string, ExprSummary>,
): Partial<WorkflowOperation> | null {
  const access = propertyAccess(node.expression);
  if (!access || access.name !== "set") return null;
  const namespace = stateVars.get(access.owner);
  if (!namespace) return null;
  const out: Partial<WorkflowOperation> = { namespace };
  const object = node.arguments[0] ? unwrapParens(node.arguments[0]) : undefined;
  if (object && ts.isObjectLiteralExpression(object)) {
    const key = objectProperty(object, "key");
    const name = objectProperty(object, "name");
    if (key) out.key = summarizeExpr(sf, key);
    if (name) out.stateName = summarizeExpr(sf, name);
  }
  return out;
}

function readReturnStatement(
  sf: ts.SourceFile,
  node: ts.ReturnStatement,
): Partial<WorkflowOperation> {
  const expression = node.expression;
  const out: Partial<WorkflowOperation> = {
    result: summarizeExpr(sf, expression),
  };
  if (expression) {
    const status = readReturnedStatus(sf, expression);
    if (status) out.status = status;
  }
  const condition = nearestCondition(sf, node);
  if (condition) out.condition = condition;
  return out;
}

function readReturnedStatus(sf: ts.SourceFile, expression: ts.Expression): ExprSummary | null {
  const expr = unwrapParens(expression);
  if (!ts.isObjectLiteralExpression(expr)) return null;
  const status = objectProperty(expr, "status");
  return status ? summarizeExpr(sf, status) : null;
}

function nearestCondition(sf: ts.SourceFile, node: ts.Node): ExprSummary | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isIfStatement(cur)) return summarizeExpr(sf, cur.expression);
  }
  return null;
}

function readSpecObject(sf: ts.SourceFile, node: ts.Node | undefined): Partial<WorkflowOperation> {
  const out: Partial<WorkflowOperation> = {};
  if (!node || !ts.isObjectLiteralExpression(unwrapParens(node))) {
    out.key = summarizeExpr(sf, undefined);
    return out;
  }
  const object = unwrapParens(node) as ts.ObjectLiteralExpression;
  for (const field of AGENT_SPEC_FIELDS) {
    const value = objectProperty(object, field);
    if (value) out[field] = summarizeExpr(sf, value) as never;
  }
  return out;
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const prop of object.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const propName = propertyNameText(prop.name);
    if (propName === name) return prop.initializer;
  }
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
}

function summarizeExpr(sf: ts.SourceFile, node: ts.Node | undefined): ExprSummary {
  if (!node) return { kind: "missing", text: "", static: false };
  const expr = unwrapParens(node);
  const text = compact(expr.getText(sf));
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { kind: "literal", text, static: true, value: expr.text };
  }
  if (ts.isNumericLiteral(expr))
    return { kind: "literal", text, static: true, value: Number(expr.text) };
  if (expr.kind === ts.SyntaxKind.TrueKeyword)
    return { kind: "literal", text, static: true, value: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword)
    return { kind: "literal", text, static: true, value: false };
  if (ts.isTemplateExpression(expr)) return { kind: "template", text, static: false };
  if (ts.isIdentifier(expr)) return { kind: "identifier", text, static: false };
  if (ts.isObjectLiteralExpression(expr))
    return { kind: "object", text, static: isStaticObject(expr) };
  if (ts.isArrayLiteralExpression(expr))
    return { kind: "array", text, static: expr.elements.every(isStaticLiteral) };
  if (ts.isCallExpression(expr)) return { kind: "call", text, static: false };
  if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr))
    return { kind: "function", text, static: false };
  return { kind: "expression", text, static: false };
}

function isStaticObject(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.every(
    (prop) => ts.isPropertyAssignment(prop) && isStaticLiteral(prop.initializer),
  );
}

function isStaticLiteral(node: ts.Node): boolean {
  const expr = unwrapParens(node);
  return (
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    ts.isNumericLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword
  );
}

function propertyAccess(node: ts.Expression): { owner: string; name: string } | null {
  const expr = unwrapParens(node);
  if (!ts.isPropertyAccessExpression(expr)) return null;
  return { owner: expr.expression.getText(), name: expr.name.text };
}

function containersFor(node: ts.Node): string[] {
  const out: string[] = [];
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isIfStatement(cur) || ts.isConditionalExpression(cur)) pushUnique(out, "branch");
    if (ts.isForStatement(cur) || ts.isForOfStatement(cur) || ts.isWhileStatement(cur))
      pushUnique(out, "loop");
    if (ts.isCallExpression(cur)) {
      const access = propertyAccess(cur.expression);
      if (access?.name === "map" || access?.name === "forEach" || access?.name === "flatMap") {
        pushUnique(out, `${access.name} loop`);
      }
      if (access?.owner === "Promise" && access.name === "all") pushUnique(out, "parallel");
    }
  }
  return out.reverse();
}

function operationContext(
  sf: ts.SourceFile,
  node: ts.Node,
): Pick<WorkflowOperation, "containers"> &
  Pick<Partial<WorkflowOperation>, "parallelLane" | "condition"> {
  const containers = containersFor(node);
  const parallelLane = containers.includes("parallel") ? parallelLaneFor(node) : undefined;
  const condition = nearestCondition(sf, node);
  const base = parallelLane === undefined ? { containers } : { containers, parallelLane };
  return condition ? { ...base, condition } : base;
}

function parallelLaneFor(node: ts.Node): number | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!ts.isCallExpression(cur)) continue;
    const access = propertyAccess(cur.expression);
    if (access?.owner !== "Promise" || access.name !== "all") continue;
    const firstArg = cur.arguments[0];
    const array = firstArg ? unwrapParens(firstArg) : undefined;
    if (!array || !ts.isArrayLiteralExpression(array)) return undefined;
    const index = array.elements.findIndex((element) => isWithin(node, element));
    return index >= 0 ? index : undefined;
  }
  return undefined;
}

function addDiagnostics(operations: WorkflowOperation[], diagnostics: Diagnostic[]): void {
  for (const op of operations) {
    const key = op.key ?? op.title;
    if (key && !key.static) {
      diagnostics.push({
        severity: "info",
        message: `${op.kind} uses dynamic ${op.title ? "title" : "key"} expression: ${key.text}`,
        location: op.location,
      });
    }
    if (op.containers.length > 0) {
      diagnostics.push({
        severity: "info",
        message: `${op.kind} appears inside ${op.containers.join(" / ")}; static cardinality may be approximate`,
        location: op.location,
      });
    }
  }
}

function loc(sf: ts.SourceFile, node: ts.Node): SourceLoc {
  const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { file: sf.fileName, line: pos.line + 1, column: pos.character + 1 };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind));
}

function unwrapParens<T extends ts.Node>(node: T): ts.Node {
  let cur: ts.Node = node;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function pushUnique(items: string[], item: string): void {
  if (!items.includes(item)) items.push(item);
}
