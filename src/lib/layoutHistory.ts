import type { LayoutNode } from '../types';

type Entry = { steps: LayoutNode[][]; index: number };
const copy = (nodes: LayoutNode[]) => structuredClone(nodes);

/** Histories belong to a project/screen pair; snapshots never share mutable rects. */
export class LayoutHistory {
  private entries = new Map<string, Entry>();

  record(key: string, before: LayoutNode[], after: LayoutNode[]) {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const entry = this.entries.get(key) ?? { steps: [copy(before)], index: 0 };
    entry.steps = entry.steps.slice(0, entry.index + 1);
    entry.steps.push(copy(after));
    entry.index += 1;
    this.entries.set(key, entry);
  }

  undo(key: string) {
    const entry = this.entries.get(key);
    if (!entry || entry.index === 0) return null;
    entry.index -= 1;
    return copy(entry.steps[entry.index]);
  }

  redo(key: string) {
    const entry = this.entries.get(key);
    if (!entry || entry.index === entry.steps.length - 1) return null;
    entry.index += 1;
    return copy(entry.steps[entry.index]);
  }

  state(key: string) {
    const entry = this.entries.get(key);
    return { canUndo: !!entry && entry.index > 0, canRedo: !!entry && entry.index < entry.steps.length - 1 };
  }
}
