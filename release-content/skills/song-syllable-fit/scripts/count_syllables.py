#!/usr/bin/env python3
"""Счёт слогов в русских строках: слог = гласная буква.

Использование:
    python count_syllables.py "строка один" "строка два"
    echo "текст" | python count_syllables.py
"""
import re
import sys

VOWELS = set("аеёиоуыэюяАЕЁИОУЫЭЮЯ")


def syllables(line: str) -> int:
    return sum(1 for ch in line if ch in VOWELS)


def main(argv):
    lines = argv[1:] or [l for l in sys.stdin.read().splitlines() if l.strip()]
    for line in lines:
        print(f"{syllables(line):3d}  {line}")


if __name__ == "__main__":
    main(sys.argv)
