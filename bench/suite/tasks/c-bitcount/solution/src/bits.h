#ifndef BITS_H
#define BITS_H
#include <stdint.h>
int popcount32(uint32_t x);
uint32_t reverse_bits32(uint32_t x);
int next_pow2(uint32_t x, uint32_t *out);
#endif
