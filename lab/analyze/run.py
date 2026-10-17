"""Entry point: python3 -I lab/analyze/run.py <command> ...

-I ignores PYTHONPATH and the script directory, so the path is set up here
explicitly: this directory (phonelab) first; the Voice PE lab is appended by
phonelab.shared."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from phonelab.cli import main  # noqa: E402

main()
