declare module 'turndown' {
  export default class TurndownService {
    constructor(options?: Record<string, unknown>);
    addRule(name: string, rule: {
      filter: string | string[] | ((node: HTMLElement) => boolean);
      replacement: (content: string, node: HTMLElement) => string;
    }): void;
    turndown(input: string): string;
  }
}
