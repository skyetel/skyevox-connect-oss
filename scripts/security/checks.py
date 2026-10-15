#!/usr/bin/env python3
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]

SECRET_PATTERNS = {
    "github_pat": re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    "github_classic_pat": re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    "openai_key": re.compile(r"sk-[A-Za-z0-9]{20,}"),
    "aws_access_key": re.compile(r"AKIA[0-9A-Z]{16}"),
    "private_key": re.compile(r"-----BEGIN (?:RSA|EC|DSA|OPENSSH|PRIVATE) KEY-----"),
}


def fail(message: str) -> None:
    print(f"[security-check] {message}", file=sys.stderr)
    raise SystemExit(1)


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return [
        path
        for line in result.stdout.splitlines()
        if line and (path := REPO_ROOT / line).is_file()
    ]


def check_high_confidence_secrets() -> None:
    violations: list[str] = []
    for file_path in tracked_files():
        rel = file_path.relative_to(REPO_ROOT).as_posix()
        try:
            content = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for name, pattern in SECRET_PATTERNS.items():
            if pattern.search(content):
                violations.append(f"{rel}: {name}")
                break
    if violations:
        fail("high-confidence secrets detected: " + ", ".join(violations))


def check_pinned_actions() -> None:
    violations: list[str] = []
    pattern = re.compile(r"^\s*-?\s*uses:\s*([^\s#]+)", re.MULTILINE)
    for workflow in sorted((REPO_ROOT / ".github" / "workflows").glob("*.y*ml")):
        for action in pattern.findall(workflow.read_text(encoding="utf-8")):
            if action.startswith("./"):
                continue
            reference = action.rsplit("@", 1)[-1]
            if not re.fullmatch(r"[0-9a-f]{40}", reference):
                violations.append(f"{workflow.name}: {action}")
    if violations:
        fail("GitHub Actions are not pinned to commit SHAs: " + ", ".join(violations))


def check_dependabot_policy() -> None:
    config = (REPO_ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8")
    blocks = re.split(r"(?m)^  - package-ecosystem:", config)[1:]
    violations: list[str] = []
    for block in blocks:
        ecosystem = block.splitlines()[0].strip()
        required = (
            "open-pull-requests-limit: 3",
            "update-types: [minor, patch]",
            "update-types: ['version-update:semver-major']",
        )
        if not all(marker in block for marker in required):
            violations.append(ecosystem)
    if len(blocks) != 3 or violations:
        fail("Dependabot policy is missing bounded minor/patch controls: " + ", ".join(violations))


def check_release_publication() -> None:
    violations: list[str] = []
    for workflow in sorted((REPO_ROOT / ".github" / "workflows").glob("*.y*ml")):
        content = workflow.read_text(encoding="utf-8")
        if "gh release create" not in content and "gh release upload" not in content:
            continue
        required = (
            "workflow_dispatch:",
            "publish:",
            "default: false",
            "if: ${{ inputs.publish }}",
        )
        if not all(marker in content for marker in required):
            violations.append(workflow.name)
    if violations:
        fail("release publication is not explicitly confirmed: " + ", ".join(violations))


def main() -> None:
    check_high_confidence_secrets()
    check_pinned_actions()
    check_dependabot_policy()
    check_release_publication()
    print("[security-check] all checks passed")


if __name__ == "__main__":
    main()
