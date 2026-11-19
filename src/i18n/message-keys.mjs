import { parse, parseExpression } from '@babel/parser';
import { NodeTypes, parse as parseVue } from '@vue/compiler-dom';

const parserOptions = { sourceType: 'unambiguous', plugins: ['typescript', 'decorators-legacy'], allowReturnOutsideFunction: true };

function scriptComments(code, offset = 0, expression = false, jsx = false) {
  if (!code.includes('//') && !code.includes('/*')) return [];
  const options = jsx ? { ...parserOptions, plugins: [...parserOptions.plugins, 'jsx'] } : parserOptions;
  const parsed = expression ? parseExpression(code, options) : parse(code, options);
  return (parsed.comments ?? []).map(comment => [offset + comment.start, offset + comment.end]);
}

function literal(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
}

function inspectSource(source, isVue) {
  const keys = [];
  const ranges = [];
  function visit(node) {
    if (node.type === NodeTypes.COMMENT) ranges.push([node.loc.start.offset, node.loc.end.offset]);
    if (node.type === NodeTypes.INTERPOLATION) {
      const expr = node.content.loc;
      ranges.push(...scriptComments(expr.source, expr.start.offset, true));
    }
    if (node.type === NodeTypes.ELEMENT) {
      if (node.tag === 'script') {
        const jsx = node.props.some(p => p.name === 'lang' && ['tsx', 'jsx'].includes(p.value?.content));
        for (const c of node.children) ranges.push(...scriptComments(c.loc.source, c.loc.start.offset, false, jsx));
        return;
      }
      const richText = node.tag === 'i18n-t' || node.tag === 'I18nT';
      for (const prop of node.props) {
        if (richText && prop.type === NodeTypes.ATTRIBUTE && prop.name === 'keypath' && prop.value) keys.push(prop.value.content);
        if (prop.type !== NodeTypes.DIRECTIVE || !prop.exp?.content) continue;
        const boundKey = richText && prop.name === 'bind' && prop.arg?.isStatic && prop.arg.content === 'keypath';
        if (!boundKey && prop.name !== 't') continue;
        let value = parseExpression(prop.exp.content, parserOptions);
        if (prop.name === 't' && value.type === 'ObjectExpression') {
          const path = value.properties.findLast(p => p.type === 'ObjectProperty' && !p.computed && (p.key.name ?? p.key.value) === 'path');
          value = path?.value;
        }
        const key = literal(value);
        if (typeof key === 'string') keys.push(key);
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  if (isVue) visit(parseVue(source, { parseMode: 'sfc', comments: true }));
  else ranges.push(...scriptComments(source));
  const pieces = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    pieces.push(source.slice(cursor, start), source.slice(start, end).replace(/[^\r\n]/g, ' '));
    cursor = end;
  }
  pieces.push(source.slice(cursor));
  return { cleaned: pieces.join(''), keys };
}

export function stripSourceComments(source, isVue = false) {
  return inspectSource(source, isVue).cleaned;
}

const defaultNamespaces = new Set(['page', 'common', 'authentication', 'preferences', 'ui', 'profile']);

export function extractMessageKeys(source, { isVue = false, admin = false, namespaces = defaultNamespaces } = {}) {
  const { cleaned, keys } = inspectSource(source, isVue);
  const strings = [...cleaned.matchAll(/\b\$?t\(\s*(['"])([^'"\r\n]+)\1/g)].map(match => match[2]);
  const templates = [...cleaned.matchAll(/\b\$?t\(\s*`([\w.-]+)`\s*[,)]/g)].map(match => match[1]);
  const metadata = admin ? [...cleaned.matchAll(/['"]([\w-]+\.[\w.-]+)['"]/g)].map(match => match[1]).filter(key => namespaces.has(key.split('.')[0])) : [];
  return [...strings, ...templates, ...keys, ...metadata];
}
