#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "strbuf.h"

int main(void) {
  strbuf sb;
  assert(sb_init(&sb) == 0);
  assert(sb.len == 0 && sb.data && sb.data[0] == '\0');
  for (int i = 0; i < 1000; i++) assert(sb_append(&sb, "ab") == 0);
  assert(sb.len == 2000 && strlen(sb.data) == 2000);
  assert(sb_appendf(&sb, "-%d-%s", 42, "x") == 0);
  assert(strcmp(sb.data + 2000, "-42-x") == 0);
  assert(sb.cap >= sb.len + 1);
  sb_free(&sb);
  puts("ok");
  return 0;
}
