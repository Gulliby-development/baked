Write a growable string buffer in C11: `src/strbuf.c` with the header `src/strbuf.h`.

- `typedef struct { char *data; size_t len; size_t cap; } strbuf;`
- `int sb_init(strbuf *sb)`, `int sb_append(strbuf *sb, const char *s)`, `int sb_appendf(strbuf *sb, const char *fmt, ...)` (printf-style) and `void sb_free(strbuf *sb)`. The int functions return 0 on success and -1 when memory runs out; `data` is always NUL-terminated after a successful call.
- Growth doubles the capacity.

Add tests as `tests/test_strbuf.c` with a `main` that returns non-zero on a failure; the existing Makefile builds `src/*.c` and `tests/*.c` together and `make test` runs them. Add a README.md.
