'use strict';

/* ============================================================
 * 正则可视化
 * 1. 解析表达式，得到带源码偏移的语法树
 * 2. 把语法树渲染成嵌套的方框图，原文与结构双向悬停高亮
 * 3. 可选的匹配测试（Worker 中执行，超时即中止）
 * ============================================================ */

/* ---------------- 语法错误 ---------------- */

class RegexSyntaxError extends Error {
  constructor(message, index) {
    super(message);
    this.name = 'RegexSyntaxError';
    this.index = index;
  }
}

/* ---------------- 常量 ---------------- */

const SET_INFO = {
  d: { label: '数字', desc: '数字 0–9' },
  D: { label: '非数字', desc: '除数字 0–9 之外的字符' },
  w: { label: '单词字符', desc: '字母、数字或下划线（[A-Za-z0-9_]）' },
  W: { label: '非单词', desc: '不匹配 [A-Za-z0-9_] 的字符' },
  s: { label: '空白', desc: '空白字符（空格、制表、换行等）' },
  S: { label: '非空白', desc: '非空白字符' },
};

// 捕获组名允许 Unicode 标识符；个别旧浏览器不支持 \p，构建失败时跳过校验
let GROUP_NAME_RE = null;
try {
  GROUP_NAME_RE = new RegExp('^[$_\\p{ID_Start}][$_\\u200C\\u200D\\p{ID_Continue}]*$', 'u');
} catch (e) {
  GROUP_NAME_RE = null;
}

const CHAR_WORDS = {
  ' ': '空格',
  '\t': '制表',
  '\n': '换行',
  '\r': '回车',
  '\v': '垂直制表',
  '\f': '换页',
  '\0': '空字符',
  '\u00a0': '不换行空格',
};

/* ============================================================
 * 解析
 * ============================================================ */

