import * as fs from 'fs';
import * as os from 'os';

import { CodexCliResolver, resolveCodexCliPath } from '@/utils/codexCli';
import { findCodexCLIPath } from '@/utils/path';

jest.mock('fs');
jest.mock('os');
jest.mock('@/utils/path', () => {
  const actual = jest.requireActual('@/utils/path');
  return {
    ...actual,
    findCodexCLIPath: jest.fn(),
  };
});

const mockedExists = fs.existsSync as jest.Mock;
const mockedStat = fs.statSync as jest.Mock;
const mockedFind = findCodexCLIPath as jest.Mock;
const mockedHostname = os.hostname as jest.Mock;

describe('CodexCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedHostname.mockReturnValue('test-host');
  });

  describe('hostname-based resolution', () => {
    it('should use hostname path when available', () => {
      mockedExists.mockImplementation((p: string) => p === '/hostname/codex');
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new CodexCliResolver();
      const resolved = resolver.resolve(
        { 'test-host': '/hostname/codex' },
        '/legacy/codex',
        ''
      );

      expect(resolved).toBe('/hostname/codex');
    });

    it('should fall back to legacy path when hostname not found', () => {
      mockedExists.mockImplementation((p: string) => p === '/legacy/codex');
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new CodexCliResolver();
      const resolved = resolver.resolve(
        { 'other-host': '/other/codex' },
        '/legacy/codex',
        ''
      );

      expect(resolved).toBe('/legacy/codex');
    });

    it('should fall back to legacy path when hostname paths empty', () => {
      mockedExists.mockImplementation((p: string) => p === '/legacy/codex');
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new CodexCliResolver();
      const resolved = resolver.resolve(
        {},
        '/legacy/codex',
        ''
      );

      expect(resolved).toBe('/legacy/codex');
    });

    it('should auto-detect when no paths configured', () => {
      mockedExists.mockReturnValue(false);
      mockedFind.mockReturnValue('/auto/codex');

      const resolver = new CodexCliResolver();
      const resolved = resolver.resolve({}, '', '');

      expect(resolved).toBe('/auto/codex');
      expect(mockedFind).toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('should cache resolved path and return same result', () => {
      mockedExists.mockImplementation((p: string) => p === '/hostname/codex');
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new CodexCliResolver();
      const first = resolver.resolve(
        { 'test-host': '/hostname/codex' },
        '',
        ''
      );
      const second = resolver.resolve(
        { 'test-host': '/hostname/codex' },
        '',
        ''
      );

      expect(first).toBe('/hostname/codex');
      expect(second).toBe('/hostname/codex');
      // existsSync should be called only once due to caching
      expect(mockedExists).toHaveBeenCalledTimes(1);
    });

    it('should invalidate cache when hostname path changes', () => {
      mockedExists.mockReturnValue(true);
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new CodexCliResolver();
      const first = resolver.resolve(
        { 'test-host': '/hostname/codex1' },
        '',
        ''
      );
      const second = resolver.resolve(
        { 'test-host': '/hostname/codex2' },
        '',
        ''
      );

      expect(first).toBe('/hostname/codex1');
      expect(second).toBe('/hostname/codex2');
    });

    it('should clear cache on reset()', () => {
      mockedExists.mockReturnValue(true);
      mockedStat.mockReturnValue({ isFile: () => true });

      const resolver = new CodexCliResolver();
      resolver.resolve(
        { 'test-host': '/hostname/codex' },
        '',
        ''
      );

      resolver.reset();

      resolver.resolve(
        { 'test-host': '/hostname/codex' },
        '',
        ''
      );

      // Should be called twice because cache was cleared
      expect(mockedExists).toHaveBeenCalledTimes(2);
    });
  });

  describe('legacy compatibility', () => {
    it('should use legacy path as fallback when hostname paths are empty', () => {
      mockedExists.mockImplementation((p: string) => p === '/legacy/codex');
      mockedStat.mockReturnValue({ isFile: () => true });
      mockedFind.mockReturnValue('/auto/codex');

      const resolver = new CodexCliResolver();
      const resolved = resolver.resolve({}, '/legacy/codex', '');

      expect(resolved).toBe('/legacy/codex');
      expect(mockedFind).not.toHaveBeenCalled();
    });

    it('should use legacy path when hostname paths are undefined', () => {
      mockedExists.mockImplementation((p: string) => p === '/legacy/codex');
      mockedStat.mockReturnValue({ isFile: () => true });
      mockedFind.mockReturnValue('/auto/codex');

      const resolver = new CodexCliResolver();
      const resolved = resolver.resolve(undefined, '/legacy/codex', '');

      expect(resolved).toBe('/legacy/codex');
      expect(mockedFind).not.toHaveBeenCalled();
    });
  });
});

