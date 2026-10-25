import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';

const markdown = new MarkdownIt();
const categories = new Set(['design', 'spec', 'development', 'guide', 'adr']);
const statuses = new Set(['Draft', 'InReview', 'Accepted', 'Rejected', 'Deprecated', 'Superseded', 'Archived']);
const placeholder = /YYYY-MM-DD|\{\{[^{}\n]+\}\}|<待填写>|\bTODO\s*[:：]/u;
const posix = (value) => value.split(path.sep).join('/');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function filesIn(root) {
  const config = parseYaml(fs.readFileSync(path.join(root, '.markdownlint-cli2.yaml'), 'utf8'));
  for (const key of ['globs', 'ignores']) {
    if (!Array.isArray(config[key]) || config[key].some((item) => typeof item !== 'string' || !item)) {
      throw new Error(`${key} must contain path patterns`);
    }
  }
  const includes = picomatch(config.globs.filter((item) => !item.startsWith('!')), { dot: true });
  const excludes = picomatch([...config.ignores, ...config.globs.filter((item) => item.startsWith('!')).map((item) => item.slice(1))], { dot: true });
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    const relative = posix(path.relative(root, target));
    if (entry.isSymbolicLink() || excludes(relative) || excludes(relative + '/')) return [];
    if (entry.isDirectory()) return walk(target);
    return entry.isFile() && includes(relative) ? [target] : [];
  });
  return walk(root).sort();
}

// Match Python-Markdown toc.slugify_unicode and its unique-ID suffixes.
export function siteSlug(text, anchors) {
  let value = text.replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().toLowerCase().replace(/[-\s]+/gu, '-');
  while (!value || anchors.has(value)) {
    const suffix = value.match(/^(.*)_([0-9]+)$/u);
    value = suffix ? `${suffix[1]}_${Number(suffix[2]) + 1}` : `${value}_1`;
  }
  return value;
}

function parsedFile(file, siteDocument) {
  const source = fs.readFileSync(file, 'utf8');
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const body = frontmatter ? source.slice(frontmatter[0].length) : source;
  const tokens = markdown.parse(body, {});
  const slugger = new GithubSlugger();
  const anchors = new Set();
  const githubAnchors = new Set();
  const links = [];
  const prose = [];
  const paragraphs = [];
  const headings = [];
  const scenarios = [];
  const tableRows = [];
  const offset = frontmatter ? frontmatter[0].split('\n').length - 1 : 0;
  let row = null;
  let column = 0;
  tokens.forEach((token, index) => {
    const visible = children => (children ?? []).filter(child => ['text', 'code_inline', 'image', 'softbreak'].includes(child.type)).map(child => child.type === 'softbreak' ? ' ' : child.content).join('');
    if (token.type === 'tr_open') { row = { line: (token.map?.[0] ?? 0) + offset + 1, cells: [] }; column = 0; }
    if (token.type === 'td_open' || token.type === 'th_open') column++;
    if (token.type === 'tr_close' && row) { tableRows.push(row); row = null; }
    if (token.type === 'inline' && row) {
      const text = visible(token.children);
      row.cells.push({ text, link: token.children?.some(child => child.type === 'link_open') });
      const id = column === 1 && text.match(/^([A-Z][A-Z0-9]*(?:-[A-Z]+)*-\d+)(?:[：:]|\s|$)/)?.[1];
      if (id) scenarios.push({ id, line: row.line });
    }
    if (token.type === 'inline' && tokens[index - 1]?.type === 'paragraph_open') {
      paragraphs.push({ text: visible(token.children), line: (token.map?.[0] ?? 0) + offset + 1 });
    }
    if (token.type === 'heading_open') {
      const text = (tokens[index + 1]?.children ?? [])
        .filter((child) => ['text', 'code_inline', 'image'].includes(child.type))
        .map((child) => child.content).join('');
      headings.push({ text, line: (token.map?.[0] ?? 0) + offset + 1, level: token.tag });
      const githubAnchor = slugger.slug(text);
      githubAnchors.add(githubAnchor);
      anchors.add(siteDocument ? siteSlug(text, anchors) : githubAnchor);
    }
    for (const child of token.children ?? []) {
      if (child.type === 'link_open') links.push(child.attrGet('href'));
      if (child.type === 'image') links.push(child.attrGet('src'));
      if (child.type === 'text') prose.push(child.content);
    }
  });
  return { source, frontmatter, anchors, githubAnchors, links, prose, paragraphs, headings, scenarios, tableRows };
}