function parseRegex(pattern, flags) {
  const src = String(pattern == null ? '' : pattern);
  const flagStr = String(flags == null ? '' : flags);
  const unicode = flagStr.indexOf('u') !== -1;

  let i = 0;
  let seq = 0;
  let captures = 0;
  const named = new Map();
  const nodes = [];

  function make(node) {
    node.id = 'n' + (++seq);
    nodes.push(node);
    return node;
  }

  function fail(message, index) {
    throw new RegexSyntaxError(message, index == null ? i : index);
  }

  function parseDisjunction() {
    const start = i;
    const branches = [parseAlternative()];
    while (src[i] === '|') {
      i++;
      branches.push(parseAlternative());
    }
    if (branches.length === 1) return branches[0];
    return make({ type: 'alt', branches: branches, start: start, end: i });
  }

  function parseAlternative() {
    const start = i;
    const items = [];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const before = i;
      items.push(parseTerm());
      if (i === before) fail('无法解析的内容', i);
    }
    if (items.length === 0) return make({ type: 'empty', start: start, end: i });
    if (items.length === 1) return items[0];
    return make({ type: 'seq', items: items, start: start, end: i });
  }

  function parseTerm() {
    const start = i;
    const c = src[i];
    if (c === '*' || c === '+' || c === '?') {
      fail('量词 “' + c + '” 前没有可重复的内容', i);
    }

    const atom = parseAtom();
    let min = 0;
    let max = 0;
    let hasQuant = false;
    const qStart = i;

    if (src[i] === '*') {
      min = 0; max = Infinity; hasQuant = true; i++;
    } else if (src[i] === '+') {
      min = 1; max = Infinity; hasQuant = true; i++;
    } else if (src[i] === '?') {
      min = 0; max = 1; hasQuant = true; i++;
    } else if (src[i] === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(src.slice(i));
      if (m) {
        const lo = Number(m[1]);
        const hi = m[2] === undefined ? lo : (m[2] === '' ? Infinity : Number(m[2]));
        if (hi < lo) fail('量词范围不合法：{' + m[1] + ',' + m[2] + '}', i);
        min = lo;
        max = hi;
        hasQuant = true;
        i += m[0].length;
      }
    }

    if (!hasQuant) return atom;

    let greedy = true;
    if (src[i] === '?') {
      greedy = false;
      i++;
    }

    return make({
      type: 'quant',
      atom: atom,
      min: min,
      max: max,
      greedy: greedy,
      symbol: src.slice(qStart, i),
      start: start,
      end: i,
    });
  }

  function parseAtom() {
    const start = i;
    const c = src[i];

    if (c === '^') { i++; return make({ type: 'anchor', kind: '^', start: start, end: i }); }
    if (c === '$') { i++; return make({ type: 'anchor', kind: '$', start: start, end: i }); }
    if (c === '.') { i++; return make({ type: 'dot', start: start, end: i }); }
    if (c === '(') return parseGroup();
    if (c === '[') return parseClass();
    if (c === '\\') return parseEscape(false);
    if (c === '*' || c === '+' || c === '?') {
      fail('量词 “' + c + '” 前没有可重复的内容', i);
    }
    if (c === undefined) fail('表达式意外结束', i);

    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    return make({ type: 'char', ch: ch, raw: ch, escaped: false, start: start, end: i });
  }

  function parseGroup() {
    const start = i;
    i++; // (
    let kind = 'capture';
    let name = null;
    let index = null;

    if (src[i] === '?') {
      const c = src[i + 1];
      if (c === ':') {
        kind = 'noncapture';
        i += 2;
      } else if (c === '=') {
        kind = 'lookahead';
        i += 2;
      } else if (c === '!') {
        kind = 'neg-lookahead';
        i += 2;
      } else if (c === '<') {
        const d = src[i + 2];
        if (d === '=') {
          kind = 'lookbehind';
          i += 3;
        } else if (d === '!') {
          kind = 'neg-lookbehind';
          i += 3;
        } else {
          const close = src.indexOf('>', i + 2);
          if (close === -1) fail('命名捕获组缺少 “>”', i);
          name = src.slice(i + 2, close);
          if (!name) fail('命名捕获组名不能为空', i + 2);
          if (GROUP_NAME_RE && !GROUP_NAME_RE.test(name)) {
            fail('捕获组名不合法：' + name, i + 2);
          }
          if (named.has(name)) fail('捕获组名重复：' + name, i + 2);
          kind = 'named';
          i = close + 1;
        }
      } else {
        fail('无效的分组写法 “(?”', i);
      }
    }

    if (kind === 'capture' || kind === 'named') {
      index = ++captures;
      if (name) named.set(name, index);
    }

    const body = parseDisjunction();
    if (src[i] !== ')') fail('缺少右括号 “)”', start);
    i++;

    return make({
      type: 'group',
      kind: kind,
      index: index,
      name: name,
      body: body,
      start: start,
      end: i,
    });
  }

  function parseClass() {
    const start = i;
    i++; // [
    let negated = false;
    if (src[i] === '^') {
      negated = true;
      i++;
    }

    const items = [];
    let closed = false;

    while (i < src.length) {
      if (src[i] === ']') {
        i++;
        closed = true;
        break;
      }

      const itemStart = i;
      const atom = parseClassAtom();

      if (src[i] === '-' && i + 1 < src.length && src[i + 1] !== ']') {
        const dashAt = i;
        i++;
        const to = parseClassAtom();
        if (atom.type === 'char' && to.type === 'char') {
          const from = atom.ch.codePointAt(0);
          const until = to.ch.codePointAt(0);
          if (from > until) {
            fail('字符组范围不合法：“' + src.slice(itemStart, i) + '”', itemStart);
          }
          items.push({ type: 'range', from: atom.ch, to: to.ch, start: itemStart, end: i });
        } else {
          // 非 u 模式下 [\d-a] 这类写法仍然合法，'-' 按字面量处理
          items.push(atom, { type: 'char', ch: '-', raw: '-', escaped: false, start: dashAt, end: dashAt + 1 }, to);
        }
      } else {
        items.push(atom);
      }
    }

    if (!closed) fail('字符组缺少右括号 “]”', start);

    return make({
      type: 'class',
      negated: negated,
      items: items,
      raw: src.slice(start, i),
      start: start,
      end: i,
    });
  }

  function parseClassAtom() {
    const start = i;
    if (src[i] === '\\') return parseEscape(true);
    if (src[i] === undefined) fail('字符组意外结束', i);
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    return { type: 'char', ch: ch, raw: ch, escaped: false, start: start, end: i };
  }

  // inClass 为 true 时不登记节点：字符组内部只用于生成说明，不参与结构图
  function parseEscape(inClass) {
    const start = i;
    const reg = inClass
      ? function (node) { return node; }
      : function (node) { return make(node); };

    i++; // backslash
    if (i >= src.length) fail('表达式不能以 “\\” 结尾', start);
    const c = src[i];

    if (SET_INFO[c]) {
      i++;
      return reg({ type: 'set', ch: c, raw: src.slice(start, i), start: start, end: i });
    }

    if (c === 'b') {
      i++;
      if (inClass) {
        return reg({ type: 'char', ch: '\b', raw: '\\b', escaped: true, start: start, end: i });
      }
      return reg({ type: 'assert', kind: '\\b', start: start, end: i });
    }

    if (c === 'B') {
      i++;
      if (inClass) {
        return reg({ type: 'char', ch: 'B', raw: '\\B', escaped: true, start: start, end: i });
      }
      return reg({ type: 'assert', kind: '\\B', start: start, end: i });
    }

    if ((c === 'p' || c === 'P') && unicode && src[i + 1] === '{') {
      const close = src.indexOf('}', i + 2);
      if (close === -1) fail('Unicode 属性缺少 “}”', start);
      const prop = src.slice(i + 2, close);
      if (!prop) fail('Unicode 属性不能为空', start);
      i = close + 1;
      return reg({
        type: 'property',
        prop: prop,
        negated: c === 'P',
        raw: src.slice(start, i),
        start: start,
        end: i,
      });
    }

    if (!inClass && c === 'k' && src[i + 1] === '<') {
      const close = src.indexOf('>', i + 2);
      if (close === -1) fail('命名反向引用缺少 “>”', start);
      const name = src.slice(i + 2, close);
      if (!name) fail('命名反向引用不能为空', i + 2);
      i = close + 1;
      return reg({ type: 'backref', name: name, raw: src.slice(start, i), start: start, end: i });
    }

    if (!inClass && c >= '1' && c <= '9') {
      let j = i;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
      const number = Number(src.slice(i, j));
      i = j;
      return reg({ type: 'backref', number: number, raw: src.slice(start, i), start: start, end: i });
    }

    if (c >= '0' && c <= '7') {
      let j = i;
      let digits = '';
      while (j < src.length && digits.length < 3 && src[j] >= '0' && src[j] <= '7') {
        digits += src[j];
        j++;
      }
      i = j;
      return reg({
        type: 'char',
        ch: String.fromCharCode(parseInt(digits, 8)),
        raw: src.slice(start, i),
        escaped: true,
        start: start,
        end: i,
      });
    }

    const simple = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' };
    if (simple[c]) {
      i++;
      return reg({ type: 'char', ch: simple[c], raw: '\\' + c, escaped: true, start: start, end: i });
    }

    if (c === 'c') {
      const d = src[i + 1];
      if (d && /[A-Za-z]/.test(d)) {
        const ch = String.fromCharCode(d.toUpperCase().charCodeAt(0) - 64);
        i += 2;
        return reg({ type: 'char', ch: ch, raw: src.slice(start, i), escaped: true, start: start, end: i });
      }
      i++;
      return reg({ type: 'char', ch: 'c', raw: src.slice(start, i), escaped: true, start: start, end: i });
    }

    if (c === 'x') {
      const hex = src.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        i += 3;
        return reg({
          type: 'char',
          ch: String.fromCharCode(parseInt(hex, 16)),
          raw: src.slice(start, i),
          escaped: true,
          start: start,
          end: i,
        });
      }
      i++;
      return reg({ type: 'char', ch: 'x', raw: src.slice(start, i), escaped: true, start: start, end: i });
    }

    if (c === 'u') {
      if (unicode && src[i + 1] === '{') {
        const close = src.indexOf('}', i + 2);
        if (close === -1) fail('Unicode 转义缺少 “}”', start);
        const hex = src.slice(i + 2, close);
        if (!/^[0-9a-fA-F]+$/.test(hex)) fail('Unicode 转义不合法：\\u{' + hex + '}', start);
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) fail('Unicode 码位超出范围：\\u{' + hex + '}', start);
        i = close + 1;
        return reg({
          type: 'char',
          ch: String.fromCodePoint(cp),
          raw: src.slice(start, i),
          escaped: true,
          start: start,
          end: i,
        });
      }
      const hex = src.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        i += 5;
        return reg({
          type: 'char',
          ch: String.fromCharCode(parseInt(hex, 16)),
          raw: src.slice(start, i),
          escaped: true,
          start: start,
          end: i,
        });
      }
      i++;
      return reg({ type: 'char', ch: 'u', raw: src.slice(start, i), escaped: true, start: start, end: i });
    }

    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    return reg({ type: 'char', ch: ch, raw: '\\' + ch, escaped: true, start: start, end: i });
  }

  const ast = parseDisjunction();

  if (i < src.length) {
    if (src[i] === ')') fail('多余的右括号 “)”', i);
    fail('无法解析的内容', i);
  }

  // 组号超出捕获组数量的十进制转义、引用不存在的命名组：Angular 引擎会按字面量/八进制处理
  for (const node of nodes) {
    if (node.type !== 'backref') continue;
    if (node.name != null && !named.has(node.name)) node.missing = true;
    if (node.number != null && node.number > captures) node.missing = true;
  }

  const byId = Object.create(null);
  for (const node of nodes) byId[node.id] = node;

  const owners = new Array(src.length).fill(null);
  const innermost = nodes.slice().sort(function (a, b) {
    return (a.end - a.start) - (b.end - b.start);
  });
  for (const node of innermost) {
    for (let p = node.start; p < node.end; p++) {
      if (!owners[p]) owners[p] = node.id;
    }
  }

  return {
    ast: ast,
    nodes: nodes,
    byId: byId,
    owners: owners,
    pattern: src,
    flags: flagStr,
    captures: captures,
    namedGroups: named,
  };
}

