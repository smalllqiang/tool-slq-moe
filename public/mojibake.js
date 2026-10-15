'use strict';

/* ---------------- 编码表 ---------------- */

// id 用于内部逻辑，label 用于界面展示，note 是悬停说明
const ENCODINGS = [
  { id: 'utf-8', label: 'UTF-8', note: '变长（1–4 字节），事实标准的网页编码' },
  { id: 'iso-8859-1', label: 'ISO-8859-1', note: '单字节，0x00–0xFF 与 Unicode 码位一一对应（“按字节看待”）' },
  { id: 'windows-1252', label: 'windows-1252', note: '单字节，0x80–0x9F 段填充了 € – Œ 等符号' },
  { id: 'gbk', label: 'GBK', note: '简体中文，1–2 字节' },
  { id: 'big5', label: 'Big5', note: '繁体中文，1–2 字节' },
  { id: 'shift_jis', label: 'Shift_JIS', note: '日文，1–2 字节' },
  { id: 'euc-kr', label: 'EUC-KR', note: '韩文，1–2 字节' },
  { id: 'unicode', label: 'Unicode', note: '这里指 UTF-16LE，即旧编辑器里的 “UNICODE”' },
];

const ENCODING_IDS = ENCODINGS.map(function (e) { return e.id; });

// 示例：把「你好，世界！」按 UTF-8 写出、再按 GBK 解码得到的乱码
const EXAMPLE = '浣犲ソ锛屼笘鐣岋紒';

// TextDecoder 标签。iso-8859-1 不能直接交给 TextDecoder：按 WHATWG 规范
// "iso-8859-1" 会被当成 windows-1252，于是两者会给出完全相同的结果。
// 这里手工实现真正的 Latin-1，保证 0x00–0xFF ↔ U+0000–U+00FF 一一对应。
const DECODER_LABEL = {
  'utf-8': 'utf-8',
  'windows-1252': 'windows-1252',
  'gbk': 'gbk',
  'big5': 'big5',
  'shift_jis': 'shift_jis',
  'euc-kr': 'euc-kr',
  'unicode': 'utf-16le',
};

const decoders = new Map();

function getDecoder(enc) {
  let d = decoders.get(enc);
  if (!d) {
    d = new TextDecoder(DECODER_LABEL[enc], { fatal: false });
    decoders.set(enc, d);
  }
  return d;
}

/* ---------------- 反查表：字符 → 字节 ---------------- */

// 浏览器只提供 TextEncoder（且只支持 UTF-8），要把字符串编回 GBK / Big5 等
// 只能反查：用解码器遍历所有合法字节序列，建立「码位 → 字节」的字典。
const reverseMaps = new Map();

function buildReverseMap(enc) {
  const map = new Map();

  if (enc === 'iso-8859-1') {
    for (let b = 0; b < 256; b++) map.set(String.fromCharCode(b), [b]);
    return map;
  }

  const dec = getDecoder(enc);
  const buf = new Uint8Array(2);

  // 单字节
  for (let b = 0; b < 256; b++) {
    buf[0] = b;
    const s = dec.decode(buf.subarray(0, 1));
    if (s.length === 1 && s !== '\uFFFD' && !map.has(s)) map.set(s, [b]);
  }

  // 双字节（GBK / Big5 / Shift_JIS / EUC-KR 的双字节段）
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      buf[0] = lead;
      buf[1] = trail;
      const s = dec.decode(buf);
      if (s.length === 1 && s !== '\uFFFD' && !map.has(s)) map.set(s, [lead, trail]);
    }
  }

  return map;
}

function reverseMap(enc) {
  let m = reverseMaps.get(enc);
  if (!m) {
    m = buildReverseMap(enc);
    reverseMaps.set(enc, m);
  }
  return m;
}

/* ---------------- 编码 / 解码 ---------------- */

// 返回 { bytes, unmappable }：unmappable 是目标编码无法表示的字符（按出现顺序，可能重复）
function encodeTo(str, enc) {
  if (enc === 'utf-8') {
    return { bytes: new TextEncoder().encode(str), unmappable: [] };
  }

  if (enc === 'unicode') {
    const bytes = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      bytes[i * 2] = c & 0xff;
      bytes[i * 2 + 1] = c >> 8;
    }
    return { bytes: bytes, unmappable: [] };
  }

  const map = reverseMap(enc);
  const parts = [];
  const unmappable = [];
  let len = 0;

  // 按码位遍历，代理对（emoji 等）不会被拆开
  for (const ch of str) {
    const b = map.get(ch);
    if (b) {
      parts.push(b);
      len += b.length;
    } else {
      unmappable.push(ch);
    }
  }

  const bytes = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) bytes[o++] = p[i];
  }
  return { bytes: bytes, unmappable: unmappable };
}

