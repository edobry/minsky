import { describe, it, expect, afterEach } from 'bun:test';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const CLI = 'src/cli.ts';
const SESSION_DB_PATH = join(process.env.XDG_STATE_HOME || '/tmp', 'minsky', 'session-db.json');

function setupSessionDb(sessions: Array<{ session: string; repoUrl: string; branch: string; createdAt: string }>) {
  mkdirSync(join(process.env.XDG_STATE_HOME || '/tmp', 'minsky'), { recursive: true });
  writeFileSync(SESSION_DB_PATH, JSON.stringify(sessions, null, 2));
}

describe('minsky session list CLI', () => {
  afterEach(() => {
    rmSync(SESSION_DB_PATH, { force: true });
  });

  it('prints human output when sessions exist', () => {
    setupSessionDb([
      { session: 'foo', repoUrl: 'https://repo', branch: 'main', createdAt: '2024-01-01' },
      { session: 'bar', repoUrl: 'https://repo2', branch: '', createdAt: '2024-01-02' }
    ]);
    const { stdout } = spawnSync('bun', ['run', CLI, 'session', 'list'], { encoding: 'utf-8', env: { ...process.env, XDG_STATE_HOME: '/tmp' } });
    expect(stdout).toContain('Session: foo');
    expect(stdout).toContain('Session: bar');
  });

  it('prints JSON output with --json', () => {
    setupSessionDb([
      { session: 'foo', repoUrl: 'https://repo', branch: 'main', createdAt: '2024-01-01' }
    ]);
    const { stdout } = spawnSync('bun', ['run', CLI, 'session', 'list', '--json'], { encoding: 'utf-8', env: { ...process.env, XDG_STATE_HOME: '/tmp' } });
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].session).toBe('foo');
  });

  it('prints [] for --json when no sessions', () => {
    setupSessionDb([]);
    const { stdout } = spawnSync('bun', ['run', CLI, 'session', 'list', '--json'], { encoding: 'utf-8', env: { ...process.env, XDG_STATE_HOME: '/tmp' } });
    expect(stdout.trim()).toBe('[]');
  });

  it('prints human message when no sessions', () => {
    setupSessionDb([]);
    const { stdout } = spawnSync('bun', ['run', CLI, 'session', 'list'], { encoding: 'utf-8', env: { ...process.env, XDG_STATE_HOME: '/tmp' } });
    expect(stdout).toContain('No sessions found.');
  });
}); 