/* ============================================================
 * 展示用的小工具
 * ============================================================ */

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function cpLabel(ch) {
  const cp = ch.codePointAt(0);
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

function charWord(ch) {
  if (ch == null) return '';
  if (CHAR_WORDS[ch]) return CHAR_WORDS[ch];
  const cp = ch.codePointAt(0);
  if (cp < 0x20 || cp === 0x7f) return cpLabel(ch);
  return ch;
}

function isVisibleChar(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0);
  return cp > 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f);
}

function showChar(ch) {
  if (ch == null) return '';
  if (ch === ' ') return '空格';
  if (!isVisibleChar(ch)) return charWord(ch);
  return ch;
}

function timesText(min, max) {
  if (min === 0 && max === Infinity) return '重复 0 次或多次';
  if (min === 1 && max === Infinity) return '重复 1 次或多次';
  if (min === 0 && max === 1) return '重复 0 次或 1 次（可有可无）';
  if (max === Infinity) return '至少重复 ' + min + ' 次';
  if (min === max) return '恰好重复 ' + min + ' 次';
  return '重复 ' + min + ' 到 ' + max + ' 次';
}

function quantDesc(n) {
  return timesText(n.min, n.max) + '，' + (n.greedy ? '贪婪（尽量多匹配）' : '懒惰（尽量少匹配）');
}

function describeChar(n, flags) {
  if (n.escaped) {
    let d = '转义字符 ' + n.raw;
    if (n.ch && n.raw !== '\\' + n.ch) {
      if (isVisibleChar(n.ch)) d += '（即 “' + n.ch + '”）';
      else d += '（' + charWord(n.ch) + '，' + cpLabel(n.ch) + '）';
    } else if (n.ch && !isVisibleChar(n.ch)) {
      d += '（' + charWord(n.ch) + '，' + cpLabel(n.ch) + '）';
    }
    return d;
  }
  let d = '字面量 “' + showChar(n.ch) + '”';
  if (flags.indexOf('i') !== -1 && /[A-Za-z]/.test(n.ch)) {
    const other = n.ch === n.ch.toUpperCase() ? n.ch.toLowerCase() : n.ch.toUpperCase();
    d += '；忽略大小写时也匹配 “' + other + '”';
  }
  return d;
}

function classItemText(item) {
  if (item.type === 'range') return showChar(item.from) + '–' + showChar(item.to);
  if (item.type === 'set') return item.raw + ' ' + SET_INFO[item.ch].label;
  if (item.type === 'property') return item.raw;
  if (item.type === 'char') return '“' + showChar(item.ch) + '”';
  return item.raw || '';
}

function classDesc(n) {
  if (!n.items.length) {
    return n.negated ? '排除空集合：匹配任意字符（包括换行）' : '空字符组：不匹配任何字符';
  }
  return (n.negated ? '不匹配其中任一字符：' : '匹配其中任一字符：') +
    n.items.map(classItemText).join('、');
}

