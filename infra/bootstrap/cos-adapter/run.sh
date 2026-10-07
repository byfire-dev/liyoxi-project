#!/bin/sh
set -eu
exec "${LYX_COS_PYTHON:-python3.11}" "$(dirname "$0")/adapter.py"
