import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PermissionAuditPort, PermissionAuditRecord } from '../../core/permissions/ports.js';

export class FilePermissionAudit implements PermissionAuditPort {
  constructor(private file: string) {}

  setFile(file: string): void {
    this.file = file;
  }

  async write(record: PermissionAuditRecord): Promise<void> {
    const file = this.file;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  }
}
