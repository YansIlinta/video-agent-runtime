import argparse
import json
import math
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--language")
    parser.add_argument("--prompt")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed in VIDEO_AGENT_PYTHON", file=sys.stderr)
        return 2

    model = WhisperModel(args.model, device="auto", compute_type="default")
    segments, info = model.transcribe(
        args.input,
        language=args.language,
        initial_prompt=args.prompt,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    output_segments = []
    warnings = []
    for segment in segments:
        words = []
        for word in segment.words or []:
            probability = float(word.probability)
            if math.isnan(probability):
                probability = 0.0
            words.append({
                "text": word.word,
                "startSeconds": float(word.start),
                "endSeconds": float(word.end),
                "confidence": probability,
            })
        output_segments.append({
            "text": segment.text,
            "startSeconds": float(segment.start),
            "endSeconds": float(segment.end),
            "confidence": max(0.0, min(1.0, math.exp(float(segment.avg_logprob)))),
            "language": info.language,
            "words": words,
        })
    print(json.dumps({
        "language": info.language,
        "languageConfidence": float(info.language_probability),
        "segments": output_segments,
        "warnings": warnings,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
