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
  type: 'save' | 'replaceAsset';
  content?: string;
}
