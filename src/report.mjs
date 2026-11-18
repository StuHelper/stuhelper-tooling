import fs from 'node:fs';

const escape = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const property = value => escape(value).replaceAll(':', '%3A').replaceAll(',', '%2C');

export function diagnostic(message, level = 'error') {
  console.error(message);
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const match = String(message).match(/^([^:\n]+?)(?::(\d+))?:\s*(.*)$/s);
  const candidate = match?.[1];
  const pathLike = candidate && (fs.existsSync(candidate) || /^(?:[^\s:]+\/[^:]+|[^\s:]+\.[a-z0-9]+)$/i.test(candidate));
  const chineseLine = pathLike && match[3].match(/^第 (\d+) 行/);
  const line = match?.[2] || chineseLine?.[1];
  const location = pathLike ? ` file=${property(match[1])}${line ? `,line=${line}` : ''}` : '';
  console.log(`::${level}${location}::${escape(pathLike ? match[3] : message)}`);
}

export function summary(name, result, details = '') {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const existing = fs.existsSync(process.env.GITHUB_STEP_SUMMARY) ? fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8') : '';
  if (!existing.includes('| Check | Result | Details |')) {
    const prefix = existing && !existing.endsWith('\n\n') ? '\n' : '';
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${prefix}| Check | Result | Details |\n| --- | --- | --- |\n`);
  }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| ${name.replaceAll('|', '\\|')} | ${result} | ${details.replaceAll('|', '\\|').replaceAll('\n', ' ')} |\n`);
}

export async function reported(name, action) {
  const start = performance.now();
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::group::${escape(name)}`);
  try {
    const result = await action();
    console.log(`PASS: ${name}`);
    summary(name, 'Passed', `${((performance.now() - start) / 1000).toFixed(2)} s`);
    return result;
  } catch (error) {
    for (const message of error instanceof AggregateError ? error.errors : [error.message]) diagnostic(message);
    summary(name, 'Failed', `${((performance.now() - start) / 1000).toFixed(2)} s`);
    process.exitCode = 1;
  } finally {
    if (process.env.GITHUB_ACTIONS === 'true') console.log('::endgroup::');
  }
}
