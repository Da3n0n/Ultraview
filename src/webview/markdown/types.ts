import type { MarkdownSettings } from '../../settings/markdownSettings';

export type MarkdownViewMode = 'rich' | 'split' | 'raw';

export interface MarkdownWebviewState {
  settings: MarkdownSettings;
  initialContent: string;
  viewMode?: MarkdownViewMode;
}

export type MarkdownToWebviewMessage = {
  type: 'setContent';
  content: string;
} | {
  type: 'setViewMode';
  viewMode: MarkdownViewMode;
};

export interface MarkdownToExtensionMessage {
  type: 'ready' | 'save' | 'setViewMode';
  content?: string;
  viewMode?: MarkdownViewMode;
}

export interface VsCodeApi {
  postMessage: (message: Record<string, unknown>) => void;
}
