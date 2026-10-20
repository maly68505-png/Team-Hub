# تنضيف الصوت (Audio Auto-Clean)

بيشيل الضوضاء، ويوضّح الصوت، ويظبط المستوى على معيار البث، والخرج Stereo.

```sh
# حلقة كاملة (فيديو): الصورة بتتنسخ زي ما هي والصوت بس اللي بيتبدّل
python3 clean_audio.py episode.mp4 episode_clean.mp4 --target tv

# صوت بس، للسوشيال
python3 clean_audio.py voice.mp3 voice_clean.wav --target social

# مقطع تجربة: دقيقتين من الثانية 30
python3 clean_audio.py voice.mp3 test.wav --ss 30 --t 120
```

| target | Loudness | True Peak |
|---|---|---|
| `tv` | −23 LUFS (EBU R128) | −1 dBTP |
| `social` | −14 LUFS | −1 dBTP |

**السلسلة:** High-pass ← RNNoise (AI) ← EQ (طين / رنين 1.15k / وضوح / هوا) ← Exciter ← De-esser ← Speech leveller ← Compressor ← Denoise + Gate للسكتات ← Gain للهدف ← Limiter.

**السرعة:** ملف 3 دقايق في حوالي 13 ثانية على CPU، يعني حلقة 50 دقيقة في حوالي 4 دقايق.
**المطلوب:** ffmpeg فيه `arnndn` و`speechnorm` (ffmpeg 5+) وPython 3. موديل RNNoise موجود في `models/` (من GregorR/rnnoise-models).
