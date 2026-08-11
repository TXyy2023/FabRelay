import { describe, expect, it } from 'vitest';
import {
  TUI_COMMANDS,
  commandHelp,
  commandSuggestions,
  completeCommand,
  suggestionWindow
} from '../src/tui/commands.js';

describe('TUI slash command palette', () => {
  it('opens for slash input and filters by command prefix', () => {
    expect(commandSuggestions('/')).toHaveLength(TUI_COMMANDS.length);
    expect(commandSuggestions('/quo').map((command) => command.name)).toEqual(['/quote']);
    expect(commandSuggestions('plain text')).toEqual([]);
    expect(commandSuggestions('/quote board.zip')).toEqual([]);
  });

  it('completes commands that need arguments with a trailing space', () => {
    const quote = TUI_COMMANDS.find((command) => command.name === '/quote');
    const orders = TUI_COMMANDS.find((command) => command.name === '/orders');
    expect(quote && completeCommand(quote)).toBe('/quote ');
    expect(orders && completeCommand(orders)).toBe('/orders');
  });

  it('keeps the selected suggestion visible in a bounded window', () => {
    const first = suggestionWindow([...TUI_COMMANDS], 0, 4);
    expect(first.start).toBe(0);
    expect(first.above).toBe(0);
    expect(first.below).toBe(TUI_COMMANDS.length - 4);

    const last = suggestionWindow([...TUI_COMMANDS], TUI_COMMANDS.length - 1, 4);
    expect(last.items.at(-1)?.name).toBe('/exit');
    expect(last.above).toBe(TUI_COMMANDS.length - 4);
    expect(last.below).toBe(0);
  });

  it('uses the same command registry for help text', () => {
    const help = commandHelp();
    for (const command of TUI_COMMANDS) expect(help).toContain(command.name);
  });

  it('exposes audit, guarded payment, messages, and Xiaozhi in the TUI', () => {
    expect(TUI_COMMANDS.map((command) => command.name)).toEqual(expect.arrayContaining([
      '/audit', '/pay', '/messages', '/xiaozhi'
    ]));
  });

  it('exposes the order action listing and hard/simple mode in the TUI', () => {
    const names = TUI_COMMANDS.map((command) => command.name);
    expect(names).toContain('/actions');
    const mode = TUI_COMMANDS.find((command) => command.name === '/mode');
    expect(mode?.usage).toBe('[hard|simple]');
  });
});
