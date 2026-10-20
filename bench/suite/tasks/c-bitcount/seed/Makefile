CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2

.PHONY: test clean

test: build/tests
	./build/tests

build/tests: $(wildcard src/*.c) $(wildcard tests/*.c) $(wildcard src/*.h)
	mkdir -p build
	$(CC) $(CFLAGS) -Isrc -o $@ $(filter %.c,$^)

clean:
	rm -rf build
