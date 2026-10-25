rockspec_format = "3.0"
package = "wordwrap"
version = "0.1-1"
source = { url = "git+https://example.invalid/wordwrap.git" }
dependencies = { "lua >= 5.1" }
test_dependencies = { "busted" }
build = {
  type = "builtin",
  modules = { wordwrap = "src/wordwrap.lua" },
}
