#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';

const args = process.argv.slice(2);
await appendFile(process.env.FAKE_AGY_QUOTA_REPORT, `${JSON.stringify({ args, pid: process.pid, cwd: process.cwd(),
  home: process.env.HOME, geminiHome: process.env.GEMINI_HOME ?? null, agentHome: process.env.GIAN_AGENT_HOME ?? null })}\n`);
if (args.length === 1 && args[0] === '--help') {
  const helpStream = process.env.FAKE_AGY_HELP_STREAM ?? 'stderr';
  if (helpStream === 'split') process.stdout.write('Usage of agy:');
  (helpStream === 'stdout' ? process.stdout : process.stderr)
    .write('Available subcommands:\n  changelog  Show changelog and release notes\n');
  if (process.env.FAKE_AGY_HELP_FAIL === '1') process.exitCode = 1;
} else if (args.length === 1 && args[0] === 'changelog') {
  process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? '1.4.6'}:\nSynthetic release notes\n`);
} else if (JSON.stringify(args) !== JSON.stringify(['--output-format', 'json', '--print', '/usage', '--print-timeout', '20s', '--disable-slash-commands=false'])) {
  process.stderr.write('Unexpected command; fixture will not simulate a model turn.');
  process.exitCode = 1;
} else if (process.env.FAKE_AGY_MODE === 'auth') {
  process.stderr.write('Authenti');
  setTimeout(() => process.stderr.write('cation required. Please visit https://invalid.test/private-token\n'), 10);
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_AGY_MODE === 'hang') {
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_AGY_MODE === 'overflow') {
  process.stdout.write('x'.repeat(300 * 1024));
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(process.env.FAKE_AGY_USAGE_STDERR ?? '');
  process.stdout.write(process.env.FAKE_AGY_QUOTA_OUTPUT ?? JSON.stringify({ status: 'SUCCESS', conversation_id: '', num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, command: { name: 'usage', data: {
      groups: [{ name: 'Gemini', buckets: [{ id: 'fixture', name: 'Gemini Pro', window: '5h', remaining_fraction: 0.5 }] }],
    } } }));
}
