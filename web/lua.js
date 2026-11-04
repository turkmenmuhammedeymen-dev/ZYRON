/* ZYRON Lua: Lua 5.3'ün büyük bir alt kümesi (kendi yazımız, dış kütüphane yok).
 * Lua kodu JavaScript'e derlenir ve async olarak çalışır; böylece gg.* çağrıları Lua'da "bekleyerek" (senkron gibi) görünür.
 * Farklar: tamsayı/ondalık ayrımı yok (hepsi JS sayısı), 64 bit tamsayı yok (2^53'e kadar kesin), goto yalnızca
 * "döngü gövdesinin sonundaki etikete" (continue deseni), __eq/__gc/__close/ağırlıklı tablolar yok, string.pack yok. */
(function (root) {
'use strict';

class LuaError extends Error { constructor(value) { super(typeof value === 'string' ? value : 'lua error'); this.value = value; } }
class LuaStop extends Error { constructor(m) { super(m || 'Script durduruldu.'); } }
class LuaTable {
  constructor() { this.hash = new Map(); this.arr = []; this.meta = undefined; }
  get(k) {
    if (typeof k === 'number') { const a = this.arr; if (k >= 1 && k <= a.length && Number.isInteger(k)) return a[k - 1]; }
    return this.hash.get(k);
  }
  set(k, v) {
    if (k === undefined || k === null) throw new LuaError('index is nil');
    if (typeof k === 'number') {
      if (Number.isNaN(k)) throw new LuaError('index is NaN');
      const a = this.arr;
      if (Number.isInteger(k) && k >= 1 && k <= a.length + 1) {
        if (k === a.length + 1) {
          if (v === undefined) return;
          a.push(v);
          if (this.hash.size) { let n = a.length + 1; while (this.hash.has(n)) { a.push(this.hash.get(n)); this.hash.delete(n); n++; } }
        } else {
          a[k - 1] = v;
          if (v === undefined) while (a.length && a[a.length - 1] === undefined) a.pop();
        }
        return;
      }
    }
    if (v === undefined) this.hash.delete(k); else this.hash.set(k, v);
  }
  length() { return this.arr.length; }
  keys() {
    const r = [];
    for (let i = 0; i < this.arr.length; i++) if (this.arr[i] !== undefined) r.push(i + 1);
    for (const k of this.hash.keys()) r.push(k);
    return r;
  }
}
class Coroutine { constructor(fn) { this.fn = fn; this.status = 'suspended'; this.started = false; } }

// ---------------------------------------------------------------- sözcük çözümleyici
const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);
function synerr(chunk, line, msg, near) { return new LuaError(chunk + ':' + line + ': ' + msg + (near !== undefined ? ' near ' + near : '')); }

function lex(src, chunk) {
  const toks = []; let i = 0, line = 1; const n = src.length;
  const isAlpha = c => /[A-Za-z_]/.test(c), isDigit = c => c >= '0' && c <= '9', isHex = c => /[0-9a-fA-F]/.test(c);
  function longBracket() { // i, '[' konumunda; seviye döner veya -1
    let j = i + 1, lv = 0; while (src[j] === '=') { lv++; j++; }
    return src[j] === '[' ? lv : -1;
  }
  function readLong(lv) {
    i += lv + 2; if (src[i] === '\r') i++; if (src[i] === '\n') { line++; i++; }
    const close = ']' + '='.repeat(lv) + ']'; const e = src.indexOf(close, i);
    if (e < 0) throw synerr(chunk, line, 'unfinished long string/comment');
    const s = src.slice(i, e); for (const ch of s) if (ch === '\n') line++;
    i = e + close.length; return s;
  }
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      i += 2;
      if (src[i] === '[') { const lv = longBracket(); if (lv >= 0) { readLong(lv); continue; } }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (isAlpha(c)) {
      let j = i + 1; while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j); i = j;
      toks.push(KEYWORDS.has(w) ? { t: w, line } : { t: 'name', v: w, line }); continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
      let j = i, v;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2; let m = '';
        while (j < n && (isHex(src[j]) || src[j] === '.')) { m += src[j]; j++; }
        let exp = 0;
        if (src[j] === 'p' || src[j] === 'P') { let k = j + 1, sg = 1; if (src[k] === '+' || src[k] === '-') { if (src[k] === '-') sg = -1; k++; } let e = ''; while (isDigit(src[k] || '')) { e += src[k]; k++; } exp = sg * Number(e || 0); j = k; }
        const [ip, fp = ''] = m.split('.'); v = (parseInt(ip || '0', 16) + (fp ? parseInt(fp, 16) / Math.pow(16, fp.length) : 0)) * Math.pow(2, exp);
      } else {
        while (j < n && (isDigit(src[j]) || src[j] === '.')) j++;
        if (src[j] === 'e' || src[j] === 'E') { j++; if (src[j] === '+' || src[j] === '-') j++; while (isDigit(src[j] || '')) j++; }
        v = Number(src.slice(i, j)); if (Number.isNaN(v)) throw synerr(chunk, line, 'malformed number', "'" + src.slice(i, j) + "'");
      }
      if (/[A-Za-z_]/.test(src[j] || '')) throw synerr(chunk, line, 'malformed number', "'" + src.slice(i, j + 1) + "'");
      i = j; toks.push({ t: 'number', v, line }); continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= n || src[j] === '\n') throw synerr(chunk, line, 'unfinished string');
        const d = src[j];
        if (d === c) { j++; break; }
        if (d === '\\') {
          j++; const e = src[j];
          const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
          if (e in map) { s += map[e]; if (e === '\n') line++; j++; }
          else if (e === 'x') { s += String.fromCharCode(parseInt(src.substr(j + 1, 2), 16)); j += 3; }
          else if (e === 'z') { j++; while (j < n && /\s/.test(src[j])) { if (src[j] === '\n') line++; j++; } }
          else if (e === 'u' && src[j + 1] === '{') { const k = src.indexOf('}', j); s += String.fromCodePoint(parseInt(src.slice(j + 2, k), 16)); j = k + 1; }
          else if (isDigit(e)) { let k = j, num = ''; while (k < j + 3 && isDigit(src[k])) { num += src[k]; k++; } s += String.fromCharCode(Number(num)); j = k; }
          else throw synerr(chunk, line, 'invalid escape sequence', "'\\" + e + "'");
        } else { s += d; j++; }
      }
      i = j; toks.push({ t: 'string', v: s, line }); continue;
    }
    if (c === '[') { const lv = longBracket(); if (lv >= 0) { const l0 = line; const s = readLong(lv); toks.push({ t: 'string', v: s, line: l0 }); continue; } }
    const three = src.substr(i, 3), two = src.substr(i, 2);
    if (three === '...') { toks.push({ t: '...', line }); i += 3; continue; }
    if (['==', '~=', '<=', '>=', '//', '::', '<<', '>>', '..'].includes(two)) { toks.push({ t: two, line }); i += 2; continue; }
    if ('+-*/%^#&~|<>=(){}[];:,.'.includes(c)) { toks.push({ t: c, line }); i++; continue; }
    throw synerr(chunk, line, 'unexpected symbol', "'" + c + "'");
  }
  toks.push({ t: 'eof', line });
  return toks;
}

