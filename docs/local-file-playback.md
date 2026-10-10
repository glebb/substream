# Local file playback

LG webOS has no local-file picker, but its companion receiver supports local media staged from the paired browser/computer. The computer-to-TV flow below therefore works with a paired LG receiver when the app and companion service support protocol v4. Selecting files from LG storage or USB remains unavailable. Direct provider playback on LG is separate. See [LG setup](../webos/README.md).

The browser app can open one video file from the home screen, even when no IPTV playlist is configured. Selecting a file opens the existing VOD details screen first. From there, **Play on this computer** uses the browser player; **Play on TV** stages the file through the optional companion service and sends it to a paired TV. The app reuses its existing details and playback UI; there are no separate local-file details or player screens.

## Computer playback

Computer playback uses a browser object URL for the selected `File`. Video bytes stay in the browser and are not uploaded. Playback depends on the browser's codec/container support; the filename extension alone does not establish that the file will decode. A decoding failure has a local-file-specific message, and the viewer can select another file.

The selected file and object URL belong to the app's current local session. The URL is retained while the player may still be using it, including the return to details and Restart, then released after the player detaches when the local session ends or the file is replaced. The app does not add a local file to the VOD catalogue, Continue Watching, or persisted playback history. A reload requires selecting the file again. Subtitle timing starts at zero; ordinary app subtitle language/font preferences remain device settings.

The filename supplies the initial display and subtitle-search title. A filename with an explicit `SxxExx` or `1x02` pattern is labelled as a series episode with that evidence. Other names remain `other`; the app does not guess movie/series type from a filename. TMDb artwork or synopsis can be looked up when metadata credentials are configured and a result is available, but the local file remains usable without that enrichment.

## Subtitles

The player can open an external SRT or WebVTT subtitle file without an OpenSubtitles key or network access. If an OpenSubtitles key is configured, the app can search automatically using the filename-derived title and preferred subtitle language; explicit episode filenames also provide season/episode metadata. Search never submits video bytes or file paths. The subtitle title is editable, and users can choose another subtitle file. Local playback does not automatically appear in Continue Watching.

For TV playback, the active local subtitle attachment, enabled state, language, and timing offset can be published to the same local-media session. This transfer requires the paired companion service. It does not add subtitle text or a file path to the app's VOD catalogue.

## TV playback through the companion

The companion is optional to the app and to computer playback, but it is required to send a computer file to a TV. The computer running the browser must also run the companion service and remain awake and reachable while the TV reads the file. The browser stages bounded chunks on that computer; the TV reads the prepared media over authenticated byte-range requests. Pairing for local media does not require an IPTV playlist on the computer or TV. The computer acts as the media source, so disconnecting it interrupts playback.

The service needs `ffprobe` and `ffmpeg` on its `PATH`, or the corresponding `FFPROBE_PATH` and `FFMPEG_PATH` settings. It prepares an indexed MP4 before dispatch when needed. Compatible H.264 video is copied when it meets the service's dimensions, frame-rate, level, pixel-format, and bitrate checks. Compatible AAC or E-AC-3 audio can be copied; other containers may be remuxed. Incompatible video is encoded as H.264 up to 1080p/30 fps, with a 5 Mbps target ceiling; unsupported audio is encoded as stereo AAC. Mac systems try VideoToolbox for conversion and fall back to software encoding when possible. These are preparation rules, not a promise that every television decodes every output identically. Atmos output also depends on the TV and audio system.

The current service accepts two concurrent local-media sessions and defaults to a total staged/prepared-media quota of 100 GiB; `COMPANION_LOCAL_MEDIA_MAX_BYTES` changes that quota. Uploads use 4 MiB chunks. A prepared copy may require additional temporary disk space. Preparation can take several minutes and can be cancelled. The browser shows upload/preparation state before it enables TV playback.

The app keeps browser pairing state in root memory across routes and local file replacement. Changing the companion origin clears it; a full browser reload also clears it. The media and subtitle session is retained while TV playback is active and released on stop, expiry, or cleanup. The service uses short-lived TV-scoped tickets for media reads; seek and restart use byte ranges. Companion pairing sessions live in service memory, so a service restart may require reconnecting or pairing again. Keep a development service on a trusted LAN; without TLS, another device on the LAN may observe credentials.

See [Search and optional TV companion](companion-search.md) for app independence, setup, and companion troubleshooting. For coverage and synthetic scenarios, use the [verification guide](verification.md). Local-file support does not include directory browsing, Tizen USB browsing, or automatic next-file playback.
