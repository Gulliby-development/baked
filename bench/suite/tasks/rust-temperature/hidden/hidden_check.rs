use temperature::{parse, Unit};

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

#[test]
fn hidden_convert() {
    let t = parse("-40 f").unwrap();
    assert!(close(t.to(Unit::C).value, -40.0));
    assert!(close(parse("100C").unwrap().to(Unit::F).value, 212.0));
    assert!(close(parse("0c").unwrap().to(Unit::K).value, 273.15));
    assert!(close(parse("21.5C").unwrap().value, 21.5));
}

#[test]
fn hidden_invalid() {
    assert!(parse("-1K").is_err());
    assert!(parse("12X").is_err());
    assert!(parse("").is_err());
}