const gitText = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const shanghaiDate = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', numberingSystem: 'latn' }).format(new Date(date));
const withoutUpdated = source => source.replace(/^updated:.*$/m, '').trim();
function contentDate(root, relative) {
  for (const entry of gitText(root, 'log', '--format=%H %cI', '--', relative).split('\n')) {
    const [revision, date] = entry.split(' ');
    const current = gitText(root, 'show', `${revision}:${relative}`);
    let previous = '';
    try { previous = gitText(root, 'show', `${revision}^:${relative}`); } catch { /* New file. */ }
    if (withoutUpdated(current) !== withoutUpdated(previous)) return shanghaiDate(date);
  }
  throw new Error(`Cannot determine the content date of ${relative}`);
}
function changedDates(root, files, requestedBase, now) {
  let base = requestedBase;
  try { if (fs.realpathSync(gitText(root, 'rev-parse', '--show-toplevel')) !== root) return new Map(); }
  catch { return new Map(); }
  if (!base) {
    try { gitText(root, 'rev-parse', '--verify', 'origin/develop'); base = 'origin/develop'; }
    catch { base = 'HEAD'; }
  }
  if (/^0+$/.test(base)) base = null;
  if (base) {
    try { gitText(root, 'rev-parse', '--verify', `${base}^{commit}`); }
    catch { if (base === 'HEAD' && !requestedBase) base = null; else throw new Error(`Invalid documentation base: ${base}`); }
  }
  const dates = new Map();
  for (const file of files) {
    const relative = posix(path.relative(root, file));
    if (!relative.startsWith('docs/') || path.basename(file) === 'TEMPLATE.md') continue;
    const current = fs.readFileSync(file, 'utf8');
    let previous = '';
    try { if (base) previous = gitText(root, 'show', `${base}:${relative}`); } catch { /* New topic. */ }
    if (current.trim() === previous) continue;
    let committed = '';
    try { committed = gitText(root, 'show', `HEAD:${relative}`); } catch { /* New uncommitted topic. */ }
    const date = withoutUpdated(current) !== withoutUpdated(committed)
      ? shanghaiDate(now)
      : contentDate(root, relative);
    dates.set(file, date);
  }
  return dates;
}

