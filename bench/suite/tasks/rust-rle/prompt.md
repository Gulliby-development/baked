Write a Rust library crate `rle` with run-length encoding in `src/lib.rs`.

- `pub fn encode(input: &str) -> String`: each run becomes its count and character, `"aaabcc"` is `"3a1b2c"`; works on any Unicode characters except ASCII digits.
- `pub fn decode(input: &str) -> Result<String, String>`: the inverse; a missing count, a count of 0 or a trailing count returns `Err` with a message.
- `encode` panics on ASCII digits in the input.

Add unit tests and a README.md with an example.
