import argparse
import json
import sys


def device_config(torch):
    if torch.cuda.is_available():
        return "cuda:0", torch.bfloat16
    return "cpu", torch.float32


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["clone", "design"], required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--language", default="Auto")
    parser.add_argument("--output", required=True)
    parser.add_argument("--ref-audio")
    parser.add_argument("--ref-text")
    parser.add_argument("--instruct")
    args = parser.parse_args()

    try:
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel
    except ImportError as error:
        print(f"qwen-tts runtime is not installed in VIDEO_AGENT_PYTHON: {error}", file=sys.stderr)
        return 2

    try:
        device, dtype = device_config(torch)
        model = Qwen3TTSModel.from_pretrained(args.model, device_map=device, dtype=dtype)
        if args.mode == "clone":
            if not args.ref_audio:
                raise ValueError("clone mode requires --ref-audio")
            ref_text = args.ref_text.strip() if args.ref_text else None
            wavs, sr = model.generate_voice_clone(
                text=args.text,
                language=args.language or "Auto",
                ref_audio=args.ref_audio,
                ref_text=ref_text,
                x_vector_only_mode=not bool(ref_text),
                non_streaming_mode=True,
            )
        else:
            if not args.instruct or not args.instruct.strip():
                raise ValueError("design mode requires --instruct")
            wavs, sr = model.generate_voice_design(
                text=args.text,
                language=args.language or "Auto",
                instruct=args.instruct,
                non_streaming_mode=True,
            )
        if not wavs:
            raise RuntimeError("Qwen3-TTS returned no waveform")
        sf.write(args.output, wavs[0], sr)
        duration = float(len(wavs[0])) / float(sr)
        print(json.dumps({"durationSeconds": duration, "sampleRate": int(sr), "mode": args.mode, "device": device}))
        return 0
    except Exception as error:
        print(f"Qwen3-TTS failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
