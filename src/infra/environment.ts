import { platform, arch, release, homedir, tmpdir } from 'node:os';
import { sep, delimiter, resolve } from 'node:path';

/** Environment details are generated at runtime, never migrated from another machine. */
export function currentEnvironment(workspace: string): string {
  const os = platform();
  const family = os === 'win32' ? 'Windows' : os === 'linux' ? 'Linux' : os === 'darwin' ? 'macOS' : os;
  return [
    '## Current execution environment (runtime detected)',
    `Operating system: ${family} (${os}, ${release()})`,
    `Architecture: ${arch()}`,
    `Node.js: ${process.version}`,
    `Current workspace: ${resolve(workspace)}`,
    `User home directory: ${homedir()}`,
    `Temporary directory: ${tmpdir()}`,
    `Path separator: ${JSON.stringify(sep)}; PATH delimiter: ${JSON.stringify(delimiter)}`,
    'Use OS-appropriate path and shell conventions. Absolute paths saved in migrated history and settings may refer to an older machine.',
    'The current filesystem and runtime tools determine what exists. Verify paths instead of trusting old history.',
    'Do not assume platform-specific tools are installed. Inspect before use.',
  ].join('\n');
}
