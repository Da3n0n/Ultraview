export type SvgViewMode = 'text' | 'split' | 'preview';

export interface SvgWebviewState {
  defaultView: SvgViewMode;
  initialContent: string;
}

export interface SvgToWebviewMessage {
  type: 'setContent';
  content: string;
}

export interface SvgToExtensionMessage {
  type: 'ready' | 'save' | 'replaceAsset';
  content?: string;
}