function groupInfo(n) {
  switch (n.kind) {
    case 'capture':
      return {
        title: '捕获组 #' + n.index,
        cls: 'g-capture',
        desc: '捕获组：匹配到的内容会被单独记住，可以用 \\' + n.index + ' 反向引用',
      };
    case 'named':
      return {
        title: '命名组 <' + n.name + '>',
        cls: 'g-capture',
        desc: '命名捕获组（第 ' + n.index + ' 组）：匹配内容可通过 <' + n.name + '> 或 \\k<' + n.name + '> 引用',
      };
    case 'noncapture':
      return {
        title: '非捕获组',
        cls: '',
        desc: '只用来把若干元素当成一个整体，不记录匹配内容',
      };
    case 'lookahead':
      return {
        title: '先行断言 · 后面必须匹配',
        cls: 'g-look',
        desc: '正向先行断言：当前位置后面必须能匹配组内表达式，但不消耗字符',
      };
    case 'neg-lookahead':
      return {
        title: '先行断言 · 后面不能匹配',
        cls: 'g-look',
        desc: '负向先行断言：当前位置后面不能匹配组内表达式，不消耗字符',
      };
    case 'lookbehind':
      return {
        title: '后行断言 · 前面必须匹配',
        cls: 'g-look',
        desc: '正向后行断言：当前位置前面必须能匹配组内表达式，不消耗字符',
      };
    case 'neg-lookbehind':
      return {
        title: '后行断言 · 前面不能匹配',
        cls: 'g-look',
        desc: '负向后行断言：当前位置前面不能匹配组内表达式，不消耗字符',
      };
    default:
      return { title: '分组', cls: '', desc: '分组' };
  }
}

function anchorInfo(n, flags) {
  const multiline = flags.indexOf('m') !== -1;
  if (n.kind === '^') {
    return {
      label: multiline ? '行首' : '开头',
      desc: multiline
        ? '行首：匹配字符串开头或任意换行之后的位置（已启用 m 标志）'
        : '字符串开头（未启用 m 标志）',
    };
  }
  return {
    label: multiline ? '行尾' : '结尾',
    desc: multiline
      ? '行尾：匹配字符串结尾或任意换行之前的位置（已启用 m 标志）'
      : '字符串结尾（未启用 m 标志）',
  };
}

/* ============================================================
 * 结构图渲染
 * ============================================================ */

function chip(n, cls, sym, lab, title) {
  return '<span class="node chip ' + cls + '" data-node="' + n.id + '"' +
    (title ? ' title="' + esc(title) + '"' : '') + '>' +
    '<span class="sym">' + esc(sym) + '</span>' +
    (lab ? '<span class="lab">' + esc(lab) + '</span>' : '') +
    '</span>';
}

function renderChar(n, model) {
  const title = describeChar(n, model.flags);
  if (n.escaped) {
    let lab = '';
    if (n.ch && !isVisibleChar(n.ch)) lab = charWord(n.ch);
    else if (n.ch && /^\\[xu]/.test(n.raw)) lab = showChar(n.ch);
    return chip(n, 'esc', n.raw, lab, title);
  }
  if (n.ch === ' ') return chip(n, 'lit word', '空格', '', title);
  if (!isVisibleChar(n.ch)) return chip(n, 'lit word', charWord(n.ch), '', title);
  return chip(n, 'lit', n.ch, '', title);
}

function renderNode(n, model) {
  switch (n.type) {
    case 'alt': {
      const branches = n.branches.map(function (branch, idx) {
        return '<div class="branch"><span class="blabel">' + (idx + 1) + '</span>' +
          '<div class="branch-body">' + renderNode(branch, model) + '</div></div>';
      }).join('');
      return '<div class="node n-alt" data-node="' + n.id + '" title="选择：匹配其中任意一个分支">' +
        '<div class="n-alt-head">选择 · 任一分支</div>' +
        '<div class="branches">' + branches + '</div></div>';
    }

    case 'seq':
      return '<div class="node n-seq" data-node="' + n.id + '" title="按顺序依次匹配">' +
        n.items.map(function (item) { return renderNode(item, model); }).join('') +
        '</div>';

    case 'empty':
      return chip(n, 'empty', '空', '', '空分支：匹配空字符串');

    case 'char':
      return renderChar(n, model);

    case 'dot': {
      const dotAll = model.flags.indexOf('s') !== -1;
      return chip(n, 'dot', '.', '任意字符',
        dotAll ? '任意字符，包括换行（已启用 s 标志）' : '任意字符，不包括换行（未启用 s 标志）');
    }

    case 'set': {
      const info = SET_INFO[n.ch];
      return chip(n, 'set', n.raw, info.label, info.desc);
    }

    case 'property':
      return chip(n, 'set', n.raw, 'Unicode 属性',
        'Unicode 字符属性 ' + n.prop + (n.negated ? '（排除该属性）' : ''));

    case 'class':
      return chip(n, 'cls', n.raw, n.negated ? '排除' : '字符集', classDesc(n));

    case 'anchor': {
      const info = anchorInfo(n, model.flags);
      return chip(n, 'anchor', n.kind, info.label, info.desc);
    }

    case 'assert': {
      const boundary = n.kind === '\\b';
      return chip(n, 'anchor', n.kind, boundary ? '单词边界' : '非单词边界',
        boundary ? '单词边界：一边是单词字符、另一边不是的位置' : '非单词边界：两边同为单词字符或同非单词字符的位置');
    }

    case 'backref': {
      let label;
      let title;
      if (n.name != null) {
        label = '<' + n.name + '>';
        title = '反向引用命名组 <' + n.name + '> 之前匹配到的内容';
        if (n.missing) title += '（当前表达式中没有这个命名组）';
      } else if (n.number != null) {
        label = '组 ' + n.number;
        title = '反向引用第 ' + n.number + ' 个捕获组之前匹配到的内容';
        if (n.missing) title += '（当前表达式没有第 ' + n.number + ' 组）';
      } else {
        label = '引用';
        title = '反向引用';
      }
      return chip(n, 'backref' + (n.missing ? ' warn' : ''), n.raw, label, title);
    }

    case 'group': {
      const info = groupInfo(n);
      return '<div class="node n-group ' + info.cls + '" data-node="' + n.id + '" title="' + esc(info.desc) + '">' +
        '<div class="g-head">' + esc(info.title) + '</div>' +
        '<div class="g-body">' + renderNode(n.body, model) + '</div>' +
        '</div>';
    }

    case 'quant': {
      return '<div class="node q-wrap' + (n.greedy ? '' : ' lazy') + '" data-node="' + n.id +
        '" title="' + esc(quantDesc(n)) + '">' +
        renderNode(n.atom, model) +
        '<span class="q-badge">' + esc(n.symbol) + '</span>' +
        '</div>';
    }

    default:
      return '';
  }
}

