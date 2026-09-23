#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::thread;
use std::time::{Duration, Instant};

const ASSIGNMENT_SCHEMA: &str = "overcenter-agent-assignment/v1";
const CANDIDATE_SCHEMA: &str = "overcenter-agent-candidate/v1";
const TASK_SCHEMA: &str = "overcenter-agent-task/v1";
const MAX_ASSIGNMENT_BYTES: usize = 16 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
enum Json {
    Null,
    Bool,
    Number(String),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

struct Parser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Parser<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn parse(mut self) -> Result<Json, String> {
        self.ws();
        let value = self.value()?;
        self.ws();
        if self.offset != self.bytes.len() {
            return Err("ASSIGNMENT_JSON_TRAILING_BYTES".to_owned());
        }
        Ok(value)
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.offset += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.offset).copied()
    }

    fn take(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.offset += 1;
        Some(byte)
    }

    fn expect(&mut self, expected: u8, code: &str) -> Result<(), String> {
        if self.take() == Some(expected) {
            Ok(())
        } else {
            Err(code.to_owned())
        }
    }

    fn literal(&mut self, rest: &[u8], value: Json) -> Result<Json, String> {
        if self.bytes.get(self.offset..self.offset + rest.len()) == Some(rest) {
            self.offset += rest.len();
            Ok(value)
        } else {
            Err("ASSIGNMENT_JSON_INVALID".to_owned())
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.ws();
        match self.take() {
            Some(b'n') => self.literal(b"ull", Json::Null),
            Some(b't') => self.literal(b"rue", Json::Bool),
            Some(b'f') => self.literal(b"alse", Json::Bool),
            Some(b'"') => Ok(Json::String(self.string_body()?)),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(first @ (b'-' | b'0'..=b'9')) => self.number(first),
            _ => Err("ASSIGNMENT_JSON_INVALID".to_owned()),
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        let mut values = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.offset += 1;
            return Ok(Json::Array(values));
        }
        loop {
            values.push(self.value()?);
            self.ws();
            match self.take() {
                Some(b',') => self.ws(),
                Some(b']') => return Ok(Json::Array(values)),
                _ => return Err("ASSIGNMENT_JSON_ARRAY_INVALID".to_owned()),
            }
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        let mut values = BTreeMap::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.offset += 1;
            return Ok(Json::Object(values));
        }
        loop {
            if self.take() != Some(b'"') {
                return Err("ASSIGNMENT_JSON_OBJECT_KEY_INVALID".to_owned());
            }
            let key = self.string_body()?;
            self.ws();
            self.expect(b':', "ASSIGNMENT_JSON_OBJECT_COLON_MISSING")?;
            let value = self.value()?;
            if values.insert(key, value).is_some() {
                return Err("ASSIGNMENT_JSON_DUPLICATE_KEY".to_owned());
            }
            self.ws();
            match self.take() {
                Some(b',') => self.ws(),
                Some(b'}') => return Ok(Json::Object(values)),
                _ => return Err("ASSIGNMENT_JSON_OBJECT_INVALID".to_owned()),
            }
        }
    }

    fn number(&mut self, first: u8) -> Result<Json, String> {
        let start = self.offset - 1;
        if first == b'-' {
            match self.peek() {
                Some(b'0'..=b'9') => self.offset += 1,
                _ => return Err("ASSIGNMENT_JSON_NUMBER_INVALID".to_owned()),
            }
        }
        let integer_start = if first == b'-' { start + 1 } else { start };
        if self.bytes[integer_start] == b'0' {
            if matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err("ASSIGNMENT_JSON_NUMBER_INVALID".to_owned());
            }
        } else {
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
        }
        if self.peek() == Some(b'.') {
            self.offset += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err("ASSIGNMENT_JSON_NUMBER_INVALID".to_owned());
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err("ASSIGNMENT_JSON_NUMBER_INVALID".to_owned());
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
        }
        let raw = std::str::from_utf8(&self.bytes[start..self.offset])
            .map_err(|_| "ASSIGNMENT_JSON_NUMBER_INVALID".to_owned())?;
        Ok(Json::Number(raw.to_owned()))
    }

    fn string_body(&mut self) -> Result<String, String> {
        let mut out = Vec::new();
        loop {
            let byte = self
                .take()
                .ok_or_else(|| "ASSIGNMENT_JSON_STRING_UNTERMINATED".to_owned())?;
            match byte {
                b'"' => {
                    return String::from_utf8(out)
                        .map_err(|_| "ASSIGNMENT_JSON_STRING_UTF8_INVALID".to_owned());
                }
                b'\\' => {
                    let escaped = self
                        .take()
                        .ok_or_else(|| "ASSIGNMENT_JSON_ESCAPE_INVALID".to_owned())?;
                    match escaped {
                        b'"' | b'\\' | b'/' => out.push(escaped),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0c),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let high = self.hex4()?;
                            let scalar = if (0xd800..=0xdbff).contains(&high) {
                                if self.take() != Some(b'\\') || self.take() != Some(b'u') {
                                    return Err("ASSIGNMENT_JSON_SURROGATE_INVALID".to_owned());
                                }
                                let low = self.hex4()?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return Err("ASSIGNMENT_JSON_SURROGATE_INVALID".to_owned());
                                }
                                0x10000 + (((high as u32) - 0xd800) << 10) + ((low as u32) - 0xdc00)
                            } else if (0xdc00..=0xdfff).contains(&high) {
                                return Err("ASSIGNMENT_JSON_SURROGATE_INVALID".to_owned());
                            } else {
                                high as u32
                            };
                            let ch = char::from_u32(scalar)
                                .ok_or_else(|| "ASSIGNMENT_JSON_UNICODE_INVALID".to_owned())?;
                            let mut encoded = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut encoded).as_bytes());
                        }
                        _ => return Err("ASSIGNMENT_JSON_ESCAPE_INVALID".to_owned()),
                    }
                }
                0x00..=0x1f => return Err("ASSIGNMENT_JSON_CONTROL_INVALID".to_owned()),
                _ => out.push(byte),
            }
        }
    }

    fn hex4(&mut self) -> Result<u16, String> {
        let mut value = 0u16;
        for _ in 0..4 {
            let byte = self
                .take()
                .ok_or_else(|| "ASSIGNMENT_JSON_UNICODE_INVALID".to_owned())?;
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err("ASSIGNMENT_JSON_UNICODE_INVALID".to_owned()),
            };
            value = (value << 4) | u16::from(digit);
        }
        Ok(value)
    }
}

