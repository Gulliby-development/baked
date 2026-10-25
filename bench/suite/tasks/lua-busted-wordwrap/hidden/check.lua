package.path = arg[1] .. "/src/?.lua;" .. package.path
local w = require("wordwrap")
local function eq(a, b)
  if #a ~= #b then return false end
  for i = 1, #a do if a[i] ~= b[i] then return false end end
  return true
end
assert(eq(w.wrap("the quick brown fox", 10), {"the quick", "brown fox"}))
assert(eq(w.wrap("  a\tb\n\nc  ", 3), {"a b", "c"}))
assert(eq(w.wrap("tiny enormousword x", 5), {"tiny", "enormousword", "x"}))
assert(eq(w.wrap("one two", 7), {"one two"}))
assert(eq(w.wrap(" \t\n", 4), {}))
assert(not pcall(w.wrap, "a", 0))
print("ok")