function nodeCategory(n) {
  switch (n.type) {
    case 'char': return n.escaped ? 'esc' : 'lit';
    case 'set':
    case 'property':
    case 'backref': return 'esc';
    case 'class': return 'cls';
    case 'dot': return 'dot';
    case 'anchor':
    case 'assert': return 'anchor';
    case 'quant': return 'quant';
    case 'alt': return 'alt';
    default: return 'punct';
  }
}

function renderSource(model) {
  let html = '';
  for (let p = 0; p < model.pattern.length;) {
    const cp = model.pattern.codePointAt(p);
    const ch = String.fromCodePoint(cp);
    const id = model.owners[p];
    const node = id ? model.byId[id] : null;
    const cat = node ? nodeCategory(node) : 'punct';
    html += '<span class="src-ch t-' + cat + '" data-pos="' + p + '"' +
      (id ? ' data-node="' + id + '"' : '') + '>' + esc(ch) + '</span>';
    p += ch.length;
  }
  return html;
}

function renderPlainSource(pattern, errIndex) {
  let html = '';
  for (let p = 0; p < pattern.length;) {
    const cp = pattern.codePointAt(p);
    const ch = String.fromCodePoint(cp);
    const bad = errIndex != null && p <= errIndex && errIndex < p + ch.length;
    html += '<span class="src-ch' + (bad ? ' err-ch' : '') + '">' + esc(ch) + '</span>';
    p += ch.length;
  }
  return html;
}

function renderModel(model) {
  const info = [];
  if (model.captures) info.push('捕获组 ' + model.captures);
  const alts = model.nodes.filter(function (n) { return n.type === 'alt'; }).length;
  if (alts) info.push('选择 ' + alts + ' 处');
  const quants = model.nodes.filter(function (n) { return n.type === 'quant'; }).length;
  if (quants) info.push('量词 ' + quants);
  if (!info.length && !model.pattern) info.push('空表达式');

  return '<div class="viz-card">' +
    '<div class="viz-head">' +
    '<span class="viz-title">结构图</span>' +
    '<span class="viz-sub">悬停结构或原文，互相高亮对应的部分</span>' +
    (info.length ? '<span class="viz-counts">' + esc(info.join(' · ')) + '</span>' : '') +
    '</div>' +
    '<div class="src" id="src-line">' + renderSource(model) + '</div>' +
    '<div class="tree">' + renderNode(model.ast, model) + '</div>' +
    '</div>';
}

function renderError(pattern, err) {
  const index = typeof err.index === 'number' ? err.index : null;
  const hasPos = index != null && index < pattern.length;
  return '<div class="viz-card">' +
    '<div class="viz-head"><span class="viz-title">表达式无效</span></div>' +
    '<div class="src">' + renderPlainSource(pattern, hasPos ? index : null) + '</div>' +
    '<div class="err-msg">' + esc(err.message) +
    (hasPos ? '<span class="err-pos">（第 ' + (index + 1) + ' 个字符附近）</span>' : '') +
    '</div>' +
    '</div>';
}

function renderFallback(pattern) {
  return '<div class="viz-card">' +
    '<div class="viz-head"><span class="viz-title">结构图</span></div>' +
    '<div class="src">' + renderPlainSource(pattern, null) + '</div>' +
    '<div class="err-note">这个写法超出了本工具的结构解析范围，先按原文显示；下方的匹配测试不受影响。</div>' +
    '</div>';
}

/* ============================================================
 * 匹配（会被序列化进 Worker，不能引用外部变量）
 * ============================================================ */

function matchText(pattern, flags, text, limit) {
  var re = new RegExp(pattern, flags);
  var matches = [];
  var truncated = false;
  var m;

  while ((m = re.exec(text)) !== null) {
    if (matches.length >= limit) {
      truncated = true;
      break;
    }

    var groups = [];
    for (var g = 1; g < m.length; g++) {
      groups.push(m[g] === undefined ? null : m[g]);
    }

    var named = null;
    if (m.groups) {
      named = [];
      for (var key in m.groups) {
        if (Object.prototype.hasOwnProperty.call(m.groups, key)) {
          named.push([key, m.groups[key] === undefined ? null : m.groups[key]]);
        }
      }
    }

    matches.push({
      index: m.index,
      end: m.index + m[0].length,
      text: m[0],
      groups: groups,
      named: named,
    });

    if (!re.global) break;
    if (m[0] === '') {
      if (re.lastIndex >= text.length) break;
      re.lastIndex++;
    }
  }

  return { matches: matches, truncated: truncated };
}

// 嵌套量词/分支被再次量词修饰时，主线程直接跑可能指数级回溯
function subtreeRepeatable(n) {
  if (!n) return false;
  if (n.type === 'quant') return true;
  if (n.type === 'alt' && n.branches.length > 1) return true;
  if (n.type === 'seq') return n.items.some(subtreeRepeatable);
  if (n.type === 'group') return subtreeRepeatable(n.body);
  return false;
}

