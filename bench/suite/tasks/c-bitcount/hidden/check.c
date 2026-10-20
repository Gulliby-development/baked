#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include "bits.h"

int main(void) {
  uint32_t out = 0;
  assert(popcount32(0) == 0);
  assert(popcount32(0xFFFFFFFFu) == 32);
  assert(popcount32(0x80000001u) == 2);
  assert(reverse_bits32(1u) == 0x80000000u);
  assert(reverse_bits32(0x0000000Fu) == 0xF0000000u);
  assert(next_pow2(0, &out) == 0 && out == 1);
  assert(next_pow2(5, &out) == 0 && out == 8);
  assert(next_pow2(64, &out) == 0 && out == 64);
  assert(next_pow2(0x80000001u, &out) == -1);
  puts("ok");
  return 0;
}
