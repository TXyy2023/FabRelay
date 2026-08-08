import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { browserDoctor } from '../browser/doctor.js';
import { runManualChromeLogin } from '../browser/manual-login.js';
import { withBrowserSession } from '../browser/session.js';
import { appPaths } from '../config/paths.js';
import { inspectGerberZip } from '../gerber/inspect.js';
import { LoginPage, type AuthenticatedUserSummary } from '../pages/login-page.js';
import {
  cycleAgentMode,
  modeLabel,
  parseAgentMode,
  readModeConfiguration,
  setAgentMode
} from '../mode/index.js';
import type { AgentMode } from '../domain/types.js';
import { JlcError } from '../domain/errors.js';
import {
  DISCLAIMER_NOTICE,
  acceptDisclaimer,
  disclaimerStatus
} from '../disclaimer/index.js';
import { resolveRequirements } from '../requirements/resolve.js';
import { auditOrder, listOrders, showOrder } from '../workflows/orders.js';
import { createQuote } from '../workflows/quote.js';
import { listPlatformMessages } from '../workflows/messages.js';
import { preparePayment } from '../workflows/payment.js';
import { askXiaoZhi } from '../workflows/xiaozhi.js';
import type { XiaoZhiAnswer } from '../domain/types.js';
import {
  commandHelp,
  commandSuggestions,
  completeCommand,
  suggestionWindow,
  type TuiCommandDefinition
} from './commands.js';

const logo = String.raw`     ██╗ ██╗      ██████╗
     ██║ ██║     ██╔════╝
     ██║ ██║     ██║
██   ██║ ██║     ██║
╚█████╔╝ ███████╗ ╚██████╗
 ╚════╝  ╚══════╝  ╚═════╝`;

