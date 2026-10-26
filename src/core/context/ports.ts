import type { ContextPort } from '../ports.js';
import type { ContextCapability, ContextOptions } from './types.js';

/** A context policy manages request views; canonical messages remain owned by the session. */
export interface ContextPolicyPort extends ContextPort {
  readonly options: Readonly<Required<ContextOptions>>;
  setCapability(capability: ContextCapability): void;
  getCapability(): ContextCapability | undefined;
}