// ---------------------------------------------------------------- ayrıştırıcı (AST)
const BINPRI = { 'or': [1, 1], 'and': [2, 2], '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3], '|': [4, 4], '~': [5, 5], '&': [6, 6], '<<': [7, 7], '>>': [7, 7], '..': [9, 8], '+': [10, 10], '-': [10, 10], '*': [11, 11], '/': [11, 11], '//': [11, 11], '%': [11, 11], '^': [14, 13] };
const UNARY_PRI = 12;

function parse(src, chunk) {
  const toks = lex(src, chunk); let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const tdesc = t => t.t === 'eof' ? '<eof>' : t.t === 'name' ? "'" + t.v + "'" : t.t === 'string' ? "'" + t.v + "'" : t.t === 'number' ? "'" + t.v + "'" : "'" + t.t + "'";
  const fail = (msg, t) => { t = t || peek(); throw synerr(chunk, t.line, msg, tdesc(t)); };
  const check = t => peek().t === t;
  const accept = t => { if (peek().t === t) { p++; return true; } return false; };
  const expect = (t, what) => { if (peek().t !== t) fail("'" + (what || t) + "' expected"); return next(); };
  const expectName = () => { if (peek().t !== 'name') fail('<name> expected'); return next().v; };
  const blockEnd = () => ['eof', 'end', 'else', 'elseif', 'until'].includes(peek().t);

  function block() {
    const stmts = [];
    while (!blockEnd()) {
      if (check('return')) { stmts.push(retstat()); break; }
      const s = statement(); if (s) stmts.push(s);
    }
    return stmts;
  }
  function retstat() {
    const line = next().line; let exprs = [];
    if (!blockEnd() && !check(';')) exprs = exprlist();
    accept(';');
    return { k: 'return', exprs, line };
  }
  function statement() {
    const t = peek(), line = t.line;
    switch (t.t) {
      case ';': next(); return null;
      case 'if': {
        next(); const clauses = []; let cond = expr(); expect('then'); clauses.push({ cond, body: block() });
        let orelse = null;
        for (;;) {
          if (accept('elseif')) { cond = expr(); expect('then'); clauses.push({ cond, body: block() }); }
          else if (accept('else')) { orelse = block(); expect('end'); break; }
          else { expect('end'); break; }
        }
        return { k: 'if', clauses, orelse, line };
      }
      case 'while': { next(); const cond = expr(); expect('do'); const body = block(); expect('end'); return { k: 'while', cond, body, line }; }
      case 'do': { next(); const body = block(); expect('end'); return { k: 'do', body, line }; }
      case 'for': {
        next(); const n1 = expectName();
        if (check('=')) {
          next(); const a = expr(); expect(','); const b = expr(); let c = null; if (accept(',')) c = expr();
          expect('do'); const body = block(); expect('end'); return { k: 'fornum', name: n1, a, b, c, body, line };
        }
        const names = [n1]; while (accept(',')) names.push(expectName());
        expect('in'); const exprs = exprlist(); expect('do'); const body = block(); expect('end');
        return { k: 'forin', names, exprs, body, line };
      }
      case 'repeat': { next(); const body = block(); expect('until'); const cond = expr(); return { k: 'repeat', body, cond, line }; }
      case 'function': {
        next(); let target = { k: 'name', name: expectName(), line }; let isMethod = false; let fullname = target.name;
        while (check('.') || check(':')) {
          const sep = next().t; const key = expectName(); fullname += sep + key;
          target = { k: 'index', obj: target, key: { k: 'string', v: key }, line, desc: "field '" + key + "'" };
          if (sep === ':') { isMethod = true; break; }
        }
        const f = funcbody(isMethod, line, fullname);
        return { k: 'assign', targets: [target], exprs: [f], line };
      }
      case 'local': {
        next();
        if (accept('function')) { const name = expectName(); const f = funcbody(false, line, name); return { k: 'localfunc', name, f, line }; }
        const names = [], attribs = [];
        do { names.push(expectName()); if (accept('<')) { attribs.push(expectName()); expect('>'); } } while (accept(','));
        let exprs = []; if (accept('=')) exprs = exprlist();
        return { k: 'local', names, exprs, line };
      }
      case 'return': return retstat();
      case 'break': next(); return { k: 'break', line };
      case 'goto': { next(); return { k: 'goto', name: expectName(), line }; }
      case '::': { next(); const name = expectName(); expect('::'); return { k: 'label', name, line }; }
      default: {
        const e = suffixedexp();
        if (check('=') || check(',')) {
          const targets = [e];
          while (accept(',')) targets.push(suffixedexp());
          expect('=');
          for (const tg of targets) if (tg.k !== 'name' && tg.k !== 'index') fail('syntax error');
          return { k: 'assign', targets, exprs: exprlist(), line };
        }
        if (e.k !== 'call' && e.k !== 'method') fail('syntax error');
        return { k: 'callstat', e, line };
      }
    }
  }
  function exprlist() { const l = [expr()]; while (accept(',')) l.push(expr()); return l; }
  function funcbody(isMethod, line, name) {
    expect('('); const params = isMethod ? ['self'] : []; let vararg = false;
    if (!check(')')) {
      do {
        if (check('...')) { next(); vararg = true; break; }
        params.push(expectName());
      } while (accept(','));
    }
    expect(')'); const body = block(); expect('end');
    return { k: 'function', params, vararg, body, line, name };
  }
  function primaryexp() {
    const t = peek();
    if (t.t === 'name') { next(); return { k: 'name', name: t.v, line: t.line }; }
    if (t.t === '(') { next(); const e = expr(); expect(')'); return { k: 'paren', e, line: t.line }; }
    return fail('unexpected symbol');
  }
  function suffixedexp() {
    let e = primaryexp();
    for (;;) {
      const t = peek();
      if (t.t === '.') { next(); const key = expectName(); e = { k: 'index', obj: e, key: { k: 'string', v: key }, line: t.line, desc: "field '" + key + "'" }; }
      else if (t.t === '[') { next(); const key = expr(); expect(']'); e = { k: 'index', obj: e, key, line: t.line }; }
      else if (t.t === ':') { next(); const name = expectName(); const args = callargs(); e = { k: 'method', obj: e, name, args, line: t.line }; }
      else if (t.t === '(' || t.t === 'string' || t.t === '{') { e = { k: 'call', f: e, args: callargs(), line: t.line }; }
      else return e;
    }
  }
  function callargs() {
    const t = peek();
    if (t.t === 'string') { next(); return [{ k: 'string', v: t.v }]; }
    if (t.t === '{') return [tablecons()];
    if (t.t !== '(') fail('function arguments expected');
    next(); if (accept(')')) return [];
    const l = exprlist(); expect(')'); return l;
  }
  function tablecons() {
    const line = expect('{').line; const items = [];
    while (!check('}')) {
      if (check('[')) { next(); const k = expr(); expect(']'); expect('='); items.push({ key: k, value: expr() }); }
      else if (check('name') && toks[p + 1].t === '=') { const k = next().v; next(); items.push({ key: { k: 'string', v: k }, value: expr() }); }
      else items.push({ value: expr() });
      if (!accept(',') && !accept(';')) break;
    }
    expect('}'); return { k: 'table', items, line };
  }
  function simpleexp() {
    const t = peek();
    switch (t.t) {
      case 'number': next(); return { k: 'number', v: t.v };
      case 'string': next(); return { k: 'string', v: t.v };
      case 'nil': next(); return { k: 'nil' };
      case 'true': next(); return { k: 'true' };
      case 'false': next(); return { k: 'false' };
      case '...': next(); return { k: 'vararg', line: t.line };
      case '{': return tablecons();
      case 'function': { next(); return funcbody(false, t.line, 'anonymous'); }
      default: return suffixedexp();
    }
  }
  function expr(limit = 0) {
    let left; const t = peek();
    if (t.t === 'not' || t.t === '-' || t.t === '#' || t.t === '~') { next(); const operand = expr(UNARY_PRI); left = { k: 'unop', op: t.t, e: operand, line: t.line }; }
    else left = simpleexp();
    for (;;) {
      const op = peek().t; const pri = BINPRI[op];
      if (!pri || pri[0] <= limit) break;
      const line = next().line; const right = expr(pri[1]);
      left = { k: 'binop', op, a: left, b: right, line };
    }
    return left;
  }
  const body = block(); if (!check('eof')) fail("'<eof>' expected");
  return { k: 'function', params: [], vararg: true, body, line: 1, name: 'main chunk' };
}

// ---------------------------------------------------------------- JS üretici
function compile(ast, chunk) {
  let uid = 0;
  const fnStack = [];
  const JS = JSON.stringify;
  function newFn() { return { temps: 0, scope: null, loops: [] }; }
  function pushScope(f) { f.scope = { vars: new Map(), parent: f.scope }; }
  function popScope(f) { f.scope = f.scope.parent; }
  function declare(f, name) { const js = 'v' + (++uid) + '_' + name.replace(/[^A-Za-z0-9_]/g, '_'); f.scope.vars.set(name, js); return js; }
  function lookup(name) {
    for (let k = fnStack.length - 1; k >= 0; k--) for (let s = fnStack[k].scope; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
    return null;
  }
  const cur = () => fnStack[fnStack.length - 1];
  const tmp = () => '$' + (++cur().temps);
  const isMulti = e => e.k === 'call' || e.k === 'method' || e.k === 'vararg';

  // tek değer üreten ifade (JS ifadesi)
  function ex(e) {
    switch (e.k) {
      case 'nil': return 'undefined';
      case 'true': return 'true';
      case 'false': return 'false';
      case 'number': return Number.isFinite(e.v) ? (e.v < 0 ? '(' + e.v + ')' : String(e.v)) : (e.v > 0 ? 'Infinity' : '(-Infinity)');
      case 'string': return JS(e.v);
      case 'vararg': return '($va[0])';
      case 'name': { const js = lookup(e.name); return js || 'G.get(' + JS(e.name) + ')'; }
      case 'paren': return ex(e.e);
      case 'index': return '(await idx(' + ex(e.obj) + ',' + ex(e.key) + ',' + JS(descOf(e.obj)) + '))';
      case 'call': case 'method': return '((' + mex(e) + ')[0])';
      case 'function': return fn(e);
      case 'table': return table(e);
      case 'unop': return unop(e);
      case 'binop': return binop(e);
    }
    throw new Error('bilinmeyen ifade: ' + e.k);
  }
  function descOf(e) {
    if (e.k === 'name') return (lookup(e.name) ? 'local' : 'global') + " '" + e.name + "'";
    if (e.k === 'index' && e.key.k === 'string') return "field '" + e.key.v + "'";
    if (e.k === 'method') return "method '" + e.name + "'";
    return '';
  }
  // çok değerli ifade (JS dizi ifadesi)
  function mex(e) {
    if (e.k === 'call') return 'await call(' + ex(e.f) + ',' + args(e.args) + ',' + JS(descOf(e.f)) + ',' + e.line + ')';
    if (e.k === 'method') return 'await callm(' + ex(e.obj) + ',' + JS(e.name) + ',' + args(e.args) + ',' + e.line + ')';
    if (e.k === 'vararg') return '$va';
    return '[' + ex(e) + ']';
  }
  function args(list) { return list.length === 0 ? '[]' : list.length === 1 && !isMulti(list[0]) ? '[' + ex(list[0]) + ']' : exlist(list); }
  function exlist(list) {
    if (!list.length) return '[]';
    const parts = list.map((e, i) => (i === list.length - 1 && isMulti(e)) ? '...(' + mex(e) + ')' : ex(e));
    return '[' + parts.join(',') + ']';
  }
  function table(e) {
    if (!e.items.length) return 'newtable()';
    const pos = [], keyed = []; let multiLast = null;
    e.items.forEach((it, i) => {
      if (it.key) keyed.push([ex(it.key), ex(it.value)]);
      else if (i === e.items.length - 1 && isMulti(it.value)) multiLast = mex(it.value);
      else pos.push(ex(it.value));
    });
    return 'mktable([' + pos.join(',') + '],[' + keyed.map(k => '[' + k[0] + ',' + k[1] + ']').join(',') + ']' + (multiLast ? ',' + multiLast : '') + ')';
  }
  function unop(e) {
    const a = ex(e.e);
    switch (e.op) {
      case 'not': return '(!truthy(' + a + '))';
      case '-': { const t = tmp(); return '(typeof (' + t + '=' + a + ")==='number'?-" + t + ':await arith("unm",' + t + ',' + t + '))'; }
      case '#': return '(await len(' + a + '))';
      case '~': return '(await arith("bnot",' + a + ',' + a + '))';
    }
  }
  const ARITH = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '^': 'pow', '//': 'idiv', '&': 'band', '|': 'bor', '~': 'bxor', '<<': 'shl', '>>': 'shr' };
  function binop(e) {
    const op = e.op;
    if (op === 'and') { const t = tmp(); return '(truthy(' + t + '=' + ex(e.a) + ')?' + ex(e.b) + ':' + t + ')'; }
    if (op === 'or') { const t = tmp(); return '(truthy(' + t + '=' + ex(e.a) + ')?' + t + ':' + ex(e.b) + ')'; }
    const t1 = tmp(), t2 = tmp(), a = ex(e.a), b = ex(e.b);
    const asg = '(' + t1 + '=' + a + ',' + t2 + '=' + b + ',';
    const bothNum = "typeof " + t1 + "==='number'&&typeof " + t2 + "==='number'";
    if (op === '==') return '(' + a + '===' + b + ')';
    if (op === '~=') return '(' + a + '!==' + b + ')';
    if (op === '+' || op === '-' || op === '*') return asg + '(' + bothNum + '?' + t1 + op + t2 + ':await arith(' + JS(ARITH[op]) + ',' + t1 + ',' + t2 + ')))';
    if (op === '/') return asg + '(' + bothNum + '?' + t1 + '/' + t2 + ':await arith("div",' + t1 + ',' + t2 + ')))';
    if (op in ARITH) return asg + '(await arith(' + JS(ARITH[op]) + ',' + t1 + ',' + t2 + ')))';
    if (op === '..') return asg + "((typeof " + t1 + "==='string'||typeof " + t1 + "==='number')&&(typeof " + t2 + "==='string'||typeof " + t2 + "==='number')?tostr(" + t1 + ')+tostr(' + t2 + '):await concat(' + t1 + ',' + t2 + ')))';
    if (op === '<' || op === '>' || op === '<=' || op === '>=') {
      const jsop = op;
      const slow = op === '<' ? 'await lt(' + t1 + ',' + t2 + ')' : op === '>' ? 'await lt(' + t2 + ',' + t1 + ')' : op === '<=' ? 'await le(' + t1 + ',' + t2 + ')' : 'await le(' + t2 + ',' + t1 + ')';
      return asg + '(' + bothNum + '?' + t1 + jsop + t2 + ':' + slow + '))';
    }
    throw new Error('bilinmeyen işleç ' + op);
  }
  function fn(f) {
    const F = newFn(); fnStack.push(F); pushScope(F);
    const pnames = f.params.map(n => declare(F, n));
    const bodyJs = block(f.body, false);
    popScope(F); fnStack.pop();
    let s = 'async (...$a)=>{';
    if (F.temps) s += 'let ' + Array.from({ length: F.temps }, (_, i) => '$' + (i + 1)).join(',') + ';';
    pnames.forEach((n, i) => { s += 'let ' + n + '=$a[' + i + '];'; });
    s += 'const $va=' + (f.vararg ? '$a.slice(' + f.params.length + ')' : '[]') + ';';
    s += bodyJs + 'return [];}';
    return s;
  }
  function loopTail(body) { // gövdenin sonundaki etiket adları (continue deseni)
    const names = []; for (let i = body.length - 1; i >= 0 && body[i].k === 'label'; i--) names.push(body[i].name); return names;
  }
  function block(stmts, newScope = true) {
    const F = cur(); if (newScope) pushScope(F);
    let s = '';
    for (const st of stmts) s += stmt(st);
    if (newScope) popScope(F);
    return s;
  }
  function loopBody(body, kind) {
    const F = cur(); const labels = loopTail(body); const js = '$L' + (++uid);
    F.loops.push({ labels, js, kind }); const code = block(body); F.loops.pop();
    return { js, code };
  }
  const L = e => 'S.line=' + (e.line || 0) + ';';
  function stmt(st) {
    const F = cur();
    switch (st.k) {
      case 'callstat': return L(st) + mex(st.e) + ';';
      case 'local': {
        const n = st.names.length, es = st.exprs; let pre = '', vals;
        if (es.length === 0) vals = st.names.map(() => 'undefined');
        else if (es.length === 1 && n === 1) vals = [ex(es[0])];
        else if (es.length >= n && !(es.length === n && isMulti(es[n - 1]) && false)) {
          // her ad bir ifade alır; fazlası değerlendirilip atılır
          vals = es.slice(0, n).map(ex); const extra = es.slice(n).map(e => isMulti(e) ? mex(e) : ex(e));
          pre = extra.length ? extra.map(x => x + ';').join('') : '';
          if (es.length === n && isMulti(es[n - 1]) && n === 1) vals = [ex(es[0])];
        } else {
          const t = tmp(); pre = t + '=' + exlist(es) + ';'; vals = st.names.map((_, i) => t + '[' + i + ']');
        }
        const names = st.names.map(nm => declare(F, nm));
        return L(st) + pre + 'let ' + names.map((nm, i) => nm + '=' + vals[i]).join(',') + ';';
      }
      case 'localfunc': { const nm = declare(F, st.name); return L(st) + 'let ' + nm + ';' + nm + '=' + fn(st.f) + ';'; }
      case 'assign': {
        const ts = st.targets, es = st.exprs;
        const assignTo = (tg, v) => {
          if (tg.k === 'name') { const js = lookup(tg.name); return js ? js + '=' + v + ';' : 'G.set(' + JS(tg.name) + ',' + v + ');'; }
          return 'await setidx(' + ex(tg.obj) + ',' + ex(tg.key) + ',' + v + ',' + JS(descOf(tg.obj)) + ');';
        };
        if (ts.length === 1 && es.length === 1) return L(st) + assignTo(ts[0], ex(es[0]));
        const t = tmp();
        let s = L(st) + t + '=' + exlist(es) + ';';
        ts.forEach((tg, i) => { s += assignTo(tg, t + '[' + i + ']'); });
        return s;
      }
      case 'do': return '{' + block(st.body) + '}';
      case 'if': {
        let s = L(st);
        st.clauses.forEach((c, i) => { s += (i ? 'else ' : '') + 'if(truthy(' + ex(c.cond) + ')){' + block(c.body) + '}'; });
        if (st.orelse) s += 'else{' + block(st.orelse) + '}';
        return s;
      }
      case 'while': {
        const lb = loopBody(st.body, 'while');
        return L(st) + lb.js + ':while(truthy(' + ex(st.cond) + ')){await tick();' + lb.code + '}';
      }
      case 'repeat': {
        // until koşulu gövdenin yerel adlarını görebilir
        pushScope(F); F.loops.push({ labels: [], js: '$L' + (++uid), kind: 'repeat' });
        let inner = ''; for (const s2 of st.body) inner += stmt(s2);
        const cond = ex(st.cond); const lp = F.loops.pop(); popScope(F);
        return L(st) + lp.js + ':for(;;){await tick();' + inner + 'if(truthy(' + cond + '))break;}';
      }
      case 'fornum': {
        const a = ex(st.a), b = ex(st.b), c = st.c ? ex(st.c) : '1';
        pushScope(F); const v = declare(F, st.name);
        const lb = loopBody(st.body, 'for'); popScope(F);
        const i = '$i' + (++uid), e = '$e' + uid, s = '$s' + uid;
        return L(st) + '{const ' + s + '=fornum(' + c + ',"step"),' + i + '0=fornum(' + a + ',"initial"),' + e + '=fornum(' + b + ',"limit");' +
          lb.js + ':for(let ' + i + '=' + i + '0;' + s + '>0?' + i + '<=' + e + ':' + i + '>=' + e + ';' + i + '+=' + s + '){await tick();let ' + v + '=' + i + ';' + lb.code + '}}';
      }
      case 'forin': {
        const t = tmp(), r = tmp();
        const list = exlist(st.exprs);
        pushScope(F); const names = st.names.map(n => declare(F, n));
        const lb = loopBody(st.body, 'forin'); popScope(F);
        const id = ++uid;
        return L(st) + t + '=' + list + ';{const $f' + id + '=' + t + '[0],$st' + id + '=' + t + '[1];let $c' + id + '=' + t + '[2];' +
          lb.js + ':for(;;){await tick();' + r + '=await call($f' + id + ',[$st' + id + ',$c' + id + '],"for iterator",' + st.line + ');if(' + r + '[0]===undefined)break;$c' + id + '=' + r + '[0];' +
          'let ' + names.map((nm, i) => nm + '=' + r + '[' + i + ']').join(',') + ';' + lb.code + '}}';
      }
      case 'break': return 'break;';
      case 'return': {
        const es = st.exprs;
        if (es.length === 0) return L(st) + 'return [];';
        if (es.length === 1 && es[0].k === 'paren') return L(st) + 'return [' + ex(es[0]) + '];';
        if (es.length === 1 && isMulti(es[0])) return L(st) + 'return ' + mex(es[0]) + ';';
        return L(st) + 'return ' + exlist(es) + ';';
      }
      case 'goto': {
        const loops = F.loops;
        for (let k = loops.length - 1; k >= 0; k--) {
          if (loops[k].labels.includes(st.name) && loops[k].kind !== 'repeat') return 'continue ' + loops[k].js + ';';
        }
        throw synerr(chunk, st.line, "goto '" + st.name + "' desteklenmiyor (yalnızca döngü gövdesinin sonundaki etikete 'continue' olarak)");
      }
      case 'label': return '';
    }
    throw new Error('bilinmeyen deyim ' + st.k);
  }
  return fn(ast);
}

// ---------------------------------------------------------------- Lua desen eşleştirme (lstrlib)
const L_ESC = '%';
function classMatch(c, cl) {
  const code = c.charCodeAt(0); let res;
  switch (cl.toLowerCase()) {
    case 'a': res = /[A-Za-z]/.test(c); break;
    case 'c': res = code < 32 || code === 127; break;
    case 'd': res = c >= '0' && c <= '9'; break;
    case 'g': res = code > 32 && code < 127; break;
    case 'l': res = c >= 'a' && c <= 'z'; break;
    case 'p': res = /[!-\/:-@\[-`{-~]/.test(c); break;
    case 's': res = c === ' ' || (code >= 9 && code <= 13); break;
    case 'u': res = c >= 'A' && c <= 'Z'; break;
    case 'w': res = /[A-Za-z0-9]/.test(c); break;
    case 'x': res = /[0-9A-Fa-f]/.test(c); break;
    default: return cl === c;
  }
  return cl >= 'A' && cl <= 'Z' ? !res : res;
}
function patMatcher(rtErr) {
  return function match(s, pat, init) {
    const ms = { s, pat, level: 0, cap: [] };
    function classEnd(pi) {
      if (pi >= pat.length) throw rtErr('malformed pattern (ends with \'%\')');
      const c = pat[pi++];
      if (c === L_ESC) { if (pi >= pat.length) throw rtErr("malformed pattern (ends with '%')"); return pi + 1; }
      if (c === '[') {
        if (pat[pi] === '^') pi++;
        do { if (pi >= pat.length) throw rtErr("malformed pattern (missing ']')"); const cc = pat[pi++]; if (cc === L_ESC) pi++; } while (pat[pi] !== ']');
        return pi + 1;
      }
      return pi;
    }
    function matchClass(c, pi, ep) { // pat[pi] tek karakter sınıfı
      const p = pat[pi];
      if (p === '.') return true;
      if (p === L_ESC) return classMatch(c, pat[pi + 1]);
      if (p === '[') return matchBracket(c, pi, ep - 1);
      return p === c;
    }
    function matchBracket(c, pi, ec) {
      let sig = true; pi++;
      if (pat[pi] === '^') { sig = false; pi++; }
      while (pi < ec) {
        if (pat[pi] === L_ESC) { pi++; if (classMatch(c, pat[pi])) return sig; pi++; }
        else if (pat[pi + 1] === '-' && pi + 2 < ec) { if (pat[pi] <= c && c <= pat[pi + 2]) return sig; pi += 3; }
        else { if (pat[pi] === c) return sig; pi++; }
      }
      return !sig;
    }
    function doMatch(si, pi) {
      for (;;) {
        if (pi >= pat.length) return si;
        const pc = pat[pi];
        if (pc === '(') {
          if (pat[pi + 1] === ')') return startCap(si, pi + 2, -2);
          return startCap(si, pi + 1, -1);
        }
        if (pc === ')') return endCap(si, pi + 1);
        if (pc === '$' && pi + 1 === pat.length) return si === s.length ? si : -1;
        if (pc === L_ESC) {
          const nx = pat[pi + 1];
          if (nx === 'b') return matchBalance(si, pi + 2);
          if (nx === 'f') {
            pi += 2; if (pat[pi] !== '[') throw rtErr("missing '[' after '%f' in pattern");
            const ep = classEnd(pi), prev = si === 0 ? '\0' : s[si - 1], curc = si < s.length ? s[si] : '\0';
            if (!matchBracket(prev, pi, ep - 1) && matchBracket(curc, pi, ep - 1)) { pi = ep; continue; }
            return -1;
          }
          if (nx >= '0' && nx <= '9') {
            const l = Number(nx) - 1; if (l < 0 || l >= ms.level || ms.cap[l].len === -1) throw rtErr('invalid capture index %' + (l + 1));
            const cs = s.substr(ms.cap[l].init, ms.cap[l].len);
            if (s.startsWith(cs, si)) { si += cs.length; pi += 2; continue; }
            return -1;
          }
        }
        const ep = classEnd(pi), epc = pat[ep];
        if (epc === '?') {
          if (si < s.length && matchClass(s[si], pi, ep)) { const r = doMatch(si + 1, ep + 1); if (r !== -1) return r; }
          pi = ep + 1; continue;
        }
        if (epc === '+') return si < s.length && matchClass(s[si], pi, ep) ? maxExpand(si + 1, pi, ep) : -1;
        if (epc === '*') return maxExpand(si, pi, ep);
        if (epc === '-') return minExpand(si, pi, ep);
        if (si < s.length && matchClass(s[si], pi, ep)) { si++; pi = ep; continue; }
        return -1;
      }
    }
    function maxExpand(si, pi, ep) {
      let i = 0; while (si + i < s.length && matchClass(s[si + i], pi, ep)) i++;
      while (i >= 0) { const r = doMatch(si + i, ep + 1); if (r !== -1) return r; i--; }
      return -1;
    }
    function minExpand(si, pi, ep) {
      for (;;) {
        const r = doMatch(si, ep + 1); if (r !== -1) return r;
        if (si < s.length && matchClass(s[si], pi, ep)) si++; else return -1;
      }
    }
    function startCap(si, pi, what) {
      ms.cap[ms.level] = { init: si, len: what }; ms.level++;
      const r = doMatch(si, pi); if (r === -1) ms.level--; return r;
    }
    function endCap(si, pi) {
      let l = -1; for (let k = ms.level - 1; k >= 0; k--) if (ms.cap[k].len === -1) { l = k; break; }
      if (l < 0) throw rtErr('invalid pattern capture');
      ms.cap[l].len = si - ms.cap[l].init;
      const r = doMatch(si, pi); if (r === -1) ms.cap[l].len = -1; return r;
    }
    function matchBalance(si, pi) {
      if (pi + 1 >= pat.length) throw rtErr("malformed pattern (missing arguments to '%b')");
      if (si >= s.length || s[si] !== pat[pi]) return -1;
      const b = pat[pi], e = pat[pi + 1]; let cont = 1, i = si + 1;
      while (i < s.length) {
        const c = s[i];
        if (c === e) { if (--cont === 0) return doMatch(i + 1, pi + 2); }
        else if (c === b) cont++;
        i++;
      }
      return -1;
    }
    const anchor = pat[0] === '^';
    return { anchor, run(si) { ms.level = 0; ms.cap = []; const pi0 = anchor ? 1 : 0; const e = doMatch(si, pi0); return e === -1 ? null : { start: si, end: e, caps: getCaps(si, e) }; } };
    function getCaps(si, e) {
      const out = []; const n = ms.level === 0 ? 0 : ms.level;
      for (let k = 0; k < n; k++) {
        const c = ms.cap[k]; if (c.len === -1) throw rtErr('unfinished capture');
        out.push(c.len === -2 ? c.init + 1 : s.substr(c.init, c.len));
      }
      return out;
    }
  };
}

// ---------------------------------------------------------------- çalışma zamanı
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function create(opts = {}) {
  const S = { line: 0, stop: false, chunk: 'script', ticks: 0, current: null };
  const G = new LuaTable();
  const out = opts.print || (() => {});
  let writeBuf = '';
  const fid = new WeakMap(); let fidn = 0x1000;
  const idOf = o => { if (!fid.has(o)) fid.set(o, (fidn += 0x20).toString(16)); return fid.get(o); };

  const rtError = msg => new LuaError(S.chunk + ':' + S.line + ': ' + msg);
  const typeName = v => v === undefined || v === null ? 'nil' : typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : typeof v === 'function' ? 'function' : v instanceof LuaTable ? 'table' : v instanceof Coroutine ? 'thread' : 'userdata';
  const truthy = v => v !== undefined && v !== false && v !== null;
  const norm = r => Array.isArray(r) ? r : r === undefined ? [] : [r];
  const first = r => r[0];
  const newtable = () => new LuaTable();
  function mktable(pos, keyed, multi) {
    const t = new LuaTable();
    const a = multi ? pos.concat(multi) : pos;
    for (let i = 0; i < a.length; i++) if (a[i] !== undefined) t.set(i + 1, a[i]); else if (i < a.length) { /* nil boşluğu */ }
    // nil boşlukları olan dizi için ardışıklık korunur: nil sonrası değerleri hash'e yaz
    if (a.some(v => v === undefined)) { t.arr = []; t.hash.clear(); a.forEach((v, i) => { if (v !== undefined) { if (i === t.arr.length) t.arr.push(v); else t.hash.set(i + 1, v); } }); }
    for (const [k, v] of keyed) { if (k === undefined) throw rtError('table index is nil'); t.set(k, v); }
    return t;
  }
  const stringMeta = new LuaTable();
  const getmeta = v => v instanceof LuaTable ? v.meta : typeof v === 'string' ? stringMeta : undefined;

  const tick = async () => {
    if (S.stop) throw new LuaStop();
    if ((++S.ticks & 1023) === 0) { await new Promise(r => setTimeout(r, 0)); if (S.stop) throw new LuaStop(); }
  };
  async function call(f, a, desc, line) {
    if (line) S.line = line;
    if (typeof f === 'function') return norm(await f(...a));
    if (f instanceof LuaTable && f.meta) { const h = f.meta.get('__call'); if (h !== undefined) return call(h, [f, ...a]); }
    throw rtError('attempt to call a ' + typeName(f) + ' value' + (desc ? ' (' + desc + ')' : ''));
  }
  async function callm(o, name, a, line) {
    if (line) S.line = line;
    const f = await idx(o, name, '');
    if (typeof f !== 'function' && !(f instanceof LuaTable && f.meta && f.meta.get('__call'))) throw rtError('attempt to call a ' + typeName(f) + " value (method '" + name + "')");
    return call(f, [o, ...a]);
  }
  async function idx(o, k, desc) {
    if (o instanceof LuaTable) {
      const v = o.get(k); if (v !== undefined || !o.meta) return v;
      const h = o.meta.get('__index'); if (h === undefined) return undefined;
      if (h instanceof LuaTable) return idx(h, k); return first(await call(h, [o, k]));
    }
    if (typeof o === 'string') return stringMeta.get('__index').get(k);
    throw rtError('attempt to index a ' + typeName(o) + ' value' + (desc ? ' (' + desc + ')' : ''));
  }
  async function setidx(o, k, v, desc) {
    if (o instanceof LuaTable) {
      if (o.meta && o.get(k) === undefined) {
        const h = o.meta.get('__newindex');
        if (h !== undefined) { if (h instanceof LuaTable) return setidx(h, k, v); await call(h, [o, k, v]); return; }
      }
      try { o.set(k, v); } catch (e) { if (e instanceof LuaError && typeof e.value === 'string' && !e.value.startsWith(S.chunk)) throw rtError(e.value); throw e; }
      return;
    }
    throw rtError('attempt to index a ' + typeName(o) + ' value' + (desc ? ' (' + desc + ')' : ''));
  }
  function str2num(s) {
    s = s.trim(); if (!s) return undefined;
    if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(s)) { const neg = s[0] === '-'; const v = parseInt(s.replace(/^[+-]/, ''), 16); return neg ? -v : v; }
    if (/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$/.test(s)) return Number(s);
    if (/^[+-]?(inf|nan)/i.test(s)) return undefined;
    return undefined;
  }
  const tonum = v => typeof v === 'number' ? v : typeof v === 'string' ? str2num(v) : undefined;
  const toint = (v, what) => {
    const n = tonum(v); if (n === undefined) throw rtError('number expected, got ' + typeName(v));
    if (!Number.isFinite(n) || Math.floor(n) !== n) throw rtError('number has no integer representation');
    return BigInt.asIntN(64, BigInt(n));
  };
  const EVENTS = { add: '__add', sub: '__sub', mul: '__mul', div: '__div', mod: '__mod', pow: '__pow', idiv: '__idiv', unm: '__unm', band: '__band', bor: '__bor', bxor: '__bxor', shl: '__shl', shr: '__shr', bnot: '__bnot' };
  async function arith(op, a, b) {
    const x = tonum(a), y = tonum(b);
    if (x !== undefined && y !== undefined) {
      switch (op) {
        case 'add': return x + y; case 'sub': return x - y; case 'mul': return x * y; case 'div': return x / y;
        case 'mod': if (y === 0 && Number.isInteger(x)) throw rtError("attempt to perform 'n%%0'"); if (y === Infinity) return x >= 0 ? x : y; if (y === -Infinity) return x <= 0 ? x : y; return x - Math.floor(x / y) * y;
        case 'pow': return Math.pow(x, y);
        case 'idiv': if (y === 0 && Number.isInteger(x) && Number.isInteger(y)) throw rtError("attempt to perform 'n//0'"); return Math.floor(x / y);
        case 'unm': return -x;
        case 'band': return Number(BigInt.asIntN(64, toint(a) & toint(b)));
        case 'bor': return Number(BigInt.asIntN(64, toint(a) | toint(b)));
        case 'bxor': return Number(BigInt.asIntN(64, toint(a) ^ toint(b)));
        case 'bnot': return Number(BigInt.asIntN(64, ~toint(a)));
        case 'shl': { const s = Number(toint(b)); return s >= 64 || s <= -64 ? 0 : Number(BigInt.asIntN(64, s >= 0 ? toint(a) << BigInt(s) : BigInt.asUintN(64, toint(a)) >> BigInt(-s))); }
        case 'shr': { const s = Number(toint(b)); return s >= 64 || s <= -64 ? 0 : Number(BigInt.asIntN(64, s >= 0 ? BigInt.asUintN(64, toint(a)) >> BigInt(s) : toint(a) << BigInt(-s))); }
      }
    }
    const ev = EVENTS[op];
    for (const v of [a, b]) { const m = getmeta(v); const h = m && m.get(ev); if (h !== undefined) return first(await call(h, [a, b])); }
    const bad = tonum(a) === undefined ? a : b;
    throw rtError('attempt to perform ' + (op.startsWith('b') || op.startsWith('sh') ? 'bitwise operation' : 'arithmetic') + ' on a ' + typeName(bad) + ' value');
  }
  async function concat(a, b) {
    for (const v of [a, b]) { const m = getmeta(v); const h = m && m.get('__concat'); if (h !== undefined && !(typeof a === 'string' || typeof a === 'number') || (h !== undefined && !(typeof b === 'string' || typeof b === 'number'))) return first(await call(h, [a, b])); }
    const bad = (typeof a === 'string' || typeof a === 'number') ? b : a;
    throw rtError('attempt to concatenate a ' + typeName(bad) + ' value');
  }
  async function len(v) {
    if (typeof v === 'string') return v.length;
    if (v instanceof LuaTable) { const h = v.meta && v.meta.get('__len'); if (h !== undefined) return first(await call(h, [v])); return v.length(); }
    throw rtError('attempt to get length of a ' + typeName(v) + ' value');
  }
  async function lt(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a < b;
    if (typeof a === 'string' && typeof b === 'string') return a < b;
    for (const v of [a, b]) { const m = getmeta(v); const h = m && m.get('__lt'); if (h !== undefined) return truthy(first(await call(h, [a, b]))); }
    throw rtError(typeName(a) === typeName(b) ? 'attempt to compare two ' + typeName(a) + ' values' : 'attempt to compare ' + typeName(a) + ' with ' + typeName(b));
  }
  async function le(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a <= b;
    if (typeof a === 'string' && typeof b === 'string') return a <= b;
    for (const v of [a, b]) { const m = getmeta(v); const h = m && m.get('__le'); if (h !== undefined) return truthy(first(await call(h, [a, b]))); }
    for (const v of [a, b]) { const m = getmeta(v); const h = m && m.get('__lt'); if (h !== undefined) return !truthy(first(await call(h, [b, a]))); }
    throw rtError(typeName(a) === typeName(b) ? 'attempt to compare two ' + typeName(a) + ' values' : 'attempt to compare ' + typeName(a) + ' with ' + typeName(b));
  }
  function fmtnum(n) {
    if (Number.isInteger(n)) return Math.abs(n) < 1e15 ? String(n) : n.toExponential().replace(/e\+?/, 'e+').replace(/e\+-/, 'e-');
    if (Number.isNaN(n)) return n < 0 ? '-nan' : 'nan';
    if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf';
    let s = n.toPrecision(14); if (s.includes('e')) { let [m, e] = s.split('e'); if (m.includes('.')) m = m.replace(/0+$/, '').replace(/\.$/, ''); const sign = e[0] === '-' ? '-' : '+'; e = e.replace(/^[+-]/, '').padStart(2, '0'); return m + 'e' + sign + e; }
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  const tostr = v => typeof v === 'string' ? v : typeof v === 'number' ? fmtnum(v) : v === undefined || v === null ? 'nil' : v === true ? 'true' : v === false ? 'false' : typeof v === 'function' ? 'function: 0x' + idOf(v) : v instanceof LuaTable ? 'table: 0x' + idOf(v) : v instanceof Coroutine ? 'thread: 0x' + idOf(v) : String(v);
  async function tostringA(v) {
    const m = getmeta(v);
    if (m && v instanceof LuaTable) { const h = m.get('__tostring'); if (h !== undefined) { const r = first(await call(h, [v])); if (typeof r !== 'string') throw rtError("'__tostring' must return a string"); return r; } const nm = m.get('__name'); if (typeof nm === 'string') return nm + ': 0x' + idOf(v); }
    return tostr(v);
  }
  function fornum(v, what) {
    const n = tonum(v); if (n === undefined) throw rtError("'for' " + what + ' must be a number');
    if (what === 'step' && n === 0) throw rtError("'for' step is zero");
    return n;
  }

  const rt = { G, call, callm, idx, setidx, arith, concat, len, lt, le, truthy, tostr, newtable, mktable, tick, fornum, S };

  // ---- standart kütüphane
  const reg = (t, name, f) => t.set(name, f);
  const lib = (name, obj) => { const t = new LuaTable(); for (const k of Object.keys(obj)) t.set(k, obj[k]); G.set(name, t); return t; };
  const arg = (a, i, fname, type) => {
    const v = a[i];
    if (type === 'table' && !(v instanceof LuaTable)) throw rtError("bad argument #" + (i + 1) + " to '" + fname + "' (table expected, got " + (v === undefined ? 'no value' : typeName(v)) + ')');
    return v;
  };
  const argNum = (a, i, fname, def) => {
    const v = a[i]; if (v === undefined && def !== undefined) return def;
    const n = tonum(v); if (n === undefined) throw rtError("bad argument #" + (i + 1) + " to '" + fname + "' (number expected, got " + (v === undefined ? 'no value' : typeName(v)) + ')');
    return n;
  };
  const argStr = (a, i, fname, def) => {
    const v = a[i]; if (v === undefined && def !== undefined) return def;
    if (typeof v === 'string') return v; if (typeof v === 'number') return fmtnum(v);
    throw rtError("bad argument #" + (i + 1) + " to '" + fname + "' (string expected, got " + (v === undefined ? 'no value' : typeName(v)) + ')');
  };
  const errvalue = e => e instanceof LuaError ? e.value : (e && e.message) || String(e);

  function nextFn(t, k) {
    const keys = t.keys(); let i = 0;
    if (k !== undefined) { i = keys.findIndex(x => x === k); if (i < 0) throw rtError("invalid key to 'next'"); i++; }
    if (i >= keys.length) return [undefined];
    return [keys[i], t.get(keys[i])];
  }
  const base = {
    print: async (...a) => { const parts = []; for (const v of a) parts.push(await tostringA(v)); out(writeBuf + parts.join('\t')); writeBuf = ''; return []; },
    type: (...a) => { if (!a.length) throw rtError("bad argument #1 to 'type' (value expected)"); return [typeName(a[0])]; },
    tostring: async (v) => [await tostringA(v)],
    tonumber: (v, b) => {
      if (b === undefined) return [typeof v === 'number' ? v : typeof v === 'string' ? str2num(v) : undefined];
      const s = String(v).trim().toLowerCase(); const base2 = Number(b); const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base2);
      const neg = s[0] === '-'; const body = neg ? s.slice(1) : s;
      if (!body || [...body].some(c => !digits.includes(c))) return [undefined];
      const r = parseInt(body, base2); return [neg ? -r : r];
    },
    pairs: async (t) => {
      const m = t instanceof LuaTable && t.meta && t.meta.get('__pairs');
      if (m) return (await call(m, [t])).slice(0, 3);
      if (!(t instanceof LuaTable)) throw rtError("bad argument #1 to 'for iterator' (table expected, got " + typeName(t) + ')');
      let keys = t.keys(), i = 0;
      return [(_t, _k) => { while (i < keys.length) { const k = keys[i++]; const v = t.get(k); if (v !== undefined) return [k, v]; } return [undefined]; }, t, undefined];
    },
    ipairs: (t) => {
      if (t === undefined) throw rtError("bad argument #1 to 'ipairs' (table expected, got no value)");
      return [async (tt, i) => { i = i + 1; const v = await idx(tt, i); return v === undefined ? [undefined] : [i, v]; }, t, 0];
    },
    next: (t, k) => nextFn(arg([t], 0, 'next', 'table'), k),
    rawget: (t, k) => [arg([t], 0, 'rawget', 'table').get(k)],
    rawset: (t, k, v) => { arg([t], 0, 'rawset', 'table').set(k, v); return [t]; },
    rawequal: (a, b) => [a === b],
    rawlen: (v) => [typeof v === 'string' ? v.length : arg([v], 0, 'rawlen', 'table').length()],
    setmetatable: (t, m) => { arg([t], 0, 'setmetatable', 'table'); if (m !== undefined && !(m instanceof LuaTable)) throw rtError("bad argument #2 to 'setmetatable' (nil or table expected)"); if (t.meta && t.meta.get('__metatable') !== undefined) throw rtError('cannot change a protected metatable'); t.meta = m; return [t]; },
    getmetatable: (v) => { const m = getmeta(v); if (!m) return [undefined]; const p = m.get('__metatable'); return [p !== undefined ? p : m]; },
    assert: async (...a) => { if (!truthy(a[0])) { if (a.length > 1) throw new LuaError(a[1]); throw rtError('assertion failed!'); } return a; },
    error: (v, level) => { if (typeof v === 'string' && level !== 0) v = S.chunk + ':' + S.line + ': ' + v; throw new LuaError(v); },
    pcall: async (f, ...a) => { try { return [true, ...(await call(f, a))]; } catch (e) { if (e instanceof LuaStop) throw e; return [false, errvalue(e)]; } },
    xpcall: async (f, h, ...a) => { try { return [true, ...(await call(f, a))]; } catch (e) { if (e instanceof LuaStop) throw e; return [false, ...(await call(h, [errvalue(e)]))]; } },
    select: (n, ...a) => {
      if (n === '#') return [a.length];
      let i = Number(n); if (!Number.isInteger(i)) throw rtError("bad argument #1 to 'select' (number expected, got " + typeName(n) + ')');
      if (i < 0) i = a.length + i; else i -= 1;
      if (i < 0) throw rtError("bad argument #1 to 'select' (index out of range)");
      return a.slice(i);
    },
    unpack: (t, i, j) => { i = i === undefined ? 1 : i; j = j === undefined ? t.length() : j; const r = []; for (let k = i; k <= j; k++) r.push(t.get(k)); return r; },
    collectgarbage: (opt) => [opt === 'count' ? 1024 : 0],
    load: async (chunk, name) => {
      let code = chunk;
      if (typeof chunk === 'function') { code = ''; for (;;) { const p = (await call(chunk, []))[0]; if (p === undefined || p === '') break; code += p; } }
      try { return [compileChunk(String(code), typeof name === 'string' ? name.replace(/^[=@]/, '') : S.chunk)]; } catch (e) { return [undefined, errvalue(e)]; }
    },
    dofile: () => { throw rtError("'dofile' desteklenmiyor"); },
    require: (n) => { throw rtError("module '" + n + "' not found"); }
  };
  base.loadstring = base.load; base.unpack = base.unpack;
  for (const k of Object.keys(base)) G.set(k, base[k]);
  G.set('_G', G); G.set('_VERSION', 'Lua 5.3');

  // string
  const matcherFor = patMatcher(rtError);
  const sIdx = (i, n) => i > 0 ? i : i === 0 ? 1 : Math.max(n + i + 1, 1);
  function strFindAux(a, find) {
    const fname = find ? 'find' : 'match';
    const s = argStr(a, 0, fname), pat = argStr(a, 1, fname); let init = sIdx(argNum(a, 2, fname, 1), s.length);
    if (init > s.length + 1) return [undefined];
    if (find && (truthy(a[3]) || !/[\^$*+?.()\[\]%\-]/.test(pat))) {
      const i = s.indexOf(pat, init - 1); return i < 0 ? [undefined] : [i + 1, i + pat.length];
    }
    const m = matcherFor(s, pat); let si = init - 1;
    do {
      const r = m.run(si);
      if (r) return find ? [r.start + 1, r.end, ...r.caps] : (r.caps.length ? r.caps : [s.slice(r.start, r.end)]);
      si++;
    } while (si <= s.length && !m.anchor);
    return [undefined];
  }
  function fmtOne(spec, conv, v) {
    // spec: bayraklar/genişlik/duyarlık
    const m = /^([-+ #0]*)(\d*)(?:\.(\d*))?$/.exec(spec); const flags = m[1], width = Number(m[2] || 0), prec = m[3] === undefined ? undefined : Number(m[3] || 0);
    let s;
    const num = () => { const n = tonum(v); if (n === undefined) throw rtError("bad argument to 'format' (number expected, got " + typeName(v) + ')'); return n; };
    switch (conv) {
      case 'd': case 'i': { const n = num(); if (!Number.isFinite(n)) throw rtError("bad argument to 'format' (number has no integer representation)"); let t = Math.trunc(n); s = Math.abs(t).toString(); if (prec !== undefined) s = s.padStart(prec, '0'); s = (t < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + s; break; }
      case 'u': s = String(Math.abs(Math.trunc(num()))); break;
      case 'c': s = String.fromCharCode(num()); break;
      case 'x': case 'X': case 'o': { let n = Math.trunc(num()); let big = BigInt.asUintN(64, BigInt(n)); s = big.toString(conv === 'o' ? 8 : 16); if (conv === 'X') s = s.toUpperCase(); if (prec !== undefined) s = s.padStart(prec, '0'); if (flags.includes('#') && n !== 0) s = (conv === 'o' ? '0' : conv === 'x' ? '0x' : '0X') + s; break; }
      case 'e': case 'E': { const n = num(); s = n.toExponential(prec === undefined ? 6 : prec).replace(/e([+-])(\d)$/, 'e$10$2'); if (conv === 'E') s = s.toUpperCase(); if (n >= 0 && flags.includes('+')) s = '+' + s; break; }
      case 'f': case 'F': { const n = num(); s = Number.isFinite(n) ? n.toFixed(prec === undefined ? 6 : prec) : fmtnum(n); if (n >= 0 && flags.includes('+')) s = '+' + s; else if (n >= 0 && flags.includes(' ')) s = ' ' + s; break; }
      case 'g': case 'G': { const n = num(); let p = prec === undefined ? 6 : prec || 1; if (!Number.isFinite(n)) s = fmtnum(n); else if (n === 0) s = '0'; else { const e = Math.floor(Math.log10(Math.abs(n))); if (e < -4 || e >= p) { s = n.toExponential(p - 1); if (!flags.includes('#')) s = s.replace(/\.?0+e/, 'e'); s = s.replace(/e([+-])(\d)$/, 'e$10$2'); } else { s = n.toFixed(Math.max(0, p - 1 - e)); if (!flags.includes('#') && s.includes('.')) s = s.replace(/\.?0+$/, ''); } } if (conv === 'G') s = s.toUpperCase(); if (n >= 0 && flags.includes('+')) s = '+' + s; break; }
      case 'q': s = '"' + String(v).replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0') + '"'; break;
      default: throw rtError("invalid option '%" + conv + "' to 'format'");
    }
    if (s.length < width) { if (flags.includes('-')) s = s.padEnd(width); else if (flags.includes('0') && !'sqc'.includes(conv) && /^[+-]?[0-9.]/.test(s) ) { const sg = /^[+-]/.test(s) ? s[0] : ''; s = sg + s.slice(sg.length).padStart(width - sg.length, '0'); } else s = s.padStart(width); }
    return s;
  }
  const string = {
    len: (...a) => [argStr(a, 0, 'len').length],
    sub: (...a) => { const s = argStr(a, 0, 'sub'); let i = argNum(a, 1, 'sub', 1), j = argNum(a, 2, 'sub', -1); const n = s.length; i = i < 0 ? Math.max(n + i + 1, 1) : i === 0 ? 1 : i; j = j < 0 ? n + j + 1 : Math.min(j, n); return [i > j ? '' : s.slice(i - 1, j)]; },
    upper: (...a) => [argStr(a, 0, 'upper').toUpperCase()],
    lower: (...a) => [argStr(a, 0, 'lower').toLowerCase()],
    reverse: (...a) => [[...argStr(a, 0, 'reverse')].reverse().join('')],
    rep: (...a) => { const s = argStr(a, 0, 'rep'), n = argNum(a, 1, 'rep'), sep = argStr(a, 2, 'rep', ''); if (n <= 0) return ['']; if (s.length * n > 1e8) throw rtError('resulting string too large'); return [Array(Math.floor(n)).fill(s).join(sep)]; },
    byte: (...a) => { const s = argStr(a, 0, 'byte'); const i = sIdx(argNum(a, 1, 'byte', 1), s.length); let j = argNum(a, 2, 'byte', i); j = j < 0 ? s.length + j + 1 : j; const r = []; for (let k = i; k <= Math.min(j, s.length); k++) r.push(s.charCodeAt(k - 1)); return r; },
    char: (...a) => [a.map((c, i) => String.fromCharCode(argNum(a, i, 'char'))).join('')],
    find: (...a) => strFindAux(a, true),
    match: (...a) => strFindAux(a, false),
    gmatch: (...a) => {
      const s = argStr(a, 0, 'gmatch'), pat = argStr(a, 1, 'gmatch'); const m = matcherFor(s, pat); let si = 0, lastEnd = -1;
      return [() => { while (si <= s.length) { const r = m.run(si); if (r && r.end !== lastEnd) { si = lastEnd = r.end; if (r.end === r.start) si = r.end; return r.caps.length ? r.caps : [s.slice(r.start, r.end)]; } si++; } return [undefined]; }];
    },
    gsub: async (...a) => {
      const s = argStr(a, 0, 'gsub'), pat = argStr(a, 1, 'gsub'), repl = a[2]; const maxn = a[3] === undefined ? Infinity : argNum(a, 3, 'gsub');
      if (!['string', 'number', 'function'].includes(typeName(repl)) && !(repl instanceof LuaTable)) throw rtError("bad argument #3 to 'gsub' (string/function/table expected, got " + typeName(repl) + ')');
      const m = matcherFor(s, pat); let si = 0, n = 0, res = '';
      while (n < maxn) {
        const r = m.run(si);
        if (r) {
          n++; const whole = s.slice(r.start, r.end); let rep;
          if (typeof repl === 'string' || typeof repl === 'number') {
            rep = String(repl).replace(/%(.)/g, (_, c) => { if (c === '%') return '%'; if (c === '0') return whole; if (c >= '1' && c <= '9') { const v = c === '1' && !r.caps.length ? whole : r.caps[Number(c) - 1]; if (v === undefined) throw rtError('invalid capture index %' + c + ' in replacement string'); return tostr(v); } throw rtError("invalid use of '%' in replacement string"); });
          } else {
            const key = r.caps.length ? r.caps[0] : whole;
            const v = repl instanceof LuaTable ? await idx(repl, key) : first(await call(repl, r.caps.length ? r.caps : [whole]));
            if (!truthy(v)) rep = whole; else if (typeof v === 'string' || typeof v === 'number') rep = tostr(v); else throw rtError('invalid replacement value (a ' + typeName(v) + ')');
          }
          res += rep;
        }
        if (r && r.end > si) si = r.end;
        else { if (si < s.length) res += s[si]; si++; }
        if (si > s.length || (m.anchor)) break;
      }
      if (si < s.length) res += s.slice(si);
      return [res, n];
    },
    format: async (...a) => {
      const f = argStr(a, 0, 'format'); let ai = 1; let out2 = '';
      for (let i = 0; i < f.length; i++) {
        if (f[i] !== '%') { out2 += f[i]; continue; }
        i++; if (f[i] === '%') { out2 += '%'; continue; }
        let spec = ''; while (i < f.length && /[-+ #0-9.]/.test(f[i])) spec += f[i++];
        const conv = f[i]; if (conv === undefined) throw rtError("invalid conversion '%' to 'format'");
        if (ai >= a.length && conv !== '%') throw rtError("bad argument #" + (ai + 1) + " to 'format' (no value)");
        const v = a[ai++];
        if (conv === 's') { let s = await tostringA(v); const m = /^([-]?)(\d*)(?:\.(\d*))?$/.exec(spec.replace(/[+ #0]/g, '')); if (m && m[3] !== undefined) s = s.slice(0, Number(m[3] || 0)); const w = Number(m[2] || 0); out2 += m[1] ? s.padEnd(w) : s.padStart(w); }
        else out2 += fmtOne(spec, conv, v);
      }
      return [out2];
    }
  };
  lib('string', string);
  const strTable = G.get('string'); const sm = new LuaTable(); sm.set('__index', strTable); stringMeta.set('__index', strTable);

  // table
  const tableLib = {
    insert: async (...a) => {
      const t = arg(a, 0, 'insert', 'table'); const n = t.length();
      if (a.length === 2) t.set(n + 1, a[1]);
      else if (a.length === 3) { const pos = argNum(a, 1, 'insert'); if (pos < 1 || pos > n + 1) throw rtError("bad argument #2 to 'insert' (position out of bounds)"); for (let i = n; i >= pos; i--) t.set(i + 1, t.get(i)); t.set(pos, a[2]); }
      else throw rtError("wrong number of arguments to 'insert'");
      return [];
    },
    remove: (...a) => {
      const t = arg(a, 0, 'remove', 'table'); const n = t.length(); let pos = a[1] === undefined ? n : argNum(a, 1, 'remove');
      if (n === 0 && (a[1] === undefined || pos === 0 || pos === n)) return [t.get(pos)];
      if (n + 1 === pos) { const v = t.get(pos); t.set(pos, undefined); return [v]; }
      if (pos < 1 || pos > n + 1) throw rtError("bad argument #2 to 'remove' (position out of bounds)");
      const v = t.get(pos); for (let i = pos; i < n; i++) t.set(i, t.get(i + 1)); t.set(n, undefined); return [v];
    },
    concat: (...a) => {
      const t = arg(a, 0, 'concat', 'table'), sep = argStr(a, 1, 'concat', ''); const i = argNum(a, 2, 'concat', 1), j = argNum(a, 3, 'concat', t.length()); const parts = [];
      for (let k = i; k <= j; k++) { const v = t.get(k); if (typeof v !== 'string' && typeof v !== 'number') throw rtError("invalid value (at index " + k + ") in table for 'concat'"); parts.push(tostr(v)); }
      return [parts.join(sep)];
    },
    unpack: (t, i, j) => base.unpack(t, i, j),
    pack: (...a) => { const t = mktable(a, []); t.set('n', a.length); return [t]; },
    sort: async (...a) => {
      const t = arg(a, 0, 'sort', 'table'), cmp = a[1]; const arr = []; const n = t.length(); for (let i = 1; i <= n; i++) arr.push(t.get(i));
      const less = async (x, y) => cmp === undefined ? lt(x, y) : truthy(first(await call(cmp, [x, y])));
      async function msort(v) {
        if (v.length < 2) return v; const mid = v.length >> 1; const l = await msort(v.slice(0, mid)), r = await msort(v.slice(mid)); const o = []; let i = 0, j = 0;
        while (i < l.length && j < r.length) { if (await less(r[j], l[i])) o.push(r[j++]); else o.push(l[i++]); }
        while (i < l.length) o.push(l[i++]); while (j < r.length) o.push(r[j++]); return o;
      }
      const sorted = await msort(arr); sorted.forEach((v, i) => t.set(i + 1, v)); return [];
    },
    move: (a1, f, e, t, a2) => { const dst = a2 === undefined ? a1 : a2; if (e >= f) { if (t > f || t > e || dst !== a1) for (let i = e - f; i >= 0; i--) dst.set(t + i, a1.get(f + i)); else for (let i = 0; i <= e - f; i++) dst.set(t + i, a1.get(f + i)); } return [dst]; }
  };
  lib('table', tableLib);

  // math
  let seed = 0x2545F491;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  lib('math', {
    pi: Math.PI, huge: Infinity, maxinteger: 9007199254740991, mininteger: -9007199254740991,
    floor: (...a) => [Math.floor(argNum(a, 0, 'floor'))], ceil: (...a) => [Math.ceil(argNum(a, 0, 'ceil'))], abs: (...a) => [Math.abs(argNum(a, 0, 'abs'))],
    sqrt: (...a) => [Math.sqrt(argNum(a, 0, 'sqrt'))], sin: (...a) => [Math.sin(argNum(a, 0, 'sin'))], cos: (...a) => [Math.cos(argNum(a, 0, 'cos'))], tan: (...a) => [Math.tan(argNum(a, 0, 'tan'))],
    asin: (...a) => [Math.asin(argNum(a, 0, 'asin'))], acos: (...a) => [Math.acos(argNum(a, 0, 'acos'))], atan: (...a) => [Math.atan2(argNum(a, 0, 'atan'), argNum(a, 1, 'atan', 1))],
    exp: (...a) => [Math.exp(argNum(a, 0, 'exp'))], pow: (...a) => [Math.pow(argNum(a, 0, 'pow'), argNum(a, 1, 'pow'))],
    log: (...a) => { const x = argNum(a, 0, 'log'); if (a[1] === undefined) return [Math.log(x)]; const b = argNum(a, 1, 'log'); return [b === 2 ? Math.log2(x) : b === 10 ? Math.log10(x) : Math.log(x) / Math.log(b)]; },
    fmod: (...a) => [argNum(a, 0, 'fmod') % argNum(a, 1, 'fmod')], modf: (...a) => { const x = argNum(a, 0, 'modf'); const i = x >= 0 ? Math.floor(x) : Math.ceil(x); return [i, x - i]; },
    max: (...a) => { let m = argNum(a, 0, 'max'); for (let i = 1; i < a.length; i++) m = Math.max(m, argNum(a, i, 'max')); return [m]; },
    min: (...a) => { let m = argNum(a, 0, 'min'); for (let i = 1; i < a.length; i++) m = Math.min(m, argNum(a, i, 'min')); return [m]; },
    random: (...a) => { if (!a.length) return [rnd()]; const lo = a.length === 1 ? 1 : argNum(a, 0, 'random'), hi = a.length === 1 ? argNum(a, 0, 'random') : argNum(a, 1, 'random'); if (lo > hi) throw rtError("bad argument to 'random' (interval is empty)"); return [lo + Math.floor(rnd() * (hi - lo + 1))]; },
    randomseed: (...a) => { seed = (Number(a[0]) >>> 0) || 0x2545F491; return []; },
    tointeger: (v) => { const n = tonum(v); return [n !== undefined && Number.isInteger(n) ? n : undefined]; },
    type: (v) => [typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'float') : undefined],
    ult: (a, b) => [BigInt.asUintN(64, BigInt(a)) < BigInt.asUintN(64, BigInt(b))]
  });

  // os / io
  const pad2 = n => String(n).padStart(2, '0');
  lib('os', {
    time: (t) => { if (t instanceof LuaTable) { const g = k => t.get(k); return [Math.floor(new Date(g('year'), (g('month') || 1) - 1, g('day') || 1, g('hour') === undefined ? 12 : g('hour'), g('min') || 0, g('sec') || 0).getTime() / 1000)]; } return [Math.floor(Date.now() / 1000)]; },
    clock: () => [(typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000],
    date: (fmt, t) => {
      const d = new Date((t === undefined ? Date.now() / 1000 : t) * 1000); let f = fmt === undefined ? '%c' : fmt; let utc = false; if (f[0] === '!') { utc = true; f = f.slice(1); }
      const Y = utc ? d.getUTCFullYear() : d.getFullYear(), M = (utc ? d.getUTCMonth() : d.getMonth()) + 1, D = utc ? d.getUTCDate() : d.getDate(), h = utc ? d.getUTCHours() : d.getHours(), mi = utc ? d.getUTCMinutes() : d.getMinutes(), s = utc ? d.getUTCSeconds() : d.getSeconds(), wd = utc ? d.getUTCDay() : d.getDay();
      if (f.startsWith('*t')) { const r = new LuaTable(); r.set('year', Y); r.set('month', M); r.set('day', D); r.set('hour', h); r.set('min', mi); r.set('sec', s); r.set('wday', wd + 1); r.set('yday', 1); r.set('isdst', false); return [r]; }
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], mons = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return [f.replace(/%(.)/g, (_, c) => ({ Y: Y, y: pad2(Y % 100), m: pad2(M), d: pad2(D), H: pad2(h), M: pad2(mi), S: pad2(s), p: h < 12 ? 'AM' : 'PM', A: days[wd], a: days[wd].slice(0, 3), B: mons[M - 1], b: mons[M - 1].slice(0, 3), c: Y + '-' + pad2(M) + '-' + pad2(D) + ' ' + pad2(h) + ':' + pad2(mi) + ':' + pad2(s), x: pad2(M) + '/' + pad2(D) + '/' + pad2(Y % 100), X: pad2(h) + ':' + pad2(mi) + ':' + pad2(s), '%': '%' }[c] ?? '%' + c))];
    },
    getenv: () => [undefined], difftime: (a, b) => [a - (b || 0)],
    exit: () => { throw new LuaStop('os.exit'); },
    remove: () => [undefined, 'desteklenmiyor'], rename: () => [undefined, 'desteklenmiyor'], tmpname: () => ['/tmp/lua_tmp']
  });
  lib('io', {
    write: (...a) => { writeBuf += a.map(tostr).join(''); let k; while ((k = writeBuf.indexOf('\n')) >= 0) { out(writeBuf.slice(0, k)); writeBuf = writeBuf.slice(k + 1); } return []; },
    read: () => [undefined]
  });

  // coroutine
  const co = {
    create: (f) => { if (typeof f !== 'function') throw rtError("bad argument #1 to 'create' (function expected)"); return [new Coroutine(f)]; },
    status: (c) => [c.status],
    running: () => [S.current || undefined, !S.current],
    isyieldable: () => [!!S.current],
    resume: (c, ...a) => resumeCo(c, a),
    yield: (...vals) => {
      const c = S.current; if (!c) throw rtError('attempt to yield from outside a coroutine');
      return new Promise((resolveInner, rejectInner) => { c.resumeInner = resolveInner; c.rejectInner = rejectInner; c.status = 'suspended'; S.current = c.prev; c.resolveOuter([true, ...vals]); });
    },
    wrap: (f) => { const c = new Coroutine(f); return [async (...a) => { const r = await resumeCo(c, a); if (r[0] === true) return r.slice(1); throw new LuaError(r[1]); }]; }
  };
  function resumeCo(c, a) {
    if (!(c instanceof Coroutine)) throw rtError("bad argument #1 to 'resume' (coroutine expected)");
    if (c.status === 'dead') return [false, 'cannot resume dead coroutine'];
    if (c.status === 'running') return [false, 'cannot resume non-suspended coroutine'];
    if (c.status === 'normal') return [false, 'cannot resume non-suspended coroutine'];
    return new Promise((resolve, reject) => {
      c.prev = S.current; if (c.prev) c.prev.status = 'normal'; S.current = c; c.status = 'running';
      c.resolveOuter = r => { if (c.prev) c.prev.status = 'running'; S.current = c.prev; resolve(r); };
      c.rejectOuter = e => { if (c.prev) c.prev.status = 'running'; S.current = c.prev; reject(e); };
      if (!c.started) {
        c.started = true;
        (async () => {
          try { const r = await call(c.fn, a); c.status = 'dead'; c.resolveOuter([true, ...r]); }
          catch (e) { c.status = 'dead'; if (e instanceof LuaStop) c.rejectOuter(e); else c.resolveOuter([false, errvalue(e)]); }
        })();
      } else c.resumeInner(a);
    });
  }
  lib('coroutine', co);

  // ---- derleme ve çalıştırma
  function compileChunk(code, chunk) {
    const saveChunk = S.chunk; S.chunk = chunk;
    try {
      const ast = parse(code, chunk); const js = compile(ast, chunk);
      const factory = new Function('rt', 'const {G,call,callm,idx,setidx,arith,concat,len,lt,le,truthy,tostr,newtable,mktable,tick,fornum,S}=rt;return (' + js + ');');
      const f = factory(rt);
      return async (...a) => { return await f(...a); };
    } finally { S.chunk = saveChunk; }
  }
  const api = {
    LuaTable, LuaError, LuaStop, G, S,
    setGlobal: (name, v) => G.set(name, v),
    getGlobal: name => G.get(name),
    stop: () => { S.stop = true; },
    // Lua kodunu çalıştırır; hata olursa Error fırlatır (iletisi Lua biçiminde)
    run: async (code, chunk = 'script') => {
      S.stop = false; S.line = 0; S.chunk = chunk; S.current = null; S.ticks = 0; writeBuf = '';
      let f;
      try { f = compileChunk(code, chunk); } catch (e) { throw e instanceof LuaError ? new Error(e.value) : e; }
      try { const r = await f(); if (writeBuf) { out(writeBuf); writeBuf = ''; } return r; }
      catch (e) {
        if (writeBuf) { out(writeBuf); writeBuf = ''; }
        if (e instanceof LuaStop) throw e;
        if (e instanceof LuaError) throw new Error(typeof e.value === 'string' ? e.value : tostr(e.value) === e.value ? e.value : '(error object is a ' + typeName(e.value) + ' value)');
        throw e;
      }
    },
    // JS değerlerini Lua'ya / Lua'dan çevirir (gg köprüsü için)
    toLua: function toLua(v) {
      if (v === null || v === undefined) return undefined;
      if (Array.isArray(v)) { const t = new LuaTable(); v.forEach((x, i) => t.set(i + 1, toLua(x))); return t; }
      if (typeof v === 'object' && !(v instanceof LuaTable)) { const t = new LuaTable(); for (const k of Object.keys(v)) { const x = toLua(v[k]); if (x !== undefined) t.set(k, x); } return t; }
      return v;
    },
    toJS: function toJS(v) {
      if (v instanceof LuaTable) {
        const n = v.length(); const keys = v.keys();
        if (keys.length === n && n > 0) return v.arr.map(toJS);
        if (keys.length === 0) return [];
        const o = {}; for (const k of keys) o[String(k)] = toJS(v.get(k)); return o;
      }
      return v;
    },
    bindObject(name, obj, wrap) {
      const t = new LuaTable();
      for (const k of Object.keys(obj)) { const v = obj[k]; t.set(k, typeof v === 'function' ? (wrap ? wrap(k, v) : v) : api.toLua(v)); }
      G.set(name, t); return t;
    },
    tostring: tostringA
  };
  return api;
}

const exported = { create, LuaTable, LuaError, LuaStop, parse, compile };
if (typeof module !== 'undefined' && module.exports) module.exports = exported;
if (root) root.ZyronLua = exported;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
