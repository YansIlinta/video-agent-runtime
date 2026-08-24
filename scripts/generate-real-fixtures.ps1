param([string]$SourceRoot = '')
$ErrorActionPreference = 'Stop'
$fixtureRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\evals\real-fixtures'))
if (-not $SourceRoot) { $SourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\work\upstream\faster-whisper\tests\data')) }
if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) { throw "faster-whisper test data not found: $SourceRoot" }
New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null

$jfk = Join-Path $SourceRoot 'jfk.flac'
$diarization = Join-Path $SourceRoot 'stereo_diarization.wav'
$hotwords = Join-Path $SourceRoot 'hotwords.mp3'
foreach ($source in @($jfk,$diarization,$hotwords)) { if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing source fixture: $source" } }

& ffmpeg -hide_banner -loglevel error -f lavfi -i 'color=c=0x18202b:s=640x360:r=24' -i $jfk -vf "drawtext=text='ONE SPEAKER / JFK':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=(h-text_h)/2" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -y (Join-Path $fixtureRoot 'one-speaker.mp4')
& ffmpeg -hide_banner -loglevel error -f lavfi -i 'color=c=0x202020:s=640x360:r=24' -i $diarization -vf "drawtext=text='TWO SPEAKERS / STEREO':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=(h-text_h)/2" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -y (Join-Path $fixtureRoot 'two-speaker-overlap.mp4')
& ffmpeg -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=640x360:rate=24' -i $hotwords -f lavfi -i 'sine=frequency=180:sample_rate=44100' -filter_complex '[2:a]volume=0.025[music];[1:a][music]amix=inputs=2:duration=first:normalize=0[a]' -map 0:v -map '[a]' -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -y (Join-Path $fixtureRoot 'background-music-proper-nouns.mp4')

Get-ChildItem -LiteralPath $fixtureRoot -Filter '*.mp4' | Select-Object Name,Length
