# Synthetic remux fixture

`vod-remux-synthetic.mkv` contains one second of generated 64×64 H.264 video at 4 fps and mono 48 kHz AAC audio. It contains no provider media, URLs, or credentials.

An equivalent fixture can be generated with FFmpeg:

```sh
ffmpeg -f lavfi -i testsrc2=size=64x64:rate=4 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 1 -c:v libx264 -pix_fmt yuv420p -g 4 -c:a aac -y vod-remux-synthetic.mkv
```

`vod-remux-mixed-audio.mkv` uses the same generated video with a default AC3 track and an alternate Opus track. It checks capability-based selection and exact packet copying:

```sh
ffmpeg -i vod-remux-synthetic.mkv -map 0:v -map 0:a -map 0:a -c:v copy -c:a:0 ac3 -c:a:1 libopus -disposition:a:0 default -disposition:a:1 0 -y vod-remux-mixed-audio.mkv
```

`vod-remux-eac3.mkv` is the generated video with EAC3 audio for testing device-local AAC conversion without WebCodecs:

```sh
ffmpeg -i vod-remux-synthetic.mkv -c:v copy -c:a eac3 -y vod-remux-eac3.mkv
```
