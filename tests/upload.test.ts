import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * Runs scripts/upload.sh with a fake `git` that answers each `git push` from a script of outcomes.
 * Returns the exit code of upload() and the git commands that were run.
 */
function runUpload(outcomes: string[]): { code: number; calls: string[]; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'upload-'));
  writeFileSync(join(dir, 'outcomes'), outcomes.join('\n') + '\n');
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
[ "$1" = "pull" ] && exit 0
n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"
line=$(sed -n "\${n}p" "${dir}/outcomes")
case "$line" in
  ok) exit 0 ;;
  reset) echo "fatal: unable to access 'https://github.com/x.git/': Recv failure: Connection reset by peer" >&2; exit 128 ;;
  auth) echo "remote: Invalid username or token. Password authentication is not supported" >&2; echo "fatal: Authentication failed" >&2; exit 128 ;;
  behind) echo " ! [rejected] main -> main (fetch first)" >&2; exit 1 ;;
esac
exit 1
`,
  );
  chmodSync(join(dir, 'git'), 0o755);
  let code = 0;
  let log = '';
  try {
    log = execFileSync('/bin/sh', ['-c', `. "${resolve('scripts/upload.sh')}"; upload`], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RADAR_UPLOAD_WAITS: '0 0 0 0 0' },
      encoding: 'utf8',
    });
  } catch (err) {
    code = (err as { status: number }).status;
    log = (err as { stdout: string }).stdout;
  }
  const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
  return { code, calls, log };
}

test('upload: a dropped connection is retried until it goes through', () => {
  const r = runUpload(['reset', 'reset', 'ok']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, ['push -q', 'push -q', 'push -q']);
});

test('upload: gives up after 5 tries and says so', () => {
  const r = runUpload(['reset', 'reset', 'reset', 'reset', 'reset']);
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 5);
});

test('upload: an expired token stops at once, because retrying will not help', () => {
  const r = runUpload(['auth', 'ok']);
  assert.equal(r.code, 2);
  assert.deepEqual(r.calls, ['push -q']);
});

test('upload: when GitHub has a newer commit, it pulls it in and tries again', () => {
  const r = runUpload(['behind', 'ok']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, ['push -q', 'pull --rebase -q', 'push -q']);
});

test('morning job: waits for 07:00, then the first hour that gets through finishes the day, with one notification', async () => {
  const { cpSync, mkdirSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'daily-'));
  mkdirSync(join(dir, 'scripts'));
  cpSync('scripts/daily.sh', join(dir, 'scripts/daily.sh'));
  cpSync('scripts/upload.sh', join(dir, 'scripts/upload.sh'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // A fake node (the collector) and git; `pushes` says how each git push ends.
  // A fake node: `collect-exit` says how the collector ends (0, or 4 when most sources were unreachable).
  writeFileSync(join(dir, 'collect-exit'), '0');
  writeFileSync(
    join(bin, 'node'),
    `#!/bin/sh\ncase "$1" in *workflows*) echo workflows >> "${dir}/calls" ;; *backfill*) echo backfill >> "${dir}/calls" ;; *) echo collect >> "${dir}/calls"; exit $(cat "${dir}/collect-exit") ;; esac\nexit 0\n`,
  );
  writeFileSync(join(dir, 'workflows.yaml'), 'enabled: true\n');
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
case "$1" in
  push) echo push >> "${dir}/calls"; [ "$(cat "${dir}/pushes")" = ok ] && exit 0; echo "Recv failure: Connection reset by peer" >&2; exit 128 ;;
  diff) exit 1 ;;
  commit) echo commit >> "${dir}/calls" ;;
