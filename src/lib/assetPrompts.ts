import type { DetectedElement, TextPolicy } from '../types';

export type SheetOptions = {
  textPolicy: TextPolicy;
  keepCharacters: boolean;
};

export function buildAiSlicePrompt(options: SheetOptions, additionalInstructions: string): string {
  const textInstruction = options.textPolicy === 'preserve'
    ? '保留素材本身已有的文字与数字，不添加新的标签。'
    : '删除已有的动态数值、等级、按钮文案和图标下方标签，修复文字及其描边、投影下面的完整底材；不要把文字位置抠成透明洞。';
  const characterInstruction = options.keepCharacters
    ? '角色、宠物与独立插画也属于可复用素材，完整保留耳朵、尾巴、武器和装饰。'
    : '不输出角色立绘或角色插画。';
  return [
    '把参考界面整理为可直接复用的游戏 UI 组件表。',
    '分别输出空白底板、图标、按钮、进度槽与进度填充；不要把底板和覆盖它的图标、数值合成一张素材。',
    textInstruction,
    '保留加号、问号、货币符号等具有图标含义的图形；移除通知红点和相邻控件残片。',
    characterInstruction,
    '补全被覆盖的轮廓和底材，保持原始比例、配色、材质、四角、描边及画风，不新增装饰。',
    '组件之间留出充足透明间距，包括所有轮廓、装饰和阴影；避免一个组件的外接矩形覆盖另一个组件。',
    '输出真实 RGBA 透明背景，不绘制棋盘格；实心素材内部保持不透明，只有真实半透明材质和抗锯齿边缘使用半透明。',
    '去掉整屏场景、宿主应用界面和鼠标；不要添加文字标签、网格线、额外光晕或漂浮碎屑。',
    additionalInstructions.trim() ? `补充要求：${additionalInstructions.trim()}` : '',
  ].filter(Boolean).join('\n');
}

export function buildAssetRepairPrompt(element: DetectedElement, textPolicy: TextPolicy): string {
  const textInstruction = textPolicy === 'preserve'
    ? 'Preserve existing lettering that belongs to this asset. Do not add any new text.'
    : 'Remove the existing text, numbers and labels, including their outlines and shadows. Restore the continuous blank material underneath; do not punch transparent holes where the text was. Preserve meaningful pictograms such as plus signs and question marks.';
  return [
    `Repair ONLY this game UI asset: ${element.label}.`,
    `Asset description: ${element.description || 'game UI element'}.`,
    'The first reference is the target asset. An optional second reference provides nearby context only; never copy neighboring objects into the output.',
    `Keep the target aspect ratio ${element.rect.w}:${element.rect.h}. Preserve its silhouette, corners, palette, material and line weight.`,
    'Complete occluded or truncated parts of this target without redesigning already visible details.',
    textInstruction,
    'Remove unrelated fragments and notification dots. Keep the complete target centered with a small transparent margin.',
    'Use real transparent RGBA. Solid surfaces must remain opaque; keep natural edge antialiasing and intentional translucent effects. No checkerboard, extra glow or floating debris.',
  ].join(' ');
}
