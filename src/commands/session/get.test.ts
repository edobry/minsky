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

describe('minsky session get CLI', () => {
  afterEach(() => {
    rmSync(SESSION_DB_PATH, { force: true });
  });

  it('prints human output when session exists', () => {
    setupSessionDb([
      { session: 'foo', repoUrl: 'https://repo', branch: 'main', createdAt: '2024-01-01' }
    ]);
    const { stdout } = spawnSync('bun', ['run', CLI, 'session', 'get', 'foo'], { encoding: 'utf-8', env: { ...process.env, XDG_STATE_HOME: '/tmp' } });
    expect(stdout).toContain('Session: foo');
    expect(stdout).toContain('Repo: https://repo');
    expect(stdout).toContain('Branch: main');
    expect(stdout).toContain('Created: 2024-01-01');
  });

  it('prints JSON output with --json', () => {
    setupSessionDb([
      { session: 'foo', repoUrl: 'https://repo', branch: 'main', createdAt: '2024-01-01' }
    ]);
    const { stdout } = spawnSync('bun', ['run', CLI, 'session', 'get', 'foo', '--json'], { encoding: 'utf-8', env: { ...process.env, XDG_STATE_HOME: '/tmp' } });
    const parsed = JSON.parse(stdout);
    expect(parsed.session).toBe('foo');
    expect(parsed.repoUrl).toBe('https://repo');
    expect(parsed.branch).toBe('main');
    expect(parsed.createdAt).toBe('2024-01-01');
  });

  it('prints null for --json when session not found', () => {
    setupSessionDb([]);
    const { stdout } = spawnSync('bun', ['run', CLI, 'session', 'get', 'notfound', '--json'], { encoding: 'utf-8', env: { ...process.env, XDG_STATE_HOME: '/tmp' } });
    expect(stdout.trim()).toBe('null');
  });

  it('prints human error when session not found', () => {
    setupSessionDb([]);
    const { stdout, stderr } = spawnSync('bun', ['run', CLI, 'session', 'get', 'notfound'], { encoding: 'utf-8', env: { ...process.env, XDG_STATE_HOME: '/tmp' } });
    expect(stdout).toBe('');
    expect(stderr || '').toContain("Session 'notfound' not found.");
  });
}); 