function riskyPattern(model) {
  if (!model) return false;
  return model.nodes.some(function (n) {
    if (n.type !== 'quant') return false;
    if (n.max <= 1) return false;
    return subtreeRepeatable(n.atom);
  });
}

/* ============================================================
 * 页面
 * ============================================================ */

const EXAMPLE_PATTERN = '(\\w+)@(\\w+\\.\\w{2,})';
const EXAMPLE_SUBJECT = '联系 alice@example.com 或 bob@test.cn，无效地址：not-an-email';

const MAX_PATTERN = 2000;
const MAX_SUBJECT = 2000;
const MAX_MATCHES = 500;
const MAX_MATCH_ROWS = 200;
const MATCH_TIMEOUT = 1000;

function buildWorkerSource() {
  return 'self.onmessage = function (e) {\n' +
    '  var d = e.data;\n' +
    '  var res;\n' +
    '  try {\n' +
    '    res = { seq: d.seq, result: (' + matchText.toString() + ')(d.pattern, d.flags, d.text, d.limit) };\n' +
    '  } catch (err) {\n' +
    '    res = { seq: d.seq, error: String(err && err.message ? err.message : err) };\n' +
    '  }\n' +
    '  self.postMessage(res);\n' +
    '};';
}

function initRegexViz() {
  const patternEl = document.getElementById('pattern');
  const flagEl = document.getElementById('flag-text');
  const vizEl = document.getElementById('viz');
  const statEl = document.getElementById('stat');
  const subjectEl = document.getElementById('subject');
  const matchViewEl = document.getElementById('match-view');
  const matchListEl = document.getElementById('match-list');
  const matchStatEl = document.getElementById('match-stat');
  const inputs = {
    i: document.getElementById('f-i'),
    g: document.getElementById('f-g'),
    m: document.getElementById('f-m'),
    s: document.getElementById('f-s'),
    u: document.getElementById('f-u'),
  };

  const state = {
    pattern: '',
    flags: '',
    valid: false,
    model: null,
    activeId: null,
    activeEl: null,
    sourceSpans: [],
    nodeEls: Object.create(null),
    runTimer: 0,
    matchSeq: 0,
    matchTimer: 0,
    worker: null,
    workerBroken: false,
    workerPending: false,
    workerTimer: 0,
    payload: null,
    lastText: '',
  };

  function currentFlags() {
    return (inputs.g.checked ? 'g' : '') +
      (inputs.i.checked ? 'i' : '') +
      (inputs.m.checked ? 'm' : '') +
      (inputs.s.checked ? 's' : '') +
      (inputs.u.checked ? 'u' : '');
  }

  function setStatus(text, isError) {
    statEl.textContent = text || '';
    statEl.classList.toggle('err', !!isError);
  }

  function setMatchStat(text, isWarn) {
    matchStatEl.textContent = text || '';
    matchStatEl.classList.toggle('warn', !!isWarn);
  }

  /* -------- 悬停联动 -------- */

  function activate(id) {
    if (state.activeId === id) return;
    state.activeId = id;

    if (state.activeEl) {
      state.activeEl.classList.remove('active');
      state.activeEl = null;
    }
    for (const span of state.sourceSpans) span.el.classList.remove('hl');

    if (!id) return;

    const el = state.nodeEls[id];
    if (el) {
      el.classList.add('active');
      state.activeEl = el;
    }

    const node = state.model && state.model.byId[id];
    if (!node) return;
    for (const span of state.sourceSpans) {
      if (span.pos >= node.start && span.pos < node.end) span.el.classList.add('hl');
    }
  }

  function bindViz(model) {
    state.nodeEls = Object.create(null);
    state.sourceSpans = [];
    if (!model) return;

    vizEl.querySelectorAll('.node[data-node]').forEach(function (el) {
      state.nodeEls[el.dataset.node] = el;
    });
    vizEl.querySelectorAll('.src-ch').forEach(function (el) {
      state.sourceSpans.push({ el: el, pos: Number(el.dataset.pos), id: el.dataset.node || null });
    });
    state.model = model;
  }

  vizEl.addEventListener('mouseover', function (e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const srcCh = target.closest('.src-ch');
    if (srcCh && srcCh.dataset.node) {
      activate(srcCh.dataset.node);
      return;
    }
    const nodeEl = target.closest('.node[data-node]');
    if (nodeEl) activate(nodeEl.dataset.node);
  });

  vizEl.addEventListener('mouseleave', function () {
    activate(null);
  });

  /* -------- 主渲染 -------- */

  function run() {
    clearTimeout(state.runTimer);
    activate(null);

    const pattern = patternEl.value;
    const flags = currentFlags();
    state.pattern = pattern;
    state.flags = flags;
    state.valid = false;
    state.model = null;
    flagEl.textContent = flags;

    if (!pattern) {
      vizEl.innerHTML = '<div class="viz-empty">输入正则表达式后，这里会生成结构图。</div>';
      setStatus('');
      cancelMatch();
      clearMatch();
      return;
    }

    if (pattern.length > MAX_PATTERN) {
      vizEl.innerHTML = '<div class="viz-empty">表达式超过 ' + MAX_PATTERN + ' 个字符，暂不生成结构图。</div>';
      setStatus('表达式过长', true);
      cancelMatch();
      clearMatch();
      return;
    }

    let nativeError = null;
    try {
      new RegExp(pattern, flags);
    } catch (err) {
      nativeError = err;
    }

    if (nativeError) {
      let friendly = null;
      try {
        parseRegex(pattern, flags);
      } catch (err) {
        friendly = err;
      }
      const shown = friendly || { message: nativeError.message, index: null };
      vizEl.innerHTML = renderError(pattern, shown);
      bindViz(null);
      setStatus('表达式无效', true);
      cancelMatch();
      clearMatch('表达式无效，无法匹配');
      return;
    }

    let model = null;
    try {
      model = parseRegex(pattern, flags);
    } catch (err) {
      model = null;
    }

    if (!model) {
      vizEl.innerHTML = renderFallback(pattern);
      bindViz(null);
      setStatus('结构解析失败', true);
    } else {
      vizEl.innerHTML = renderModel(model);
      bindViz(model);
      const info = [];
      if (model.captures) info.push('捕获组 ' + model.captures);
      const alts = model.nodes.filter(function (n) { return n.type === 'alt'; }).length;
      if (alts) info.push('选择 ' + alts + ' 处');
      const quants = model.nodes.filter(function (n) { return n.type === 'quant'; }).length;
      if (quants) info.push('量词 ' + quants);
      setStatus(info.join(' · '));
    }

    state.valid = true;
    scheduleMatch();
  }

  /* -------- 匹配测试 -------- */

  function scheduleMatch() {
    clearTimeout(state.matchTimer);
    const seq = ++state.matchSeq;
    state.matchTimer = setTimeout(function () { doMatch(seq); }, 160);
  }

  function cancelMatch() {
    clearTimeout(state.matchTimer);
    clearTimeout(state.workerTimer);
    state.matchSeq++;
    if (state.workerPending && state.worker) {
      try { state.worker.terminate(); } catch (err) { /* 忽略 */ }
      state.worker = null;
      state.workerPending = false;
    }
  }

  function clearMatch(message) {
    clearTimeout(state.workerTimer);
    if (state.workerPending && state.worker) {
      try { state.worker.terminate(); } catch (err) { /* 忽略 */ }
      state.worker = null;
      state.workerPending = false;
    }
    matchViewEl.hidden = true;
    matchViewEl.innerHTML = '';
    matchListEl.innerHTML = '';
    setMatchStat(message || '');
  }

  function ensureWorker() {
    if (state.worker) return state.worker;
    if (state.workerBroken) return null;

    try {
      // Blob URL 不释放：Worker 脚本可能还在加载，提前 revoke 会让它抓不到脚本。
      // 每个页面生命周期内创建的 Worker 很少，这点占用可以忽略。
      const url = URL.createObjectURL(new Blob([buildWorkerSource()], { type: 'text/javascript' }));
      const worker = new Worker(url);

      worker.onmessage = function (e) {
        const data = e.data || {};
        clearTimeout(state.workerTimer);
        state.workerPending = false;
        if (data.seq !== state.matchSeq) return;
        if (data.error) {
          renderMatchError(data.error);
          return;
        }
        renderMatchResult(state.lastText, data.result);
      };

      worker.onerror = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        clearTimeout(state.workerTimer);
        state.workerPending = false;
        state.workerBroken = true;
        try { worker.terminate(); } catch (err) { /* 忽略 */ }
        if (state.worker === worker) state.worker = null;
        // file:// 等环境无法创建 Worker，退回主线程（带风险检查）
        if (state.payload) runSync(state.payload);
      };

      state.worker = worker;
      state.workerPending = false;
      return worker;
    } catch (err) {
      state.workerBroken = true;
      return null;
    }
  }

  function doMatch(seq) {
    if (seq !== state.matchSeq) return;
    if (!state.valid || !state.pattern) return;

    const full = subjectEl.value;
    if (!full) {
      clearMatch('');
      return;
    }

    const text = full.slice(0, MAX_SUBJECT);
    state.lastText = text;
    state.payload = {
      seq: seq,
      pattern: state.pattern,
      flags: state.flags,
      text: text,
      limit: MAX_MATCHES,
    };

    if (state.workerBroken) {
      runSync(state.payload);
      return;
    }

    if (state.workerPending && state.worker) {
      try { state.worker.terminate(); } catch (err) { /* 忽略 */ }
      state.worker = null;
      state.workerPending = false;
    }
    clearTimeout(state.workerTimer);

    const worker = ensureWorker();
    if (!worker) {
      runSync(state.payload);
      return;
    }

    state.workerPending = true;
    state.workerTimer = setTimeout(function () {
      if (seq !== state.matchSeq) return;
      try { worker.terminate(); } catch (err) { /* 忽略 */ }
      if (state.worker === worker) state.worker = null;
      state.workerPending = false;
      renderTimeout(text);
    }, MATCH_TIMEOUT);

    try {
      worker.postMessage(state.payload);
    } catch (err) {
      clearTimeout(state.workerTimer);
      state.workerPending = false;
      state.workerBroken = true;
      runSync(state.payload);
    }
  }

  function runSync(payload) {
    if (!payload || payload.seq !== state.matchSeq) return;
    if (riskyPattern(state.model)) {
      matchViewEl.hidden = true;
      matchViewEl.innerHTML = '';
      matchListEl.innerHTML = '';
      setMatchStat('表达式含嵌套量词，可能发生灾难性回溯；当前环境不支持 Worker 超时保护，已跳过匹配。', true);
      return;
    }
    try {
      const result = matchText(payload.pattern, payload.flags, payload.text, payload.limit);
      renderMatchResult(payload.text, result);
    } catch (err) {
      renderMatchError(err && err.message ? err.message : String(err));
    }
  }

  function previewText(text, limit) {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + '…';
  }

  function renderMatchResult(text, result) {
    const matches = result.matches || [];
    const plain = esc(text);

    if (!matches.length) {
      matchViewEl.innerHTML = plain;
      matchViewEl.hidden = false;
      matchListEl.innerHTML = '';
      const notes = ['没有匹配'];
      if (subjectEl.value.length > text.length) notes.push('文本仅取前 ' + MAX_SUBJECT + ' 字符');
      setMatchStat(notes.join(' · '));
      return;
    }

    let view = '';
    let pos = 0;
    matches.forEach(function (m, idx) {
      const start = Math.max(pos, m.index);
      view += esc(text.slice(pos, start));
      if (m.end > start) {
        view += '<mark class="' + (idx % 2 ? 'alt' : '') + '">' + esc(text.slice(start, m.end)) + '</mark>';
      } else {
        view += '<mark class="zero" title="空匹配"></mark>';
      }
      pos = Math.max(pos, m.end);
    });
    view += esc(text.slice(pos));
    matchViewEl.innerHTML = view;
    matchViewEl.hidden = false;

    const shown = matches.slice(0, MAX_MATCH_ROWS);
    let list = '';
    shown.forEach(function (m, idx) {
      list += '<div class="match">' +
        '<div class="match-head">' +
        '<span class="mnum">#' + (idx + 1) + '</span>' +
        '<span class="mpos">[' + m.index + ', ' + m.end + ')</span>' +
        '<span class="mtext" title="' + esc(m.text) + '">' + esc(previewText(m.text, 160)) + '</span>' +
        '</div>';

      if (m.groups && m.groups.length) {
        list += '<div class="match-groups">';
        m.groups.forEach(function (value, gi) {
          const text = value == null ? '（未参与匹配）' : previewText(value, 160);
          list += '<div class="match-group">' +
            '<span class="gname">组 ' + (gi + 1) + '</span>' +
            '<span class="gval">' + esc(text) + '</span>' +
            '</div>';
        });
        if (m.named) {
          m.named.forEach(function (pair) {
            const value = pair[1] == null ? '（未参与匹配）' : previewText(pair[1], 160);
            list += '<div class="match-group">' +
              '<span class="gname">&lt;' + esc(pair[0]) + '&gt;</span>' +
              '<span class="gval">' + esc(value) + '</span>' +
              '</div>';
          });
        }
        list += '</div>';
      }

      list += '</div>';
    });

    if (matches.length > shown.length) {
      list += '<div class="no-match">还有 ' + (matches.length - shown.length) + ' 个匹配未列出</div>';
    }
    matchListEl.innerHTML = list;

    const notes = [matches.length + ' 个匹配'];
    if (result.truncated) notes.push('仅显示前 ' + MAX_MATCHES + ' 个');
    if (subjectEl.value.length > text.length) notes.push('文本仅取前 ' + MAX_SUBJECT + ' 字符');
    setMatchStat(notes.join(' · '));
  }

  function renderMatchError(message) {
    matchViewEl.hidden = true;
    matchViewEl.innerHTML = '';
    matchListEl.innerHTML = '';
    setMatchStat('匹配失败：' + message, true);
  }

  function renderTimeout(text) {
    matchViewEl.innerHTML = esc(text);
    matchViewEl.hidden = false;
    matchListEl.innerHTML = '';
    setMatchStat('匹配超时，已中止（表达式可能发生了灾难性回溯）', true);
  }

  /* -------- 事件 -------- */

  patternEl.addEventListener('input', function () {
    clearTimeout(state.runTimer);
    state.runTimer = setTimeout(run, 90);
  });

  for (const key of ['i', 'g', 'm', 's', 'u']) {
    inputs[key].addEventListener('change', run);
  }

  subjectEl.addEventListener('input', function () {
    if (state.valid) scheduleMatch();
  });

  document.getElementById('btn-example').addEventListener('click', function () {
    patternEl.value = EXAMPLE_PATTERN;
    subjectEl.value = EXAMPLE_SUBJECT;
    inputs.i.checked = false;
    inputs.g.checked = true;
    inputs.m.checked = false;
    inputs.s.checked = false;
    inputs.u.checked = false;
    run();
    patternEl.focus();
  });

  document.getElementById('btn-clear').addEventListener('click', function () {
    patternEl.value = '';
    subjectEl.value = '';
    inputs.i.checked = false;
    inputs.g.checked = true;
    inputs.m.checked = false;
    inputs.s.checked = false;
    inputs.u.checked = false;
    run();
    patternEl.focus();
  });

  // 粘贴 /pattern/flags 时自动拆出表达式和标志
  patternEl.addEventListener('paste', function (e) {
    const clip = e.clipboardData && e.clipboardData.getData('text');
    if (!clip) return;
    const literal = splitRegexLiteral(clip.trim());
    if (!literal) return;

    e.preventDefault();
    patternEl.value = literal.pattern;
    inputs.i.checked = literal.flags.indexOf('i') !== -1;
    inputs.g.checked = literal.flags.indexOf('g') !== -1;
    inputs.m.checked = literal.flags.indexOf('m') !== -1;
    inputs.s.checked = literal.flags.indexOf('s') !== -1;
    inputs.u.checked = literal.flags.indexOf('u') !== -1;
    run();
  });

  /* -------- 初始状态 -------- */

  patternEl.value = EXAMPLE_PATTERN;
  subjectEl.value = EXAMPLE_SUBJECT;
  inputs.g.checked = true;
  run();
}

function splitRegexLiteral(text) {
  if (!text || text.length < 2 || text[0] !== '/') return null;
  if (/[\r\n]/.test(text)) return null;
  const end = text.lastIndexOf('/');
  if (end <= 0) return null;
  const flags = text.slice(end + 1);
  // 只识别本页支持的标志；其它标志（y、d、v）保留原文，避免静默改变语义
  if (!/^[gimsu]*$/.test(flags)) return null;
  return { pattern: text.slice(1, end), flags: flags };
}

/* ---------------- 导出 ---------------- */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RegexSyntaxError,
    parseRegex,
    renderModel,
    renderError,
    renderFallback,
    matchText,
    riskyPattern,
    splitRegexLiteral,
    timesText,
  };
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initRegexViz);
}