function App(): React.JSX.Element {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyDraft, setHistoryDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [browserState, setBrowserState] = useState('检查中');
  const [authState, setAuthState] = useState('检查中');
  const [user, setUser] = useState<AuthenticatedUserSummary>();
  const [agentMode, setCurrentAgentMode] = useState<AgentMode>('manual');
  const [message, setMessage] = useState('输入 /help 查看命令');
  const [recentOrders, setRecentOrders] = useState<string[]>([]);
  const [notifications, setNotifications] = useState<TuiNotification[]>([]);
  const [xiaozhiTurns, setXiaozhiTurns] = useState<XiaoZhiAnswer[]>([]);

  useEffect(() => {
    void readModeConfiguration().then((configuration) => setCurrentAgentMode(configuration.mode));
    void (async () => {
      try {
        await browserDoctor();
        setBrowserState('Chrome/Chromium 可用');
        const status = await withBrowserSession({}, async (session) => await new LoginPage(session.page).status());
        setAuthState(status.authenticated ? '已登录测试站' : '未登录');
        setUser(status.authenticated ? status.user : undefined);
      } catch {
        setBrowserState('Chrome/Chromium 不可用');
        setAuthState('未知');
        setUser(undefined);
      }
    })();
  }, []);

  const suggestions = useMemo(
    () => paletteDismissed ? [] : commandSuggestions(input),
    [input, paletteDismissed]
  );
  const paletteOpen = suggestions.length > 0;
  const selectedCommand = suggestions[Math.min(selectedSuggestion, suggestions.length - 1)];

  useEffect(() => {
    setSelectedSuggestion(0);
  }, [input]);

  const chooseSuggestion = useCallback((command: TuiCommandDefinition) => {
    setInput(completeCommand(command));
    setPaletteDismissed(true);
    setHistoryIndex(-1);
  }, []);

  useInput((_character, key) => {
    if (busy) return;
    if (key.tab && key.shift) {
      void cycleAgentMode().then((configuration) => {
        setCurrentAgentMode(configuration.mode);
        setMessage(`已切换为 ${modeLabel(configuration.mode)} (${configuration.mode})`);
      }).catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (paletteOpen) {
      if (key.downArrow) {
        setSelectedSuggestion((current) => (current + 1) % suggestions.length);
      } else if (key.upArrow) {
        setSelectedSuggestion((current) => (current - 1 + suggestions.length) % suggestions.length);
      } else if (key.tab && selectedCommand) {
        chooseSuggestion(selectedCommand);
      } else if (key.escape) {
        setPaletteDismissed(true);
      }
      return;
    }

    if (key.upArrow && history.length > 0) {
      const nextIndex = Math.min(historyIndex + 1, history.length - 1);
      if (historyIndex === -1) setHistoryDraft(input);
      setHistoryIndex(nextIndex);
      setInput(history[history.length - 1 - nextIndex] ?? input);
      setPaletteDismissed(true);
    } else if (key.downArrow && historyIndex >= 0) {
      const nextIndex = historyIndex - 1;
      setHistoryIndex(nextIndex);
      setInput(nextIndex < 0 ? historyDraft : (history[history.length - 1 - nextIndex] ?? historyDraft));
      setPaletteDismissed(true);
    } else if (key.escape && input.length > 0) {
      setInput('');
      setHistoryIndex(-1);
      setPaletteDismissed(false);
    }
  }, { isActive: !busy });

  const updateInput = useCallback((value: string) => {
    setInput(value);
    setPaletteDismissed(false);
    setHistoryIndex(-1);
  }, []);

  const run = useCallback(async (value: string) => {
    const submitted = value.trim();
    if (!submitted) return;
    const parts = submitted.split(/\s+/).filter(Boolean);
    const command = parts.shift();
    setInput('');
    setPaletteDismissed(false);
    setHistoryIndex(-1);
    setHistory((current) => current.at(-1) === submitted ? current : [...current.slice(-49), submitted]);
    setBusy(true);
    setMessage(`正在执行 ${command ?? submitted}…`);
    try {
      if (command === '/exit') return exit();
      if (command === '/help') return setMessage(commandHelp());
      if (command === '/browser') return setMessage(JSON.stringify(await browserDoctor(), null, 2));
      if (command === '/auth') {
        let status = await withBrowserSession({}, async (session) => await new LoginPage(session.page).status());
        if (!status.authenticated) {
          setMessage('已打开专用 Chrome；登录并完成滑块后，请在该窗口按 ⌘Q 完全退出');
          await runManualChromeLogin();
          status = await withBrowserSession({ browser: 'chrome' }, async (session) => await new LoginPage(session.page).status());
        }
        setAuthState(status.authenticated ? '已登录测试站' : '未登录');
        setUser(status.authenticated ? status.user : undefined);
        return setMessage(JSON.stringify(status, null, 2));
      }
      if (command === '/mode') {
        const selected = parts[0];
        const configuration = selected
          ? await setAgentMode(parseAgentMode(selected))
          : await readModeConfiguration();
        setCurrentAgentMode(configuration.mode);
        return setMessage(`${modeLabel(configuration.mode)} (${configuration.mode})\nShift+Tab 可循环切换`);
      }
      if (command === '/profile') return setMessage(`配置: ${appPaths.configDir}\n数据: ${appPaths.dataDir}\n浏览器: ${appPaths.browserProfile}`);
      if (command === '/inspect' || command === '/preview') {
        if (!parts[0]) throw new Error('需要 Gerber ZIP 路径');
        return setMessage(JSON.stringify(await inspectGerberZip(parts[0], { render: command === '/preview' }), null, 2));
      }
      if (command === '/requirements') return setMessage(JSON.stringify(await resolveRequirements(parts), null, 2));
      if (command === '/quote') {
        const gerber = parts.shift();
        if (!gerber || parts.length === 0) throw new Error('用法: /quote <gerber.zip> <requirements...>');
        return setMessage(JSON.stringify(await createQuote(gerber, { requirementFiles: parts, headed: true }), null, 2));
      }
      if (command === '/orders') {
        const orders = await listOrders({ limit: 5, headed: true });
        setRecentOrders(orders.map((order) => `${order.id}  ${order.rawStatus}`));
        return setMessage(`读取到 ${orders.length} 条近期订单`);
      }
      if (command === '/track') {
        if (!parts[0]) throw new Error('需要订单 ID');
        return setMessage(JSON.stringify(await showOrder(parts[0], { headed: true }), null, 2));
      }
      if (command === '/audit') {
        if (!parts[0]) throw new Error('需要订单 ID');
        return setMessage(JSON.stringify(await auditOrder(parts[0], { headed: true }), null, 2));
      }
      if (command === '/pay') {
        if (!parts[0]) throw new Error('需要订单 ID');
        const snapshot = await preparePayment(parts[0], { headed: true });
        return setMessage(`已生成付款快照 ${snapshot.id}\n金额 CNY ${snapshot.amount.toFixed(2)}\n本动作未扣款；请通过 payment approval 单独审批。`);
      }
      if (command === '/messages') {
        const rows = await listPlatformMessages({ limit: 10 });
        setNotifications(rows.map((row) => ({
          id: row.id,
          title: `${row.category === 'platform' ? '平台' : '站内'} · ${row.title}`,
          detail: row.publishedAt,
          level: row.unread ? 'warning' : 'info'
        })));
        return setMessage(`读取到 ${rows.length} 条消息`);
      }
      if (command === '/xiaozhi') {
        const question = parts.join(' ').trim();
        if (!question) throw new Error('用法: /xiaozhi <question>');
        const answer = await askXiaoZhi(question);
        setXiaozhiTurns((current) => [...current.slice(-2), answer]);
        return setMessage('嘉小智已回复');
      }
      setMessage('未知命令；输入 /help');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [exit]);

  const submitInput = useCallback((value: string) => {
    if (busy) return;
    if (paletteOpen && selectedCommand) {
      const submittedCommand = value.trim();
      if (submittedCommand !== selectedCommand.name || selectedCommand.usage) {
        chooseSuggestion(selectedCommand);
        return;
      }
    }
    void run(value);
  }, [busy, chooseSuggestion, paletteOpen, run, selectedCommand]);

  const visibleSuggestions = suggestionWindow(suggestions, selectedSuggestion);
  const terminalHeight = Math.max(22, process.stdout.rows ?? 24);
  const terminalWidth = Math.max(80, process.stdout.columns ?? 100);
  const logoWidth = Math.min(42, Math.max(34, Math.floor(terminalWidth * 0.34)));

  return <Box flexDirection="column" paddingX={2} height={terminalHeight}>
    <Box flexDirection="row" marginTop={1}>
      <Box width={logoWidth}>
        <Text bold color="magenta">{logo}</Text>
      </Box>
      <Box flexDirection="column" marginLeft={2} flexGrow={1}>
        <Text bold color="cyan">用户信息</Text>
        {authState !== '已登录测试站'
          ? <Text color="gray">{authState === '检查中' ? '正在读取登录用户…' : '登录后显示用户资料'}</Text>
          : <>
            <Text>用户：{user?.displayName ?? '已登录账号'}</Text>
            <Text>客编：{user?.customerCode ?? '未识别'}</Text>
            <Text>归属公司：{user?.companyName ?? '未识别'}</Text>
          </>}
        <Box marginTop={1} flexDirection="column">
          <Text bold color={browserState.includes('可用') ? 'green' : browserState === '检查中' ? 'yellow' : 'red'}>
            浏览器：{browserState}
          </Text>
          <Text bold color={authState === '已登录测试站' ? 'green' : authState === '检查中' ? 'yellow' : 'red'}>
            登录：{authState}
          </Text>
          <Text bold color={agentMode === 'manual' ? 'yellow' : 'magenta'}>
            模式：{modeLabel(agentMode)} ({agentMode})
          </Text>
        </Box>
      </Box>
    </Box>

    <Box marginTop={1}>
      <Text bold color="yellow">TEST ENVIRONMENT · Playwright-first · 余额付款需单笔审批</Text>
    </Box>

    <Box flexGrow={1} flexDirection="column" justifyContent="flex-end">
      {notifications.length > 0 && <NotificationPanel notifications={notifications} />}
      {xiaozhiTurns.length > 0 && <XiaoZhiPanel turns={xiaozhiTurns} />}
      {message !== '输入 /help 查看命令' && <Box marginBottom={1}>
        <Text color="gray">{message}</Text>
      </Box>}
      {recentOrders.map((order) => <Text key={order}>{order}</Text>)}
      {paletteOpen && <CommandPalette
        suggestions={visibleSuggestions}
        selectedIndex={selectedSuggestion}
      />}
      <Box borderStyle="round" borderColor={paletteOpen ? 'cyan' : 'gray'} paddingX={1} marginTop={1}>
        <Text bold color={busy ? 'gray' : 'cyan'}>{busy ? '…' : '›'} </Text>
        <TextInput
          value={input}
          placeholder="输入 / 查看命令"
          focus={!busy}
          onChange={updateInput}
          onSubmit={submitInput}
        />
      </Box>
      <Box>
        <Text bold color={agentMode === 'manual' ? 'yellow' : 'magenta'}>▶▶ {agentMode}</Text>
        <Text color="gray"> · Shift+Tab 切换模式 · 输入 / 查看命令 · ↑/↓ 历史 · Ctrl+C 退出</Text>
      </Box>
    </Box>
  </Box>;
}

interface UserInfoPanelProps {
  authState: string;
  user?: AuthenticatedUserSummary;
}

export function UserInfoPanel({ authState, user }: UserInfoPanelProps): React.JSX.Element {
  return <Box borderStyle="round" flexDirection="column" paddingX={1} flexGrow={2} flexBasis={0}>
    <Text bold color="cyan">用户信息</Text>
    {authState !== '已登录测试站'
      ? <Text color="gray">{authState === '检查中' ? '正在读取登录用户…' : '登录后显示用户资料'}</Text>
      : <>
        <Text>用户：{user?.displayName ?? '未识别'}　客编：{user?.customerCode ?? '未识别'}</Text>
        <Text>客编归属公司：{user?.companyName ?? '未识别'}</Text>
      </>}
  </Box>;
}

export interface TuiNotification {
  id: string;
  title: string;
  detail?: string;
  level: 'info' | 'warning' | 'error';
}

interface NotificationPanelProps {
  notifications: readonly TuiNotification[];
}

export function NotificationPanel({ notifications }: NotificationPanelProps): React.JSX.Element {
  return <Box borderStyle="round" flexDirection="column" paddingX={1} flexGrow={1} flexBasis={0}>
    <Text bold color="yellow">通知</Text>
    {notifications.length === 0
      ? <Text color="gray">暂无通知 · 消息入口已预留</Text>
      : notifications.slice(0, 3).map((notification) => <Text
        key={notification.id}
        color={notification.level === 'error' ? 'red' : notification.level === 'warning' ? 'yellow' : undefined}
      >• {notification.title}{notification.detail ? `：${notification.detail}` : ''}</Text>)}
  </Box>;
}

export function XiaoZhiPanel({ turns }: { turns: readonly XiaoZhiAnswer[] }): React.JSX.Element {
  return <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1}>
    <Text bold color="magenta">嘉小智</Text>
    {turns.slice(-2).map((turn) => <Box key={turn.askedAt} flexDirection="column">
      <Text color="cyan">你：{turn.question}</Text>
      <Text>嘉小智：{tuiExcerpt(turn.answer)}</Text>
    </Box>)}
  </Box>;
}

function tuiExcerpt(value: string, maximum = 600): string {
  const compact = value.split(/\r?\n/).slice(0, 5).join('\n').trim();
  return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
}

interface CommandPaletteProps {
  suggestions: ReturnType<typeof suggestionWindow>;
  selectedIndex: number;
}

export function CommandPalette({ suggestions, selectedIndex }: CommandPaletteProps): React.JSX.Element {
  return <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
    {suggestions.above > 0 && <Text color="gray">  ↑ {suggestions.above} 条更多命令</Text>}
    {suggestions.items.map((command, visibleIndex) => {
      const absoluteIndex = suggestions.start + visibleIndex;
      const selected = absoluteIndex === selectedIndex;
      return <Box key={command.name}>
        <Box width={3}><Text bold={selected} color={selected ? 'cyan' : 'gray'}>{selected ? '›' : ' '} </Text></Box>
        <Box width={18}><Text bold={selected} color={selected ? 'cyan' : undefined}>{command.name}</Text></Box>
        <Text color={selected ? 'cyan' : 'gray'}>{command.description}</Text>
      </Box>;
    })}
    {suggestions.below > 0 && <Text color="gray">  ↓ {suggestions.below} 条更多命令</Text>}
    <Box marginTop={1}>
      <Text color="gray">↑/↓ 导航 · </Text>
      <Text bold color="cyan">Tab</Text><Text color="gray"> 补全 · </Text>
      <Text bold color="cyan">Enter</Text><Text color="gray"> 选择/执行 · </Text>
      <Text bold color="cyan">Esc</Text><Text color="gray"> 关闭</Text>
    </Box>
  </Box>;
}

interface FirstRunDisclaimerProps {
  configFile?: string;
  onDecision: (accepted: boolean) => void;
}

export function FirstRunDisclaimer({ configFile, onDecision }: FirstRunDisclaimerProps): React.JSX.Element {
  const { exit } = useApp();
  const [selected, setSelected] = useState<0 | 1>(0);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();

  const finish = useCallback(async (accepted: boolean) => {
    if (busy) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      if (accepted) await acceptDisclaimer(configFile);
      onDecision(accepted);
      exit();
    } catch (error) {
      setBusy(false);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [busy, configFile, exit, onDecision]);

  useInput((input, key) => {
    if (busy) return;
    if (key.escape) return void finish(false);
    if (key.upArrow || key.downArrow || key.tab) return setSelected((current) => current === 0 ? 1 : 0);
    if (input === '1') return setSelected(0);
    if (input === '2') return setSelected(1);
    if (key.return) void finish(selected === 1);
  });

  return <Box flexDirection="column" paddingX={2} paddingY={1}>
    <Box borderStyle="single" borderColor="red" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="red">⚠ 警告：JLC CLI 为非官方工具</Text>
      <Box marginTop={1}><Text>{DISCLAIMER_NOTICE.split('\n').slice(2).join('\n')}</Text></Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold={selected === 0} color={selected === 0 ? 'cyan' : undefined}>{selected === 0 ? '❯' : ' '} 1. 否，退出</Text>
        <Text bold={selected === 1} color={selected === 1 ? 'cyan' : undefined}>{selected === 1 ? '❯' : ' '} 2. 是，我已了解并接受风险</Text>
      </Box>
      <Box marginTop={1}><Text italic color="gray">Enter 确认 · Esc 取消 · 默认为退出</Text></Box>
      {errorMessage && <Text color="red">{errorMessage}</Text>}
    </Box>
  </Box>;
}

export async function runDisclaimerPrompt(configFile?: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new JlcError('APPROVAL_REQUIRED', '首次使用必须在交互式终端阅读并确认非官方工具警告。');
  }
  let accepted = false;
  const instance = render(<FirstRunDisclaimer configFile={configFile} onDecision={(value) => { accepted = value; }} />);
  await instance.waitUntilExit();
  return accepted;
}

export async function startTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write('jlc-cli TUI requires an interactive terminal. Run `jlc-cli --help` for commands.\n');
    return;
  }
  if ((await disclaimerStatus()).required && !await runDisclaimerPrompt()) return;
  const instance = render(<App />);
  await instance.waitUntilExit();
}
