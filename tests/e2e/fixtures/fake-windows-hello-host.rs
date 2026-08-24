use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn json_string(input: &str, key: &str) -> Option<String> {
    let marker = format!("\"{}\"", key);
    let start = input.find(&marker)? + marker.len();
    let value = input[start..].find(':')? + start + 1;
    let quote = input[value..].find('"')? + value + 1;
    let end = input[quote..].find('"')? + quote;
    Some(input[quote..end].to_string())
}

fn mode() -> String {
    env::var("MONICA_FAKE_HELLO_CONTROL")
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_else(|| "success".to_string())
        .trim()
        .to_string()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn result(request_id: &str, value: String) -> String {
    format!(r#"{{"protocol":2,"requestId":"{}","ok":true,"result":{}}}"#, request_id, value)
}

fn error(request_id: &str, code: &str, message: &str) -> String {
    format!(r#"{{"protocol":2,"requestId":"{}","ok":false,"error":{{"code":"{}","message":"{}","retryable":false}}}}"#, request_id, code, message)
}

fn respond(input: &str) -> String {
    let request_id = json_string(input, "requestId").unwrap_or_else(|| "invalid".to_string());
    let method = json_string(input, "method").unwrap_or_default();
    let binding_id = json_string(input, "bindingId");
    match method.as_str() {
        "hello.status" => {
            let enrolled = binding_id.is_some();
            result(&request_id, format!(r#"{{"version":1,"supported":true,"available":true,"enrolled":{},"bindingIdPresent":{},"rpId":"monica-extension.local","reason":"{}"}}"#, enrolled, enrolled, if enrolled { "ready" } else { "not-enrolled" }))
        }
        "hello.enroll" => result(&request_id, format!(r#"{{"version":1,"bindingId":"{}","rpId":"monica-extension.local","enrolledAtUnixSeconds":{},"verified":true}}"#, binding_id.unwrap_or_default(), now())),
        "hello.verify" => {
            let control = mode();
            if control == "cancel" {
                error(&request_id, "hello-cancelled", "Windows Hello test cancellation")
            } else {
                if let Some(delay) = control.strip_prefix("delay:").and_then(|value| value.parse::<u64>().ok()) {
                    thread::sleep(Duration::from_millis(delay.min(5_000)));
                }
                result(&request_id, format!(r#"{{"version":1,"verified":true,"bindingId":"{}","proofId":"11111111-1111-4111-8111-111111111111","expiresAtUnixSeconds":{}}}"#, binding_id.unwrap_or_default(), now() + 60))
            }
        }
        "hello.revoke" => result(&request_id, format!(r#"{{"version":1,"bindingId":"{}","revoked":true}}"#, binding_id.unwrap_or_default())),
        _ => error(&request_id, "method-not-supported", "Unsupported test method"),
    }
}

fn main() -> io::Result<()> {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    loop {
        let mut header = [0u8; 4];
        match stdin.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error),
        }
        let length = u32::from_le_bytes(header) as usize;
        if length == 0 || length > 1024 * 1024 { break; }
        let mut body = vec![0u8; length];
        stdin.read_exact(&mut body)?;
        let response = respond(&String::from_utf8_lossy(&body)).into_bytes();
        stdout.write_all(&(response.len() as u32).to_le_bytes())?;
        stdout.write_all(&response)?;
        stdout.flush()?;
    }
    Ok(())
}