describe('resolveCodexCliPath', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return hostname path when valid file exists', () => {
    mockedExists.mockImplementation((p: string) => p === '/hostname/codex');
    mockedStat.mockReturnValue({ isFile: () => true });

    const result = resolveCodexCliPath('/hostname/codex', '/legacy/codex', '');

    expect(result).toBe('/hostname/codex');
  });

  it('should skip hostname path if it is a directory', () => {
    mockedExists.mockReturnValue(true);
    mockedStat.mockImplementation((p: string) => ({
      isFile: () => p !== '/hostname/codex',
    }));

    const result = resolveCodexCliPath('/hostname/codex', '/legacy/codex', '');

    expect(result).toBe('/legacy/codex');
  });

  it('should handle empty hostname path gracefully', () => {
    mockedExists.mockImplementation((p: string) => p === '/legacy/codex');
    mockedStat.mockReturnValue({ isFile: () => true });

    const result = resolveCodexCliPath('', '/legacy/codex', '');

    expect(result).toBe('/legacy/codex');
  });

  it('should trim whitespace from paths', () => {
    mockedExists.mockImplementation((p: string) => p === '/hostname/codex');
    mockedStat.mockReturnValue({ isFile: () => true });

    const result = resolveCodexCliPath('  /hostname/codex  ', '', '');

    expect(result).toBe('/hostname/codex');
  });

  it('should handle null/undefined hostname path', () => {
    mockedExists.mockImplementation((p: string) => p === '/legacy/codex');
    mockedStat.mockReturnValue({ isFile: () => true });

    const result = resolveCodexCliPath(undefined, '/legacy/codex', '');

    expect(result).toBe('/legacy/codex');
  });

  it('should handle null/undefined legacy path', () => {
    mockedExists.mockReturnValue(false);
    mockedFind.mockReturnValue('/auto/codex');

    const result = resolveCodexCliPath('', undefined, '');

    expect(result).toBe('/auto/codex');
  });

  it('should fall through hostname path when existsSync returns false', () => {
    mockedExists.mockImplementation((p: string) => p === '/legacy/codex');
    mockedStat.mockReturnValue({ isFile: () => true });

    const result = resolveCodexCliPath('/nonexistent/codex', '/legacy/codex', '');

    expect(result).toBe('/legacy/codex');
  });

  it('should fall through hostname path when existsSync throws', () => {
    mockedExists.mockImplementation((p: string) => {
      if (p.includes('nonexistent')) throw new Error('Access denied');
      return p === '/legacy/codex';
    });
    mockedStat.mockReturnValue({ isFile: () => true });

    const result = resolveCodexCliPath('/nonexistent/codex', '/legacy/codex', '');

    expect(result).toBe('/legacy/codex');
  });

  it('should fall through legacy path when existsSync throws', () => {
    mockedExists.mockImplementation(() => {
      throw new Error('Access denied');
    });
    mockedFind.mockReturnValue('/auto/codex');

    const result = resolveCodexCliPath('', '/bad/path', '');

    expect(result).toBe('/auto/codex');
  });

  it('should skip legacy path if it is a directory', () => {
    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => false });
    mockedFind.mockReturnValue('/auto/codex');

    const result = resolveCodexCliPath('', '/legacy/dir', '');

    expect(result).toBe('/auto/codex');
  });

  it('should pass env PATH to findCodexCLIPath', () => {
    mockedExists.mockReturnValue(false);
    mockedFind.mockReturnValue(null);

    resolveCodexCliPath('', '', 'PATH=/custom/bin');

    expect(mockedFind).toHaveBeenCalledWith('/custom/bin');
  });
});
