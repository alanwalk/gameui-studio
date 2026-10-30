/** Restore enclosed transparent components only; border-connected background stays transparent. */
export function restoreEnclosedPixels(width: number, height: number, pixels: Uint8ClampedArray, original: Uint8ClampedArray) {
  const count = width * height;
  if (!Number.isSafeInteger(count) || width < 1 || height < 1 || pixels.length !== count * 4 || original.length !== pixels.length) throw Error('蒙版尺寸不符');
  const outside = new Uint8Array(count);
  const queue = new Uint32Array(count);
  let head = 0;
  let tail = 0;
  const visit = (index: number) => {
    if (!outside[index] && pixels[index * 4 + 3] === 0) {
      outside[index] = 1;
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    if (x > 0) visit(index - 1);
    if (x < width - 1) visit(index + 1);
    if (index >= width) visit(index - width);
    if (index + width < count) visit(index + width);
  }
  const result = pixels.slice();
  let restored = 0;
  for (let index = 0; index < count; index++) {
    if (pixels[index * 4 + 3] === 0 && !outside[index]) {
      result.set(original.subarray(index * 4, index * 4 + 4), index * 4);
      restored++;
    }
  }
  return { pixels: result, restored };
}
