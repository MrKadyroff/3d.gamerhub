#!/usr/bin/env python3
"""
Собирает галерею «что печатают» через Openverse (агрегатор свободных изображений).

Берём только лицензии, разрешающие коммерческое использование. Подпись к каждой
картинке выводится из её собственного названия — чтобы подпись не врала о том,
что на фото. Авторы и лицензии складываются в manifest.json: CC BY / BY-SA
требуют указания авторства.

Запуск: python3 scripts/gallery.py
"""
import json, time, urllib.parse, pathlib, subprocess, sys

API = "https://api.openverse.org/v1/images/"
OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "img" / "gallery"
UA = "3dgamerhub-gallery/1.0 (https://3dgamerhub.kz; site owner)"
WANT = 20

# Sketchfab отдаёт 403 на прямые ссылки — не тратим на него попытки.
BLOCKED_HOSTS = ("sketchfab.com",)

# Широкие запросы дают сотни результатов, узкие — единицы. Берём и те, и другие.
QUERIES = [
    ("3d print", 3), ("3d printing", 3), ("3dprinting", 2), ("additive manufacturing", 2),
    ("3d printed mask", 1), ("3d printed bust", 1), ("3d printed gear", 1),
    ("3d printed figurine", 1), ("3d printed vase", 1), ("3d printed prosthetic", 1),
    ("3d printed robot", 1), ("3d printed toy", 1), ("3d printed sculpture", 1),
]

# ключевые слова в названии → подпись и параметры печати для калькулятора
LABELS = [
    (("mask", "cosplay", "helmet"),         "Маски и косплей",      "PLA",  "0.20", "0.1"),
    (("gear", "cog", "mechanism", "screw"), "Шестерни и механика",  "PETG", "0.20", "0.4"),
    (("bust", "sculpt", "statue", "head"),  "Бюсты и скульптура",   "PLA",  "0.12", "0.2"),
    (("figur", "miniature", "toy", "doll"), "Фигурки и миниатюры",  "PLA",  "0.12", "0.2"),
    (("vase", "lamp", "decor", "planter"),  "Вазы и декор",         "PLA",  "0.20", "0.1"),
    (("prosthe", "medic", "implant", "anat"), "Медицина и анатомия","PETG", "0.20", "0.4"),
    (("robot", "drone", "quad", "arm"),     "Робототехника",        "PETG", "0.20", "0.4"),
    (("architect", "building", "model"),    "Макеты и прототипы",   "PLA",  "0.12", "0.2"),
    (("case", "enclos", "box", "holder"),   "Корпуса и держатели",  "PETG", "0.20", "0.2"),
    (("bracket", "mount", "clip", "part"),  "Крепёж и запчасти",    "PETG", "0.20", "0.4"),
    (("jewel", "ring", "pendant"),          "Украшения",            "PLA",  "0.12", "0.4"),
    (("chess", "dice", "game", "board"),    "Настольные игры",      "PLA",  "0.12", "0.2"),
    (("skull", "dino", "fossil", "bone"),   "Наука и обучение",     "PLA",  "0.12", "0.2"),
    (("art", "design", "geometr", "math"),  "Арт-объекты",          "PLA",  "0.12", "0.1"),
]
DEFAULT = ("Мелкосерийная печать", "PLA", "0.20", "0.2")

_last = [0.0]


def fetch(url, binary=False, tries=1):
    code = "?"
    for attempt in range(tries):
        wait = 1.6 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        r = subprocess.run(["curl", "-sSL", "--max-time", "45", "-A", UA, "-w", "\n%{http_code}", url],
                           capture_output=True)
        _last[0] = time.time()
        body, _, code = r.stdout.rpartition(b"\n")
        code = code.decode().strip()
        if code == "200":
            return body if binary else body.decode("utf-8")
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"HTTP {code}")


def search(term, pages=1, n=20):
    out = []
    for page in range(1, pages + 1):
        q = urllib.parse.urlencode({
            "q": term, "license_type": "commercial", "page_size": n,
            "page": page, "mature": "false", "size": "large",
        })
        try:
            out += json.loads(fetch(API + "?" + q, tries=3)).get("results", [])
        except Exception as e:
            print(f"  ! поиск «{term}» стр.{page}: {e}", file=sys.stderr)
    return out


def is_image(path):
    """Проверяем сигнатуру: иногда прилетает HTML-заглушка или битый файл."""
    head = path.read_bytes()[:12]
    return head.startswith(b"\xff\xd8\xff") or head.startswith(b"\x89PNG") \
        or head[:4] == b"RIFF" and head[8:12] == b"WEBP" or head.startswith(b"GIF8")


def shrink(path, width=760):
    """Ужимаем под карточку галереи: оригиналы весят по мегабайту."""
    try:
        subprocess.run(["sips", "-Z", str(width), "-s", "format", "jpeg",
                        "-s", "formatOptions", "72", str(path), "--out", str(path)],
                       capture_output=True, check=True)
    except Exception:
        pass          # нет sips — оставляем как есть, просто тяжелее


def label_for(title):
    low = (title or "").lower()
    for keys, label, mat, layer, infill in LABELS:
        if any(k in low for k in keys):
            return label, mat, layer, infill
    return DEFAULT


def image_url(r):
    """Прямая ссылка на файл. Превью-прокси Openverse отвечает 424, на него не полагаемся."""
    return r.get("url") or r.get("thumbnail")


def usable(url, seen):
    if not url or url in seen:
        return False
    if any(h in urllib.parse.urlparse(url).netloc for h in BLOCKED_HOSTS):
        return False
    return True


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for old in list(OUT.glob("*.jpg")) + list(OUT.glob("*.json")):
        old.unlink()

    print("собираю кандидатов…")
    pool, seen_url = [], set()
    for term, pages in QUERIES:
        for r in search(term, pages):
            url = image_url(r)
            if usable(url, seen_url):
                seen_url.add(url)
                pool.append(r)
    print(f"кандидатов: {len(pool)}\n")

    manifest, used_labels = [], {}
    for r in pool:
        if len(manifest) >= WANT:
            break
        label, mat, layer, infill = label_for(r.get("title"))
        # не больше двух картинок на одну категорию — иначе галерея однообразная
        if used_labels.get(label, 0) >= 2:
            continue

        name = f"{len(manifest) + 1:02d}.jpg"
        try:
            data = fetch(image_url(r), binary=True, tries=2)
            if len(data) < 8000:
                raise RuntimeError("файл подозрительно мал")
            (OUT / name).write_bytes(data)
            if not is_image(OUT / name):
                raise RuntimeError("это не картинка")
            shrink(OUT / name)
            if not is_image(OUT / name):
                raise RuntimeError("сжатие испортило файл")
        except Exception:
            (OUT / name).unlink(missing_ok=True)
            continue                      # не картинка — берём следующего кандидата
        used_labels[label] = used_labels.get(label, 0) + 1
        manifest.append({
            "img": f"img/gallery/{name}",
            "label": label,
            "hint": f"{mat} · слой {layer} мм",
            "preset": {"material": mat, "layer": layer, "infill": infill},
            "author": (r.get("creator") or "неизвестен")[:60],
            "license": f"CC {(r.get('license') or '').upper()} {r.get('license_version') or ''}".strip(),
            "source": r.get("foreign_landing_url") or r.get("url"),
        })
        print(f"  {name}  {label:24} {manifest[-1]['license']}")

    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"\nсохранено: {len(manifest)} шт → {OUT}")


if __name__ == "__main__":
    main()
