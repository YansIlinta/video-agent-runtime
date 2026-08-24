#!/usr/bin/env python3
import argparse
import json


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--speaker", required=True)
    parser.add_argument("--language", default="Auto")
    parser.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    parser.add_argument("--output", required=True)
    parser.add_argument("--instruct", default="")
    return parser.parse_args()


def main():
    args = parse_args()
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    use_cuda = torch.cuda.is_available()
    dtype = torch.bfloat16 if use_cuda else torch.float32
    device = "cuda:0" if use_cuda else "cpu"
    model = Qwen3TTSModel.from_pretrained(
        args.model,
        dtype=dtype,
        device_map=device,
    )
    wavs, sample_rate = model.generate_custom_voice(
        text=args.text,
        speaker=args.speaker,
        language=args.language or "Auto",
        instruct=args.instruct or None,
    )
    if not wavs:
        raise RuntimeError("Qwen3-TTS returned no waveform")
    wav = wavs[0]
    sf.write(args.output, wav, sample_rate)
    duration = float(len(wav)) / float(sample_rate)
    print(json.dumps({"durationSeconds": duration, "sampleRate": int(sample_rate)}))


if __name__ == "__main__":
    main()
