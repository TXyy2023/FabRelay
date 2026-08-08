export interface TuiCommandDefinition {
  name: `/${string}`;
  usage?: string;
  description: string;
}

export const TUI_COMMANDS: readonly TuiCommandDefinition[] = [
  { name: '/inspect', usage: '<gerber.zip>', description: '检查 Gerber ZIP 的安全性、层和板框' },
  { name: '/preview', usage: '<gerber.zip>', description: '生成 Gerber 正反面本地预览' },
  { name: '/requirements', usage: '<files...>', description: '解析并合并 PCB 要求文件' },
  { name: '/quote', usage: '<gerber.zip> <requirements...>', description: '通过测试站页面获取实时 PCB 报价' },
  { name: '/orders', description: '读取测试站的近期订单' },
  { name: '/track', usage: '<order-id>', description: '查看订单、生产进度和物流状态' },
  { name: '/audit', usage: '<order-id>', description: '查看 PCB 文件审核结果' },
  { name: '/pay', usage: '<order-id>', description: '生成余额付款快照（不扣款）' },
  { name: '/messages', description: '读取平台消息和站内消息' },
  { name: '/xiaozhi', usage: '<question>', description: '调用页面右下角嘉小智对话' },
  { name: '/browser', description: '检查 Chrome 与 Playwright 运行环境' },
  { name: '/auth', description: '登录测试站或检查当前会话' },
  { name: '/mode', usage: '[manual|auto]', description: '查看或切换 Agent 工艺选择模式' },
  { name: '/profile', description: '显示 jlc-cli 专用数据目录' },
  { name: '/help', description: '显示全部斜杠命令及用法' },
  { name: '/exit', description: '退出 jlc-cli' }
];

export function commandSuggestions(value: string): TuiCommandDefinition[] {
  const candidate = value.trimStart();
  if (!candidate.startsWith('/') || /\s/.test(candidate)) return [];
  const query = candidate.toLocaleLowerCase();
  return TUI_COMMANDS.filter((command) => command.name.toLocaleLowerCase().startsWith(query));
}

export function completeCommand(command: TuiCommandDefinition): string {
  return command.usage ? `${command.name} ` : command.name;
}

export function commandHelp(): string {
  return TUI_COMMANDS
    .map((command) => `${command.name}${command.usage ? ` ${command.usage}` : ''}  ${command.description}`)
    .join('\n');
}

export interface SuggestionWindow {
  items: TuiCommandDefinition[];
  start: number;
  above: number;
  below: number;
}

export function suggestionWindow(
  suggestions: TuiCommandDefinition[],
  selectedIndex: number,
  maximumVisible = 7
): SuggestionWindow {
  if (maximumVisible < 1) throw new Error('maximumVisible must be at least 1');
  const boundedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, suggestions.length - 1)));
  const start = Math.min(
    Math.max(0, boundedIndex - maximumVisible + 1),
    Math.max(0, suggestions.length - maximumVisible)
  );
  const items = suggestions.slice(start, start + maximumVisible);
  return {
    items,
    start,
    above: start,
    below: Math.max(0, suggestions.length - start - items.length)
  };
}
