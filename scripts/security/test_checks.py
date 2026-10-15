import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import checks


class ReleasePublicationTests(unittest.TestCase):
    def test_rejects_release_without_confirmation(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "release.yml").write_text(
                "on:\n  workflow_dispatch:\njobs:\n  build:\n    steps:\n"
                "      - run: gh release upload v1 artifact.zip\n",
                encoding="utf-8",
            )
            with patch.object(checks, "REPO_ROOT", root), self.assertRaises(SystemExit):
                checks.check_release_publication()

    def test_allows_explicit_release_confirmation(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "release.yml").write_text(
                "on:\n  workflow_dispatch:\n    inputs:\n      publish:\n"
                "        default: false\njobs:\n  build:\n    steps:\n"
                "      - if: ${{ inputs.publish }}\n"
                "        run: gh release upload v1 artifact.zip\n",
                encoding="utf-8",
            )
            with patch.object(checks, "REPO_ROOT", root):
                checks.check_release_publication()


class ActionPinningTests(unittest.TestCase):
    def test_rejects_mutable_action_tag(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "ci.yml").write_text(
                "steps:\n  - uses: actions/checkout@v7\n", encoding="utf-8"
            )
            with patch.object(checks, "REPO_ROOT", root), self.assertRaises(SystemExit):
                checks.check_pinned_actions()

    def test_allows_action_commit_sha(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "ci.yml").write_text(
                "steps:\n  - uses: actions/checkout@" + "a" * 40 + "\n",
                encoding="utf-8",
            )
            with patch.object(checks, "REPO_ROOT", root):
                checks.check_pinned_actions()


class DependabotPolicyTests(unittest.TestCase):
    def test_rejects_unbounded_major_updates(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / ".github" / "dependabot.yml"
            config.parent.mkdir(parents=True)
            config.write_text(
                "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n",
                encoding="utf-8",
            )
            with patch.object(checks, "REPO_ROOT", root), self.assertRaises(SystemExit):
                checks.check_dependabot_policy()


if __name__ == "__main__":
    unittest.main()
