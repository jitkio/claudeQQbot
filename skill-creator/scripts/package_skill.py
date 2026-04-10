#!/usr/bin/env python3
"""Package a skill folder into a .skill file."""
import sys, zipfile, fnmatch
from pathlib import Path
from scripts.quick_validate import validate_skill

EXCLUDE_DIRS = {"__pycache__", "node_modules"}
EXCLUDE_GLOBS = {"*.pyc"}
EXCLUDE_FILES = {".DS_Store"}
ROOT_EXCLUDE_DIRS = {"evals"}

def should_exclude(rel_path):
    parts = rel_path.parts
    if any(part in EXCLUDE_DIRS for part in parts):
        return True
    if len(parts) > 1 and parts[1] in ROOT_EXCLUDE_DIRS:
        return True
    name = rel_path.name
    if name in EXCLUDE_FILES:
        return True
    return any(fnmatch.fnmatch(name, pat) for pat in EXCLUDE_GLOBS)

def package_skill(skill_path, output_dir=None):
    skill_path = Path(skill_path).resolve()
    if not skill_path.exists() or not skill_path.is_dir():
        print(f"Error: {skill_path} not found or not a directory"); return None
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        print(f"Error: SKILL.md not found"); return None
    print("Validating...")
    valid, msg = validate_skill(skill_path)
    if not valid:
        print(f"Validation failed: {msg}"); return None
    print(f"OK: {msg}")
    skill_name = skill_path.name
    out = Path(output_dir).resolve() if output_dir else Path.cwd()
    out.mkdir(parents=True, exist_ok=True)
    skill_file = out / f"{skill_name}.skill"
    try:
        with zipfile.ZipFile(skill_file, 'w', zipfile.ZIP_DEFLATED) as zf:
            for fp in skill_path.rglob('*'):
                if not fp.is_file(): continue
                arcname = fp.relative_to(skill_path.parent)
                if should_exclude(arcname): continue
                zf.write(fp, arcname)
                print(f"  Added: {arcname}")
        print(f"\n✅ Packaged: {skill_file}")
        return skill_file
    except Exception as e:
        print(f"Error: {e}"); return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python package_skill.py <skill-folder> [output-dir]"); sys.exit(1)
    result = package_skill(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    sys.exit(0 if result else 1)
