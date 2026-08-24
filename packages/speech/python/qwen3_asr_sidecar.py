import argparse
import json
import math
import sys
from typing import Optional

LANGUAGE_NAMES = {
    "zh": "Chinese", "en": "English", "yue": "Cantonese", "ar": "Arabic", "de": "German",
    "fr": "French", "es": "Spanish", "pt": "Portuguese", "id": "Indonesian", "it": "Italian",
    "ko": "Korean", "ru": "Russian", "th": "Thai", "vi": "Vietnamese", "ja": "Japanese",
    "tr": "Turkish", "hi": "Hindi", "ms": "Malay", "nl": "Dutch", "sv": "Swedish",
    "da": "Danish", "fi": "Finnish", "pl": "Polish", "cs": "Czech", "fil": "Filipino",
    "fa": "Persian", "el": "Greek", "hu": "Hungarian", "mk": "Macedonian", "ro": "Romanian",
}


def language_name(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return LANGUAGE_NAMES.get(value.lower(), value)


def finite(value) -> float:
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"invalid timestamp {value!r}")
    return result


def group_units(units, language: Optional[str]):
    segments = []
    current = []
    start = None
    punctuation = ("。", "！", "？", ".", "!", "?", "；", ";")

    def flush():
        nonlocal current, start
        if not current:
            return
        text = "".join(item["text"] for item in current) if language in {"Chinese", "Cantonese", "Japanese"} else " ".join(item["text"].strip() for item in current).strip()
        segments.append({
            "text": text.strip(),
            "startSeconds": current[0]["startSeconds"],
            "endSeconds": current[-1]["endSeconds"],
            "words": current,
        })
        current = []
        start = None

    for item in units:
        if start is None:
            start = item["startSeconds"]
        current.append(item)
        duration = item["endSeconds"] - start
        boundary = item["text"].rstrip().endswith(punctuation)
        if duration >= 12.0 or (duration >= 4.0 and boundary):
            flush()
    flush()
    return [segment for segment in segments if segment["text"]]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default="Qwen/Qwen3-ASR-0.6B")
    parser.add_argument("--aligner", default="Qwen/Qwen3-ForcedAligner-0.6B")
    parser.add_argument("--language")
    parser.add_argument("--prompt")
    parser.add_argument("--max-new-tokens", type=int, default=2048)
    args = parser.parse_args()

    try:
        import torch
        from qwen_asr import Qwen3ASRModel
    except ImportError as error:
        print(f"qwen-asr runtime is not installed in VIDEO_AGENT_PYTHON: {error}", file=sys.stderr)
        return 2

    try:
        use_cuda = bool(torch.cuda.is_available())
        device = "cuda:0" if use_cuda else "cpu"
        dtype = torch.bfloat16 if use_cuda else torch.float32
        model = Qwen3ASRModel.from_pretrained(
            args.model,
            dtype=dtype,
            device_map=device,
            max_inference_batch_size=1,
            max_new_tokens=max(128, args.max_new_tokens),
            forced_aligner=args.aligner,
            forced_aligner_kwargs={"dtype": dtype, "device_map": device},
        )
        requested_language = language_name(args.language)
        results = model.transcribe(
            audio=args.input,
            language=requested_language,
            context=args.prompt or "",
            return_time_stamps=True,
        )
        if not results:
            raise RuntimeError("Qwen3-ASR returned no result")
        result = results[0]
        time_stamps = result.time_stamps or []
        if not time_stamps:
            raise RuntimeError("Qwen3-ASR returned text without ForcedAligner timestamps; refusing an edit-unsafe transcript")
        units = []
        for stamp in time_stamps:
            text = str(stamp.text).strip()
            if not text:
                continue
            start = finite(stamp.start_time)
            end = finite(stamp.end_time)
            if end <= start:
                continue
            units.append({"text": text, "startSeconds": start, "endSeconds": end})
        if not units:
            raise RuntimeError("Qwen3 ForcedAligner returned no usable timestamp units")
        detected_language = str(result.language) if result.language else requested_language
        segments = group_units(units, detected_language)
        warnings = ["Qwen3 ForcedAligner timestamps are alignment units and may be character-level for CJK text."]
        print(json.dumps({"language": detected_language, "segments": segments, "warnings": warnings}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(f"Qwen3-ASR failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
