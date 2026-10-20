#ifndef STRBUF_H
#define STRBUF_H
#include <stddef.h>
typedef struct {
  char *data;
  size_t len;
  size_t cap;
} strbuf;
int sb_init(strbuf *sb);
int sb_append(strbuf *sb, const char *s);
int sb_appendf(strbuf *sb, const char *fmt, ...);
void sb_free(strbuf *sb);
#endif
