'use strict';

/* ---------------- Myers diff ---------------- */

// a, b: arrays; eq: (x, y) => boolean
// 返回 [{type: 'equal'|'delete'|'insert', ai, bi}]
function myersDiff(a, b, eq) {
  eq = eq || function (x, y) { return x === y; };
  const N = a.length, M = b.length;
  if (N === 0 && M === 0) return [];

  const max = N + M;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace = [];
  let depth = -1;

  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && eq(a[x], b[y])) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) { depth = d; break outer; }
    }
  }

  const ops = [];
  let x = N, y = M;
  for (let d = depth; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ type: 'equal', ai: x, bi: y }); }
    if (x === prevX) { y--; ops.push({ type: 'insert', bi: y }); }
    else { x--; ops.push({ type: 'delete', ai: x }); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ type: 'equal', ai: x, bi: y }); }
  while (x > 0) { x--; ops.push({ type: 'delete', ai: x }); }
  while (y > 0) { y--; ops.push({ type: 'insert', bi: y }); }
  ops.reverse();
  return ops;
}

/* ---------------- 大文本: 内存受控的行差异 ---------------- */

// Myers 需要在每个编辑深度保存一份路径快照: 最坏内存约 (D+1)*(2*(N+M)+1) 个 int。
// 超过预算时改用 anchor 切分 (patience 风格), 把大区间拆成小区间后再精确对比。
const DEFAULT_BUDGET = 16 * 1024 * 1024;
const MAX_SPLIT_DEPTH = 64;

function exactFits(n, m, budget) {
  const max = n + m;
  return max === 0 || (max + 1) * (2 * max + 1) <= budget;
}

function coarseOps(a0, a1, b0, b1) {
  const ops = [];
  for (let i = a0; i < a1; i++) ops.push({ type: 'delete', ai: i });
  for (let j = b0; j < b1; j++) ops.push({ type: 'insert', bi: j });
  return ops;
}

function lisByBi(cands) {
  const tails = [];
  const prev = new Int32Array(cands.length).fill(-1);
  for (let i = 0; i < cands.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cands[tails[mid]].bi < cands[i].bi) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) { out.push(cands[k]); k = prev[k]; }
  out.reverse();
  return out;
}

// 找出两侧都只出现一次的行, 作为切分锚点 (保证不交叉)
function anchorsIn(a, b, a0, a1, b0, b1) {
  const ca = new Map(), cb = new Map();
  for (let i = a0; i < a1; i++) ca.set(a[i], (ca.get(a[i]) || 0) + 1);
  for (let j = b0; j < b1; j++) cb.set(b[j], (cb.get(b[j]) || 0) + 1);
  const posB = new Map();
  for (let j = b0; j < b1; j++) {
    const v = b[j];
    if (cb.get(v) === 1 && ca.get(v) === 1) posB.set(v, j);
  }
  const cands = [];
  for (let i = a0; i < a1; i++) {
    const p = posB.get(a[i]);
    if (p !== undefined) cands.push({ ai: i, bi: p });
  }
  return lisByBi(cands);
}

function diffRange(a, b, a0, a1, b0, b1, depth, budget, out) {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    out.push({ type: 'equal', ai: a0++, bi: b0++ });
  }
  const tail = [];
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) {
    a1--; b1--;
    tail.push({ type: 'equal', ai: a1, bi: b1 });
  }

  const na = a1 - a0, nb = b1 - b0;
  if (na > 0 || nb > 0) {
    if (exactFits(na, nb, budget)) {
      const sub = myersDiff(a.slice(a0, a1), b.slice(b0, b1));
      for (const op of sub) {
        if (op.type === 'delete') out.push({ type: 'delete', ai: op.ai + a0 });
        else if (op.type === 'insert') out.push({ type: 'insert', bi: op.bi + b0 });
        else out.push({ type: 'equal', ai: op.ai + a0, bi: op.bi + b0 });
      }
    } else if (depth >= MAX_SPLIT_DEPTH) {
      for (const op of coarseOps(a0, a1, b0, b1)) out.push(op);
    } else {
      const anchors = anchorsIn(a, b, a0, a1, b0, b1);
      if (anchors.length === 0) {
        for (const op of coarseOps(a0, a1, b0, b1)) out.push(op);
      } else {
        let pa = a0, pb = b0;
        for (const an of anchors) {
          diffRange(a, b, pa, an.ai, pb, an.bi, depth + 1, budget, out);
          out.push({ type: 'equal', ai: an.ai, bi: an.bi });
          pa = an.ai + 1; pb = an.bi + 1;
        }
        diffRange(a, b, pa, a1, pb, b1, depth + 1, budget, out);
      }
    }
  }
  // tail 是从后往前收集的, 需要倒序输出
  for (let i = tail.length - 1; i >= 0; i--) out.push(tail[i]);
}

// 行级差异入口, 结果始终能还原两侧原文, 小文本下为最少编辑数
function diffLines(a, b, budget) {
  const out = [];
  diffRange(a, b, 0, a.length, 0, b.length, 0, budget || DEFAULT_BUDGET, out);
  return out;
}

