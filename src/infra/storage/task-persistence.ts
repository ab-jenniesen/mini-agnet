import { rm } from 'node:fs/promises';
import type { Message } from '../../core/model/types.js';
import type { TaskResult } from '../../core/execution/result.js';
import type { TaskPersistencePort, ExecutionStorePort } from '../../core/execution/ports.js';
import type { ProjectState } from '../workspace/project-state.js';
import { ExecutionStore } from './execution-store.js';
import { TaskResultStore } from './task-results.js';
import { saveSession } from './session-store.js';

export class FileTaskPersistence implements TaskPersistencePort {
  constructor(private readonly project: ProjectState) {}

  open(sessionId: string): ExecutionStorePort {
    this.project.session(sessionId);
    return new ExecutionStore(this.project.path('executions', `${sessionId}.json`), sessionId);
  }

  async reset(sessionId: string): Promise<void> {
    this.project.session(sessionId);
    await rm(this.project.path('executions', `${sessionId}.json`), { force: true });
  }

  loadResult(sessionId: string): Promise<TaskResult | undefined> {
    this.project.session(sessionId);
    return new TaskResultStore(this.project.path('tasks', `${sessionId}.json`)).load();
  }

  saveResult(sessionId: string, result: TaskResult): Promise<void> {
    this.project.session(sessionId);
    return new TaskResultStore(this.project.path('tasks', `${sessionId}.json`)).save(result);
  }

  saveHistory(sessionId: string, messages: Message[]): Promise<void> {
    return saveSession(this.project.session(sessionId), messages);
  }
}
