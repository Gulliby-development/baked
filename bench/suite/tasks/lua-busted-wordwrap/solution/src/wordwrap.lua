local M = {}

function M.wrap(text, width)
	if width < 1 then
		error("width must be at least 1")
	end
	local lines = {}
	local line = nil
	for word in text:gmatch("%S+") do
		if line == nil then
			line = word
		elseif #line + 1 + #word <= width then
			line = line .. " " .. word
		else
			lines[#lines + 1] = line
			line = word
		end
	end
	if line ~= nil then
		lines[#lines + 1] = line
	end
	return lines
end

return M
