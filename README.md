# atmosify

Batch-convert TrueHD Atmos tracks in MKV files to Dolby Digital Plus Atmos (E-AC-3 JOC).

Many players, streaming boxes and TVs can pass DD+ Atmos through to an AV receiver but not TrueHD Atmos. atmosify finds every TrueHD Atmos track in your MKVs, encodes each one to DD+ Atmos with [DeeZy](https://github.com/jessielw/DeeZy) and the Dolby Encoding Engine, and muxes the new tracks back in with [MKVToolNix](https://mkvtoolnix.download/). The original tracks are kept by default.

```
atmosify "Movie (2024).mkv"
atmosify D:\Movies --dry-run
```

## How it works

For each MKV file:

1. **Detect.** atmosify reads the tracks with `mkvmerge` and `ffprobe`. ffprobe's profile tells TrueHD Atmos apart from plain TrueHD, and DD+ Atmos apart from plain DD+.
2. **Pick tracks.** Every TrueHD Atmos track gets converted, so a German and an English Atmos track are both handled in one run. A track is skipped if the file already has a DD+ Atmos track in the same language, which makes reruns safe.
3. **Encode.** `deezy encode atmos --atmos-mode streaming` runs once per track, at 768 kbps by default.
4. **Mux.** Each new track is placed directly before its TrueHD source and gets the same language. It becomes the default track only if its source was the default.
5. **Verify.** Track count, DD+ Atmos tracks and duration are checked before anything is replaced. Temporary files are removed afterwards.

Files without a TrueHD Atmos track are left untouched.

## Download

Get a binary from the [Releases](https://github.com/SyntaxxHD/atmosify/releases) page. Windows x64 and Linux x64 are supported.

| Build                       | Includes                                         | You install                             |
| --------------------------- | ------------------------------------------------ | --------------------------------------- |
| `atmosify-<os>-x64`         | atmosify only                                    | DEE, DeeZy, truehdd, FFmpeg, MKVToolNix |
| `atmosify-<os>-x64-bundled` | atmosify + DeeZy + truehdd + FFmpeg + MKVToolNix | DEE                                     |

The bundled build is larger (about 310 MB) but only needs the Dolby Encoding Engine. On first run it unpacks its tools into `%LOCALAPPDATA%\atmosify\<version>` on Windows, or `~/.cache/atmosify/<version>` on Linux. The Linux bundle needs glibc 2.28 or newer.

## Requirements

| Tool                            | Where to get it                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Dolby Encoding Engine (DEE)** | From Dolby. It is licensed software and cannot be bundled. Needed by both builds.                                                   |
| **FFmpeg** (with `ffprobe`)     | Standard build only. Windows: `winget install Gyan.FFmpeg` · Linux: `apt install ffmpeg` / `dnf install ffmpeg`                     |
| **MKVToolNix**                  | Standard build only. Windows: `winget install MoritzBunkus.MKVToolNix` · Linux: `apt install mkvtoolnix` / `dnf install mkvtoolnix` |
| **DeeZy**                       | Standard build only: [releases](https://github.com/jessielw/DeeZy/releases)                                                         |
| **truehdd**                     | Standard build only: [releases](https://github.com/truehdd/truehdd/releases)                                                        |

atmosify looks for each tool in this order:

1. the path set in `atmosify.toml`
2. the bundled copy (bundled build only)
3. next to the atmosify executable
4. `PATH`
5. on Windows, `mkvmerge` also in the default MKVToolNix install folder

DeeZy finds DEE (and, in the standard build, FFmpeg and truehdd) through its own config, an `apps` folder next to it, or `PATH`. The simplest setup is to set `dee` in `atmosify.toml`, which atmosify passes on to DeeZy.

## Usage

```
atmosify <file.mkv | folder>... [options]
```

| Option          | Effect                                                            |
| --------------- | ----------------------------------------------------------------- |
| `--dry-run`     | Show what would be converted, change nothing                      |
| `--replace`     | Replace the original MKV after the result is verified             |
| `--drop-truehd` | Remove the converted TrueHD tracks from the output                |
| `--bitrate <n>` | DD+ Atmos bitrate in kbps (DeeZy picks the nearest allowed value) |
| `--pause`       | Wait for Enter before closing                                     |
| `-v, --version` | Show the version                                                  |
| `-h, --help`    | Show help                                                         |

Folders are scanned recursively for `.mkv` files. By default the result is written next to the original as `<name>.atmos.mkv`.

**Windows tips**

- Drag files or folders onto `atmosify.exe`. The window stays open until you press Enter whenever atmosify was started from Explorer.
- For a right-click entry, put a shortcut to `atmosify.exe` into `shell:sendto`. You then get **Send to → atmosify**.

## Configuration

`atmosify.toml` is created next to the executable on first run. Command-line flags override it.

```toml
bitrate = 768             # DD+ Atmos bitrate in kbps
replace_original = false  # replace the original MKV after verification
drop_truehd = false       # remove converted TrueHD tracks
output_suffix = ".atmos"  # "<name>.atmos.mkv" when not replacing
temp_dir = ""             # empty = ".atmosify-tmp" next to each input; needs several GB per track

[tools]
deezy = ""                # paths to the tools; empty = auto-detect
mkvmerge = ""
ffprobe = ""
ffmpeg = ""               # passed to DeeZy
dee = ""                  # passed to DeeZy
truehdd = ""              # passed to DeeZy
```

## Building from source

Requires [Bun](https://bun.sh).

```
bun install
bun run start -- --dry-run Movie.mkv   # run from source
bun run typecheck
bun run build                          # dist/atmosify(.exe)
bun run vendor                         # download and pack the tools for the bundled build
bun run build:bundled                  # dist/atmosify-bundled(.exe)
```

The bundled tool versions and their SHA-256 checksums are pinned in `vendor.json`. The Linux bundle has to be packed on Linux, because it unpacks the MKVToolNix AppImage and collects shared libraries with `ldd`.

Pushing a tag such as `v1.0.0` runs the release workflow. It builds both variants for Windows and Linux and publishes them on the Releases page, together with the third-party license texts. The tag must match the `version` in `package.json`.

## Credits

- [DeeZy](https://github.com/jessielw/DeeZy) by jessielw (MIT)
- [truehdd](https://github.com/truehdd/truehdd) (Apache-2.0)
- [MKVToolNix](https://mkvtoolnix.download/) by Moritz Bunkus (GPL-2.0)
- [FFmpeg](https://ffmpeg.org/) (LGPL-2.1, [BtbN](https://github.com/BtbN/FFmpeg-Builds) shared build)

The bundled builds ship these tools as separate, unmodified programs that atmosify runs. atmosify itself stays MIT licensed. Each release includes the third-party licenses as `THIRD_PARTY_LICENSES.txt`. The source code of the bundled FFmpeg and MKVToolNix is available on request: [open an issue](https://github.com/SyntaxxHD/atmosify/issues).

Dolby, Dolby Atmos and Dolby Digital Plus are trademarks of Dolby Laboratories. This project is not affiliated with Dolby.

## License

[MIT](LICENSE)
