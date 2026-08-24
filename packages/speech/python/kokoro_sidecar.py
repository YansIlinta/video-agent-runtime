import argparse
import json
import wave

import numpy as np


LANGUAGE_CODES = {
    "en": "a",
    "en-us": "a",
    "en-gb": "b",
    "es": "e",
    "fr": "f",
    "hi": "h",
    "it": "i",
    "pt-br": "p",
    "ja": "j",
    "zh": "z",
    "zh-cn": "z",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--model", default="hexgrad/Kokoro-82M")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        import torch
        from kokoro import KPipeline
    except ImportError as exc:
        raise SystemExit(f"Kokoro dependencies are not installed in VIDEO_AGENT_PYTHON: {exc}")

    language = LANGUAGE_CODES.get(args.language.lower(), args.language.lower())
    pipeline = KPipeline(lang_code=language, repo_id=args.model)
    chunks = []
    word_timings = []
    offset = 0.0
    sample_rate = 24000
    for result in pipeline(args.text, voice=args.voice, speed=args.speed):
        if result.audio is None:
            continue
        audio = result.audio.detach().cpu().flatten()
        chunks.append(audio)
        for token in result.tokens or []:
            if token.start_ts is None or token.end_ts is None or not token.text.strip():
                continue
            word_timings.append({
                "text": token.text,
                "startSeconds": offset + float(token.start_ts),
                "endSeconds": offset + float(token.end_ts),
            })
        offset += audio.numel() / sample_rate
    if not chunks:
        raise SystemExit("Kokoro returned no audio")
    waveform = torch.cat(chunks).clamp(-1, 1).numpy()
    pcm = (waveform * 32767.0).astype(np.int16)
    with wave.open(args.output, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    print(json.dumps({
        "durationSeconds": len(pcm) / sample_rate,
        "sampleRate": sample_rate,
        "wordTimings": word_timings,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
