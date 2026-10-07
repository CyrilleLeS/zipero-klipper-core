# SPDX-License-Identifier: GPL-3.0-only
"""Génère la base des broches (EP-06.04) : noms de broches valides par microcontrôleur, et cartes
reconnues par l'en-tête de leur configuration d'exemple.

Usage (depuis packages/klipper-core) : python scripts/pins/generate.py
Lit les sources complètes de Klipper au commit épinglé (hors dépôt, dans le dossier temporaire,
téléchargées si absentes) et écrit src/config/pins/klipper-<commit>.json :
- chips : pour chaque microcontrôleur de Klipper (identifiant de « make menuconfig », celui du
  nom USB `usb-Klipper_<mcu>_…`), sa famille et les ports que son micrologiciel énumère
  (src/<arch>/gpio.c ; pour les STM32, les GPIOx définis par l'en-tête CMSIS du modèle) ;
- boards : la première ligne de chaque config/*.cfg (« This file contains … pin mappings for … »)
  et les microcontrôleurs que son en-tête cite.
"""
import io
import json
import re
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

COMMIT = "214fdb2877ff4640e9316a663c1b8b2e232c86fd"
HERE = Path(__file__).parent
PACKAGE = HERE.parent.parent
OUT = PACKAGE / "src" / "config" / "pins" / f"klipper-{COMMIT[:10]}.json"

# Ports énumérés par src/avr/gpio.c selon les registres PINx que définit avr-libc pour chaque
# modèle (le dépôt de Klipper n'embarque pas ces en-têtes) : relevé des fiches techniques.
AVR_PORTS = {
    "atmega168": "BCD",
    "atmega328": "BCD",
    "atmega328p": "BCDE",
    "atmega644p": "ABCD",
    "atmega1284p": "ABCD",
    "at90usb646": "ABCDEF",
    "at90usb1286": "ABCDEF",
    "atmega32u4": "BCDEF",
    "atmega1280": "ABCDEFGHJKL",
    "atmega2560": "ABCDEFGHJKL",
}


def sources() -> Path:
    root = Path(tempfile.gettempdir()) / "klipper-src" / "full"
    if (root / "src").is_dir():
        return root
    url = f"https://codeload.github.com/Klipper3d/klipper/tar.gz/{COMMIT}"
    print(f"Téléchargement de {url}", file=sys.stderr)
    data = urllib.request.urlopen(url).read()
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            parts = member.name.split("/", 1)
            if len(parts) < 2 or not parts[1]:
                continue
            member.name = parts[1]
            archive.extract(member, root, filter="data")
    return root


def kconfig_mcus(src: Path) -> dict[str, str]:
    """Identifiant de chaque microcontrôleur, par architecture (`default "x" if MACH_…`)."""
    mcus = {}
    for kconfig in sorted(src.glob("src/*/Kconfig")):
        arch = kconfig.parent.name
        for name in re.findall(r'default "([a-z0-9]+)" if MACH_', kconfig.read_text()):
            mcus.setdefault(name, arch)
    # Architecture d'un seul modèle : `default "hc32f460"`, sans condition.
    mcus.setdefault("hc32f460", "hc32f460")
    return mcus


def stm32_ports(src: Path, mcu: str) -> str | None:
    headers = list(src.glob(f"lib/*/include/{mcu}.h"))
    if not headers:
        return None
    text = headers[0].read_text(errors="replace")
    # src/stm32/gpio.c : A, B et C toujours ; D à I si l'en-tête définit GPIOx.
    return "ABC" + "".join(p for p in "DEFGHI" if re.search(rf"#define GPIO{p}\s", text))


def chips(src: Path) -> dict[str, dict]:
    result = {}
    for mcu, arch in sorted(kconfig_mcus(src).items()):
        if arch == "stm32":
            ports = stm32_ports(src, mcu)
            if ports:
                result[mcu] = {"family": "stm32", "ports": ports}
        elif arch == "lpc176x":
            result[mcu] = {"family": "lpc176x"}
        elif arch == "rp2040":
            # src/rp2040/gpio.c : NUM_GPIO = 30 (RP2040), 48 (RP2350).
            result[mcu] = {"family": "rp2040", "gpio": 30 if mcu == "rp2040" else 48}
        elif arch == "avr" and mcu in AVR_PORTS:
            result[mcu] = {"family": "avr", "ports": AVR_PORTS[mcu]}
        elif arch == "hc32f460":
            # src/hc32f460/gpio.c : ports A à E, plus PH2.
            result[mcu] = {"family": "hc32f460", "ports": "ABCDE"}
    return result


CHIP_IN_TEXT = re.compile(
    r"\b(STM32[FGHL][0-9][0-9A-Z]{2}|LPC17[0-9]{2}|RP2040|RP2350|ATmega[0-9]+[A-Z0-9]*|AT90USB[0-9]+|HC32F460)",
    re.IGNORECASE,
)

# Titre : de « pin mappings for » à la fin de la phrase (avant « board », « To use » ou un point).
TITLE = re.compile(r"pin mappings for (?:the )?(.+?)(?:\s+boards?\b|\.(?:\s|$)|\s+To use\b|$)")


def chip_id(name: str, known: dict[str, dict]) -> str | None:
    lower = name.lower()
    if lower in known:
        return lower
    # STM32F446 → stm32f446xx (ou xe, xb… : l'identifiant de Kconfig qui commence ainsi).
    matches = [mcu for mcu in known if mcu.startswith(lower)]
    return matches[0] if len(matches) == 1 else None


def boards(src: Path, known: dict[str, dict]) -> list[dict]:
    result = []
    for path in sorted((src / "config").glob("*.cfg")):
        lines = path.read_text(errors="replace").splitlines()
        header = []
        for line in lines:
            if line.startswith("["):
                break
            header.append(line)
        first = lines[0].strip() if lines else ""
        if "pin mappings for" not in first:
            continue
        found = []
        for name in CHIP_IN_TEXT.findall("\n".join(header)):
            mcu = chip_id(name, known)
            if mcu and mcu not in found:
                found.append(mcu)
        paragraph = " ".join(line.lstrip("#").strip() for line in header).strip()
        match = TITLE.search(paragraph)
        title = match.group(1).strip() if match else first
        result.append({"file": path.name, "line": first, "title": title, "chips": found})
    return result


def main() -> None:
    src = sources()
    known = chips(src)
    data = {"commit": COMMIT, "chips": known, "boards": boards(src, known)}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n"
    )
    with_chip = sum(1 for b in data["boards"] if b["chips"])
    print(
        f"{OUT.name} : {len(known)} microcontrôleurs, {len(data['boards'])} cartes "
        f"({with_chip} avec microcontrôleur)."
    )


if __name__ == "__main__":
    main()