/* ---------------- 文本切分 ---------------- */

function splitLines(text) {
  if (text === '') return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

// 必须覆盖整行: 三个分支分别是 空白 / 字母数字下划线 / 其它字符。
// 若空白只用 [ \t] 匹配, 像 U+3000(全角空格)、U+00A0(不换行空格) 这类字符会漏掉,
// match() 直接跳过它们, token 长度之和就小于原文长度, 行内高亮的字符偏移会整体左移。
const TOKEN_RE = /(\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_])/g;

function splitTokens(line) {
  const out = line.match(TOKEN_RE);
  if (!out) return [];
  // 兜底: 万一将来正则改动导致漏字符, 退化为逐字符切分, 保证偏移精确
  let total = 0;
  for (const t of out) total += t.length;
  if (total !== line.length) return Array.from(line);
  return out;
}

/* ---------------- 行对齐 ---------------- */

// 相似度阈值: 低于此值的删除行/新增行不会被左右配对
const PAIR_THRESHOLD = 0.2;
// 配对 DP 的规模上限, 超出则退化为按序号配对
const PAIR_CELL_CAP = 40000;

// token 多重集 Dice 系数, 用于判断两行是否"其实是同一行被改过"
function tokenSimilarity(aTokens, bTokens) {
  const la = aTokens.length, lb = bTokens.length;
  if (la === 0 && lb === 0) return 1;
  if (la === 0 || lb === 0) return 0;
  const counts = new Map();
  for (const t of aTokens) counts.set(t, (counts.get(t) || 0) + 1);
  let common = 0;
  for (const t of bTokens) {
    const c = counts.get(t);
    if (c > 0) { counts.set(t, c - 1); common++; }
  }
  return (2 * common) / (la + lb);
}

// 在一个不匹配块内做单调配对: 返回 [{li, ri}], li/ri 为 -1 表示该侧无对应行
function pairBlock(dels, ins, simOf) {
  const d = dels.length, n = ins.length;
  if (d === 0) return ins.map(function (ri) { return { li: -1, ri: ri }; });
  if (n === 0) return dels.map(function (li) { return { li: li, ri: -1 }; });

  if (d * n > PAIR_CELL_CAP) {
    const out = [];
    for (let j = 0; j < Math.max(d, n); j++) {
      out.push({ li: j < d ? dels[j] : -1, ri: j < n ? ins[j] : -1 });
    }
    return out;
  }

  const sim = [];
  for (let i = 0; i < d; i++) {
    const row = new Float64Array(n);
    for (let j = 0; j < n; j++) row[j] = simOf(dels[i], ins[j]);
    sim.push(row);
  }

  // dp[i][j]: 用前 i 个删除行和前 j 个新增行能拿到的最大总分; 未配对记 0 分
  const W = n + 1;
  const dp = new Float64Array((d + 1) * W);
  const score = function (i, j) {
    const s = sim[i - 1][j - 1];
    return s >= PAIR_THRESHOLD ? s + 0.5 : -1;
  };
  for (let i = 1; i <= d; i++) {
    for (let j = 1; j <= n; j++) {
      let best = Math.max(dp[(i - 1) * W + j], dp[i * W + j - 1]);
      const paired = dp[(i - 1) * W + j - 1] + score(i, j);
      if (paired > best) best = paired;
      dp[i * W + j] = best;
    }
  }

  const out = [];
  let i = d, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const paired = dp[(i - 1) * W + j - 1] + score(i, j);
      if (Math.abs(dp[i * W + j] - paired) < 1e-9) {
        out.push({ li: dels[i - 1], ri: ins[j - 1] });
        i--; j--;
        continue;
      }
    }
    // 未配对时优先走新增分支, 反转后即为 "先删后增" 的顺序
    if (j > 0 && dp[i * W + j] === dp[i * W + j - 1]) { out.push({ li: -1, ri: ins[j - 1] }); j--; continue; }
    out.push({ li: dels[i - 1], ri: -1 });
    i--;
  }
  out.reverse();
  return out;
}

