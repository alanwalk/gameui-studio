import type { ElementKind } from '../types';

/**
 * UI rule: "同概念只使用一个词根" — Background/Button/Icon must not be mixed with
 * Bg/Btn/Glyph. This table collapses the synonyms a vision model tends to produce.
 */
const CANONICAL_WORDS: Record<string, string> = {
  bg: 'Background',
  background: 'Background',
  backdrop: 'Background',
  wallpaper: 'Background',
  btn: 'Button',
  button: 'Button',
  butn: 'Button',
  icon: 'Icon',
  glyph: 'Icon',
  ico: 'Icon',
  symbol: 'Icon',
  panel: 'Panel',
  pane: 'Panel',
  board: 'Panel',
  frame: 'Frame',
  border: 'Frame',
  popup: 'Popup',
  dialog: 'Popup',
  modal: 'Popup',
  toast: 'Toast',
  tip: 'Tooltip',
  tooltip: 'Tooltip',
  bar: 'Bar',
  progress: 'Progress',
  progressbar: 'Progress',
  slider: 'Slider',
  toggle: 'Toggle',
  switch: 'Toggle',
  checkbox: 'Checkbox',
  tab: 'Tab',
  card: 'Card',
  item: 'Item',
  cell: 'Cell',
  slot: 'Slot',
  box: 'Box',
  badge: 'Badge',
  label: 'Label',
  title: 'Title',
  header: 'Header',
  footer: 'Footer',
  divider: 'Divider',
  separator: 'Divider',
  arrow: 'Arrow',
  close: 'Close',
  back: 'Back',
  home: 'Home',
  menu: 'Menu',
  setting: 'Settings',
  settings: 'Settings',
  avatar: 'Avatar',
  portrait: 'Avatar',
  head: 'Avatar',
  hp: 'Hp',
  health: 'Hp',
  mana: 'Mp',
  mp: 'Mp',
  energy: 'Energy',
  gold: 'Gold',
  coin: 'Coin',
  gem: 'Gem',
  diamond: 'Gem',
  currency: 'Currency',
  exp: 'Exp',
  level: 'Level',
  lv: 'Level',
  star: 'Star',
  rank: 'Rank',
  lock: 'Lock',
  locked: 'Lock',
  unlock: 'Unlock',
  add: 'Add',
  plus: 'Add',
  minus: 'Minus',
  remove: 'Remove',
  delete: 'Delete',
  edit: 'Edit',
  search: 'Search',
  filter: 'Filter',
  sort: 'Sort',
  refresh: 'Refresh',
  share: 'Share',
  gift: 'Gift',
  reward: 'Reward',
  chest: 'Chest',
  bag: 'Bag',
  inventory: 'Inventory',
  shop: 'Shop',
  store: 'Shop',
  cart: 'Cart',
  mail: 'Mail',
  message: 'Mail',
  notice: 'Notice',
  task: 'Task',
  quest: 'Quest',
  mission: 'Quest',
  daily: 'Daily',
  weekly: 'Weekly',
  normal: 'Normal',
  common: 'Common',
  main: 'Main',
  sub: 'Sub',
  big: 'Large',
  large: 'Large',
  small: 'Small',
  tiny: 'Small',
  mini: 'Small',
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom',
  center: 'Center',
  middle: 'Center',
  red: 'Red',
  blue: 'Blue',
  green: 'Green',
  yellow: 'Yellow',
  purple: 'Purple',
  gold2: 'Gold',
  gray: 'Gray',
  grey: 'Gray',
  black: 'Black',
  white: 'White',
  empty: 'Empty',
  full: 'Full',
  half: 'Half',
  shadow: 'Shadow',
  glow: 'Glow',
  highlight: 'Highlight',
  mask: 'Mask',
  circle: 'Circle',
  round: 'Round',
  square: 'Square',
  rect: 'Square',
  line: 'Line',
  dot: 'Dot',
  bgm: 'Bgm',
};

/** UI rule 5: these cannot express revision or acceptance state in a filename. */
const FORBIDDEN_REVISION_WORDS = new Set([
  'new',
  'old',
  'final',
  'approved',
  'refined',
  'backup',
  'copy',
  'temp',
  'tmp',
  'test',
  'debug',
  'unused',
  'latest',
  'recent',
]);

/** UI control-state suffixes, from the asset naming spec's state table. */
const STATE_WORDS: Record<string, string> = {
  normal: 'Normal',
  default: 'Normal',
  idle: 'Normal',
  pressed: 'Pressed',
  press: 'Pressed',
  down: 'Pressed',
  active: 'Pressed',
  disabled: 'Disabled',
  disable: 'Disabled',
  inactive: 'Disabled',
  gray: 'Disabled',
  grey: 'Disabled',
  selected: 'Selected',
  select: 'Selected',
  checked: 'Selected',
  on: 'On',
  off: 'Off',
  unavailable: 'Unavailable',
  locked: 'Unavailable',
  processing: 'Processing',
  loading: 'Processing',
  waiting: 'Processing',
};

const KIND_FALLBACK: Record<ElementKind, string> = {
  panel: 'Panel',
  button: 'Button',
  icon: 'Icon',
  text: 'Label',
  progress: 'Progress',
  frame: 'Frame',
  decor: 'Decor',
};

function splitWords(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function toPascal(words: string[]): string {
  return words
    .map((w) => {
      const canonical = CANONICAL_WORDS[w] ?? w;
      return canonical.charAt(0).toUpperCase() + canonical.slice(1);
    })
    .join('');
}

export type NameParts = {
  objectName: string;
  state: string;
};

/**
 * Turns a vision-model label into UI's `T_UI_<模块>_<对象>[_<状态>]`.
 * Trailing state words are split off so the object name stays stable across states.
 */
export function deriveName(label: string, kind: ElementKind): NameParts {
  const words = splitWords(label).filter((w) => !FORBIDDEN_REVISION_WORDS.has(w));

  let state = '';
  const objectWords: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const isStateWord = Object.prototype.hasOwnProperty.call(STATE_WORDS, word);
    // Only a TRAILING state word is a state; "SelectedTab" is an object, not a state.
    const isTrailing = i >= words.length - 2;
    if (isStateWord && isTrailing && objectWords.length > 0) {
      state = STATE_WORDS[word];
      continue;
    }
    objectWords.push(word);
  }

  const objectName = objectWords.length > 0 ? toPascal(objectWords) : KIND_FALLBACK[kind];
  return { objectName, state };
}

export function buildFileName(moduleName: string, objectName: string, state: string): string {
  const segments = [moduleName, objectName];
  if (state) segments.push(state);
  // UI rule: single underscore between fields, no consecutive underscores.
  const body = segments.filter(Boolean).join('_');
  return `T_UI_${body}.png`;
}

export function safeModuleName(raw: string): string {
  const words = splitWords(raw).filter((w) => !FORBIDDEN_REVISION_WORDS.has(w));
  if (words.length === 0) return 'Common';
  return toPascal(words);
}

/**
 * UI rule: "不同格式或不同目录中的同一主体应有明确来源或用途关系" — never silently
 * overwrite a look-alike asset, so collisions get a numeric disambiguator instead.
 */
export function dedupeName(fileName: string, taken: Set<string>): string {
  if (!taken.has(fileName)) return fileName;
  const base = fileName.replace(/\.png$/, '');
  let index = 2;
  while (taken.has(`${base}_${String(index).padStart(2, '0')}.png`)) {
    index++;
  }
  return `${base}_${String(index).padStart(2, '0')}.png`;
}
