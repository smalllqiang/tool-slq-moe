'use strict';

/* ---------------- 随机源 ---------------- */

const TWO32 = 0x100000000;          // 2^32
const TWO53 = 9007199254740992;     // 2^53
const MAX_COUNT = 10000;
const MAX_DECIMALS = 10;
const MAX_RANGE = TWO53;            // 整数刻度最多覆盖 2^53 个值

// 优先用浏览器的 Web Crypto；不可用时退回 Math.random（会在页面上标注）。
const webCrypto = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
const secureSource = !!(webCrypto && typeof webCrypto.getRandomValues === 'function');
const RANDOM_SOURCE = secureSource ? 'Web Crypto' : 'Math.random';

let uint32Buf = null;

function randomUint32() {
  if (secureSource) {
    if (!uint32Buf) uint32Buf = new Uint32Array(1);
    webCrypto.getRandomValues(uint32Buf);
    return uint32Buf[0];
  }
  return Math.floor(Math.random() * TWO32) >>> 0;
}

// 53 位随机整数：高 21 位 + 低 32 位，正好覆盖 [0, 2^53)
function random53() {
  return (randomUint32() >>> 11) * TWO32 + randomUint32();
}

// 无偏的 randBelow：取 n 所需的位数 k，生成均匀的 k 位整数，落在 [n, 2^k) 就重抽。
// 直接用 x % n 会让较小的余数出现得更频繁，值域大时偏差不容忽视。
function randBelow(n) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_RANGE) {
    throw new RangeError('随机范围必须是 1 到 2^53 之间的整数');
  }
  if (n === 1) return 0;

  let bits = 0;
  let cap = 1;
  while (cap < n) { cap *= 2; bits++; }

  let x;
  do {
    // bits <= 32 时直接取 32 位随机数的高位；更大的范围用 53 位随机数取模 2^k。
    x = bits <= 32 ? (randomUint32() >>> (32 - bits)) : (random53() % cap);
  } while (x >= n);
  return x;
}

/* ---------------- 采样 ---------------- */

// Floyd 无放回抽样：从 [0, range) 里均匀取出 count 个互不相同的整数。
// 只花 O(count) 次随机和 O(count) 个 Set 元素，不需要按 range 开数组。
function sampleUniqueTicks(minTick, maxTick, count) {
  const range = maxTick - minTick + 1;
  if (count > range) {
    throw new RangeError('范围内只有 ' + range + ' 个可选值，无法生成 ' + count + ' 个不重复的数');
  }
  const chosen = new Set();
  for (let j = range - count; j < range; j++) {
    const t = randBelow(j + 1);
    chosen.add(chosen.has(t) ? j : t);
  }
  const ticks = [];
  for (const t of chosen) ticks.push(minTick + t);
  return ticks;
}

function generateTicks(minTick, maxTick, count, unique) {
  if (!unique) {
    const range = maxTick - minTick + 1;
    const ticks = new Array(count);
    for (let i = 0; i < count; i++) ticks[i] = minTick + randBelow(range);
    return ticks;
  }
  return sampleUniqueTicks(minTick, maxTick, count);
}

// Floyd 只保证抽出的集合均匀，插入顺序并不是均匀排列（抽满整个范围时甚至从最小值开始），
// 所以未选择排序时再洗一次牌。Fisher–Yates 的每一步都用 randBelow 取无偏下标。
function shuffleTicks(ticks) {
  for (let i = ticks.length - 1; i > 0; i--) {
    const j = randBelow(i + 1);
    const t = ticks[i];
    ticks[i] = ticks[j];
    ticks[j] = t;
  }
  return ticks;
}

/* ---------------- 数值处理 ---------------- */

function toNumber(value, label) {
  if (value === null || value === undefined || value === '') {
    throw new RangeError('请填写' + label);
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new RangeError('请填写' + label);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new RangeError(label + '必须是有效数字');
  }
  return n;
}

function formatTick(tick, decimals) {
  if (decimals === 0) return String(tick);
  return (tick / Math.pow(10, decimals)).toFixed(decimals);
}

// 把边界向内取整到指定精度：下界向上取、上界向下取，保证输出不会越界。
// 先看 value 四舍五入到该精度后落在哪一侧，再决定要不要挪一个刻度，
// 这样 1.01 这种乘 100 后带浮点误差的边界也不会被错挪到 1.02。
function tickBound(value, factor, decimals, dir) {
  const rounded = Number(value.toFixed(decimals));
  const tick = Math.round(rounded * factor);
  if (rounded === value) return tick;
  if (dir === 'ceil') return rounded < value ? tick + 1 : tick;
  return rounded > value ? tick - 1 : tick;
}

