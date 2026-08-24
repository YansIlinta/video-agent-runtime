import argparse
import json


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["align", "diarize"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--transcript")
    parser.add_argument("--hf-token")
    args = parser.parse_args()
    try:
        import whisperx
    except ImportError as exc:
        raise SystemExit(f"whisperx is not installed: {exc}")
    device = "cuda" if __import__("torch").cuda.is_available() else "cpu"
    audio = whisperx.load_audio(args.input)
    if args.mode == "align":
        with open(args.transcript, "r", encoding="utf-8") as handle:
            transcript = json.load(handle)
        language = transcript.get("language") or "en"
        model, metadata = whisperx.load_align_model(language_code=language, device=device)
        source = [{"start": s["startUs"] / 1_000_000, "end": s["endUs"] / 1_000_000, "text": s["rawText"]} for s in transcript["segments"]]
        result = whisperx.align(source, model, metadata, audio, device, return_char_alignments=False)
        words = [{"rawText": w.get("word", ""), "startUs": round(w["start"] * 1_000_000), "endUs": round(w["end"] * 1_000_000), **({"confidence": w["score"]} if "score" in w else {})} for w in result.get("word_segments", []) if "start" in w and "end" in w]
        print(json.dumps({"provider": "whisperx", "model": language, "words": words, "failedSegmentIds": [], "warnings": []}, ensure_ascii=False))
    else:
        pipeline = whisperx.DiarizationPipeline(token=args.hf_token, device=device)
        result = pipeline(audio)
        segments = [{"speakerId": str(row["speaker"]), "startUs": round(float(row["start"]) * 1_000_000), "endUs": round(float(row["end"]) * 1_000_000)} for _, row in result.iterrows()]
        print(json.dumps({"provider": "whisperx", "model": "pyannote", "segments": segments, "warnings": []}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