function decodeFrom(bytes, enc) {
  if (enc === 'iso-8859-1') {
    let s = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return s;
  }
  return getDecoder(enc).decode(bytes);
}

/* ---------------- 乱码恢复 ---------------- */

// 单元格语义：把「现在编码」列还原成字节，再用「原来编码」行解码。
//   原始文字 --原来编码--> 字节 --现在编码（错误地）--> 眼前的乱码
// 于是 乱码 --现在编码--> 字节 --原来编码--> 原始文字
function recoverCell(input, nowEnc, wasEnc) {
  const r = encodeTo(input, nowEnc);
  if (r.unmappable.length) {
    return { available: false, text: '', unmappable: r.unmappable };
  }
  return { available: true, text: decodeFrom(r.bytes, wasEnc), unmappable: [] };
}

// 返回 { cols, rows }：
//   cols: [{ enc, bytes, unmappable }]，列是现在编码（表头）
//   rows: [{ enc, cells: [{ enc, available, text, unmappable }] }]，行是原来编码
function recoverTable(input, encodings) {
  const ids = encodings || ENCODING_IDS;

  // 同一列只编码一次，再分别按各个「原来编码」解码
  const cols = ids.map(function (enc) {
    const r = encodeTo(input, enc);
    return { enc: enc, bytes: r.bytes, unmappable: r.unmappable };
  });

  const rows = ids.map(function (rowEnc) {
    return {
      enc: rowEnc,
      cells: cols.map(function (col) {
        if (col.unmappable.length) {
          return { enc: col.enc, available: false, text: '', unmappable: col.unmappable };
        }
        return {
          enc: col.enc,
          available: true,
          text: decodeFrom(col.bytes, rowEnc),
          unmappable: [],
        };
      }),
    };
  });

  return { cols: cols, rows: rows };
}

function labelOf(id) {
  for (const e of ENCODINGS) {
    if (e.id === id) return e.label;
  }
  return id;
}

function noteOf(id) {
  for (const e of ENCODINGS) {
    if (e.id === id) return e.note;
  }
  return '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ENCODINGS,
    ENCODING_IDS,
    EXAMPLE,
    labelOf,
    noteOf,
    encodeTo,
    decodeFrom,
    recoverCell,
    recoverTable,
  };
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initMojibake);
}

/* ---------------- 页面 ---------------- */

