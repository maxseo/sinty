/**
 * Word stems for full-text recall. Russian: the Snowball Russian stemmer (snowballstem.org/algorithms/russian),
 * written out here so the core needs no dependency. English and other Latin-script words are left as they are and
 * stemmed by SQLite's `porter` tokenizer on the `facts_stem` table (memory.ts), which passes Cyrillic through
 * untouched. Changing this file's output changes the index: bump STEM_VERSION so existing databases rebuild it.
 */
export const STEM_VERSION = "ru-snowball-1+porter";

const VOWELS = "аеиоуыэюя";
const isVowel = (c: string | undefined): boolean => c !== undefined && VOWELS.includes(c);

// Longest first inside each list, so the first match is the longest ending.
const byLength = (xs: string[]): string[] => [...xs].sort((a, b) => b.length - a.length);
const PERFECTIVE_1 = byLength(["в", "вши", "вшись"]); // after а / я
const PERFECTIVE_2 = byLength(["ив", "ивши", "ившись", "ыв", "ывши", "ывшись"]);
const ADJECTIVE = byLength(["ее", "ие", "ые", "ое", "ими", "ыми", "ей", "ий", "ый", "ой", "ем", "им", "ым", "ом", "его", "ого", "ему", "ому", "их", "ых", "ую", "юю", "ая", "яя", "ою", "ею"]);
const PARTICIPLE_1 = byLength(["ем", "нн", "вш", "ющ", "щ"]); // after а / я
const PARTICIPLE_2 = byLength(["ивш", "ывш", "ующ"]);
const REFLEXIVE = ["ся", "сь"];
const VERB_1 = byLength(["ла", "на", "ете", "йте", "ли", "й", "л", "ем", "н", "ло", "но", "ет", "ют", "ны", "ть", "ешь", "нно"]); // after а / я
const VERB_2 = byLength(["ила", "ыла", "ена", "ейте", "уйте", "ите", "или", "ыли", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ило", "ыло", "ено", "ят", "ует", "уют", "ит", "ыт", "ены", "ить", "ыть", "ишь", "ую", "ю"]);
const NOUN = byLength(["а", "ев", "ов", "ие", "ье", "е", "иями", "ями", "ами", "еи", "ии", "и", "ией", "ей", "ой", "ий", "й", "иям", "ям", "ием", "ем", "ам", "ом", "о", "у", "ах", "иях", "ях", "ы", "ь", "ию", "ью", "ю", "ия", "ья", "я"]);
const SUPERLATIVE = byLength(["ейш", "ейше"]);
const DERIVATIONAL = byLength(["ост", "ость"]);

/** Removes the longest ending of `list` that lies in the region starting at `from`; group-1 endings need а/я before them (also in the region). */
function strip(w: string, from: number, list: string[], afterAYa = false): string | undefined {
  for (const e of list) {
    if (!w.endsWith(e)) continue;
    const at = w.length - e.length;
    if (at < from) continue;
    if (afterAYa) {
      const prev = w[at - 1];
      if (at - 1 < from || (prev !== "а" && prev !== "я")) continue;
    }
    return w.slice(0, at);
  }
  return undefined;
}

/** Snowball Russian. Input: one lowercase word; non-Cyrillic input comes back unchanged. */
export function stemRussian(input: string): string {
  let w = input.toLowerCase().replaceAll("ё", "е");
  if (!/^[а-я]+$/.test(w)) return input.toLowerCase();
  // RV: after the first vowel. R1: after the first non-vowel that follows a vowel. R2: the same rule inside R1.
  let rv = w.length;
  for (let i = 0; i < w.length; i++) if (isVowel(w[i])) { rv = i + 1; break; }
  const region = (start: number): number => {
    for (let i = start + 1; i < w.length; i++) if (!isVowel(w[i]) && isVowel(w[i - 1])) return i + 1;
    return w.length;
  };
  const r1 = region(0);
  const r2 = r1 < w.length ? region(r1) : w.length;

  // Step 1
  const gerund = strip(w, rv, PERFECTIVE_1, true) ?? strip(w, rv, PERFECTIVE_2);
  if (gerund !== undefined) w = gerund;
  else {
    w = strip(w, rv, REFLEXIVE) ?? w;
    const adj = strip(w, rv, ADJECTIVE);
    if (adj !== undefined) w = strip(adj, rv, PARTICIPLE_1, true) ?? strip(adj, rv, PARTICIPLE_2) ?? adj;
    else w = strip(w, rv, VERB_1, true) ?? strip(w, rv, VERB_2) ?? strip(w, rv, NOUN) ?? w;
  }
  // Step 2
  if (w.endsWith("и") && w.length - 1 >= rv) w = w.slice(0, -1);
  // Step 3
  w = strip(w, r2, DERIVATIONAL) ?? w;
  // Step 4
  if (w.endsWith("нн") && w.length - 2 >= rv) w = w.slice(0, -1);
  else {
    const sup = strip(w, rv, SUPERLATIVE);
    if (sup !== undefined) {
      w = sup;
      if (w.endsWith("нн") && w.length - 2 >= rv) w = w.slice(0, -1);
    } else if (w.endsWith("ь") && w.length - 1 >= rv) w = w.slice(0, -1);
  }
  return w;
}

/** Words of a text (letters, digits, _ and -), lowercased. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean);
}

/** What goes into `facts_stem`: Russian words as their stems, everything else as it is (porter stems English there). */
export function stemText(text: string): string {
  return words(text)
    .flatMap((w) => w.split("-").filter(Boolean))
    .map((w) => (/[а-яё]/.test(w) ? stemRussian(w) : w))
    .join(" ");
}
