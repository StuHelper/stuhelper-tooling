import fs from 'node:fs';

const escape = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const property = value => escape(value).replaceAll(':', '%3A').replaceAll(',', '%2C');

export function diagnostic(message, level = 'error') {
  console.error(message);
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const match = String(message).match(/^([^:\n]+?)(?::(\d+))?:\s*(.*)$/s);
  const location = match ? ` file=${property(match[1])}${match[2] ? `,line=${match[2]}` : ''}` : '';
  console.log(`::${level}${location}::${escape(match?.[3] ?? message)}`);
}

export function summary(name, result, details = '') {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  if (!fs.existsSync(process.env.GITHUB_STEP_SUMMARY) || fs.statSync(process.env.GITHUB_STEP_SUMMARY).size === 0) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '| Check | Result | Details |\n| --- | --- | --- |\n');
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
    for (const message of error.message.split('\n')) diagnostic(message);
    summary(name, 'Failed', `${((performance.now() - start) / 1000).toFixed(2)} s`);
    process.exitCode = 1;
  } finally {
    if (process.env.GITHUB_ACTIONS === 'true') console.log('::endgroup::');
  }
}
