# Подписи и платформы

## Три стиля

| Стиль | Шрифт | Как выглядит | Для чего |
|---|---|---|---|
| bold | Montserrat 900 | КАПС, всплытие пружиной, активное слово жёлтым #FFE24B | бизнес, обучение, мотивация |
| bounce | Bangers / аналогичный жирный | подскок 70→120→100%, цвета меняются по кругу | развлечение, реакции |
| clean | Inter 700 | мягкое появление, белый с тенью | интервью, спокойная подача |

Настройки по умолчанию, если человек не выбрал: **bold**.
В композиции HyperFrames Montserrat может отсутствовать — заменять на Arial Black
и проверять ширину строки через `magick -font arialbd -pointsize N label:"..." -format %w`.

## Раскладка кадра 1080×1920

- подписи в нижней трети, baseline ~1680 px, безопасная зона 120 px по краям
- не больше 2 строк, кегль 64–76
- блок живёт 0.6–1.4 с, минимум 3 кадра в кадре
- два соседних блока не перекрываются по времени НИКОГДА

## Экспорт

| Платформа | Кодек | Битрейт | Звук | Лимит |
|---|---|---|---|---|
| YouTube Shorts | H.264 High 4.2 | 12 Mbps | AAC 192k | 3 мин |
| TikTok | H.264 CRF 18 preset slow | — | AAC 128k | 10 мин |
| Reels | H.264 High 4.2 | 4.5 Mbps, maxrate 5000k | AAC 128k | 90 с |

Команды:

```cmd
ffmpeg -y -i clip.mp4 -c:v libx264 -profile:v high -level 4.2 -b:v 12M -c:a aac -b:a 192k -movflags +faststart short_yt.mp4
ffmpeg -y -i clip.mp4 -c:v libx264 -crf 18 -preset slow -c:a aac -b:a 128k -movflags +faststart short_tt.mp4
ffmpeg -y -i clip.mp4 -c:v libx264 -profile:v high -level 4.2 -b:v 4.5M -maxrate 5000k -bufsize 10M -c:a aac -b:a 128k -movflags +faststart short_ig.mp4
```

## Валидация после экспорта

1. `ffprobe` — файл открывается, 1080×1920, есть видеопоток h264 и аудиопоток aac
2. длительность 3–90 с
3. `volumedetect` за первые 5 секунд — mean не ниже -50 dB, иначе звук пустой
4. один кадр из середины через `vision.look` — подписи читаются, не обрезаны, не поверх лица
