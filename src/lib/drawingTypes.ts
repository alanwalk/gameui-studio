export const DRAWING_SIZES = {
  '1:1': '1024x1024',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
} as const;

export const DRAWING_RESOLUTIONS = ['512x512', '1024x1024', '1536x1536', '2048x2048', '1024x1536', '1536x1024', '1080x1920', '1920x1080', '1152x2048', '2048x1152', '1440x2560', '2560x1440'];
export type DrawingRatio = keyof typeof DRAWING_SIZES | 'custom';
export type DrawingImage = { id: string; name: string; mime: string; width?: number; height?: number; createdAt: number; sourceImages?: string[] };
export type DrawingInput = { prompt: string; references: string[]; ratio: DrawingRatio; size?: string };
export function drawingSize(input: Pick<DrawingInput, 'ratio' | 'size'>): string {
  if (input.ratio !== 'custom') {
    if (!Object.hasOwn(DRAWING_SIZES, input.ratio)) throw Error('画图比例无效');
    if (input.size !== undefined && input.size !== DRAWING_SIZES[input.ratio]) throw Error('分辨率与比例不匹配，请使用自定义分辨率');
    return DRAWING_SIZES[input.ratio];
  }
  if (typeof input.size !== 'string' || !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(input.size)) throw Error('请填写有效的整数分辨率');
  const [width, height] = input.size.split('x').map(Number);
  if (width > 8192 || height > 8192 || width * height > 40_000_000) throw Error('宽高不能超过8192，总像素不能超过4000万');
  return input.size;
}
export type DrawingTask = DrawingInput & {
  id: string;
  size: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
  result?: string;
  resultSize?: { width: number; height: number };
  error?: string;
  submitted?: boolean;
  pendingId?: string;
  watchPath?: string;
  retryOf?: string;
  createdAt: number;
  updatedAt: number;
};

export type DrawingState = { tasks: DrawingTask[]; images: DrawingImage[] };

export function drawingRatioWarning(task: DrawingTask): string | undefined {
  if (!task.result || !task.resultSize) return;
  const [ratioWidth, ratioHeight] = task.size.split('x').map(Number);
  const { width, height } = task.resultSize;
  if (width * ratioHeight === height * ratioWidth) return;
  const requested = task.ratio === 'custom' ? task.size : `${task.ratio}（${task.size}）`;
  return `比例与请求不符：实际 ${width}×${height}，请求 ${requested}。可下载原图。`;
}
