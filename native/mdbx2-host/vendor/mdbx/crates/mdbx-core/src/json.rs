//! JSON at the storage boundary: exact numbers and literal object keys.
//!
//! `serde_json::Value` treats some real object keys as internal Number/RawValue
//! markers when those features are enabled. Decode containers as raw members
//! first, so only a JSON number token can become a Number.
use std::collections::BTreeMap;

use serde::de::Error as _;
use serde_json::{value::RawValue, Value};

const MAX_DEPTH: usize = 128;

pub fn from_str(input: &str) -> serde_json::Result<Value> {
    let raw: &RawValue = serde_json::from_str(input)?;
    from_raw(raw, 0)
}

pub fn from_slice(input: &[u8]) -> serde_json::Result<Value> {
    let raw: &RawValue = serde_json::from_slice(input)?;
    from_raw(raw, 0)
}

fn from_raw(raw: &RawValue, depth: usize) -> serde_json::Result<Value> {
    if depth >= MAX_DEPTH {
        return Err(serde_json::Error::custom("JSON nesting limit exceeded"));
    }
    match raw.get().as_bytes()[0] {
        b'{' => {
            let fields: BTreeMap<String, &RawValue> = serde_json::from_str(raw.get())?;
            fields
                .into_iter()
                .map(|(key, value)| Ok((key, from_raw(value, depth + 1)?)))
                .collect::<serde_json::Result<_>>()
                .map(Value::Object)
        }
        b'[' => {
            let elements: Vec<&RawValue> = serde_json::from_str(raw.get())?;
            elements
                .into_iter()
                .map(|value| from_raw(value, depth + 1))
                .collect::<serde_json::Result<_>>()
                .map(Value::Array)
        }
        _ => serde_json::from_str(raw.get()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precise_numbers_and_literal_internal_keys_survive_roundtrip() {
        let input = r#"{"n":123456789012345678901234567890,"f":1.2345678901234567890123456789,"number":{"$serde_json::private::Number":"123"},"raw":{"$serde_json::private::RawValue":"{\"lost\":true}"},"nested":[{"$serde_json::private::Number":null,"other":false}],"escaped":{"\u0024serde_json::private::Number":"not a number"}}"#;
        let value = from_str(input).unwrap();
        assert_eq!(value["n"].to_string(), "123456789012345678901234567890");
        assert_eq!(value["f"].to_string(), "1.2345678901234567890123456789");
        assert_eq!(value["number"]["$serde_json::private::Number"], "123");
        assert_eq!(value["raw"]["$serde_json::private::RawValue"], "{\"lost\":true}");
        assert!(value["nested"][0]["$serde_json::private::Number"].is_null());
        assert_eq!(value["nested"][0]["other"], false);
        assert_eq!(value["escaped"]["$serde_json::private::Number"], "not a number");
        assert_eq!(from_slice(&serde_json::to_vec(&value).unwrap()).unwrap(), value);
    }

    #[test]
    fn accepts_all_json_shapes_and_rejects_invalid_or_deep_input() {
        for input in ["null", "true", "false", "[]", "{}", "\"text\"", "-42", "1e400", "1.00"] {
            let value = from_str(input).unwrap();
            assert_eq!(from_slice(&serde_json::to_vec(&value).unwrap()).unwrap(), value);
        }
        for input in ["", "{} trailing", "[1,]", "{\"x\":}", "NaN", "01"] {
            assert!(from_str(input).is_err(), "accepted invalid JSON");
        }
        assert!(from_slice(&[0xff]).is_err());
        assert!(from_str(&format!("{}0{}", "[".repeat(128), "]".repeat(128))).is_err());
    }
}