// 生成随机数。所有值先换算成定点整数刻度再采样，
// 这样小数模式也能保证结果落在相同精度的范围内，且每个刻度等概率。
function generateNumbers(options) {
  const opts = options || {};
  const min = toNumber(opts.min, '最小值');
  const max = toNumber(opts.max, '最大值');
  const count = toNumber(opts.count, '数量');
  const decimals = opts.decimals === undefined || opts.decimals === null || opts.decimals === ''
    ? 0
    : toNumber(opts.decimals, '小数位数');
  const unique = !!opts.unique;
  const sort = !!opts.sort;

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError('小数位数必须是 0 到 ' + MAX_DECIMALS + ' 之间的整数');
  }
  if (decimals === 0) {
    if (!Number.isSafeInteger(min)) throw new RangeError('小数位数为 0 时，最小值必须是 2^53 以内的整数');
    if (!Number.isSafeInteger(max)) throw new RangeError('小数位数为 0 时，最大值必须是 2^53 以内的整数');
  }
  if (min > max) throw new RangeError('最小值不能大于最大值');
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new RangeError('数量必须是 1 到 ' + MAX_COUNT + ' 之间的整数');
  }
  if (unique && decimals > 0) {
    throw new RangeError('「不重复」仅支持整数，请把小数位数设为 0');
  }

  const factor = Math.pow(10, decimals);
  const minTick = decimals === 0 ? min : tickBound(min, factor, decimals, 'ceil');
  const maxTick = decimals === 0 ? max : tickBound(max, factor, decimals, 'floor');
  if (!Number.isSafeInteger(minTick) || !Number.isSafeInteger(maxTick)) {
    throw new RangeError('数值范围太大，请缩小范围或减少小数位数');
  }
  if (minTick > maxTick) {
    throw new RangeError('范围内没有符合 ' + decimals + ' 位小数的值，请调整范围或小数位数');
  }

  const span = maxTick - minTick;
  if (span >= MAX_RANGE) {
    throw new RangeError('可选值太多（超过 2^53 个），请缩小范围');
  }
  const range = span + 1;
  if (unique && count > range) {
    throw new RangeError('范围内只有 ' + range + ' 个可选值，无法生成 ' + count + ' 个不重复的数');
  }

  let ticks = generateTicks(minTick, maxTick, count, unique);
  if (sort) ticks = ticks.slice().sort(function (a, b) { return a - b; });
  else if (unique) ticks = shuffleTicks(ticks);

  const values = new Array(ticks.length);
  for (let i = 0; i < ticks.length; i++) values[i] = formatTick(ticks[i], decimals);

  return {
    values: values,
    ticks: ticks,
    count: count,
    decimals: decimals,
    unique: unique,
    sorted: sort,
    minTick: minTick,
    maxTick: maxTick
  };
}

/* ---------------- 页面逻辑 ---------------- */

function initRandom() {
  const form = document.getElementById('form');
  const minEl = document.getElementById('min');
  const maxEl = document.getElementById('max');
  const countEl = document.getElementById('count');
  const decimalsEl = document.getElementById('decimals');
  const uniqueEl = document.getElementById('unique');
  const sortEl = document.getElementById('sort');
  const outEl = document.getElementById('out');
  const statEl = document.getElementById('stat');
  const sourceEl = document.getElementById('source');
  const btnCopy = document.getElementById('btn-copy');
  const btnClear = document.getElementById('btn-clear');

  let copyTimer = 0;

  sourceEl.textContent = '随机源：' + RANDOM_SOURCE;
  sourceEl.classList.toggle('warn', !secureSource);

  function setStatus(text, isError) {
    statEl.textContent = text || '';
    statEl.classList.toggle('err', !!isError);
  }

  function syncDecimals() {
    const p = decimalsEl.value === '' ? 0 : Number(decimalsEl.value);
    const decimalMode = Number.isFinite(p) && p > 0;
    if (decimalMode) uniqueEl.checked = false;
    uniqueEl.disabled = decimalMode;
    uniqueEl.parentElement.classList.toggle('disabled', decimalMode);
    uniqueEl.title = decimalMode ? '小数模式不支持不重复' : '生成的值互不相同';
  }

  function generate() {
    let result;
    try {
      result = generateNumbers({
        min: minEl.value,
        max: maxEl.value,
        count: countEl.value,
        decimals: decimalsEl.value === '' ? 0 : decimalsEl.value,
        unique: uniqueEl.checked,
        sort: sortEl.checked
      });
    } catch (err) {
      setStatus(err && err.message ? err.message : String(err), true);
      return;
    }

    outEl.value = result.values.join('\n');
    btnCopy.disabled = false;
    const rangeText = formatTick(result.minTick, result.decimals) + ' ~ ' + formatTick(result.maxTick, result.decimals);
    const modeText = result.decimals === 0 ? '整数' : result.decimals + ' 位小数';
    setStatus(
      '共 ' + result.values.length + ' 个 · ' + modeText + ' · ' + rangeText +
      (result.unique ? ' · 不重复' : '') +
      (result.sorted ? ' · 已排序' : '')
    );
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

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    generate();
  });

  decimalsEl.addEventListener('input', syncDecimals);

  btnCopy.addEventListener('click', function () {
    if (!outEl.value) return;
    const old = btnCopy.textContent;
    const done = function () {
      clearTimeout(copyTimer);
      btnCopy.textContent = '已复制';
      copyTimer = setTimeout(function () { btnCopy.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(outEl.value).then(done, function () {
        fallbackCopy(outEl.value, done);
      });
    } else {
      fallbackCopy(outEl.value, done);
    }
  });

  btnClear.addEventListener('click', function () {
    outEl.value = '';
    btnCopy.disabled = true;
    setStatus('');
    minEl.focus();
  });

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      generate();
    }
  });

  syncDecimals();
  generate();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    randomUint32,
    random53,
    randBelow,
    sampleUniqueTicks,
    generateNumbers,
    formatTick,
    tickBound,
    MAX_COUNT,
    MAX_DECIMALS,
    RANDOM_SOURCE
  };
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initRandom);
}