// 返回行数据: [{type, ln, rn, text, rtext, marks}]
// type: 'equal' | 'change' | 'delete' | 'insert'
function buildRows(leftLines, rightLines, opts) {
  opts = opts || {};
  const wordDiff = opts.wordDiff !== false;
  const ops = diffLines(leftLines, rightLines, opts.budget);
  const rows = [];
  const tokens = new Map();
  const tokensOf = function (side, idx) {
    const key = side + ':' + idx;
    let t = tokens.get(key);
    if (!t) { t = splitTokens(side === 'l' ? leftLines[idx] : rightLines[idx]); tokens.set(key, t); }
    return t;
  };
  const simOf = function (li, ri) {
    return tokenSimilarity(tokensOf('l', li), tokensOf('r', ri));
  };
  let i = 0;

  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      const op = ops[i++];
      rows.push({ type: 'equal', ln: op.ai + 1, rn: op.bi + 1, text: leftLines[op.ai], rtext: rightLines[op.bi] });
      continue;
    }
    const dels = [], ins = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      const op = ops[i++];
      if (op.type === 'delete') dels.push(op.ai);
      else ins.push(op.bi);
    }
    for (const pair of pairBlock(dels, ins, simOf)) {
      const li = pair.li, ri = pair.ri;
      const row = {
        type: li >= 0 && ri >= 0 ? 'change' : (li >= 0 ? 'delete' : 'insert'),
        ln: li >= 0 ? li + 1 : null,
        rn: ri >= 0 ? ri + 1 : null,
        text: li >= 0 ? leftLines[li] : null,
        rtext: ri >= 0 ? rightLines[ri] : null,
        marks: null
      };
      if (wordDiff && row.type === 'change') {
        row.marks = wordMarks(row.text, row.rtext);
      }
      rows.push(row);
    }
  }
  return rows;
}

// 行内词级差异: 返回 {left: [[start,len], ...], right: [[start,len], ...]}
function wordMarks(left, right) {
  if (left.length + right.length > 20000) return null;
  const lt = splitTokens(left);
  const rt = splitTokens(right);
  const ops = myersDiff(lt, rt);
  // 先按 token 序号标记, 再换算成字符区间
  const lTok = new Array(lt.length).fill(false);
  const rTok = new Array(rt.length).fill(false);
  for (const op of ops) {
    if (op.type === 'delete') lTok[op.ai] = true;
    else if (op.type === 'insert') rTok[op.bi] = true;
  }
  const toRanges = function (tokens, flags) {
    const ranges = [];
    let pos = 0, start = -1;
    for (let k = 0; k < tokens.length; k++) {
      if (flags[k] && start < 0) start = pos;
      if (!flags[k] && start >= 0) { ranges.push([start, pos - start]); start = -1; }
      pos += tokens[k].length;
    }
    if (start >= 0) ranges.push([start, pos - start]);
    return ranges;
  };
  return { left: toRanges(lt, lTok), right: toRanges(rt, rTok) };
}

/* ---------------- 渲染 ---------------- */

function makeCell(cls, text, marks) {
  const el = document.createElement('span');
  el.className = cls;
  if (text === null || text === undefined) return el;
  if (!marks || !marks.length) {
    el.textContent = text;
    return el;
  }
  let pos = 0;
  for (const [start, len] of marks) {
    // 防御: 丢弃越界/重叠/长度为 0 的区间, 保证单元格文本永远不被吞掉或错位
    if (len <= 0 || start < pos || start >= text.length) continue;
    const end = Math.min(start + len, text.length);
    if (start > pos) el.appendChild(document.createTextNode(text.slice(pos, start)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    el.appendChild(mark);
    pos = end;
  }
  if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
  return el;
}

function render(rows, out) {
  out.textContent = '';
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'row ' + row.type;
    const ln = document.createElement('span');
    ln.className = 'ln';
    ln.textContent = row.ln === null ? '' : row.ln;
    const rn = document.createElement('span');
    rn.className = 'ln ln-r';
    rn.textContent = row.rn === null ? '' : row.rn;
    const lc = makeCell('cell c-left', row.text, row.marks && row.marks.left);
    const rc = makeCell('cell c-right', row.rtext, row.marks && row.marks.right);
    div.append(ln, lc, rn, rc);
    frag.appendChild(div);
  }
  out.appendChild(frag);
}

function countChanges(rows) {
  let add = 0, del = 0;
  for (const r of rows) {
    if (r.type === 'insert') add++;
    else if (r.type === 'delete') del++;
    else if (r.type === 'change') { add++; del++; }
  }
  return { add: add, del: del };
}

/* ---------------- 页面逻辑 ---------------- */

function initTextDiff() {
  const left = document.getElementById('left');
  const right = document.getElementById('right');
  const out = document.getElementById('out');
  const stat = document.getElementById('stat');

  function compare() {
    const a = splitLines(left.value);
    const b = splitLines(right.value);
    if (a.length + b.length > 20000) {
      alert('文本太大, 请分批次对比 (单侧最多约 10000 行)');
      return;
    }
    const rows = buildRows(a, b);
    render(rows, out);
    const c = countChanges(rows);
    stat.textContent = '−' + c.del + ' +' + c.add;
  }

  document.getElementById('btn-compare').addEventListener('click', compare);
  document.getElementById('btn-swap').addEventListener('click', function () {
    const t = left.value; left.value = right.value; right.value = t;
    if (out.childNodes.length) compare();
  });
  document.getElementById('btn-clear').addEventListener('click', function () {
    left.value = ''; right.value = ''; out.textContent = ''; stat.textContent = '';
    left.focus();
  });
  for (const ta of [left, right]) {
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); compare(); }
    });
  }
  compare();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { myersDiff, diffLines, splitLines, splitTokens, buildRows, wordMarks, countChanges, pairBlock, tokenSimilarity };
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initTextDiff);
}
