import type { SegmentationDiagnostics } from './lib/segmentationTypes';

export type Rect = { x: number; y: number; w: number; h: number };
export type TextPolicy = 'remove' | 'preserve' | 'separate';

export type ElementKind =
  | 'panel'
  | 'button'
  | 'icon'
  | 'text'
  | 'progress'
  | 'frame'
  | 'decor';

/** What the vision model returns; rect is in ORIGINAL image pixels. */
export type DetectedElement = {
  label: string;
  kind: ElementKind;
  rect: Rect;
  /** Higher sits on top of lower. */
  layer: number;
  description: string;
  /** Present when kind is 'text': the readable string, which should become a TMP node. */
  text?: string;
  /** Dynamic labels are separated from artwork; decorative lettering can be preserved. */
  textPolicy?: TextPolicy;
};

export type BorderSide = 'top' | 'right' | 'bottom' | 'left';

export type BorderReport = {
  bgColor: [number, number, number];
  /** Per-side boundary strength: contrast between the band inside and outside the edge. */
  sideScore: Record<BorderSide, number>;
  /** Sides with NO real art boundary, i.e. the box edge floats on flat colour. */
  dirtySides: BorderSide[];
};

export type SliceResult = {
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
  border: BorderReport;
};

export type UiElement = {
  id: string;
  rect: Rect;
  kind: ElementKind;
  /** Raw label from the model, kept so the user can see what it thought. */
  label: string;
  /** English art description from the model; used as the repaint prompt. */
  description: string;
  /** Sanitized PascalCase object name used in the output filename. */
  objectName: string;
  state: string;
  text?: string;
  textPolicy?: TextPolicy;
  layer: number;
  occluded: boolean;
  needsAi: boolean;
  approved: boolean;
  extractionMethod?: 'color-key' | 'segmentation' | 'repaint' | 'manual' | 'ai-sheet';
  repainted?: boolean;
  processingStatus?: 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
  processingError?: string;
  maskImage?: string;
  /** Sheet coordinates must never be used to crop the original screenshot. */
  coordinateSpace?: 'source' | 'sheet';
  sourceSheetImage?: string;
  qualityWarnings?: string[];
  segmentationDiagnostics?: SegmentationDiagnostics;
  slice?: SliceResult;
};

export type Settings = {
  visionModel: string;
  imageModel: string;
  /** UI module segment: Common / Login / Inventory / Items / Mail. */
  module: string;
  tolerance: number;
  softness: number;
  hardEdge: boolean;
  fringeFix: boolean;
  includeTextAsImage: boolean;
};

/** A rectangle in wireframe units, i.e. fractions of the screen, so layout survives resize. */
export type NormRect = { x: number; y: number; w: number; h: number };

export type LayoutKind =
  | 'container'
  | 'panel'
  | 'button'
  | 'icon'
  | 'text'
  | 'image'
  | 'progress';

export type LayoutNode = {
  parentId?: string | null;
  preset?: string;
  iconLabel?: string;
  textPosition?: 'bottom' | 'above' | 'corner' | 'right';
  framed?: boolean;
  value?: number;
  textAlign?: 'left' | 'center' | 'right';
  description?: string;
  id: string;
  name: string;
  kind: LayoutKind;
  /** Normalized 0..1 against the screen, so 1080x1920 and 1920x1080 share one layout. */
  rect: NormRect;
  text?: string;
};

export type ScreenVersion = {
  id: string;
  parentVersionId?: string;
  operation?: 'generate' | 'import' | 'refine';
  name?: string;
  note?: string;
  styleSnapshot?: { id?: string; name?: string; prompt: string; image?: string };
  /** File name in the server image store; undefined while still generating. */
  image?: string;
  prompt: string;
  createdAt: number;
};

export type Screen = {
  assetSettings?: Pick<Settings, 'module' | 'includeTextAsImage'>;
  id: string;
  layoutReferenceImage?: string;
  name: string;
  /** What the screen is for; this is the seed of the generation prompt. */
  usage: string;
  layout: LayoutNode[];
  versions: ScreenVersion[];
  activeVersionId?: string;
};

export type Project = {
  id: string;
  name: string;
  stylePrompt: string;
  styleImage?: string;
  orientation: 'portrait' | 'landscape';
  size: { w: number; h: number };
  screens: Screen[];
  createdAt: number;
  updatedAt: number;
};

/** A reusable look shared by projects; it is intentionally not owned by a project. */
export type Style = {
  id: string;
  name: string;
  prompt: string;
  image?: string;
  /** Stored image file names shared across projects. */
  referenceImages?: string[];
  createdAt: number;
  updatedAt: number;
};

/** Only file references cross the persistence boundary. */
export type SliceTaskSource =
  | { kind: 'project'; projectId: string; screenId: string; versionId: string; sourceImage: string }
  | { kind: 'standalone'; sourceImage: string };

export type StoredSliceElement = Omit<UiElement, 'slice'> & {
  slice?: Omit<SliceResult, 'canvas'> & { image: string };
};
export type SliceTask = {
  schemaVersion: 1;
  id: string;
  name: string;
  source: SliceTaskSource;
  width: number;
  height: number;
  elements: StoredSliceElement[];
  status: 'idle' | 'running' | 'done' | 'interrupted';
  createdAt: number;
  updatedAt: number;
};
