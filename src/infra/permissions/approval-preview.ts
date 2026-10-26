import { readFile } from 'node:fs/promises';
import type { ApprovalRequest } from '../../core/permissions/manager.js';
import type { Workspace } from '../workspace/files.js';
import { diffPreview } from '../workspace/diff.js';

/** Build an approval preview independent of any UI framework. */
export async function approvalPreview(
  request: ApprovalRequest,
  workspace: Workspace,
): Promise<string> {
  if (request.name !== 'write_file') return JSON.stringify(request.args, null, 2);
  const path = String(request.args.path),
    proposed = String(request.args.content);
  const target = await workspace.safePath(path);
  let before = '';
  try {
    before = await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return `文件：${path}\n${diffPreview(before, proposed, 100000)}`;
}