export function checkDocs(directory, { base = process.env.DOCS_BASE_REF, now = Date.now(), glossary: suppliedGlossary } = {}) {
  const root = fs.realpathSync(directory);
  const errors = [];
  const cache = new Map();
  const read = (file) => {
    if (!cache.has(file)) cache.set(file, parsedFile(file, posix(path.relative(root, file)).startsWith('docs/')));
    return cache.get(file);
  };
  const files = filesIn(root);
  const ownGlossary = path.join(root, 'docs/spec/terminology.md');
  const glossary = suppliedGlossary ? path.resolve(root, suppliedGlossary) : ownGlossary;
  const requiredDates = changedDates(root, files, base, now);
  const today = shanghaiDate(now);
  const scenarioOwners = new Map();
  const adrOwners = new Map();
  const aliases = fs.existsSync(glossary) ? fs.readFileSync(glossary, 'utf8').split('\n').filter(line => line.startsWith('|')).flatMap(line => {
    const cells = line.split('|').map(cell => cell.trim());
    return cells.length === 7 && !['替代表述', '---', '—'].includes(cells[5]) ? cells[5].split('、').map(alias => [alias, cells[1]]) : [];
  }) : [];
  const siteFile = path.join(root, 'mkdocs.yml');
  const siteConfig = fs.existsSync(siteFile) ? fs.readFileSync(siteFile, 'utf8') : '';
  const repository = siteConfig.match(/^repo_url:\s*(https:\/\/github\.com\/[^\s]+)\s*$/m)?.[1];

  for (const file of files) {
    const relative = posix(path.relative(root, file));
    const report = (message) => errors.push(`${relative}: ${message}`);
    const parsed = read(file);
    const template = path.basename(file) === 'TEMPLATE.md';
    if (relative.startsWith('docs/')) {
      if (!parsed.frontmatter) {
        report('missing frontmatter');
      } else {
        try {
          const data = parseYaml(parsed.frontmatter[1]);
          const parts = relative.split('/');
          const allowedTypes = parts.length === 2 ? ['index'] : categories.has(parts[1]) ? [parts[1]] : [];
          if (!data || typeof data.type !== 'string' || !allowedTypes.includes(data.type)) report('type does not match document location');
          if (!statuses.has(data?.status)) report('invalid document status');
          const date = data?.updated;
          const valid = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
            && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
          if (!valid && !(template && date === 'YYYY-MM-DD')) report('invalid updated date');
          if (valid && date > today) report(`updated 不能晚于检查日期 ${today}，实际为 ${date}`);
          if (valid && requiredDates.has(file) && date < requiredDates.get(file)) report(`updated 必须不早于本次内容修改日期 ${requiredDates.get(file)}，实际为 ${date}`);
        } catch {
          report('invalid YAML metadata');
        }
      }
      if (!template && parsed.prose.some((text) => placeholder.test(text))) report('unfilled prose placeholder');
    }
    if (!template) for (const paragraph of parsed.paragraphs) {
      const count = [...paragraph.text].length;
      if (count > 200) report(`第 ${paragraph.line} 行段落有 ${count} 个可见字符，超过 200；请按主题拆分。`);
      if (/(?:不是.{0,80}而是|不应该.{0,80}而应该|不应.{0,80}而应)/u.test(paragraph.text)) report(`第 ${paragraph.line} 行请直接描述当前规则，必要的技术对比应明确具体条件。`);
    }
    for (const { id, line } of relative.startsWith('docs/spec/') ? parsed.scenarios : []) {
      if (scenarioOwners.has(id)) report(`第 ${line} 行场景编号 ${id} 与 ${scenarioOwners.get(id)} 重复。`);
      else scenarioOwners.set(id, `${relative}:${line}`);
    }
    if (/^docs\/adr\/\d/.test(relative)) {
      const number = path.basename(file).match(/^(\d{4})-/)?.[1];
      if (!number || !parsed.headings.some(heading => heading.level === 'h1' && heading.text.startsWith(`${number}：`))) report('ADR 文件编号必须与一级标题中的四位编号一致。');
      if (number && adrOwners.has(number)) report(`ADR 编号 ${number} 与 ${adrOwners.get(number)} 重复。`);
      if (number) adrOwners.set(number, relative);
    }
    if (file !== glossary) for (const [alias, canonical] of aliases) {
      if (parsed.prose.some(text => text.includes(alias))) report(`use standard term "${canonical}" instead of "${alias}"`);
    }
    for (let href of parsed.links) {
      let github = false;
      if (repository && href?.startsWith(`${repository}/blob/develop/`)) {
        const url = new URL(href);
        const relativeTarget = url.pathname.split('/blob/develop/')[1];
        href = posix(path.relative(path.dirname(file), path.join(root, relativeTarget))) + url.search + url.hash;
        github = true;
      }
      if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
      try {
        const hash = href.indexOf('#');
        const fragment = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1));
        const pathname = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split('?')[0]);
        const target = pathname ? path.resolve(path.dirname(file), pathname) : file;
        if (!inside(root, target) || !fs.existsSync(target) || !inside(root, fs.realpathSync(target))) {
          report(`missing or external local target: ${href}`);
        } else if (fragment && /\.(?:md|markdown)$/i.test(target) && fs.statSync(target).isFile() && !(github ? read(target).githubAnchors : read(target).anchors).has(fragment)) {
          report(`missing heading anchor: ${href}`);
        }
      } catch {
        report(`invalid local link: ${href}`);
      }
    }
  }
  for (const category of categories) {
    const index = path.join(root, 'docs', category, 'README.md');
    if (!fs.existsSync(index)) continue;
    for (const row of read(index).tableRows) if (row.cells[0]?.link) {
      const description = row.cells[1]?.text.trim();
      if (!description) errors.push(`${posix(path.relative(root, index))}:${row.line}: 主题描述不能为空。`);
      else if (row.cells[0].text === description) errors.push(`${posix(path.relative(root, index))}:${row.line}: 主题描述需要说明内容，不能重复标题。`);
    }
    const listed = new Set(read(index).links.map(link => path.resolve(path.dirname(index), link.split('#')[0])));
    for (const file of files.filter(file => path.dirname(file) === path.dirname(index) && !['README.md', 'TEMPLATE.md'].includes(path.basename(file)))) {
      if (!listed.has(file)) errors.push(`${posix(path.relative(root, index))}: missing topic ${path.basename(file)}`);
    }
  }
  if (/^nav:/m.test(siteConfig)) {
    const navigation = new Set([...siteConfig.matchAll(/^\s*-\s+[^:\n]+:\s+([\w./-]+\.md)\s*$/gm)].map(match => match[1]));
    for (const file of files.filter(file => posix(path.relative(root, file)).startsWith('docs/'))) {
      const target = posix(path.relative(path.join(root, 'docs'), file));
      if (!navigation.has(target)) errors.push(`mkdocs.yml: missing navigation ${target}`);
    }
  }
  return { count: files.length, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkDocs(process.cwd());
    if (result.errors.length) {
      console.error(result.errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`PASS: documentation metadata and local links (${result.count} Markdown files)`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
