import type { MarkdownSettings } from '../../settings/markdownSettings';

export type MarkdownViewMode = 'rich' | 'split' | 'raw';

export interface MarkdownWebviewState {
  settings: MarkdownSettings;
  initialContent: string;
}

export interface MarkdownToWebviewMessage {
  type: 'setContent';
  content: string;
}

export interface MarkdownToExtensionMessage {
  type: 'ready' | 'save';
  content?: string;
}

export interface VsCodeApi {
  postMessage: (message: Record<string, unknown>) => void;
}
