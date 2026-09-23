#!/usr/bin/env python3
"""Bump the build number everywhere it appears as a cache-bust ?v=N.

Usage: bump_build.py <new-build-number>
Rewrites every ?v=<digits> in index.html and js/*.js to ?v=<new>,
so no asset can ever be left pinned to a stale version (the build-53
stale-import incident, 2026-09-21). The in-game build stamp reads
LIMBO_BUILD from game.js's own ?v=, so it follows automatically.
Run BEFORE committing a release, then verify the live ?v= matches.
Also bumps the service worker's BUILD const (sw.js), which is what forces
phones to drop their offline cache and pick up the new assets.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [ROOT / "index.html", ROOT / "sw.js"] + sorted((ROOT / "js").glob("*.js"))

def main() -> None:
    build = sys.argv[1]
    if not build.isdigit():
        sys.exit("usage: bump_build.py <new-build-number>")
    changed = []
    for f in FILES:
        text = f.read_text()
        new = re.sub(r"\?v=\d+", f"?v={build}", text)
        # sw.js pins its own cache generation in const BUILD = 'NN'
        if f.name == "sw.js":
            new = re.sub(r"const BUILD = '\d+'", f"const BUILD = '{build}'", new)
            new = new.replace("(build 40)", f"(build {build})").replace(
                "?v=40)", f"?v={build})"
            )
        if new != text:
            f.write_text(new)
            changed.append(f.name)
    print(f"bumped to v={build}: {', '.join(changed) or 'nothing'}")

if __name__ == "__main__":
    main()
