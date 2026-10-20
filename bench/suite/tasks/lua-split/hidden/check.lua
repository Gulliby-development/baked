package.path = arg[1] .. "/src/?.lua;" .. package.path
local s = require("strutil")
local function eq(a, b)
  if #a ~= #b then return false end
  for i = 1, #a do if a[i] ~= b[i] then return false end end
  return true
end
assert(eq(s.split("a,,b", ","), {"a", "", "b"}))
assert(eq(s.split("a.b", ".", true), {"a", "b"}))
assert(eq(s.split("a1b22c", "%d+"), {"a", "b", "c"}))
assert(eq(s.split("", ","), {""}))
assert(not pcall(s.split, "a", ""))
print("ok")
