//! Temperature parsing and conversion.

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Unit {
    C,
    F,
    K,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Temp {
    pub value: f64,
    pub unit: Unit,
}

pub fn parse(s: &str) -> Result<Temp, String> {
    let s = s.trim();
    let last = s.chars().last().ok_or("empty input")?;
    let unit = match last.to_ascii_uppercase() {
        'C' => Unit::C,
        'F' => Unit::F,
        'K' => Unit::K,
        _ => return Err(format!("unknown unit in {s:?}")),
    };
    let value: f64 = s[..s.len() - 1].trim().parse().map_err(|_| format!("bad number in {s:?}"))?;
    if unit == Unit::K && value < 0.0 {
        return Err("kelvin below zero".into());
    }
    Ok(Temp { value, unit })
}

impl Temp {
    pub fn to(&self, unit: Unit) -> Temp {
        let c = match self.unit {
            Unit::C => self.value,
            Unit::F => (self.value - 32.0) * 5.0 / 9.0,
            Unit::K => self.value - 273.15,
        };
        let value = match unit {
            Unit::C => c,
            Unit::F => c * 9.0 / 5.0 + 32.0,
            Unit::K => c + 273.15,
        };
        Temp { value, unit }
    }
}
