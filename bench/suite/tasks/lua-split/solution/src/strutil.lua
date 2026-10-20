local M = {}

function M.split(s, sep, plain)
  if sep == nil or sep == "" then error("empty separator") end
  local out, pos = {}, 1
  while true do
    local i, j = string.find(s, sep, pos, plain)
    if not i then break end
    out[#out + 1] = s:sub(pos, i - 1)
    pos = j + 1
  end
  out[#out + 1] = s:sub(pos)
  return out
end

return M