fn object<'a>(value: &'a Json, code: &str) -> Result<&'a BTreeMap<String, Json>, String> {
    match value {
        Json::Object(value) => Ok(value),
        _ => Err(code.to_owned()),
    }
}

fn array<'a>(value: &'a Json, code: &str) -> Result<&'a [Json], String> {
    match value {
        Json::Array(value) => Ok(value),
        _ => Err(code.to_owned()),
    }
}

fn string<'a>(value: &'a Json, code: &str) -> Result<&'a str, String> {
    match value {
        Json::String(value) => Ok(value),
        _ => Err(code.to_owned()),
    }
}

fn positive_u64(value: &Json, code: &str) -> Result<u64, String> {
    match value {
        Json::Number(raw)
            if !raw.starts_with('-')
                && !raw.contains('.')
                && !raw.contains('e')
                && !raw.contains('E') =>
        {
            let parsed = raw.parse::<u64>().map_err(|_| code.to_owned())?;
            if parsed > 0 {
                Ok(parsed)
            } else {
                Err(code.to_owned())
            }
        }
        _ => Err(code.to_owned()),
    }
}

fn field<'a>(
    value: &'a BTreeMap<String, Json>,
    name: &str,
    code: &str,
) -> Result<&'a Json, String> {
    value.get(name).ok_or_else(|| code.to_owned())
}

fn exact_keys(value: &BTreeMap<String, Json>, required: &[&str], code: &str) -> Result<(), String> {
    let actual: BTreeSet<&str> = value.keys().map(String::as_str).collect();
    let expected: BTreeSet<&str> = required.iter().copied().collect();
    if actual == expected {
        Ok(())
    } else {
        Err(code.to_owned())
    }
}

fn valid_path(value: &str) -> bool {
    if value.is_empty() || value.starts_with('/') || value.bytes().any(|b| b < 32 || b == 127) {
        return false;
    }
    value
        .split('/')
        .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug)]
