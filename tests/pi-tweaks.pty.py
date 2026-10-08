"""Exercise pi-tweaks in the real bundled Pi CLI using an isolated pseudo-terminal.

No model prompts, credentials, MCP connections, or real user settings are used.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import uuid

PLUGIN = Path(__file__).resolve().parents[1]
ROWS, COLUMNS = 90, 100
CSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
OSC = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')
ROW_WRITE = re.compile(r'\x1b\[(\d+);1H\x1b\[2K')

with tempfile.TemporaryDirectory(prefix='pi-tweaks-pty-') as directory:
    root = Path(directory)
    agent = root / 'agent'
    workspace = root / 'workspace'
    agent.mkdir()
    workspace.mkdir()
    (agent / 'extensions').mkdir()
    (agent / 'extensions' / 'demo-renderers.ts').write_text('''
import { Text } from "@earendil-works/pi-tui";
export default function (pi) {
  pi.registerToolRenderer((name, next) => name.startsWith("demo_compact_") ? {
    renderShell: "default",
    renderCall: () => new Text(name === "demo_compact_a" ? "COMPACT_CALL_A" : "COMPACT_CALL_B", 0, 0),
    renderResult: () => ({ render: () => [], invalidate() {} }),
  } : next());
}
''')
    (agent / 'settings.json').write_text(json.dumps({
        'theme': 'dark', 'tuiMode': 'fullscreen',
        'quietStartup': True, 'hideThinkingBlock': True,
        'defaultProvider': 'openai', 'defaultModel': 'gpt-4o',
        'enableInstallTelemetry': False,
    }))
    now = int(time.time() * 1000)
    stamp = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    usage = {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 0,
             'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}}
    entries = [{'type': 'session', 'version': 3, 'id': str(uuid.uuid4()),
                'timestamp': stamp, 'cwd': str(workspace)}]

    def append_message(message):
        parent = entries[-1].get('id') if entries[-1]['type'] != 'session' else None
        entries.append({'type': 'message', 'id': uuid.uuid4().hex[:8],
                        'parentId': parent, 'timestamp': stamp, 'message': message})

    def assistant(content, stop='stop'):
        return {'role': 'assistant', 'content': content, 'api': 'openai-completions',
                'provider': 'openai', 'model': 'gpt-4o', 'usage': usage,
                'stopReason': stop, 'timestamp': now}

    append_message({'role': 'user', 'content': 'Hover smoke test', 'timestamp': now})
    append_message(assistant([
        {'type': 'toolCall', 'id': 'compact-a', 'name': 'demo_compact_a', 'arguments': {}},
        {'type': 'toolCall', 'id': 'compact-b', 'name': 'demo_compact_b', 'arguments': {}},
    ], 'toolUse'))
    for name, call in [('demo_compact_a', 'compact-a'), ('demo_compact_b', 'compact-b')]:
        append_message({'role': 'toolResult', 'toolCallId': call, 'toolName': name,
                        'content': [], 'isError': False, 'timestamp': now})
    append_message(assistant([
        {'type': 'thinking', 'thinking': 'PTY_THOUGHT_DETAIL'},
        {'type': 'text', 'text': 'HOVER_SMOKE_REPLY\n\nsecond reply line'},
    ]))
    append_message(assistant([{'type': 'toolCall', 'id': 'search-test-call',
                               'name': 'mcp__duckduckgo__search',
                               'arguments': {'query': 'TOOL_CALL_MARKER'}}], 'toolUse'))
    append_message({'role': 'toolResult', 'toolCallId': 'search-test-call',
                    'toolName': 'mcp__duckduckgo__search', 'content': [{
                        'type': 'text', 'text': 'TOOL_RESULT_MARKER\n' + '\n'.join(f'TOOL_LINE_{i}' for i in range(16)),
                    }], 'isError': False, 'timestamp': now})
    append_message({'role': 'bashExecution', 'command': 'printf simulated',
                    'output': 'PTY_BASH_MARKER\n', 'exitCode': 0, 'cancelled': False,
                    'truncated': False, 'timestamp': now})
    append_message({'role': 'custom', 'customType': 'hover-test',
                    'content': 'PTY_CUSTOM_MARKER', 'display': True, 'timestamp': now})
    append_message({'role': 'user', 'content': 'SECOND_USER_MARKER', 'timestamp': now})
    append_message(assistant([{'type': 'text', 'text': 'PTY_FINAL_REPLY'}]))
    session = root / 'session.jsonl'
    session.write_text(''.join(json.dumps(entry) + '\n' for entry in entries))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLUMNS, 0, 0))
    environment = {key: value for key, value in os.environ.items()
                   if not any(word in key.upper() for word in ('API_KEY', 'TOKEN', 'SECRET')) and not key.startswith('AWS_')}
    environment.update({'PI_CODING_AGENT_DIR': str(agent), 'PI_OFFLINE': '1',
                        'PI_SKIP_VERSION_CHECK': '1', 'TERM': 'xterm-kitty',
                        'AWS_EC2_METADATA_DISABLED': 'true', 'AWS_CONFIG_FILE': '/dev/null',
                        'AWS_SHARED_CREDENTIALS_FILE': '/dev/null'})
    for key in ('PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_STARTUP_BENCHMARK', 'TMUX', 'ZELLIJ', 'STY'):
        environment.pop(key, None)
    process = subprocess.Popen([
        shutil.which('pi'), '--offline', '--no-mcp', '--no-tools', '--no-skills',
        '--no-context-files', '--no-prompt-templates', '--session', str(session),
        '--extension', str(PLUGIN),
    ], stdin=slave, stdout=slave, stderr=slave, env=environment, cwd=workspace, start_new_session=True)
    os.close(slave)
    received = bytearray()

    def collect(seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], min(.05, max(0, deadline-time.monotonic())))
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                received.extend(chunk)

    def screen():
        text = received.decode(errors='replace')
        writes = list(ROW_WRITE.finditer(text))
        lines = {}
        for index, match in enumerate(writes):
            end = writes[index+1].start() if index+1 < len(writes) else len(text)
            content = CSI.sub('', OSC.sub('', text[match.end():end]))
            lines[int(match[1])] = content.replace('\r', '').replace('\n', '')
        return {row: line for row, line in lines.items() if 1 <= row <= ROWS}

    def wait_for(predicate, description, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            collect(.1)
            if predicate():
                return
            if process.poll() is not None:
                break
        raise AssertionError(description + '\nOutput tail:\n' + received.decode(errors='replace')[-8000:])

    def row_with(marker):
        return next((row for row, line in screen().items() if marker in line), None)

    def send(text):
        os.write(master, text.encode())

    def mouse(button, column, row, suffix='M'):
        send(f'\x1b[<{button};{column};{row}{suffix}')

    def hover(marker='HOVER_SMOKE_REPLY', expected=True):
        row = row_with(marker)
        assert row is not None, marker + ' must be visible'
        mouse(35, 6, row)
        if expected:
            wait_for(lambda: screen().get(row, '').startswith(('┌', '│', '└')),
                     'no hover bracket for ' + marker)
        else:
            collect(.3)
            assert not any(line.startswith(('┌', '│', '└')) for line in screen().values()), marker

    def ticks():
        lines = screen()
        up = next((row for row, line in lines.items() if line.rstrip().endswith('▴')), None)
        down = next((row for row, line in lines.items() if line.rstrip().endswith('▾')), None)
        return list(range(up + 1, down)) if up is not None and down is not None else []

    try:
        wait_for(lambda: row_with('HOVER_SMOKE_REPLY') is not None, 'CLI did not show the fixture')
        collect(.7)
        send('/question-nav\r')
        wait_for(lambda: b'Usage: /question-nav <number>. 2 questions are rendered.' in received,
                 'the package entrypoint did not register the navigation command')
        assert not any(line.startswith(('┌', '│', '└')) for line in screen().values())
        assert row_with('COMPACT_CALL_B') - row_with('COMPACT_CALL_A') == 2, 'tool calls must have only one blank separating row'
        print('PASS: real CLI tool shells have compact one-row spacing.')
        for marker in ['HOVER_SMOKE_REPLY', 'TOOL_CALL_MARKER', 'TOOL_RESULT_MARKER',
                       'PTY_BASH_MARKER', 'PTY_CUSTOM_MARKER', 'Usage: /question-nav', 'PTY_FINAL_REPLY']:
            hover(marker)
        hover('Hover smoke test')
        hover('SECOND_USER_MARKER')
        print('PASS: pi-tweaks package loads; every message type, including user messages, gets a hover bracket.')
        mouse(35, 6, ROWS)
        wait_for(lambda: not any(line.startswith(('┌', '│', '└')) for line in screen().values()),
                 'leaving chat did not clear the bracket')
        thought_row = row_with('Thinking...')
        assert thought_row is not None
        mouse(0, 10, thought_row)
        mouse(0, 10, thought_row, 'm')
        wait_for(lambda: row_with('PTY_THOUGHT_DETAIL') is not None, 'thinking click stopped working')
        print('PASS: native thinking clicks remain functional.')
        send('/reload\r')
        wait_for(lambda: b'Reloaded keybindings' in received, 'reload did not finish')
        collect(.3)
        hover('TOOL_RESULT_MARKER')
        print('PASS: unload/reload restores and reattaches the renderer hooks.')

        # Compact footer: directory path, auto compact indicator and model are unified onto a single line.
        footer_line = next((line for line in screen().values() if 'workspace' in line), None)
        assert footer_line is not None and '(auto)' in footer_line and ('gpt-4o' in footer_line or 'unknown' in footer_line), \
            'workspace, auto indicator and model must be on the same footer line: ' + str(footer_line)
        print('PASS: compact status bar shows directory, stats and model on a single line.')

        # Empty enter with empty queue remains safe and non-crashing in real CLI.
        send('\r')
        collect(.3)
        assert process.poll() is None, 'empty enter caused process to crash'

        # Make the first question genuinely off-screen, then exercise the actual rail.
        ROWS = 24
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLUMNS, 0, 0))
        process.send_signal(signal.SIGWINCH)
        wait_for(lambda: len(ticks()) == 2 and row_with('Hover smoke test') is None,
                 'resize did not create an off-screen first question and a two-tick rail')
        first_tick = ticks()[0]
        # The short glyph stays at the edge, then grows left on hover.
        nav_column = COLUMNS
        mouse(35, nav_column, first_tick)
        wait_for(lambda: row_with('Question 1/2') is not None and row_with('Hover smoke test') is not None,
                 'hover did not preview the off-screen user question')
        assert screen()[first_tick].endswith('────'), 'hovered tick did not grow left'
        mouse(35, 6, ROWS)
        wait_for(lambda: row_with('Question 1/2') is None, 'preview did not hide on mouse leave')
        assert not screen()[first_tick].endswith('────'), 'tick did not shrink on mouse leave'
        print('PASS: a short edge tick grows left on hover and shrinks when the mouse leaves.')

        send('DRAFT_KEEP')
        wait_for(lambda: row_with('DRAFT_KEEP') is not None, 'draft was not entered')
        draft_row = row_with('DRAFT_KEEP')
        before_jump = session.read_bytes()
        first_tick = ticks()[0]
        # Click the left end of the expanded bar, not only its original one-cell tip.
        mouse(35, nav_column, first_tick)
        wait_for(lambda: screen()[first_tick].endswith('────'), 'tick did not expand before click')
        mouse(0, nav_column - 3, first_tick)
        mouse(0, nav_column - 3, first_tick, 'm')
        wait_for(lambda: row_with('Hover smoke test') is not None and row_with('Hover smoke test') <= 3,
                 'click did not scroll to the first question')
        assert row_with('Question 1/2') is None
        mouse(35, 6, ROWS)
        collect(.2)
        assert any(line.startswith('┌') for row, line in screen().items() if row <= 3), 'navigation destination must remain marked after mouse leave'
        assert row_with('DRAFT_KEEP') == draft_row, 'mouse navigation changed the editor draft'
        assert session.read_bytes() == before_jump, 'mouse navigation changed the session/branch'
        print('PASS: click pins a marker on the destination while preserving draft, session bytes and branch.')
        send('\x15')
        wait_for(lambda: row_with('DRAFT_KEEP') is None, 'Ctrl+U did not clear the test draft')
        send('/question-nav 2\r')
        wait_for(lambda: row_with('SECOND_USER_MARKER') is not None,
                 'numbered keyboard navigation did not locate the second question')
        assert session.read_bytes() == before_jump, 'keyboard navigation changed the session'
        send('/question-nav 1\r')
        wait_for(lambda: row_with('Hover smoke test') is not None and row_with('Hover smoke test') <= 3, 'first question not located')
        wait_for(lambda: row_with('↓') is not None, 'minimal jump-to-end arrow did not appear')
        assert row_with('Jump to latest message') is None, 'verbose jump banner remains visible'
        arrow_row = row_with('↓')
        arrow_column = screen()[arrow_row].index('↓') + 1
        mouse(0, arrow_column, arrow_row)
        mouse(0, arrow_column, arrow_row, 'm')
        wait_for(lambda: row_with('PTY_FINAL_REPLY') is not None and row_with('↓') is None,
                 'arrow click did not restore follow-end scrolling')
        assert session.read_bytes() == before_jump
        print('PASS: compact arrow replaces the verbose banner and still jumps to the latest message.')
        assert not (agent / 'pi-tweaks.json').exists()
        assert not (agent / 'ai-hover-frame.json').exists()
        print('PASS: numbered keyboard navigation works without switch commands or preference files.')
        text = received.decode(errors='replace')
        assert 'Failed to load extension' not in text
        assert 'pi-tweaks could not attach:' not in text
        send('\x04')
        collect(.5)
        print('PASS: real CLI smoke test completed without any model request or MCP connection.')
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        os.close(master)
