Write a small C11 library in `src/bits.c` with the header `src/bits.h`.

- `int popcount32(uint32_t x)` returns the number of set bits, without compiler builtins.
- `uint32_t reverse_bits32(uint32_t x)` reverses the bit order.
- `int next_pow2(uint32_t x, uint32_t *out)` writes the smallest power of two at least `x` (1 for 0) and returns 0, or returns -1 when it does not fit in 32 bits.

Add tests as `tests/test_bits.c` with a `main` that returns non-zero on a failure; the existing Makefile builds `src/*.c` and `tests/*.c` together and `make test` runs them. Add a README.md.
