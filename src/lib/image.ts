export type LoadedImage = {
  image: HTMLImageElement;
  data: ImageData;
  width: number;
  height: number;
  dataUrl: string;
};

export async function loadImageFile(file: File): Promise<LoadedImage> {
  const dataUrl = await readAsDataUrl(file);
  const image = await loadImageElement(dataUrl);
  const data = toImageData(image);
  return {
    image,
    data,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dataUrl,
  };
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = src;
  });
}

export function toImageData(image: HTMLImageElement): ImageData {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}
