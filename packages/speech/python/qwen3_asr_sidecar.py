#!/usr/bin/env python3
import argparse
import json
import math


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default="Qwen/Qwen3-ASR-0.6B")
    parser.add_argument("--forced-aligner", default="")
    parser.add_argument("--language", default="")
    parser.add_argument("--context", default="")
    return parser.parse_args()


def audio_duration(path: str) -> float:
    try:
        import soundfile as sf
        info = sf.info(path)
        return max(0.001, float(info.frames) / float(info.samplerate))
    except Exception:
        return 0.001


def main():
    args = parse_args()
    import torch
    from qwen_asr import Qwen3ASRModel

    use_cuda = torch.cuda.is_available()
    dtype = torch.bfloat16 if use_cuda else torch.float32
    device = "cuda:0" if use_cuda else "cpu"
    kwargs = {
        "dtype": dtype,
        "device_map": device,
        "max_inference_batch_size": 1,
        "max_new_tokens": 2048,
    }
    if args.forced_aligner:
        kwargs["forced_aligner"] = args.forced_aligner
        kwargs["forced_aligner_kwargs"] = {"dtype": dtype, "device_map": device}

    model = Qwen3ASRModel.from_pretrained(args.model, **kwargs)
    results = model.transcribe(
        audio=args.input,
        language=args.language or None,
        context=args.context or "",
        return_time_stamps=bool(args.forced_aligner),
    )
    if not results:
        raise RuntimeError("Qwen3-ASR returned no result")
    result = results[0]
    language = getattr(result, "language", None)
    text = (getattr(result, "text", "") or "").strip()
    timestamps = list(getattr(result, "time_stamps", None) or [])
    warnings = []
    segments = []

    if timestamps:
        for stamp in timestamps:
            start = max(0.0, float(getattr(stamp, "start_time", 0.0)))
            end = max(start + 0.001, float(getattr(stamp, "end_time", start + 0.001)))
            stamp_text = (getattr(stamp, "text", "") or "").strip()
            if not stamp_text:
                continue
            segments.append({
                "text": stamp_text,
                "startSeconds": start,
                "endSeconds": end,
                "language": language,
                "words": [{
                    "text": stamp_text,
                    "startSeconds": start,
                    "endSeconds": end,
                }],
            })
    else:
        duration = audio_duration(args.input)
        warnings.append("Qwen3-ASR ran without forced-alignment timestamps; one coarse segment was returned")
        segments.append({
            "text": text,
            "startSeconds": 0.0,
            "endSeconds": duration,
            "language": language,
            "words": [],
        })

    print(json.dumps({
        "language": language,
        "segments": segments,
        "warnings": warnings,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
