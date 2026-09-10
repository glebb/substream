# Standalone catalog storage

The playlist currently contains more than 244,000 on-demand entries. The TV app must not put that raw playlist into `localStorage` (Samsung limits Web Storage to 5 MB) or render the full collection in memory.

Use IndexedDB for VOD records and query only bounded result sets. The Tizen package must request `http://tizen.org/privilege/unlimitedstorage`; Samsung documents IndexedDB as partial support under that privilege.

Import behavior:

1. Download the playlist to `wgt-private-tmp` with the Tizen Download API.
2. Keep only `vod` entries.
3. Read the temporary file in 64 KiB chunks and parse each chunk incrementally.
4. Write catalog records in 500-item IndexedDB transactions.
5. Store group metadata separately.
6. Mark the import ready only after every batch completes.

The temporary source file is deleted after a completed import. The Tizen package will need `download`, `filesystem.read`, `filesystem.write`, and `unlimitedstorage` privileges.
