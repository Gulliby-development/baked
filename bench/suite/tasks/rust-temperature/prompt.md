Write a Rust library crate `temperature` in `src/lib.rs` for parsing and converting temperatures.

- `pub enum Unit { C, F, K }` and `pub struct Temp { pub value: f64, pub unit: Unit }`.
- `pub fn parse(s: &str) -> Result<Temp, String>` accepts a number followed by `C`, `F` or `K` (case-insensitive, optional space): `"21.5C"`, `"-40 f"`, `"300K"`. Kelvin below 0 and anything else return `Err`.
- `impl Temp { pub fn to(&self, unit: Unit) -> Temp }` converts between units.

Add unit tests and a README.md with an example.
