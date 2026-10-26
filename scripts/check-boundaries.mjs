import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../src');
const layers = {
  core: new Set(['core']),
  app: new Set(['app', 'core', 'protocol']),
  protocol: new Set(['protocol', 'core']),
  ui: new Set(['ui', 'protocol']),
};
const failures = [];

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(file);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const local = relative(root, file).replaceAll('\\', '/');
    const layer = local.split('/')[0];
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function check(specifier) {
      if (!layers[layer]) return;
      if (specifier.startsWith('.')) {
        const target = relative(root, resolve(dirname(file), specifier)).replaceAll('\\', '/');
        if (!layers[layer].has(target.split('/')[0])) failures.push(`${local} -> ${specifier}`);
      } else if (['core', 'app', 'protocol'].includes(layer)) {
        // These layers have no filesystem, process, UI or concrete provider dependencies.
        if (!['zod', 'node:crypto'].includes(specifier)) failures.push(`${local} -> ${specifier}`);
      }
    }
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        check(node.moduleSpecifier.text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        check(node.argument.literal.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteral(node.arguments[0])
      )
        check(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

await inspect(root);
if (failures.length) {
  console.error(`Invalid layer dependencies:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Layer boundaries passed: core, application, protocol and UI.');
}
