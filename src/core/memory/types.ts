export type MemoryEntry = {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type MemoryScope = 'project' | 'global';
export type ScopedMemoryEntry = MemoryEntry & { scope: MemoryScope };