struct AssignmentFile {
    path: String,
    mode: u32,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct Assignment {
    obligation_id: String,
    run_id: String,
    claimed_revision: String,
    command: Vec<String>,
    output_path: String,
    files: Vec<AssignmentFile>,
}

fn validate_assignment(root: &Json) -> Result<Assignment, String> {
    let assignment = object(root, "ASSIGNMENT_INVALID")?;
    exact_keys(
        assignment,
        &["schema", "work", "files"],
        "ASSIGNMENT_SHAPE_INVALID",
    )?;
    if string(
        field(assignment, "schema", "ASSIGNMENT_SCHEMA_MISSING")?,
        "ASSIGNMENT_SCHEMA_INVALID",
    )? != ASSIGNMENT_SCHEMA
    {
        return Err("ASSIGNMENT_SCHEMA_MISMATCH".to_owned());
    }

    let work = object(
        field(assignment, "work", "ASSIGNMENT_WORK_MISSING")?,
        "ASSIGNMENT_WORK_INVALID",
    )?;
    let obligation_id = string(
        field(work, "id", "ASSIGNMENT_WORK_ID_MISSING")?,
        "ASSIGNMENT_WORK_ID_INVALID",
    )?
    .to_owned();
    let revision = string(
        field(work, "revision", "ASSIGNMENT_WORK_REVISION_MISSING")?,
        "ASSIGNMENT_WORK_REVISION_INVALID",
    )?;
    let run_id = string(
        field(work, "run_id", "ASSIGNMENT_WORK_RUN_ID_MISSING")?,
        "ASSIGNMENT_WORK_RUN_ID_INVALID",
    )?
    .to_owned();
    let claimed_revision = string(
        field(
            work,
            "claimed_revision",
            "ASSIGNMENT_WORK_CLAIMED_REVISION_MISSING",
        )?,
        "ASSIGNMENT_WORK_CLAIMED_REVISION_INVALID",
    )?
    .to_owned();
    for (name, value) in [
        ("id", obligation_id.as_str()),
        ("revision", revision),
        ("run_id", run_id.as_str()),
        ("claimed_revision", claimed_revision.as_str()),
    ] {
        if value.is_empty() {
            return Err(format!(
                "ASSIGNMENT_WORK_{}_INVALID",
                name.to_ascii_uppercase()
            ));
        }
    }
    if string(
        field(work, "status", "ASSIGNMENT_WORK_STATUS_MISSING")?,
        "ASSIGNMENT_WORK_STATUS_INVALID",
    )? != "EXECUTING"
    {
        return Err("ASSIGNMENT_WORK_NOT_EXECUTING".to_owned());
    }
    positive_u64(
        field(
            work,
            "execution_generation",
            "ASSIGNMENT_EXECUTION_GENERATION_MISSING",
        )?,
        "ASSIGNMENT_EXECUTION_GENERATION_INVALID",
    )?;

    let packet = object(
        field(work, "packet", "ASSIGNMENT_PACKET_MISSING")?,
        "ASSIGNMENT_PACKET_INVALID",
    )?;
    exact_keys(
        packet,
        &[
            "schema",
            "kind",
            "source_sha",
            "command",
            "required_paths",
            "output_path",
        ],
        "ASSIGNMENT_PACKET_SHAPE_INVALID",
    )?;
    if string(
        field(packet, "schema", "ASSIGNMENT_PACKET_SCHEMA_MISSING")?,
        "ASSIGNMENT_PACKET_SCHEMA_INVALID",
    )? != TASK_SCHEMA
    {
        return Err("ASSIGNMENT_PACKET_SCHEMA_MISMATCH".to_owned());
    }
    if string(
        field(packet, "kind", "ASSIGNMENT_PACKET_KIND_MISSING")?,
        "ASSIGNMENT_PACKET_KIND_INVALID",
    )? != "pure-candidate"
    {
        return Err("ASSIGNMENT_PACKET_KIND_INVALID".to_owned());
    }
    let source_sha = string(
        field(packet, "source_sha", "ASSIGNMENT_SOURCE_SHA_MISSING")?,
        "ASSIGNMENT_SOURCE_SHA_INVALID",
    )?;
    if !lower_hex(source_sha, 40) {
        return Err("ASSIGNMENT_SOURCE_SHA_INVALID".to_owned());
    }

    let command_values = array(
        field(packet, "command", "ASSIGNMENT_COMMAND_MISSING")?,
        "ASSIGNMENT_COMMAND_INVALID",
    )?;
    if command_values.is_empty() {
        return Err("ASSIGNMENT_COMMAND_INVALID".to_owned());
    }
    let mut command = Vec::with_capacity(command_values.len());
    for value in command_values {
        let part = string(value, "ASSIGNMENT_COMMAND_INVALID")?;
        if part.is_empty() {
            return Err("ASSIGNMENT_COMMAND_INVALID".to_owned());
        }
        command.push(part.to_owned());
    }

    let required_values = array(
        field(
            packet,
            "required_paths",
            "ASSIGNMENT_REQUIRED_PATHS_MISSING",
        )?,
        "ASSIGNMENT_REQUIRED_PATHS_INVALID",
    )?;
    if required_values.is_empty() {
        return Err("ASSIGNMENT_REQUIRED_PATHS_INVALID".to_owned());
    }
    let mut required_paths = BTreeSet::new();
    for value in required_values {
        let path = string(value, "ASSIGNMENT_REQUIRED_PATHS_INVALID")?;
        if !valid_path(path) {
            return Err("ASSIGNMENT_REQUIRED_PATHS_INVALID".to_owned());
        }
        if !required_paths.insert(path.to_owned()) {
            return Err("ASSIGNMENT_REQUIRED_PATHS_DUPLICATE".to_owned());
        }
    }
    let output_path = string(
        field(packet, "output_path", "ASSIGNMENT_OUTPUT_PATH_MISSING")?,
        "ASSIGNMENT_OUTPUT_PATH_INVALID",
    )?
    .to_owned();
    if !valid_path(&output_path) {
        return Err("ASSIGNMENT_OUTPUT_PATH_INVALID".to_owned());
    }

    let file_values = array(
        field(assignment, "files", "ASSIGNMENT_FILES_MISSING")?,
        "ASSIGNMENT_FILES_INVALID",
    )?;
    if file_values.is_empty() {
        return Err("ASSIGNMENT_FILES_INVALID".to_owned());
    }
    let mut files = Vec::with_capacity(file_values.len());
    let mut file_paths = BTreeSet::new();
    for value in file_values {
        let file = object(value, "ASSIGNMENT_FILE_INVALID")?;
        exact_keys(
            file,
            &["path", "mode", "sha256", "content_base64"],
            "ASSIGNMENT_FILE_SHAPE_INVALID",
        )?;
        let path = string(
            field(file, "path", "ASSIGNMENT_FILE_PATH_MISSING")?,
            "ASSIGNMENT_FILE_PATH_INVALID",
        )?
        .to_owned();
        if !valid_path(&path) {
            return Err("ASSIGNMENT_FILE_PATH_INVALID".to_owned());
        }
        if !file_paths.insert(path.clone()) {
            return Err("ASSIGNMENT_FILE_PATH_DUPLICATE".to_owned());
        }
        let mode = match string(
            field(file, "mode", "ASSIGNMENT_FILE_MODE_MISSING")?,
            "ASSIGNMENT_FILE_MODE_INVALID",
        )? {
            "100644" => 0o644,
            "100755" => 0o755,
            _ => return Err("ASSIGNMENT_FILE_MODE_INVALID".to_owned()),
        };
        let expected_sha = string(
            field(file, "sha256", "ASSIGNMENT_FILE_SHA256_MISSING")?,
            "ASSIGNMENT_FILE_SHA256_INVALID",
        )?;
        if !lower_hex(expected_sha, 64) {
            return Err("ASSIGNMENT_FILE_SHA256_INVALID".to_owned());
        }
        let content = string(
            field(file, "content_base64", "ASSIGNMENT_FILE_BASE64_MISSING")?,
            "ASSIGNMENT_FILE_BASE64_INVALID",
        )?;
        let bytes = base64_decode(content)?;
        if sha256_hex(&bytes) != expected_sha {
            return Err("ASSIGNMENT_FILE_DIGEST_MISMATCH".to_owned());
        }
        files.push(AssignmentFile { path, mode, bytes });
    }
    for required in required_paths {
        if !file_paths.contains(&required) {
            return Err(format!("ASSIGNMENT_REQUIRED_FILE_MISSING:{required}"));
        }
    }

    Ok(Assignment {
        obligation_id,
        run_id,
        claimed_revision,
        command,
        output_path,
        files,
    })
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn base64_decode(value: &str) -> Result<Vec<u8>, String> {
    let input = value.as_bytes();
    if input.len() % 4 != 0 {
        return Err("ASSIGNMENT_FILE_BASE64_INVALID".to_owned());
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    for (index, chunk) in input.chunks_exact(4).enumerate() {
        let last = index + 1 == input.len() / 4;
        let a =
            base64_value(chunk[0]).ok_or_else(|| "ASSIGNMENT_FILE_BASE64_INVALID".to_owned())?;
        let b =
            base64_value(chunk[1]).ok_or_else(|| "ASSIGNMENT_FILE_BASE64_INVALID".to_owned())?;
        let c_pad = chunk[2] == b'=';
        let d_pad = chunk[3] == b'=';
        if c_pad && !d_pad {
            return Err("ASSIGNMENT_FILE_BASE64_INVALID".to_owned());
        }
        if (c_pad || d_pad) && !last {
            return Err("ASSIGNMENT_FILE_BASE64_INVALID".to_owned());
        }
        let c = if c_pad {
            0
        } else {
            base64_value(chunk[2]).ok_or_else(|| "ASSIGNMENT_FILE_BASE64_INVALID".to_owned())?
        };
        let d = if d_pad {
            0
        } else {
            base64_value(chunk[3]).ok_or_else(|| "ASSIGNMENT_FILE_BASE64_INVALID".to_owned())?
        };
        out.push((a << 2) | (b >> 4));
        if !c_pad {
            out.push((b << 4) | (c >> 2));
        }
        if !d_pad {
            out.push((c << 6) | d);
        }
    }
    if base64_encode(&out) != value {
        return Err("ASSIGNMENT_FILE_BASE64_INVALID".to_owned());
    }
    Ok(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = *chunk.get(1).unwrap_or(&0);
        let c = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(a >> 2) as usize] as char);
        out.push(TABLE[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(c & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha256(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        write!(&mut out, "{byte:02x}").expect("write to string");
    }
    out
}

fn sha256(input: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut padded = input.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in w[..16].iter_mut().enumerate() {
            let start = i * 4;
            *word = u32::from_be_bytes([
                chunk[start],
                chunk[start + 1],
                chunk[start + 2],
                chunk[start + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut a = state[0];
        let mut b = state[1];
        let mut c = state[2];
        let mut d = state[3];
        let mut e = state[4];
        let mut f = state[5];
        let mut g = state[6];
        let mut h = state[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    let mut out = [0u8; 32];
    for (index, word) in state.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn list_files(root: &Path, prefix: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries =
        fs::read_dir(root).map_err(|error| format!("ASSIGNMENT_WORKSPACE_READ_FAILED:{error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("ASSIGNMENT_WORKSPACE_READ_FAILED:{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("ASSIGNMENT_WORKSPACE_STAT_FAILED:{error}"))?;
        let relative = prefix.join(entry.file_name());
        if file_type.is_dir() {
            list_files(&entry.path(), &relative, out)?;
        } else if file_type.is_file() {
            out.push(relative);
        } else {
            return Err(format!(
                "ASSIGNMENT_WORKSPACE_ENTRY_INVALID:{}",
                relative.display()
            ));
        }
    }
    Ok(())
}

fn materialize(assignment: &Assignment, workspace: &Path) -> Result<(), String> {
    fs::create_dir_all(workspace)
        .map_err(|error| format!("ASSIGNMENT_WORKSPACE_CREATE_FAILED:{error}"))?;
    if fs::read_dir(workspace)
        .map_err(|error| format!("ASSIGNMENT_WORKSPACE_READ_FAILED:{error}"))?
        .next()
        .is_some()
    {
        return Err("ASSIGNMENT_WORKSPACE_NOT_EMPTY".to_owned());
    }

    for file in &assignment.files {
        let target = workspace.join(&file.path);
        let parent = target
            .parent()
            .ok_or_else(|| "ASSIGNMENT_FILE_PATH_INVALID".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("ASSIGNMENT_FILE_PARENT_CREATE_FAILED:{error}"))?;
        let mut handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| format!("ASSIGNMENT_FILE_CREATE_FAILED:{}:{error}", file.path))?;
        handle
            .write_all(&file.bytes)
            .map_err(|error| format!("ASSIGNMENT_FILE_WRITE_FAILED:{}:{error}", file.path))?;
        fs::set_permissions(&target, fs::Permissions::from_mode(file.mode))
            .map_err(|error| format!("ASSIGNMENT_FILE_MODE_FAILED:{}:{error}", file.path))?;
    }

    let mut actual = Vec::new();
    list_files(workspace, Path::new(""), &mut actual)?;
    actual.sort();
    let mut expected: Vec<PathBuf> = assignment
        .files
        .iter()
        .map(|file| PathBuf::from(&file.path))
        .collect();
    expected.sort();
    if actual != expected {
        return Err("ASSIGNMENT_WORKSPACE_MEMBERSHIP_MISMATCH".to_owned());
    }
    Ok(())
}

fn run_task(assignment: &Assignment, workspace: &Path) -> Result<(), String> {
    let path = env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into());
    let mut child = Command::new(&assignment.command[0])
        .args(&assignment.command[1..])
        .current_dir(workspace)
        .env_clear()
        .env("PATH", path)
        .spawn()
        .map_err(|error| format!("ASSIGNMENT_COMMAND_START_FAILED:{error}"))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("ASSIGNMENT_COMMAND_WAIT_FAILED:{error}"))?
        {
            if status.success() {
                return Ok(());
            }
            return Err(format!(
                "ASSIGNMENT_COMMAND_FAILED:{}",
                status
                    .code()
                    .map_or_else(|| "signal".to_owned(), |code| code.to_string())
            ));
        }
        if started.elapsed() >= TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("ASSIGNMENT_COMMAND_TIMEOUT".to_owned());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch < '\u{20}' => {
                write!(&mut out, "\\u{:04x}", ch as u32).expect("write to string");
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn run(assignment_path: &Path, workspace: &Path, candidate_path: &Path) -> Result<(), String> {
    let assignment_bytes =
        fs::read(assignment_path).map_err(|error| format!("ASSIGNMENT_READ_FAILED:{error}"))?;
    if assignment_bytes.len() > MAX_ASSIGNMENT_BYTES {
        return Err("ASSIGNMENT_TOO_LARGE".to_owned());
    }
    let parsed = Parser::new(&assignment_bytes).parse()?;
    let assignment = validate_assignment(&parsed)?;
    materialize(&assignment, workspace)?;
    run_task(&assignment, workspace)?;

    let output_file = workspace.join(&assignment.output_path);
    let metadata =
        fs::symlink_metadata(&output_file).map_err(|_| "ASSIGNMENT_OUTPUT_MISSING".to_owned())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("ASSIGNMENT_OUTPUT_MISSING".to_owned());
    }
    let output =
        fs::read(&output_file).map_err(|error| format!("ASSIGNMENT_OUTPUT_READ_FAILED:{error}"))?;
    let candidate = format!(
        "{{\n  \"schema\": {},\n  \"assignment_sha256\": {},\n  \"obligation_id\": {},\n  \"run_id\": {},\n  \"claimed_revision\": {},\n  \"output_path\": {},\n  \"output_sha256\": {},\n  \"output_base64\": {}\n}}\n",
        json_string(CANDIDATE_SCHEMA),
        json_string(&sha256_hex(&assignment_bytes)),
        json_string(&assignment.obligation_id),
        json_string(&assignment.run_id),
        json_string(&assignment.claimed_revision),
        json_string(&assignment.output_path),
        json_string(&sha256_hex(&output)),
        json_string(&base64_encode(&output)),
    );
    if let Some(parent) = candidate_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("CANDIDATE_PARENT_CREATE_FAILED:{error}"))?;
    }
    let mut file =
        File::create(candidate_path).map_err(|error| format!("CANDIDATE_CREATE_FAILED:{error}"))?;
    file.write_all(candidate.as_bytes())
        .map_err(|error| format!("CANDIDATE_WRITE_FAILED:{error}"))?;
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<_> = env::args_os().collect();
    if args.len() != 5 || args[1] != "run" {
        eprintln!("usage: overcenter run <assignment.json> <workspace> <candidate.json>");
        return ExitCode::from(2);
    }
    match run(
        Path::new(&args[2]),
        Path::new(&args[3]),
        Path::new(&args[4]),
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("overcenter: {error}");
            ExitCode::from(2)
        }
    }
}
