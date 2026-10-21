#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { exportBundle, importBundle, inspectBundle } from '../lib/portable.mjs';
import readline from 'node:readline/promises';
const args = process.argv.slice(2);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
  if (['export', 'import', 'inspect'].includes(args[0])) {
    const command = args[0];
    const file = args.slice(1).find((a) => !a.startsWith('--'));
    if (command === 'export') {
      const outIndex = args.indexOf('--out');
      const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
      console.log(
        JSON.stringify(
          await exportBundle({
            out,
            includeGlobal: args.includes('--global'),
            allowSensitive: args.includes('--allow-sensitive'),
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (!file) throw Error(`Usage: mini-agent ${command} <bundle.magent>`);
    if (command === 'inspect') {
      const m = await inspectBundle(file);
      console.log(
        JSON.stringify(
          {
            source: m.source,
            createdAt: m.createdAt,
            files: m.files.map((x) => ({ path: x.path, bytes: x.bytes })),
          },
          null,
          2,
        ),
      );
      return;
    }
    const includeGlobal = args.includes('--global');
    const preview = await importBundle({ file, includeGlobal });
    console.log(JSON.stringify(preview, null, 2));
    if (!args.includes('--yes')) {
      if (!process.stdin.isTTY) {
        console.log('Preview only. Pass --yes to apply.');
        return;
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Apply the CREATE entries above? (type IMPORT) ');
      rl.close();
      if (answer !== 'IMPORT') {
        console.log('Cancelled');
        return;
      }
    }
    console.log(JSON.stringify(await importBundle({ file, includeGlobal, apply: true }), null, 2));
    return;
  }
  const entry = resolve(project, 'node_modules/tsx/dist/cli.mjs');
  const app = resolve(project, args.includes('--classic') ? 'src/cli.ts' : 'src/tui.ts');
  const argv = args.filter((v) => v !== '--classic');
  const child = spawn(process.execPath, [entry, app, ...argv], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  child.on('error', (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
main().catch((e) => {
  console.error(`mini-agent: ${e.message}`);
  process.exitCode = 1;
});
