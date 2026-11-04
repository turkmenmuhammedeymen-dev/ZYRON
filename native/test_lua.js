// Lua yorumlayıcısı testleri: node native/test_lua.js
const { create } = require('../web/lua.js');
let pass = 0, fail = 0;
async function run(code, extra) {
  const out = [];
  const lua = create({ print: s => out.push(s) });
  if (extra) extra(lua);
  try { await lua.run(code); } catch (e) { out.push('ERR:' + e.message); }
  return out;
}
async function t(name, code, expected, extra) {
  const got = await run(code, extra);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) pass++; else { fail++; console.log('FAIL', name, '\n  beklenen:', JSON.stringify(expected), '\n  gelen:   ', JSON.stringify(got)); }
}
(async () => {
  await t('print', 'print("merhaba", 1, 2.5, true, nil)', ['merhaba\t1\t2.5\ttrue\tnil']);
  await t('arith', 'print(1+2*3, 10/4, 7//2, 7%3, -7%3, 2^10, 7.5//2)', ['7\t2.5\t3\t1\t2\t1024\t3']);
  await t('string num coercion', 'print("10"+5, "3"*"4", 10 .. 20)', ['15\t12\t1020']);
  await t('locals+closures', 'local function mk() local n=0 return function() n=n+1 return n end end local c=mk() c() c() print(c())', ['3']);
  await t('multi return', 'local function f() return 1,2,3 end local a,b,c=f() print(a,b,c) print((f())) print(f()) local t={f(),f()} print(#t)', ['1\t2\t3', '1', '1\t2\t3', '4']);
  await t('varargs', 'local function f(...) local a,b=... return select("#",...),a,b end print(f(5,6,7))', ['3\t5\t6']);
  await t('if/elseif/else', 'local x=5 if x<3 then print("a") elseif x<10 then print("b") else print("c") end', ['b']);
  await t('while/break', 'local i=0 while true do i=i+1 if i>=5 then break end end print(i)', ['5']);
  await t('repeat scope', 'local i=0 repeat local j=i i=i+1 until j>=3 print(i)', ['4']);
  await t('numeric for', 'local s=0 for i=1,10 do s=s+i end print(s) for i=10,1,-3 do io.write(i," ") end print()', ['55', '10 7 4 1 ']);
  await t('for float step', 'for i=0,1,0.5 do io.write(i," ") end print()', ['0 0.5 1 ']);
  await t('pairs/ipairs', 'local t={10,20,30,x=1} local s=0 for i,v in ipairs(t) do s=s+v end print(s) local n=0 for k,v in pairs(t) do n=n+1 end print(n)', ['60', '4']);
  await t('table funcs', 'local t={} table.insert(t,"a") table.insert(t,"c") table.insert(t,2,"b") print(table.concat(t,",")) print(table.remove(t,1), #t) print(table.unpack({1,2,3}))', ['a,b,c', 'a\t2', '1\t2\t3']);
  await t('sort', 'local t={5,2,8,1} table.sort(t) print(table.concat(t," ")) table.sort(t,function(a,b) return a>b end) print(table.concat(t," "))', ['1 2 5 8', '8 5 2 1']);
  await t('string basics', 'local s="Hello" print(#s, s:upper(), s:lower(), s:sub(2,3), s:sub(-3), s:rep(2,"-"), s:reverse(), s:byte(1), string.char(72,105))', ['5\tHELLO\thello\tel\tllo\tHello-Hello\tolleH\t72\tHi']);
  await t('string.format', 'print(string.format("%d|%5d|%-5d|%05d|%x|%X|%o|%5.2f|%e|%g|%s|%q|%%", 42, 42, 42, 42, 255, 255, 8, 3.14159, 12345.678, 0.0001, "x", "a\\"b"))', ['42|   42|42   |00042|ff|FF|10| 3.14|1.234568e+04|0.0001|x|"a\\"b"|%']);
  await t('find/match', 'print(string.find("hello world","wor")) print(string.find("hello","l+")) print(string.match("key=value","(%w+)=(%w+)")) print(string.match("abc123","%d+")) print(string.find("a.b",".",1,true))', ['7\t9', '3\t4', 'key\tvalue', '123', '2\t2']);
  await t('gsub/gmatch', 'print(string.gsub("hello world","o","0")) print(string.gsub("abc","%w","%0%0")) for w in string.gmatch("one two three","%a+") do io.write(w,";") end print() print(string.gsub("$name is $age","%$(%w+)",{name="Ali",age=7}))', ['hell0 w0rld\t2', 'aabbcc\t3', 'one;two;three;', 'Ali is 7\t2']);
  await t('gsub fn+anchors', 'print(("  trim  "):gsub("^%s+",""):gsub("%s+$",""))  print(("x"):rep(3):gsub("x",function(c) return "y" end))', ['trim\t1', 'yyy\t3']);
  await t('patterns %b %f', 'print(string.match("f(a(b)c)d","%b()")) print(string.find("THE (quick) fox","%f[%a]%a+%f[%A]"))', ['(a(b)c)', '1\t3']);
  await t('metatables', 'local V={} V.__index=V V.__add=function(a,b) return setmetatable({x=a.x+b.x},V) end V.__tostring=function(v) return "V("..v.x..")" end local a=setmetatable({x=1},V) local b=setmetatable({x=2},V) print(tostring(a+b)) print(rawget(a,"y"))', ['V(3)', 'nil']);
  await t('__index fn/__newindex/__call', 'local log={} local t=setmetatable({}, {__index=function(t,k) return k.."!" end, __newindex=function(t,k,v) rawset(t,k,v*2) end, __call=function(self,a) return a+1 end}) print(t.foo) t.x=5 print(t.x) print(t(41))', ['foo!', '10', '42']);
  await t('pcall/error', 'print(pcall(function() error("boom") end)) print(pcall(function() error({code=1}) end)) print(select(2,pcall(error,"x",0)))', ['false\tscript:1: boom', 'false\ttable: 0x1020', 'x']);
  await t('error with table value', 'local ok,e=pcall(function() error({code=7}) end) print(ok, e.code)', ['false\t7']);
  await t('runtime error messages', 'local t=nil print(pcall(function() return t.x end)) print(pcall(function() return undefinedfn() end)) print(pcall(function() return 1+{} end)) print(pcall(function() return "a"<1 end))', ["false\tscript:1: attempt to index a nil value (local 't')", "false\tscript:1: attempt to call a nil value (global 'undefinedfn')", 'false\tscript:1: attempt to perform arithmetic on a table value', 'false\tscript:1: attempt to compare string with number']);
  await t('syntax error', 'x = = 1', ["ERR:script:1: unexpected symbol near '='"]);
  await t('coroutine basic', 'local co=coroutine.create(function(a,b) local c=coroutine.yield(a+b) local d,e=coroutine.yield(c*2) return d+e end) print(coroutine.resume(co,1,2)) print(coroutine.resume(co,10)) print(coroutine.resume(co,3,4)) print(coroutine.resume(co)) print(coroutine.status(co))', ['true\t3', 'true\t20', 'true\t7', 'false\tcannot resume dead coroutine', 'dead']);
  await t('coroutine wrap gen', 'local function gen(n) return coroutine.wrap(function() for i=1,n do coroutine.yield(i) end end) end local s=0 for v in gen(5) do s=s+v end print(s)', ['15']);
  await t('goto continue', 'for i=1,5 do if i%2==0 then goto continue end io.write(i," ") ::continue:: end print()', ['1 3 5 ']);
  await t('integer ops', 'print(5 & 3, 5 | 3, 5 ~ 3, ~0, 1 << 4, 256 >> 4)', ['1\t7\t6\t-1\t16\t16']);
  await t('comparison/logic', 'print(1<2, 2<=2, "a"<"b", 1==1.0, "1"==1, nil==false, not nil, 1 and 2, nil or 3, false and 1)', ['true\ttrue\ttrue\ttrue\tfalse\tfalse\ttrue\t2\t3\tfalse']);
  await t('tostring/tonumber', 'print(tonumber("0x10"), tonumber("  12  "), tonumber("1e2"), tonumber("abc"), tonumber("ff",16), tonumber("z",36), tostring(12), tostring(1.5), tostring(nil))', ['16\t12\t100\tnil\t255\t35\t12\t1.5\tnil']);
  await t('math', 'print(math.floor(3.7), math.ceil(3.2), math.max(1,5,3), math.min(4,2), math.abs(-3), math.sqrt(16), math.huge, math.type(1), math.type(1.5), math.tointeger(3.0))', ['3\t4\t5\t2\t3\t4\tinf\tinteger\tfloat\t3']);
  await t('long strings/comments', 'local s=[[a\nb]] print(#s) --[[ comment\n]] print("ok") --[==[ x ]==] print([==[x]]y]==])', ['3', 'ok', 'x]]y']);
  await t('nested tables', 'local t={a={b={c=5}}, [1]="x", [2]="y"} print(t.a.b.c, #t, t[2]) t.a.b.c=9 print(t["a"]["b"]["c"])', ['5\t2\ty', '9']);
  await t('method defs', 'local A={} function A:new(n) local o=setmetatable({n=n},{__index=A}) return o end function A:get() return self.n end function A.static(x) return x*2 end print(A:new(7):get(), A.static(4))', ['7\t8']);
  await t('shadowing/closures in loops', 'local fs={} for i=1,3 do fs[i]=function() return i end end print(fs[1](), fs[2](), fs[3]())', ['1\t2\t3']);
  await t('multiple assign swap', 'local a,b=1,2 a,b=b,a print(a,b) local t={} t.x,t.y=5,6 print(t.x,t.y)', ['2\t1', '5\t6']);
  await t('load', 'local f=load("return 1+1") print(f()) print(load("x ="))', ['2', 'nil\t[string]:1: unexpected symbol near <eof>'.replace('[string]','script')]);
  await t('os/time', 'print(type(os.time()), type(os.clock()), os.date("%Y")==tostring(os.date("*t").year))', ['number\tnumber\ttrue']);
  await t('async host fn', 'print(add(2,3)) print(slow())', ['5', 'done'], lua => {
    lua.setGlobal('add', async (a, b) => [a + b]);
    lua.setGlobal('slow', async () => { await new Promise(r => setTimeout(r, 20)); return ['done']; });
  });
  await t('perf loop', 'local s=0 for i=1,300000 do s=s+i%7 end print(s)', ['899998']);
  // durdurma
  {
    const lua = create({ print: () => {} }); setTimeout(() => lua.stop(), 50);
    let stopped = false; try { await lua.run('while true do end'); } catch (e) { stopped = e instanceof require('../web/lua.js').LuaStop; }
    if (stopped) pass++; else { fail++; console.log('FAIL stop infinite loop'); }
  }
  console.log(fail ? fail + ' BASARISIZ, ' + pass + ' gecti' : 'TUM LUA TESTLERI GECTI (' + pass + ')');
  process.exit(fail ? 1 : 0);
})();
