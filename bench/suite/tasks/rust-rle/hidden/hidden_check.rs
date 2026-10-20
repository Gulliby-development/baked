use rle::{decode, encode};

#[test]
fn hidden_round_trip() {
    assert_eq!(encode("aaabcc"), "3a1b2c");
    assert_eq!(encode(""), "");
    assert_eq!(encode("\u{e9}\u{e9}x"), "2\u{e9}1x");
    assert_eq!(decode("12a1b").unwrap(), format!("{}b", "a".repeat(12)));
    assert_eq!(decode(&encode("zzzzzzzzzzzzq")).unwrap(), "zzzzzzzzzzzzq");
}

#[test]
fn hidden_errors() {
    assert!(decode("a").is_err());
    assert!(decode("0a").is_err());
    assert!(decode("2a3").is_err());
}