function initMojibake() {
  const input = document.getElementById('input');
  const out = document.getElementById('out');
  const stat = document.getElementById('stat');
  const detail = document.getElementById('detail');
  const detailTitle = document.getElementById('detail-title');
  const detailText = document.getElementById('detail-text');
  const btnCopy = document.getElementById('btn-copy');
  const btnReuse = document.getElementById('btn-reuse');

  const MAX_INPUT = 20000;
  const PREVIEW = 600;

  let current = null; // 最近一次的可点击单元格内容

  function debounce(fn, ms) {
    let t = 0;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  // 把字符显示成「x」U+XXXX；不可见字符只显示码位
  function fmtChar(ch) {
    const cp = ch.codePointAt(0);
    const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
    const visible = cp > 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f);
    return visible ? '「' + ch + '」' + hex : hex;
  }

  function fmtChars(list, limit) {
    const shown = list.slice(0, limit).map(fmtChar).join(' ');
    return shown + (list.length > limit ? ' …' : '');
  }

  // 预览里把不可见控制字符画成 ·，否则乱码格会把表格撑得七零八落。
  // 只影响显示，完整内容（复制、详情）仍是原始字符。
  function visiblePreview(s) {
    return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '·');
  }

  function run() {
    const text = input.value;

    if (!text) {
      out.innerHTML = '';
      out.hidden = true;
      stat.textContent = '';
      hideDetail();
      return;
    }

    if (text.length > MAX_INPUT) {
      stat.textContent = '输入过长，仅处理前 ' + MAX_INPUT + ' 字符';
    }

    const src = text.slice(0, MAX_INPUT);
    const table = recoverTable(src);
    render(table, src, text.length > MAX_INPUT);
  }

  function render(table, src, truncated) {
    const head = ['<table><thead><tr><th class="corner" title="行 = 原来编码（想恢复成的编码），列 = 现在编码（被误用的编码）">原来 ＼ 现在</th>'];
    for (const c of table.cols) {
      head.push('<th title="' + esc(noteOf(c.enc)) + '">' + esc(labelOf(c.enc)) + '</th>');
    }
    head.push('</tr></thead><tbody>');

    const body = [];
    for (const row of table.rows) {
      body.push('<tr><th title="' + esc(noteOf(row.enc)) + '">' + esc(labelOf(row.enc)) + '</th>');
      for (const cell of row.cells) {
        if (!cell.available) {
          const uniq = Array.from(new Set(cell.unmappable));
          const tip = '输入中有 ' + uniq.length + ' 种字符无法用 ' + labelOf(cell.enc) +
            ' 表示：' + fmtChars(uniq, 12);
          body.push('<td class="cell na" data-col="' + esc(cell.enc) + '" data-row="' + esc(row.enc) +
            '" data-available="0" tabindex="0" title="' + esc(tip) + '">不可用</td>');
        } else {
          const same = cell.text === src;
          const clipped = cell.text.length > PREVIEW;
          const preview = clipped ? cell.text.slice(0, PREVIEW) : cell.text;
          body.push('<td class="cell' + (same ? ' same' : '') + '" data-col="' + esc(cell.enc) +
            '" data-row="' + esc(row.enc) + '" data-available="1" tabindex="0">' +
            esc(visiblePreview(preview)) + (clipped ? '<span class="more">…</span>' : '') + '</td>');
        }
      }
      body.push('</tr>');
    }

    out.innerHTML = head.join('') + body.join('') + '</tbody></table>';
    out.hidden = false;

    const usable = table.cols.filter(function (c) {
      return !c.unmappable.length;
    }).length;
    const parts = [src.length + ' 字符', '可用列 ' + usable + '/' + table.cols.length];
    if (truncated) parts.push('超出上限的部分已忽略');
    stat.textContent = parts.join(' · ');

    hideDetail();
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function hideDetail() {
    current = null;
    detail.hidden = true;
    detailText.textContent = '';
    detailTitle.textContent = '';
    syncButtons();
    const sel = out.querySelector('.cell.selected');
    if (sel) sel.classList.remove('selected');
  }

  // 「复制 / 作为输入」只对可用的格子有意义
  function syncButtons() {
    if (btnCopy) btnCopy.disabled = !current;
    if (btnReuse) btnReuse.disabled = !current;
  }

  function cellTextOf(td) {
    // 预览可能被截断，重新完整算一次，避免把省略号复制进去
    const rowEnc = td.dataset.row;
    const colEnc = td.dataset.col;
    const src = input.value.slice(0, MAX_INPUT);
    const r = recoverCell(src, colEnc, rowEnc);
    return r.available ? r.text : '';
  }

  function select(td) {
    const prev = out.querySelector('.cell.selected');
    if (prev && prev !== td) prev.classList.remove('selected');
    td.classList.add('selected');

    if (td.dataset.available !== '1') {
      detailTitle.textContent = '现在编码 ' + labelOf(td.dataset.col) + ' → 原来编码 ' + labelOf(td.dataset.row);
      const src = input.value.slice(0, MAX_INPUT);
      const r = recoverCell(src, td.dataset.col, td.dataset.row);
      const uniq = Array.from(new Set(r.unmappable));
      detailText.textContent = '这一格不成立：若文本原本是按 ' + labelOf(td.dataset.col) +
        ' 解码得到的，就不可能包含下列字符（它们不在 ' + labelOf(td.dataset.col) + ' 里）：\n' +
        fmtChars(uniq, 40);
      current = null;
      syncButtons();
      detail.hidden = false;
      return;
    }

    const text = cellTextOf(td);
    detailTitle.textContent = '现在编码 ' + labelOf(td.dataset.col) + ' → 原来编码 ' + labelOf(td.dataset.row) +
      '（' + text.length + ' 字符）';
    detailText.textContent = text;
    current = { text: text, col: td.dataset.col, row: td.dataset.row };
    syncButtons();
    detail.hidden = false;
  }

  out.addEventListener('click', function (e) {
    const td = e.target.closest('td.cell');
    if (td) select(td);
  });

  out.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('cell')) {
      e.preventDefault();
      select(e.target);
    }
  });

  if (btnCopy) {
    btnCopy.addEventListener('click', function () {
      if (!current) return;
      const done = function () {
        const old = btnCopy.textContent;
        btnCopy.textContent = '已复制';
        setTimeout(function () { btnCopy.textContent = old; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(current.text).then(done, function () { fallbackCopy(current.text, done); });
      } else {
        fallbackCopy(current.text, done);
      }
    });
  }

  if (btnReuse) {
    btnReuse.addEventListener('click', function () {
      if (!current) return;
      input.value = current.text;
      run();
      input.focus();
    });
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (err) { /* 忽略 */ }
    document.body.removeChild(ta);
    done();
  }

  const rerun = debounce(run, 150);
  input.addEventListener('input', rerun);
  input.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  document.getElementById('btn-clear').addEventListener('click', function () {
    input.value = '';
    run();
    input.focus();
  });

  const btnExample = document.getElementById('btn-example');
  if (btnExample) {
    btnExample.addEventListener('click', function () {
      input.value = EXAMPLE;
      run();
      input.focus();
    });
  }

  run();
}
