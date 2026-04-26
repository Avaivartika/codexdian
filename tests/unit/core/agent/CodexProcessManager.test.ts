import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

import { CodexProcessManager } from '@/core/agent/CodexProcessManager';
import * as env from '@/utils/env';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));

describe('CodexProcessManager', () => {
  const spawnMock = spawn as jest.MockedFunction<typeof spawn>;

  const createMockProcess = () => ({
    stdin: { write: jest.fn(), writable: true },
    stdout: { setEncoding: jest.fn(), on: jest.fn() },
    stderr: { setEncoding: jest.fn(), on: jest.fn() },
    on: jest.fn(),
    kill: jest.fn(),
  });

  beforeEach(() => {
    spawnMock.mockReturnValue(createMockProcess() as unknown as ReturnType<typeof spawn>);
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => false } as fs.Stats);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    spawnMock.mockReset();
  });

  it('starts JavaScript Codex entries with the Node executable resolved from PATH', () => {
    jest.spyOn(env, 'findNodeExecutable').mockReturnValue('C:\\Program Files\\nodejs\\node.exe');

    const manager = new CodexProcessManager();
    manager.start({
      cliPath: 'C:\\Users\\catpro\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
      cwd: 'C:\\vault',
      env: { PATH: 'C:\\Program Files\\nodejs' },
    });

    expect(env.findNodeExecutable).toHaveBeenCalledWith('C:\\Program Files\\nodejs');
    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.exe',
      [
        'C:\\Users\\catpro\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
        'app-server',
        '--listen',
        'stdio://',
      ],
      expect.objectContaining({
        cwd: 'C:\\vault',
      })
    );
  });

  it('does not assume node is next to codex.js when sibling node is missing', () => {
    jest.spyOn(env, 'findNodeExecutable').mockReturnValue(null);

    const manager = new CodexProcessManager();
    manager.start({
      cliPath: 'C:\\Users\\catpro\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
      cwd: 'C:\\vault',
      env: { PATH: '' },
    });

    expect(spawnMock.mock.calls[0][0]).not.toBe(
      'C:\\Users\\catpro\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\node.exe'
    );
  });

  it('starts native Codex binaries directly', () => {
    const findNodeExecutable = jest.spyOn(env, 'findNodeExecutable');

    const manager = new CodexProcessManager();
    manager.start({
      cliPath: 'C:\\Program Files\\Codex\\codex.exe',
      cwd: 'C:\\vault',
      env: { PATH: 'C:\\Program Files\\nodejs' },
    });

    expect(findNodeExecutable).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Program Files\\Codex\\codex.exe',
      ['app-server', '--listen', 'stdio://'],
      expect.any(Object)
    );
  });
});
