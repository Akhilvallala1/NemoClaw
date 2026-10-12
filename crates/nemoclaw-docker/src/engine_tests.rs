// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
#[tokio::test]
async fn docker_transport_distinguishes_confirmed_absence_from_failed_observation() {
    for (status, body, absent) in [
        (404, r#"{"message":"missing"}"#, true),
        (403, r#"{"message":"secret-sentinel"}"#, false),
        (500, r#"{"message":"secret-sentinel"}"#, false),
        (200, "{", false),
    ] {
        let server =
            crate::fixture::Fixture::start(move |_| Some((status, body.as_bytes().to_vec()))).await;
        let engine = Engine::connect(&server.endpoint).unwrap();
        let observed = engine.container("owned").await;
        if absent {
            assert!(observed.unwrap().is_none());
        } else {
            let error = observed.unwrap_err();
            assert!(!error.to_string().contains("secret-sentinel"));
        }
    }
}
#[test]
fn archive_observation_requires_one_complete_regular_file_within_limit() {
    let good = archive(&[("status.json", b"ready".as_slice(), 0o600)]).unwrap();
    assert_eq!(
        read_entry_archive(&good, 128, false).unwrap().bytes,
        b"ready"
    );
    assert!(read_entry_archive(&good, 4, false).is_err());
    assert!(read_entry_archive(&good[..514], 128, false).is_err());
    let duplicate = archive(&[
        ("first", b"ready".as_slice(), 0o600),
        ("second", b"unexpected".as_slice(), 0o600),
    ])
    .unwrap();
    assert!(read_entry_archive(&duplicate, 128, false).is_err());
    assert!(read_entry_archive(b"", 128, false).is_err());
}

#[test]
fn checked_archive_metadata_rejects_links_extensions_and_corrupt_headers() {
    let mut header = tar::Header::new_gnu();
    header.set_size(0);
    header.set_mode(0o700);
    header.set_uid(65532);
    header.set_gid(65531);
    header.set_entry_type(tar::EntryType::Directory);
    header.set_cksum();
    let directory = read_entry_archive(header.as_bytes(), 0, true).unwrap();
    assert_eq!(
        (directory.uid, directory.gid, directory.mode),
        (Some(65532), Some(65531), Some(0o700))
    );
    assert!(directory.bytes.is_empty());
    assert!(read_entry_archive(header.as_bytes(), 4096, false).is_err());
    assert!(read_entry_archive(&header.as_bytes()[..511], 0, true).is_err());
    for kind in [
        tar::EntryType::Symlink,
        tar::EntryType::Link,
        tar::EntryType::XHeader,
        tar::EntryType::XGlobalHeader,
    ] {
        header.set_entry_type(kind);
        header.set_cksum();
        assert!(read_entry_archive(header.as_bytes(), 4096, false).is_err());
        assert!(read_entry_archive(header.as_bytes(), 0, true).is_err());
    }
    header.set_entry_type(tar::EntryType::Directory);
    header.set_cksum();
    header.as_mut_bytes()[0] = b'x';
    assert!(read_entry_archive(header.as_bytes(), 0, true).is_err());
}

#[tokio::test]
async fn archive_transport_bounds_reads_and_distinguishes_missing_paths() {
    let good = archive(&[("token", b"ready".as_slice(), 0o600)]).unwrap();
    for (status, bytes, absent, valid) in [
        (404, vec![], true, false),
        (401, vec![], false, false),
        (403, vec![], false, false),
        (503, vec![], false, false),
        (200, good.clone(), false, true),
        (200, good[..514].to_vec(), false, false),
        (200, vec![0; 8192 + 129], false, false),
    ] {
        let fixture = crate::fixture::Fixture::start(move |_| Some((status, bytes.clone()))).await;
        let result = Engine::connect(&fixture.endpoint)
            .unwrap()
            .read_file("owned", "/token", 128)
            .await;
        if absent {
            assert!(result.unwrap().is_none());
        } else if valid {
            assert_eq!(result.unwrap().unwrap(), b"ready");
        } else {
            assert!(result.is_err());
        }
    }
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Directory);
    header.set_mode(0o700);
    header.set_uid(65532);
    header.set_gid(65532);
    header.set_size(0);
    header.set_cksum();
    // The unrelated directory contents exceed the file bound; only the first header is read.
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend(vec![0; 65536]);
    let fixture = crate::fixture::Fixture::start(move |_| Some((200, bytes.clone()))).await;
    let entry = Engine::connect(&fixture.endpoint)
        .unwrap()
        .read_entry("owned", "/data", 0, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (entry.uid, entry.gid, entry.mode),
        (Some(65532), Some(65532), Some(0o700))
    );
    assert!(entry.bytes.is_empty());
}
