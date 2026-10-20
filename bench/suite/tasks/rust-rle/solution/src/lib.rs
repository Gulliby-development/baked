//! Run-length encoding.

pub fn encode(input: &str) -> String {
    let mut out = String::new();
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        assert!(!c.is_ascii_digit(), "digits cannot be encoded");
        let mut n = 1;
        while chars.peek() == Some(&c) {
            chars.next();
            n += 1;
        }
        out.push_str(&format!("{n}{c}"));
    }
    out
}

pub fn decode(input: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut count = String::new();
    for c in input.chars() {
        if c.is_ascii_digit() {
            count.push(c);
            continue;
        }
        let n: usize = count.parse().map_err(|_| format!("missing count before {c:?}"))?;
        if n == 0 {
            return Err("count of 0".into());
        }
        out.extend(std::iter::repeat(c).take(n));
        count.clear();
    }
    if !count.is_empty() {
        return Err("trailing count".into());
    }
    Ok(out)
}
