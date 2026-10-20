#include "bits.h"

int popcount32(uint32_t x) {
  int n = 0;
  for (; x; x &= x - 1) n++;
  return n;
}

uint32_t reverse_bits32(uint32_t x) {
  uint32_t r = 0;
  for (int i = 0; i < 32; i++, x >>= 1) r = (r << 1) | (x & 1u);
  return r;
}

int next_pow2(uint32_t x, uint32_t *out) {
  if (x > 0x80000000u) return -1;
  uint32_t p = 1;
  while (p < x) p <<= 1;
  *out = p;
  return 0;
}