esac
exit 0
`,
  );
  // The hour comes from the file `hour` (07 unless a test changes it).
  writeFileSync(join(dir, 'hour'), '07');
  writeFileSync(join(bin, 'date'), `#!/bin/sh\ncase "$1" in +%H) cat "${dir}/hour" ;; +%F) echo 2026-11-02 ;; *) /bin/date "$@" ;; esac\n`);
  // Notifications are recorded instead of shown.
  writeFileSync(join(bin, 'notify'), `#!/bin/sh\necho notify >> "${dir}/calls"\n`);
  for (const f of ['node', 'git', 'date', 'notify']) chmodSync(join(bin, f), 0o755);
  const run = () => {
    try {
      execFileSync('/bin/sh', [join(dir, 'scripts/daily.sh')], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, RADAR_NODE: join(bin, 'node'), RADAR_NOTIFY: join(bin, 'notify'), RADAR_UPLOAD_WAITS: '0 0 0 0 0' } });
      return 0;
    } catch (err) {
      return (err as { status: number }).status;
    }
  };
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');

  writeFileSync(join(dir, 'hour'), '05');
  writeFileSync(join(dir, 'calls'), '');
  assert.equal(run(), 0);
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8').trim(), '', 'logging in before 07:00 does nothing');
  writeFileSync(join(dir, 'hour'), '07');

  writeFileSync(join(dir, 'pushes'), 'reset');
  assert.equal(run(), 1, 'all five uploads dropped');
  assert.deepEqual(calls(), ['collect', 'workflows', 'commit', 'push', 'push', 'push', 'push', 'push', 'notify']);
  assert.equal(existsSync(join(dir, '.cache/last-success')), false);

  writeFileSync(join(dir, 'calls'), '');
  writeFileSync(join(dir, 'hour'), '08');
  assert.equal(run(), 1, 'still offline at 08:00');
  assert.deepEqual(calls(), ['push', 'push', 'push', 'push', 'push'], 'the 08:00 run only uploads, and does not notify again');

  writeFileSync(join(dir, 'calls'), '');
  writeFileSync(join(dir, 'hour'), '09');
  writeFileSync(join(dir, 'pushes'), 'ok');
  assert.equal(run(), 0);
  assert.deepEqual(calls(), ['push'], 'the second run does not collect again');
  assert.equal(readFileSync(join(dir, '.cache/last-success'), 'utf8').trim(), '2026-11-02');

  writeFileSync(join(dir, 'calls'), '');
  assert.equal(run(), 0);
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8').trim(), '', 'a third run that day does nothing');
});

test('morning job: a run that could not reach most sources is saved, and every later hour collects again until one gets through', async () => {
  const { cpSync, mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'daily-'));
  mkdirSync(join(dir, 'scripts'));
  cpSync('scripts/daily.sh', join(dir, 'scripts/daily.sh'));
  cpSync('scripts/upload.sh', join(dir, 'scripts/upload.sh'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'collect-exit'), '4');
  writeFileSync(
    join(bin, 'node'),
    `#!/bin/sh\ncase "$1" in *backfill*) echo backfill >> "${dir}/calls" ;; *) echo collect >> "${dir}/calls"; exit $(cat "${dir}/collect-exit") ;; esac\nexit 0\n`,
  );
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in push) echo push >> "${dir}/calls" ;; diff) exit 1 ;; esac\nexit 0\n`);
  writeFileSync(join(bin, 'date'), `#!/bin/sh\ncase "$1" in +%H) echo 07 ;; +%F) echo 2026-11-05 ;; *) /bin/date "$@" ;; esac\n`);
  for (const f of ['node', 'git', 'date']) chmodSync(join(bin, f), 0o755);
  const run = () => {
    writeFileSync(join(dir, 'calls'), '');
    execFileSync('/bin/sh', [join(dir, 'scripts/daily.sh')], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, RADAR_NODE: join(bin, 'node'), RADAR_NOTIFY: '/usr/bin/true', RADAR_UPLOAD_WAITS: '0 0 0 0 0' } });
    return readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
  };

  // 07:00, mostly offline: what was found is uploaded, the pictures are tried again, and the day is not done.
  assert.deepEqual(run(), ['collect', 'backfill', 'push']);
  // 08:00, still offline: the same.
  assert.deepEqual(run(), ['collect', 'backfill', 'push']);
  // 09:00, back online: collects again, re-reads pictures, and the day is done.
  writeFileSync(join(dir, 'collect-exit'), '0');
  assert.deepEqual(run(), ['collect', 'backfill', 'push']);
  assert.deepEqual(run(), [''], 'the rest of the day does nothing');

  // A day that stays offline keeps trying every hour, however many runs it takes.
  writeFileSync(join(dir, 'collect-exit'), '4');
  writeFileSync(join(dir, '.cache/last-success'), '');
  writeFileSync(join(dir, '.cache/last-collected'), '');
  for (let hour = 0; hour < 6; hour++) assert.deepEqual(run(), ['collect', 'backfill', 'push'], `still trying, run ${hour + 1}`);
});

