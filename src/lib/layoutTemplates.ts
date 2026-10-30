import type { LayoutKind, LayoutNode } from '../types';

type TemplateNode = Omit<LayoutNode, 'id'>;
const block = (name: string, kind: LayoutKind, x: number, y: number, w: number, h: number): TemplateNode => ({
  name, kind, rect: { x, y, w, h },
});

export const LAYOUT_TEMPLATES: { id: string; name: string; nodes: TemplateNode[] }[] = [
  { id: 'home', name: '主界面', nodes: [
    block('背景', 'container', 0, 0, 1, 1),
    block('货币栏', 'panel', .05, .03, .9, .07),
    block('角色立绘', 'image', .2, .15, .6, .58),
    block('任务入口', 'button', .04, .25, .18, .09),
    block('活动入口', 'button', .78, .25, .18, .09),
    block('开始冒险', 'button', .3, .76, .4, .09),
    block('底部导航', 'panel', .04, .89, .92, .08),
  ] },
  { id: 'inventory', name: '背包', nodes: [
    block('背景', 'container', 0, 0, 1, 1),
    { ...block('标题', 'text', .1, .03, .65, .07), text: '背包' },
    block('关闭', 'button', .85, .03, .1, .06),
    block('分类栏', 'panel', .05, .13, .9, .07),
    block('物品网格', 'panel', .05, .24, .55, .6),
    block('物品详情', 'panel', .64, .24, .31, .5),
    block('使用物品', 'button', .64, .78, .31, .08),
    block('容量进度', 'progress', .05, .91, .55, .04),
  ] },
  { id: 'dialogue', name: '剧情对话', nodes: [
    block('背景', 'container', 0, 0, 1, 1),
    block('场景', 'image', 0, 0, 1, .72),
    block('角色', 'image', .14, .12, .58, .6),
    block('跳过', 'button', .8, .03, .15, .06),
    block('对话框', 'panel', .04, .7, .92, .27),
    { ...block('角色名', 'text', .08, .73, .4, .05), text: '角色名' },
    { ...block('对话内容', 'text', .08, .8, .84, .09), text: '在这里填写对话内容…' },
    block('继续', 'button', .78, .91, .14, .04),
  ] },
];

export function createTemplateLayout(templateId: string): LayoutNode[] {
  const template = LAYOUT_TEMPLATES.find((entry) => entry.id === templateId);
  if (!template) throw new Error('未知布局模板');
  return template.nodes.map((node) => ({ ...node, id: `layout-${crypto.randomUUID()}`, rect: { ...node.rect } }));
}
