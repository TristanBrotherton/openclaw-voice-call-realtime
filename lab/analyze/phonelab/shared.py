"""The Voice PE lab's shared results store and report statistics, imported
read-only from $VOICEPE_LAB_PATH (default ~/development/voice-pe/lab).
Never modify files there; the store's row schema is shared."""
from __future__ import annotations

import os
import sys
from pathlib import Path

VOICEPE_LAB_PATH = Path(os.environ.get("VOICEPE_LAB_PATH") or "~/development/voice-pe/lab").expanduser()
if str(VOICEPE_LAB_PATH) not in sys.path:
    sys.path.append(str(VOICEPE_LAB_PATH))

from voicepe_lab.report import bootstrap_delta, pct  # noqa: E402
from voicepe_lab.store import Store  # noqa: E402

STATE_DIR = Path(os.environ.get("PHONELAB_STATE") or os.environ.get("VOICE_CALL_LAB_STATE")
                 or "~/.local/state/voice-call-lab").expanduser()

__all__ = ["Store", "pct", "bootstrap_delta", "STATE_DIR", "VOICEPE_LAB_PATH"]
