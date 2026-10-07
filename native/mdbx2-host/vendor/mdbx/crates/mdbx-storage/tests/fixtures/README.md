# KDBX interoperability fixtures

`kdbx3-demopass.kdbx.b64` is the Base64 representation of
`tests/resources/test_db_with_password.kdbx` from
[`sseemayer/keepass-rs`](https://github.com/sseemayer/keepass-rs) tag
`v0.13.17`. The upstream project is MIT licensed. The fixture password is
`demopass` and the database identifies itself as KDBX3.1.

The encoded text is stored instead of a binary file so repository review and
line-ending handling remain deterministic. Tests remove ASCII whitespace before
decoding.
