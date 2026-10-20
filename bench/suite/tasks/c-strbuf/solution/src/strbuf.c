#include "strbuf.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int reserve(strbuf *sb, size_t need) {
  if (need + 1 <= sb->cap) return 0;
  size_t cap = sb->cap ? sb->cap : 16;
  while (cap < need + 1) cap *= 2;
  char *p = realloc(sb->data, cap);
  if (!p) return -1;
  sb->data = p;
  sb->cap = cap;
  return 0;
}

int sb_init(strbuf *sb) {
  sb->data = NULL;
  sb->len = sb->cap = 0;
  if (reserve(sb, 0)) return -1;
  sb->data[0] = '\0';
  return 0;
}

int sb_append(strbuf *sb, const char *s) {
  size_t n = strlen(s);
  if (reserve(sb, sb->len + n)) return -1;
  memcpy(sb->data + sb->len, s, n + 1);
  sb->len += n;
  return 0;
}

int sb_appendf(strbuf *sb, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  if (n < 0 || reserve(sb, sb->len + (size_t)n)) return -1;
  va_start(ap, fmt);
  vsnprintf(sb->data + sb->len, (size_t)n + 1, fmt, ap);
  va_end(ap);
  sb->len += (size_t)n;
  return 0;
}

void sb_free(strbuf *sb) {
  free(sb->data);
  sb->data = NULL;
  sb->len = sb->cap = 0;
}
