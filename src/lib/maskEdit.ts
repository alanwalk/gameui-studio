export type PixelImage = { width: number; height: number; data: Uint8ClampedArray };
export type BrushPoint = { x: number; y: number };

/** Owns copies only: neither the source slice nor a previous undo state is mutated. */
export class MaskHistory {
  readonly original: PixelImage;
  current: Uint8ClampedArray;
  private past: Uint8ClampedArray[] = [];
  private future: Uint8ClampedArray[] = [];
  private strokeStart: Uint8ClampedArray | null = null;
  private changed = false;
  private readonly historyLimit: number;

  constructor(original: PixelImage, current = original.data) {
    if (original.width < 1 || original.height < 1 || original.data.length !== original.width * original.height * 4 || current.length !== original.data.length) {
      throw new Error('蒙版像素尺寸无效');
    }
    this.original = { width: original.width, height: original.height, data: original.data.slice() };
    this.current = current.slice();
    // Large slices keep fewer full-pixel snapshots to bound undo memory.
    this.historyLimit = Math.max(1, Math.min(20, Math.floor(32 * 1024 * 1024 / current.length)));
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  beginStroke() {
    if (this.strokeStart) return;
    this.strokeStart = this.current.slice();
    this.current = this.current.slice();
    this.changed = false;
  }

  paint(from: BrushPoint, to: BrushPoint, radius: number, mode: 'erase' | 'restore') {
    if (![from.x, from.y, to.x, to.y, radius].every(Number.isFinite) || radius <= 0) return;
    if (!this.strokeStart) this.beginStroke();
    const { width, height, data: original } = this.original;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    const left = Math.max(0, Math.floor(Math.min(from.x, to.x) - radius));
    const right = Math.min(width - 1, Math.ceil(Math.max(from.x, to.x) + radius));
    const top = Math.max(0, Math.floor(Math.min(from.y, to.y) - radius));
    const bottom = Math.min(height - 1, Math.ceil(Math.max(from.y, to.y) + radius));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        let progress = 0;
        if (lengthSquared > 0) progress = Math.max(0, Math.min(1, ((x + 0.5 - from.x) * dx + (y + 0.5 - from.y) * dy) / lengthSquared));
        const distanceX = x + 0.5 - from.x - progress * dx;
        const distanceY = y + 0.5 - from.y - progress * dy;
        if (distanceX * distanceX + distanceY * distanceY > radius * radius) continue;
        const offset = (y * width + x) * 4;
        if (mode === 'erase') {
          if (this.current[offset + 3] !== 0) this.changed = true;
          this.current[offset + 3] = 0;
        } else {
          for (let channel = 0; channel < 4; channel++) {
            if (this.current[offset + channel] !== original[offset + channel]) this.changed = true;
            this.current[offset + channel] = original[offset + channel];
          }
        }
      }
    }
  }

  endStroke() {
    if (!this.strokeStart) return;
    if (this.changed) {
      this.past.push(this.strokeStart);
      if (this.past.length > this.historyLimit) this.past.shift();
      this.future = [];
    }
    this.strokeStart = null;
    this.changed = false;
  }

  undo() {
    this.endStroke();
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.current);
    this.current = previous.slice();
  }

  redo() {
    this.endStroke();
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.current);
    this.current = next.slice();
  }
}
