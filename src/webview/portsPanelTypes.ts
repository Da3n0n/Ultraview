import type { PortProcess } from '../ports/portManager';

export interface PortsPanelStateMessage {
  type: 'state';
  ports: PortProcess[];
  devOnly: boolean;
}

export type PortsPanelInboundMessage = PortsPanelStateMessage;

export type PortsPanelOutboundMessage =
  | { type: 'ready' | 'refresh' | 'openPanel'; devOnly?: boolean }
  | { type: 'kill'; pid: number }
  | { type: 'killAll'; ports: number[] };
