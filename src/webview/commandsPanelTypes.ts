import type { ProjectCommand } from '../commands/commandScanner';

export interface CommandsPanelStateMessage {
  type: 'state';
  commands: ProjectCommand[];
}

export type CommandsPanelInboundMessage = CommandsPanelStateMessage;

export type CommandsPanelOutboundMessage =
  | { type: 'ready' | 'refresh' | 'openPanel' }
  | { type: 'run'; command: ProjectCommand };
