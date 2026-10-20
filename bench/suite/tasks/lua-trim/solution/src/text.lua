local M = {}

function M.trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

function M.starts_with(s, prefix)
  return s:sub(1, #prefix) == prefix
end

function M.pad_left(s, width, char)
  char = char or " "
  if #char ~= 1 then error("pad char must be one character") end
  if #s >= width then return s end
  return string.rep(char, width - #s) .. s
end

return M
